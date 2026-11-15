// Shared upload / URL validation for Navigation + Resources.
// Files go to SUPABASE STORAGE (never MongoDB). They arrive from the browser in one of two ways:
//   { name, ticket }  — big files: the browser already uploaded straight to Supabase (POST /api/files/sign)
//   { name, data }    — small files as a base64 data URL; the server stores the bytes in Supabase
// Either way the file is checked on the SERVER (extension allow-list, size limit, magic bytes)
// and MongoDB keeps only its name / type / size / storage path.
import * as sb from "./supabase.js";

export const MAX_FILE_BYTES = sb.maxFileBytes();
export const ALLOWED_EXT = [...sb.ALLOWED_EXT];

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export const str = (v, max) => String(v ?? "").trim().slice(0, max);

// Reads an uploaded file object and stores it in the section's Supabase folder.
// Records what to clean up on the document ($locals) — see withFileCleanup().
//   section: "navigation" | "resources" | …      doc must have fileName / fileType / fileSize / filePath / fileData
export async function applyFile(doc, file, { section, sub = [], uid, exts } = {}) {
  doc.$locals = doc.$locals || {};
  if (file === null) {                                   // remove
    if (doc.filePath) doc.$locals.oldPath = doc.filePath;
    doc.fileName = ""; doc.fileType = ""; doc.fileSize = 0; doc.filePath = ""; doc.fileData = "";
    return;
  }
  if (!file || typeof file !== "object") return;
  if (!file.ticket && !file.data) return;                // nothing new (the page sent the old file info back)
  const rec = await sb.claim(file, { section, sub, uid, exts });
  doc.$locals.newPath = rec.path;
  if (doc.filePath) doc.$locals.oldPath = doc.filePath;
  doc.fileName = rec.name; doc.fileType = rec.mime; doc.fileSize = rec.size; doc.filePath = rec.path;
  doc.fileData = "";                                     // legacy MongoDB bytes are dropped on replace
}

// Runs a save; if it fails the freshly uploaded file is deleted again, if it works the replaced one is.
export async function withFileCleanup(doc, run) {
  try {
    const out = await run();
    if (doc.$locals?.oldPath) await sb.remove([doc.$locals.oldPath]);
    return out;
  } catch (e) {
    if (doc.$locals?.newPath) await sb.remove([doc.$locals.newPath]);
    throw e;
  }
}

// Links: external must be http(s); internal must be a site path ("/apply").
export function cleanExternalUrl(v) {
  const s = str(v, 1000);
  if (!s) return "";
  let u;
  try { u = new URL(s); } catch { throw fail("Enter a full web address starting with http:// or https://"); }
  if (!/^https?:$/.test(u.protocol)) throw fail("Only http:// and https:// links are allowed.");
  return u.toString();
}
export function cleanInternalPath(v) {
  const s = str(v, 500);
  if (!s) return "";
  if (!s.startsWith("/") || s.startsWith("//") || /[\s\\<>"']/.test(s)) {
    throw fail("Internal pages must be a path on this site, like /apply or /faculty.");
  }
  return s;
}

// Sends a stored file to the response (inline only for pdf/images). Files in Supabase are streamed
// from there; files saved before the move (base64 in MongoDB) are still served until migrated.
export async function sendFile(res, doc, { download = false } = {}) {
  if (doc.filePath) return sb.stream(res, doc.filePath, { name: doc.fileName, mime: doc.fileType, download });
  const buf = Buffer.from(doc.fileData, "base64");
  const ext = (doc.fileName.split(".").pop() || "").toLowerCase();
  const inline = !download && sb.canInline(doc.fileName);
  const safe = doc.fileName.replace(/[^\w.\- ]/g, "_");
  res.setHeader("Content-Type", doc.fileType || sb.mimeFor(doc.fileName));
  res.setHeader("Content-Length", buf.length);
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
  res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
  res.send(buf);
}
export const hasStoredFile = (d) => !!(d && (d.filePath || d.fileData));

export const fail_ = fail;
