import mongoose from "mongoose";
import { contentConnection } from "../db.js";

// One item of the Home page "Resources" section, uploaded by the admin.
//   kind "file"  -> any document; bytes in Supabase Storage (home-resources/…), MongoDB keeps the path.
//   kind "image" -> a picture; stored on Cloudinary (website account), MongoDB keeps the URL.
const HomeResourceSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, default: "", trim: true, maxlength: 400 },
    kind: { type: String, enum: ["file", "image"], required: true },
    fileName: { type: String, default: "", maxlength: 200 },
    fileType: { type: String, default: "", maxlength: 120 },
    fileSize: { type: Number, default: 0 },
    filePath: { type: String, default: "" },
    imageUrl: { type: String, default: "" },
    visible: { type: Boolean, default: true, index: true },
    order: { type: Number, default: 0 }
  },
  { timestamps: true }
);

export default contentConnection.model("HomeResource", HomeResourceSchema);
