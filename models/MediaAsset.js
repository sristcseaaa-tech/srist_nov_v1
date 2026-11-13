import mongoose from "mongoose";
import { contentConnection } from "../db.js";

// METADATA ONLY about a picture that lives in Cloudinary. This collection never holds image
// bytes or base64 — just where the file is and what it belongs to.
//   account: "website" (Cloudinary Account 1, public) | "student" (Account 2, private)
const MediaAssetSchema = new mongoose.Schema(
  {
    account: { type: String, enum: ["website", "student"], required: true, index: true },
    category: { type: String, default: "misc", index: true },   // employee-photo, gallery, banner, student-profile, ...
    ownerType: { type: String, default: "" },                   // user | faculty | student | department | content | assessment ...
    ownerId: { type: String, default: "", index: true },        // id of the record the picture belongs to
    publicId: { type: String, required: true, unique: true },   // Cloudinary public id (includes the folder)
    url: { type: String, required: true },                      // Cloudinary secure URL (for the private account: the unsigned form)
    deliveryType: { type: String, enum: ["upload", "authenticated"], default: "upload" },
    resourceType: { type: String, default: "image" },
    format: { type: String, default: "" },
    bytes: { type: Number, default: 0 },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    folder: { type: String, default: "" },
    uploadedBy: { id: { type: String, default: "" }, kind: { type: String, default: "" } }
  },
  { timestamps: true }
);
MediaAssetSchema.index({ account: 1, category: 1, createdAt: -1 });

export default contentConnection.model("MediaAsset", MediaAssetSchema);
