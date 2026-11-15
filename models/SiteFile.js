import mongoose from "mongoose";
import { contentConnection } from "../db.js";

// A document (PDF / PPT / DOC / XLS) attached to one Customize section.
// The bytes live in Supabase Storage (site-content/<section>/…); MongoDB keeps only the path + metadata.
const SiteFileSchema = new mongoose.Schema(
  {
    section: { type: String, required: true, trim: true, lowercase: true, index: true },
    label: { type: String, default: "", trim: true, maxlength: 160 },
    fileName: { type: String, required: true, maxlength: 200 },
    fileType: { type: String, default: "", maxlength: 120 },
    fileSize: { type: Number, default: 0 },
    filePath: { type: String, required: true },
    order: { type: Number, default: 0 }
  },
  { timestamps: true }
);

export default contentConnection.model("SiteFile", SiteFileSchema);
