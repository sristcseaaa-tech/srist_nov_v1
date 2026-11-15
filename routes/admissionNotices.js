import express from "express";
import mongoose from "mongoose";
import AdmissionNotice from "../models/AdmissionNotice.js";
import requireAuth from "../middleware/requireAuth.js";
import requireAdmin from "../middleware/requireAdmin.js";
import * as media from "../utils/media.js";
import { setImage, dropImages, uploader } from "../utils/mediaFields.js";
import * as sb from "../utils/supabase.js";
import { applyFile, withFileCleanup, sendFile, hasStoredFile } from "../utils/safeFile.js";

const router = express.Router();

const MAX_IMAGE_CHARS = 7_000_000; // data-URL length (~5 MB); checked again byte-for-byte before upload

const isId = (id) => mongoose.isValidObjectId(id);
const str = (v, max) => String(v ?? "").trim().slice(0, max);

// What the browser gets — never the file bytes, just whether there is a file.
const toPublic = (d) => ({
  id: String(d._id),
  title: d.title,
  text: d.text || "",
  image: d.image || "",
  hasFile: !!d.fileName,
  fileName: d.fileName || "",
  fileType: d.fileType || "",
  fileSize: d.fileSize || 0,
  active: d.active !== false,
  order: d.order || 0,
  updatedAt: d.updatedAt
});

// Applies the editable fields from a request body onto a document.
// file: undefined = leave alone · null = remove · {name, ticket} / {name, data} = replace (stored in Supabase, folder admission-notices/).
async function applyBody(doc, b, req) {
  if (b.title !== undefined) doc.title = str(b.title, 160);
  if (b.text !== undefined) doc.text = String(b.text ?? "").trim().slice(0, 4000);
  if (b.active !== undefined) doc.active = !!b.active;

  if (b.image !== undefined) {
    const img = String(b.image ?? "");
    if (img.length > MAX_IMAGE_CHARS) throw Object.assign(new Error("Image is too large — please use a smaller picture."), { status: 400 });
    if (img && !/^(data:image\/|https?:\/\/|\/)/i.test(img)) throw Object.assign(new Error("Image must be an uploaded picture or a link."), { status: 400 });
    // Notice picture -> Cloudinary Account 1 (the old one is deleted when replaced / removed).
    doc.image = await setImage(img, {
      account: media.WEBSITE, category: "admission-notice", ownerType: "admission-notice", ownerId: String(doc._id),
      folder: "srist/website/admission/notices", uploadedBy: uploader(req), previous: doc.image, label: "Image"
    });
  }

  if (b.file === null || (b.file && typeof b.file === "object")) await applyFile(doc, b.file, { section: "admission-notices", uid: req?.userId });
}

// ---------------------------------------------------------------------------
// PUBLIC — notices shown on /apply
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const list = await AdmissionNotice.find({ active: { $ne: false } }).sort({ order: 1, createdAt: -1 });
    res.json({ notices: list.map(toPublic) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load notices" });
  }
});

// PUBLIC — download a notice's attached file.
router.get("/:id/file", async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: "Not found" });
    const doc = await AdmissionNotice.findById(req.params.id).select("+fileData");
    if (!doc || doc.active === false || !hasStoredFile(doc)) return res.status(404).json({ error: "File not found" });
    await sendFile(res, doc, { download: true }); // Supabase Storage (older files saved in MongoDB are still served)
  } catch (err) {
    console.error(err);
    if (res.headersSent) return res.destroy();
    res.status(err.status || 500).json({ error: err.status ? err.message : "Could not download the file" });
  }
});

// ---------------------------------------------------------------------------
// ADMIN — manage notices (Customize → Admission)
// ---------------------------------------------------------------------------
router.get("/admin/all", requireAuth, requireAdmin, async (req, res) => {
  try {
    const list = await AdmissionNotice.find().sort({ order: 1, createdAt: -1 });
    res.json({ notices: list.map(toPublic) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const last = await AdmissionNotice.findOne().sort({ order: -1 }).select("order");
    const doc = new AdmissionNotice({ title: "x", order: (last?.order ?? -1) + 1 });
    await withFileCleanup(doc, async () => {
      await applyBody(doc, req.body || {}, req);
      if (!doc.title) throw Object.assign(new Error("Give the notice a title."), { status: 400 });
      await doc.save();
    });
    res.status(201).json({ notice: toPublic(doc) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Reorder — body { ids: [id, id, ...] } in the order they should appear.
router.put("/reorder", requireAuth, requireAdmin, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(isId) : [];
    if (!ids.length) return res.status(400).json({ error: "ids array is required" });
    await AdmissionNotice.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: id }, update: { order: i } } })));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.put("/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: "Notice not found" });
    const doc = await AdmissionNotice.findById(req.params.id).select("+fileData");
    if (!doc) return res.status(404).json({ error: "Notice not found" });
    await withFileCleanup(doc, async () => {
      await applyBody(doc, req.body || {}, req);
      if (!doc.title) throw Object.assign(new Error("Give the notice a title."), { status: 400 });
      await doc.save();
    });
    res.json({ notice: toPublic(doc) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: "Notice not found" });
    const gone = await AdmissionNotice.findByIdAndDelete(req.params.id).select("image filePath");
    if (gone) { await dropImages(gone.image); if (gone.filePath) await sb.remove([gone.filePath]); }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
