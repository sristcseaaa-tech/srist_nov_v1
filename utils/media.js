import crypto from "crypto";
import { v2 as cloudinary } from "cloudinary";
import MediaAsset from "../models/MediaAsset.js";
import * as sb from "./supabase.js";

// ============================================================================
// ONE place that talks to Cloudinary. Two accounts, kept strictly apart:
//
//   "website"  (Account 1)  CLOUDINARY_WEBSITE_URL   (or the legacy CLOUDINARY_URL)
//              Public site media: employee / faculty / admin photos, gallery, cards,
//              banners, department images, every customizable section image.
//              Delivered from the public CDN (type "upload").
//
//   "student"  (Account 2)  CLOUDINARY_STUDENT_URL
//              Student profile images, assessment images and files, and anything else that
//              belongs to a student. Stored as type "authenticated": the plain URL does NOT
//              work, only a URL signed by this server does, and the server only hands those
//              out to people who are allowed to see them.
//
// Credentials come ONLY from environment variables, in the form
//   cloudinary://<api_key>:<api_secret>@<cloud_name>
// They are passed to the SDK explicitly on every call (never through the SDK's global
// CLOUDINARY_URL auto-config) so one account can never be used by accident for the other,
// and they are never put in an API response, a log line or the database.
// What MongoDB keeps: url, publicId, category, owner/reference id and metadata (MediaAsset).
// Never the image bytes, never base64.
// ============================================================================

export const WEBSITE = "website";
export const STUDENT = "student";

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function parseUrl(raw) {
  if (/[<>]/.test(String(raw))) return null; // an unfilled placeholder is not a credential
  const m = /^cloudinary:\/\/([^:@\s]+):([^@\s]+)@([^/\s]+)\/?$/.exec(String(raw || "").trim());
  return m ? { api_key: m[1], api_secret: m[2], cloud_name: m[3] } : null;
}

// Read lazily so tests / late dotenv loading both work.
function creds(account) {
  if (account === STUDENT) return parseUrl(process.env.CLOUDINARY_STUDENT_URL);
  if (account === WEBSITE) return parseUrl(process.env.CLOUDINARY_WEBSITE_URL || process.env.CLOUDINARY_URL);
  return null;
}
export const accountReady = (account) => !!creds(account);
export const cloudNameOf = (account) => creds(account)?.cloud_name || "";

// The account that owns a Cloudinary URL, judged by its cloud name. null = not ours.
export function accountOfUrl(url) {
  const m = /^https?:\/\/res\.cloudinary\.com\/([^/]+)\//i.exec(String(url || ""));
  if (!m) return null;
  for (const a of [WEBSITE, STUDENT]) if (cloudNameOf(a) && cloudNameOf(a) === m[1]) return a;
  return null;
}

function conf(account) {
  const c = creds(account);
  if (!c) {
    const name = account === STUDENT ? "CLOUDINARY_STUDENT_URL" : "CLOUDINARY_WEBSITE_URL";
    throw fail(`Image storage is not configured on the server (${name} is missing).`, 503);
  }
  return c;
}

// A safe, short description for logs — never the secret.
export const describeAccounts = () => ({
  website: accountReady(WEBSITE) ? cloudNameOf(WEBSITE) : "NOT CONFIGURED",
  student: accountReady(STUDENT) ? cloudNameOf(STUDENT) : "NOT CONFIGURED"
});

// ---------------------------------------------------------------- validation
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per picture
export const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/gif": "gif" };

