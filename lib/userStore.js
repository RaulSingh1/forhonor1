const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const DATA_DIR = path.join(__dirname, "..", "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const HASH_ALGORITHM = "sha512";
const HASH_ITERATIONS = 120000;
const HASH_KEYLEN = 64;
const HASH_PREFIX = "pbkdf2";
const MONGODB_URI = process.env.MONGODB_URI || "";
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "forhonor";
const USERS_COLLECTION = "users";

const ADMIN_SEED = {
  email: "admin@forhonor.no",
  username: "For Honor Admin",
  password: "Admin123!",
  role: "admin"
};

let mongoClient = null;
let usersCollection = null;
let usingFileFallback = false;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeUsername(username) {
  return String(username || "").trim();
}

function loadLegacyUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(USERS_FILE, "utf8").trim();
    if (!raw) {
      return [];
    }

    const users = JSON.parse(raw);
    return Array.isArray(users) ? users : [];
  } catch (error) {
    console.error("Kunne ikke lese gamle users.json:", error);
    return [];
  }
}

function ensureStoreFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2));
  }
}

function loadFileUsers() {
  ensureStoreFiles();

  try {
    const raw = fs.readFileSync(USERS_FILE, "utf8").trim();
    if (!raw) {
      return [];
    }

    const users = JSON.parse(raw);
    return Array.isArray(users) ? users : [];
  } catch (error) {
    console.error("Kunne ikke lese users.json:", error);
    return [];
  }
}

function saveFileUsers(users) {
  ensureStoreFiles();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto
    .pbkdf2Sync(password, salt, HASH_ITERATIONS, HASH_KEYLEN, HASH_ALGORITHM)
    .toString("hex");

  return `${HASH_PREFIX}$${HASH_ITERATIONS}$${salt}$${derived}`;
}

function verifyPassword(password, storedHash) {
  if (typeof storedHash !== "string") {
    return false;
  }

  const parts = storedHash.split("$");

  if (parts.length !== 4 || parts[0] !== HASH_PREFIX) {
    return false;
  }

  const iterations = Number(parts[1]);
  const salt = parts[2];
  const expectedHex = parts[3];

  if (!Number.isInteger(iterations) || !salt || !expectedHex) {
    return false;
  }

  const actualHex = crypto
    .pbkdf2Sync(password, salt, iterations, HASH_KEYLEN, HASH_ALGORITHM)
    .toString("hex");

  if (actualHex.length !== expectedHex.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(actualHex, "hex"),
    Buffer.from(expectedHex, "hex")
  );
}

function sanitizeUser(user) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt
  };
}

function requireUsersCollection() {
  if (usingFileFallback) {
    return null;
  }

  if (!usersCollection) {
    throw new Error("MongoDB er ikke initialisert. Sjekk MONGODB_URI.");
  }

  return usersCollection;
}

async function findUserByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  const collection = requireUsersCollection();

  if (!collection) {
    const users = loadFileUsers();
    return users.find((user) => user.email === normalizedEmail) || null;
  }

  return collection.findOne({ email: normalizedEmail });
}

async function createUser({ email, username, password, role = "user" }) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedUsername = normalizeUsername(username);
  const collection = requireUsersCollection();

  if (!collection) {
    const users = loadFileUsers();

    if (users.some((user) => user.email === normalizedEmail)) {
      throw new Error("EMAIL_EXISTS");
    }

    const now = new Date().toISOString();
    const user = {
      id: crypto.randomUUID(),
      email: normalizedEmail,
      username: normalizedUsername,
      passwordHash: hashPassword(password),
      role,
      createdAt: now
    };

    users.push(user);
    saveFileUsers(users);

    return user;
  }

  const existingUser = await collection.findOne({ email: normalizedEmail });
  if (existingUser) {
    throw new Error("EMAIL_EXISTS");
  }

  const now = new Date().toISOString();
  const user = {
    id: crypto.randomUUID(),
    email: normalizedEmail,
    username: normalizedUsername,
    passwordHash: hashPassword(password),
    role,
    createdAt: now
  };

  await collection.insertOne(user);
  return user;
}

async function ensureAdminUser() {
  const collection = requireUsersCollection();

  if (!collection) {
    const users = loadFileUsers();
    const adminEmail = normalizeEmail(ADMIN_SEED.email);
    const adminExists = users.some((user) => user.role === "admin" || user.email === adminEmail);

    if (adminExists) {
      return;
    }

    users.push({
      id: crypto.randomUUID(),
      email: adminEmail,
      username: normalizeUsername(ADMIN_SEED.username),
      passwordHash: hashPassword(ADMIN_SEED.password),
      role: ADMIN_SEED.role,
      createdAt: new Date().toISOString()
    });

    saveFileUsers(users);
    return;
  }

  const adminEmail = normalizeEmail(ADMIN_SEED.email);
  const adminExists = await collection.findOne({
    $or: [{ role: "admin" }, { email: adminEmail }]
  });

  if (adminExists) {
    return;
  }

  await collection.insertOne({
    id: crypto.randomUUID(),
    email: adminEmail,
    username: normalizeUsername(ADMIN_SEED.username),
    passwordHash: hashPassword(ADMIN_SEED.password),
    role: ADMIN_SEED.role,
    createdAt: new Date().toISOString()
  });
}

async function migrateLegacyUsersIfEmpty() {
  const collection = requireUsersCollection();
  const existingCount = await collection.countDocuments();

  if (existingCount > 0) {
    return;
  }

  const legacyUsers = loadLegacyUsers()
    .filter((user) => user && user.email && user.passwordHash)
    .map((user) => ({
      ...user,
      email: normalizeEmail(user.email),
      username: normalizeUsername(user.username),
      id: user.id || crypto.randomUUID(),
      role: user.role || "user",
      createdAt: user.createdAt || new Date().toISOString()
    }));

  if (legacyUsers.length > 0) {
    await collection.insertMany(legacyUsers, { ordered: false });
    console.log(`Migrerte ${legacyUsers.length} brukere fra data/users.json til MongoDB.`);
  }
}

async function initializeUserStore() {
  if (!MONGODB_URI) {
    usingFileFallback = true;
    console.warn("MONGODB_URI mangler. Bruker data/users.json som midlertidig fallback.");
    await ensureAdminUser();
    return;
  }

  mongoClient = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000
  });

  try {
    await mongoClient.connect();

    const db = mongoClient.db(MONGODB_DB_NAME);
    usersCollection = db.collection(USERS_COLLECTION);
    usingFileFallback = false;
    await usersCollection.createIndex({ email: 1 }, { unique: true });
  } catch (error) {
    console.warn(`MongoDB er ikke tilgjengelig (${error.message}). Bruker data/users.json som midlertidig fallback.`);
    await mongoClient.close().catch(() => {});
    mongoClient = null;
    usersCollection = null;
    usingFileFallback = true;
    await ensureAdminUser();
    return;
  }

  await migrateLegacyUsersIfEmpty();
  await ensureAdminUser();
}

async function closeUserStore() {
  if (mongoClient) {
    await mongoClient.close();
    mongoClient = null;
    usersCollection = null;
  }
}

module.exports = {
  ADMIN_SEED,
  closeUserStore,
  createUser,
  findUserByEmail,
  hashPassword,
  initializeUserStore,
  normalizeEmail,
  normalizeUsername,
  sanitizeUser,
  ensureAdminUser,
  verifyPassword
};
