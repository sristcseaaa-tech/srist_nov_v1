import express from "express";
import Content from "../models/Content.js";
import requireAuth from "../middleware/requireAuth.js";
import requireAdmin from "../middleware/requireAdmin.js";
import * as media from "../utils/media.js";
import { setImagesInText, dropImages, uploader } from "../utils/mediaFields.js";

const router = express.Router();

// ---------- GET ALL CONTENT  (PUBLIC — used by the homepage to render) ----------
// Returns: { hero: { title: {type,value,label}, ... }, about: {...}, ... }
router.get("/", async (req, res) => {
  try {
    const docs = await Content.find();
    const grouped = {};
    docs.forEach((d) => {
      grouped[d.section] = grouped[d.section] || {};
      grouped[d.section][d.key] = { type: d.type, value: d.value, label: d.label };
    });
    res.json({ content: grouped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- GET ONE SECTION  (PUBLIC) ----------
router.get("/:section", async (req, res) => {
  try {
    const docs = await Content.find({ section: req.params.section.toLowerCase() });
    const fields = {};
    docs.forEach((d) => {
      fields[d.key] = { type: d.type, value: d.value, label: d.label };
    });
    res.json({ section: req.params.section, fields });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- SAVE A WHOLE SECTION AT ONCE  (PROTECTED — used by the Customize page) ----------
// Body: { fields: { title: {type:'text', value:'...', label:'Heading'}, ... } }
router.put("/:section", requireAuth, requireAdmin, async (req, res) => {
  try {
    const section = req.params.section.toLowerCase();
    const { fields } = req.body;
    if (!fields || typeof fields !== "object" || !Object.keys(fields).length) {
      return res.status(400).json({ error: "fields object is required" });
    }

    // Customize pictures (hero / banners / cards / gallery / department images / logos ...) go to
    // Cloudinary Account 1. Any base64 picture in a value is uploaded and replaced by its URL;
    // a picture that was replaced or removed is deleted from Cloudinary. MongoDB keeps text + URLs only.
    const before = new Map((await Content.find({ section, key: { $in: Object.keys(fields) } }).select("key value")).map((d) => [d.key, d.value]));
    const by = uploader(req);
    const entries = [];
    for (const [key, f] of Object.entries(fields)) {
      const value = await setImagesInText(f.value ?? "", {
        account: media.WEBSITE, category: f.type === "image" ? `section-${section}` : `gallery-${section}`,
        ownerType: "content", ownerId: `${section}.${key}`, folder: `srist/website/sections/${section}/${String(key).replace(/[^\w-]+/g, "-").slice(0, 40)}`,
        uploadedBy: by, previous: before.get(key), label: f.label || "Image"
      });
      entries.push([key, f, value]);
    }

    const ops = entries.map(([key, f, value]) => ({
      updateOne: {
        filter: { section, key },
        update: { section, key, type: f.type || "text", value, label: f.label || "" },
        upsert: true
      }
    }));

    await Content.bulkWrite(ops);

    const docs = await Content.find({ section });
    const saved = {};
    docs.forEach((d) => { saved[d.key] = { type: d.type, value: d.value, label: d.label }; });
    res.json({ section, fields: saved });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---------- DELETE ONE FIELD  (PROTECTED) ----------
router.delete("/:section/:key", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { section, key } = req.params;
    const gone = await Content.findOneAndDelete({ section: section.toLowerCase(), key });
    if (gone) await dropImages(gone.value); // free the Cloudinary pictures too
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
