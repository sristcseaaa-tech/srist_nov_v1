// One-time move of DOCUMENTS that are still stored as base64 inside MongoDB into Supabase Storage.
//   node scripts/migrateFilesToSupabase.js          -> DRY RUN: only counts what would move
//   node scripts/migrateFilesToSupabase.js --run    -> uploads, then clears the base64 from MongoDB
// Safe to repeat: records that already have a Supabase path are skipped. The base64 is only removed AFTER its upload worked.
// Covers: Resources menu files, /resources page, admission notices, newsletter PDFs, placement reports,
//         student-portal resources (incl. the old single-file fields) and Exam Cell attachments.
// (Files that are in Cloudinary keep working and are left where they are.)
import "dotenv/config";
import { connectDatabases } from "../db.js";
import * as sb from "../utils/supabase.js";
import NavItem from "../models/NavItem.js";
import Resource from "../models/Resource.js";
import AdmissionNotice from "../models/AdmissionNotice.js";
import NewsletterPdf from "../models/NewsletterPdf.js";
import PlacementReport from "../models/PlacementReport.js";
import StudentResource from "../models/StudentResource.js";
import ExamNotice from "../models/ExamNotice.js";

const RUN = process.argv.includes("--run");
const stats = {}; const bump = (k, f) => { stats[k] = stats[k] || { found: 0, moved: 0, failed: 0 }; stats[k][f]++; };

async function put(label, buffer, name, mime, section, sub) {
  bump(label, "found");
  if (!RUN) return null;
  try {
    const rec = await sb.putBuffer({ buffer, name, mime }, { section, sub, check: false });
    bump(label, "moved");
    return rec;
  } catch (e) { bump(label, "failed"); console.error(`  ✗ ${label} "${name}": ${e.message}`); return null; }
}
const b64 = (s) => Buffer.from(String(s || ""), "base64");

async function singleFile(Model, label, section, dataField = "fileData") {
  const docs = await Model.find({ [dataField]: { $nin: ["", null] }, $or: [{ filePath: "" }, { filePath: null }, { filePath: { $exists: false } }] }).select(`+${dataField} fileName fileType`);
  for (const d of docs) {
    const rec = await put(label, b64(d[dataField]), d.fileName || "file.pdf", d.fileType, section);
    if (rec) await Model.updateOne({ _id: d._id }, { $set: { filePath: rec.path, fileType: rec.mime, fileSize: rec.size, [dataField]: "" } });
  }
}

await connectDatabases();
if (RUN && !sb.ready()) { console.error("Supabase is not configured (SUPABASE_URL / SUPABASE_SECRET_KEY)."); process.exit(1); }
console.log(RUN ? "RUN — uploading to Supabase" : "DRY RUN — nothing is changed (add --run to move the files)");

await singleFile(NavItem, "navigation files", "navigation");
await singleFile(Resource, "resource files", "resources");
await singleFile(AdmissionNotice, "admission notice files", "admission-notices");
await singleFile(PlacementReport, "placement reports", "placement-reports", "data");

for (const d of await NewsletterPdf.find({ data: { $nin: ["", null] }, filePath: { $in: ["", null] } })) {
  const rec = await put("newsletter PDFs", b64(d.data), d.fileName || "newsletter.pdf", "application/pdf", "newsletters");
  if (rec) await NewsletterPdf.updateOne({ _id: d._id }, { $set: { filePath: rec.path, fileSize: rec.size, data: "" } });
}

for (const d of await StudentResource.find({}).select("+fileData +attachments.data dept fileName fileType attachments")) {
  const add = []; const keep = [];
  for (const a of d.attachments || []) {
    if (a.path || !a.data?.length) { keep.push(a.toObject()); continue; }
    const rec = await put("student resource files", Buffer.from(a.data), a.name || "file", a.type, "student-resources", [d.dept]);
    if (rec) keep.push({ _id: a._id, name: a.name, type: rec.mime, size: rec.size, path: rec.path }); else keep.push(a.toObject());
  }
  let legacy = {};
  if (d.fileData) {
    const rec = await put("student resource files", b64(d.fileData), d.fileName || "file", d.fileType, "student-resources", [d.dept]);
    if (rec) { keep.push({ name: d.fileName, type: rec.mime, size: rec.size, path: rec.path }); legacy = { fileName: "", fileType: "", fileSize: 0, fileData: "" }; }
  }
  if (RUN && (Object.keys(legacy).length || keep.some((k, i) => k.path && !(d.attachments?.[i]?.path)))) await StudentResource.updateOne({ _id: d._id }, { $set: { attachments: keep, ...legacy } });
}

for (const n of await ExamNotice.find({ "attachments.data": /^data:/ })) {
  const list = n.toObject().attachments;
  for (const a of list) {
    if (a.kind === "photo" || !String(a.data).startsWith("data:")) continue;
    const parsed = sb.parseDataUrl(a.data);
    if (!parsed) continue;
    const rec = await put("exam cell files", parsed.buffer, a.name || "file", a.mime, "exam-cell", [`year-${n.year}`]);
    if (rec) { a.data = sb.refOf(rec.path); a.mime = rec.mime; a.size = rec.size; }
  }
  if (RUN) await ExamNotice.updateOne({ _id: n._id }, { $set: { attachments: list } });
}

console.table(stats);
if (!RUN) console.log("Nothing changed. Run again with --run to move these files.");
process.exit(0);
