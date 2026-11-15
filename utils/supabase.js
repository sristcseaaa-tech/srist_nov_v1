import crypto from "crypto";
import { Readable } from "stream";
import jwt from "jsonwebtoken";
import { createClient } from "@supabase/supabase-js";

// ============================================================================
// ONE place that talks to Supabase Storage.
//
// Every DOCUMENT / big file of the website lives here — never in MongoDB, never in Cloudinary:
//   Documents    PDF, DOC, DOCX, TXT, RTF, ODT, PPT, PPTX …
//   Archives     ZIP, 7Z, RAR
//   Spreadsheets XLS, XLSX, CSV, ODS
//   Other        JSON, XML, source-code files (c, cpp, py, java, js, sql, ipynb …)
// (Pictures — photos, banners, logos — stay on Cloudinary; see utils/media.js.)
//
// Layout: ONE private bucket, one top-level folder per website SECTION:
//
//   <bucket>/navigation/…          Resources menu files
//   <bucket>/resources/…           /resources page documents
//   <bucket>/home-resources/…      files uploaded for the Home page "Resources" section
//   <bucket>/site-content/<section>/…   PDF / PPT / DOC / XLS attached to a Customize section
//   <bucket>/admin-uploads/<role>/<section>/…   Admin → Storage page (files filed by role type + section / page)
//   <bucket>/admission-notices/…   /apply notice downloads
//   <bucket>/newsletters/…         newsletter PDFs
//   <bucket>/placement-reports/…   placement report PDFs
//   <bucket>/exam-cell/<year>/…    exam cell notice files
//   <bucket>/task-center/…         staff task attachments
//   <bucket>/discussion/<dept>/…   student ↔ faculty discussion files
//   <bucket>/student-resources/<dept>/…   notes, routines, grade cards …
//   <bucket>/assessments/<id>/…    assessment material + student answers
//
// When a file is uploaded the server first works out WHICH section it belongs to and makes sure
// that section's base folder exists in the bucket (created on first use), then stores the file
// inside it as  <section>/<sub>/<yyyy-mm>/<random>_<safe-name>.
//
// MongoDB keeps ONLY the object path + metadata (name, size, type). Bytes never touch it.
//
// Two ways in (both end up in the same bucket):
//   1. DIRECT (big files): the browser asks POST /api/files/sign, gets a one-time signed upload
//      URL and a ticket, uploads straight to Supabase (the API server is not in the data path),
//      then sends { name, ticket } to the normal save route. See client/src/fileUpload.js.
//   2. SERVER: a route receives a base64 data URL / multer buffer and calls putBuffer().
//
// The bucket is PRIVATE. Files are handed out only by routes that already checked who may see
// them (they stream through the server) or through short-lived signed links (linkFor).
// Credentials come only from the environment — never from code, never into an API response.
// ============================================================================

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// ---------------------------------------------------------------- configuration
const clean = (v) => String(v || "").trim();
export const bucketName = () => clean(process.env.SUPABASE_BUCKET) || "srist-files";
const baseUrl = () => clean(process.env.SUPABASE_URL).replace(/\/+$/, "");
const secretKey = () => clean(process.env.SUPABASE_SECRET_KEY) || clean(process.env.SUPABASE_SERVICE_ROLE_KEY);
export const publishableKey = () => clean(process.env.SUPABASE_PUBLISHABLE_KEY) || clean(process.env.SUPABASE_ANON_KEY);
export const supabaseUrl = baseUrl;
export const ready = () => !!baseUrl() && !!secretKey() && !/[<>]/.test(baseUrl() + secretKey());
export const maxFileBytes = () => Math.max(1, Number(process.env.FILE_MAX_MB) || 50) * 1024 * 1024; // Supabase free plan allows 50 MB per file
export const describe = () => ({ ready: ready(), project: ready() ? new URL(baseUrl()).hostname.split(".")[0] : "NOT CONFIGURED", bucket: bucketName(), maxMB: Math.round(maxFileBytes() / 1048576) });

