import express from "express";
import mongoose from "mongoose";
import PlacementRecord from "../models/PlacementRecord.js";
import PlacementCompany from "../models/PlacementCompany.js";
import PlacementStory from "../models/PlacementStory.js";
import PlacementReport from "../models/PlacementReport.js";
import PlacementYearStat from "../models/PlacementYearStat.js";
import requireAuth from "../middleware/requireAuth.js";
import requireAccess from "../middleware/requireAccess.js";
import { parseSeed, SEED_STORIES } from "../seed/placementData.js";
import * as media from "../utils/media.js";
import { setImage, dropImages, uploader } from "../utils/mediaFields.js";
import * as sb from "../utils/supabase.js";

const router = express.Router();
// Admins and Placement_Com accounts manage placement.
const admin = [requireAuth, requireAccess("placement")];

const MAX_IMG_CHARS = 7_000_000; // data-URL length (~5 MB); checked again byte-for-byte before upload
const isId = (id) => mongoose.isValidObjectId(id);
const str = (v, n) => String(v ?? "").trim().slice(0, n);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
// A placed student's photo is STUDENT media -> Cloudinary Account 2 (private; only the server can sign it).
// Company logos are public site media -> Account 1.
const studentPhoto = (req, value, previous, ownerId, kind) => setImage(value, {
  account: media.STUDENT, category: `placement-${kind}`, ownerType: `placement-${kind}`, ownerId: String(ownerId),
  folder: `srist/students/placement/${kind}`, uploadedBy: uploader(req), previous, label: "Photo"
});
const companyLogo = (req, value, previous, ownerId) => setImage(value, {
  account: media.WEBSITE, category: "placement-company-logo", ownerType: "placement-company", ownerId: String(ownerId),
  folder: "srist/website/placement/companies", uploadedBy: uploader(req), previous, label: "Logo"
});
const fail = (res, err) => res.status(err.status || 500).json({ error: err.status ? err.message : "Something went wrong" });

// "SIGMA ELECTRIC" and "Sigma Electric" are the same company.
const keyOf = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Department spellings → one code (only clear synonyms; anything else is kept as typed).
const DEPT_MAP = {
  ce: "CE", civil: "CE", "c.e": "CE", "civil engineering": "CE",
  ee: "EE", ele: "EE", "e.e": "EE", dee: "EE", electrical: "EE", "electrical engineering": "EE",
  etce: "ETCE", etc: "ETCE", "e.t.c": "ETCE", ete: "ETCE", "electronics and telecommunication engineering": "ETCE",
  me: "ME", "m.e": "ME", mech: "ME", dme: "ME", "me dip": "ME", mechanical: "ME", "mechanical engineering": "ME",
  cst: "CST", cse: "CST", "computer science": "CST", "computer science & technology": "CST",
  arch: "ARCH", "arch.": "ARCH", architecture: "ARCH"
};
export const normDept = (d) => {
  const t = str(d, 40);
  if (!t || /^not written$/i.test(t)) return "";
  return DEPT_MAP[t.toLowerCase()] || t.toUpperCase();
};

function cleanImage(v) {
  const s = String(v ?? "");
  if (!s) return "";
  if (s.length > MAX_IMG_CHARS) throw bad("An image is too large — please use a smaller picture.");
  if (!/^(data:image\/(png|jpe?g|webp|gif);base64,|https?:\/\/|\/)/i.test(s)) throw bad("Images must be an uploaded picture or a link.");
  return s;
}

const cleanCompanies = (c) => {
  const list = Array.isArray(c) ? c : String(c ?? "").split(/[;\n]+/);
  const seen = new Set();
  return list.map((x) => str(x, 140)).filter((x) => x && !seen.has(keyOf(x)) && seen.add(keyOf(x)));
};
const dupKeyOf = (name, year, companies) =>
  [keyOf(name), year ?? "", [...companies].map(keyOf).sort().join("+")].join("|");

