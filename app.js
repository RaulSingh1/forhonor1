require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const session = require("express-session");
const multer = require("multer");
const ffmpegPath = require("ffmpeg-static");

const {
  createUser,
  findUserByEmail,
  initializeUserStore,
  sanitizeUser,
  verifyPassword
} = require("./lib/userStore");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(__dirname, "public", "uploads");
const VIDEOS_FILE = path.join(DATA_DIR, "videos.json");
const MAX_VIDEOS = 4;
const VIDEO_FILE_PREFIX = "featured-video";
const PLAYABLE_VIDEO_MIME_TYPES = new Set(["video/mp4", "video/webm"]);

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || ".mp4";
      cb(null, `${VIDEO_FILE_PREFIX}-${Date.now()}-${crypto.randomUUID()}${ext}`);
    }
  }),
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: MAX_VIDEOS
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith("video/")) {
      cb(new Error("Only video files are allowed"));
      return;
    }

    cb(null, true);
  }
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "forhonor-dev-session-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false
    }
  })
);
app.use(express.static(path.join(__dirname, "public")));
const PUBLIC_API_BASE_URL = process.env.PUBLIC_API_BASE_URL || "";

app.use("/api", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});

function safeRedirectTarget(target) {
  if (typeof target !== "string") {
    return "/";
  }

  if (!target.startsWith("/") || target.startsWith("//")) {
    return "/";
  }

  return target;
}

function inferVideoMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();

  if (ext === ".webm") {
    return "video/webm";
  }

  if (ext === ".mp4" || ext === ".m4v") {
    return "video/mp4";
  }

  if (ext === ".mov") {
    return "video/quicktime";
  }

  return "video/mp4";
}

function normalizeVideoMimeType(mimeType, filename) {
  const ext = path.extname(filename).toLowerCase();

  if (ext === ".webm") {
    return "video/webm";
  }

  if (ext === ".mp4" || ext === ".m4v") {
    return "video/mp4";
  }

  if (ext === ".mov") {
    return "video/quicktime";
  }

  if (typeof mimeType === "string" && mimeType.startsWith("video/")) {
    return mimeType;
  }

  return "video/mp4";
}

function playableVideoFilename(filename) {
  return `${path.basename(filename, path.extname(filename))}.mp4`;
}

function transcodeVideoToMp4(sourcePath, targetPath) {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static er ikke tilgjengelig");
  }

  const result = spawnSync(
    ffmpegPath,
    [
      "-y",
      "-i",
      sourcePath,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      targetPath
    ],
    {
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString("utf8").trim() : "";
    throw new Error(stderr || `ffmpeg avsluttet med kode ${result.status}`);
  }
}

function normalizeStoredVideoRecord(record) {
  const sourceFilename = record.filename;
  const sourcePath = path.join(UPLOAD_DIR, sourceFilename);
  const currentMimeType = normalizeVideoMimeType(record.mimeType, sourceFilename);
  const currentExt = path.extname(sourceFilename).toLowerCase();

  if (currentMimeType === "video/webm" || currentExt === ".webm") {
    return {
      ...record,
      mimeType: "video/webm"
    };
  }

  if (currentExt !== ".mov" && currentExt !== ".m4v" && currentMimeType === "video/mp4") {
    return {
      ...record,
      mimeType: "video/mp4"
    };
  }

  const targetFilename = playableVideoFilename(sourceFilename);
  const targetPath = path.join(UPLOAD_DIR, targetFilename);

  if (!fs.existsSync(sourcePath)) {
    if (fs.existsSync(targetPath)) {
      return {
        ...record,
        filename: targetFilename,
        mimeType: "video/mp4"
      };
    }

    return {
      ...record,
      mimeType: currentMimeType === "video/quicktime" ? "video/mp4" : currentMimeType
    };
  }

  if (sourcePath !== targetPath && fs.existsSync(targetPath)) {
    try {
      fs.unlinkSync(sourcePath);
    } catch (error) {
      // Ignore cleanup failures.
    }

    return {
      ...record,
      filename: targetFilename,
      mimeType: "video/mp4"
    };
  }

  if (sourcePath !== targetPath) {
    transcodeVideoToMp4(sourcePath, targetPath);

    try {
      fs.unlinkSync(sourcePath);
    } catch (error) {
      // Ignore cleanup failures.
    }

    return {
      ...record,
      filename: targetFilename,
      mimeType: "video/mp4"
    };
  }

  return {
    ...record,
    mimeType: "video/mp4"
  };
}

