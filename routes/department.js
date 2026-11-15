import express from "express";
import Faculty from "../models/Faculty.js";
import DeptProfile from "../models/DeptProfile.js";
import Notice from "../models/Notice.js";
import Event from "../models/Event.js";
import requireAuth from "../middleware/requireAuth.js";
import requireDeptEditor from "../middleware/requireDeptEditor.js";
import optionalAuth from "../middleware/optionalAuth.js";
import DEPARTMENTS, { FIRST_YEAR_DEPT } from "../utils/departments.js";
import mongoose from "mongoose";
import * as media from "../utils/media.js";
import { setImage, dropImages, uploader } from "../utils/mediaFields.js";

const router = express.Router();

function validDept(dept) {
  return DEPARTMENTS.includes((dept || "").toLowerCase());
}


// ---------- department profile helpers (intake, logo, HOD's note) ----------
const MAX_IMAGE_CHARS = 7_000_000; // base64 data-URL length (~5 MB of image) — checked again, byte-for-byte, before upload
const IMAGE_RE = /^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,/i;
const LINK_RE = /^(https?:\/\/|\/)/i; // an already-uploaded Cloudinary URL / external link sent back unchanged

// All pictures here go to Cloudinary Account 1 (public site media). MongoDB keeps the URL only.
const siteImage = (req, value, { category, ownerType, ownerId, folder, previous, label, empty }) =>
  setImage(value, { account: media.WEBSITE, category, ownerType, ownerId: String(ownerId), folder, uploadedBy: uploader(req), previous, label, empty, allowSvg: true });

class BadRequest extends Error {}

// undefined = "not sent, leave unchanged"; null / "" = "clear it"
function cleanImage(value, label) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !(IMAGE_RE.test(value) || LINK_RE.test(value))) {
    throw new BadRequest(`${label} must be a PNG, JPG, WebP, GIF or SVG image`);
  }
  if (value.length > MAX_IMAGE_CHARS) throw new BadRequest(`${label} is too large (max about 2 MB)`);
  return value;
}

function cleanText(value, max, label) {
  if (value === undefined) return undefined;
  if (value === null) return "";
  if (typeof value !== "string") throw new BadRequest(`${label} must be text`);
  const v = value.replace(/\r\n/g, "\n").trim();
  if (v.length > max) throw new BadRequest(`${label} is too long (max ${max} characters)`);
  return v;
}

function cleanIntake(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null; // back to the built-in default
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 9999) throw new BadRequest("Intake must be a whole number between 0 and 9999");
  return n;
}

// Student-year targeting used by notices/events: "all" or "1"/"2"/"3".
const NOTICE_YEARS = ["all", "1", "2", "3"];
function normalizeYear(year) {
  const y = String(year ?? "all");
  return NOTICE_YEARS.includes(y) ? y : "all";
}