function cleanRecord(b, { partial = false } = {}) {
  const out = {};
  if (!partial || b.studentName !== undefined) {
    out.studentName = str(b.studentName, 120);
    if (!out.studentName) throw bad("Student name is required.");
  }
  if (!partial || b.companies !== undefined || b.company !== undefined) {
    out.companies = cleanCompanies(b.companies ?? b.company);
    if (!out.companies.length) throw bad("At least one company is required.");
  }
  if (!partial || b.department !== undefined) out.department = normDept(b.department);
  if (!partial || b.year !== undefined) {
    if (b.year === "" || b.year == null) out.year = null;
    else {
      const y = Number(b.year);
      if (!Number.isInteger(y) || y < 1990 || y > 2100) throw bad("Enter a valid placement year (or leave it blank).");
      out.year = y;
    }
  }
  for (const [k, n] of [["jobRole", 120], ["package", 60], ["placementType", 60], ["description", 600]]) {
    if (!partial || b[k] !== undefined) out[k] = str(b[k], n);
  }
  if (b.photo !== undefined) out.photo = cleanImage(b.photo);
  if (b.status !== undefined) out.status = b.status === "draft" ? "draft" : "published";
  return out;
}

const pubYearStat = (y) => ({
  year: y.year, studentsPlaced: y.studentsPlaced, companies: y.companies, multipleOffers: y.multipleOffers,
  highestPackage: y.highestPackage, highestPackageCompany: y.highestPackageCompany, averagePackage: y.averagePackage
});

// Optional non-negative number; blank → null (shown as "not available").
function optNum(v, label, { max = 1e6, decimals = true } = {}) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) throw bad(`${label} must be a number between 0 and ${max}.`);
  if (!decimals && !Number.isInteger(n)) throw bad(`${label} must be a whole number.`);
  return decimals ? Math.round(n * 100) / 100 : n;
}
function cleanYearStat(b) {
  const year = Number(b.year);
  if (!Number.isInteger(year) || year < 1990 || year > 2100) throw bad("Enter a valid placement year.");
  const out = {
    year,
    studentsPlaced: optNum(b.studentsPlaced, "Students placed", { max: 100000, decimals: false }),
    companies: optNum(b.companies, "Companies", { max: 10000, decimals: false }),
    multipleOffers: optNum(b.multipleOffers, "Students with multiple offers", { max: 100000, decimals: false }),
    highestPackage: optNum(b.highestPackage, "Highest package (LPA)", { max: 1000 }),
    averagePackage: optNum(b.averagePackage, "Average package (LPA)", { max: 1000 }),
    highestPackageCompany: str(b.highestPackageCompany, 140),
    status: b.status === "draft" ? "draft" : "published"
  };
  if (out.highestPackage != null && out.averagePackage != null && out.averagePackage > out.highestPackage)
    throw bad("The average package cannot be higher than the highest package.");
  if (out.studentsPlaced != null && out.multipleOffers != null && out.multipleOffers > out.studentsPlaced)
    throw bad("Students with multiple offers cannot exceed students placed.");
  return out;
}

// ----------------------------------------------------------------------------
// PUBLIC
// ----------------------------------------------------------------------------
router.get("/public", async (req, res) => {
  try {
    const [records, stories, reports, companies, yearStats] = await Promise.all([
      PlacementRecord.find({ status: "published" }).sort({ year: -1, studentName: 1 })
        .select("studentName department companies year jobRole package placementType description +photo"),
      PlacementStory.find({ status: "published" }).sort({ order: 1, createdAt: 1 }),
      PlacementReport.find({ status: "published" }).sort({ year: -1, createdAt: -1 }).select("title year description fileName fileSize"),
      PlacementCompany.find(),
      PlacementYearStat.find({ status: "published" }).sort({ year: 1 })
    ]);
    res.json({
      yearStats: yearStats.map(pubYearStat),
      records: records.map((r) => ({
        id: String(r._id), name: r.studentName, dept: r.department, companies: r.companies, year: r.year,
        role: r.jobRole, package: r.package, type: r.placementType, note: r.description, hasPhoto: !!r.photo
      })),
      stories: stories.map((s) => ({ id: String(s._id), name: s.studentName, dept: s.department, company: s.company, year: s.year, photo: media.deliver(s.photo, { w: 400, h: 400 }), quote: s.quote })),
      reports: reports.map((r) => ({ id: String(r._id), title: r.title, year: r.year, description: r.description, hasFile: !!r.fileName, fileSize: r.fileSize })),
      companies: companies.map((c) => ({ name: c.name, key: c.key, logo: media.deliver(c.logo, { w: 240 }), website: c.website, note: c.note, industry: c.industry, featured: c.featured !== false, order: c.order || 0 }))
    });
  } catch (err) { console.error(err); fail(res, err); }
});

