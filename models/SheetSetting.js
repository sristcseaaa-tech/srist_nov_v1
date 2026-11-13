import mongoose from "mongoose";
import { contentConnection } from "../db.js";

// Which Google Sheet a Student Management section writes to. No document for a
// key = the default sheet (GOOGLE_SHEET_ID). Keys: "all_students", "our_students".
const sheetSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    spreadsheetId: { type: String, required: true },
    url: { type: String, default: "" },
    title: { type: String, default: "" },
    updatedBy: { type: String, default: "" }
  },
  { timestamps: true }
);

export default contentConnection.models.SheetSetting || contentConnection.model("SheetSetting", sheetSettingSchema);
