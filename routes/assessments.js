import express from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import multer from "multer";
import requireAuth from "../middleware/requireAuth.js";
import User from "../models/User.js";
import StudentAccount from "../models/StudentAccount.js";
import Assessment from "../models/Assessment.js";
import Submission from "../models/AssessmentSubmission.js";
import isAdminEmail from "../utils/isAdminEmail.js";
import DEPARTMENTS, { FIRST_YEAR_DEPT, deptOfStudent } from "../utils/departments.js";
import { loadAccount, studentDbReady } from "../utils/accounts.js";
import {
  storeFile, removeFile, removeMany, fileOut, fileAllowed, storageReady, storageKind, isDriveFile, isSupabaseFile, canPreview, isPrivateFile, streamPrivate,
  driveOut, connectFolder, lockAccess, listFolderAccess, providerOf, driveShare
} from "../utils/fileStore.js";
import * as driveApi from "../utils/driveStore.js";
import * as sb from "../utils/supabase.js";
import { oauthAuthUrl, exchangeCode, oauthClient, storedTokenActive } from "../utils/googleAuth.js";
import { saveDriveToken, clearDriveToken } from "../utils/driveTokenStore.js";
import { runTests, runnerReady, runnerKind, runnerNote, LANGS } from "../utils/codeRunner.js";
import { sheetsConfigured, serviceAccountEmail, idFromUrl, urlOf, createSpreadsheet, shareWith, lockSheet, openSpreadsheet, upsertRow, rewriteAll } from "../utils/assessmentSheets.js";

import { isDeptRole } from "../utils/roles.js";
// ASSESSMENTS
//   /api/assessments/manage/...   admin + department editors build assessments and read responses
//   /api/assessments/mine/...     students see their assessments, answer and upload files
//
// FILES (teacher material + students' uploads: pdf, image, zip, docs, text … any type) go to
// GOOGLE DRIVE (once connected and working), otherwise SUPABASE STORAGE — never switched off — into a private folder per
// assessment that only the assessment provider can open (utils/fileStore.js). TEXT answers and multiple-choice picks go to that assessment's Google Sheet.
// Students never receive a Drive link: they download through this API, which checks who is asking.
// Older Cloudinary uploads keep working. Code answers are run by utils/codeRunner.js.

const router = express.Router();

// ---------- Google sends the admin back here after "Connect Google Drive" ----------
// (declared BEFORE requireAuth: it is a browser redirect from Google, so it carries no sign-in
// header — the signed `state` made in /manage/drive/oauth/start proves who started it.)
const redirectUriFor = (req) => {
  if (process.env.GOOGLE_OAUTH_REDIRECT_URI) return process.env.GOOGLE_OAUTH_REDIRECT_URI.trim();
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol).split(",")[0].trim();
  return `${proto}://${req.get("host")}/api/assessments/drive/oauth/callback`;
};
const clientBase = () => {
  const o = String(process.env.CLIENT_ORIGIN || "").split(",")[0].trim().replace(/\/$/, "");
  return o && o !== "*" ? o : "";
};
router.get("/drive/oauth/callback", async (req, res) => {
  const back = (result, why = "") => res.redirect(`${clientBase()}/assessments/responses?drive=${result}${why ? `&why=${encodeURIComponent(String(why).slice(0, 240))}` : ""}`);
  try {
    if (req.query.error) return back(req.query.error === "access_denied" ? "denied" : "error", req.query.error_description || req.query.error);
    const st = jwt.verify(String(req.query.state || ""), process.env.JWT_SECRET);
    if (st.purpose !== "drive-oauth") return back("error", "The sign-in link was not made by this site.");
    const me = await User.findById(st.sub);
    if (!me || !isAdminUser(me)) return back("error", "Only an admin can connect Google Drive.");
    const t = await exchangeCode(String(req.query.code || ""), redirectUriFor(req));
    if (!t.refresh_token) return back("norefresh");
    const about = await fetch(`${process.env.DRIVE_API_BASE || "https://www.googleapis.com/drive/v3"}/about?fields=user(emailAddress)`, { headers: { Authorization: `Bearer ${t.access_token}` } })
      .then((x) => x.json()).catch(() => ({}));
    await saveDriveToken({ refreshToken: t.refresh_token, account: about.user?.emailAddress || "", by: me.name });
    back("connected");
  } catch (e) {
    console.error("[assessments] drive sign-in failed:", e.message);
    // e.g. redirect_uri_mismatch, invalid_client, "The state token expired" — shown on the page so it can be fixed
    back("error", e.message);
  }
});

router.use(requireAuth);

const isId = (v) => mongoose.isValidObjectId(v);
const escapeRx = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rid = () => crypto.randomBytes(5).toString("hex");
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const handle = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error("[assessments]", e);
    res.status(500).json({ error: e.message || "Something went wrong" });
  }
};

// One file per request. Two ways in:
//   JSON { ticket, name }  the browser uploaded it straight to Supabase (POST /api/files/sign, section "assessments") — big files
//   multipart "file"       the file passes through this server (kept in memory, then stored in Supabase)
const SERVER_MAX = Math.min(sb.maxFileBytes(), 50 * 1024 * 1024); // files that pass through the server stay in memory — keep that bounded
const uploader = multer({ storage: multer.memoryStorage(), limits: { fileSize: SERVER_MAX, files: 1 } }).single("file");
const takeFile = (req, res) =>
  new Promise((resolve, reject) => {
    if (req.body?.ticket && !req.is("multipart/form-data")) {
      sb.claim({ name: req.body.name, ticket: req.body.ticket }, { section: "assessments", uid: req.userId })
        .then((rec) => resolve({ originalname: rec.name, mimetype: rec.mime, size: rec.size, claimed: rec }))
        .catch(reject);
      return;
    }
    uploader(req, res, (err) => {
      if (err?.code === "LIMIT_FILE_SIZE") return reject(bad(`That file is too large (${Math.round(SERVER_MAX / 1048576)} MB is the most the server accepts).`, 413));
      if (err) return reject(bad(err.message));
      if (!req.file) return reject(bad("Choose a file to upload."));
      resolve(req.file);
    });
  });

const TYPES = ["text", "number", "date", "email", "phone", "mcq", "file", "code", "link"];
// Question types whose answer is one short piece of text (stored in answer.text).
const TEXTY = ["text", "number", "date", "email", "phone"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+\d][\d\s()-]{6,18}$/;

// ============================================================ helpers
const isAdminUser = (u) => u && (u.role === "admin" || isAdminEmail(u.email));

// Students that an assessment is meant for.
function audience(a) {
  if (a.department === FIRST_YEAR_DEPT) return { year: "1" };
  const q = { department: a.department, year: { $in: ["2", "3"] } };
  if (a.year) q.year = a.year;
  return q;
}
const forStudent = (a, me) => a.department === deptOfStudent(me) && (!a.year || a.year === String(me.year));

const totalPoints = (a) => a.blocks.reduce((n, b) => n + (b.points || 0), 0);
const blockOf = (a, id) => a.blocks.find((b) => b.id === id);

// Clean what a teacher sends into a safe assessment document.
function cleanAssessment(b, me) {
  const title = str(b.title, 140);
  if (!title) throw bad("Give the assessment a title.");
  const department = str(b.department, 10).toLowerCase();
  if (!DEPARTMENTS.includes(department)) throw bad("Choose a department.");
  const out = {
    title,
    description: str(b.description, 4000),
    department,
    year: ["1", "2", "3"].includes(String(b.year)) ? String(b.year) : "",
    subject: str(b.subject, 100),
    status: b.status === "published" ? "published" : "draft",
    allowLate: !!b.allowLate,
    allowResubmit: b.allowResubmit !== false,
    important: !!b.important,
    dueAt: null
  };
  if (department === FIRST_YEAR_DEPT) out.year = "1";
  if (b.dueAt) {
    const d = new Date(b.dueAt);
    if (Number.isNaN(d.getTime())) throw bad("The due date isn't valid.");
    out.dueAt = d;
  }
  const raw = Array.isArray(b.blocks) ? b.blocks : [];
  if (raw.length > 40) throw bad("An assessment can have at most 40 tasks.");
  const seen = new Set();
  out.blocks = raw.map((x, i) => {
    const type = TYPES.includes(x.type) ? x.type : null;
    if (!type) throw bad(`Task ${i + 1} has an unknown type.`);
    let id = str(x.id, 20).replace(/[^\w-]/g, "") || rid();
    if (seen.has(id)) id = rid();
    seen.add(id);
    const blk = {
      id, type, prompt: str(x.prompt, 4000), help: str(x.help, 1000), required: x.required !== false,
      points: Math.max(0, Math.min(1000, Number(x.points) || 0))
    };
    if (!blk.prompt) throw bad(`Task ${i + 1} needs a question or instruction.`);
    if (type === "text") blk.longText = x.longText !== false;
    if (type === "number") {
      const lim = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
      blk.min = lim(x.min); blk.max = lim(x.max); blk.whole = x.whole !== false;
      if (blk.min != null && blk.max != null && blk.min > blk.max) throw bad(`Task ${i + 1}: the smallest value is bigger than the largest.`);
    }
    if (type === "mcq") {
      blk.dropdown = !!x.dropdown;
      const opts = (Array.isArray(x.options) ? x.options : []).map((o) => ({ id: str(o.id, 20).replace(/[^\w-]/g, "") || rid(), text: str(o.text, 500) })).filter((o) => o.text);
      if (opts.length < 2) throw bad(`Task ${i + 1}: add at least two options.`);
      if (opts.length > 10) throw bad(`Task ${i + 1}: at most 10 options.`);
      const ids = new Set(opts.map((o) => o.id));
      blk.options = opts;
      blk.multiple = !!x.multiple;
      blk.correct = (Array.isArray(x.correct) ? x.correct : []).map(String).filter((c) => ids.has(c));
      if (!blk.multiple && blk.correct.length > 1) blk.correct = blk.correct.slice(0, 1);
    }
    if (type === "file") {
      blk.accept = ["any", "pdf", "image", "pdf_image", "doc"].includes(x.accept) ? x.accept : "any";
      blk.maxFiles = Math.max(1, Math.min(10, Math.round(Number(x.maxFiles)) || 1));
      blk.maxSizeMB = Math.max(1, Math.min(25, Number(x.maxSizeMB) || 10));
    }
    if (type === "code") {
      blk.languages = (Array.isArray(x.languages) ? x.languages : []).filter((l) => LANGS[l]);
      if (!blk.languages.length) throw bad(`Task ${i + 1}: choose at least one language.`);
      blk.timeLimitMs = Math.max(500, Math.min(5000, Number(x.timeLimitMs) || 2000));
      blk.starter = {};
      for (const l of blk.languages) blk.starter[l] = String(x.starter?.[l] ?? "").slice(0, 20000);
      const tcs = Array.isArray(x.testCases) ? x.testCases : [];
      if (tcs.length > 20) throw bad(`Task ${i + 1}: at most 20 test cases.`);
      blk.testCases = tcs.map((t) => ({
        id: str(t.id, 20).replace(/[^\w-]/g, "") || rid(), label: str(t.label, 80),
        input: String(t.input ?? "").slice(0, 5000), expected: String(t.expected ?? "").slice(0, 5000),
        hidden: !!t.hidden, points: Math.max(0, Math.min(1000, Number(t.points ?? 1)))
      }));
    }
    return blk;
  });
  return out;
}