// A student's optional photo as an image.
router.get("/records/:id/photo", async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).end();
    const r = await PlacementRecord.findOne({ _id: req.params.id, status: "published" }).select("+photo");
    if (!r?.photo) return res.status(404).end();
    // Photos live in Cloudinary now; the visitor is sent to a freshly signed, resized copy.
    // (Legacy base64 photos that have not been migrated yet are still served so nothing breaks.)
    const m = /^data:(image\/[\w+.-]+);base64,(.+)$/.exec(r.photo);
    if (!m) return res.redirect(media.deliver(r.photo, { w: 400, h: 400 }));
    res.setHeader("Content-Type", m[1]);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(Buffer.from(m[2], "base64"));
  } catch { res.status(404).end(); }
});

// Report PDF — inline by default, ?download=1 to save.
router.get("/reports/:id/file", async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: "Not found" });
    const r = await PlacementReport.findOne({ _id: req.params.id, status: "published" }).select("+data fileName filePath");
    if (!r?.filePath && !r?.data) return res.status(404).json({ error: "File not found" });
    if (r.filePath) return await sb.stream(res, r.filePath, { name: r.fileName, mime: "application/pdf", download: !!req.query.download }); // Supabase Storage
    const buf = Buffer.from(r.data, "base64"); // legacy: saved in MongoDB before the move
    const safe = r.fileName.replace(/[^\w.\- ]/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(r.fileName)}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(buf);
  } catch (err) { if (res.headersSent) return res.destroy(); if (!err.status) console.error(err); fail(res, err); }
});

// ----------------------------------------------------------------------------
// ADMIN — records
// ----------------------------------------------------------------------------
const adminRec = (r) => ({
  id: String(r._id), studentName: r.studentName, department: r.department, companies: r.companies, year: r.year,
  jobRole: r.jobRole, package: r.package, placementType: r.placementType, description: r.description,
  status: r.status, hasPhoto: !!r.photo
});

router.get("/admin/all", admin, async (req, res) => {
  try {
    const [records, stories, reports, companies, yearStats] = await Promise.all([
      PlacementRecord.find().sort({ year: -1, studentName: 1 }).select("+photo"),
      PlacementStory.find().sort({ order: 1, createdAt: 1 }),
      PlacementReport.find().sort({ year: -1, createdAt: -1 }).select("title year description fileName fileSize status"),
      PlacementCompany.find().sort({ name: 1 }),
      PlacementYearStat.find().sort({ year: -1 })
    ]);
    res.json({
      yearStats: yearStats.map((y) => ({ ...pubYearStat(y), id: String(y._id), status: y.status })),
      records: records.map(adminRec),
      stories: stories.map((s) => ({ id: String(s._id), studentName: s.studentName, department: s.department, company: s.company, year: s.year, photo: media.deliver(s.photo, { w: 400, h: 400 }), quote: s.quote, order: s.order, status: s.status })),
      reports: reports.map((r) => ({ id: String(r._id), title: r.title, year: r.year, description: r.description, fileName: r.fileName, fileSize: r.fileSize, status: r.status })),
      companies: companies.map((c) => ({ id: String(c._id), name: c.name, logo: media.deliver(c.logo, { w: 240 }), website: c.website, note: c.note, industry: c.industry, featured: c.featured !== false, order: c.order || 0 }))
    });
  } catch (err) { console.error(err); fail(res, err); }
});

