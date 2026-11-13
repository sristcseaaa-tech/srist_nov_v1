import SheetSetting from "../models/SheetSetting.js";
import { runWithSheet } from "./googleSheets.js";

// Express middleware: runs the rest of the request against the Google Sheet an
// admin connected for this section (Student Management → "Change Google Sheet").
// Falls back to the default sheet when none is connected or the lookup fails.
const cache = new Map(); // key -> { id, exp }
const TTL = 30_000;

export const forgetSheetSetting = (key) => cache.delete(key);

export async function sheetIdFor(key) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.id;
  let id = "";
  try { id = (await SheetSetting.findOne({ key }).lean())?.spreadsheetId || ""; } catch { /* default sheet */ }
  cache.set(key, { id, exp: Date.now() + TTL });
  return id;
}

export default function sheetScope(key) {
  return async (req, res, next) => {
    const id = await sheetIdFor(key);
    runWithSheet(id, next);
  };
}
