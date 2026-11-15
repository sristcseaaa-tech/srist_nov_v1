import mongoose from "mongoose";
import { authConnection } from "../db.js";
import { deliver } from "../utils/media.js";
import isAdminEmail from "../utils/isAdminEmail.js";
import { ROLES, normaliseRole, accessOf, ROLE_LABEL } from "../utils/roles.js";

const UserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    lastLogin: { type: Date, default: null },
    lastLogout: { type: Date, default: null },

    // Profile photo — stored as a base64 data URL (e.g. "data:image/png;base64,...").
    // Simple approach that needs no file storage/CDN; fine for small avatar images.
    profileImage: { type: String, default: null },

    // Role-based access:
    //  "user"      — normal account, no editing rights beyond their own profile.
    //  "asst_prof" — Assistant Professor / Lecturer (the old "editor"). Manages ONE
    //                department's public page (faculty, notices, events) — see
    //                editorDept below. Given automatically by designation.
    //  "hod"       — Head of Department: an upgraded asst_prof (same department
    //                powers) plus admin-nav access. ONE per department.
    //  "registrar" / "placement_com" — admin-nav access to admissions / placement.
    //  "exam_role" — can view AND work (add/remove) the Exam Cell notices
    //                for every year (1st/2nd/3rd) at /exam-cells/*. Does not
    //                grant department-editor or admin rights. Assigned by an
    //                admin from Admin → Employees & accounts, same as editor.
    //  "student"   — LEGACY ONLY. Students no longer live in this database: their
    //                accounts are in the student database (models/StudentAccount.js).
    //                Any old "student" rows here are moved across the first time
    //                that student signs in (see utils/accounts.js).
    //  "admin"     — full control: sees every employee/user, can delete
    //                accounts, and can promote/demote anyone to editor,
    //                exam_role, or back to a normal user. Admins can also
    //                edit any department page and the Exam Cell pages.
    // The very first person to ever sign up on the site is made admin
    // automatically (see /signup) so there's always at least one.
    role: { type: String, enum: [...ROLES, "student"], default: "user" },

    // Job title as entered when the employee was added (Lecturer, Assistant
    // Professor, HOD, Registrar, Placement Committee …). Lecturer / Assistant
    // Professor automatically get role "asst_prof"; see utils/roles.js.
    designation: { type: String, default: "", trim: true },

    // Which department (course slug — "etce", "ee", "ce", "me", "cse") this
    // account may edit, when role === "editor". Null for "user"/"admin".
    editorDept: { type: String, default: null }, // set for asst_prof and hod

    // Which department this employee profile belongs to (course slug —
    // "etce", "ee", "ce", "me", "cse"). Set by an admin when the profile is
    // created, independent of editorDept (a non-editor "user" can still
    // belong to a department; an editor's department usually matches the
    // one they're scoped to edit, but doesn't have to).
    department: { type: String, default: null },

    // Students only (role === "student"): which year they are in — "1", "2"
    // or "3". Together with `department` this decides which notes, notices
    // and class routine show up on their student portal.
    year: { type: String, default: null },

    // Email verification — a user cannot log in until emailVerified is true.
    // Verification is done with a 6-digit OTP emailed at signup / when an
    // admin creates the account (not a click-through link).
    emailVerified: { type: Boolean, default: false },
    emailVerifyOtpCode: { type: String, default: null },
    emailVerifyOtpExpires: { type: Date, default: null },

    // Login OTP — after a correct password, a 6-digit code is emailed and
    // must be entered before a session token is issued.
    loginOtpCode: { type: String, default: null },
    loginOtpExpires: { type: Date, default: null },

    // Change-password OTP — after the current password is verified, a
    // 6-digit code is emailed; the new password is only applied once that
    // code is confirmed.
    passwordOtpCode: { type: String, default: null },
    passwordOtpExpires: { type: Date, default: null },

    // Year of birth — a second authentication factor required before a
    // password change is allowed (replaces the old "current password +
    // full birthday" check). Stored as a 4-digit string, e.g. "1998".
    // There's no separate one-time "set your birthday" step anymore: the
    // first time someone changes their password they simply type their
    // birth year into the password-change form and it's saved then; every
    // time after that, it has to match what's on file.
    birthYear: { type: String, default: null },

    // Personal theme colour for office (staff) log-ins — "#rrggbb", or "" for the site default.
    // themeAccess is the admin-controlled "power" to change it:
    //   "default" — allowed (every office account may pick its own colour)
    //   "allowed" — explicitly allowed by an admin / HOD
    //   "locked"  — the person can't change it; the colour stays whatever an admin set
    themeColor: { type: String, default: "" },
    themeAccess: { type: String, enum: ["default", "allowed", "locked"], default: "default" },

    // The Google Sheet this staff member connected for their assessments — remembered so the
    // "connect your sheet" step is not asked again for every new assessment.
    assessmentSheet: {
      url: { type: String, default: "" },
      title: { type: String, default: "" }
    }
  },
  { timestamps: true } // adds createdAt / updatedAt
);

// Legacy rows may still say "editor"; treat them as "asst_prof".
UserSchema.pre("validate", function (next) {
  if (this.role === "editor") this.role = "asst_prof";
  next();
});

// Never send the password hash back in API responses.
UserSchema.methods.toSafeObject = function () {
  return {
    id: this._id,
    name: this.name,
    email: this.email,
    createdAt: this.createdAt,
    lastLogin: this.lastLogin,
    role: this.role,
    roleLabel: ROLE_LABEL[this.role] || this.role,
    designation: this.designation || "",
    // Which "Manage" menu sections / admin pages this account may open.
    access: accessOf(this),
    editorDept: this.editorDept || null,
    department: this.department || null,
    year: this.year || null,
    // Kept for backward compatibility with existing frontend checks
    // (user.isAdmin) — true for role "admin" OR a legacy hardcoded email.
    isAdmin: this.role === "admin" || isAdminEmail(this.email),
    emailVerified: this.emailVerified,
    // Cloudinary URL: optimised CDN URL (staff) or a signed URL (students). Never raw bytes.
    profileImage: deliver(this.profileImage, { w: 400, h: 400 }) || null,
    birthYear: this.birthYear || null,
    themeColor: this.themeColor || "",
    themeAccess: this.themeAccess || "default",
    canChangeTheme: this.role === "admin" || isAdminEmail(this.email) || this.themeAccess !== "locked"
  };
};

export default authConnection.model("User", UserSchema);
