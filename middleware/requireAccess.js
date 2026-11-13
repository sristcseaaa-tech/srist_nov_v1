import User from "../models/User.js";
import { hasAccess } from "../utils/roles.js";

// Must run AFTER requireAuth. Lets the request through when the logged-in
// staff account has the named admin-nav access (see utils/roles.js ACCESS).
// Admins always pass. e.g. requireAccess("placement") admits admins and
// Placement_Com accounts.
export default function requireAccess(...keys) {
  return async function (req, res, next) {
    try {
      if (req.userKind === "student") return res.status(403).json({ error: "Staff accounts only." });
      const user = await User.findById(req.userId);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!keys.some((k) => hasAccess(user, k))) return res.status(403).json({ error: "You don't have access to this section" });
      req.currentUser = user;
      next();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  };
}