function normalizeStoredVideoRecords(records) {
  let changed = false;

  const normalizedRecords = records.map((record) => {
    try {
      const normalizedRecord = normalizeStoredVideoRecord(record);
      if (
        normalizedRecord.filename !== record.filename ||
        normalizedRecord.mimeType !== record.mimeType
      ) {
        changed = true;
      }

      return normalizedRecord;
    } catch (error) {
      console.error(`Kunne ikke normalisere videoen ${record.filename}:`, error);
      return record;
    }
  });

  if (changed) {
    saveVideoRecords(normalizedRecords);
  }

  return normalizedRecords;
}

function readVideoRecordsFromDisk() {
  if (!fs.existsSync(VIDEOS_FILE)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(VIDEOS_FILE, "utf8").trim();
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    const existingFiles = new Set(fs.readdirSync(UPLOAD_DIR));

    return parsed
      .filter((record) => record && typeof record.filename === "string" && record.filename)
      .map((record) => ({
        id: typeof record.id === "string" && record.id ? record.id : crypto.randomUUID(),
        filename: record.filename,
        originalName:
          typeof record.originalName === "string" && record.originalName
            ? record.originalName
            : record.filename,
        mimeType:
          typeof record.mimeType === "string" && record.mimeType
            ? record.mimeType
            : inferVideoMimeType(record.filename),
        createdAt:
          typeof record.createdAt === "string" && record.createdAt
            ? record.createdAt
            : new Date().toISOString(),
        likes: Number.isInteger(record.likes) && record.likes >= 0 ? record.likes : 0
      }))
      .filter((record) => existingFiles.has(record.filename))
      .slice(0, MAX_VIDEOS);
  } catch (error) {
    console.error("Kunne ikke lese videos.json:", error);
    return [];
  }
}

function saveVideoRecords(records) {
  const payload = records.slice(0, MAX_VIDEOS).map((record) => ({
    id: record.id,
    filename: record.filename,
    originalName: record.originalName,
    mimeType: normalizeVideoMimeType(record.mimeType, record.filename),
    createdAt: record.createdAt,
    likes: Number.isInteger(record.likes) && record.likes >= 0 ? record.likes : 0
  }));

  fs.writeFileSync(VIDEOS_FILE, JSON.stringify(payload, null, 2));
}