function sniff(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (buf.length >= 3 && buf.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return "";
}
function looksLikeSafeSvg(buf) {
  const t = buf.toString("utf8", 0, Math.min(buf.length, 200_000));
  return /<svg[\s>]/i.test(t) && !/<script|javascript:|\son\w+\s*=|<foreignObject|<iframe|<embed|<object/i.test(t);
}

const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/i;
export const isDataUrl = (v) => typeof v === "string" && v.startsWith("data:");

// data URL | { buffer, mimetype } (multer) -> a checked { buffer, mime, ext }
// The file's real bytes decide the type, not the name or the claimed content-type.
export function checkImage(input, { allowSvg = false, maxBytes = MAX_IMAGE_BYTES, label = "Image" } = {}) {
  let buffer, claimed;
  if (typeof input === "string") {
    const m = DATA_URL.exec(input);
    if (!m) throw fail(`${label} could not be read. Please choose it again.`);
    claimed = m[1].toLowerCase();
    buffer = Buffer.from(m[2].replace(/\s/g, ""), "base64");
  } else if (input?.buffer) {
    buffer = input.buffer; claimed = String(input.mimetype || "").toLowerCase();
  } else throw fail(`${label} could not be read. Please choose it again.`);

  if (!buffer.length) throw fail(`${label} is empty.`);
  if (buffer.length > maxBytes) throw fail(`${label} is too large — the limit is ${Math.round(maxBytes / 1048576)} MB.`, 413);
  const real = sniff(buffer);
  if (real) return { buffer, mime: real, ext: IMAGE_TYPES[real] };
  if (allowSvg && claimed === "image/svg+xml" && looksLikeSafeSvg(buffer)) return { buffer, mime: "image/svg+xml", ext: "svg" };
  throw fail(`${label} must be a PNG, JPG, WebP or GIF picture${allowSvg ? " (or a clean SVG)" : ""}.`);
}

// ---------------------------------------------------------------- naming
const slug = (s) => String(s || "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const safeId = (s) => String(s || "misc").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "misc";
export const ROOT = { [WEBSITE]: "srist/website", [STUDENT]: "srist/students" };

// Folder layout (Account 1):
//   srist/website/employees/<userId>/profile      every employee / faculty / admin has their own folder
//   srist/website/departments/<dept>/<kind>       logos, HOD photos, events, notices
//   srist/website/sections/<section>              Customize page: banners, cards, gallery, ...
//   srist/website/<category>/...                  newsletters, placement, admission, ...
// (Account 2):
//   srist/students/<studentId>/profile
//   srist/students/assessments/<assessmentId>/...
export function folderFor(account, { category = "misc", ownerId = "", sub = "" } = {}) {
  const parts = [ROOT[account] || ROOT[WEBSITE], slug(category) || "misc"];
  if (ownerId) parts.push(safeId(ownerId));
  if (sub) parts.push(slug(sub));
  return parts.join("/");
}
export const employeeFolder = (id, sub = "profile") => `${ROOT[WEBSITE]}/employees/${safeId(id)}/${slug(sub)}`;
export const studentFolder = (id, sub = "profile") => `${ROOT[STUDENT]}/${safeId(id)}/${slug(sub)}`;

// ---------------------------------------------------------------- upload / delete
// Account 2 is always private. Account 1 is public CDN, except pictures/files that must NOT be public
// (staff Task Center attachments): those are uploaded with { private: true } and signed by the server too.
const typeOf = (account, priv) => (account === STUDENT || priv ? "authenticated" : "upload");

// Uploads one checked image and records its METADATA. Returns the record + the URL to store.
//   opts: { category, ownerType, ownerId, folder, uploadedBy: { id, kind }, label, allowSvg }
export async function uploadImage(input, account, opts = {}) {
  const c = conf(account);
  const img = checkImage(input, { allowSvg: !!opts.allowSvg, label: opts.label || "Image" });
  const folder = opts.folder || folderFor(account, opts);
  const public_id = `${crypto.randomBytes(8).toString("hex")}${opts.name ? `_${slug(opts.name)}` : ""}`;
  let res;
  try {
    res = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { ...c, folder, public_id, resource_type: "image", type: typeOf(account, opts.private), overwrite: false, invalidate: true, unique_filename: false, secure: true },
        (err, r) => (err ? reject(err) : resolve(r))
      ).end(img.buffer);
    });
  } catch (e) {
    console.error(`[media] ${account} upload failed:`, e.message);
    throw fail("The picture could not be saved to image storage. Please try again.", 502);
  }
  const doc = {
    account, category: opts.category || "misc", ownerType: opts.ownerType || "", ownerId: String(opts.ownerId || ""),
    publicId: res.public_id, url: res.secure_url, deliveryType: typeOf(account, opts.private), resourceType: "image",
    format: res.format || img.ext, bytes: res.bytes || img.buffer.length, width: res.width || 0, height: res.height || 0,
    folder, uploadedBy: opts.uploadedBy || {}
  };
  try { await MediaAsset.create(doc); }
  catch (e) { await destroyAsset(account, res.public_id, "image", typeOf(account, opts.private)); throw e; } // never leave an orphan
  return { ...doc, url: typeOf(account, opts.private) === "authenticated" ? canonical(account, res.public_id, res.version, res.format || img.ext, "", "image") : res.secure_url };
}

