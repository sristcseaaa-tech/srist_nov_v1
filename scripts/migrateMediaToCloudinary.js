// One-time move of pictures/files that are still stored as base64 inside MongoDB into Cloudinary.
//   node scripts/migrateMediaToCloudinary.js            -> DRY RUN: only counts what would move
//   node scripts/migrateMediaToCloudinary.js --run      -> uploads, then replaces the base64 with the Cloudinary URL
// Safe to repeat: values that are already URLs are skipped. The base64 is only removed AFTER its upload succeeded.
// Website pictures -> Account 1 (CLOUDINARY_WEBSITE_URL); student pictures/files -> Account 2 (CLOUDINARY_STUDENT_URL).
import "dotenv/config";
import { connectDatabases } from "../db.js";
import * as media from "../utils/media.js";
import { setImage, setImagesInText } from "../utils/mediaFields.js";
import { storeAttachment } from "../utils/attachments.js";
import User from "../models/User.js";
import StudentAccount from "../models/StudentAccount.js";
import Faculty from "../models/Faculty.js";
import DeptProfile from "../models/DeptProfile.js";
import Notice from "../models/Notice.js";
import Event from "../models/Event.js";
import AdmissionNotice from "../models/AdmissionNotice.js";
import Newsletter from "../models/Newsletter.js";
import Content from "../models/Content.js";
import PlacementStory from "../models/PlacementStory.js";
import PlacementRecord from "../models/PlacementRecord.js";
import PlacementCompany from "../models/PlacementCompany.js";
import OurStudent from "../models/OurStudent.js";
import Application from "../models/Application.js";
import StudentResource from "../models/StudentResource.js";
import Task from "../models/Task.js";
import DiscussionMessage from "../models/DiscussionMessage.js";
import ExamNotice from "../models/ExamNotice.js";

const RUN = process.argv.includes("--run");
const W = media.WEBSITE, S = media.STUDENT;
const stats = {}; const bump = (k, f) => { stats[k] = stats[k] || { found: 0, moved: 0, failed: 0 }; stats[k][f]++; };
const isB64 = (v) => typeof v === "string" && v.startsWith("data:");
const by = { id: "migration", kind: "script" };

// Moves one image field of one document.
async function field(Model, label, docs, path, account, ctx) {
  for (const d of docs) {
    const v = path.split(".").reduce((o, k) => o?.[k], d);
    if (!isB64(v)) continue;
    bump(label, "found");
    if (!RUN) continue;
    try {
      const c = ctx(d);
      const url = await setImage(v, { account, uploadedBy: by, allowSvg: account === W, ...c });
      await Model.updateOne({ _id: d._id }, { $set: { [path]: url } });
      bump(label, "moved");
    } catch (e) { bump(label, "failed"); console.error(`  ${label} ${d._id}: ${e.message}`); }
  }
}
const lean = (M, sel) => M.find({}).select(sel).lean();

await connectDatabases();
if (RUN) for (const a of [W, S]) if (!media.accountReady(a)) { console.error(`Account "${a}" is not configured — set its CLOUDINARY_*_URL first.`); process.exit(1); }

// ---- website media (Account 1)
await field(User, "staff photos", await lean(User, "profileImage role"), "profileImage", W, (d) => ({ category: "employee-photo", ownerType: "user", ownerId: String(d._id), folder: media.employeeFolder(d._id) }));
await field(Faculty, "faculty photos", await lean(Faculty, "photo"), "photo", W, (d) => ({ category: "employee-photo", ownerType: "faculty", ownerId: String(d._id), folder: media.employeeFolder(d._id) }));
const dp = await lean(DeptProfile, "dept logo hodPhoto");
await field(DeptProfile, "department logos", dp, "logo", W, (d) => ({ category: "department-logo", ownerType: "department", ownerId: d.dept, folder: `srist/website/departments/${d.dept}/logo` }));
await field(DeptProfile, "HOD photos", dp, "hodPhoto", W, (d) => ({ category: "department-hod", ownerType: "department", ownerId: d.dept, folder: `srist/website/departments/${d.dept}/hod` }));
await field(Notice, "department notices", await lean(Notice, "dept image"), "image", W, (d) => ({ category: "department-notice", ownerType: "notice", ownerId: String(d._id), folder: `srist/website/departments/${d.dept}/notices` }));
await field(Event, "department events", await lean(Event, "dept image"), "image", W, (d) => ({ category: "department-event", ownerType: "event", ownerId: String(d._id), folder: `srist/website/departments/${d.dept}/events` }));
await field(AdmissionNotice, "admission notices", await lean(AdmissionNotice, "image"), "image", W, (d) => ({ category: "admission-notice", ownerType: "admission-notice", ownerId: String(d._id), folder: "srist/website/admission/notices" }));
await field(PlacementCompany, "company logos", await lean(PlacementCompany, "logo key"), "logo", W, (d) => ({ category: "placement-company-logo", ownerType: "placement-company", ownerId: d.key, folder: "srist/website/placement/companies" }));

