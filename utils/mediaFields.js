import * as media from "./media.js";

// Glue between the existing routes (which receive pictures as base64 data URLs from the
// browser) and Cloudinary. A route calls these instead of saving the value itself:
//
//   doc.photo = await media.setImage(req.body.photo, { account, ... , previous: doc.photo });
//
// Result: MongoDB only ever gets a URL (or "" / null). The old Cloudinary picture is deleted when
// it is replaced or cleared.

export const { WEBSITE, STUDENT } = media;
const fail = (m, s = 400) => Object.assign(new Error(m), { status: s });
const isUrlLike = (v) => /^(https?:\/\/|\/)/i.test(v);

// value:   data URL (new upload) | our own Cloudinary URL (unchanged) | external link | "" / null (clear)
// opts:    { account, category, ownerType, ownerId, folder, uploadedBy, previous, allowSvg, label, empty }
// returns: the string to store (opts.empty is what "cleared" becomes: "" by default, or null)
export async function setImage(value, opts = {}) {
  const empty = opts.empty === undefined ? "" : opts.empty;
  const prev = opts.previous ? media.toStored(opts.previous) : "";

  if (value === undefined) return opts.previous ?? empty;           // not sent: leave as it is
  if (value === null || value === "") {
    if (prev) await media.removeByUrl(prev);
    return empty;
  }
  if (typeof value !== "string") throw fail(`${opts.label || "Image"} must be a picture.`);

  if (media.isDataUrl(value)) {
    const rec = await media.uploadImage(value, opts.account || media.WEBSITE, opts);
    if (prev) await media.removeByUrl(prev);
    return rec.url;
  }
  if (media.isManaged(value)) {                                      // our own picture sent back (maybe signed / resized)
    if (prev && media.idOf(prev) === media.idOf(value)) return prev; // unchanged
    if (prev) await media.removeByUrl(prev);
    return media.toStored(value);
  }
  if (isUrlLike(value)) {                                            // an external link or a site path: keep, not ours to delete
    if (prev) await media.removeByUrl(prev);
    return value;
  }
  throw fail(`${opts.label || "Image"} must be an uploaded picture or a link.`);
}

// A value that may be a JSON text holding a list/object with pictures (Customize "More photos", albums).
// Every data URL inside is uploaded and swapped for its Cloudinary URL; pictures that dropped out
// of the list are deleted. Plain text and plain URLs pass through untouched.
export async function setImagesInText(text, opts = {}) {
  const raw = String(text ?? "");
  const before = new Map(collectUrls(opts.previous).map((u) => [media.idOf(u), u])); // publicId -> stored url
  const dropMissing = (keptIds) => media.removeByUrl([...before].filter(([id]) => !keptIds.has(id)).map(([, u]) => u));

  const swap = async (v, used) => {
    if (typeof v === "string") {
      if (media.isDataUrl(v)) { const r = await media.uploadImage(v, opts.account || media.WEBSITE, opts); used.add(media.idOf(r.url)); return r.url; }
      if (media.isManaged(v)) { const id = media.idOf(v); used.add(id); return before.get(id) || media.toStored(v); }
      return v;
    }
    if (Array.isArray(v)) { const out = []; for (const x of v) out.push(await swap(x, used)); return out; }
    if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = await swap(x, used); return o; }
    return v;
  };

  const used = new Set();
  if (raw.startsWith("[") || raw.startsWith("{")) {
    let tree;
    try { tree = JSON.parse(raw); } catch { tree = undefined; }
    if (tree !== undefined) { const next = await swap(tree, used); await dropMissing(used); return JSON.stringify(next); }
  }
  const out = await swap(raw, used);                                  // a single picture (or plain text)
  await dropMissing(used);
  return out;
}

// Every managed Cloudinary URL mentioned in a value (plain URL or JSON text), in stored form.
export function collectUrls(value) {
  const out = new Map();
  const walk = (v) => {
    if (typeof v === "string") {
      if (media.isManaged(v)) out.set(media.idOf(v), media.toStored(v));
      else if (v.startsWith("[") || v.startsWith("{")) { try { walk(JSON.parse(v)); } catch { /* not JSON */ } }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return [...out.values()];
}

// Deletes every managed picture mentioned in these values (used when a whole record is deleted).
export const dropImages = (...values) => media.removeByUrl(values.flatMap(collectUrls));

// Who uploaded it, for the metadata row.
export const uploader = (req) => ({ id: String(req.userId || ""), kind: req.userKind === "student" ? "student" : "staff" });
