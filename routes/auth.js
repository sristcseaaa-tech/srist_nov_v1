import express from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import User from "../models/User.js";
import requireAuth from "../middleware/requireAuth.js";
import requireAdmin from "../middleware/requireAdmin.js";
import requireAccess from "../middleware/requireAccess.js";
import { ROLES, isDeptRole, isAdminUser, hasAccess, roleFromDesignation, normaliseRole } from "../utils/roles.js";
import { currentHod, hodMessage } from "../utils/hod.js";
import { sendOtpEmail } from "../utils/mailer.js";
import DEPARTMENTS, { deptOfStudent } from "../utils/departments.js";
import OurStudent from "../models/OurStudent.js";
import OfficeMember from "../models/OfficeMember.js";
import StudentAccount from "../models/StudentAccount.js";
import credentialRouter from "./credentialFlows.js";
import { loadAccount, studentDbReady } from "../utils/accounts.js";
import * as media from "../utils/media.js";
import { setImage, dropImages, uploader } from "../utils/mediaFields.js";

// Email verification (signup / admin-created accounts) — the person has
// 10 minutes to enter the code before it needs to be re-sent.
const SIGNUP_OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SIGNUP_OTP_TTL_LABEL = "10 minutes";

// Change-password OTP — unrelated to login, kept at the original 10 minutes.
const PASSWORD_OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PASSWORD_OTP_TTL_LABEL = "10 minutes";

// 6-digit numeric code, e.g. "042917". crypto.randomInt is cryptographically
// strong (unlike Math.random), which matters since this gates login/password.
function makeOtp() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

const router = express.Router();

