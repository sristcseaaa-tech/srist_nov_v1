import express from "express";
import mongoose from "mongoose";
import StudentAccount from "../models/StudentAccount.js";
import { loadAccount, studentDbReady } from "../utils/accounts.js";
import Notice from "../models/Notice.js";
import StudentResource from "../models/StudentResource.js";
import StudentSeen from "../models/StudentSeen.js";
import requireAuth from "../middleware/requireAuth.js";
import DEPARTMENTS, { deptOfStudent, FIRST_YEAR_DEPT } from "../utils/departments.js";
import isAdminEmail from "../utils/isAdminEmail.js";
import * as media from "../utils/media.js";
import { setImage, dropImages, uploader } from "../utils/mediaFields.js";
import * as sb from "../utils/supabase.js";

import { isDeptRole } from "../utils/roles.js";
const router = express.Router();

const MAX_FILES = 10; // files per upload (each file may be as big as the Supabase limit — see FILE_MAX_MB)
const MAX_IMAGE_CHARS = 7_000_000; // data-URL length (~5 MB); checked again byte-for-byte before upload
const CLASS_TYPES = ["notice", "note", "routine"];
const PERSONAL_TYPES = ["grade_card", "certificate", "receipt"];
const TYPES = [...CLASS_TYPES, ...PERSONAL_TYPES];
const YEARS = ["all", "1", "2", "3"];

const isId = (id) => mongoose.isValidObjectId(id);
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const isAdminUser = (u) => u.role === "admin" || isAdminEmail(u.email);

// All downloadable files of a resource, including a legacy single file.
function filesOf(d) {
  const list = (d.attachments || []).map((a) => ({ id: String(a._id), name: a.name, type: a.type, size: a.size }));
  if (d.fileName && !list.length) list.push({ id: "legacy", name: d.fileName, type: d.fileType, size: d.fileSize || 0 });
  return list;
}

// Checks uploaded [{name, ticket} | {name, data}] before anything is stored (type + shape only; size and the real
// file type are checked when the file is claimed from Supabase). Throws { status, msg } on a problem.
function buildAttachments(input) {
  const out = [];
  for (const f of Array.isArray(input) ? input : []) {
    if (!f || typeof f !== "object") continue;
    const name = sb.safeName(f.name);
    try { sb.checkName(name); } catch (e) { throw { status: 400, msg: `"${name}": ${e.message}` }; }
    if (!f.ticket && !sb.parseDataUrl(f.data)) throw { status: 400, msg: `"${name}" could not be read. Please choose it again.` };
    out.push({ name, ticket: f.ticket, data: f.ticket ? undefined : f.data });
  }
  return out;
}

// Student portal documents go to Supabase Storage (private bucket, folder student-resources/<dept>/…).
// Only metadata + the storage path are saved in MongoDB. Pictures (resource image) stay on Cloudinary Account 2.
async function storeAttachments(req, doc, list) {
  const done = [];
  try {
    for (const a of list) {
      const rec = await sb.claim({ name: a.name, ticket: a.ticket, data: a.data }, { section: "student-resources", sub: [doc.dept], uid: req.userId });
      done.push({ name: rec.name, type: rec.mime, size: rec.size, path: rec.path });
    }
  } catch (e) { await sb.remove(done.map((d) => d.path)); throw e; }
  return done;
}
const resourceImage = (req, doc, value) => setImage(value, {
  account: media.STUDENT, category: "student-resource-image", ownerType: "student-resource", ownerId: String(doc._id),
  folder: `${media.ROOT[media.STUDENT]}/resources/${doc.dept}/${doc._id}`, uploadedBy: uploader(req), previous: doc.image, label: "Image"
});

const toPublic = (d) => ({
  id: String(d._id),
  dept: d.dept,
  year: d.year,
  type: d.type,
  title: d.title,
  subject: d.subject || "",
  body: d.body || "",
  image: media.deliver(d.image || "", { w: 1200 }), // signed URL — only reaches people the route already admitted
  files: filesOf(d),
  studentId: d.studentId || "",
  studentName: d.studentName || "",
  postedBy: d.postedBy || "",
  createdAt: d.createdAt
});