// What a student may see of a block: no answers, hidden tests reduced to a stub.
function studentBlock(b) {
  const o = b.toObject ? b.toObject() : { ...b };
  delete o.correct;
  if (o.type === "code") {
    o.testCases = (o.testCases || []).map((t) => (t.hidden ? { id: t.id, label: t.label, hidden: true, points: t.points } : t));
  }
  return o;
}

// Checks one short answer (age / number, date, email, phone). Empty is allowed here — "required" is checked on hand-in.
function cleanShort(b, raw) {
  const v = String(raw ?? "").trim().slice(0, 200);
  if (!v) return "";
  const label = `“${String(b.prompt || "").slice(0, 40)}”`;
  if (b.type === "number") {
    const n = Number(v);
    if (!Number.isFinite(n)) throw bad(`${label}: enter a number.`);
    if (b.whole !== false && !Number.isInteger(n)) throw bad(`${label}: enter a whole number.`);
    if (b.min != null && n < b.min) throw bad(`${label}: the smallest value allowed is ${b.min}.`);
    if (b.max != null && n > b.max) throw bad(`${label}: the largest value allowed is ${b.max}.`);
    return String(n);
  }
  if (b.type === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(new Date(v).getTime())) throw bad(`${label}: choose a valid date.`);
    return v;
  }
  if (b.type === "email") { if (!EMAIL_RE.test(v)) throw bad(`${label}: enter a valid email address.`); return v.toLowerCase(); }
  if (b.type === "phone") { if (!PHONE_RE.test(v)) throw bad(`${label}: enter a valid phone number.`); return v; }
  return v;
}

// who: "staff" (teacher view) or "student" — decides which download route a Drive file is fetched from.
const attachmentsOut = (a, who = "student") =>
  (a.attachments || []).map((f) => fileOut(f, (r) => (who === "staff" ? `/manage/${a._id}/attachments/${r.id}/content` : `/mine/${a._id}/attachments/${r.id}/content`)));
const answerFileOut = (s, a, forStaff) => (f) =>
  fileOut(f, (r) => (forStaff ? `/manage/submissions/${s._id}/files/${r.id}/content` : `/mine/${a._id}/files/${r.id}/content`));

function submissionOut(s, a, { forStaff = false } = {}) {
  if (!s) return null;
  const total = (s.answers || []).reduce((n, x) => n + (typeof x.score === "number" ? x.score : 0), 0);
  const needsReview = a.blocks.some((b) => {
    const ans = s.answers.find((x) => x.blockId === b.id);
    if (!ans) return false;
    const hasContent = b.type === "file" ? ans.files?.length : b.type === "code" ? ans.code?.trim() : b.type === "link" ? ans.link : TEXTY.includes(b.type) ? ans.text?.trim() : false;
    return hasContent && b.points > 0 && typeof ans.score !== "number";
  });
  const showScores = forStaff || s.graded;
  return {
    id: String(s._id), assessmentId: String(s.assessmentId), studentId: String(s.studentId),
    studentName: s.studentName, studentEmail: s.studentEmail, department: s.department, year: s.year,
    status: s.status, submittedAt: s.submittedAt, late: s.late, graded: s.graded, gradedAt: s.gradedAt, gradedByName: s.gradedByName,
    feedback: showScores ? s.feedback : "", needsReview, maxScore: totalPoints(a),
    score: showScores ? total : null,
    answers: s.answers.map((x) => ({
      blockId: x.blockId, text: x.text, choice: x.choice, link: x.link, code: x.code, language: x.language,
      files: (x.files || []).map(answerFileOut(s, a, forStaff)),
      run: x.run ? stripRun(x.run, forStaff) : null,
      score: showScores || forStaff ? x.score : null,
      manual: x.manual, feedback: showScores ? x.feedback : ""
    })),
    updatedAt: s.updatedAt
  };
}
// Students never see the input / expected output of hidden tests (already removed when run).
const stripRun = (run) => run;

function statusOf(s) {
  if (!s) return "not_started";
  if (s.graded) return "graded";
  return s.status === "submitted" ? "submitted" : "draft";
}

// Score the auto-markable answers (multiple choice and code). Teacher-set scores stay.
function autoScore(a, s) {
  for (const ans of s.answers) {
    const b = blockOf(a, ans.blockId);
    if (!b || ans.manual) continue;
    if (b.type === "mcq" && b.correct?.length) {
      const picked = [...(ans.choice || [])].sort().join("|");
      const right = [...b.correct].sort().join("|");
      ans.score = picked && picked === right ? b.points : 0;
    } else if (b.type === "code" && ans.run && !ans.run.error && ans.run.possible > 0) {
      ans.score = Math.round((b.points * ans.run.earned / ans.run.possible) * 100) / 100;
    }
  }
}

// ============================================================ history log
// A short timeline per submission (shown on the student's History page).
function pushEvent(s, type, note = "") {
  const list = s.events || (s.events = []);
  const last = list[list.length - 1];
  // Autosaves would flood the timeline — keep one "draft saved" per 10 minutes.
  if (type === "draft_saved" && last?.type === "draft_saved" && Date.now() - new Date(last.at).getTime() < 600000) return;
  list.push({ at: new Date(), type, note: String(note).slice(0, 200) });
  if (list.length > 60) list.splice(0, list.length - 60);
}

// ============================================================ Google Sheet (text answers)
const SHEET_TAB = "Responses";
const when = (d) => (d ? new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) : "");

function sheetHeaders(a) {
  const h = ["Submission ID", "Submitted at (IST)", "Status", "Late", "Student name", "Email", "Department", "Year"];
  a.blocks.forEach((b, i) => {
    h.push(`Q${i + 1}: ${b.prompt.replace(/\s+/g, " ").slice(0, 70)}`);
    if (b.type === "code") h.push(`Q${i + 1} auto-check`);
  });
  h.push("Score", "Out of", "Graded", "Feedback", "Drive folder");
  return h;
}
function sheetRow(a, s) {
  const out = submissionOut(s, a, { forStaff: true });
  const row = [String(s._id), when(s.submittedAt), s.graded ? "graded" : s.status, s.late ? "yes" : "", s.studentName, s.studentEmail, String(s.department || "").toUpperCase(), s.year];
  for (const b of a.blocks) {
    const ans = s.answers.find((x) => x.blockId === b.id) || {};
    if (TEXTY.includes(b.type)) row.push(ans.text || "");
    else if (b.type === "link") row.push(ans.link || "");
    else if (b.type === "mcq") row.push((ans.choice || []).map((id) => b.options.find((o) => o.id === id)?.text).filter(Boolean).join(", "));
    else if (b.type === "file") row.push((ans.files || []).map((f) => `${f.name}: ${f.viewLink || f.url}`).join("\n")); // Drive links open only for people the folder is shared with
    else if (b.type === "code") {
      row.push(ans.code ? `[${LANGS[ans.language]?.label || ans.language}]\n${ans.code}` : "");
      const r = ans.run;
      row.push(!r ? "" : r.error ? "not auto-checked" : r.compileError ? "compile error" : `${r.passed}/${r.total} tests passed`);
    }
  }
  row.push(out.score ?? "", out.maxScore, s.graded ? "yes" : "no", s.feedback || "", s.driveFolderUrl || "");
  return row;
}

// Syncs for one sheet run one after another, so two quick saves can't add the same row twice.
const chains = new Map();
function serial(key, fn) {
  const next = (chains.get(key) || Promise.resolve()).catch(() => {}).then(fn);
  chains.set(key, next);
  next.finally(() => { if (chains.get(key) === next) chains.delete(key); }).catch(() => {});
  return next;
}
async function sheetResult(aId, ok, err = "") {
  await Assessment.updateOne({ _id: aId }, { $set: { "sheet.lastSyncAt": ok ? new Date() : undefined, "sheet.lastError": ok ? "" : String(err).slice(0, 300) } }).catch(() => {});
}