router.get("/admin/records/:id/photo", admin, async (req, res) => {
  const r = isId(req.params.id) && await PlacementRecord.findById(req.params.id).select("+photo");
  res.json({ photo: media.deliver(r?.photo || "", { w: 600 }) });
});

router.post("/admin/records", admin, async (req, res) => {
  try {
    const data = cleanRecord(req.body || {});
    data.dupKey = dupKeyOf(data.studentName, data.year, data.companies);
    if (await PlacementRecord.exists({ dupKey: data.dupKey })) throw bad("That student already has this placement for this year.", 409);
    const _id = new mongoose.Types.ObjectId();
    if (data.photo !== undefined) data.photo = await studentPhoto(req, data.photo, "", _id, "record");
    let doc;
    try { doc = await PlacementRecord.create({ ...data, _id }); }
    catch (e) { await dropImages(data.photo); throw e; }
    res.status(201).json({ record: adminRec(doc) });
  } catch (err) { fail(res, err); }
});

router.put("/admin/records/:id", admin, async (req, res) => {
  try {
    if (!isId(req.params.id)) throw bad("Record not found", 404);
    const doc = await PlacementRecord.findById(req.params.id).select("+photo");
    if (!doc) throw bad("Record not found", 404);
    const data = cleanRecord(req.body || {}, { partial: true });
    if (data.photo !== undefined) data.photo = await studentPhoto(req, data.photo, doc.photo, doc._id, "record");
    Object.assign(doc, data);
    doc.dupKey = dupKeyOf(doc.studentName, doc.year, doc.companies);
    const clash = await PlacementRecord.exists({ dupKey: doc.dupKey, _id: { $ne: doc._id } });
    if (clash) throw bad("Another record already has this student, company and year.", 409);
    await doc.save();
    res.json({ record: adminRec(doc) });
  } catch (err) { fail(res, err); }
});

router.delete("/admin/records/:id", admin, async (req, res) => {
  try {
    if (isId(req.params.id)) { const gone = await PlacementRecord.findByIdAndDelete(req.params.id).select("+photo"); if (gone) await dropImages(gone.photo); }
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

router.post("/admin/records/delete-many", admin, async (req, res) => {
  try {
    const ids = (req.body?.ids || []).filter(isId);
    const withPhotos = await PlacementRecord.find({ _id: { $in: ids } }).select("+photo");
    await dropImages(...withPhotos.map((d) => d.photo));
    const r = await PlacementRecord.deleteMany({ _id: { $in: ids } });
    res.json({ deleted: r.deletedCount });
  } catch (err) { fail(res, err); }
});

router.post("/admin/records/status", admin, async (req, res) => {
  try {
    const ids = (req.body?.ids || []).filter(isId);
    const status = req.body?.status === "draft" ? "draft" : "published";
    const r = await PlacementRecord.updateMany({ _id: { $in: ids } }, { status });
    res.json({ updated: r.modifiedCount });
  } catch (err) { fail(res, err); }
});

// Import many records. Duplicates (same student + company + year), inside the
// file or already stored, are skipped and counted.
async function importRecords(rows, req) {
  const clean = [];
  const invalid = [];
  rows.forEach((r, i) => {
    try { const d = cleanRecord(r); d.dupKey = dupKeyOf(d.studentName, d.year, d.companies); clean.push(d); }
    catch (e) { invalid.push({ row: i + 1, reason: e.message }); }
  });
  const keys = [...new Set(clean.map((c) => c.dupKey))];
  const existing = new Set((await PlacementRecord.find({ dupKey: { $in: keys } }).select("dupKey")).map((d) => d.dupKey));
  const seen = new Set(existing);
  const toInsert = [];
  let duplicates = 0;
  for (const d of clean) {
    if (seen.has(d.dupKey)) { duplicates++; continue; }
    seen.add(d.dupKey); toInsert.push(d);
  }
  for (const d of toInsert) if (d.photo && media.isDataUrl(d.photo)) d.photo = await studentPhoto(req, d.photo, "", d.dupKey.slice(0, 40), "record");
  if (toInsert.length) await PlacementRecord.insertMany(toInsert, { ordered: false });
  return { imported: toInsert.length, duplicates, invalid: invalid.length, invalidRows: invalid.slice(0, 20) };
}

router.post("/admin/records/bulk", admin, async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.records) ? req.body.records.slice(0, 5000) : [];
    if (!rows.length) throw bad("No records to import.");
    res.json(await importRecords(rows, req));
  } catch (err) { fail(res, err); }
});

