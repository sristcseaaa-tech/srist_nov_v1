import * as media from "./media.js";
import * as sb from "./supabase.js";

// File storage for assessments (attachments from staff, uploads from students) and student documents.
// This is Cloudinary ACCOUNT 2 (students / assessments) — CLOUDINARY_STUDENT_URL — the private one.
// Files are uploaded as type "authenticated": there is NO public URL. The server streams each file
// only to a signed-in person its route has already checked (see fileStore.fileOut / media.streamPrivate).
// Credentials come only from the environment, never from code.

export const cloudReady = () => media.accountReady(media.STUDENT);

// Executable / script types are never accepted as uploads.
const BLOCKED_EXT = new Set(); // every type is accepted; non-pdf/picture files are always served as downloads
export const extOf = (name) => (String(name).toLowerCase().match(/\.([a-z0-9]{1,8})$/) || [])[1] || "";

// What kinds of file a block / attachment accepts.
const DOC_EXT = [...sb.GROUPS.documents, ...sb.GROUPS.archives, ...sb.GROUPS.spreadsheets, ...sb.GROUPS.other];
export const ACCEPT_KEYS = ["any", "pdf", "image", "pdf_image", "doc"];
export function fileAllowed(file, accept = "any") {
  const ext = extOf(file.originalname);
  const mime = String(file.mimetype || "");
  if (BLOCKED_EXT.has(ext)) return { ok: false, why: `.${ext} files can't be uploaded.` };
  const isPdf = mime === "application/pdf" || ext === "pdf";
  const isImg = /^image\/(png|jpe?g|gif|webp|bmp|heic|heif)$/.test(mime) || ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic"].includes(ext);
  if (accept === "pdf" && !isPdf) return { ok: false, why: "Only PDF files are accepted here." };
  if (accept === "image" && !isImg) return { ok: false, why: "Only image files (PNG, JPG, GIF, WebP) are accepted here." };
  if (accept === "pdf_image" && !isPdf && !isImg) return { ok: false, why: "Only PDF or image files are accepted here." };
  return { ok: true };
}

// What the browser gets for a stored file.
//   private (Account 2) -> NO url; the browser asks the portal at `apiPath` (see fileStore.fileOut)
//   older public uploads (made before the move to private storage) keep their link
export const publicFile = (f) => f && ({
  id: f.id, name: f.name, url: f.url,
  downloadUrl: f.resourceType === "image" || f.resourceType === "raw" ? String(f.url || "").replace("/upload/", "/upload/fl_attachment/") : f.url,
  bytes: f.bytes, mime: f.mime, kind: f.resourceType === "image" ? "image" : /pdf/i.test(f.mime || "") ? "pdf" : "file",
  uploadedAt: f.uploadedAt
});

// Uploads one in-memory file to Account 2 (private). Returns the record we keep in the database:
// url (unsigned, useless on its own), publicId, size, type — never the bytes.
export const uploadFile = (file, folder, opts) => media.uploadPrivateFile(file, `${media.ROOT[media.STUDENT]}/${folder}`, opts);

// Best effort — a file that is already gone from Cloudinary is not an error.
export async function destroyFile(f) {
  if (!f?.url) return;
  try { await media.removeByUrl(f.url); }
  catch (e) { console.error("[cloud] could not delete", f.publicId, e.message); }
}
export const destroyMany = (files) => Promise.all((files || []).map(destroyFile));
