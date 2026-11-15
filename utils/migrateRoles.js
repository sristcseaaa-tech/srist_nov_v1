import User from "../models/User.js";
import OfficeMember from "../models/OfficeMember.js";

// One-time, idempotent: the old "editor" role is now "asst_prof" (Asst_Prof).
// Runs on every start; once nothing says "editor" any more it changes nothing.
export async function migrateRoles() {
  try {
    const u = await User.updateMany({ role: "editor" }, { $set: { role: "asst_prof" } });
    const m = await OfficeMember.updateMany({ role: "editor" }, { $set: { role: "asst_prof" } });
    const n = (u.modifiedCount || 0) + (m.modifiedCount || 0);
    if (n) console.log(`Roles: renamed ${n} "editor" record(s) to "asst_prof".`);
  } catch (e) {
    console.error("Roles migration failed (editor -> asst_prof):", e.message);
  }
}