// One student's row (best effort — a sheet problem never blocks the student).
function syncSubmission(aId, sId) {
  setImmediate(async () => {
    let a = null;
    try {
      a = await Assessment.findById(aId);
      if (a?.store !== "supabase" && a?.sheet?.spreadsheetId && sheetsConfigured()) {
        await serial(a.sheet.spreadsheetId, async () => {
          const s = await Submission.findById(sId);
          if (!s || s.status !== "submitted") return;
          await upsertRow(a.sheet.spreadsheetId, a.sheet.tab || SHEET_TAB, sheetHeaders(a), sheetRow(a, s));
        });
        await sheetResult(aId, true);
      }
    } catch (e) { console.error("[assessments] sheet sync failed:", e.message); await sheetResult(aId, false, e.message); }
    // Important data: keep a Supabase copy too (a sheet problem never stops this, and vice versa).
    try {
      if ((a?.important || a?.store === "supabase") && sb.ready()) {
        const s = await Submission.findById(sId);
        if (s && s.status === "submitted") { await backupSubmission(a, s); await backupResult(aId, true); }
      }
    } catch (e) { console.error("[assessments] Supabase backup failed:", e.message); await backupResult(aId, false, e.message); }
  });
}
// Everything: headers + every submitted row.
async function syncAll(a) {
  const subs = await Submission.find({ assessmentId: a._id, status: "submitted" }).sort({ submittedAt: 1 });
  await serial(a.sheet.spreadsheetId, () => rewriteAll(a.sheet.spreadsheetId, a.sheet.tab || SHEET_TAB, sheetHeaders(a), subs.map((s) => sheetRow(a, s))));
  return subs.length;
}
// ---- "Important data": a JSON copy of every submission in Supabase Storage (next to the Google Sheet) ----
function backupDoc(a, s) {
  const out = submissionOut(s, a, { forStaff: true });
  return {
    assessmentId: String(a._id), assessment: a.title, department: a.department, year: a.year,
    submissionId: String(s._id), studentId: String(s.studentId), studentName: s.studentName, studentEmail: s.studentEmail,
    status: s.graded ? "graded" : s.status, submittedAt: s.submittedAt, late: !!s.late, score: out.score, outOf: out.maxScore,
    answers: a.blocks.map((b, i) => {
      const ans = s.answers.find((x) => x.blockId === b.id) || {};
      let value = "";
      if (TEXTY.includes(b.type)) value = ans.text || "";
      else if (b.type === "link") value = ans.link || "";
      else if (b.type === "mcq") value = (ans.choice || []).map((id) => b.options.find((o) => o.id === id)?.text).filter(Boolean);
      else if (b.type === "file") value = (ans.files || []).map((f) => ({ name: f.name, link: f.viewLink || f.url || "" }));
      else if (b.type === "code") value = { language: ans.language, code: ans.code || "" };
      return { n: i + 1, type: b.type, question: b.prompt, answer: value, score: typeof ans.score === "number" ? ans.score : null };
    }),
    savedAt: new Date().toISOString()
  };
}
async function backupResult(aId, ok, err = "", count) {
  const set = { "backup.lastError": ok ? "" : String(err).slice(0, 300) };
  if (ok) set["backup.lastAt"] = new Date();
  const upd = { $set: set };
  if (ok && count != null) upd.$set["backup.count"] = count;
  await Assessment.updateOne({ _id: aId }, upd).catch(() => {});
}
async function backupSubmission(a, s) {
  await sb.putJson("assessments", [String(a._id), "responses"], String(s.studentId), backupDoc(a, s));
}
async function backupAll(a) {
  const subs = await Submission.find({ assessmentId: a._id, status: "submitted" });
  for (const s of subs) await backupSubmission(a, s);
  await backupResult(a._id, true, "", subs.length);
  return subs.length;
}

const sheetOut = (a) => ({
  configured: sheetsConfigured(), serviceAccount: serviceAccountEmail(),
  connected: !!a.sheet?.spreadsheetId, url: a.sheet?.url || "", tab: a.sheet?.tab || SHEET_TAB, mode: a.sheet?.mode || "",
  sharedWith: a.sheet?.sharedWith || [], lastSyncAt: a.sheet?.lastSyncAt || null, lastError: a.sheet?.lastError || ""
});

// ============================================================ reading stored files
const findAnswerFile = (s, fid) => {
  for (const ans of s?.answers || []) {
    const f = (ans.files || []).find((x) => x.id === fid);
    if (f) return f;
  }
  return null;
};
// Streams one stored file to the signed-in person who was already checked by the route.
// Supabase and Drive files are proxied (the browser never sees a storage URL).
// Drive files are proxied (the browser never sees a Drive URL); only pdf / images open in the
// tab, everything else is a download. Older Cloudinary files redirect to their link.
async function sendStored(res, f, download = false) {
  if (!f) throw bad("File not found", 404);
  if (isSupabaseFile(f)) {            // Supabase Storage (private bucket): streamed by the server, only after the route checked who is asking
    try { await sb.stream(res, f.path, { name: f.name, mime: f.mime, download: download || !canPreview(f) }); }
    catch (e) { if (res.headersSent) { res.destroy(); return; } throw bad(e.message, e.status === 404 ? 404 : 502); }
    return;
  }
  if (isPrivateFile(f)) {            // Cloudinary Account 2 (authenticated): streamed by the server, never a public link
    try { await streamPrivate(res, f, { download: download || !canPreview(f) }); }
    catch (e) { if (res.headersSent) { res.destroy(); return; } throw bad(e.message, e.status === 404 ? 404 : 502); }
    return;
  }
  if (!isDriveFile(f)) {
    const out = fileOut(f);
    return res.redirect(download ? out.downloadUrl || out.url : out.url);
  }
  try {
    await driveApi.streamTo(res, f.driveId, { name: f.name, mime: f.mime, inline: !download && canPreview(f) });
  } catch (e) {
    if (res.headersSent) { res.destroy(); return; }
    throw bad(e.message, e.code === 404 ? 404 : 502);
  }
}

