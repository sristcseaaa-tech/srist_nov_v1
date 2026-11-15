import express from "express";
import mongoose from "mongoose";
import MediaAsset from "../models/MediaAsset.js";
import User from "../models/User.js";
import requireAuth from "../middleware/requireAuth.js";
import requireAdmin from "../middleware/requireAdmin.js";
import isAdminEmail from "../utils/isAdminEmail.js";
import { loadAccount } from "../utils/accounts.js";
import * as media from "../utils/media.js";

import { isDeptRole } from "../utils/roles.js";
// Generic media API (every response is metadata + URLs; never bytes).
//   Account 1 (website):  POST/GET/DELETE /api/media/website...   admins + department editors
//   Account 2 (students): POST /api/media/student                 the signed-in student (own folder) or staff
//                         GET  /api/media/student/:id             owner or staff, redirects to a signed URL
const router = express.Router();
const isAdminUser = (u) => u.role === "admin" || isAdminEmail(u.email);

const staffGate = async (req, res, next) => {
  try {
    if (req.userKind === "student") return res.status(403).json({ error: "Staff accounts only." });
    const me = await User.findById(req.userId);
    if (!me) return res.status(401).json({ error: "Not authenticated" });
    if (!isAdminUser(me) && !(isDeptRole(me.role) && me.editorDept)) return res.status(403).json({ error: "Only admins and department editors can manage website images." });
    req.me = me; req.isAdmin = isAdminUser(me);
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
};
const out = (d, size) => ({
  id: String(d._id), account: d.account, category: d.category, ownerType: d.ownerType, ownerId: d.ownerId, publicId: d.publicId,
  url: media.deliver(d.url, size), bytes: d.bytes, width: d.width, height: d.height, format: d.format, createdAt: d.createdAt
});
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : "Something went wrong" }); } };
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

// ---- website (Account 1)
router.post("/website", requireAuth, staffGate, wrap(async (req, res) => {
  const { image, category = "gallery", ownerType = "", ownerId = "", section = "" } = req.body || {};
  const dept = slug(req.body?.dept);
  if (!req.isAdmin && (!dept || dept !== req.me.editorDept)) return res.status(403).json({ error: "Editors can only upload for their own department." });
  const cat = slug(category) || "gallery";
  const rec = await media.uploadImage(image, media.WEBSITE, {
    category: cat, ownerType, ownerId, uploadedBy: { id: String(req.userId), kind: "staff" }, allowSvg: req.isAdmin,
    folder: ownerType === "user" && ownerId ? media.employeeFolder(ownerId) : dept ? `srist/website/departments/${dept}/${cat}` : `srist/website/sections/${slug(section) || cat}`
  });
  res.status(201).json({ asset: { ...rec, url: media.optimizedUrl(rec.url, { w: 1200 }), storedUrl: rec.url } });
}));

router.get("/website", requireAuth, staffGate, wrap(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1), limit = Math.min(60, Math.max(1, Number(req.query.limit) || 24));
  const q = { account: media.WEBSITE, ...(req.query.category ? { category: String(req.query.category) } : {}) };
  const [items, total] = await Promise.all([MediaAsset.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), MediaAsset.countDocuments(q)]);
  res.json({ page, limit, total, pages: Math.ceil(total / limit), items: items.map((d) => out(d, { w: 400 })) });
}));

router.delete("/website/:id", requireAuth, staffGate, wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const d = await MediaAsset.findOne({ _id: req.params.id, account: media.WEBSITE });
  if (!d) return res.status(404).json({ error: "Not found" });
  if (!req.isAdmin && !String(d.folder).includes(`/departments/${req.me.editorDept}/`)) return res.status(403).json({ error: "You can't delete this image." });
  await media.removeByUrl(d.url);
  res.json({ ok: true });
}));

// ---- students (Account 2)
router.post("/student", requireAuth, wrap(async (req, res) => {
  const me = await loadAccount(req);
  if (!me) return res.status(401).json({ error: "Not authenticated" });
  const isStudent = req.userKind === "student" || me.role === "student";
  const ownerId = isStudent ? String(me._id) : String(req.body?.studentId || "");
  if (!mongoose.isValidObjectId(ownerId)) return res.status(400).json({ error: "studentId is required." });
  if (!isStudent && !isAdminUser(me) && !(isDeptRole(me.role) && me.editorDept)) return res.status(403).json({ error: "You can't upload student images." });
  const rec = await media.uploadImage(req.body?.image, media.STUDENT, {
    category: "student-image", ownerType: "student", ownerId, folder: media.studentFolder(ownerId, "uploads"), uploadedBy: { id: String(req.userId), kind: isStudent ? "student" : "staff" }
  });
  res.status(201).json({ asset: { ...rec, url: media.deliver(rec.url, { w: 800 }), storedUrl: rec.url } });
}));

router.get("/student/:id", requireAuth, wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Not found" });
  const d = await MediaAsset.findOne({ _id: req.params.id, account: media.STUDENT });
  if (!d) return res.status(404).json({ error: "Not found" });
  const me = await loadAccount(req);
  const isStudent = req.userKind === "student";
  const allowed = isStudent ? String(me?._id) === d.ownerId : !!me && (isAdminUser(me) || (isDeptRole(me.role) && !!me.editorDept));
  if (!allowed) return res.status(403).json({ error: "You don't have access to this image." });
  res.redirect(media.deliver(d.url, { w: 1200 }));
}));

export default router;