function listLegacyVideoRecords() {
  const legacyFiles = fs
    .readdirSync(UPLOAD_DIR)
    .filter((file) => file === "featured-video.mp4" || file.startsWith(`${VIDEO_FILE_PREFIX}-`))
    .map((file) => ({
      file,
      mtimeMs: fs.statSync(path.join(UPLOAD_DIR, file)).mtimeMs
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_VIDEOS);

  return legacyFiles.map(({ file, mtimeMs }) => ({
    id: crypto.randomUUID(),
    filename: file,
    originalName: file,
    mimeType: inferVideoMimeType(file),
    createdAt: new Date(mtimeMs).toISOString(),
    likes: 0
  }));
}

function loadFeaturedVideoRecords() {
  let records = readVideoRecordsFromDisk();

  if (records.length === 0) {
    records = listLegacyVideoRecords();

    if (records.length > 0) {
      saveVideoRecords(records);
    }
  }

  return normalizeStoredVideoRecords(records).slice(0, MAX_VIDEOS);
}

function serializeVideoRecord(record) {
  return {
    id: record.id,
    filename: record.filename,
    originalName: record.originalName,
    mimeType: normalizeVideoMimeType(record.mimeType, record.filename),
    createdAt: record.createdAt,
    likes: Number.isInteger(record.likes) && record.likes >= 0 ? record.likes : 0,
    url: `/uploads/${encodeURIComponent(record.filename)}`
  };
}

async function storeUploadedVideos(uploadedFiles) {
  const currentRecords = loadFeaturedVideoRecords();
  const normalizedFiles = uploadedFiles.map((file) => {
    const sourcePath = path.join(UPLOAD_DIR, file.filename);
    const currentMimeType = normalizeVideoMimeType(file.mimetype, file.filename);
    const currentExt = path.extname(file.filename).toLowerCase();

    if (currentExt === ".mov" || currentExt === ".m4v") {
      const targetFilename = playableVideoFilename(file.filename);
      const targetPath = path.join(UPLOAD_DIR, targetFilename);

      transcodeVideoToMp4(sourcePath, targetPath);

      try {
        fs.unlinkSync(sourcePath);
      } catch (error) {
        // Ignore cleanup failures.
      }

      return {
        filename: targetFilename,
        originalName: file.originalname,
        mimeType: "video/mp4"
      };
    }

    return {
      filename: file.filename,
      originalName: file.originalname,
      mimeType: currentMimeType
    };
  });

  const newRecords = normalizedFiles.map((file) => ({
    id: crypto.randomUUID(),
    filename: file.filename,
    originalName: file.originalName,
    mimeType: file.mimeType,
    createdAt: new Date().toISOString(),
    likes: 0
  }));

  const combinedRecords = [...newRecords, ...currentRecords];
  const keptRecords = combinedRecords.slice(0, MAX_VIDEOS);
  const keptFileNames = new Set(keptRecords.map((record) => record.filename));
  const removedRecords = combinedRecords.slice(MAX_VIDEOS);

  saveVideoRecords(keptRecords);

  await Promise.all(
    removedRecords.map(async (record) => {
      if (keptFileNames.has(record.filename)) {
        return;
      }

      await fs.promises.unlink(path.join(UPLOAD_DIR, record.filename)).catch(() => {});
    })
  );

  return keptRecords;
}

function parseAuthMessage(query, page) {
  if (page === "login") {
    if (query.registered === "1") {
      return {
        type: "success",
        text: "Brukeren er opprettet. Logg inn med e-post og passord."
      };
    }

    if (query.error === "invalid_credentials") {
      return {
        type: "error",
        text: "Feil e-post eller passord."
      };
    }

    if (query.error === "missing_fields") {
      return {
        type: "error",
        text: "Fyll inn både e-post og passord."
      };
    }

    if (query.error === "admin_required") {
      return {
        type: "error",
        text: "Du må være logget inn som admin for å åpne adminpanelet."
      };
    }
  }

  if (page === "register") {
    if (query.error === "email_exists") {
      return {
        type: "error",
        text: "Denne e-posten er allerede registrert."
      };
    }

    if (query.error === "password_short") {
      return {
        type: "error",
        text: "Passordet må være minst 8 tegn."
      };
    }

    if (query.error === "password_mismatch") {
      return {
        type: "error",
        text: "Passordene er ikke like."
      };
    }

    if (query.error === "missing_fields") {
      return {
        type: "error",
        text: "Fyll inn e-post, brukernavn og passord."
      };
    }

    if (query.created === "1") {
      return {
        type: "success",
        text: "Brukeren ble opprettet. Du kan logge inn nå."
      };
    }
  }

  return null;
}

function parseUploadMessage(query) {
  if (query.upload === "success") {
    return {
      type: "success",
      text: "Videoene er lastet opp. Du kan bla mellom opptil 4 videoer."
    };
  }

  if (query.upload === "error") {
    return {
      type: "error",
      text: "Kun videofiler kan lastes opp."
    };
  }

  if (query.upload === "too_many") {
    return {
      type: "error",
      text: `Du kan laste opp maks ${MAX_VIDEOS} videoer av gangen.`
    };
  }

  if (query.upload === "file_size") {
    return {
      type: "error",
      text: "En av videofilene er for stor."
    };
  }

  return null;
}

function requireAdmin(req, res, next) {
  if (!req.session.user) {
    const redirectTo = encodeURIComponent(req.originalUrl || "/admin");
    res.redirect(`/login?redirect=${redirectTo}&error=admin_required`);
    return;
  }

  if (req.session.user.role !== "admin") {
    res.status(403).render("forbidden", {
      pageTitle: "Tilgang nektet - For Honor",
      bodyClass: "forbidden-page",
      message: "Kun administrator kan laste opp videoer og åpne dette panelet."
    });
    return;
  }

  next();
}

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.isAdmin = Boolean(req.session.user && req.session.user.role === "admin");
  res.locals.apiBaseUrl = PUBLIC_API_BASE_URL;
  res.locals.featuredVideos = loadFeaturedVideoRecords().map(serializeVideoRecord);
  next();
});

