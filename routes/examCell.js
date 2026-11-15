import express from "express";
import ExamNotice from "../models/ExamNotice.js";
import requireAuth from "../middleware/requireAuth.js";
import requireExamEditor from "../middleware/requireExamEditor.js";
import EXAM_YEARS from "../utils/examYears.js";
import mongoose from "mongoose";
import * as media from "../utils/media.js";
import { uploader } from "../utils/mediaFields.js";
import { storeAttachments, urlsOf } from "../utils/attachments.js";
import * as sb from "../utils/supabase.js";

const router = express.Router();

const MAX_ATTACH = 8;
const LIST_SELECT = "-attachments.data"; // public lists carry file info only, never the bytes
const DATA_URL = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/;

// Validates what the editor sent. Each attachment is one of:
//   { kind: "file",  name, ticket }   a document uploaded straight to Supabase (big files)
//   { kind: "file",  name, data }     a document as a base64 data URL (stored in Supabase by the server)
//   { kind: "photo", name, data }     a picture as a base64 data URL (stored in Cloudinary)
//   { …, data: "sb:<path>" }          an attachment already saved (sent back unchanged on edit)
// The files themselves are stored by storeAttachments() below — never in MongoDB.
function cleanAttachments(list) {
  if (list === undefined) return { value: [] };
  if (!Array.isArray(list)) return { error: "attachments must be a list" };
  if (list.length > MAX_ATTACH) return { error: `Attach at most ${MAX_ATTACH} files per notice` };
  const out = [];
  for (const a of list) {
    const ok = a && (a.ticket || DATA_URL.test(String(a.data || "")) || sb.isRef(a.data) || sb.refFromLink(a.data));
    if (!ok) return { error: "One of the attachments could not be read" };
    out.push({ name: String(a.name || "file").slice(0, 160), kind: a.kind === "photo" ? "photo" : "file", ticket: a.ticket, data: a.data });
  }
  return { value: out };
}

function validYear(year) {
  return EXAM_YEARS.includes(String(year));
}

// ---------- GET ALL EXAM NOTICES, EVERY YEAR  (PUBLIC — feeds the Home page summary) ----------
router.get("/", async (req, res) => {
  try {
    const notices = await ExamNotice.find().select(LIST_SELECT).sort({ createdAt: -1 });
    res.json({ notices });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- DOWNLOAD ONE ATTACHMENT  (PUBLIC — same visibility as the notice itself) ----------
router.get("/file/:id/:index", async (req, res) => {
  try {
    const n = await ExamNotice.findById(req.params.id).select("attachments");
    const a = n?.attachments?.[Number(req.params.index)];
    if (!a) return res.status(404).json({ error: "File not found" });
    // Documents live in Supabase Storage: the notice is public, so the server streams the file.
    if (sb.isRef(a.data)) return await sb.stream(res, sb.pathOfRef(a.data), { name: a.name, mime: a.mime, download: a.kind !== "photo" });
    // Pictures: Cloudinary (Account 1, private) — redirect to a resized copy.
    if (media.isManaged(a.data)) {
      if (a.kind === "photo") return res.redirect(media.deliver(a.data, { w: 1600 }));
      return await media.streamPrivate(res, { name: a.name, mime: a.mime, url: a.data }, { download: true });
    }
    const m = DATA_URL.exec(a.data); // legacy base64 not migrated yet
    if (!m) return res.status(404).json({ error: "File not found" });
    const safe = encodeURIComponent(a.name || "file");
    res.setHeader("Content-Type", a.mime || m[1]);
    res.setHeader("Content-Disposition", `${a.kind === "photo" ? "inline" : "attachment"}; filename*=UTF-8''${safe}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(Buffer.from(m[2], "base64"));
  } catch (err) {
    if (res.headersSent) return res.destroy();
    res.status(404).json({ error: "File not found" });
  }
});

// ---------- GET ONE YEAR'S EXAM NOTICES  (PUBLIC — feeds /exam-cells/:year) ----------
router.get("/:year", async (req, res) => {
  try {
    const year = String(req.params.year);
    if (!validYear(year)) return res.status(404).json({ error: "Unknown exam cell year" });

    const notices = await ExamNotice.find({ year }).select(LIST_SELECT).sort({ createdAt: -1 });
    res.json({ year, notices });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- ADD AN EXAM NOTICE  (admin or exam_role only) ----------
router.post("/:year", requireAuth, requireExamEditor, async (req, res) => {
  try {
    const year = String(req.params.year);
    if (!validYear(year)) return res.status(404).json({ error: "Unknown exam cell year" });

    const { title, examDate, time, roomNo, floor, rules, attachments } = req.body;
    if (!title) return res.status(400).json({ error: "title is required" });
    const files = cleanAttachments(attachments);
    if (files.error) return res.status(400).json({ error: files.error });

    const _id = new mongoose.Types.ObjectId();
    const stored = await storeAttachments(files.value, {
      account: media.WEBSITE, private: true, folder: `srist/website/exam-cell/${year}/${_id}`,
      category: "exam-notice", ownerType: "exam-notice", ownerId: String(_id), uploadedBy: uploader(req),
      section: "exam-cell", sub: [`year-${year}`], uid: req.userId
    });
    let notice;
    try { notice = await ExamNotice.create({
      _id,
      year,
      title,
      examDate: examDate || "",
      time: time || "",
      roomNo: roomNo || "",
      floor: floor || "",
      rules: rules || "",
      attachments: stored.map((a) => ({ ...a, mime: a.mime || "application/octet-stream" }))
    }); } catch (e) { await media.removeByUrl(urlsOf(stored)); throw e; }
    // Never echo the stored bytes back.
    const out = notice.toObject();
    out.attachments = (out.attachments || []).map(({ data, ...meta }) => meta);
    res.status(201).json({ notice: out });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---------- REMOVE AN EXAM NOTICE  (admin or exam_role only) ----------
router.delete("/:year/:id", requireAuth, requireExamEditor, async (req, res) => {
  try {
    const year = String(req.params.year);
    const deleted = await ExamNotice.findOneAndDelete({ _id: req.params.id, year });
    if (!deleted) return res.status(404).json({ error: "Exam notice not found for this year" });
    // One upload can be shared by the same notice posted to several years — keep it while another notice still uses it.
    const gone = [];
    for (const u of urlsOf(deleted.attachments)) {
      if (sb.isRef(u) && (await ExamNotice.exists({ "attachments.data": u }))) continue;
      gone.push(u);
    }
    await media.removeByUrl(gone);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
