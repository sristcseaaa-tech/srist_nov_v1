import express from "express";
import mongoose from "mongoose";
import HomeResource from "../models/HomeResource.js";
import requireAuth from "../middleware/requireAuth.js";
import requireAdmin from "../middleware/requireAdmin.js";
import { sendFile, str, fail_ as fail } from "../utils/safeFile.js";
import * as sb from "../utils/supabase.js";
import * as media from "../utils/media.js";
import { setImage, WEBSITE, uploader } from "../utils/mediaFields.js";

// Home page "Resources" section.
//   Files    -> Supabase Storage (folder home-resources/) — any document type.
//   Pictures -> Cloudinary (website account)              — never Supabase.
//
//   GET    /api/home-resources              public — the visible items
//   GET    /api/home-resources/:id/file     public — streams a file item (pdf / pictures open, the rest downloads)
//   GET    /api/home-resources/admin/all    admin  — everything, incl. hidden
//   POST   /api/home-resources              admin  { title?, description?, file:{name,ticket|data} }   (a document)
//                                                   { title?, description?, image:"data:image/…" }        (a picture)
//   PUT    /api/home-resources/:id          admin  { title, description, visible }
//   DELETE /api/home-resources/:id          admin
const router = express.Router();
const isId = (id) => mongoose.isValidObjectId(id);

const toPublic = (d, admin = false) => ({
  id: String(d._id),
  title: d.title,
  description: d.description || "",
  kind: d.kind,
  fileName: d.fileName || "",
  fileExt: (d.fileName || "").split(".").pop().toLowerCase(),
  fileSize: d.fileSize || 0,
  imageUrl: d.kind === "image" ? media.optimizedUrl(d.imageUrl, { w: 900 }) : "",
  createdAt: d.createdAt,
  ...(admin ? { visible: d.visible, order: d.order || 0 } : {})
});

router.get("/", async (req, res) => {
  try {
    const list = await HomeResource.find({ visible: true }).sort({ order: 1, createdAt: -1 }).limit(500);
    res.json({ items: list.map((d) => toPublic(d)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load resources" });
  }
});

const admin = [requireAuth, requireAdmin];

router.get("/admin/all", ...admin, async (req, res) => {
  try {
    const list = await HomeResource.find().sort({ order: 1, createdAt: -1 });
    res.json({ items: list.map((d) => toPublic(d, true)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/:id/file", async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: "File not found" });
    const d = await HomeResource.findById(req.params.id);
    if (!d || d.kind !== "file" || !d.filePath || !d.visible) return res.status(404).json({ error: "File not found" });
    await sendFile(res, d, { download: req.query.download === "1" });
  } catch (err) {
    console.error(err);
    if (res.headersSent) return res.destroy();
    res.status(err.status || 500).json({ error: err.status ? err.message : "Could not open the file" });
  }
});

const stem = (n) => String(n || "").replace(/\.[a-z0-9]{1,8}$/i, "").replace(/[_-]+/g, " ").trim();

router.post("/", ...admin, async (req, res) => {
  let rec, imageUrl;
  try {
    const b = req.body || {};
    const last = await HomeResource.findOne().sort({ order: -1 }).select("order");
    const order = (last?.order ?? -1) + 1;
    const data = { description: str(b.description, 400), order };
    if (typeof b.image === "string" && b.image) {
      // pictures: Cloudinary only
      imageUrl = await setImage(b.image, { account: WEBSITE, category: "home-resources", ownerType: "home-resource", folder: "srist/website/home-resources", uploadedBy: uploader(req), label: "Picture" });
      Object.assign(data, { kind: "image", imageUrl, title: str(b.title, 160) || stem(b.name) || "Picture" });
    } else if (b.file && typeof b.file === "object") {
      // everything else: Supabase Storage
      rec = await sb.claim(b.file, { section: "home-resources", uid: req.userId });
      Object.assign(data, { kind: "file", fileName: rec.name, fileType: rec.mime, fileSize: rec.size, filePath: rec.path, title: str(b.title, 160) || stem(rec.name) || "Document" });
    } else {
      throw fail("Choose a file or a picture to upload.");
    }
    const doc = await HomeResource.create(data);
    res.status(201).json({ item: toPublic(doc, true) });
  } catch (err) {
    if (rec?.path) await sb.remove([rec.path]);
    if (imageUrl) await media.removeByUrl(imageUrl).catch(() => {});
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.put("/:id", ...admin, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: "Item not found" });
    const doc = await HomeResource.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Item not found" });
    const b = req.body || {};
    if (b.title !== undefined) { const t = str(b.title, 160); if (!t) throw fail("Give the item a title."); doc.title = t; }
    if (b.description !== undefined) doc.description = str(b.description, 400);
    if (b.visible !== undefined) doc.visible = !!b.visible;
    await doc.save();
    res.json({ item: toPublic(doc, true) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete("/:id", ...admin, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: "Item not found" });
    const gone = await HomeResource.findByIdAndDelete(req.params.id);
    if (gone?.filePath) await sb.remove([gone.filePath]);
    if (gone?.imageUrl) await media.removeByUrl(gone.imageUrl).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