// ---------- SIGN UP  (PUSH: insert a new document) ----------
// Public self-service sign-up only exists to bootstrap the very first
// (admin) account on a brand-new install. Once at least one account exists,
// this endpoint is closed to the public — every further employee profile is
// created by an admin instead, over at POST /admin/users below.
router.post("/signup", async (req, res) => {
  try {
    const isFirstAccount = (await User.estimatedDocumentCount()) === 0;
    if (!isFirstAccount) {
      return res.status(403).json({
        error: "Public sign-up is disabled. Ask an administrator to create your account."
      });
    }

    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "name, email and password are required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    // FETCH: check whether this email is already registered
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const otp = makeOtp();

    // PUSH: insert the new (first-ever, admin) user document into MongoDB
    const user = await User.create({
      name,
      email,
      passwordHash,
      role: "admin",
      emailVerified: false,
      emailVerifyOtpCode: otp,
      emailVerifyOtpExpires: new Date(Date.now() + SIGNUP_OTP_TTL_MS)
    });

    try {
      await sendOtpEmail(user.email, otp, "signup", SIGNUP_OTP_TTL_LABEL);
    } catch (mailErr) {
      // Don't fail the whole signup just because the email didn't send —
      // the account still exists and the user can hit "resend code".
      console.error("Failed to send verification OTP email:", mailErr.message);
    }

    // No token / no auto-login here — the account exists but is unverified,
    // so login will be rejected until the emailed 6-digit code is entered
    // at POST /verify-email/otp.
    res.status(201).json({
      message: "Admin account created. Enter the 6-digit code we emailed you to verify your account.",
      email: user.email,
      otpRequired: true
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- OFFICE SIGN IN  (staff database only) ----------
// Password login, email-code login and email verification for faculty /
// employees / admins. Students have their own, separate endpoints at
// /api/student-auth — a student account is refused here, and an office account
// is not found there.
router.use(
  credentialRouter({
    kind: "staff",
    find: (email) => User.findOne({ email }),
    // Only accounts created before the separation can still be "student" here.
    reject: (u) => (u.role === "student" ? "This is a student account. Please use Student Log, not Office In." : null),
    noAccount: "No office account found with that email"
  })
);

// The account behind the current token — a student's lives in the student
// database, everyone else's in the staff database (see utils/accounts.js).
async function mine(req, res) {
  try {
    const u = await loadAccount(req);
    if (!u) { res.status(404).json({ error: "User not found" }); return null; }
    return u;
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
    return null;
  }
}

// ---------- CURRENT USER  (FETCH: find by id from the JWT) ----------
router.get("/me", requireAuth, async (req, res) => {
  const user = await mine(req, res);
  if (!user) return;
  res.json({ user: user.toSafeObject() });
});

// ---------- LOG OUT  (PUSH: record the logout time) ----------
// JWTs are stateless, so "logout" here just records the event server-side;
// the client is responsible for discarding its token.
router.post("/logout", requireAuth, async (req, res) => {
  const user = await mine(req, res);
  if (!user) return;

  user.lastLogout = new Date();
  await user.save();

  res.json({ ok: true });
});

// ---------- UPDATE PROFILE  (name / email) ----------
router.put("/profile", requireAuth, async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name || !email) {
      return res.status(400).json({ error: "name and email are required" });
    }

    const user = await mine(req, res);
    if (!user) return;

    const normalizedEmail = email.toLowerCase().trim();
    // Only an administrator may change a name or email from the profile page.
    const changing = normalizedEmail !== user.email || String(name).trim() !== (user.name || "");
    if (changing && !(req.userKind !== "student" && isAdminUser(user))) {
      return res.status(403).json({ error: "Only an administrator can change a name or email. Ask your admin to update it." });
    }
    if (normalizedEmail !== user.email) {
      // A student's email is their login AND their roster entry — it can't be changed here.
      if (req.userKind === "student") {
        return res.status(400).json({ error: "Students can't change their email. Ask your department to update the roster." });
      }
      // FETCH: make sure no other account already uses this email
      const existing = await User.findOne({ email: normalizedEmail });
      if (existing && String(existing._id) !== String(user._id)) {
        return res.status(409).json({ error: "Another account already uses this email" });
      }
      if (studentDbReady() && (await StudentAccount.exists({ email: normalizedEmail }))) {
        return res.status(409).json({ error: "Another account already uses this email" });
      }
    }

    user.name = name.trim();
    user.email = normalizedEmail;
    await user.save();

    res.json({ user: user.toSafeObject() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- UPDATE PROFILE PHOTO ----------
// The browser still sends the (already shrunk) picture as a data URL, but it is NOT saved in
// MongoDB: the server uploads it straight to Cloudinary and keeps only the URL + metadata.
//   staff / admin / faculty -> Cloudinary Account 1, in their own folder  srist/website/employees/<id>/profile
//   students                -> Cloudinary Account 2 (private), srist/students/<id>/profile
router.put("/profile/photo", requireAuth, async (req, res) => {
  try {
    const { imageDataUrl } = req.body;
    if (!imageDataUrl) {
      return res.status(400).json({ error: "imageDataUrl is required" });
    }
    if (!/^data:image\/(png|jpe?g|gif|webp);base64,/.test(imageDataUrl)) {
      return res.status(400).json({ error: "Image must be a PNG, JPEG, GIF, or WEBP file" });
    }
    // Rough size guard on the base64 payload (~2MB of actual image data).
    if (imageDataUrl.length > 2_800_000) {
      return res.status(400).json({ error: "Image is too large. Please use a photo under 2MB." });
    }

    const user = await mine(req, res);
    if (!user) return;

    const isStudent = req.userKind === "student" || user.role === "student";
    user.profileImage = await setImage(imageDataUrl, {
      account: isStudent ? media.STUDENT : media.WEBSITE,
      category: isStudent ? "student-profile" : "employee-photo",
      ownerType: isStudent ? "student" : "user", ownerId: String(user._id),
      folder: isStudent ? media.studentFolder(user._id, "profile") : media.employeeFolder(user._id, "profile"),
      uploadedBy: uploader(req), previous: user.profileImage, empty: null, label: "Profile photo"
    });
    await user.save();

    res.json({ user: user.toSafeObject() });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---------- REMOVE PROFILE PHOTO (also deletes it from Cloudinary) ----------
router.delete("/profile/photo", requireAuth, async (req, res) => {
  try {
    const user = await mine(req, res);
    if (!user) return;

    await dropImages(user.profileImage);
    user.profileImage = null;
    await user.save();

    res.json({ user: user.toSafeObject() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- PERSONAL THEME COLOUR (office log-ins) ----------
// Every office account can pick its own accent colour, unless an admin / HOD has locked it.
// Body: { themeColor: "#rrggbb" }  — "" puts the site default back.
const HEX = /^#[0-9a-f]{6}$/i;
router.put("/profile/theme", requireAuth, async (req, res) => {
  try {
    if (req.userKind === "student") return res.status(403).json({ error: "Theme colours are for office accounts." });
    const user = await mine(req, res);
    if (!user) return;
    if (user.themeAccess === "locked" && !isAdminUser(user)) {
      return res.status(403).json({ error: "Your theme colour is locked by an administrator." });
    }
    const colour = String(req.body?.themeColor ?? "").trim();
    if (colour && !HEX.test(colour)) return res.status(400).json({ error: "Pick a colour like #2B4C7E." });
    user.themeColor = colour.toLowerCase();
    await user.save();
    res.json({ user: user.toSafeObject() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- CHANGE PASSWORD, STEP 1: verify year of birth, send OTP ----------
// Doesn't touch passwordHash yet — the new password is only supplied (and
// applied) at the confirm step below, once the emailed code is entered.
// There's no separate "set your birthday first" step and no current-password
// check anymore: the birth year typed into the password-change form IS the
// verification factor. The first time this is ever called for an account it
// simply records the year on file; every time after that it has to match.
router.post("/password/request-otp", requireAuth, async (req, res) => {
  try {
    const { birthYear } = req.body;
    if (!birthYear || !/^\d{4}$/.test(birthYear)) {
      return res.status(400).json({ error: "A valid 4-digit birth year is required" });
    }

    const yearNum = parseInt(birthYear, 10);
    const currentYear = new Date().getFullYear();
    if (yearNum < 1900 || yearNum > currentYear) {
      return res.status(400).json({ error: "That doesn't look like a valid birth year" });
    }

    const user = await mine(req, res);
    if (!user) return;

    if (user.birthYear) {
      if (birthYear !== user.birthYear) {
        return res.status(401).json({ error: "Birth year does not match our records" });
      }
    } else {
      // First time changing the password — this is now on file for next time.
      user.birthYear = birthYear;
    }

    const otp = makeOtp();
    user.passwordOtpCode = otp;
    user.passwordOtpExpires = new Date(Date.now() + PASSWORD_OTP_TTL_MS);
    await user.save();

    try {
      await sendOtpEmail(user.email, otp, "password-change", PASSWORD_OTP_TTL_LABEL);
    } catch (mailErr) {
      console.error("Failed to send password-change OTP email:", mailErr.message);
      return res.status(500).json({ error: "Could not send the confirmation code email. Please try again." });
    }

    res.json({ ok: true, message: "We emailed you a 6-digit code. Enter it to confirm the password change." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- CHANGE PASSWORD, STEP 2: confirm OTP, then apply the new password ----------
router.put("/password/verify-otp", requireAuth, async (req, res) => {
  try {
    const { otp, newPassword } = req.body;
    if (!otp || !newPassword) {
      return res.status(400).json({ error: "otp and newPassword are required" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters" });
    }

    const user = await mine(req, res);
    if (!user) return;

    if (!user.passwordOtpCode) {
      return res.status(400).json({ error: "No password-change code is pending. Please start again." });
    }

    if (user.passwordOtpExpires && user.passwordOtpExpires < new Date()) {
      user.passwordOtpCode = null;
      user.passwordOtpExpires = null;
      await user.save();
      return res.status(400).json({ error: "This code has expired. Please start again." });
    }

    if (otp !== user.passwordOtpCode) {
      return res.status(401).json({ error: "Incorrect code. Please try again." });
    }

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.passwordOtpCode = null;
    user.passwordOtpExpires = null;
    await user.save();

    res.json({ ok: true, message: "Password changed." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== ADMIN: EMPLOYEE / USER MANAGEMENT ====================
// Create / delete are admin-only (requireAdmin). Listing and role changes are
// open to admin-nav roles too, but SCOPED (see /admin/users below):
//   admin      — everyone, any role
//   hod        — only their own department; may switch staff between
//                Normal user and Asst_Prof (nothing higher)
//   registrar  — read-only view of everyone
// Roles: "user", "asst_prof" (one department's page — pass editorDept),
// "hod" (asst_prof powers + admin-nav access; one per department),
// "registrar", "placement_com", "exam_role", "admin".

// ---------- CREATE A NEW EMPLOYEE PROFILE  (PUSH: insert a new document, admin only) ----------
// This is how every account gets created day-to-day now that public
// /signup is closed. The admin sets the department and role up front —
// Body: { name, email, password, role?: any role or "auto", designation?, department?, editorDept? }
// department is the employee's own department (any role); editorDept is
// which department page they're allowed to edit and is required (and must
// match one of DEPARTMENTS) when role is "asst_prof" or "hod". role "auto" (the
// default) is worked out from the designation: Lecturer / Assistant Professor
// become Asst_Prof, HOD -> hod, Registrar -> registrar, Placement -> placement_com.
router.post("/admin/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, email, password, department, editorDept, designation = "" } = req.body;
    let role = normaliseRole(req.body.role || "auto");

    if (!name || !email || !password) {
      return res.status(400).json({ error: "name, email and password are required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    // "auto" (or no role) = decide from the designation: Lecturer / Assistant
    // Professor -> asst_prof, HOD -> hod, Registrar -> registrar, …
    if (role === "auto") role = roleFromDesignation(designation) || "user";
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${ROLES.join(", ")}` });
    }
    if (department && !DEPARTMENTS.includes(department)) {
      return res.status(400).json({ error: `department must be one of: ${DEPARTMENTS.join(", ")}` });
    }
    let deptScope = null;
    if (isDeptRole(role)) {
      deptScope = editorDept || department;
      if (!deptScope || !DEPARTMENTS.includes(deptScope)) {
        return res.status(400).json({ error: `department must be one of: ${DEPARTMENTS.join(", ")}` });
      }
    }
    if (role === "hod") {
      const who = await currentHod(deptScope, email);
      if (who) return res.status(409).json({ error: hodMessage(deptScope, who) });
    }

    // FETCH: check whether this email is already registered
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }
    if (studentDbReady() && (await StudentAccount.exists({ email: email.toLowerCase() }))) {
      return res.status(409).json({ error: "A student account already uses this email" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const otp = makeOtp();

    // PUSH: insert the new employee document, unverified. The email address
    // is confirmed with a 6-digit code (same flow as signup) rather than a
    // click-through link, and rather than being auto-verified — the
    // employee has to actually open their inbox and prove the address is
    // theirs before they can log in for the first time.
    const user = await User.create({
      name,
      email,
      passwordHash,
      role,
      designation: String(designation || "").trim().slice(0, 100),
      department: department || deptScope || null,
      editorDept: deptScope,
      emailVerified: false,
      emailVerifyOtpCode: otp,
      emailVerifyOtpExpires: new Date(Date.now() + SIGNUP_OTP_TTL_MS)
    });

    try {
      await sendOtpEmail(user.email, otp, "signup", SIGNUP_OTP_TTL_LABEL);
    } catch (mailErr) {
      // Don't fail account creation just because the email didn't send —
      // the account still exists and can request a new code from /sign-in.
      console.error("Failed to send verification OTP email:", mailErr.message);
    }

    res.status(201).json({ user: user.toSafeObject() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- LIST ALL USERS ----------
router.get("/admin/users", requireAuth, requireAccess("accounts"), async (req, res) => {
  try {
    const me = req.currentUser;
    const admin = isAdminUser(me);
    // HOD -> only their own department. Registrar -> everyone (read-only).
    const scope = !admin && me.role === "hod" ? me.editorDept : null;
    const staff = await User.find().sort({ createdAt: -1 });
    // Student accounts live in the student database; show them alongside.
    let students = [];
    if (studentDbReady()) {
      try { students = await StudentAccount.find().sort({ createdAt: -1 }); }
      catch (e) { console.error("[admin/users] could not read student accounts:", e.message); }
    }
    const seen = new Set(students.map((u) => u.email));
    let users = [...students, ...staff.filter((u) => !(u.role === "student" && seen.has(u.email)))]
      .sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt));
    if (scope) {
      users = users.filter((u) => u.role === "student"
        ? deptOfStudent(u) === scope // BSH HOD sees every 1st-year; others see their own branch (year 2+)
        : u.role !== "admin" && (u.editorDept === scope || u.department === scope));
    }

    // Student accounts also carry their roster record (roll no, phone,
    // guardian…) so Accounts Management can show everything in one place.
    const mails = users.filter((u) => u.role === "student").map((u) => u.email);
    const roster = new Map();
    if (mails.length) {
      try {
        for (const r of await OurStudent.find({ email: { $in: mails } })) roster.set(r.email, r);
      } catch (e) {
        console.error("[admin/users] could not read roster:", e.message);
      }
    }

    // Staff accounts carry their office-roster record (phone, employee ID, who added them …) so the
    // employee profile card can show every detail in one place.
    const staffMails = users.filter((u) => u.role !== "student").map((u) => u.email);
    const office = new Map();
    if (staffMails.length) {
      try {
        for (const r of await OfficeMember.find({ email: { $in: staffMails } })) office.set(r.email, r);
      } catch (e) {
        console.error("[admin/users] could not read office roster:", e.message);
      }
    }

    res.json({
      // What this viewer may do on the page (the server re-checks on every change).
      viewer: { admin, role: me.role, dept: scope, canSetRoles: admin || me.role === "hod", canDelete: admin, canSetTheme: admin || me.role === "hod" },
      users: users.map((u) => {
        const out = { ...u.toSafeObject(), lastLogout: u.lastLogout || null };
        const r = u.role === "student" ? roster.get(u.email) : null;
        if (r) {
          out.roster = {
            rollNo: r.rollNo, regNo: r.regNo, phone: r.phone, guardianName: r.guardianName,
            guardianPhone: r.guardianPhone, address: r.address, dept: r.dept, year: r.year
          };
        }
        const o = u.role !== "student" ? office.get(u.email) : null;
        if (o) {
          out.office = {
            phone: o.phone || "", employeeId: o.employeeId || "", designation: o.designation || "",
            department: o.department || "", source: o.source, addedBy: o.addedBy || "", addedAt: o.createdAt
          };
        }
        out.updatedAt = u.updatedAt || null;
        return out;
      })
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- SET SOMEONE'S THEME-COLOUR POWER ----------
// Body: { themeAccess?: "allowed" | "locked" | "default", themeColor?: "#rrggbb" | "" }
//   admin — anyone.   HOD — Normal user / Asst_Prof / other staff of their own department only.
//   Registrar and everyone else — no.
router.put("/admin/users/:id/theme", requireAuth, requireAccess("accounts"), async (req, res) => {
  try {
    const actor = req.currentUser;
    const admin = isAdminUser(actor);
    if (!admin && actor.role !== "hod") return res.status(403).json({ error: "You can view accounts but not change theme access." });
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!admin) {
      const mine = actor.editorDept;
      if (String(user._id) === String(actor._id)) return res.status(403).json({ error: "Use your own Profile page to change your colour." });
      if (!(user.editorDept === mine || user.department === mine) || user.role === "admin" || user.role === "hod") {
        return res.status(403).json({ error: "You can only manage people of your own department." });
      }
    }
    const { themeAccess, themeColor } = req.body || {};
    if (themeAccess !== undefined) {
      if (!["default", "allowed", "locked"].includes(themeAccess)) return res.status(400).json({ error: "themeAccess must be allowed, locked or default" });
      if (themeAccess === "locked" && isAdminUser(user)) return res.status(400).json({ error: "Admins can't be locked out of their own theme." });
      user.themeAccess = themeAccess;
    }
    if (themeColor !== undefined) {
      const c = String(themeColor || "").trim();
      if (c && !HEX.test(c)) return res.status(400).json({ error: "Pick a colour like #2B4C7E." });
      user.themeColor = c.toLowerCase();
    }
    await user.save();
    res.json({ user: user.toSafeObject() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- DELETE A USER'S PROFILE ----------
router.delete("/admin/users/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (String(req.params.id) === String(req.currentUser._id)) {
      return res.status(400).json({ error: "You can't delete your own account from here" });
    }

    let deleted = await User.findByIdAndDelete(req.params.id);
    if (!deleted && studentDbReady()) deleted = await StudentAccount.findByIdAndDelete(req.params.id);
    if (deleted) await dropImages(deleted.profileImage); // remove the photo from Cloudinary too
    if (!deleted) return res.status(404).json({ error: "User not found" });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- SET A USER'S ROLE / DEPARTMENT PRIVILEGE ----------
// Body: { role: "user"|"asst_prof"|"hod"|"registrar"|"placement_com"|"exam_role"|"admin", editorDept? }
// editorDept (a department slug) is required for asst_prof and hod and is cleared
// for every other role. A department can have only ONE hod.
// Who may do what:
//   admin — anything.
//   hod   — only inside their own department, and only Normal user <-> Asst_Prof
//           (they can't create HODs / admins, or touch their own role).
router.put("/admin/users/:id/role", requireAuth, requireAccess("accounts"), async (req, res) => {
  try {
    const actor = req.currentUser;
    const admin = isAdminUser(actor);
    if (!admin && actor.role !== "hod") return res.status(403).json({ error: "You can view accounts but not change roles." });

    const role = normaliseRole(req.body.role);
    const { editorDept, department } = req.body;
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${ROLES.join(", ")}` });
    }
    if (isDeptRole(role) && (!editorDept || !DEPARTMENTS.includes(editorDept))) {
      return res.status(400).json({ error: `editorDept must be one of: ${DEPARTMENTS.join(", ")}` });
    }
    if (department !== undefined && department !== null && !DEPARTMENTS.includes(department)) {
      return res.status(400).json({ error: `department must be one of: ${DEPARTMENTS.join(", ")}` });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (!admin) { // HOD limits
      const mine = actor.editorDept;
      if (String(user._id) === String(actor._id)) return res.status(403).json({ error: "You can't change your own role." });
      if (!(user.editorDept === mine || user.department === mine) || user.role === "admin" || user.role === "hod") {
        return res.status(403).json({ error: "You can only manage Normal user / Asst_Prof accounts in your own department." });
      }
      if (!["user", "asst_prof"].includes(role)) return res.status(403).json({ error: "A HOD can only set Normal user or Asst_Prof." });
      if (role === "asst_prof" && editorDept !== mine) return res.status(403).json({ error: "You can only assign Asst_Prof for your own department." });
    }

    if (role === "hod") {
      const who = await currentHod(editorDept, user.email);
      if (who) return res.status(409).json({ error: hodMessage(editorDept, who) });
    }

    user.role = role;
    user.editorDept = isDeptRole(role) ? editorDept : null;
    if (department !== undefined) {
      user.department = department || (isDeptRole(role) ? editorDept : null);
    } else if (isDeptRole(role) && !user.department) {
      user.department = editorDept;
    }
    await user.save();

    res.json({ user: user.toSafeObject() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
