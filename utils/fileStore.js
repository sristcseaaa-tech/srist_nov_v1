import crypto from "crypto";
import Assessment from "../models/Assessment.js";
import User from "../models/User.js";
import * as drive from "./driveStore.js";
import * as cloud from "./cloud.js";
import * as media from "./media.js";
import * as sb from "./supabase.js";
export { isPrivateFile } from "./media.js";
export const streamPrivate = media.streamPrivate;

// ONE place that decides where assessment files live.
//
// Every NEW assessment file (reference material, file-upload answers, code-lab files) is saved in Supabase Storage.
// Google Drive is not used any more. Files already stored in Drive / Supabase / Cloudinary keep working and keep
// being deleted from where they are.

export { extOf, ACCEPT_KEYS, fileAllowed } from "./cloud.js";
const lc = (s) => String(s || "").trim().toLowerCase();

// New files (teacher reference material AND student answers) always go to Supabase Storage.
// Google Drive is no longer used for new uploads; older Drive files still open and delete normally.
export function storageKind() {
  return sb.ready() ? "supabase" : "none";
}
export const storageReady = () => storageKind() !== "none";
export const isDriveFile = (f) => f?.storage === "drive" || !!f?.driveId;
export const isSupabaseFile = (f) => f?.storage === "supabase" || !!f?.path;

// ============================================================ provider + assessment folder
// The "assessment provider" is the staff member who made the assessment (department editor or admin).
export async function providerOf(a) {
  if (a.drive?.providerEmail) return { email: lc(a.drive.providerEmail), name: a.drive.providerName || a.createdByName || "" };
  const u = a.createdBy ? await User.findById(a.createdBy).select("email name").catch(() => null) : null;
  return { email: lc(u?.email), name: u?.name || a.createdByName || "" };
}

const folderName = (a) => `${String(a.department || "").toUpperCase()} · ${a.title} · ${String(a._id).slice(-6)}`;

// Creates (once) the assessment's Drive folder and shares it with the provider ONLY.
export async function ensureAssessmentFolder(a) {
  if (a.drive?.folderId) return a.drive.folderId;
  return drive.once(`assessment:${a._id}`, async () => {
    const fresh = await Assessment.findById(a._id).select("drive");
    if (fresh?.drive?.folderId) { a.drive = fresh.drive; return fresh.drive.folderId; }
    const root = await drive.rootFolderId();
    const prov = await providerOf(a);
    const folder = await drive.ensureFolder(folderName(a), root);
    const d = {
      folderId: folder.id, url: folder.webViewLink || drive.folderUrl(folder.id), mode: "created",
      providerEmail: prov.email, providerName: prov.name, sharedWith: prov.email ? [prov.email] : [],
      lockedAt: null, shareError: "", lastError: ""
    };
    if (prov.email) {
      const r = await drive.lockTo(folder.id, d.sharedWith);
      if (r.notAdded.length) d.shareError = r.notAdded.join("; "); else d.lockedAt = new Date();
    } else d.shareError = "The teacher who made this assessment has no email on file, so the folder isn't shared with anyone yet.";
    await Assessment.updateOne({ _id: a._id }, { $set: { drive: d } });
    a.drive = d;
    return d.folderId;
  });
}

export async function ensureStudentFolder(a, student) {
  const parent = await ensureAssessmentFolder(a);
  const f = await drive.ensureFolder(`${student.name || "Student"} (${student.email || student._id})`, parent);
  return { id: f.id, url: f.webViewLink || drive.folderUrl(f.id) };
}
const materialFolder = async (a) => (await drive.ensureFolder("_Teacher material", await ensureAssessmentFolder(a))).id;

// ============================================================ store / remove / describe
// ctx: { assessment, kind: "material" | "answer", student?: { _id, name, email } }
const newId = () => crypto.randomBytes(8).toString("hex");

async function storeInSupabase(file, ctx) {
  const a = ctx.assessment;
  // Supabase Storage (private bucket): assessments/<assessmentId>/<material | studentId>/…
  // `file.claimed` = the browser already uploaded it straight to Supabase (big files); otherwise the server stores the buffer.
  const up = file.claimed || await sb.putBuffer({ buffer: file.buffer, name: file.originalname, mime: file.mimetype }, { section: "assessments", sub: [String(a._id), ctx.kind === "material" ? "material" : String(ctx.student._id)] });
  return {
    id: newId(), name: up.name, url: "", publicId: "", resourceType: "raw", bytes: up.size, mime: up.mime, uploadedAt: new Date(),
    storage: "supabase", path: up.path
  };
}

async function storeInDrive(file, ctx) {
  const a = ctx.assessment;
  const buffer = file.buffer || await sb.readBuffer(file.claimed.path);   // big files arrive via Supabase first — read them back
  let parentId, folder = null;
  if (ctx.kind === "material") parentId = await materialFolder(a);
  else { folder = await ensureStudentFolder(a, ctx.student); parentId = folder.id; }
  const mime = String(file.mimetype || "application/octet-stream");
  const up = await drive.uploadBuffer({ name: file.originalname, mime, buffer, parentId });
  if (file.claimed) await sb.remove([file.claimed.path]);                 // only now is the temporary Supabase copy not needed
  return {
    id: newId(),
    name: String(file.originalname || "file").slice(0, 160), url: "", publicId: "", resourceType: "raw",
    bytes: Number(up.size) || file.size, mime, uploadedAt: new Date(),
    storage: "drive", driveId: up.id, viewLink: up.webViewLink || "",
    folder // not saved on the file itself; the route keeps it on the submission
  };
}

