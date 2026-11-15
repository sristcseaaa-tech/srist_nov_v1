import express from "express";
import requireAuth from "../middleware/requireAuth.js";
import { loadAccount } from "../utils/accounts.js";
import isAdminEmail from "../utils/isAdminEmail.js";
import DEPARTMENTS from "../utils/departments.js";
import * as sb from "../utils/supabase.js";

import { isDeptRole } from "../utils/roles.js";
// File storage endpoints (Supabase Storage).
//
//   GET  /api/files/config      what the browser needs to know (limits, allowed types, ready?)
//   POST /api/files/sign        { section, sub?, name, size, mime? } -> one-time signed upload URL + ticket.
//                               The browser then uploads the file STRAIGHT to Supabase (big files never pass
//                               through this server) and sends { name, ticket } to the normal save route.
//   GET  /api/files/dl/:token   a short-lived signed download link issued by the server (see supabase.linkFor)
const router = express.Router();

const handle = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    if (res.headersSent) return res.destroy();
    if (!e.status) console.error("[files]", e);
    res.status(e.status || 500).json({ error: e.status ? e.message : "File storage error" });
  }
};
const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });

router.get("/config", (req, res) => {
  const d = sb.describe();
  res.json({
    ready: d.ready, maxMB: d.maxMB,
    sections: Object.keys(sb.SECTIONS),
    groups: sb.GROUPS
  });
});

// Which roles does this account have?
function rolesOf(me, kind) {
  const r = new Set();
  if (kind === "student" || me.role === "student") { r.add("student"); return r; }
  if (me.role === "admin" || isAdminEmail(me.email)) r.add("admin");
  if (me.role === "exam_role") r.add("exam");
  else r.add("staff");
  if (isDeptRole(me.role)) r.add("editor");
  return r;
}

router.post("/sign", requireAuth, handle(async (req, res) => {
  const b = req.body || {};
  const section = String(b.section || "");
  if (!sb.sectionKnown(section)) throw bad("Unknown file section.");
  const me = await loadAccount(req);
  if (!me) throw bad("Not authenticated", 401);
  const roles = rolesOf(me, req.userKind);
  const allowed = roles.has("admin") || sb.SECTIONS[section].who.some((w) => roles.has(w));
  if (!allowed) throw bad("You don't have permission to upload files here.", 403);

  // a few sections are split per department / year — the sub-folder must be valid and the person must be allowed in it
  let sub = [];
  const rawSub = String(b.sub || "").toLowerCase().trim();
  if (section === "student-resources") {
    if (!DEPARTMENTS.includes(rawSub)) throw bad("Choose a department first.");
    if (!roles.has("admin") && !(roles.has("editor") && me.editorDept === rawSub)) throw bad("You can't upload files for that department.", 403);
    sub = [rawSub];
  } else if (section === "exam-cell") {
    if (!["1", "2", "3"].includes(rawSub)) throw bad("Unknown exam cell year.");
    sub = [`year-${rawSub}`];
  } else if (section === "discussion") {
    sub = [rawSub && DEPARTMENTS.includes(rawSub) ? rawSub : "general"];
  } else if (section === "admin-uploads") {
    // "<role>:<section>" -> admin-uploads/<role>/<section>/…
    sub = rawSub.split(":").map((x) => x.replace(/[^a-z0-9_-]/g, "").slice(0, 40)).filter(Boolean).slice(0, 2);
  } else if (section === "assessments" || section === "task-center" || section === "site-content") {
    sub = rawSub ? [rawSub.replace(/[^a-z0-9_-]/g, "").slice(0, 40)].filter(Boolean) : [];
  }

  const exts = Array.isArray(b.exts) ? b.exts.map((e) => String(e).toLowerCase().replace(/^\./, "")).filter(Boolean).slice(0, 20) : undefined;
  const out = await sb.createUpload({ section, sub, name: b.name, size: b.size, mime: b.mime, uid: req.userId, exts });
  res.json(out);
}));

// Signed download link (issued by the server, short-lived). No login token needed — the link itself is the permission.
router.get("/dl/:token", handle(async (req, res) => {
  const f = sb.readLink(req.params.token);
  if (!f) throw bad("This link has expired. Please open the page again.", 410);
  await sb.stream(res, f.path, { name: f.name, mime: f.mime, download: req.query.inline !== "1" });
}));

export default router;