// ============================================================ STAFF
async function staffGate(req, res, next) {
  try {
    if (req.userKind === "student") return res.status(403).json({ error: "Staff accounts only." });
    const me = await User.findById(req.userId);
    if (!me) return res.status(401).json({ error: "Not authenticated" });
    const admin = isAdminUser(me);
    if (!admin && !(isDeptRole(me.role) && me.editorDept)) {
      return res.status(403).json({ error: "Only admins and department editors can manage assessments." });
    }
    req.me = me; req.isAdmin = admin; req.editorDept = admin ? null : me.editorDept;
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}
const canDept = (req, dept) => req.isAdmin || req.editorDept === dept;

async function ownedAssessment(req) {
  if (!isId(req.params.id)) throw bad("Not found", 404);
  const a = await Assessment.findById(req.params.id);
  if (!a) throw bad("Not found", 404);
  if (!canDept(req, a.department)) throw bad("This assessment belongs to another department.", 403);
  return a;
}

// Order of setup (the same for every staff member — there is no per-person switch any more):
// 1) paste YOUR Google Sheet link (nothing else is offered before this), 2) file questions only: Supabase Storage
// connected, 3) add questions. Only NEW questions are checked, so an older assessment can still be edited and saved.
function requireSheets() {
  if (!sheetsConfigured()) throw bad("Google Sheets isn't connected on the server yet — assessments can only be created once it is.", 409);
}
function requireFiles() {
  // File-upload questions store everything in Supabase Storage — Google Drive is not needed.
  if (!sb.ready()) throw bad("Supabase Storage isn't set up on the server yet — file-upload questions need it (SUPABASE_URL / SUPABASE_SECRET_KEY).", 409);
}
function checkSetup(req, a, blocks) {
  const have = new Set((a?.blocks || []).map((b) => b.id));
  const fresh = blocks.filter((b) => !have.has(b.id));
  if (!fresh.length) return;
  requireSheets();
  if (a && !a.sheet?.spreadsheetId) {
    throw bad("Paste your Google Sheet link first — questions can be added once answers have somewhere to go.");
  }
  if (fresh.some((b) => b.type === "file")) requireFiles();
}

// Every staff member brings THEIR OWN Google Sheet: paste its link, share it with the service account as Editor.
// Without a tab name the tab is named after the assessment, so two assessments never overwrite each other.
const TAB_BAD = /[\[\]*?:/\\]/g;
const sheetTabFor = (tab, title) => str(tab, 60).replace(TAB_BAD, "").trim() || str(title, 60).replace(TAB_BAD, "").trim() || SHEET_TAB;
async function checkSheetLink(url) {
  const id = idFromUrl(url);
  if (!id) throw bad("Paste the Google Sheet link (docs.google.com/spreadsheets/d/…).");
  try {
    const info = await openSpreadsheet(id);
    return { id, url: urlOf(id), title: info.title };
  } catch (e) { throw bad(e.message, e.status === 404 || e.status === 403 ? 400 : 502); }
}

// Remember the staff member's own sheet so the connect step is skipped next time (best effort).
const rememberSheet = (me, link) =>
  User.updateOne({ _id: me._id }, { $set: { "assessmentSheet.url": link.url, "assessmentSheet.title": link.title || "" } }).catch(() => {});

const manage = express.Router();
manage.use(staffGate);

manage.get("/status", (req, res) => {
  const di = driveApi.driveAuthInfo();
  const sheets = sheetsConfigured();
  const driveOk = driveApi.driveCanStore();
  const supabaseOk = sb.ready();
  res.json({
    storage: storageReady(), storageKind: storageKind(), supabase: supabaseOk,
    drive: { configured: driveApi.driveReady(), mode: di.mode, account: di.account, canStore: driveOk },
    runner: runnerReady() ? runnerKind() : null, runnerNote: runnerNote(), sheets,
    isAdmin: req.isAdmin, serviceAccount: serviceAccountEmail(),
    mySheet: mySheetOut(req.me),
    can: { create: sheets && !!req.me?.assessmentSheet?.url, files: sheets && supabaseOk },
    languages: Object.entries(LANGS).map(([k, v]) => ({ key: k, label: v.label }))
  });
});

// ---- Connect Google Drive (admin, one time) ----
// The server needs ONE Google account whose Drive holds the files. An admin signs in to it here;
// the token is stored encrypted in the database. Nothing is typed into a terminal.
manage.get("/drive/oauth", handle(async (req, res) => {
  const info = driveApi.driveAuthInfo();
  // Really ask Google (not just "a token is saved"): a revoked / expired sign-in shows up here as "not working".
  const health = info.mode === "none" ? { ok: false, error: "" } : await driveApi.driveHealth();
  const account = health.email || info.account;
  const pid = encodeURIComponent(info.projectId || "");
  res.json({
    isAdmin: req.isAdmin, hasClient: !!oauthClient(), mode: info.mode, connected: info.mode === "oauth", working: !!health.ok, problem: health.ok ? "" : health.error || "",
    account, fromPortal: storedTokenActive(), canStore: driveApi.driveCanStore(), storage: storageKind(), redirectUri: redirectUriFor(req),
    projectId: info.projectId || "",
    links: info.projectId ? {
      consent: `https://console.cloud.google.com/apis/credentials/consent?project=${pid}`,
      credentials: `https://console.cloud.google.com/apis/credentials?project=${pid}`,
      driveApi: `https://console.cloud.google.com/apis/library/drive.googleapis.com?project=${pid}`
    } : null
  });
}));
manage.post("/drive/oauth/start", handle(async (req, res) => {
  if (!req.isAdmin) throw bad("Only an admin can connect the Google Drive account.", 403);
  const redirectUri = redirectUriFor(req);
  const state = jwt.sign({ purpose: "drive-oauth", sub: String(req.me._id) }, process.env.JWT_SECRET, { expiresIn: "10m" });
  try { res.json({ url: oauthAuthUrl({ redirectUri, state }), redirectUri }); }
  catch (e) { throw bad(e.message, e.status || 500); }
}));
manage.delete("/drive/oauth", handle(async (req, res) => {
  if (!req.isAdmin) throw bad("Only an admin can disconnect the Google Drive account.", 403);
  await clearDriveToken();
  res.json({ ok: true });
}));

// List (editors only ever see their own department)
manage.get("/", handle(async (req, res) => {
  const q = {};
  if (!req.isAdmin) q.department = req.editorDept;
  else if (req.query.dept && DEPARTMENTS.includes(String(req.query.dept))) q.department = String(req.query.dept);
  const list = await Assessment.find(q).sort({ createdAt: -1 });
  const counts = await Submission.aggregate([
    { $match: { assessmentId: { $in: list.map((a) => a._id) }, status: "submitted" } },
    { $group: { _id: "$assessmentId", submitted: { $sum: 1 }, graded: { $sum: { $cond: ["$graded", 1, 0] } } } }
  ]);
  const byId = Object.fromEntries(counts.map((c) => [String(c._id), c]));
  res.json({
    assessments: list.map((a) => ({
      id: String(a._id), title: a.title, department: a.department, year: a.year, subject: a.subject, status: a.status,
      dueAt: a.dueAt, blocks: a.blocks.length, points: totalPoints(a), createdAt: a.createdAt, createdByName: a.createdByName,
      submitted: byId[String(a._id)]?.submitted || 0, graded: byId[String(a._id)]?.graded || 0,
      types: [...new Set(a.blocks.map((b) => b.type))],
      store: a.store || "sheet", important: !!a.important, sheetConnected: !!a.sheet?.spreadsheetId, backupCount: a.backup?.count || 0
    }))
  });
}));

// Step 1 of a NEW assessment: is this sheet reachable? (nothing is saved yet)
manage.post("/sheet/check", handle(async (req, res) => {
  requireSheets();
  const link = await checkSheetLink(req.body?.url);
  res.json({ ok: true, url: link.url, title: link.title, serviceAccount: serviceAccountEmail() });
}));

// The staff member's ONE connected Google Sheet. Connect it once on the "All assessments" page: every
// NEW assessment then uses it automatically (each in its own tab) until the sheet is changed or disconnected.
// Assessments that already exist keep the sheet they were created with.
const mySheetOut = (me) => (me?.assessmentSheet?.url ? { url: me.assessmentSheet.url, title: me.assessmentSheet.title || "" } : null);
manage.post("/my-sheet", handle(async (req, res) => {
  requireSheets();
  const link = await checkSheetLink(req.body?.url);
  await User.updateOne({ _id: req.me._id }, { $set: { "assessmentSheet.url": link.url, "assessmentSheet.title": link.title || "" } });
  res.json({ ok: true, mySheet: { url: link.url, title: link.title || "" } });
}));
manage.delete("/my-sheet", handle(async (req, res) => {
  await User.updateOne({ _id: req.me._id }, { $set: { "assessmentSheet.url": "", "assessmentSheet.title": "" } });
  res.json({ ok: true, mySheet: null }); // the Google Sheet itself is not deleted
}));

manage.post("/", handle(async (req, res) => {
  const data = cleanAssessment(req.body || {}, req.me);
  if (!canDept(req, data.department)) throw bad("You can only create assessments for your own department.", 403);
  requireSheets();
  // Use the sheet connected on the "All assessments" page unless the request names another one.
  const sheetUrl = String(req.body?.sheetUrl || "").trim() || req.me?.assessmentSheet?.url || "";
  if (!sheetUrl) throw bad("Connect your Google Sheet first (on the All assessments page).");
  const link = await checkSheetLink(sheetUrl);
  checkSetup(req, null, data.blocks);
  const tab = sheetTabFor(req.body?.sheetTab, data.title);
  const sheet = { spreadsheetId: link.id, url: link.url, tab, mode: "linked", sharedWith: [], lastSyncAt: null, lastError: "" };
  const a = await Assessment.create({ ...data, sheet, createdBy: req.me._id, createdByName: req.me.name });
  rememberSheet(req.me, link);
  // First copy into the sheet. If it can't write (e.g. only "Viewer" access) the assessment is still saved — the error is shown.
  let sheetError = "";
  try { await syncAll(a); await sheetResult(a._id, true); }
  catch (e) { sheetError = e.message; await sheetResult(a._id, false, e.message); }
  res.status(201).json({ id: String(a._id), sheet: sheetOut(await Assessment.findById(a._id)), sheetError });
}));

manage.get("/students", handle(async (req, res) => {
  if (!studentDbReady()) throw bad("The student database is not available right now.", 503);
  let dept = String(req.query.dept || "").toLowerCase();
  if (!req.isAdmin) dept = req.editorDept;
  const q = dept ? audience({ department: dept, year: String(req.query.year || "") }) : {};
  if (req.query.q) {
    const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 60), "i");
    q.$or = [{ name: rx }, { email: rx }];
  }
  const students = await StudentAccount.find(q).sort({ year: 1, name: 1 }).limit(300).select("name email department year");
  res.json({ students: students.map((s) => ({ id: String(s._id), name: s.name, email: s.email, department: s.department, year: s.year })) });
}));

manage.get("/submissions/:sid", handle(async (req, res) => {
  if (!isId(req.params.sid)) throw bad("Not found", 404);
  const s = await Submission.findById(req.params.sid);
  if (!s) throw bad("Not found", 404);
  const a = await Assessment.findById(s.assessmentId);
  if (!a || !canDept(req, a.department)) throw bad("Not found", 404);
  res.json({ submission: submissionOut(s, a, { forStaff: true }), assessment: staffAssessment(a) });
}));

// Student-wise view: one student, every assessment meant for them.
manage.get("/student/:studentId", handle(async (req, res) => {
  if (!studentDbReady()) throw bad("The student database is not available right now.", 503);
  if (!isId(req.params.studentId)) throw bad("Not found", 404);
  const st = await StudentAccount.findById(req.params.studentId);
  if (!st) throw bad("Student not found", 404);
  const dept = deptOfStudent(st);
  if (!canDept(req, dept)) throw bad("This student belongs to another department.", 403);
  const list = await Assessment.find({ department: dept, status: "published", $or: [{ year: "" }, { year: st.year }] }).sort({ createdAt: -1 });
  const subs = await Submission.find({ studentId: st._id, assessmentId: { $in: list.map((a) => a._id) } });
  const by = Object.fromEntries(subs.map((s) => [String(s.assessmentId), s]));
  res.json({
    student: { id: String(st._id), name: st.name, email: st.email, department: st.department, year: st.year },
    items: list.map((a) => {
      const s = by[String(a._id)];
      const out = s ? submissionOut(s, a, { forStaff: true }) : null;
      return {
        assessment: { id: String(a._id), title: a.title, subject: a.subject, dueAt: a.dueAt, points: totalPoints(a), blocks: a.blocks.length },
        submissionId: s ? String(s._id) : null, status: statusOf(s), submittedAt: s?.submittedAt || null, late: !!s?.late,
        score: out?.score ?? null, needsReview: out?.needsReview || false
      };
    })
  });
}));

