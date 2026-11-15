import mongoose from "mongoose";
import { contentConnection } from "../db.js";

// One admission notice shown on the public /apply page.
// Each notice can carry text, an image and a downloadable file — the admin
// manages them from Customize → "Admission (Apply page)".
const AdmissionNoticeSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 160 },
    text: { type: String, default: "", trim: true, maxlength: 4000 },
    // Notice picture — small, optimised base64 data URL (or a normal URL/path).
    image: { type: String, default: "" },
    // Downloadable attachment. The file itself lives in Supabase Storage (admission-notices/…);
    // MongoDB keeps only its name / type / size / filePath.
    fileName: { type: String, default: "", maxlength: 200 },
    fileType: { type: String, default: "", maxlength: 120 },
    fileSize: { type: Number, default: 0 },
    filePath: { type: String, default: "" },
    fileData: { type: String, default: "", select: false }, // LEGACY base64 — read only, cleared by npm run migrate:files
    // Show/hide without deleting, and manual ordering (lowest first).
    active: { type: Boolean, default: true },
    order: { type: Number, default: 0 }
  },
  { timestamps: true }
);

export default contentConnection.model("AdmissionNotice", AdmissionNoticeSchema);