for (const d of await Newsletter.find({}).lean()) {
  const paths = ["coverImage", "featuredStory.image"];
  for (const k of ["achievements", "events", "departmentHighlights", "studentAchievements", "facultyAchievements", "researchHighlights", "placementHighlights", "upcomingEvents"]) (d[k] || []).forEach((_, i) => paths.push(`${k}.${i}.image`));
  for (const p of paths) await field(Newsletter, "newsletter images", [d], p, W, () => ({ category: "newsletter", ownerType: "newsletter", ownerId: String(d._id), folder: `srist/website/newsletters/${d._id}` }));
}
for (const d of await Content.find({}).lean()) {
  if (!/data:image/.test(d.value || "")) continue;
  bump("customize sections", "found");
  if (!RUN) continue;
  try {
    const v = await setImagesInText(d.value, { account: W, uploadedBy: by, category: `section-${d.section}`, ownerType: "content", ownerId: `${d.section}.${d.key}`, folder: `srist/website/sections/${d.section}/${String(d.key).replace(/[^\w-]+/g, "-").slice(0, 40)}` });
    await Content.updateOne({ _id: d._id }, { $set: { value: v } }); bump("customize sections", "moved");
  } catch (e) { bump("customize sections", "failed"); console.error(`  content ${d.section}.${d.key}: ${e.message}`); }
}

// ---- student media (Account 2, private)
await field(StudentAccount, "student photos", await lean(StudentAccount, "profileImage"), "profileImage", S, (d) => ({ category: "student-profile", ownerType: "student", ownerId: String(d._id), folder: media.studentFolder(d._id) }));
await field(OurStudent, "roster photos", await lean(OurStudent, "logo"), "logo", S, (d) => ({ category: "student-profile", ownerType: "student", ownerId: String(d._id), folder: media.studentFolder(d._id) }));
await field(Application, "applicant photos", await lean(Application, "logo"), "logo", S, (d) => ({ category: "student-profile", ownerType: "applicant", ownerId: String(d._id), folder: `srist/students/applicants/${d._id}` }));
await field(PlacementStory, "placement stories", await lean(PlacementStory, "photo"), "photo", S, (d) => ({ category: "placement-story", ownerType: "placement-story", ownerId: String(d._id), folder: "srist/students/placement/story" }));
await field(PlacementRecord, "placement photos", await PlacementRecord.find({}).select("+photo").lean(), "photo", S, (d) => ({ category: "placement-record", ownerType: "placement-record", ownerId: String(d._id), folder: "srist/students/placement/record" }));
await field(StudentResource, "student resource images", await lean(StudentResource, "dept image"), "image", S, (d) => ({ category: "student-resource-image", ownerType: "student-resource", ownerId: String(d._id), folder: `srist/students/resources/${d.dept}/${d._id}` }));

for (const d of await StudentResource.find({}).select("+attachments.data dept studentId").lean()) {
  for (const [i, a] of (d.attachments || []).entries()) {
    if (!a.data || a.url) continue;
    bump("student resource files", "found");
    if (!RUN) continue;
    try {
      const rec = await media.uploadPrivateFile({ buffer: Buffer.from(a.data.buffer || a.data), originalname: a.name, mimetype: a.type }, `srist/students/resources/${d.dept}/${d._id}`, { category: d.studentId ? "student-document" : "student-resource", ownerType: "student-resource", ownerId: String(d._id), uploadedBy: by });
      await StudentResource.updateOne({ _id: d._id }, { $set: { [`attachments.${i}.url`]: rec.url, [`attachments.${i}.publicId`]: rec.publicId, [`attachments.${i}.resourceType`]: rec.resourceType, [`attachments.${i}.format`]: rec.format }, $unset: { [`attachments.${i}.data`]: "" } });
      bump("student resource files", "moved");
    } catch (e) { bump("student resource files", "failed"); console.error(`  resource ${d._id}: ${e.message}`); }
  }
}
for (const d of await DiscussionMessage.find({ "note.data": /^data:/ }).lean()) {
  bump("discussion attachments", "found");
  if (!RUN) continue;
  try {
    const r = await storeAttachment({ kind: d.note.kind, name: d.note.name, data: d.note.data }, { account: S, folder: `srist/students/${d.studentId}/discussion`, category: "discussion", ownerType: "discussion", ownerId: String(d.studentId), uploadedBy: by });
    await DiscussionMessage.updateOne({ _id: d._id }, { $set: { "note.data": r.data } }); bump("discussion attachments", "moved");
  } catch (e) { bump("discussion attachments", "failed"); console.error(`  discussion ${d._id}: ${e.message}`); }
}

// ---- staff-internal / exam attachments (Account 1, private)
async function lists(Model, label, docs, getLists, folder, category) {
  for (const d of docs) for (const { path, list } of getLists(d)) {
    for (const [i, a] of list.entries()) {
      if (!isB64(a.data)) continue;
      bump(label, "found");
      if (!RUN) continue;
      try {
        const r = await storeAttachment(a, { account: W, private: true, folder: folder(d), category, ownerType: category, ownerId: String(d._id), uploadedBy: by });
        await Model.updateOne({ _id: d._id }, { $set: { [`${path}.${i}.data`]: r.data, [`${path}.${i}.mime`]: r.mime, [`${path}.${i}.size`]: r.size } }); bump(label, "moved");
      } catch (e) { bump(label, "failed"); console.error(`  ${label} ${d._id}: ${e.message}`); }
    }
  }
}
await lists(Task, "task attachments", await Task.find({}).lean(), (d) => [{ path: "attachments", list: d.attachments || [] }, ...(d.responses || []).map((r, ri) => ({ path: `responses.${ri}.attachments`, list: r.attachments || [] }))], (d) => `srist/website/tasks/${d._id}`, "task-attachment");
await lists(ExamNotice, "exam notice attachments", await ExamNotice.find({}).lean(), (d) => [{ path: "attachments", list: d.attachments || [] }], (d) => `srist/website/exam-cell/${d.year}/${d._id}`, "exam-notice");

console.log(RUN ? "\nMigration finished:" : "\nDRY RUN — nothing was changed. Items that still hold base64:");
console.table(stats);
if (!Object.keys(stats).length) console.log("Nothing to migrate.");
process.exit(0);