// ---------- ALL DEPARTMENT PROFILES — light version  (PUBLIC) ----------
// Feeds the home-page course grid (custom intake + logo). The HOD's note is
// only sent with the single-department feed below, to keep this one small.
// NOTE: must stay above "/:dept" so "profiles" isn't read as a department.
router.get("/profiles", optionalAuth, async (req, res) => {
  try {
    // BSH is restricted: anonymous callers never receive its profile.
    const filter = req.isSignedIn ? {} : { dept: { $ne: FIRST_YEAR_DEPT } };
    const profiles = await DeptProfile.find(filter, "dept intake logo updatedAt").lean();
    res.json({ profiles });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- GET EVERYTHING FOR ONE DEPARTMENT  (PUBLIC, except BSH — needs sign-in) ----------
router.get("/:dept", optionalAuth, async (req, res) => {
  try {
    const dept = req.params.dept.toLowerCase();
    if (!validDept(dept)) return res.status(404).json({ error: "Unknown department" });

    // BSH is restricted: the HOD note, faculty, notices and events need a signed-in user.
    if (dept === FIRST_YEAR_DEPT && !req.isSignedIn) {
      return res.status(401).json({ error: "Please sign in to view this department." });
    }

    const [faculty, notices, events, profile] = await Promise.all([
      Faculty.find({ dept }).sort({ order: 1, createdAt: 1 }),
      Notice.find({ dept }).sort({ createdAt: -1 }),
      Event.find({ dept }).sort({ createdAt: -1 }),
      DeptProfile.findOne({ dept }).lean()
    ]);

    // profile is null until an admin/editor customises this department.
    res.json({ dept, faculty, notices, events, profile: profile || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== DEPARTMENT PROFILE (intake / logo / HOD's note) ====================

// Admins can edit any department; an editor only their own (requireDeptEditor).
// Send only the fields you want to change. Sending null / "" clears a field,
// which makes the public page fall back to the built-in default for it.
router.put("/:dept/profile", requireAuth, requireDeptEditor, async (req, res) => {
  try {
    const dept = req.params.dept.toLowerCase();
    if (!validDept(dept)) return res.status(404).json({ error: "Unknown department" });

    const b = req.body || {};
    const logoIn = cleanImage(b.logo, "Logo");
    const hodIn = cleanImage(b.hodPhoto, "HOD photo");
    const existing = (logoIn !== undefined || hodIn !== undefined) ? await DeptProfile.findOne({ dept }).select("logo hodPhoto").lean() : null;
    const update = {
      intake: cleanIntake(b.intake),
      logo: logoIn === undefined ? undefined : await siteImage(req, logoIn, { category: "department-logo", ownerType: "department", ownerId: dept, folder: `srist/website/departments/${dept}/logo`, previous: existing?.logo, label: "Logo", empty: null }),
      hodPhoto: hodIn === undefined ? undefined : await siteImage(req, hodIn, { category: "department-hod", ownerType: "department", ownerId: dept, folder: `srist/website/departments/${dept}/hod`, previous: existing?.hodPhoto, label: "HOD photo", empty: null }),
      hodName: cleanText(b.hodName, 80, "HOD name"),
      hodRole: cleanText(b.hodRole, 80, "HOD designation"),
      hodNoteTitle: cleanText(b.hodNoteTitle, 120, "Note title"),
      hodNote: cleanText(b.hodNote, 5000, "HOD's note")
    };
    for (const k of Object.keys(update)) if (update[k] === undefined) delete update[k];

    const profile = await DeptProfile.findOneAndUpdate(
      { dept },
      { $set: update }, // dept itself comes from the upsert filter
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    ).lean();

    res.json({ profile });
  } catch (err) {
    if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ==================== FACULTY ====================

router.post("/:dept/faculty", requireAuth, requireDeptEditor, async (req, res) => {
  try {
    const dept = req.params.dept.toLowerCase();
    if (!validDept(dept)) return res.status(404).json({ error: "Unknown department" });

    const { name, role, subject, photo, order } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });

    // Every faculty / employee gets their own Cloudinary folder: srist/website/employees/<id>/profile
    const _id = new mongoose.Types.ObjectId();
    const photoUrl = await siteImage(req, cleanImage(photo, "Photo") ?? null, { category: "employee-photo", ownerType: "faculty", ownerId: _id, folder: media.employeeFolder(_id, "profile"), label: "Photo", empty: null });
    let faculty;
    try {
      faculty = await Faculty.create({
        _id,
        dept,
        name,
        role: role || "",
        subject: subject || "",
        photo: photoUrl,
        order: Number.isFinite(order) ? order : 0
      });
    } catch (e) { await dropImages(photoUrl); throw e; }
    res.status(201).json({ faculty });
  } catch (err) {
    if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.put("/:dept/faculty/:id", requireAuth, requireDeptEditor, async (req, res) => {
  try {
    const dept = req.params.dept.toLowerCase();
    const { name, role, subject, photo, order } = req.body;

    const faculty = await Faculty.findOne({ _id: req.params.id, dept });
    if (!faculty) return res.status(404).json({ error: "Faculty member not found in this department" });

    if (name !== undefined) faculty.name = name;
    if (role !== undefined) faculty.role = role;
    if (subject !== undefined) faculty.subject = subject;
    if (photo !== undefined) {
      // replace = upload the new one, delete the old one; null / "" = remove
      faculty.photo = await siteImage(req, cleanImage(photo, "Photo"), { category: "employee-photo", ownerType: "faculty", ownerId: faculty._id, folder: media.employeeFolder(faculty._id, "profile"), previous: faculty.photo, label: "Photo", empty: null });
    }
    if (Number.isFinite(order)) faculty.order = order;
    await faculty.save();

    res.json({ faculty });
  } catch (err) {
    if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete("/:dept/faculty/:id", requireAuth, requireDeptEditor, async (req, res) => {
  try {
    const dept = req.params.dept.toLowerCase();
    const deleted = await Faculty.findOneAndDelete({ _id: req.params.id, dept });
    if (!deleted) return res.status(404).json({ error: "Faculty member not found in this department" });
    await dropImages(deleted.photo);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== NOTICES ====================

router.post("/:dept/notices", requireAuth, requireDeptEditor, async (req, res) => {
  try {
    const dept = req.params.dept.toLowerCase();
    if (!validDept(dept)) return res.status(404).json({ error: "Unknown department" });

    const { title, body, year, image } = req.body;
    if (!title) return res.status(400).json({ error: "title is required" });

    const _id = new mongoose.Types.ObjectId();
    const imageUrl = await siteImage(req, cleanImage(image, "Image") ?? null, { category: "department-notice", ownerType: "notice", ownerId: _id, folder: `srist/website/departments/${dept}/notices`, label: "Image", empty: null });
    let notice;
    try {
      notice = await Notice.create({ _id, dept, title, body: body || "", year: normalizeYear(year), image: imageUrl });
    } catch (e) { await dropImages(imageUrl); throw e; }
    res.status(201).json({ notice });
  } catch (err) {
    if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete("/:dept/notices/:id", requireAuth, requireDeptEditor, async (req, res) => {
  try {
    const dept = req.params.dept.toLowerCase();
    const deleted = await Notice.findOneAndDelete({ _id: req.params.id, dept });
    if (!deleted) return res.status(404).json({ error: "Notice not found in this department" });
    await dropImages(deleted.image);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== EVENTS ====================

router.post("/:dept/events", requireAuth, requireDeptEditor, async (req, res) => {
  try {
    const dept = req.params.dept.toLowerCase();
    if (!validDept(dept)) return res.status(404).json({ error: "Unknown department" });

    const { title, description, image, year } = req.body;
    if (!title) return res.status(400).json({ error: "title is required" });

    const _id = new mongoose.Types.ObjectId();
    const imageUrl = await siteImage(req, cleanImage(image, "Image") ?? null, { category: "department-event", ownerType: "event", ownerId: _id, folder: `srist/website/departments/${dept}/events`, label: "Image", empty: null });
    let event;
    try {
      event = await Event.create({ _id, dept, title, description: description || "", image: imageUrl, year: normalizeYear(year) });
    } catch (e) { await dropImages(imageUrl); throw e; }
    res.status(201).json({ event });
  } catch (err) {
    if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete("/:dept/events/:id", requireAuth, requireDeptEditor, async (req, res) => {
  try {
    const dept = req.params.dept.toLowerCase();
    const deleted = await Event.findOneAndDelete({ _id: req.params.id, dept });
    if (!deleted) return res.status(404).json({ error: "Event not found in this department" });
    await dropImages(deleted.image);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