// The URL we keep in the model field. For the private account it is the UNSIGNED form (useless on its own).
function canonical(account, publicId, version, format, fallback, resourceType = "image") {
  if (!account) return fallback;
  return `https://res.cloudinary.com/${cloudNameOf(account)}/${resourceType}/authenticated/${version ? `v${version}/` : ""}${publicId}${format ? `.${format}` : ""}`;
}

async function destroyAsset(account, publicId, resourceType = "image", type) {
  try {
    const r = await cloudinary.uploader.destroy(publicId, { ...conf(account), resource_type: resourceType, type: type || typeOf(account), invalidate: true });
    return r?.result === "ok" || r?.result === "not found";
  } catch (e) {
    console.error("[media] could not delete", publicId, "-", e.message);
    return false;
  }
}

// ---------------------------------------------------------------- reading a stored URL
// "https://res.cloudinary.com/<cloud>/<image|raw>/<upload|authenticated>/[s--sig--/][transforms/][v123/]<publicId>[.ext]"
const URL_RE = /^https?:\/\/res\.cloudinary\.com\/([^/]+)\/(image|raw|video)\/(upload|authenticated|private)\/(.+)$/i;
export function parseAsset(url) {
  const m = URL_RE.exec(String(url || "").split(/[?#]/)[0]);
  if (!m) return null;
  const [, cloud, resourceType, type, rest] = m;
  let parts = rest.split("/");
  if (/^s--[\w-]{8}--$/.test(parts[0])) parts.shift();
  const vIdx = parts.findIndex((p) => /^v\d+$/.test(p));
  let version = "";
  if (vIdx >= 0) { version = parts[vIdx].slice(1); parts = parts.slice(vIdx + 1); }
  else parts = parts.filter((p) => !/^[a-z]{1,3}_[^/]*$/i.test(p) || p.includes("."));  // drop transform segments
  const last = parts.pop() || "";
  const dot = last.lastIndexOf(".");
  const format = resourceType === "raw" || dot < 0 ? "" : last.slice(dot + 1);
  parts.push(resourceType === "raw" || dot < 0 ? last : last.slice(0, dot));
  const account = accountOfUrl(url);
  return { cloud, resourceType, type, version, format, publicId: decodeURIComponent(parts.join("/")), account };
}

// Any URL we issued (public, signed or transformed) -> the form we store. Anything else is returned unchanged.
export function toStored(url) {
  const a = parseAsset(url);
  if (!a?.account) return url;
  if (a.type === "authenticated") return canonical(a.account, a.publicId, a.version, a.format, "", a.resourceType);
  // public site images: drop any transformation so the stored value is the plain CDN URL
  return `https://res.cloudinary.com/${a.cloud}/${a.resourceType}/upload/${a.version ? `v${a.version}/` : ""}${a.publicId}${a.format ? `.${a.format}` : ""}`;
}
export const isManaged = (url) => !!accountOfUrl(url) && !!parseAsset(url);
// Identity of a picture. Two URLs of the same picture (plain, resized, signed) share a public id.
export const idOf = (url) => (isManaged(url) ? parseAsset(url).publicId : "");

// Deletes the Cloudinary asset(s) behind these stored URLs and their registry rows — and the Supabase files behind "sb:" references.
// Best effort: a picture that is already gone is not an error. External links are ignored.
export async function removeByUrl(urls) {
  const list = [...new Set((Array.isArray(urls) ? urls : [urls]).filter((u) => typeof u === "string" && u))];
  const refs = list.filter(sb.isRef);                       // documents live in Supabase Storage ("sb:<path>")
  if (refs.length) await sb.remove(refs);
  await Promise.all(list.filter((u) => !sb.isRef(u)).map(async (u) => {
    const a = parseAsset(u);
    if (!a?.account) return;
    await destroyAsset(a.account, a.publicId, a.resourceType, a.type);
    await MediaAsset.deleteOne({ publicId: a.publicId }).catch(() => {});
  }));
}

// ---------------------------------------------------------------- delivery
// Cloudinary transformation string: automatic format + quality, sized to what the page needs.
export function transformString({ w, h, crop, dpr } = {}) {
  const t = ["f_auto", "q_auto"];
  if (dpr) t.push(`dpr_${dpr}`);
  if (w) t.push(`w_${Math.round(w)}`);
  if (h) t.push(`h_${Math.round(h)}`);
  t.push(`c_${crop || (w && h ? "fill" : "limit")}`);
  if (crop === "fill" || (w && h)) t.push("g_auto");
  return t.join(",");
}

// Optimised URL for a PUBLIC site image (f_auto, q_auto, sized). Non-Cloudinary URLs pass through.
export function optimizedUrl(url, size = {}) {
  const a = parseAsset(url);
  if (!a || a.account !== WEBSITE || a.type !== "upload" || a.resourceType !== "image") return url;
  return `https://res.cloudinary.com/${a.cloud}/image/upload/${transformString(size)}/${a.version ? `v${a.version}/` : ""}${a.publicId}${a.format ? `.${a.format}` : ""}`;
}

// A URL a browser can actually load for a PRIVATE picture (type "authenticated") — signed with that
// account's secret. Hand these out only to people who are allowed to see the picture.
export function signedImageUrl(url, size = { w: 640 }) {
  const a = parseAsset(url);
  if (!a?.account || a.type !== "authenticated" || a.resourceType !== "image") return url;
  const c = creds(a.account);
  const opts = { cloud_name: c.cloud_name, api_secret: c.api_secret, secure: true, sign_url: true, type: "authenticated", resource_type: "image", version: a.version || undefined };
  const tr = size.w || size.h
    ? [{ fetch_format: "auto", quality: "auto", width: size.w, height: size.h, crop: size.h && size.w ? "fill" : "limit" }]
    : [{ fetch_format: "auto", quality: "auto" }];
  return cloudinary.url(a.publicId, { ...opts, transformation: tr, format: undefined });
}

// What an API response should carry for a stored image value:
//   public site image  -> optimised CDN URL
//   student image      -> signed URL  (caller must already have checked the viewer's right to see it)
//   anything else      -> unchanged (external links, site paths)
export function deliver(url, size) {
  if (!url || typeof url !== "string") return url;
  const a = parseAsset(url);
  if (!a?.account) return url;
  if (a.type === "authenticated") return signedImageUrl(url, size || { w: 640 });
  if (a.account === WEBSITE) return optimizedUrl(url, size || { w: 1200 });
  return url;
}

// ---------------------------------------------------------------- private FILES
// Student / assessment documents (Account 2) — and staff-internal files — of any allowed type (pdf, zip, office, images ...).
// Stored as type "authenticated": there is no public URL. The server streams them to a person
// it has already checked (see streamPrivate), so access is decided on every request.
//   file: { buffer, originalname, mimetype }
export async function uploadPrivateFile(file, folder, opts = {}) {
  const account = opts.account || STUDENT;   // default Account 2; staff-internal files pass WEBSITE (still private)
  const c = conf(account);
  const mime = String(file.mimetype || "application/octet-stream");
  const resourceType = mime.startsWith("image/") ? "image" : "raw";
  const base = String(file.originalname || "file").normalize("NFKD").replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "").slice(0, 60) || "file";
  const id = crypto.randomBytes(8).toString("hex");
  // raw files keep their extension in the public id so downloads open correctly
  const stem = resourceType === "image" ? base.replace(/\.[a-z0-9]{1,8}$/i, "") : base;
  let res;
  try {
    res = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { ...c, folder, public_id: `${id}_${stem}`, resource_type: resourceType, type: "authenticated", overwrite: false, unique_filename: false, secure: true },
        (err, r) => (err ? reject(err) : resolve(r))
      ).end(file.buffer);
    });
  } catch (e) {
    console.error(`[media] ${account} private file upload failed:`, e.message);
    throw fail("The file could not be saved to file storage. Please try again.", 502);
  }
  const rec = {
    id, name: String(file.originalname || base).slice(0, 160), publicId: res.public_id, resourceType: res.resource_type,
    format: res.format || "", url: canonical(STUDENT, res.public_id, res.version, res.format, "", res.resource_type),
    bytes: res.bytes || file.buffer.length, mime, uploadedAt: new Date(), private: true
  };
  try {
    await MediaAsset.create({
      account, category: opts.category || "student-file", ownerType: opts.ownerType || "", ownerId: String(opts.ownerId || ""),
      publicId: rec.publicId, url: rec.url, deliveryType: "authenticated", resourceType: rec.resourceType, format: rec.format,
      bytes: rec.bytes, folder, uploadedBy: opts.uploadedBy || {}
    });
  } catch (e) { await destroyAsset(account, rec.publicId, rec.resourceType, "authenticated"); throw e; }
  return rec;
}

