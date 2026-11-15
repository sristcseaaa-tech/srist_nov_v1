import express from "express";
import mongoose from "mongoose";
import StorageFile from "../models/StorageFile.js";
import requireAuth from "../middleware/requireAuth.js";
import requireAdmin from "../middleware/requireAdmin.js";
import optionalAuth from "../middleware/optionalAuth.js";
import User from "../models/User.js";
import isAdminEmail from "../utils/isAdminEmail.js";
import { str, fail_ as fail } from "../utils/safeFile.js";
import * as sb from "../utils/supabase.js";
import MediaAsset from "../models/MediaAsset.js";
import * as media from "../utils/media.js";

import { isDeptRole } from "../utils/roles.js";
// Admin → Storage.  Every file goes straight to Supabase Storage (admin-uploads/<role>/<section>/…).
//
//   GET    /api/storage/meta           admin   role types + sections the page offers, storage status
//   GET    /api/storage/files          admin   ?role=&section=   saved uploads (with a 1 h open link each)
//   POST   /api/storage/files          admin   { role, section, page?, label?, file:{name,ticket} }
//   PUT    /api/storage/files/:id      admin   { label?, role?, section?, page?, visible? }
//   DELETE /api/storage/files/:id      admin   removes the record AND the Supabase object
//   GET    /api/storage/bucket         admin   everything in the bucket, grouped by top-level folder
//   GET    /api/storage/cloudinary     admin   every picture in Cloudinary (website account), grouped by category
//   DELETE /api/storage/object         admin   { path }  remove any single object from the bucket
//   GET    /api/storage/for-me         any     ?section=  files this visitor's role may open (signed links)
const router = express.Router();
const isId = (id) => mongoose.isValidObjectId(id);

// Role types = who may open a file.
export const ROLES = {
  public: "Everyone (public)",
  student: "Students",
  staff: "All office accounts",
  editor: "Asst_Prof / HOD (department staff)",
  exam: "Exam Cell accounts",
  admin: "Admins only"
};
// Sections / pages a file can be filed under.
export const PAGES = {
  general: "General",
  home: "Home page",
  resources: "Resources page",
  navigation: "Navigation (Resources menu)",
  newsletter: "Newsletter",
  placement: "Training & Placement",
  admission: "Admission / Apply",
  "exam-cell": "Exam Cell",
  "student-portal": "Student portal",
  tasks: "Task Center",
  customize: "Customize sections"
};

const toPublic = (d, link = true) => ({
  id: String(d._id), role: d.role, section: d.section, page: d.page || "", label: d.label || "",
  fileName: d.fileName, fileExt: sb.extOf(d.fileName), fileSize: d.fileSize || 0, visible: d.visible !== false,
  createdAt: d.createdAt,
  url: link ? sb.linkFor(d.filePath, { name: d.fileName, mime: d.fileType, ttl: 3600 }) : undefined
});

// Which role types does the person asking belong to? (decided on the server from the token)
async function audienceOf(req) {
  const r = new Set(["public"]);
  if (!req.isSignedIn) return { roles: r, admin: false };
  if (req.userKind === "student") { r.add("student"); return { roles: r, admin: false }; }
  const u = await User.findById(req.userId).select("role email");
  if (!u) return { roles: r, admin: false };
  const admin = u.role === "admin" || isAdminEmail(u.email);
  r.add("staff");
  if (isDeptRole(u.role)) r.add("editor");
  if (u.role === "exam_role") r.add("exam");
  if (admin) ["student", "staff", "editor", "exam", "admin"].forEach((x) => r.add(x));
  return { roles: r, admin };
}

const handle = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    if (!e.status) console.error("[storage]", e);
    res.status(e.status || 500).json({ error: e.status ? e.message : "Storage error" });
  }
};
const checkRoleSection = (role, section) => {
  if (!ROLES[role]) throw fail("Choose a valid role type.");
  if (!PAGES[section]) throw fail("Choose a valid section.");
};

router.get("/for-me", optionalAuth, handle(async (req, res) => {
  const { roles } = await audienceOf(req);
  const filter = { visible: true, role: { $in: [...roles] } };
  if (req.query.section) filter.section = str(req.query.section, 40).toLowerCase();
  const list = await StorageFile.find(filter).sort({ section: 1, createdAt: -1 }).limit(500);
  res.json({ files: list.map((d) => toPublic(d)) });
}));

const admin = [requireAuth, requireAdmin];

router.get("/meta", ...admin, handle(async (req, res) => {
  res.json({ roles: ROLES, sections: PAGES, storage: sb.describe() });
}));

router.get("/files", ...admin, handle(async (req, res) => {
  const filter = {};
  if (req.query.role && ROLES[req.query.role]) filter.role = req.query.role;
  if (req.query.section && PAGES[req.query.section]) filter.section = req.query.section;
  const list = await StorageFile.find(filter).sort({ createdAt: -1 }).limit(1000);
  res.json({ files: list.map((d) => toPublic(d)) });
}));