app.get("/", (req, res) => {
  res.render("index", {
    pageTitle: "For Honor - Kulturmøter",
    bodyClass: "home-page"
  });
});

app.get("/kilder", (req, res) => {
  res.render("kilder", {
    pageTitle: "Kilder - For Honor",
    bodyClass: "sources-page"
  });
});

app.get("/tema", (req, res) => {
  res.render("tema", {
    pageTitle: "Tema - Kulturkonflikt i For Honor",
    bodyClass: "theme-page"
  });
});

app.get("/sources", (req, res) => {
  res.redirect(302, "/kilder");
});

app.get("/login", (req, res) => {
  res.render("login", {
    pageTitle: "Logg inn - For Honor",
    bodyClass: "auth-page",
    redirectTo: safeRedirectTarget(req.query.redirect),
    email: typeof req.query.email === "string" ? req.query.email : "",
    message: parseAuthMessage(req.query, "login")
  });
});

app.post("/login", async (req, res, next) => {
  const email = String(req.body.email || "").trim();
  const password = String(req.body.password || "");
  const redirectTo = safeRedirectTarget(req.body.redirectTo);

  if (!email || !password) {
    res.render("login", {
      pageTitle: "Logg inn - For Honor",
      bodyClass: "auth-page",
      redirectTo,
      email,
      message: {
        type: "error",
        text: "Fyll inn både e-post og passord."
      }
    });
    return;
  }

  let user = null;

  try {
    user = await findUserByEmail(email);
  } catch (error) {
    next(error);
    return;
  }

  if (!user || !verifyPassword(password, user.passwordHash)) {
    res.render("login", {
      pageTitle: "Logg inn - For Honor",
      bodyClass: "auth-page",
      redirectTo,
      email,
      message: {
        type: "error",
        text: "Feil e-post eller passord."
      }
    });
    return;
  }

  req.session.regenerate((sessionError) => {
    if (sessionError) {
      next(sessionError);
      return;
    }

    req.session.user = sanitizeUser(user);

    req.session.save((saveError) => {
      if (saveError) {
        next(saveError);
        return;
      }

      res.redirect(303, redirectTo);
    });
  });
});

app.get("/register", (req, res) => {
  res.render("register", {
    pageTitle: "Lag bruker - For Honor",
    bodyClass: "auth-page",
    redirectTo: safeRedirectTarget(req.query.redirect),
    email: typeof req.query.email === "string" ? req.query.email : "",
    username: typeof req.query.username === "string" ? req.query.username : "",
    message: parseAuthMessage(req.query, "register")
  });
});

app.post("/register", async (req, res, next) => {
  const email = String(req.body.email || "").trim();
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const confirmPassword = String(req.body.confirmPassword || "");
  const redirectTo = safeRedirectTarget(req.body.redirectTo);

  if (!email || !username || !password || !confirmPassword) {
    res.render("register", {
      pageTitle: "Lag bruker - For Honor",
      bodyClass: "auth-page",
      redirectTo,
      email,
      username,
      message: {
        type: "error",
        text: "Fyll inn e-post, brukernavn og begge passordfeltene."
      }
    });
    return;
  }

  if (password.length < 8) {
    res.render("register", {
      pageTitle: "Lag bruker - For Honor",
      bodyClass: "auth-page",
      redirectTo,
      email,
      username,
      message: {
        type: "error",
        text: "Passordet må være minst 8 tegn."
      }
    });
    return;
  }

  if (password !== confirmPassword) {
    res.render("register", {
      pageTitle: "Lag bruker - For Honor",
      bodyClass: "auth-page",
      redirectTo,
      email,
      username,
      message: {
        type: "error",
        text: "Passordene er ikke like."
      }
    });
    return;
  }

  try {
    await createUser({ email, username, password, role: "user" });
  } catch (error) {
    if (error && error.message === "EMAIL_EXISTS") {
      res.render("register", {
        pageTitle: "Lag bruker - For Honor",
        bodyClass: "auth-page",
        redirectTo,
        email,
        username,
        message: {
          type: "error",
          text: "Denne e-posten er allerede registrert."
        }
      });
      return;
    }

    next(error);
    return;
  }

  res.redirect(
    303,
    `/login?registered=1&email=${encodeURIComponent(email)}&redirect=${encodeURIComponent(redirectTo)}`
  );
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect(303, "/");
  });
});