// One-click load of the records on the official SRIST page (safe to repeat).
router.post("/admin/seed", admin, async (req, res) => {
  try {
    const result = await importRecords(parseSeed(), req);
    let stories = 0;
    for (const s of SEED_STORIES) {
      if (!(await PlacementStory.exists({ studentName: s.studentName, company: s.company }))) {
        await PlacementStory.create({ ...s, status: "published" }); stories++;
      }
    }
    res.json({ ...result, stories });
  } catch (err) { console.error(err); fail(res, err); }
});

// ----------------------------------------------------------------------------
// ADMIN — stories, companies, reports
// ----------------------------------------------------------------------------
function cleanStory(b) {
  const out = {
    studentName: str(b.studentName, 120), department: str(b.department, 80), company: str(b.company, 140),
    quote: str(b.quote, 400), photo: cleanImage(b.photo), order: Number(b.order) || 0,
    status: b.status === "draft" ? "draft" : "published"
  };
  if (!out.studentName || !out.company) throw bad("Student name and company are required.");
  const y = b.year === "" || b.year == null ? null : Number(b.year);
  if (y !== null && (!Number.isInteger(y) || y < 1990 || y > 2100)) throw bad("Enter a valid year (or leave it blank).");
  out.year = y;
  return out;
}
router.post("/admin/stories", admin, async (req, res) => {
  try {
    const data = cleanStory(req.body || {});
    const _id = new mongoose.Types.ObjectId();
    data.photo = await studentPhoto(req, data.photo, "", _id, "story");
    let doc;
    try { doc = await PlacementStory.create({ ...data, _id }); } catch (e) { await dropImages(data.photo); throw e; }
    res.status(201).json({ id: String(doc._id) });
  } catch (e) { fail(res, e); }
});
router.put("/admin/stories/:id", admin, async (req, res) => {
  try {
    if (!isId(req.params.id)) throw bad("Not found", 404);
    const data = cleanStory(req.body || {});
    const old = await PlacementStory.findById(req.params.id);
    if (!old) throw bad("Not found", 404);
    data.photo = await studentPhoto(req, data.photo, old.photo, old._id, "story");
    await PlacementStory.findByIdAndUpdate(req.params.id, data);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
router.delete("/admin/stories/:id", admin, async (req, res) => {
  try {
    if (isId(req.params.id)) { const gone = await PlacementStory.findByIdAndDelete(req.params.id); if (gone) await dropImages(gone.photo); }
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

router.post("/admin/year-stats", admin, async (req, res) => {
  try {
    const data = cleanYearStat(req.body || {});
    if (await PlacementYearStat.exists({ year: data.year })) throw bad(`Statistics for ${data.year} already exist — edit that year instead.`, 409);
    await PlacementYearStat.create(data);
    res.status(201).json({ ok: true });
  } catch (e) { fail(res, e); }
});
router.put("/admin/year-stats/:id", admin, async (req, res) => {
  try {
    if (!isId(req.params.id)) throw bad("Not found", 404);
    const data = cleanYearStat(req.body || {});
    if (await PlacementYearStat.exists({ year: data.year, _id: { $ne: req.params.id } })) throw bad(`Statistics for ${data.year} already exist.`, 409);
    const doc = await PlacementYearStat.findByIdAndUpdate(req.params.id, data);
    if (!doc) throw bad("Not found", 404);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
router.delete("/admin/year-stats/:id", admin, async (req, res) => {
  try { if (isId(req.params.id)) await PlacementYearStat.deleteOne({ _id: req.params.id }); res.json({ ok: true }); } catch (e) { fail(res, e); }
});

router.put("/admin/companies", admin, async (req, res) => {
  try {
    const name = str(req.body?.name, 140);
    if (!name) throw bad("Company name is required.");
    const key = keyOf(name);
    const old = await PlacementCompany.findOne({ key });
    const data = {
      name, key, logo: await companyLogo(req, cleanImage(req.body?.logo), old?.logo, key.replace(/\s+/g, "-").slice(0, 40)), website: str(req.body?.website, 300), note: str(req.body?.note, 300),
      industry: str(req.body?.industry, 80), featured: req.body?.featured !== false, order: Math.round(Number(req.body?.order)) || 0
    };
    await PlacementCompany.findOneAndUpdate({ key: data.key }, data, { upsert: true, new: true, setDefaultsOnInsert: true });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
router.delete("/admin/companies/:id", admin, async (req, res) => {
  try {
    if (isId(req.params.id)) { const gone = await PlacementCompany.findByIdAndDelete(req.params.id); if (gone) await dropImages(gone.logo); }
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// The report PDF goes to Supabase Storage (folder: placement-reports/); MongoDB keeps name, size and path only.
// pdf: undefined = leave alone · null = remove · { name, ticket } / { name, data } = replace.
async function applyPdf(doc, pdf, req) {
  if (pdf === undefined) return;
  doc.$locals = doc.$locals || {};
  if (pdf === null) {
    if (doc.filePath) doc.$locals.oldPath = doc.filePath;
    doc.data = ""; doc.filePath = ""; doc.fileName = ""; doc.fileSize = 0; return;
  }
  if (!pdf?.ticket && !pdf?.data) return; // the page sent the existing file info back — nothing new
  const name = str(pdf?.name, 200).replace(/[\\/\r\n"]/g, "_");
  if (!name.toLowerCase().endsWith(".pdf")) throw bad("The report must be a PDF file.");
  const rec = await sb.claim({ ...pdf, name }, { section: "placement-reports", uid: req?.userId, exts: ["pdf"] });
  doc.$locals.newPath = rec.path;
  if (doc.filePath) doc.$locals.oldPath = doc.filePath;
  doc.data = ""; doc.filePath = rec.path; doc.fileName = rec.name; doc.fileSize = rec.size;
}
function reportFields(b) {
  const title = str(b.title, 160);
  if (!title) throw bad("Report title is required.");
  const y = b.year === "" || b.year == null ? null : Number(b.year);
  if (y !== null && (!Number.isInteger(y) || y < 1990 || y > 2100)) throw bad("Enter a valid year (or leave it blank).");
  return { title, year: y, description: str(b.description, 400), status: b.status === "draft" ? "draft" : "published" };
}
router.post("/admin/reports", admin, async (req, res) => {
  try {
    const doc = new PlacementReport(reportFields(req.body || {}));
    try { await applyPdf(doc, req.body?.pdf, req); await doc.save(); }
    catch (e) { await sb.remove([doc.$locals?.newPath]); throw e; }
    res.status(201).json({ id: String(doc._id) });
  } catch (e) { fail(res, e); }
});
router.put("/admin/reports/:id", admin, async (req, res) => {
  try {
    if (!isId(req.params.id)) throw bad("Not found", 404);
    const doc = await PlacementReport.findById(req.params.id).select("+data filePath");
    if (!doc) throw bad("Not found", 404);
    Object.assign(doc, reportFields(req.body || {}));
    try { await applyPdf(doc, req.body?.pdf, req); await doc.save(); }
    catch (e) { await sb.remove([doc.$locals?.newPath]); throw e; }
    if (doc.$locals?.oldPath) await sb.remove([doc.$locals.oldPath]); // replaced / removed PDF -> delete from Supabase
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
router.delete("/admin/reports/:id", admin, async (req, res) => {
  try {
    if (isId(req.params.id)) {
      const gone = await PlacementReport.findByIdAndDelete(req.params.id).select("filePath");
      if (gone?.filePath) await sb.remove([gone.filePath]);
    }
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

export default router;
