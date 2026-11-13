import mongoose from "mongoose";
import { contentConnection } from "../db.js";

// A downloadable placement report (PDF), one per year or topic.
const PlacementReportSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 160 },
    year: { type: Number, default: null },
    description: { type: String, default: "", trim: true, maxlength: 400 },
    fileName: { type: String, default: "" },
    fileSize: { type: Number, default: 0 },
    filePath: { type: String, default: "" },               // object path in Supabase Storage (placement-reports/…)
    data: { type: String, default: "", select: false },    // LEGACY base64 PDF — read only, cleared by npm run migrate:files
    status: { type: String, enum: ["published", "draft"], default: "published" }
  },
  { timestamps: true }
);

export default contentConnection.model("PlacementReport", PlacementReportSchema);