manage.put("/submissions/:sid/grade", handle(async (req, res) => {
  if (!isId(req.params.sid)) throw bad("Not found", 404);
  const s = await Submission.findById(req.params.sid);
  if (!s) throw bad("Not found", 404);
  const a = await Assessment.findById(s.assessmentId);
  if (!a || !canDept(req, a.department)) throw bad("Not found", 404);
  const given = Array.isArray(req.body?.answers) ? req.body.answers : [];
  for (const g of given) {
    const b = blockOf(a, String(g.blockId));
    const ans = s.answers.find((x) => x.blockId === String(g.blockId));
    if (!b || !ans) continue;
    if (g.score === "" || g.score == null) { ans.score = null; ans.manual = false; }
    else {
      const n = Number(g.score);
      if (!Number.isFinite(n) || n < 0 || n > b.points) throw bad(`A score for “${b.prompt.slice(0, 30)}” must be between 0 and ${b.points}.`);
      ans.score = Math.round(n * 100) / 100; ans.manual = true;
    }
    ans.feedback = str(g.feedback, 2000);
  }
  s.feedback = str(req.body?.feedback, 2000);
  s.graded = req.body?.graded !== false; // "Save & release" vs. "Save as draft"
  s.gradedAt = new Date(); s.gradedByName = req.me.name;
  s.markModified("answers");
  const gradeOut = submissionOut(s, a, { forStaff: true });
  pushEvent(s, s.graded ? "graded" : "grade_draft", s.graded ? `${gradeOut.score ?? 0} / ${gradeOut.maxScore}` : "");
  await s.save();
  syncSubmission(a._id, s._id);
  res.json({ ok: true, submission: submissionOut(s, a, { forStaff: true }) });
}));

// Moderation: remove a file a student uploaded.
manage.delete("/submissions/:sid/files/:fid", handle(async (req, res) => {
  if (!isId(req.params.sid)) throw bad("Not found", 404);
  const s = await Submission.findById(req.params.sid);
  if (!s) throw bad("Not found", 404);
  const a = await Assessment.findById(s.assessmentId);
  if (!a || !canDept(req, a.department)) throw bad("Not found", 404);
  let gone = null;
  for (const ans of s.answers) {
    const i = (ans.files || []).findIndex((f) => f.id === req.params.fid);
    if (i >= 0) { [gone] = ans.files.splice(i, 1); break; }
  }
  if (!gone) throw bad("File not found", 404);
  pushEvent(s, "file_removed", `${gone.name} (removed by a teacher)`);
  s.markModified("answers");
  await s.save();
  await removeFile(gone);
  syncSubmission(a._id, s._id);
  res.json({ ok: true });
}));

const staffAssessment = (a) => ({
  id: String(a._id), title: a.title, description: a.description, department: a.department, year: a.year, subject: a.subject,
  status: a.status, dueAt: a.dueAt, allowLate: a.allowLate, allowResubmit: a.allowResubmit, points: totalPoints(a),
  blocks: a.blocks.map((b) => b.toObject()), attachments: attachmentsOut(a, "staff"), createdByName: a.createdByName,
  important: !!a.important, backup: { lastAt: a.backup?.lastAt || null, count: a.backup?.count || 0, lastError: a.backup?.lastError || "" }
});

manage.get("/:id", handle(async (req, res) => {
  res.json({ assessment: staffAssessment(await ownedAssessment(req)) });
}));

manage.put("/:id", handle(async (req, res) => {
  const a = await ownedAssessment(req);
  const data = cleanAssessment(req.body || {}, req.me);
  if (!canDept(req, data.department)) throw bad("You can only use your own department.", 403);
  checkSetup(req, a, data.blocks);
  a.set(data);
  await a.save();
  if (a.store !== "supabase" && a.sheet?.spreadsheetId && sheetsConfigured()) {
    syncAll(a).then(() => sheetResult(a._id, true)).catch((e) => sheetResult(a._id, false, e.message));
  }
  if ((a.important || a.store === "supabase") && sb.ready()) backupAll(a).catch((e) => backupResult(a._id, false, e.message));
  res.json({ ok: true });
}));

manage.delete("/:id", handle(async (req, res) => {
  const a = await ownedAssessment(req);
  const subs = await Submission.find({ assessmentId: a._id });
  let files = [...(a.attachments || []), ...subs.flatMap((s) => s.answers.flatMap((x) => x.files || []))];
  const wholeFolder = a.drive?.folderId && a.drive.mode === "created"; // a folder the app made goes as one piece
  if (wholeFolder) files = files.filter((f) => !isDriveFile(f));
  await Submission.deleteMany({ assessmentId: a._id });
  await a.deleteOne();
  await removeMany(files);
  if (wholeFolder) await driveApi.deleteFile(a.drive.folderId);
  res.json({ ok: true, filesRemoved: files.length });
}));

// Teacher attachments (reference material): upload / replace / delete — stored in the
// assessment's Drive folder under "_Teacher material".
const staffAttachmentHref = (a) => (r) => `/manage/${a._id}/attachments/${r.id}/content`;
manage.post("/:id/attachments", handle(async (req, res) => {
  const a = await ownedAssessment(req);
  if ((a.attachments || []).length >= 10) throw bad("An assessment can have at most 10 attachments.");
  const file = await takeFile(req, res);
  const ok = fileAllowed(file, "any"); if (!ok.ok) throw bad(ok.why);
  const { folder, ...rec } = await storeFile(file, { assessment: a, kind: "material" });
  const fresh = await Assessment.findById(a._id);
  fresh.attachments.push(rec); await fresh.save();
  res.status(201).json({ file: fileOut(rec, staffAttachmentHref(a)) });
}));
manage.put("/:id/attachments/:fid", handle(async (req, res) => {
  const a = await ownedAssessment(req);
  if (!a.attachments.some((f) => f.id === req.params.fid)) throw bad("File not found", 404);
  const file = await takeFile(req, res);
  const ok = fileAllowed(file, "any"); if (!ok.ok) throw bad(ok.why);
  const { folder, ...rec } = await storeFile(file, { assessment: a, kind: "material" });
  const fresh = await Assessment.findById(a._id);
  const i = fresh.attachments.findIndex((f) => f.id === req.params.fid);
  if (i < 0) { await removeFile(rec); throw bad("File not found", 404); }
  const old = fresh.attachments[i].toObject();
  fresh.attachments.set(i, rec); await fresh.save();
  await removeFile(old);
  res.json({ file: fileOut(rec, staffAttachmentHref(a)) });
}));
manage.delete("/:id/attachments/:fid", handle(async (req, res) => {
  const a = await ownedAssessment(req);
  const i = a.attachments.findIndex((f) => f.id === req.params.fid);
  if (i < 0) throw bad("File not found", 404);
  const [gone] = a.attachments.splice(i, 1);
  await a.save(); await removeFile(gone);
  res.json({ ok: true });
}));

// Teachers read files through the portal too (so Drive access is only ever the provider's own).
manage.get("/:id/attachments/:fid/content", handle(async (req, res) => {
  const a = await ownedAssessment(req);
  await sendStored(res, a.attachments.find((f) => f.id === req.params.fid), req.query.download === "1");
}));
manage.get("/submissions/:sid/files/:fid/content", handle(async (req, res) => {
  if (!isId(req.params.sid)) throw bad("Not found", 404);
  const s = await Submission.findById(req.params.sid);
  if (!s) throw bad("Not found", 404);
  const a = await Assessment.findById(s.assessmentId);
  if (!a || !canDept(req, a.department)) throw bad("Not found", 404);
  await sendStored(res, findAnswerFile(s, req.params.fid), req.query.download === "1");
}));

// ---- Google Drive folder for this assessment's FILES ----
// Whoever may manage the assessment (admin / the department's editor) may connect or lock its
// folder; inside Drive itself only the provider (+ staff added below) can open it.
manage.get("/:id/drive", handle(async (req, res) => {
  const a = await ownedAssessment(req);
  const out = { drive: driveOut(a) };
  if (!out.drive.provider.email) out.drive.provider = await providerOf(a);
  if (driveApi.driveReady() && !out.drive.account) { try { out.drive.account = (await driveApi.whoAmI()).email; } catch { /* shown later as a Drive error */ } }
  if (req.query.access === "1" && a.drive?.folderId && driveApi.driveReady()) {
    try { out.access = await listFolderAccess(a); } catch (e) { out.accessError = e.message; }
  }
  res.json(out);
}));
manage.post("/:id/drive", handle(async (req, res) => {
  const a = await ownedAssessment(req);
  requireFiles();
  const action = req.body?.action === "link" ? "link" : "create";
  try { await connectFolder(a, { action, url: req.body?.url }); }
  catch (e) { throw bad(e.message, e.status && e.status < 500 ? e.status : 502); }
  const out = driveOut(a);
  if (!out.provider.email) out.provider = await providerOf(a);
  res.status(201).json({ drive: out });
}));
// "Only the provider": removes link-sharing and every other person from the folder (and the sheet
// the app created), keeping just the provider and the staff added with /drive/share.
manage.post("/:id/drive/lock", handle(async (req, res) => {
  const a = await ownedAssessment(req);
  let r;
  try { r = await lockAccess(a, lockSheet); }
  catch (e) { throw bad(e.message, e.status && e.status < 500 ? e.status : 502); }
  res.json({ ok: true, result: r, drive: driveOut(await Assessment.findById(a._id)) });
}));
// Adds ANOTHER staff member of this department (or an admin) to the folder / sheet. Students and
// outside emails are refused.
manage.post("/:id/drive/share", handle(async (req, res) => {
  const a = await ownedAssessment(req);
  if (!a.drive?.folderId) throw bad("Connect a Drive folder first.");
  const email = str(req.body?.email, 160).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad("Enter a valid email address.");
  const u = await User.findOne({ email: new RegExp(`^${escapeRx(email)}$`, "i") });
  const okStaff = u && (isAdminUser(u) || (isDeptRole(u.role) && u.editorDept === a.department));
  if (!okStaff) throw bad("Only an admin or this department's editor can be added — they must have a staff account here.", 403);
  const f = await driveShare(a.drive.folderId, email, "writer");
  if (!f.shared) throw bad(f.error, 502);
  let sheetShared = null;
  if (a.sheet?.spreadsheetId) sheetShared = (await shareWith(a.sheet.spreadsheetId, email, "writer")).shared;
  await Assessment.updateOne({ _id: a._id }, { $addToSet: { "drive.sharedWith": email, ...(a.sheet?.spreadsheetId ? { "sheet.sharedWith": email } : {}) } });
  res.json({ ok: true, sheetShared, drive: driveOut(await Assessment.findById(a._id)) });
}));

