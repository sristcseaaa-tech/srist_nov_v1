import express from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import User from "../models/User.js";
import OfficeMember from "../models/OfficeMember.js";
import { sendOtpEmail } from "../utils/mailer.js";
import { studentDbReady } from "../utils/accounts.js";
import StudentAccount from "../models/StudentAccount.js";
import { isDeptRole } from "../utils/roles.js";
import { currentHod, hodMessage } from "../utils/hod.js";

// OFFICE sign-up (twin of student sign-up) — mounted at /api/office-signup.
// Only an email that an admin put on the office roster can sign up. Name,
// department and role come from the roster. The account is created unverified
// and a 6-digit code is emailed; it is confirmed through the normal
// /api/auth/verify-email/otp endpoint, after which the person can log in.
const router = express.Router();
const TTL_MS = 10 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const hits = new Map();
const tooMany = (ip) => {
  const now = Date.now();
  const l = (hits.get(ip) || []).filter((t) => now - t < 3600_000); l.push(now); hits.set(ip, l);
  return l.length > 30;
};
const makeOtp = () => crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");

async function entryFor(email) {
  const entry = await OfficeMember.findOne({ email });
  if (!entry) return { error: "This email isn't registered with SRIST yet. Ask an administrator to add it, then try again.", status: 404 };
  if (await User.exists({ email })) return { error: "An account with this email already exists. Please log in.", status: 409 };
  if (studentDbReady() && (await StudentAccount.exists({ email }))) return { error: "This email belongs to a student account. Use Student Log instead.", status: 409 };
  return { entry };
}

router.post("/check", async (req, res) => {
  try {
    if (tooMany(req.ip)) return res.status(429).json({ error: "Too many attempts. Please try again later." });
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Enter a valid email address" });
    const r = await entryFor(email);
    if (r.error) return res.status(r.status).json({ eligible: false, error: r.error });
    res.json({ eligible: true, name: r.entry.name, department: r.entry.department, role: r.entry.role, designation: r.entry.designation || "" });
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not check this email" }); }
});

router.post("/", async (req, res) => {
  try {
    if (tooMany(req.ip)) return res.status(429).json({ error: "Too many attempts. Please try again later." });
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const { password, confirmPassword } = req.body || {};
    if (!email || !password || !confirmPassword) return res.status(400).json({ error: "Email, password and re-entered password are required" });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Enter a valid email address" });
    if (String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    if (password !== confirmPassword) return res.status(400).json({ error: "The two passwords don't match" });
    const r = await entryFor(email);
    if (r.error) return res.status(r.status).json({ error: r.error });
    const m = r.entry, otp = makeOtp();
    if (m.role === "hod") { // never end up with two HODs in one department
      const who = await currentHod(m.department, m.email);
      if (who) return res.status(409).json({ error: hodMessage(m.department, who) });
    }
    const user = await User.create({
      name: m.name, email, passwordHash: await bcrypt.hash(String(password), 10),
      role: m.role, department: m.department, designation: m.designation || "", editorDept: isDeptRole(m.role) ? m.department : null,
      emailVerified: false, emailVerifyOtpCode: otp, emailVerifyOtpExpires: new Date(Date.now() + TTL_MS)
    });
    try { await sendOtpEmail(user.email, otp, "signup", "10 minutes"); }
    catch (mailErr) { console.error("Failed to send office verification OTP email:", mailErr.message); }
    res.status(201).json({ message: "Account created. Enter the 6-digit code we emailed you to verify your email.", email: user.email, otpRequired: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not create the account" }); }
});

export default router;
