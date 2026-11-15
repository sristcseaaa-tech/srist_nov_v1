// MUST be the very first import. ES module `import` statements all execute
// top-to-bottom, in file order, before any other code runs — including a
// later `dotenv.config()` call. Since routes/auth.js -> utils/mailer.js reads
// process.env.EMAIL_USER / EMAIL_APP_PASSWORD at import time, dotenv has to
// finish loading before that import line below runs, or those vars are still
// undefined (this was the cause of "Missing credentials for 'PLAIN'").
import "dotenv/config";

import express from "express";
import cors from "cors";

import { connectDatabases } from "./db.js";
import { loadStoredDriveToken } from "./utils/driveTokenStore.js";
import statsRoutes from "./routes/stats.js";
import coursesRoutes from "./routes/courses.js";
import recruitersRoutes from "./routes/recruiters.js";
import contactRoutes from "./routes/contact.js";
import applicationRoutes from "./routes/applications.js";
import admissionNoticeRoutes from "./routes/admissionNotices.js";
import authRoutes from "./routes/auth.js";
import studentAuthRoutes from "./routes/studentAuth.js";
import officeSignupRoutes from "./routes/officeSignup.js";
import officeMemberRoutes from "./routes/officeMembers.js";
import assessmentRoutes from "./routes/assessments.js";
import contentRoutes from "./routes/content.js";
import departmentRoutes from "./routes/department.js";
import examCellRoutes from "./routes/examCell.js";
import facultyRoutes from "./routes/faculty.js";
import taskRoutes from "./routes/tasks.js";
import studentRoutes from "./routes/student.js";
import ourStudentRoutes from "./routes/ourStudents.js";
import sheetSettingRoutes from "./routes/sheetSettings.js";
import discussionRoutes from "./routes/discussion.js";
import newsletterRoutes from "./routes/newsletters.js";
import placementRoutes from "./routes/placement.js";
import navigationRoutes from "./routes/navigation.js";
import resourceRoutes from "./routes/resources.js";
import mediaRoutes from "./routes/media.js";
import fileRoutes from "./routes/files.js";
import siteFileRoutes from "./routes/siteFiles.js";
import homeResourceRoutes from "./routes/homeResources.js";
import storageRoutes from "./routes/storage.js";
import * as sb from "./utils/supabase.js";
import { describeAccounts } from "./utils/media.js";
import { migrateRoles } from "./utils/migrateRoles.js";

const app = express();
// CLIENT_ORIGIN may hold several comma-separated origins (e.g. production + a Vercel preview URL).
// Trailing slashes are stripped because browsers send Origin without one.
const origins = String(process.env.CLIENT_ORIGIN || "").split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean);
if (process.env.NODE_ENV === "production" && !origins.length) console.warn("CLIENT_ORIGIN is not set: CORS is open to every site. Set it to your Vercel URL.");
app.use(cors({ origin: origins.length ? origins : "*" }));
app.use(express.json({ limit: "50mb" }));

app.use("/api/stats", statsRoutes);
app.use("/api/courses", coursesRoutes);
app.use("/api/recruiters", recruitersRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/applications", applicationRoutes);
app.use("/api/sheet-settings", sheetSettingRoutes);
app.use("/api/admission-notices", admissionNoticeRoutes);
// Office (staff) sign-in/sign-up and student sign-in/sign-up are separate doors,
// each backed by its own database.
app.use("/api/auth", authRoutes);
app.use("/api/student-auth", studentAuthRoutes);
app.use("/api/office-signup", officeSignupRoutes);
app.use("/api/office-members", officeMemberRoutes);
app.use("/api/assessments", assessmentRoutes);
app.use("/api/content", contentRoutes);
app.use("/api/department", departmentRoutes);
app.use("/api/exam-cell", examCellRoutes);
app.use("/api/faculty", facultyRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/student", studentRoutes);
app.use("/api/our-students", ourStudentRoutes);
app.use("/api/discussion", discussionRoutes);
app.use("/api/newsletters", newsletterRoutes);
app.use("/api/placement", placementRoutes);
app.use("/api/navigation", navigationRoutes);
app.use("/api/resources", resourceRoutes);
app.use("/api/media", mediaRoutes);
app.use("/api/files", fileRoutes);
app.use("/api/site-files", siteFileRoutes);
app.use("/api/home-resources", homeResourceRoutes);
app.use("/api/storage", storageRoutes);

app.get("/api/health", (req, res) => res.json({ ok: true, service: "srist-api" }));

// Safety net: catches anything that slips past a route's own try/catch
// (e.g. a synchronous throw) so it's always logged and always JSON, not a
// bare HTML error page.
app.use((err, req, res, next) => {
  console.error("Unhandled error on", req.method, req.originalUrl, ":", err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

const PORT = process.env.PORT || 5000;

connectDatabases()
  .then(async () => {
    const acc = describeAccounts(); // cloud names only — never secrets
    console.log(`Cloudinary website account: ${acc.website} | student account: ${acc.student}`);
    if (process.env.CLOUDINARY_URL && !process.env.CLOUDINARY_WEBSITE_URL) console.warn("CLOUDINARY_URL is being used as the WEBSITE account. Set CLOUDINARY_WEBSITE_URL and CLOUDINARY_STUDENT_URL explicitly.");
    await migrateRoles(); // old "editor" accounts -> "asst_prof"
    await loadStoredDriveToken(); // Google Drive sign-in made from the portal (if any)
    const fs = sb.describe(); // project id + bucket only — never keys
    console.log(`Supabase file storage: ${fs.project} | bucket: ${fs.bucket} | max file: ${fs.maxMB} MB`);
    if (fs.ready) {
      // Retries in the background (Supabase can be asleep or briefly return 504); uploads also retry on demand.
      const setup = (attempt = 1) => sb.prepareAll()
        .then(() => console.log("Supabase file storage: bucket and section folders are ready."))
        .catch((e) => {
          console.error(`Supabase file storage: setup attempt ${attempt} failed —`, e.message);
          if (attempt < 4) setTimeout(() => setup(attempt + 1), 15000 * attempt);
          else console.error("Supabase file storage: still unreachable. Check the project is not paused (Supabase dashboard) and that SUPABASE_URL / SUPABASE_SECRET_KEY are correct.");
        });
      setup();
    }
    else console.warn("Supabase file storage is NOT configured: set SUPABASE_URL and SUPABASE_SECRET_KEY in server/.env. Document uploads will be refused until then.");
    app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error("Database connection failed:", err.message);
    process.exit(1);
  });
