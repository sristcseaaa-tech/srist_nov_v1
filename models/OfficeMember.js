import mongoose from "mongoose";
import { authConnection } from "../db.js";
import { ROLES } from "../utils/roles.js";

// Office roster = the sign-up allow-list for faculty / employees / admins.
// Same idea as the student roster (OurStudent): an admin adds the person's
// email (one by one with the form, or many at once from an Excel / CSV sheet).
// Only those emails can create an account on Office In → Sign up; their name,
// department and role come from this record, never from the person.
const OfficeMemberSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 160 },
    phone: { type: String, default: "", trim: true, maxlength: 20 },
    designation: { type: String, default: "", trim: true, maxlength: 100 },
    employeeId: { type: String, default: "", trim: true, maxlength: 40 },
    department: { type: String, required: true, trim: true, maxlength: 20 },
    role: { type: String, enum: ROLES, default: "user" },
    source: { type: String, enum: ["form", "excel"], required: true },
    batch: { type: String, default: "" },
    addedBy: { type: String, default: "" }
  },
  { timestamps: true }
);

export default authConnection.model("OfficeMember", OfficeMemberSchema);
