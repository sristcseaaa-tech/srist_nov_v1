import express from "express";
import mongoose from "mongoose";
import OfficeMember from "../models/OfficeMember.js";
import User from "../models/User.js";
import requireAuth from "../middleware/requireAuth.js";
import requireAdmin from "../middleware/requireAdmin.js";
import DEPARTMENTS from "../utils/departments.js";
import { ROLES, ROLE_LABEL, isDeptRole, roleFromDesignation } from "../utils/roles.js";
import { currentHod, hodMessage } from "../utils/hod.js";

// Admin → Add employee → the OFFICE ROSTER (twin of /api/our-students).
//   GET    /                 list + sign-up status of every member
//   POST   /form             one or several people from the form card
//   POST   /excel            rows read from an uploaded .xlsx / .csv sheet
//   PUT    /:id              edit one member (until they have signed up)
//   DELETE /:id              remove one member from the roster
//   POST   /bulk-delete      remove several at once
const router = express.Router();
router.use(requireAuth, requireAdmin);

const MAX_FORM = 50, MAX_EXCEL = 2000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const ist = (d) => new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });

const DEPT_ALIASES = {
  cse: ["cse", "computer science", "computer science & engineering", "computer science and engineering", "cs"],
  me: ["me", "mechanical", "mechanical engineering"],
  etce: ["etce", "electronics", "electronics & tele-communication engineering", "electronics and telecommunication engineering", "etc", "ece"],
  ee: ["ee", "electrical", "electrical engineering"],
  ce: ["ce", "civil", "civil engineering"],
  bsh: ["bsh", "basic science", "basic science & humanities", "basic science and humanities", "science", "humanities"]
};
const normDept = (v) => {
  const s = clean(v).toLowerCase();
  return s ? DEPARTMENTS.find((d) => (DEPT_ALIASES[d] || [d]).includes(s)) || "" : "";
};
const ROLE_ALIASES = {
  user: ["user", "normal", "normal user", "faculty", "teacher", "staff", "employee"],
  asst_prof: ["asst_prof", "asst prof", "asstprof", "assistant professor", "lecturer", "editor", "department editor", "dept editor"],
  hod: ["hod", "head of department", "head of the department"],
  registrar: ["registrar", "registrars", "registers"],
  placement_com: ["placement_com", "placement com", "placement committee", "placement", "tpo"],
  exam_role: ["exam_role", "exam", "exam cell", "examcell"],
  admin: ["admin", "administrator", "administration"]
};
// "" / "auto" = decide from the designation (Lecturer / Assistant Professor -> Asst_Prof …).
const normRole = (v) => {
  const s = clean(v).toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  if (!s || s === "auto") return "auto";
  return ROLES.find((r) => ROLE_ALIASES[r].some((a) => a.replace(/_/g, " ") === s)) || "";
};

function normalise(raw, fallback = {}) {
  const r = raw || {};
  const name = clean(r.name);
  const email = clean(r.email).toLowerCase();
  const department = normDept(r.department ?? r.dept ?? fallback.department);
  const designation = clean(r.designation).slice(0, 100);
  let role = normRole(r.role || fallback.role || "auto");
  if (role === "auto") role = roleFromDesignation(designation) || "user"; // Lecturer / Asst Prof -> asst_prof …
  const phone = clean(r.phone);
  if (name.length < 2) return { error: "Name is required" };
  if (!EMAIL_RE.test(email)) return { error: "A valid email is required" };
  if (!department) return { error: `Department must be one of ${DEPARTMENTS.join(", ").toUpperCase()}` };
  if (!role) return { error: "Role must be Normal user, Asst_Prof, HOD, Registrar, Placement_Com, Exam Cell or Admin" };
  if (phone && (!/^[+\d][\d\s-]*$/.test(phone) || phone.replace(/\D/g, "").length < 10 || phone.replace(/\D/g, "").length > 13)) return { error: "Phone needs 10–13 digits" };
  return { value: { name: name.slice(0, 100), email: email.slice(0, 160), department, role, phone: phone.slice(0, 20), designation, employeeId: clean(r.employeeId).slice(0, 40) } };
}

async function statusMap(docs) {
  const map = new Map();
  const mails = docs.map((d) => d.email);
  if (!mails.length) return map;
  for (const u of await User.find({ email: { $in: mails } }).select("email emailVerified lastLogin lastLogout")) {
    const li = u.lastLogin ? new Date(u.lastLogin).getTime() : 0;
    const lo = u.lastLogout ? new Date(u.lastLogout).getTime() : 0;
    map.set(u.email, { account: u.emailVerified ? "active" : "unverified", activity: li ? (li > lo && Date.now() - li < 7 * 864e5 ? "online" : "past") : "never", lastActive: li || lo ? new Date(Math.max(li, lo)).toISOString() : null });
  }
  return map;
}
const view = (d, a = {}) => ({
  roleLabel: ROLE_LABEL[d.role] || d.role,
  id: String(d._id), name: d.name, email: d.email, phone: d.phone, designation: d.designation, employeeId: d.employeeId,
  department: d.department, role: d.role, source: d.source, batch: d.batch, addedAt: ist(d.createdAt),
  account: a.account || "none", activity: a.activity || "never", lastActive: a.lastActive || null
});