// ---- Google Sheet for this assessment's text answers ----
manage.get("/:id/sheet", handle(async (req, res) => {
  res.json({ sheet: sheetOut(await ownedAssessment(req)) });
}));
// Create a new sheet, or point this assessment at an existing one (changing it later
// just calls this again — the old Google Sheet is left untouched).
manage.post("/:id/sheet", handle(async (req, res) => {
  const a = await ownedAssessment(req);
  if (!sheetsConfigured()) throw bad("Google Sheets isn't set up on the server yet (the service-account key is missing).", 503);
  const action = req.body?.action === "link" ? "link" : "create";
  const tab = sheetTabFor(req.body?.tab, a.title);
  let id, url, shared = null;
  if (action === "create") {
    const made = await createSpreadsheet(`${a.title} — responses (${a.department.toUpperCase()})`, tab);
    id = made.spreadsheetId; url = made.url;
    // Provider (+ the staff member pressing the button) only — then every other permission is removed.
    const prov = await providerOf(a);
    const who = [...new Set([prov.email, String(req.me.email || "").toLowerCase()].filter(Boolean))];
    const results = await Promise.all(who.map((e) => shareWith(id, e, "writer")));
    shared = { shared: results.some((r) => r.shared), error: results.find((r) => !r.shared)?.error || "", emails: who.filter((_, i) => results[i].shared) };
    try { await lockSheet(id, shared.emails); } catch { /* best effort */ }
  } else {
    const link = await checkSheetLink(req.body?.url);
    id = link.id; url = link.url;
    rememberSheet(req.me, link);
  }
  a.sheet = { spreadsheetId: id, url, tab, mode: action === "create" ? "created" : "linked", sharedWith: shared?.shared ? shared.emails : [], lastSyncAt: null, lastError: "" };
  await a.save();
  let rows = 0;
  try { rows = await syncAll(a); await sheetResult(a._id, true); }
  catch (e) { await sheetResult(a._id, false, e.message); throw bad(e.message, 502); }
  const fresh = await Assessment.findById(a._id);
  res.status(201).json({ sheet: sheetOut(fresh), rows, shared: shared ? shared.shared : null, shareError: shared && !shared.shared ? shared.error : "" });
}));
manage.post("/:id/sheet/sync", handle(async (req, res) => {
  const a = await ownedAssessment(req);
  if (!a.sheet?.spreadsheetId) throw bad("No Google Sheet is connected to this assessment.");
  let rows;
  try { rows = await syncAll(a); await sheetResult(a._id, true); }
  catch (e) { await sheetResult(a._id, false, e.message); throw bad(e.message, 502); }
  res.json({ ok: true, rows, sheet: sheetOut(await Assessment.findById(a._id)) });
}));
manage.delete("/:id/sheet", handle(async (req, res) => {
  const a = await ownedAssessment(req);
  a.sheet = { spreadsheetId: "", url: "", tab: SHEET_TAB, mode: "", sharedWith: [], lastSyncAt: null, lastError: "" };
  await a.save();
  res.json({ ok: true, sheet: sheetOut(a) }); // the Google Sheet itself is not deleted
}));

// ---- Convert / clear where answers are kept (Assessment page → Google Sheets / Supabase buttons) ----
async function clearSheetData(a) {
  if (!a.sheet?.spreadsheetId || !sheetsConfigured()) return 0;
  await serial(a.sheet.spreadsheetId, () => rewriteAll(a.sheet.spreadsheetId, a.sheet.tab || SHEET_TAB, sheetHeaders(a), []));
  await sheetResult(a._id, true);
  return 1;
}
// Empties Supabase for one assessment: the response backup (assessments/<id>/responses) AND every file the
// students handed in (assessments/<id>/<studentId>/…). The teacher's own question material (assessments/<id>/material)
// is kept, otherwise the assessment itself would break. The matching file entries are also removed from the
// submissions so nobody is left with a broken download link; the written answers stay in the database.
async function clearSupabaseData(a) {
  if (!sb.ready()) return 0;
  const base = `assessments/${String(a._id)}`;
  const all = await sb.listTree(base);
  const files = all.filter((f) => !f.path.startsWith(`${base}/material/`));
  await sb.remove(files.map((f) => f.path));
  await Submission.updateMany(
    { assessmentId: a._id },
    { $pull: { "answers.$[].files": { $or: [{ storage: "supabase" }, { path: { $nin: ["", null] } }] } } }
  ).catch((e) => console.error("[assessments] could not drop cleared file entries:", e.message));
  await Assessment.updateOne({ _id: a._id }, { $set: { "backup.count": 0, "backup.lastError": "" } });
  return files.length;
}
// body: { to: "sheet" | "supabase", clearOld?: boolean }
manage.post("/:id/storage", handle(async (req, res) => {
  const a = await ownedAssessment(req);
  const to = req.body?.to === "supabase" ? "supabase" : req.body?.to === "sheet" ? "sheet" : "";
  if (!to) throw bad("Choose Google Sheet or Supabase.");
  const clearOld = !!req.body?.clearOld;
  let cleared = 0;
  if (to === "supabase") {
    if (!sb.ready()) throw bad("Supabase isn't set up on the server (SUPABASE_URL / SUPABASE_SECRET_KEY).", 503);
    a.store = "supabase"; a.important = true; await a.save();
    try { await backupAll(a); } catch (e) { await backupResult(a._id, false, e.message); throw bad(e.message, 502); }
    if (clearOld) cleared = await clearSheetData(a).catch((e) => { throw bad(`Moved to Supabase, but the sheet couldn't be cleared: ${e.message}`, 502); });
  } else {
    if (!a.sheet?.spreadsheetId) throw bad("Connect a Google Sheet to this assessment first.");
    if (!sheetsConfigured()) throw bad("Google Sheets isn't set up on the server.", 503);
    a.store = "sheet"; if (clearOld) a.important = false; await a.save();
    try { await syncAll(a); await sheetResult(a._id, true); } catch (e) { await sheetResult(a._id, false, e.message); throw bad(e.message, 502); }
    if (clearOld) cleared = await clearSupabaseData(a);
  }
  res.json({ ok: true, store: to, cleared });
}));
// body: { store: "sheet" | "supabase" } — empties that store for EVERY assessment this account may manage
// (admin: all, or one department; department editor: their own department). Answers stay in the database.
manage.post("/storage/clear-all", handle(async (req, res) => {
  const store = req.body?.store;
  if (store !== "sheet" && store !== "supabase") throw bad("Choose Google Sheet or Supabase.");
  if (store === "supabase" && !sb.ready()) throw bad("Supabase isn't set up on the server.", 503);
  if (store === "sheet" && !sheetsConfigured()) throw bad("Google Sheets isn't set up on the server.", 503);
  const q = req.isAdmin ? {} : { department: req.editorDept };
  const list = await Assessment.find(q);
  let cleared = 0, touched = 0;
  const failed = [];
  for (const a of list) {
    try {
      if (store === "sheet" && !a.sheet?.spreadsheetId) continue;
      cleared += store === "sheet" ? await clearSheetData(a) : await clearSupabaseData(a);
      touched += 1;
    } catch (e) { failed.push(`${a.title}: ${e.message}`); }
  }
  res.json({ ok: true, store, cleared, assessments: touched, failed });
}));
// body: { store: "sheet" | "supabase" } — empties that store (the answers stay in the database).
manage.post("/:id/storage/clear", handle(async (req, res) => {
  const a = await ownedAssessment(req);
  const store = req.body?.store;
  let cleared = 0;
  if (store === "sheet") {
    if (!a.sheet?.spreadsheetId) throw bad("No Google Sheet is connected to this assessment.");
    cleared = await clearSheetData(a);
  } else if (store === "supabase") {
    if (!sb.ready()) throw bad("Supabase isn't set up on the server.", 503);
    cleared = await clearSupabaseData(a);
  } else throw bad("Choose Google Sheet or Supabase.");
  res.json({ ok: true, store, cleared });
}));

