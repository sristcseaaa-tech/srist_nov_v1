import express from "express";
import requireAuth from "../middleware/requireAuth.js";
import requireAccess from "../middleware/requireAccess.js";
import User from "../models/User.js";
import Application from "../models/Application.js";
import OurStudent from "../models/OurStudent.js";
import isAdminEmail from "../utils/isAdminEmail.js";
import SheetSetting from "../models/SheetSetting.js";
import { forgetSheetSetting } from "../utils/sheetScope.js";
import { idFromUrl, defaultSheetId, probeSheet, runWithSheet, sheetsConfigured, serviceAccountEmail } from "../utils/googleSheets.js";

// Student Management → "Change Google Sheet": connect a different spreadsheet to
// All Student (admission enquiries) or Our Student (present students). Admin only.
const router = express.Router();
const KEYS = {
  all_students: { label: "All Student", model: Application },
  our_students: { label: "Our Student", model: OurStudent }
};
const urlOf = (id) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

router.use(requireAuth, requireAccess("admissions", "studentMgmt"));
router.use(async (req, res, next) => {
  const u = req.currentUser || (await User.findById(req.userId));
  if (!u || !(u.role === "admin" || isAdminEmail(u.email))) return res.status(403).json({ error: "Only an admin can change the Google Sheet" });
  next();
});
router.param("key", (req, res, next, key) => (KEYS[key] ? next() : res.status(404).json({ error: "Unknown section" })));

async function info(key) {
  const s = await SheetSetting.findOne({ key }).lean();
  const id = s?.spreadsheetId || defaultSheetId();
  return {
    key, label: KEYS[key].label, configured: sheetsConfigured(), serviceAccount: serviceAccountEmail(),
    custom: !!s, spreadsheetId: id, url: urlOf(id), title: s?.title || "", updatedAt: s?.updatedAt || null
  };
}

router.get("/:key", async (req, res) => {
  try { res.json(await info(req.params.key)); } catch (e) { res.status(500).json({ error: e.message }); }
});

// body: { url, resync? }  resync = mark every existing record "not in sheet yet" so
// the Sync button copies them all into the newly connected sheet.
router.put("/:key", async (req, res) => {
  const { key } = req.params;
  const id = idFromUrl(req.body?.url);
  if (!id) return res.status(400).json({ error: "Paste the full Google Sheet link (https://docs.google.com/spreadsheets/d/…)" });
  if (!sheetsConfigured()) return res.status(503).json({ error: "Google Sheets isn't set up on the server yet" });
  try {
    const title = await runWithSheet(id, () => probeSheet(id));
    await SheetSetting.findOneAndUpdate(
      { key },
      { key, spreadsheetId: id, url: urlOf(id), title, updatedBy: String(req.userId) },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    forgetSheetSetting(key);
    let pending = 0;
    if (req.body?.resync) {
      await KEYS[key].model.updateMany({}, { sheetSynced: false });
      pending = await KEYS[key].model.countDocuments({ sheetSynced: false });
    }
    res.json({ ...(await info(key)), pending });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Back to the default sheet.
router.delete("/:key", async (req, res) => {
  try {
    await SheetSetting.deleteOne({ key: req.params.key });
    forgetSheetSetting(req.params.key);
    res.json(await info(req.params.key));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