router.post("/files", ...admin, handle(async (req, res) => {
  const b = req.body || {};
  const role = str(b.role, 20).toLowerCase(), section = str(b.section, 40).toLowerCase();
  checkRoleSection(role, section);
  let rec;
  try {
    rec = await sb.claim(b.file, { section: "admin-uploads", uid: req.userId, sub: [role, section] });
    const doc = await StorageFile.create({
      role, section, page: str(b.page, 80), label: str(b.label, 160),
      fileName: rec.name, fileType: rec.mime, fileSize: rec.size, filePath: rec.path, uploadedBy: String(req.userId)
    });
    res.status(201).json({ file: toPublic(doc) });
  } catch (e) {
    if (rec?.path) await sb.remove([rec.path]); // never leave an orphan in Supabase
    throw e;
  }
}));

router.put("/files/:id", ...admin, handle(async (req, res) => {
  if (!isId(req.params.id)) throw fail("File not found", 404);
  const d = await StorageFile.findById(req.params.id);
  if (!d) throw fail("File not found", 404);
  const b = req.body || {};
  if (b.role !== undefined || b.section !== undefined) {
    const role = b.role !== undefined ? str(b.role, 20).toLowerCase() : d.role;
    const section = b.section !== undefined ? str(b.section, 40).toLowerCase() : d.section;
    checkRoleSection(role, section);
    d.role = role; d.section = section; // the object stays where it is; only who-sees-it / where-it-shows changes
  }
  if (b.label !== undefined) d.label = str(b.label, 160);
  if (b.page !== undefined) d.page = str(b.page, 80);
  if (b.visible !== undefined) d.visible = !!b.visible;
  await d.save();
  res.json({ file: toPublic(d) });
}));

router.delete("/files/:id", ...admin, handle(async (req, res) => {
  if (!isId(req.params.id)) throw fail("File not found", 404);
  const gone = await StorageFile.findByIdAndDelete(req.params.id).select("filePath");
  if (gone?.filePath) await sb.remove([gone.filePath]);
  res.json({ ok: true });
}));

// The whole bucket, grouped by top-level folder, so an admin can see (and clean up) what each part of the site stores.
router.get("/bucket", ...admin, handle(async (req, res) => {
  if (!sb.ready()) throw fail("Supabase is not configured on the server (SUPABASE_URL / SUPABASE_SECRET_KEY).", 503);
  const objs = await sb.listTree("");
  const folders = {};
  for (const o of objs) {
    const top = sb.sectionOfPath(o.path);
    const f = (folders[top] ||= { folder: top, label: sb.SECTIONS[top]?.label || top, count: 0, bytes: 0, files: [] });
    f.count++; f.bytes += o.size;
    f.files.push({ ...o, name: o.path.split("/").pop().replace(/^[0-9a-f]{16}_/, ""), url: sb.linkFor(o.path, { name: o.path.split("/").pop().replace(/^[0-9a-f]{16}_/, ""), mime: o.mime, ttl: 3600 }) });
  }
  const list = Object.values(folders).sort((a, b) => a.folder.localeCompare(b.folder));
  res.json({ storage: sb.describe(), totalCount: objs.length, totalBytes: objs.reduce((n, o) => n + o.size, 0), folders: list });
}));

// Everything kept in Cloudinary (Account 1 — the website), grouped by category, so it can be reviewed like the Supabase bucket.
router.get("/cloudinary", ...admin, handle(async (req, res) => {
  const docs = await MediaAsset.find({ account: media.WEBSITE }).sort({ createdAt: -1 }).limit(3000).lean();
  const folders = {};
  for (const d of docs) {
    const f = (folders[d.category || "misc"] ||= { folder: d.category || "misc", label: (d.category || "misc").replace(/[-_]+/g, " "), count: 0, bytes: 0, files: [] });
    f.count++; f.bytes += d.bytes || 0;
    f.files.push({
      id: String(d._id), publicId: d.publicId, name: String(d.publicId).split("/").pop(), format: d.format, bytes: d.bytes || 0,
      width: d.width, height: d.height, createdAt: d.createdAt, folderPath: d.folder,
      url: media.deliver(d.url, { w: 160, h: 160 }), full: media.deliver(d.url, { w: 1600 })
    });
  }
  res.json({
    cloud: media.cloudNameOf(media.WEBSITE), ready: media.accountReady(media.WEBSITE),
    totalCount: docs.length, totalBytes: docs.reduce((n, d) => n + (d.bytes || 0), 0),
    folders: Object.values(folders).sort((a, b) => a.folder.localeCompare(b.folder))
  });
}));

router.delete("/object", ...admin, handle(async (req, res) => {
  const path = str(req.body?.path, 500);
  if (!path || path.includes("..") || !sb.sectionKnown(sb.sectionOfPath(path))) throw fail("Unknown file.");
  await StorageFile.deleteMany({ filePath: path }); // keep the records in step
  await sb.remove([path]);
  res.json({ ok: true });
}));

export default router;