app.get("/admin", requireAdmin, (req, res) => {
  res.render("admin", {
    pageTitle: "Adminpanel - For Honor",
    bodyClass: "admin-page",
    uploadStatus: parseUploadMessage(req.query)
  });
});

function handleVideoUpload(req, res) {
  upload.any()(req, res, async (err) => {
    if (err) {
      console.error(err.message || err);

      if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
        return res.redirect(303, "/admin?upload=too_many");
      }

      if (err.code === "LIMIT_FILE_SIZE") {
        return res.redirect(303, "/admin?upload=file_size");
      }

      return res.redirect(303, "/admin?upload=error");
    }

    if (!req.files || req.files.length === 0) {
      return res.redirect(303, "/admin?upload=error");
    }

    try {
      await storeUploadedVideos(req.files);
      return res.redirect(303, "/admin?upload=success");
    } catch (storageError) {
      console.error(storageError);
      return res.redirect(303, "/admin?upload=error");
    }
  });
}

app.post("/admin/upload-video", requireAdmin, handleVideoUpload);
app.post("/admin/upload-videos", requireAdmin, handleVideoUpload);

function incrementVideoLike(videoId, callback) {
  const records = loadFeaturedVideoRecords();
  const recordIndex = records.findIndex((record) => record.id === videoId);

  if (recordIndex === -1) {
    callback(null, null);
    return;
  }

  try {
    const currentLikes = Number.isInteger(records[recordIndex].likes) && records[recordIndex].likes >= 0
      ? records[recordIndex].likes
      : 0;

    records[recordIndex].likes = currentLikes + 1;
    saveVideoRecords(records);
  } catch (error) {
    callback(error);
    return;
  }

  const updatedRecord = records[recordIndex];
  const likeCount = Number.isInteger(updatedRecord.likes) && updatedRecord.likes >= 0 ? updatedRecord.likes : 0;

  callback(null, {
    id: updatedRecord.id,
    likes: likeCount,
    record: serializeVideoRecord(updatedRecord)
  });
}

function handleLikeRequest(req, res, next) {
  const videoId = String(req.params.id || "").trim();

  if (!videoId) {
    res.status(400).json({ error: "missing_video_id" });
    return;
  }

  incrementVideoLike(videoId, (error, result) => {
    if (error) {
      next(error);
      return;
    }

    if (!result) {
      res.status(404).json({ error: "video_not_found" });
      return;
    }

    res.json({
      id: result.id,
      likes: result.likes,
      liked: true,
      video: result.record
    });
  });
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/videos", (req, res) => {
  res.json({
    videos: loadFeaturedVideoRecords().map(serializeVideoRecord)
  });
});

app.post("/api/videos/:id/like", handleLikeRequest);
app.post("/videos/:id/like", handleLikeRequest);

app.use((req, res) => {
  res.status(404).render("forbidden", {
    pageTitle: "Fant ikke siden - For Honor",
    bodyClass: "forbidden-page",
    message: "Siden finnes ikke."
  });
});

async function startServer() {
  try {
    await initializeUserStore();

    app.listen(PORT, HOST, () => {
      console.log(`Server kjører på http://${HOST}:${PORT}`);
    });
  } catch (error) {
    console.error("Kunne ikke starte serveren:", error);
    process.exit(1);
  }
}

startServer();