// Task-wise view: one assessment, every student.
manage.get("/:id/responses", handle(async (req, res) => {
  const a = await ownedAssessment(req);
  if (!studentDbReady()) throw bad("The student database is not available right now.", 503);
  const students = await StudentAccount.find(audience(a)).sort({ year: 1, name: 1 }).select("name email department year");
  const subs = await Submission.find({ assessmentId: a._id });
  const by = Object.fromEntries(subs.map((s) => [String(s.studentId), s]));
  const seen = new Set();
  const rows = students.map((st) => {
    seen.add(String(st._id));
    const s = by[String(st._id)];
    const out = s ? submissionOut(s, a, { forStaff: true }) : null;
    return {
      studentId: String(st._id), name: st.name, email: st.email, year: st.year, department: st.department,
      status: statusOf(s), submissionId: s ? String(s._id) : null, submittedAt: s?.submittedAt || null, late: !!s?.late,
      score: out?.score ?? null, needsReview: out?.needsReview || false
    };
  });
  // Students who answered but whose account moved / changed class still show up.
  for (const s of subs) if (!seen.has(String(s.studentId))) {
    const out = submissionOut(s, a, { forStaff: true });
    rows.push({ studentId: String(s.studentId), name: s.studentName, email: s.studentEmail, year: s.year, department: s.department, status: statusOf(s), submissionId: String(s._id), submittedAt: s.submittedAt, late: s.late, score: out.score, needsReview: out.needsReview });
  }
  const done = rows.filter((r) => r.status === "submitted" || r.status === "graded");
  const scored = rows.filter((r) => r.status !== "not_started" && r.status !== "draft" && typeof r.score === "number");
  res.json({
    assessment: staffAssessment(a), rows,
    stats: {
      eligible: rows.length, submitted: done.length, graded: rows.filter((r) => r.status === "graded").length,
      pending: rows.filter((r) => r.status === "submitted").length, notStarted: rows.filter((r) => r.status === "not_started").length,
      average: scored.length ? Math.round((scored.reduce((n, r) => n + r.score, 0) / scored.length) * 100) / 100 : null
    }
  });
}));

router.use("/manage", manage);

