const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const HASH_ALGORITHM = "sha512";
const HASH_ITERATIONS = 120000;
const HASH_KEYLEN = 64;
const HASH_PREFIX = "pbkdf2";

const ADMIN_SEED = {
  email: "admin@forhonor.no",
  username: "For Honor Admin",
  password: "Admin123!",
  role: "admin"
};

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeUsername(username) {
  return String(username || "").trim();
}

function ensureStoreFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2));
  }
}

function loadUsers() {
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

function saveUsers(users) {
  ensureStoreFiles();

  const payload = JSON.stringify(users, null, 2);
  fs.writeFileSync(USERS_FILE, payload);
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

function findUserByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  const users = loadUsers();
  return users.find((user) => user.email === normalizedEmail) || null;
}

function createUser({ email, username, password, role = "user" }) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedUsername = normalizeUsername(username);
  const users = loadUsers();

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
  saveUsers(users);

  return user;
}

function ensureAdminUser() {
  const users = loadUsers();
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

  saveUsers(users);
}

function initializeUserStore() {
  ensureStoreFiles();
  ensureAdminUser();
}

module.exports = {
  ADMIN_SEED,
  createUser,
  findUserByEmail,
  hashPassword,
  initializeUserStore,
  loadUsers,
  normalizeEmail,
  normalizeUsername,
  sanitizeUser,
  saveUsers,
  ensureAdminUser,
  verifyPassword
};