export async function storeFile(file, ctx) {
  const kind = storageKind();
  if (kind === "none") {
    throw Object.assign(new Error("File storage is not configured on the server (SUPABASE_URL / SUPABASE_SECRET_KEY are missing — see server/.env.example)."), { status: 503 });
  }
  return storeInSupabase(file, ctx);
}

export async function removeFile(f) {
  if (!f) return;
  if (isSupabaseFile(f)) return sb.remove([f.path]);
  if (isDriveFile(f)) return drive.deleteFile(f.driveId);
  return cloud.destroyFile(f);
}
export const removeMany = (files) => Promise.all((files || []).map(removeFile));

// What the browser gets. Drive files have NO public URL: the browser must ask the portal
// (with its sign-in token) at `apiPath`, and the portal checks who is allowed to read it.
export function fileOut(f, href) {
  if (!f) return f;
  if (!isSupabaseFile(f) && !isDriveFile(f) && !(media.isPrivateFile(f) && href)) return cloud.publicFile(f); // older public uploads keep their link
  const mime = f.mime || "";
  const kind = /^image\//.test(mime) ? "image" : /pdf/i.test(mime) ? "pdf" : "file";
  return { id: f.id, name: f.name, url: "", downloadUrl: "", protected: true, apiPath: href(f), bytes: f.bytes, mime, kind, uploadedAt: f.uploadedAt };
}

// Only these open inside the browser tab; everything else is forced to download.
const INLINE_MIME = /^(application\/pdf|image\/(png|jpe?g|gif|webp|bmp))$/i;
export const canPreview = (f) => INLINE_MIME.test(String(f?.mime || ""));

// ============================================================ Drive panel (teacher side)
export function driveOut(a) {
  const info = drive.driveAuthInfo();
  const d = a.drive || {};
  return {
    configured: drive.driveReady(), canStore: drive.driveCanStore(), mode: info.mode, account: info.account, detail: info.detail,
    hasOAuthClient: info.hasOAuthClient, hasRefreshToken: info.hasRefreshToken, hasServiceAccount: info.hasServiceAccount,
    active: storageKind() === "drive", storage: storageKind(), problem: drive.driveProblem(),
    connected: !!d.folderId, url: d.url || "", folderMode: d.mode || "",
    provider: { email: d.providerEmail || "", name: d.providerName || "" },
    sharedWith: d.sharedWith || [], lockedAt: d.lockedAt || null, shareError: d.shareError || "", lastError: d.lastError || ""
  };
}

// Create a new folder (default) or point the assessment at an existing Drive folder.
export async function connectFolder(a, { action, url }) {
  if (!drive.driveReady()) throw Object.assign(new Error("Google Drive isn't set up on the server yet."), { status: 503 });
  // Don't make a folder nobody can put files in (a service account has no storage) — say what to do instead.
  if (!drive.driveCanStore()) throw Object.assign(new Error(`${drive.driveProblem()} Until then, uploaded files are saved in Supabase Storage automatically.`), { status: 409 });
  const prov = await providerOf(a);
  let d;
  if (action === "link") {
    const id = drive.idFromDriveUrl(url);
    if (!id) throw Object.assign(new Error("Paste the Google Drive folder link (drive.google.com/drive/folders/…)."), { status: 400 });
    const f = await drive.openFolder(id);
    d = { folderId: f.id, url: f.url, mode: "linked" };
  } else {
    const root = await drive.rootFolderId();
    const f = await drive.ensureFolder(folderName(a), root);
    d = { folderId: f.id, url: f.webViewLink || drive.folderUrl(f.id), mode: "created" };
  }
  d = { ...d, providerEmail: prov.email, providerName: prov.name, sharedWith: prov.email ? [prov.email] : [], lockedAt: null, shareError: "", lastError: "" };
  if (prov.email) {
    if (d.mode === "created") {
      const r = await drive.lockTo(d.folderId, d.sharedWith);
      if (r.notAdded.length) d.shareError = r.notAdded.join("; "); else d.lockedAt = new Date();
    } else {
      // An existing folder belongs to someone else: add the provider, but don't remove anyone from it.
      const r = await drive.share(d.folderId, prov.email, "writer");
      if (!r.shared && !/already|owner/i.test(r.error || "")) d.shareError = r.error;
    }
  }
  await Assessment.updateOne({ _id: a._id }, { $set: { drive: d } });
  a.drive = d;
  return d;
}

// Locks the Drive folder (and the Google Sheet the app created) to the allowed staff emails only.
export async function lockAccess(a, sheetLock) {
  const d = a.drive || {};
  if (!d.folderId) throw Object.assign(new Error("Connect a Drive folder first."), { status: 400 });
  const allowed = [...new Set([d.providerEmail, ...(d.sharedWith || [])].map(lc).filter(Boolean))];
  if (!allowed.length) throw Object.assign(new Error("No provider email is on file for this assessment."), { status: 400 });
  const result = { folder: await drive.lockTo(d.folderId, allowed), sheet: null };
  if (sheetLock && a.sheet?.spreadsheetId && a.sheet.mode === "created") result.sheet = await sheetLock(a.sheet.spreadsheetId, allowed);
  const ok = !result.folder.notAdded.length && !result.folder.failed.length;
  await Assessment.updateOne({ _id: a._id }, { $set: { "drive.lockedAt": ok ? new Date() : null, "drive.shareError": result.folder.notAdded.concat(result.folder.failed).join("; ").slice(0, 300) } });
  return { ...result, allowed };
}

export async function listFolderAccess(a) {
  if (!a.drive?.folderId) return [];
  return drive.listAccess(a.drive.folderId);
}
export const driveShare = drive.share;