// ============================================================ STUDENT
async function studentGate(req, res, next) {
  try {
    if (req.userKind !== "student") return res.status(403).json({ error: "Student accounts only." });
    const me = await loadAccount(req);
    if (!me) return res.status(401).json({ error: "Not authenticated" });
    req.me = me;
    next();
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}
const mine = express.Router();
mine.use(studentGate);

const isLate = (a) => !!a.dueAt && Date.now() > new Date(a.dueAt).getTime();
// Can the student still change their answers / files?
// After a student hands in, they can change their answers for 6 hours only (counted from the first hand-in).
const EDIT_WINDOW_MS = 6 * 60 * 60 * 1000;
function editState(a, s) {
  if (s?.graded) return { canEdit: false, why: "This has been graded." };
  if (isLate(a) && !a.allowLate) return { canEdit: false, why: "The due date has passed." };
  if (s?.status === "submitted" && !a.allowResubmit) return { canEdit: false, why: "Already submitted." };
  if (s?.status === "submitted") {
    const first = s.firstSubmittedAt || s.submittedAt;
    if (first) {
      const until = new Date(new Date(first).getTime() + EDIT_WINDOW_MS);
      if (Date.now() > until.getTime()) return { canEdit: false, why: "Editing closed 6 hours after you submitted.", editUntil: until };
      return { canEdit: true, why: "", editUntil: until };
    }
  }
  return { canEdit: true, why: "" };
}

async function visibleAssessment(req) {
  if (!isId(req.params.id)) throw bad("Not found", 404);
  const a = await Assessment.findById(req.params.id);
  if (!a || a.status !== "published" || !forStudent(a, req.me)) throw bad("Not found", 404);
  return a;
}

mine.get("/", handle(async (req, res) => {
  const dept = deptOfStudent(req.me);
  const list = await Assessment.find({ department: dept, status: "published", $or: [{ year: "" }, { year: String(req.me.year) }] }).sort({ dueAt: 1, createdAt: -1 });
  const subs = await Submission.find({ studentId: req.me._id, assessmentId: { $in: list.map((a) => a._id) } });
  const by = Object.fromEntries(subs.map((s) => [String(s.assessmentId), s]));
  res.json({
    assessments: list.map((a) => {
      const s = by[String(a._id)];
      const out = s ? submissionOut(s, a) : null;
      return {
        id: String(a._id), title: a.title, subject: a.subject, description: a.description.slice(0, 240), dueAt: a.dueAt,
        points: totalPoints(a), blocks: a.blocks.length, types: [...new Set(a.blocks.map((b) => b.type))],
        status: statusOf(s), submittedAt: s?.submittedAt || null, late: !!s?.late, score: out?.score ?? null,
        overdue: isLate(a) && !s?.status, ...editState(a, s)
      };
    })
  });
}));

// Everything this student has started or handed in, newest first (History page).
mine.get("/history", handle(async (req, res) => {
  const subs = await Submission.find({ studentId: req.me._id }).sort({ updatedAt: -1 });
  const list = await Assessment.find({ _id: { $in: subs.map((s) => s.assessmentId) } });
  const byA = Object.fromEntries(list.map((a) => [String(a._id), a]));
  const items = subs.filter((s) => byA[String(s.assessmentId)]).map((s) => {
    const a = byA[String(s.assessmentId)];
    const out = submissionOut(s, a);
    return {
      submissionId: String(s._id), assessmentId: String(a._id), title: a.title, subject: a.subject, dueAt: a.dueAt,
      status: statusOf(s), submittedAt: s.submittedAt, updatedAt: s.updatedAt, createdAt: s.createdAt, late: !!s.late, graded: !!s.graded,
      score: out.score, maxScore: out.maxScore, feedback: out.feedback,
      tasks: a.blocks.length,
      answered: a.blocks.filter((b) => { const x = s.answers.find((y) => y.blockId === b.id); return x && (x.text?.trim() || x.code?.trim() || x.link || x.choice?.length || x.files?.length); }).length,
      files: s.answers.reduce((n, x) => n + (x.files?.length || 0), 0),
      canEdit: editState(a, s).canEdit,
      events: (s.events || []).slice(-15).reverse().map((e) => ({ at: e.at, type: e.type, note: e.note }))
    };
  });
  const graded = items.filter((i) => i.graded && i.maxScore > 0 && typeof i.score === "number");
  res.json({
    items,
    summary: {
      total: items.length,
      submitted: items.filter((i) => i.status === "submitted" || i.status === "graded").length,
      graded: items.filter((i) => i.graded).length,
      inProgress: items.filter((i) => i.status === "draft").length,
      late: items.filter((i) => i.late).length,
      averagePercent: graded.length ? Math.round((graded.reduce((n, i) => n + (i.score / i.maxScore) * 100, 0) / graded.length) * 10) / 10 : null
    }
  });
}));

mine.get("/:id", handle(async (req, res) => {
  const a = await visibleAssessment(req);
  const s = await Submission.findOne({ assessmentId: a._id, studentId: req.me._id });
  res.json({
    assessment: {
      id: String(a._id), title: a.title, description: a.description, subject: a.subject, dueAt: a.dueAt, points: totalPoints(a),
      allowLate: a.allowLate, allowResubmit: a.allowResubmit, blocks: a.blocks.map(studentBlock), attachments: attachmentsOut(a, "student")
    },
    submission: submissionOut(s, a),
    status: statusOf(s), ...editState(a, s),
    storage: storageReady(), runner: runnerReady(), languages: Object.entries(LANGS).map(([k, v]) => ({ key: k, label: v.label }))
  });
}));

async function mySubmission(a, me) {
  let s = await Submission.findOne({ assessmentId: a._id, studentId: me._id });
  if (!s) {
    s = new Submission({
      assessmentId: a._id, studentId: me._id, studentName: me.name, studentEmail: me.email,
      department: deptOfStudent(me) || "", year: String(me.year || ""), answers: []
    });
  }
  return s;
}
const answerFor = (s, blockId) => {
  let ans = s.answers.find((x) => x.blockId === blockId);
  if (!ans) { s.answers.push({ blockId }); ans = s.answers[s.answers.length - 1]; }
  return ans;
};

// Save answers (draft) or hand them in.
mine.put("/:id/submission", handle(async (req, res) => {
  const a = await visibleAssessment(req);
  const s = await mySubmission(a, req.me);
  const st = editState(a, s);
  if (!st.canEdit) throw bad(st.why, 403);
  const submit = !!req.body?.submit;
  const wasSubmitted = s.status === "submitted";
  if (!submit && s.status === "submitted") throw bad("You've already submitted — use “Update submission” to change your answers.", 409);

  const given = Array.isArray(req.body?.answers) ? req.body.answers : [];
  for (const g of given) {
    const b = blockOf(a, String(g.blockId));
    if (!b) continue;
    const ans = answerFor(s, b.id);
    if (b.type === "text") ans.text = String(g.text ?? "").slice(0, 20000);
    if (["number", "date", "email", "phone"].includes(b.type)) ans.text = cleanShort(b, g.text);
    if (b.type === "link") {
      const link = str(g.link, 600);
      if (link && !/^https?:\/\/\S+$/i.test(link)) throw bad("Links must start with http:// or https://");
      ans.link = link;
    }
    if (b.type === "mcq") {
      const ids = new Set(b.options.map((o) => o.id));
      ans.choice = (Array.isArray(g.choice) ? g.choice : []).map(String).filter((c) => ids.has(c)).slice(0, b.multiple ? 10 : 1);
    }
    if (b.type === "code") {
      ans.code = String(g.code ?? "").slice(0, 60000);
      ans.language = b.languages.includes(g.language) ? g.language : b.languages[0];
    }
  }

  if (submit) {
    for (const b of a.blocks) {
      if (!b.required) continue;
      const ans = s.answers.find((x) => x.blockId === b.id);
      const empty = !ans || (TEXTY.includes(b.type) && !ans.text.trim()) || (b.type === "link" && !ans.link) ||
        (b.type === "mcq" && !ans.choice.length) || (b.type === "code" && !ans.code.trim()) || (b.type === "file" && !ans.files.length);
      if (empty) throw bad(`Please answer: “${b.prompt.slice(0, 60)}”`);
    }
    // Run the code answers against ALL test cases (hidden ones too).
    for (const b of a.blocks.filter((x) => x.type === "code")) {
      const ans = s.answers.find((x) => x.blockId === b.id);
      if (!ans?.code?.trim()) continue;
      if (!runnerReady() || !b.testCases?.length) { ans.run = b.testCases?.length ? { error: "Automatic checking isn't available — your teacher will mark this." } : null; continue; }
      try {
        ans.run = await runTests({ language: ans.language, code: ans.code, testCases: b.testCases, timeLimitMs: b.timeLimitMs });
      } catch (e) { ans.run = { error: e.message }; }
    }
    autoScore(a, s);
    if (!s.firstSubmittedAt) s.firstSubmittedAt = s.submittedAt || new Date();
    s.status = "submitted"; s.submittedAt = new Date(); s.late = isLate(a);
    pushEvent(s, wasSubmitted ? "updated" : "submitted", s.late ? "Handed in after the due date" : "");
  } else {
    pushEvent(s, "draft_saved");
  }
  s.markModified("answers");
  await s.save();
  if (submit) syncSubmission(a._id, s._id);
  res.json({ ok: true, submission: submissionOut(s, a), status: statusOf(s), ...editState(a, s) });
}));

// "Run" button: try the code against the sample (visible) test cases.
const runHits = new Map();
mine.post("/:id/run", handle(async (req, res) => {
  const a = await visibleAssessment(req);
  const s = await Submission.findOne({ assessmentId: a._id, studentId: req.me._id });
  if (!editState(a, s).canEdit) throw bad("This assessment is closed.", 403);
  const b = blockOf(a, String(req.body?.blockId));
  if (!b || b.type !== "code") throw bad("Not a code task.");
  const language = b.languages.includes(req.body?.language) ? req.body.language : null;
  if (!language) throw bad("Choose one of the allowed languages.");
  const code = String(req.body?.code ?? "").slice(0, 60000);
  if (!code.trim()) throw bad("Write some code first.");
  const key = String(req.me._id), now = Date.now();
  const recent = (runHits.get(key) || []).filter((t) => now - t < 60000);
  if (recent.length >= 15) throw bad("Slow down — you can run your code up to 15 times a minute.", 429);
  recent.push(now); runHits.set(key, recent);
  if (!runnerReady()) throw bad("Running code isn't set up on this server yet. You can still submit — your teacher will mark it.", 503);
  const visible = b.testCases.filter((t) => !t.hidden);
  const customInput = typeof req.body?.stdin === "string" ? req.body.stdin.slice(0, 5000) : null;
  const tests = customInput != null && !visible.length ? [{ id: "custom", input: customInput, expected: "", points: 0 }] : visible;
  const result = await runTests({ language, code, testCases: tests, timeLimitMs: b.timeLimitMs, onlyVisible: true });
  res.json({ result, hiddenCount: b.testCases.length - visible.length });
}));

// Student uploads: add / replace / delete. Every file goes to Drive, into THIS student's own
// folder inside the assessment's folder. Several files can arrive at the same moment (drag &
// drop), so each one is stored first and then added to a freshly loaded submission, one at a time.
const myFileHref = (a) => (r) => `/mine/${a._id}/files/${r.id}/content`;
const subKey = (a, me) => `sub:${a._id}:${me._id}`;

mine.post("/:id/files", handle(async (req, res) => {
  const a = await visibleAssessment(req);
  const s0 = await mySubmission(a, req.me);
  const st = editState(a, s0); if (!st.canEdit) throw bad(st.why, 403);
  const file = await takeFile(req, res);
  const b = blockOf(a, String(req.body?.blockId || req.query.blockId));
  if (!b || b.type !== "file") throw bad("This task doesn't take file uploads.");
  if (answerFor(s0, b.id).files.length >= b.maxFiles) throw bad(`You can upload at most ${b.maxFiles} file${b.maxFiles > 1 ? "s" : ""} here — delete one first.`);
  if (file.size > b.maxSizeMB * 1024 * 1024) throw bad(`Files for this task can be at most ${b.maxSizeMB} MB.`, 413);
  const ok = fileAllowed(file, b.accept); if (!ok.ok) throw bad(ok.why);
  const { folder, ...rec } = await storeFile(file, { assessment: a, kind: "answer", student: req.me });
  let submitted = false, sid = null;
  try {
    await serial(subKey(a, req.me), async () => {
      const s = await mySubmission(a, req.me);
      const st2 = editState(a, s); if (!st2.canEdit) throw bad(st2.why, 403);
      const ans = answerFor(s, b.id);
      if (ans.files.length >= b.maxFiles) throw bad(`You can upload at most ${b.maxFiles} file${b.maxFiles > 1 ? "s" : ""} here — delete one first.`);
      ans.files.push(rec);
      if (folder) { s.driveFolderId = folder.id; s.driveFolderUrl = folder.url; }
      pushEvent(s, "file_added", rec.name);
      s.markModified("answers");
      await s.save();
      sid = s._id; submitted = s.status === "submitted";
    });
  } catch (e) { await removeFile(rec).catch(() => {}); throw e; } // don't leave an orphan in Drive
  if (submitted) syncSubmission(a._id, sid);
  res.status(201).json({ file: fileOut(rec, myFileHref(a)) });
}));
mine.put("/:id/files/:fid", handle(async (req, res) => {
  const a = await visibleAssessment(req);
  const s0 = await Submission.findOne({ assessmentId: a._id, studentId: req.me._id });
  if (!s0) throw bad("File not found", 404);
  const st = editState(a, s0); if (!st.canEdit) throw bad(st.why, 403);
  const ans0 = s0.answers.find((x) => x.files.some((f) => f.id === req.params.fid));
  if (!ans0) throw bad("File not found", 404);
  const b = blockOf(a, ans0.blockId);
  const file = await takeFile(req, res);
  if (file.size > b.maxSizeMB * 1024 * 1024) throw bad(`Files for this task can be at most ${b.maxSizeMB} MB.`, 413);
  const ok = fileAllowed(file, b.accept); if (!ok.ok) throw bad(ok.why);
  const { folder, ...rec } = await storeFile(file, { assessment: a, kind: "answer", student: req.me });
  let old = null, sid = null, submitted = false;
  try {
    await serial(subKey(a, req.me), async () => {
      const s = await Submission.findOne({ assessmentId: a._id, studentId: req.me._id });
      if (!s) throw bad("File not found", 404);
      const st2 = editState(a, s); if (!st2.canEdit) throw bad(st2.why, 403);
      const ans = s.answers.find((x) => x.files.some((f) => f.id === req.params.fid));
      if (!ans) throw bad("File not found", 404);
      const i = ans.files.findIndex((f) => f.id === req.params.fid);
      old = ans.files[i].toObject();
      ans.files.set(i, rec);
      if (folder) { s.driveFolderId = folder.id; s.driveFolderUrl = folder.url; }
      pushEvent(s, "file_replaced", `${old.name} → ${rec.name}`);
      s.markModified("answers"); await s.save();
      sid = s._id; submitted = s.status === "submitted";
    });
  } catch (e) { await removeFile(rec).catch(() => {}); throw e; }
  await removeFile(old);
  if (submitted) syncSubmission(a._id, sid);
  res.json({ file: fileOut(rec, myFileHref(a)) });
}));
mine.delete("/:id/files/:fid", handle(async (req, res) => {
  const a = await visibleAssessment(req);
  let gone = null, sid = null, submitted = false;
  await serial(subKey(a, req.me), async () => {
    const s = await Submission.findOne({ assessmentId: a._id, studentId: req.me._id });
    if (!s) throw bad("File not found", 404);
    const st = editState(a, s); if (!st.canEdit) throw bad(st.why, 403);
    for (const ans of s.answers) {
      const i = ans.files.findIndex((f) => f.id === req.params.fid);
      if (i >= 0) { [gone] = ans.files.splice(i, 1); break; }
    }
    if (!gone) throw bad("File not found", 404);
    pushEvent(s, "file_removed", gone.name);
    s.markModified("answers"); await s.save();
    sid = s._id; submitted = s.status === "submitted";
  });
  await removeFile(gone);
  if (submitted) syncSubmission(a._id, sid);
  res.json({ ok: true });
}));

// Reading a file: a student can open only their OWN uploads and the teacher's material for an
// assessment they're allowed to see. Anything else is a 404.
mine.get("/:id/files/:fid/content", handle(async (req, res) => {
  const a = await visibleAssessment(req);
  const s = await Submission.findOne({ assessmentId: a._id, studentId: req.me._id });
  await sendStored(res, findAnswerFile(s, req.params.fid), req.query.download === "1");
}));
mine.get("/:id/attachments/:fid/content", handle(async (req, res) => {
  const a = await visibleAssessment(req);
  await sendStored(res, (a.attachments || []).find((f) => f.id === req.params.fid), req.query.download === "1");
}));

router.use("/mine", mine);
export default router;
