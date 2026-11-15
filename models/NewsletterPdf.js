import mongoose from "mongoose";
import { contentConnection } from "../db.js";

// The uploaded PDF of a newsletter edition (one per edition). The PDF itself is in Supabase Storage;
// this record keeps its name, size and storage path.
const NewsletterPdfSchema = new mongoose.Schema(
  {
    newsletter: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true, unique: true },
    fileName: { type: String, required: true },
    fileSize: { type: Number, default: 0 },
    filePath: { type: String, default: "" },              // object path in Supabase Storage (newsletters/…)
    data: { type: String, default: "" }                   // LEGACY base64 (no data: prefix) — read only, cleared by npm run migrate:files
  },
  { timestamps: true }
);

export default contentConnection.model("NewsletterPdf", NewsletterPdfSchema);
