import isAdminEmail from "./isAdminEmail.js";

// ============================================================================
// ROLES — single source of truth for the server.
//
//   user          Normal user / staff. No management rights.
//   asst_prof     Assistant Professor / Lecturer. Manages ONE department's
//                 page (faculty, notices, events, student notes…), scoped by
//                 editorDept. (This is the old "editor" role, renamed.)
//   hod           Head of Department. An upgraded Asst_Prof: everything an
//                 Asst_Prof can do for the department PLUS admin-nav access
//                 (see ACCESS below). Exactly ONE HOD per department.
//   registrar     Registrar. Admin-nav access to admissions (All Student) and a
//                 read-only view of Accounts Management.
//   placement_com Placement Committee. Admin-nav access to the Placement manager.
//   exam_role     Exam Cell. Exam Cell notices only.
//   admin         Everything.
//   student       LEGACY only (students live in their own database).
// ============================================================================

export const ROLES = ["user", "asst_prof", "hod", "registrar", "placement_com", "exam_role", "admin"];
export const DEPT_ROLES = ["asst_prof", "hod"]; // roles that are scoped to one department
export const ONE_PER_DEPT = ["hod"];            // roles only one person per department may hold

export const ROLE_LABEL = {
  user: "Normal user", asst_prof: "Asst_Prof", hod: "HOD", registrar: "Registrar",
  placement_com: "Placement_Com", exam_role: "Exam Cell", admin: "Admin"
};

// Old data / old spreadsheets may still say "editor".
export const normaliseRole = (r) => (r === "editor" ? "asst_prof" : r);
export const isDeptRole = (role) => DEPT_ROLES.includes(role);

// ---- Designation -> role (what happens when an employee is added) ----
// Lecturer / Assistant Professor -> Asst_Prof (dept editor role).
// Head of Department -> HOD, Registrar -> Registrar, Placement -> Placement_Com.
// Anything else -> no automatic role (stays a Normal user).
export const DESIGNATIONS = ["Lecturer", "Assistant Professor", "HOD (Head of Department)", "Registrar", "Placement Committee"];
export function roleFromDesignation(designation) {
  const s = String(designation || "").toLowerCase().replace(/[^a-z0-9& ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (/\bhod\b|head of (the )?dep/.test(s)) return "hod";
  if (/registrar/.test(s)) return "registrar";
  if (/placement|training (and|&) placement|\btpo\b|\btnp\b/.test(s)) return "placement_com";
  if (/lecturer|assistant professor|asst\.? ?prof|\basst prof\b|\bap\b/.test(s)) return "asst_prof";
  return null;
}

// ---- Admin-nav access ----------------------------------------------------
// Each key is one entry in the "Manage" menu / one group of admin routes.
//   editor      /editor            department page editor (own department)
//   studentMgmt Student Management Our Student · Student Content · Assessments (own department)
//   admissions  All Student        admission enquiries (/apply)
//   accounts    Accounts Management (HOD: own department, can set Normal user ⇄ Asst_Prof;
//                                    Registrar: read-only view of everyone)
//   placement   Placement manager
//   uploads     Upload History     (Exam Cell notices)
export const ALL_ACCESS = ["customize", "accounts", "content", "storage", "uploads", "newsletter", "placement", "admissions", "studentMgmt", "editor"];
const ACCESS = {
  asst_prof: ["editor", "studentMgmt"],
  hod: ["editor", "studentMgmt", "accounts"],
  registrar: ["accounts", "admissions"],
  placement_com: ["placement"],
  exam_role: ["uploads"]
};

export const isAdminUser = (u) => !!u && (u.role === "admin" || isAdminEmail(u.email));
export const accessOf = (u) => (!u ? [] : isAdminUser(u) ? ALL_ACCESS : ACCESS[u.role] || []);
export const hasAccess = (u, key) => accessOf(u).includes(key);

// The department a dept-scoped account (Asst_Prof / HOD) looks after.
export const deptOfStaff = (u) => (u && isDeptRole(u.role) && u.editorDept) || null;