export const isPrivateFile = (f) => !!f && (f.private === true || /\/(image|raw)\/authenticated\//.test(String(f.url || "")));

// A short-lived (5 min) Cloudinary API download URL. Used by the server only — never sent to a browser.
function privateDownloadUrl(f) {
  const a = parseAsset(f.url);
  const resource_type = f.resourceType || a?.resourceType || "image";
  const publicId = f.publicId || a?.publicId;
  if (!publicId) throw fail("File not found", 404);
  const format = resource_type === "raw" ? "" : (f.format || a?.format || "");
  return cloudinary.utils.private_download_url(publicId, format, {
    ...conf(a?.account || STUDENT), resource_type, type: "authenticated", expires_at: Math.floor(Date.now() / 1000) + 300
  });
}

// A short-lived, signed link a BROWSER can open for a private FILE (pdf, zip, ...). Hand it out only to
// people who are allowed to have the file. (Pictures use deliver() instead.)
export function fileLink(url, { ttl = 3600, name } = {}) {
  const a = parseAsset(url);
  if (!a?.account || a.type !== "authenticated") return url;
  const format = a.resourceType === "raw" ? "" : a.format || "";
  return cloudinary.utils.private_download_url(a.publicId, format, {
    ...conf(a.account), resource_type: a.resourceType, type: "authenticated", attachment: name ? String(name).replace(/[^\w.\- ]/g, "_") : true,
    expires_at: Math.floor(Date.now() / 1000) + ttl
  });
}

const INLINE = /^(application\/pdf|image\/(png|jpe?g|gif|webp|bmp))$/i;
// Streams a private file to the response of a request the route has ALREADY authorised.
export async function streamPrivate(res, f, { download = false } = {}) {
  const r = await fetch(privateDownloadUrl(f));
  if (!r.ok || !r.body) throw fail("File not found", r.status === 404 ? 404 : 502);
  const mime = f.mime || r.headers.get("content-type") || "application/octet-stream";
  const inline = !download && INLINE.test(mime);
  const name = String(f.name || "file");
  res.setHeader("Content-Type", mime);
  const len = r.headers.get("content-length"); if (len) res.setHeader("Content-Length", len);
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${name.replace(/[^\w.\- ]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
  res.setHeader("Cache-Control", "private, no-store");
  const { Readable } = await import("stream");
  await new Promise((resolve, reject) => { const src = Readable.fromWeb(r.body); src.on("error", reject); res.on("close", resolve); src.pipe(res); });
}
export { cloudinary as _sdk };
