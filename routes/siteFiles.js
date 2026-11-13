import express from "express";
import mongoose from "mongoose";
import SiteFile from "../models/SiteFile.js";
import requireAuth from "../middleware/requireAuth.js";
import requireAdmin from "../middleware/requireAdmin.js";
import { sendFile, str, fail_ as fail } from "../utils/safeFile.js";
import * as sb from "../utils/supabase.js";

// Documents attached to a Customize section (PDF, PPT, DOC, XLS …) — stored in Supabase Storage,
// folder  site-content/<section>/.  Pictures are NOT accepted here: they go to Cloudinary through
// the normal image upload of Customize.
//
//   GET    /api/site-files?section=hero     public list (optional section filter)
//   GET    /api/site-files/:id/file         public — streams the file (pdf opens, the rest downloads)
//   POST   /api/site-files                  admin  { section, label?, file:{name,ticket|data} }
//   PUT    /api/site-files/:id              admin  { label }
//   DELETE /api/site-files/:id              admin  (also deletes the Supabase object)
const router = express.Router();
const isId = (id) => mongoose.isValidObjectId(id);
// Every non-picture file type is accepted (stored in Supabase). Pictures go to Cloudinary.

const toPublic = (d) => ({
  id: String(d._id),
  section: d.section,
  label: d.label || "",
  fileName: d.fileName,
  fileExt: (d.fileName.split(".").pop() || "").toLowerCase(),
  fileSize: d.fileSize || 0,
  createdAt: d.createdAt
});

router.get("/", async (req, res) => {
  try {
    const filter = {};
    if (req.query.section) filter.section = String(req.query.section).toLowerCase().slice(0, 60);
    const list = await SiteFile.find(filter).sort({ section: 1, order: 1, createdAt: 1 }).limit(1000);
    res.json({ files: list.map(toPublic) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load files" });
  }
});

router.get("/:id/file", async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: "File not found" });
    const d = await SiteFile.findById(req.params.id);
    if (!d?.filePath) return res.status(404).json({ error: "File not found" });
    await sendFile(res, d, { download: req.query.download === "1" });
  } catch (err) {
    console.error(err);
    if (res.headersSent) return res.destroy();
    res.status(err.status || 500).json({ error: err.status ? err.message : "Could not open the file" });
  }
});

const admin = [requireAuth, requireAdmin];

router.post("/", ...admin, async (req, res) => {
  let rec;
  try {
    const b = req.body || {};
    const section = str(b.section, 60).toLowerCase();
    if (!/^[a-z0-9_-]{1,60}$/.test(section)) throw fail("Choose a section first.");
    if (/\.(jpe?g|png|webp|gif|bmp|avif|svg)$/i.test(String(b.file?.name || ""))) throw fail("Pictures are stored on Cloudinary — use the section's image upload. Every other file type goes here (Supabase).");
    rec = await sb.claim(b.file, { section: "site-content", sub: [section], uid: req.userId, });
    const last = await SiteFile.findOne({ section }).sort({ order: -1 }).select("order");
    const doc = await SiteFile.create({
      section, label: str(b.label, 160), fileName: rec.name, fileType: rec.mime, fileSize: rec.size, filePath: rec.path,
      order: (last?.order ?? -1) + 1
    });
    res.status(201).json({ file: toPublic(doc) });
  } catch (err) {
    if (rec?.path) await sb.remove([rec.path]); // never leave an orphan in Supabase
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.put("/:id", ...admin, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: "File not found" });
    const doc = await SiteFile.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "File not found" });
    if (req.body?.label !== undefined) doc.label = str(req.body.label, 160);
    await doc.save();
    res.json({ file: toPublic(doc) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete("/:id", ...admin, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: "File not found" });
    const gone = await SiteFile.findByIdAndDelete(req.params.id).select("filePath");
    if (gone?.filePath) await sb.remove([gone.filePath]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
