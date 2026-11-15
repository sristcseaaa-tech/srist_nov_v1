import * as media from "./media.js";
import * as sb from "./supabase.js";

// Shared by the Task Center, class Discussion and Exam Cell: they all receive an attachment from the browser as
//   { kind: "photo", name, data: "data:image/…;base64,…" }          pictures      -> Cloudinary (media.uploadImage)
//   { kind: "file",  name, ticket }                                 big files     -> already uploaded straight to Supabase
//   { kind: "file",  name, data: "data:<mime>;base64,…" }           small files   -> stored in Supabase by the server
//
// DOCUMENTS (pdf, word, excel, zip, json, source code …) go to SUPABASE STORAGE, in the folder of the section they
// belong to (task-center/, discussion/, exam-cell/). MongoDB keeps ONLY a reference in `data`: "sb:<path>"
// (+ name / mime / size). No bytes, no base64.
//
// When the record is sent back to a browser, attachmentOut() swaps the stored reference for something that browser
// can open: a signed picture URL, or a short-lived signed download link for a file.
// Call attachmentOut() only for people the route already allowed to see the record.

const DATA = /^data:([\w.+-]+\/[\w.+-]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/i;
const fail = (m, s = 400) => Object.assign(new Error(m), { status: s });

// opts: { account, folder, category, ownerType, ownerId, uploadedBy, private,   // pictures (Cloudinary)
//         section, sub, uid }                                                   // documents (Supabase)
export async function storeAttachment(a, opts) {
  if (!a || typeof a !== "object") throw fail("An attachment could not be read.");
  const data = String(a.data || "");
  // Already one of ours (sent back unchanged on an edit): keep it as it is.
  if (sb.isRef(data)) return { ...a, data };
  const fromLink = sb.refFromLink(data);                  // signed link sent back unchanged
  if (fromLink) return { ...a, data: fromLink };
  if (media.isManaged(data)) return { ...a, data: media.toStored(data) };
  const name = sb.safeName(a.name);
  const base = { account: opts.account, category: opts.category, ownerType: opts.ownerType, ownerId: opts.ownerId, uploadedBy: opts.uploadedBy, private: opts.private };

  const m = DATA.exec(data);
  const isPhoto = !opts.allToStorage && a.kind === "photo" && !!m && m[1].toLowerCase().startsWith("image/"); // allToStorage: pictures go to Supabase too
  if (isPhoto) {
    const rec = await media.uploadImage(data, opts.account, { ...base, folder: opts.folder, name, label: `“${name}”` });
    return { kind: "photo", name, data: rec.url, mime: `image/${rec.format === "jpg" ? "jpeg" : rec.format}`, size: rec.bytes };
  }
  if (!a.ticket && !m) throw fail("One of the attachments could not be read.");
  const rec = await sb.claim({ name, ticket: a.ticket, data: a.ticket ? undefined : data }, { section: opts.section, sub: opts.sub, uid: opts.uid });
  const asPhoto = a.kind === "photo" && rec.mime.startsWith("image/");
  return { kind: asPhoto ? "photo" : "file", name: rec.name, data: sb.refOf(rec.path), mime: rec.mime, size: rec.size };
}

// Stores a list; if any item fails, the ones already uploaded are removed again.
export async function storeAttachments(list, opts) {
  const done = [];
  try { for (const a of list || []) done.push(await storeAttachment(a, opts)); }
  catch (e) { await media.removeByUrl(done.map((d) => d.data)); throw e; }
  return done;
}

const isMine = (v) => sb.isRef(v) || media.isManaged(v);
const idOf = (v) => (sb.isRef(v) ? v : media.idOf(v));
export const urlsOf = (list) => (list || []).map((a) => a?.data).filter(isMine);
// Delete the pictures/files that were in `before` but are no longer in `after`.
export const removeDropped = (before, after) => {
  const keep = new Set(urlsOf(after).map(idOf));
  return media.removeByUrl(urlsOf(before).filter((u) => !keep.has(idOf(u))));
};

// What a browser receives for one stored attachment.
export function attachmentOut(a, { ttl = 3600 } = {}) {
  if (!a) return a;
  const o = typeof a.toObject === "function" ? a.toObject() : { ...a };
  if (sb.isRef(o.data)) { o.data = sb.linkFor(sb.pathOfRef(o.data), { name: o.name, mime: o.mime, ttl }); return o; }   // Supabase file: signed, short-lived link
  if (!isMine(o.data)) return o;                         // legacy base64 / external link: unchanged
  o.data = o.kind === "photo" ? media.deliver(o.data, { w: 1600 }) : media.fileLink(o.data, { ttl, name: o.name, mime: o.mime });
  return o;
}
export const attachmentsOut = (list, opts) => (list || []).map((a) => attachmentOut(a, opts));