// Loads the acting user for every route below.
router.use(requireAuth, async (req, res, next) => {
  try {
    const me = await loadAccount(req); // student -> student DB, staff -> staff DB
    if (!me) return res.status(401).json({ error: "Not authenticated" });
    req.me = me;
    next();
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Which department may this person manage student content for?
//   admin  -> any     editor -> their own editorDept only     everyone else -> none
function canManageDept(me, dept) {
  if (isAdminUser(me)) return true;
  return isDeptRole(me.role) && me.editorDept === dept;
}

// Which department's portal is this person looking at?
//   student -> their own (year is also their own)
//   admin / editor -> preview: ?dept=&year= (editor is locked to their dept)
function portalScope(me, query) {
  if (me.role === "student") {
    // 1st-year students are all under BSH; later years under their own branch.
    const dept = deptOfStudent(me);
    return { dept, year: dept === FIRST_YEAR_DEPT ? "1" : me.year || "1" };
  }
  if (isAdminUser(me) || isDeptRole(me.role)) {
    const dept = isDeptRole(me.role) && !isAdminUser(me) ? me.editorDept : String(query.dept || "").toLowerCase();
    const year = YEARS.includes(String(query.year)) ? String(query.year) : "all";
    return { dept, year };
  }
  return null;
}

// ==================== STUDENT PORTAL (read) ====================
// GET /api/student/portal
// Everything a student needs, automatically scoped to THEIR department and
// year: class notices (uploaded ones + the department's public notices),
// subject notes, and the class routine.
router.get("/portal", async (req, res) => {
  try {
    const scope = portalScope(req.me, req.query);
    if (!scope) return res.status(403).json({ error: "This page is for students." });
    if (!DEPARTMENTS.includes(scope.dept)) {
      return res.status(400).json({ error: "Choose a department to preview." });
    }

    // "all" targets every year; a specific year sees "all" + its own.
    const yearFilter = scope.year === "all" ? { $in: YEARS } : { $in: ["all", scope.year] };

    const [resources, deptNotices] = await Promise.all([
      StudentResource.find(
        req.me.role === "student"
          // class content of their department + their own personal documents
          // (those follow the student, even after BSH -> their branch)
          ? { $or: [{ dept: scope.dept, year: yearFilter }, { studentId: String(req.me._id) }] }
          : { dept: scope.dept, year: yearFilter }
      ).sort({ createdAt: -1 }),
      Notice.find({ dept: scope.dept, year: yearFilter }).sort({ createdAt: -1 })
    ]);

    const all = resources.map(toPublic);
    // Personal documents belong to ONE student: a student sees only their own,
    // and never anyone else's. (Admin / editor preview shows none.)
    const mine = req.me.role === "student" ? all.filter((r) => r.studentId === String(req.me._id)) : [];
    const list = all.filter((r) => !r.studentId);
    // Department-page notices (posted from the Editor) also count as notices.
    const notices = [
      ...list.filter((r) => r.type === "notice"),
      ...deptNotices.map((n) => ({
        id: `dept-${n._id}`,
        dept: n.dept,
        year: n.year,
        type: "notice",
        title: n.title,
        subject: "",
        body: n.body || "",
        image: media.deliver(n.image || "", { w: 1200 }),
        files: [],
        createdAt: n.createdAt
      }))
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({
      dept: scope.dept,
      year: scope.year,
      student: req.me.role === "student" ? { name: req.me.name, email: req.me.email } : null,
      notices,
      notes: list.filter((r) => r.type === "note"),
      routines: list.filter((r) => r.type === "routine"),
      gradeCards: mine.filter((r) => r.type === "grade_card"),
      certificates: mine.filter((r) => r.type === "certificate"),
      receipts: mine.filter((r) => r.type === "receipt")
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== READ / UNREAD TRACKING ====================
// GET  /api/student/seen        -> { ids: [...] } the student has already opened
// POST /api/student/seen        body { ids: [...] } marks those as read
const MAX_SEEN = 3000;
router.get("/seen", async (req, res) => {
  try {
    if (req.me.role !== "student") return res.json({ ids: [] });
    const doc = await StudentSeen.findOne({ userId: String(req.me._id) });
    res.json({ ids: doc?.seen || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/seen", async (req, res) => {
  try {
    if (req.me.role !== "student") return res.json({ ids: [] });
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map((i) => str(i, 60)).filter(Boolean))].slice(0, 500);
    if (!ids.length) return res.json({ ok: true });
    const userId = String(req.me._id);
    await StudentSeen.updateOne({ userId }, { $addToSet: { seen: { $each: ids } } }, { upsert: true });
    // Keep the list bounded: drop the oldest entries beyond the cap.
    await StudentSeen.updateOne({ userId, [`seen.${MAX_SEEN}`]: { $exists: true } }, { $push: { seen: { $each: [], $slice: -MAX_SEEN } } });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== FILE DOWNLOAD ====================
// Students may download only files in their own department (and year), or —
// for personal documents — only their own; staff who manage that department
// may download too. (The client fetches with the Authorization header and
// saves the blob.)  GET /resources/:id/file/:fileId   (fileId optional = first file)
router.get("/resources/:id/file/:fileId?", async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: "Not found" });
    const doc = await StudentResource.findById(req.params.id).select("+fileData +attachments.data");
    if (!doc) return res.status(404).json({ error: "File not found" });

    const me = req.me;
    const allowed =
      canManageDept(me, doc.dept) ||
      (me.role === "student" &&
        (doc.studentId
          ? doc.studentId === String(me._id) // personal document: only its owner
          : deptOfStudent(me) === doc.dept && (doc.year === "all" || doc.year === me.year)));
    if (!allowed) return res.status(403).json({ error: "You don't have access to this file" });

    let name, type, buf;
    const att = req.params.fileId && req.params.fileId !== "legacy"
      ? doc.attachments.id(req.params.fileId)
      : doc.attachments[0];
    if (att && att.path) {
      // Supabase Storage (private bucket): the server streams it — only now that access was checked above.
      await sb.stream(res, att.path, { name: att.name, mime: att.type, download: true });
      return;
    }
    if (att && att.url) {
      // LEGACY Cloudinary Account 2 (private): the server streams it — only now that access was checked above.
      await media.streamPrivate(res, { name: att.name, mime: att.type, url: att.url, publicId: att.publicId, resourceType: att.resourceType, format: att.format }, { download: true });
      return;
    }
    if (att && att.data) {
      ({ name, type } = att);
      buf = att.data;
    } else if (doc.fileData && (!req.params.fileId || req.params.fileId === "legacy")) {
      name = doc.fileName; type = doc.fileType; buf = Buffer.from(doc.fileData, "base64");
    } else {
      return res.status(404).json({ error: "File not found" });
    }

    res.setHeader("Content-Type", type || "application/octet-stream");
    res.setHeader("Content-Length", buf.length);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${name.replace(/[^\w.\- ]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(buf);
  } catch (err) {
    console.error(err);
    if (res.headersSent) { res.destroy(); return; }
    res.status(err.status || 500).json({ error: err.status ? err.message : "Could not download the file" });
  }
});

// ==================== ADMIN / EDITOR: UPLOAD & MANAGE ====================

// GET /api/student/resources?dept=cse   (admin: any dept; editor: own dept)
router.get("/resources", async (req, res) => {
  try {
    const dept = String(req.query.dept || (isDeptRole(req.me.role) ? req.me.editorDept : "")).toLowerCase();
    if (!DEPARTMENTS.includes(dept)) return res.status(400).json({ error: "Unknown department" });
    if (!canManageDept(req.me, dept)) return res.status(403).json({ error: "You can't manage this department's student content" });
    const list = await StudentResource.find({ dept }).sort({ createdAt: -1 });
    res.json({ resources: list.map(toPublic) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/student/students?dept=cse — the registered students of a department
// (for choosing who a grade card / certificate / receipt belongs to).
router.get("/students", async (req, res) => {
  try {
    const dept = String(req.query.dept || (isDeptRole(req.me.role) ? req.me.editorDept : "")).toLowerCase();
    if (!DEPARTMENTS.includes(dept)) return res.status(400).json({ error: "Unknown department" });
    if (!canManageDept(req.me, dept)) return res.status(403).json({ error: "You can't view this department's students" });
    // BSH = every 1st-year student; a branch = its 2nd/3rd-year students.
    const who = dept === FIRST_YEAR_DEPT ? { year: "1" } : { department: dept, year: { $ne: "1" } };
    if (!studentDbReady()) return res.status(503).json({ error: "The student database is not available right now." });
    const students = await StudentAccount.find({ ...who }).sort({ department: 1, year: 1, name: 1 });
    res.json({ students: students.map((u) => ({ id: String(u._id), name: u.name, email: u.email, year: u.year || "", branch: u.department || "" })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/student/resources — upload a notice / note / routine.
// Body: { dept, year, type, title, subject?, body?, image?, file?: {name, data} }
router.post("/resources", async (req, res) => {
  try {
    const b = req.body || {};
    const dept = String(b.dept || "").toLowerCase();
    if (!DEPARTMENTS.includes(dept)) return res.status(400).json({ error: "Choose a department" });
    if (!canManageDept(req.me, dept)) return res.status(403).json({ error: "You can't upload for this department" });
    if (!TYPES.includes(b.type)) return res.status(400).json({ error: "type must be notice, note or routine" });

    const title = str(b.title, 160);
    if (!title) return res.status(400).json({ error: "Give it a title." });

    // Personal documents are addressed to one registered student of this
    // department; their year is taken from their account.
    let owner = null;
    if (PERSONAL_TYPES.includes(b.type)) {
      if (!isId(b.studentId)) return res.status(400).json({ error: "Choose the student this is for." });
      if (!studentDbReady()) return res.status(503).json({ error: "The student database is not available right now." });
      owner = await StudentAccount.findById(b.studentId);
      if (!owner || owner.role !== "student" || deptOfStudent(owner) !== dept) {
        return res.status(400).json({ error: "That student isn't registered in this department." });
      }
    }

    const doc = new StudentResource({
      dept,
      type: b.type,
      title,
      year: owner ? owner.year || "all" : YEARS.includes(String(b.year)) ? String(b.year) : "all",
      studentId: owner ? String(owner._id) : "",
      studentName: owner ? owner.name : "",
      subject: b.type === "note" || owner ? str(b.subject, 120) : "",
      body: String(b.body ?? "").trim().slice(0, 5000),
      postedBy: req.me.name
    });
    if (b.type === "note" && !doc.subject) return res.status(400).json({ error: "Enter the subject name for this note." });

    let pendingImage = "";
    if (b.image) {
      const img = String(b.image);
      if (img.length > MAX_IMAGE_CHARS) return res.status(400).json({ error: "Image is too large — please use a smaller picture." });
      if (!/^data:image\//i.test(img)) return res.status(400).json({ error: "Image must be an uploaded picture." });
      pendingImage = img; // uploaded to Cloudinary only after everything else checked out
    }

    // One or many files: `files: [{name, data}]` (legacy `file: {name, data}` still works).
    const incoming = Array.isArray(b.files) ? b.files : b.file ? [b.file] : [];
    if (incoming.length > MAX_FILES) return res.status(400).json({ error: `You can attach up to ${MAX_FILES} files at a time.` });
    let atts;
    try { atts = buildAttachments(incoming); } catch (e) { return res.status(e.status || 400).json({ error: e.msg }); }
    if (!doc.body && !pendingImage && !atts.length) {
      return res.status(400).json({ error: "Add some text, a picture or a file." });
    }
    try {
      if (pendingImage) doc.image = await resourceImage(req, doc, pendingImage);
      doc.attachments = await storeAttachments(req, doc, atts);
      await doc.save();
    } catch (e) { await media.removeByUrl([doc.image, ...doc.attachments.map((x) => (x.path ? sb.refOf(x.path) : x.url))].filter(Boolean)); throw e; }
    res.status(201).json({ resource: toPublic(doc) });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PUT /api/student/resources/:id — fix a mistake in something already posted.
// Body (all optional): { title, body, subject, year, image ("" removes it),
//   removeFileIds: [...], addFiles: [{name, data}] }
// The type, department and (for personal documents) the student can't be
// changed — delete and re-upload for that.
router.put("/resources/:id", async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: "Not found" });
    const doc = await StudentResource.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    if (!canManageDept(req.me, doc.dept)) return res.status(403).json({ error: "You can't edit this" });
    const b = req.body || {};

    if (b.title !== undefined) {
      const title = str(b.title, 160);
      if (!title) return res.status(400).json({ error: "Give it a title." });
      doc.title = title;
    }
    if (b.body !== undefined) doc.body = String(b.body ?? "").trim().slice(0, 5000);
    if (b.subject !== undefined && (doc.type === "note" || doc.studentId)) doc.subject = str(b.subject, 120);
    if (doc.type === "note" && !doc.subject) return res.status(400).json({ error: "Enter the subject name for this note." });
    if (b.year !== undefined && !doc.studentId && YEARS.includes(String(b.year))) doc.year = String(b.year);

    let imageChange; // applied (uploaded / deleted on Cloudinary) only after every check below passed
    if (b.image !== undefined) {
      if (!b.image) imageChange = "";
      else {
        const img = String(b.image);
        if (img.length > MAX_IMAGE_CHARS) return res.status(400).json({ error: "Image is too large — please use a smaller picture." });
        if (!/^(data:image\/|https?:\/\/)/i.test(img)) return res.status(400).json({ error: "Image must be an uploaded picture." });
        imageChange = img; // same picture sent back = unchanged; a new one replaces it and the old one is deleted
      }
    }

    // remove files the admin unticked (and delete them from Cloudinary)
    const removedUrls = [];
    for (const fid of Array.isArray(b.removeFileIds) ? b.removeFileIds : []) {
      if (fid === "legacy") { doc.fileName = ""; doc.fileType = ""; doc.fileSize = 0; doc.fileData = ""; }
      else if (isId(fid)) { const a = doc.attachments.id(fid); if (a?.path) removedUrls.push(sb.refOf(a.path)); else if (a?.url) removedUrls.push(a.url); doc.attachments.pull(fid); }
    }

    // add new files
    const add = Array.isArray(b.addFiles) ? b.addFiles : [];
    let atts;
    try { atts = buildAttachments(add); } catch (e) { return res.status(e.status || 400).json({ error: e.msg }); }
    const kept = doc.attachments.length + (doc.fileName ? 1 : 0);
    if (kept + atts.length > MAX_FILES) return res.status(400).json({ error: `A post can have up to ${MAX_FILES} files.` });
    const hasImage = imageChange === undefined ? !!doc.image : !!imageChange;
    if (!doc.body && !hasImage && !doc.attachments.length && !atts.length && !doc.fileName) {
      return res.status(400).json({ error: "Add some text, a picture or a file." });
    }
    if (imageChange !== undefined) doc.image = await resourceImage(req, doc, imageChange);
    const added = await storeAttachments(req, doc, atts);
    added.forEach((a) => doc.attachments.push(a));
    try { await doc.save(); } catch (e) { await sb.remove(added.map((a) => a.path)); throw e; }
    await media.removeByUrl(removedUrls);
    res.json({ resource: toPublic(doc) });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete("/resources/:id", async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: "Not found" });
    const doc = await StudentResource.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    if (!canManageDept(req.me, doc.dept)) return res.status(403).json({ error: "You can't delete this" });
    await media.removeByUrl([doc.image, ...doc.attachments.map((a) => (a.path ? sb.refOf(a.path) : a.url))].filter(Boolean)); // free Cloudinary / Supabase space
    await doc.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
