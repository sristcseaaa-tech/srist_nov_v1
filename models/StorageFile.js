import mongoose from "mongoose";
import { contentConnection } from "../db.js";

// A file uploaded from Admin → Storage. The bytes live in Supabase (admin-uploads/<role>/<section>/…);
// MongoDB keeps only the path + who may see it (role) + where it belongs (section / page).
const StorageFileSchema = new mongoose.Schema(
  {
    role: { type: String, required: true, lowercase: true, index: true },    // public | student | staff | editor | exam | admin
    section: { type: String, required: true, lowercase: true, index: true }, // home | resources | navigation | newsletter | placement | admission | exam-cell | student-portal | tasks | general
    page: { type: String, default: "", trim: true, maxlength: 80 },          // optional page / sub-section name
    label: { type: String, default: "", trim: true, maxlength: 160 },
    fileName: { type: String, required: true, maxlength: 200 },
    fileType: { type: String, default: "", maxlength: 120 },
    fileSize: { type: Number, default: 0 },
    filePath: { type: String, required: true },
    visible: { type: Boolean, default: true },
    uploadedBy: { type: String, default: "" }
  },
  { timestamps: true }
);

export default contentConnection.model("StorageFile", StorageFileSchema);