// Validates + saves a batch; skips emails already on the roster or already holding an account.
async function saveBatch(items, source, batch, addedBy) {
  const skipped = [], fresh = [], seen = new Set(), hodDepts = new Set();
  const mails = items.map((i) => i.value.email);
  const onRoster = new Set((await OfficeMember.find({ email: { $in: mails } }).select("email")).map((d) => d.email));
  const hasAccount = new Set((await User.find({ email: { $in: mails } }).select("email")).map((d) => d.email));
  for (const it of items) {
    const em = it.value.email;
    if (onRoster.has(em) || seen.has(em)) { skipped.push({ row: it.row, name: it.value.name, error: `${em} is already on the roster` }); continue; }
    if (hasAccount.has(em)) { skipped.push({ row: it.row, name: it.value.name, error: `${em} already has an account` }); continue; }
    if (it.value.role === "hod") { // one HOD per department
      const dept = it.value.department;
      const who = hodDepts.has(dept) ? { name: "another person in this upload", email: "" } : await currentHod(dept);
      if (who) { skipped.push({ row: it.row, name: it.value.name, error: who.email ? hodMessage(dept, who) : `${dept.toUpperCase()} already has a HOD (${who.name}). Only one HOD per department.` }); continue; }
      hodDepts.add(dept);
    }
    seen.add(em); fresh.push(it);
  }
  if (!fresh.length) return { added: 0, skipped };
  const docs = await OfficeMember.insertMany(fresh.map((f) => ({ ...f.value, source, batch, addedBy })));
  return { added: docs.length, skipped };
}

router.get("/", async (req, res) => {
  try {
    const docs = await OfficeMember.find().sort({ createdAt: -1 }).limit(5000);
    const st = await statusMap(docs);
    res.json({ rows: docs.map((d) => view(d, st.get(d.email))), total: docs.length });
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not load the office roster" }); }
});

router.post("/form", async (req, res) => {
  try {
    const list = Array.isArray(req.body?.members) ? req.body.members : [];
    if (!list.length) return res.status(400).json({ error: "Add at least one person" });
    if (list.length > MAX_FORM) return res.status(400).json({ error: `Add at most ${MAX_FORM} people at a time` });
    const fallback = { department: req.body?.department, role: req.body?.role };
    const errors = {};
    const items = list.map((raw, i) => { const n = normalise(raw, fallback); if (n.error) errors[i] = n.error; return { row: i + 1, value: n.value }; });
    if (Object.keys(errors).length) return res.status(400).json({ error: "Please fix the highlighted people", rows: errors });
    const result = await saveBatch(items, "form", `FORM-${Date.now().toString(36).toUpperCase()}`, req.currentUser?.email || "");
    res.status(201).json({ ok: true, ...result });
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not save the people" }); }
});

router.post("/excel", async (req, res) => {
  try {
    const list = Array.isArray(req.body?.members) ? req.body.members : [];
    if (!list.length) return res.status(400).json({ error: "The sheet has no rows" });
    if (list.length > MAX_EXCEL) return res.status(400).json({ error: `Upload at most ${MAX_EXCEL} rows per sheet` });
    const fallback = { department: req.body?.department, role: req.body?.role };
    const items = [], skipped = [];
    list.forEach((raw, i) => {
      const n = normalise(raw, fallback);
      const row = Number(raw?.__row) || i + 2;
      if (n.error) skipped.push({ row, name: clean(raw?.name), error: n.error }); else items.push({ row, value: n.value });
    });
    if (!items.length) return res.status(400).json({ error: "No valid rows found in the sheet", skipped });
    const fileName = clean(req.body?.fileName).slice(0, 60).replace(/[^\w.\- ]/g, "");
    const result = await saveBatch(items, "excel", `XLSX-${Date.now().toString(36).toUpperCase()}${fileName ? " " + fileName : ""}`, req.currentUser?.email || "");
    res.status(201).json({ ok: true, added: result.added, skipped: [...skipped, ...result.skipped] });
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not save the sheet" }); }
});

router.put("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Not found" });
    const doc = await OfficeMember.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    const n = normalise({ ...doc.toObject(), ...req.body, email: doc.email });
    if (n.error) return res.status(400).json({ error: n.error });
    if (n.value.role === "hod") {
      const who = await currentHod(n.value.department, doc.email);
      if (who) return res.status(409).json({ error: hodMessage(n.value.department, who) });
    }
    Object.assign(doc, n.value);
    await doc.save();
    // Already signed up? keep the live account in step with the roster.
    const u = await User.findOne({ email: doc.email });
    if (u && u.role !== "student") {
      u.name = doc.name; u.role = doc.role; u.department = doc.department; u.designation = doc.designation || "";
      u.editorDept = isDeptRole(doc.role) ? doc.department : null;
      await u.save();
    }
    res.json({ ok: true, row: view(doc, (await statusMap([doc])).get(doc.email)) });
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not save the changes" }); }
});

router.delete("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Not found" });
    const d = await OfficeMember.findByIdAndDelete(req.params.id);
    if (!d) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not delete" }); }
});

router.post("/bulk-delete", async (req, res) => {
  try {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((i) => mongoose.isValidObjectId(i));
    if (!ids.length) return res.status(400).json({ error: "Nothing selected" });
    const r = await OfficeMember.deleteMany({ _id: { $in: ids } });
    res.json({ ok: true, deleted: r.deletedCount });
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not delete" }); }
});

export default router;
