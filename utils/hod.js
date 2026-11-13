import User from "../models/User.js";
import OfficeMember from "../models/OfficeMember.js";

// Every department has exactly ONE HOD. Returns who already holds it (as
// { name, email }) or null. `exceptEmail` lets the current holder be re-saved.
export async function currentHod(dept, exceptEmail = "") {
  if (!dept) return null;
  const except = String(exceptEmail || "").toLowerCase();
  const ne = except ? { email: { $ne: except } } : {};
  const u = await User.findOne({ role: "hod", $or: [{ editorDept: dept }, { department: dept }], ...ne }).select("name email");
  if (u) return { name: u.name, email: u.email };
  const m = await OfficeMember.findOne({ role: "hod", department: dept, ...ne }).select("name email");
  return m ? { name: m.name, email: m.email } : null;
}

export const hodMessage = (dept, who) =>
  `${String(dept).toUpperCase()} already has a HOD (${who.name}, ${who.email}). Each department can have only one HOD — change them to Asst_Prof first.`;