let _client = null, _clientKey = "";
function db() {
  if (!ready()) throw fail("File storage is not configured on the server (SUPABASE_URL / SUPABASE_SECRET_KEY are missing — see server/.env.example).", 503);
  const key = baseUrl() + secretKey();
  if (!_client || _clientKey !== key) {
    _client = createClient(baseUrl(), secretKey(), { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    _clientKey = key;
  }
  return _client;
}
const bucket = () => db().storage.from(bucketName());

// ---------------------------------------------------------------- sections
// who: "admin" (always allowed everywhere) | "exam" (exam_role) | "editor" (department editor) | "staff" (any non-student, non-exam account) | "student"
export const SECTIONS = {
  navigation:           { label: "Navigation (Resources menu)", who: ["admin"] },
  resources:            { label: "Resources page",              who: ["admin"] },
  "home-resources":     { label: "Home page resources",         who: ["admin"] },
  "site-content":       { label: "Customize site content files", who: ["admin"] },
  "admin-uploads":      { label: "Admin storage (by role type / section / page)", who: ["admin"] },
  "admission-notices":  { label: "Admission notices",           who: ["admin"] },
  newsletters:          { label: "Newsletters",                 who: ["admin"] },
  "placement-reports":  { label: "Placement reports",           who: ["admin"] },
  "exam-cell":          { label: "Exam Cell",                   who: ["exam"] },
  "task-center":        { label: "Task Center",                 who: ["staff", "exam"] },
  discussion:           { label: "Student discussion",          who: ["staff", "student"] },
  "student-resources":  { label: "Student portal resources",    who: ["editor"] },
  assessments:          { label: "Assessments",                 who: ["staff", "student"] }
};
export const sectionKnown = (s) => Object.prototype.hasOwnProperty.call(SECTIONS, s);

// ---------------------------------------------------------------- file types
export const GROUPS = {
  documents:    ["pdf", "doc", "docx", "txt", "rtf", "odt", "ppt", "pptx", "odp", "md"],
  archives:     ["zip", "7z", "rar"],
  spreadsheets: ["xls", "xlsx", "csv", "ods", "tsv"],
  other:        ["json", "xml", "yaml", "yml", "sql", "ipynb", "c", "cpp", "cc", "h", "hpp", "cs", "java", "py", "js", "jsx", "ts", "tsx", "php", "go", "rs", "rb", "kt", "swift", "css", "r", "m", "asm", "vhd", "v"],
  pictures:     ["jpg", "jpeg", "png", "webp", "gif", "bmp"]
};
export const ALLOWED_EXT = new Set(Object.values(GROUPS).flat());
// EVERY file type is accepted and stored in Supabase. Safety comes from how files are served: only pdf / pictures
// are ever shown inside the browser; everything else (exe, html, svg, sh …) is forced to download, with
// "nosniff" and a sandbox CSP, so a stored file can never run on the site.
const BLOCKED_EXT = new Set();
export const extOf = (name) => (String(name || "").toLowerCase().match(/\.([a-z0-9]{1,8})$/) || [])[1] || "";

const MIME = {
  pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet", odp: "application/vnd.oasis.opendocument.presentation",
  txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8", tsv: "text/tab-separated-values; charset=utf-8",
  rtf: "application/rtf", json: "application/json", xml: "application/xml", zip: "application/zip", rar: "application/vnd.rar", "7z": "application/x-7z-compressed",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", bmp: "image/bmp"
};
export const mimeFor = (name, fallback = "application/octet-stream") => MIME[extOf(name)] || (GROUPS.other.includes(extOf(name)) ? "text/plain; charset=utf-8" : fallback);
const INLINE = new Set(["pdf", "jpg", "jpeg", "png", "webp", "gif", "bmp"]); // everything else downloads
export const canInline = (name) => INLINE.has(extOf(name));

const TEXTLIKE = new Set([...GROUPS.other, "txt", "md", "csv", "tsv", "json", "xml", "rtf"]);
function magicOk(ext, head) {
  const hex = head.toString("hex");
  if (ext === "pdf") return head.subarray(0, 5).toString("latin1") === "%PDF-";
  if (["docx", "xlsx", "pptx", "odt", "ods", "odp", "zip"].includes(ext)) return hex.startsWith("504b0304") || hex.startsWith("504b0506");
  if (["doc", "xls", "ppt"].includes(ext)) return hex.startsWith("d0cf11e0a1b11ae1");
  if (ext === "rar") return head.subarray(0, 4).toString("latin1") === "Rar!";
  if (ext === "7z") return hex.startsWith("377abcaf271c");
  if (ext === "png") return hex.startsWith("89504e470d0a1a0a");
  if (ext === "jpg" || ext === "jpeg") return hex.startsWith("ffd8ff");
  if (ext === "gif") return /^GIF8[79]a$/.test(head.subarray(0, 6).toString("latin1"));
  if (ext === "webp") return head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP";
  if (ext === "bmp") return head.subarray(0, 2).toString("latin1") === "BM";
  if (TEXTLIKE.has(ext)) return !head.includes(0); // text must not contain NUL bytes
  return true;
}

// Checks name + (optional) allowed list. `exts` narrows it further (e.g. ["pdf"] for newsletters).
export function checkName(name, exts) {
  const ext = extOf(name);
  if (BLOCKED_EXT.has(ext)) throw fail(`.${ext} files can't be uploaded.`);
  if (exts?.length && !exts.includes(ext)) throw fail(`Only ${exts.map((e) => e.toUpperCase()).join(", ")} files are accepted here.`);
  return ext;
}
export const safeName = (name) => {
  const n = String(name || "file").normalize("NFKD").replace(/[\\/\r\n"]/g, "_").trim();
  return n.slice(0, 200) || "file";
};
const slug = (s) => String(s || "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
const keyName = (name) => {
  const ext = extOf(name);
  const stem = String(name || "file").replace(/\.[a-z0-9]{1,8}$/i, "");
  return `${slug(stem) || "file"}${ext ? `.${ext}` : ""}`;
};

// <section>/<sub…>/<yyyy-mm>/<random>_<name>  — every part is ASCII-safe for object keys.
export function buildPath(section, sub, name) {
  if (!sectionKnown(section)) throw fail("Unknown file section.");
  const d = new Date();
  const subs = (Array.isArray(sub) ? sub : [sub]).map((s) => slug(s) || String(s || "").replace(/[^A-Za-z0-9_-]/g, "")).filter(Boolean).slice(0, 4);
  return [section, ...subs, `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, `${crypto.randomBytes(8).toString("hex")}_${keyName(name)}`].join("/");
}
export const sectionOfPath = (path) => String(path || "").split("/")[0];

// ---------------------------------------------------------------- bucket + section folders
let _bucketReady = null;
const _sections = new Set();

// Supabase sometimes answers 502/503/504 or times out for a moment (free projects go to sleep and need
// a few seconds to wake up). Those are not real failures, so folder/bucket setup is retried with a
// growing pause instead of giving up on the first error.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transient = (m) => /\b(5\d\d)\b|time-?d? ?out|fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket|network|gateway|temporar|unavailable|paused/i.test(String(m || ""));
async function withRetry(fn, { tries = 5, base = 1000 } = {}) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    try { return await fn(); } catch (e) {
      last = e;
      if (!transient(e?.message) || i === tries - 1) break;
      await sleep(base * 2 ** i); // 1s, 2s, 4s, 8s
    }
  }
  throw last;
}

export function ensureBucket() {
  if (_bucketReady) return _bucketReady;
  _bucketReady = withRetry(async () => {
    const s = db().storage;
    const got = await s.getBucket(bucketName());
    if (got?.data) return true;
    const made = await s.createBucket(bucketName(), { public: false });
    if (made.error && !/already exists|duplicate/i.test(made.error.message || "")) throw fail(`Could not create the storage bucket "${bucketName()}": ${made.error.message}`, 502);
    return true;
  }).catch((e) => { _bucketReady = null; throw e; });
  return _bucketReady;
}

// Finds the section the file belongs to and makes sure its base folder exists (once per process).
// Object storage has no real folders, so the folder is created by a small ".keep" marker.
export async function ensureSection(section) {
  if (!sectionKnown(section)) throw fail("Unknown file section.");
  await ensureBucket();
  if (_sections.has(section)) return section;
  await withRetry(async () => {
    const { error } = await bucket().upload(`${section}/.keep`, Buffer.from(`SRIST · ${SECTIONS[section].label}\n`), { contentType: "text/plain", upsert: true });
    if (error && !/already exists|duplicate/i.test(error.message || "")) throw fail(`Could not prepare the "${section}" folder: ${error.message}`, 502);
  });
  _sections.add(section);
  return section;
}
// Creates every section folder up front (called once at server start).
// One slow folder no longer stops the others, and a failed folder is simply created on the first upload
// into it (ensureSection runs again then), so a temporary Supabase hiccup never blocks the site.
export async function prepareAll() {
  await ensureBucket();
  const names = Object.keys(SECTIONS);
  const results = await Promise.allSettled(names.map((s) => ensureSection(s)));
  const failed = names.filter((_, i) => results[i].status === "rejected");
  if (failed.length) {
    const why = results.find((r) => r.status === "rejected").reason?.message || "unknown error";
    throw fail(`${failed.length} of ${names.length} folders could not be prepared yet (${failed.join(", ")}): ${why}. They will be created automatically on first upload.`, 502);
  }
}

// ---------------------------------------------------------------- references kept in MongoDB
// A reference is just the object path, optionally written "sb:<path>" where a field used to hold a URL.
export const REF = "sb:";
export const refOf = (path) => `${REF}${path}`;
export const isRef = (v) => typeof v === "string" && v.startsWith(REF) && v.length > REF.length;
export const pathOfRef = (v) => (isRef(v) ? v.slice(REF.length) : "");

// ---------------------------------------------------------------- server-side upload
// file: { buffer, name, mime? }  ->  { path, name, mime, size, ext }
export async function putBuffer(file, { section, sub = [], exts, check = true } = {}) {
  const name = safeName(file?.name || file?.originalname);
  const ext = checkName(name, exts);
  const buffer = file?.buffer;
  if (!buffer?.length) throw fail(`“${name}” is empty.`);
  if (buffer.length > maxFileBytes()) throw fail(`“${name}” is too large — the limit is ${Math.round(maxFileBytes() / 1048576)} MB.`, 413);
  if (check && !magicOk(ext, buffer.subarray(0, 64))) throw fail(`“${name}” doesn't look like a real .${ext} file.`);
  await ensureSection(section);
  const path = buildPath(section, sub, name);
  const mime = (file.mime || file.mimetype || "").split(";")[0] || mimeFor(name);
  const { error } = await bucket().upload(path, buffer, { contentType: mime, upsert: false, cacheControl: "3600" });
  if (error) { console.error("[supabase] upload failed:", error.message); throw fail("The file could not be saved to file storage. Please try again.", 502); }
  return { path, name, mime, size: buffer.length, ext };
}

// Writes one JSON document at a FIXED path (overwritten each time) — used for the "important data"
// backup of assessment answers: <section>/<sub…>/<name>.json
export async function putJson(section, sub, name, data) {
  await ensureSection(section);
  const subs = (Array.isArray(sub) ? sub : [sub]).map((x) => String(x || "").replace(/[^A-Za-z0-9_-]/g, "")).filter(Boolean).slice(0, 4);
  const file = `${String(name || "data").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80)}.json`;
  const path = [section, ...subs, file].join("/");
  const body = Buffer.from(JSON.stringify(data, null, 2), "utf8");
  const { error } = await bucket().upload(path, body, { contentType: "application/json", upsert: true, cacheControl: "60" });
  if (error) throw fail(`Supabase could not save the backup: ${error.message}`, 502);
  return { path, bytes: body.length };
}

const DATA_URL = /^data:([^;,]*)(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/;
export const isDataUrl = (v) => typeof v === "string" && v.startsWith("data:");
export function parseDataUrl(s) {
  const m = DATA_URL.exec(String(s || ""));
  if (!m) return null;
  return { mime: m[1] || "application/octet-stream", buffer: Buffer.from(m[2].replace(/\s/g, ""), "base64") };
}

// ---------------------------------------------------------------- direct (browser -> Supabase) upload
// Step 1 (POST /api/files/sign): the server decides the path and hands out a one-time upload URL + ticket.
const ticketSecret = () => `${process.env.JWT_SECRET || ""}:files`;
export async function createUpload({ section, sub = [], name, size, mime, uid, exts }) {
  const fname = safeName(name);
  checkName(fname, exts);
  const bytes = Number(size) || 0;
  if (!bytes) throw fail(`“${fname}” is empty.`);
  if (bytes > maxFileBytes()) throw fail(`“${fname}” is ${(bytes / 1048576).toFixed(1)} MB — the limit is ${Math.round(maxFileBytes() / 1048576)} MB per file.`, 413);
  await ensureSection(section);
  const path = buildPath(section, sub, fname);
  const { data, error } = await bucket().createSignedUploadUrl(path);
  if (error || !data) { console.error("[supabase] sign failed:", error?.message); throw fail("Could not start the upload. Please try again.", 502); }
  const ticket = jwt.sign({ p: path, s: section, n: fname, z: bytes, m: mime || mimeFor(fname), u: String(uid || "") }, ticketSecret(), { expiresIn: "30m" });
  return {
    path, token: data.token, ticket, bucket: bucketName(), name: fname, expiresIn: 1800,
    supabaseUrl: baseUrl(), publishableKey: publishableKey()
  };
}

// Step 2 (the normal save route): turn what the browser sent into a verified stored file.
//   input: { name, ticket }  (direct upload)   or   { name, data: "data:…;base64,…" }  (small / legacy)
//   -> { path, name, mime, size, ext }   — throws if the file isn't really there / isn't what it claims.
export async function claim(input, { section, uid, exts, sub = [] } = {}) {
  if (!input || typeof input !== "object") throw fail("The file could not be read. Please choose it again.");
  if (input.ticket) {
    let t;
    try { t = jwt.verify(String(input.ticket), ticketSecret()); } catch { throw fail("The upload expired. Please choose the file again.", 400); }
    if (t.s !== section) throw fail("That upload belongs to a different section.", 400);
    if (uid && t.u && String(t.u) !== String(uid)) throw fail("That upload belongs to another account.", 403);
    const ext = checkName(t.n, exts);
    const st = await stat(t.p);
    if (!st) throw fail("The file never finished uploading. Please try again.", 400);
    const size = st.size || t.z;
    if (size > maxFileBytes()) { await remove([t.p]); throw fail(`“${t.n}” is too large.`, 413); }
    if (!size) { await remove([t.p]); throw fail(`“${t.n}” is empty.`); }
    const head = await peek(t.p, 64);
    if (!magicOk(ext, head)) { await remove([t.p]); throw fail(`“${t.n}” doesn't look like a real .${ext} file.`); }
    return { path: t.p, name: t.n, mime: (t.m || mimeFor(t.n)).split(";")[0], size, ext };
  }
  if (input.data) {
    const parsed = parseDataUrl(input.data);
    if (!parsed) throw fail("The file could not be read. Please choose it again.");
    return putBuffer({ buffer: parsed.buffer, name: input.name, mime: parsed.mime }, { section, sub, exts });
  }
  throw fail("The file could not be read. Please choose it again.");
}

// ---------------------------------------------------------------- reading / deleting
// { size, mime } of an object, or null if it isn't there.
export async function stat(path) {
  const i = path.lastIndexOf("/");
  const dir = path.slice(0, i), base = path.slice(i + 1);
  const { data, error } = await bucket().list(dir, { limit: 20, search: base });
  if (error) { console.error("[supabase] stat failed:", error.message); return null; }
  const hit = (data || []).find((o) => o.name === base);
  return hit ? { size: Number(hit.metadata?.size) || 0, mime: hit.metadata?.mimetype || "" } : null;
}
export const exists = async (path) => !!(await stat(path));

async function signedUrl(path, seconds = 120) {
  const { data, error } = await bucket().createSignedUrl(path, seconds);
  if (error || !data?.signedUrl) throw fail("File not found", 404);
  return data.signedUrl;
}
// First `n` bytes of an object (for the real-type check).
export async function peek(path, n = 64) {
  const r = await fetch(await signedUrl(path, 60), { headers: { Range: `bytes=0-${n - 1}` } });
  if (!r.ok && r.status !== 206) throw fail("File not found", 404);
  return Buffer.from(await r.arrayBuffer()).subarray(0, n);
}
export async function readBuffer(path) {
  const r = await fetch(await signedUrl(path, 120));
  if (!r.ok) throw fail("File not found", r.status === 404 ? 404 : 502);
  return Buffer.from(await r.arrayBuffer());
}

// Every object in the bucket under `prefix` (recursive, capped) — used by the admin Storage page.
// -> [{ path, size, mime, updatedAt }]   (".keep" folder markers are skipped)
export async function listTree(prefix = "", cap = 5000) {
  await ensureBucket();
  const out = [];
  const walk = async (dir) => {
    for (let offset = 0; out.length < cap; offset += 100) {
      const { data, error } = await bucket().list(dir, { limit: 100, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw fail(`Could not list storage: ${error.message}`, 502);
      if (!data?.length) break;
      for (const o of data) {
        const full = dir ? `${dir}/${o.name}` : o.name;
        if (!o.id) await walk(full); // a folder
        else if (o.name !== ".keep") out.push({ path: full, size: Number(o.metadata?.size) || 0, mime: o.metadata?.mimetype || "", updatedAt: o.updated_at || o.created_at || null });
      }
      if (data.length < 100) break;
    }
  };
  await walk(String(prefix || "").replace(/^\/+|\/+$/g, ""));
  return out.slice(0, cap);
}

// Best effort — a file that's already gone is not an error. Accepts paths, "sb:" refs or a mix.
export async function remove(list) {
  const paths = [...new Set((Array.isArray(list) ? list : [list]).map((v) => (isRef(v) ? pathOfRef(v) : v)).filter((p) => typeof p === "string" && p && !p.endsWith("/.keep")))];
  if (!paths.length || !ready()) return;
  try {
    const { error } = await bucket().remove(paths);
    if (error) console.error("[supabase] could not delete", paths.join(", "), "-", error.message);
  } catch (e) { console.error("[supabase] could not delete", paths.join(", "), "-", e.message); }
}

// Streams one stored file to a response of a request the route has ALREADY authorised.
// opts: { name, mime, download }  — pdf / pictures open in the tab, everything else downloads.
export async function stream(res, path, { name, mime, download = false } = {}) {
  const r = await fetch(await signedUrl(path, 120));
  if (!r.ok || !r.body) throw fail("File not found", r.status === 404 || r.status === 400 ? 404 : 502);
  const fname = safeName(name || path.split("/").pop());
  const type = (mime && mime !== "application/octet-stream" ? mime : "") || mimeFor(fname, r.headers.get("content-type") || "application/octet-stream");
  const inline = !download && canInline(fname);
  res.setHeader("Content-Type", type);
  const len = r.headers.get("content-length"); if (len) res.setHeader("Content-Length", len);
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${fname.replace(/[^\w.\- ]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
  res.setHeader("Cache-Control", "private, no-store");
  await new Promise((resolve, reject) => {
    const src = Readable.fromWeb(r.body);
    src.on("error", reject);
    res.on("close", resolve);
    src.on("end", resolve);
    src.pipe(res);
  });
}

// A short-lived link a BROWSER can open without sending a token (for places that hand the record
// to the page with the file address inside it). Opens GET /api/files/dl/:token. Hand it out only to
// people the route already admitted.
const publicBase = () => clean(process.env.PUBLIC_API_URL || process.env.RENDER_EXTERNAL_URL).replace(/\/+$/, "").replace(/\/api$/, "");
export function linkFor(path, { name, mime, ttl = 3600 } = {}) {
  if (!path) return "";
  const token = jwt.sign({ p: path, n: safeName(name || path.split("/").pop()), m: mime || "", k: "dl" }, ticketSecret(), { expiresIn: ttl });
  return `${publicBase()}/api/files/dl/${token}`;
}
// A record that was sent to the browser (with signed links) and is sent back unchanged on an edit:
// turn "<api>/api/files/dl/<token>" back into the "sb:<path>" reference. The signature proves the link is ours.
export function refFromLink(v) {
  const m = /\/api\/files\/dl\/([\w-]+\.[\w-]+\.[\w-]+)(?:[?#].*)?$/.exec(String(v || ""));
  if (!m) return "";
  try { const t = jwt.verify(m[1], ticketSecret(), { ignoreExpiration: true }); return t.k === "dl" && t.p ? refOf(t.p) : ""; } catch { return ""; }
}
export function readLink(token) {
  try { const t = jwt.verify(String(token), ticketSecret()); return t.k === "dl" ? { path: t.p, name: t.n, mime: t.m } : null; } catch { return null; }
}
