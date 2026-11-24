"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT) || 4174;
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "cougou.sqlite");
const SESSION_COOKIE = "cougou_session";
const SESSION_AGE_SECONDS = 60 * 60 * 24 * 30;
const CONFIGURED_ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || "").trim();

const MEALS = new Set(["breakfast", "lunch", "dinner", "snack"]);
const COOK_SLOTS = new Set(["morning", "afternoon"]);
const MEAL_LABELS = { breakfast: "早餐", lunch: "午餐", dinner: "晚餐", snack: "加餐" };
const INGREDIENT_CATEGORIES = new Set([
  "staple",
  "protein",
  "vegetable",
  "fruit",
  "drink",
  "other",
]);
const INVITE_ROLES = new Set(["editor", "viewer"]);
const MEMBER_ROLES = new Set(["editor", "viewer"]);
const USERNAME_RE = /^[\p{L}\p{N}_-]{3,24}$/u;

fs.mkdirSync(DATA_DIR, { recursive: true });
try {
  fs.chmodSync(DATA_DIR, 0o700);
} catch (error) {
  // Some platforms do not support POSIX modes.
}

const db = new DatabaseSync(DB_FILE);
try {
  fs.chmodSync(DB_FILE, 0o600);
} catch (error) {
  // Some platforms do not support POSIX modes.
}
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kitchens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    daily_target INTEGER NOT NULL DEFAULT 1800,
    revision INTEGER NOT NULL DEFAULT 1,
    is_sample INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memberships (
    kitchen_id TEXT NOT NULL REFERENCES kitchens(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    joined_at TEXT NOT NULL,
    PRIMARY KEY (kitchen_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS ingredients (
    id TEXT PRIMARY KEY,
    kitchen_id TEXT NOT NULL REFERENCES kitchens(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    calories INTEGER NOT NULL CHECK (calories >= 0 AND calories <= 5000),
    unit TEXT NOT NULL DEFAULT '1 份',
    category TEXT NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS plan_items (
    id TEXT PRIMARY KEY,
    kitchen_id TEXT NOT NULL REFERENCES kitchens(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    meal TEXT NOT NULL CHECK (meal IN ('breakfast', 'lunch', 'dinner', 'snack')),
    name TEXT NOT NULL,
    calories INTEGER NOT NULL CHECK (calories >= 0 AND calories <= 5000),
    position INTEGER NOT NULL DEFAULT 0,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_plan_items_kitchen_date
    ON plan_items (kitchen_id, date, meal, position);

  CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    kitchen_id TEXT NOT NULL REFERENCES kitchens(id) ON DELETE CASCADE,
    code TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_invites_kitchen ON invites (kitchen_id, revoked, expires_at);

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    kitchen_id TEXT NOT NULL REFERENCES kitchens(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_kitchen_created
    ON messages (kitchen_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS sleep_logs (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    bedtime TEXT NOT NULL,
    wake_time TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, date)
  );

  CREATE TABLE IF NOT EXISTS exercise_logs (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    calories INTEGER NOT NULL CHECK (calories >= 0 AND calories <= 5000),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, date)
  );

  CREATE TABLE IF NOT EXISTS week_templates (
    id TEXT PRIMARY KEY,
    kitchen_id TEXT NOT NULL REFERENCES kitchens(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_week_templates_kitchen
    ON week_templates (kitchen_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS meal_favorites (
    id TEXT PRIMARY KEY,
    kitchen_id TEXT NOT NULL REFERENCES kitchens(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    meal TEXT NOT NULL CHECK (meal IN ('breakfast', 'lunch', 'dinner', 'snack')),
    items TEXT NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_meal_favorites_kitchen
    ON meal_favorites (kitchen_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS day_cooks (
    kitchen_id TEXT NOT NULL REFERENCES kitchens(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (kitchen_id, date)
  );

  CREATE TABLE IF NOT EXISTS day_cook_slots (
    kitchen_id TEXT NOT NULL REFERENCES kitchens(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    slot TEXT NOT NULL CHECK (slot IN ('morning', 'afternoon')),
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (kitchen_id, date, slot)
  );

  CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS meal_polls (
    id TEXT PRIMARY KEY,
    kitchen_id TEXT NOT NULL REFERENCES kitchens(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_meal_polls_kitchen
    ON meal_polls (kitchen_id, status, created_at DESC);

  CREATE TABLE IF NOT EXISTS poll_options (
    id TEXT PRIMARY KEY,
    poll_id TEXT NOT NULL REFERENCES meal_polls(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_poll_options_poll
    ON poll_options (poll_id, position);

  CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id TEXT NOT NULL REFERENCES meal_polls(id) ON DELETE CASCADE,
    option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (poll_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS grocery_duties (
    id TEXT PRIMARY KEY,
    kitchen_id TEXT NOT NULL REFERENCES kitchens(id) ON DELETE CASCADE,
    week_start TEXT NOT NULL,
    day_index INTEGER,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    note TEXT NOT NULL DEFAULT '',
    done INTEGER NOT NULL DEFAULT 0,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_grocery_duties_kitchen_week
    ON grocery_duties (kitchen_id, week_start, day_index);
`);

// Migrate databases created before the admin console existed.
const userColumns = db.prepare("PRAGMA table_info(users)").all();
if (!userColumns.some((column) => column.name === "is_admin")) {
  db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
}

if (CONFIGURED_ADMIN_USERNAME) {
  const configured = db
    .prepare("SELECT id, username, is_admin FROM users WHERE username = ?")
    .get(CONFIGURED_ADMIN_USERNAME);
  if (configured && !configured.is_admin) {
    db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(configured.id);
    console.log(`已将 ADMIN_USERNAME 指定的账号 ${configured.username} 设为管理员。`);
  }
}

// Split the old one-cook-per-day assignments into morning/afternoon slots once.
// Existing assignments are copied to both slots so no data is lost.
const dayCookSplitMigration = db
  .prepare("SELECT 1 AS done FROM schema_migrations WHERE id = ?")
  .get("day_cooks_split_v1");
if (!dayCookSplitMigration) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(
      `INSERT OR IGNORE INTO day_cook_slots (kitchen_id, date, slot, user_id, assigned_by, updated_at)
       SELECT kitchen_id, date, 'morning', user_id, assigned_by, updated_at
       FROM day_cooks WHERE user_id IS NOT NULL`,
    );
    db.exec(
      `INSERT OR IGNORE INTO day_cook_slots (kitchen_id, date, slot, user_id, assigned_by, updated_at)
       SELECT kitchen_id, date, 'afternoon', user_id, assigned_by, updated_at
       FROM day_cooks WHERE user_id IS NOT NULL`,
    );
    db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run("day_cooks_split_v1");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/* =========================================================
   Small helpers
   ========================================================= */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function nowISO() {
  return new Date().toISOString();
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function dateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDateKey(key) {
  if (typeof key !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const parts = key.split("-").map(Number);
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  return dateKey(date) === key ? date : null;
}

function startOfWeek(date) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = (result.getDay() + 6) % 7;
  result.setDate(result.getDate() - offset);
  return result;
}

function addDays(date, amount) {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

function normalizeWeekStart(value) {
  const date = parseDateKey(value);
  if (!date) throw new HttpError(400, "周份日期格式不正确。");
  return dateKey(startOfWeek(date));
}

function weekDateKeys(weekStart) {
  const start = parseDateKey(weekStart);
  return Array.from({ length: 7 }, (_, index) => dateKey(addDays(start, index)));
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
}

function normalizeCalories(value) {
  const calories = Number(value);
  if (!Number.isFinite(calories) || calories < 0 || calories > 5000) {
    throw new HttpError(400, "热量需要在 0–5,000 kcal 之间。");
  }
  return Math.round(calories);
}

function normalizeDailyTarget(value) {
  const target = Number(value);
  if (!Number.isFinite(target) || target < 500 || target > 6000) {
    throw new HttpError(400, "每日目标需要在 500–6,000 kcal 之间。");
  }
  return Math.round(target);
}

/* =========================================================
   Passwords, sessions, cookies
   ========================================================= */

const DUMMY_PASSWORD_HASH = hashPassword("not-a-real-password");

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.scryptSync(password, salt, 64).toString("base64url");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [algorithm, salt, expected] = String(stored).split("$");
    if (algorithm !== "scrypt" || !salt || !expected) return false;
    const derived = crypto.scryptSync(password, salt, 64);
    const expectedBuffer = Buffer.from(expected, "base64url");
    return derived.length === expectedBuffer.length && crypto.timingSafeEqual(derived, expectedBuffer);
  } catch (error) {
    return false;
  }
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function parseCookies(req) {
  const result = {};
  const header = req.headers.cookie;
  if (!header) return result;
  header.split(";").forEach((chunk) => {
    const index = chunk.indexOf("=");
    if (index === -1) return;
    const key = chunk.slice(0, index).trim();
    const value = chunk.slice(index + 1).trim();
    if (key) result[key] = value;
  });
  return result;
}

function isSecureRequest(req) {
  return Boolean(req.socket.encrypted) || req.headers["x-forwarded-proto"] === "https";
}

function sessionCookie(req, token, maxAge) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (isSecureRequest(req)) parts.push("Secure");
  return parts.join("; ");
}

function clearSessionCookie(req) {
  return sessionCookie(req, "", 0);
}

function createSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const createdAt = nowISO();
  const expiresAt = new Date(Date.now() + SESSION_AGE_SECONDS * 1000).toISOString();
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  ).run(hashToken(token), userId, createdAt, expiresAt);
  res.setHeader("Set-Cookie", sessionCookie(req, token, SESSION_AGE_SECONDS));
  return token;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  const row = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.is_admin, u.created_at, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(hashToken(token), nowISO());

  return row || null;
}

function deleteCurrentSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  }
}

function pruneExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowISO());
}

/* =========================================================
   HTTP helpers
   ========================================================= */

function baseSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
}

function sendJson(res, status, data) {
  const payload = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    let tooLarge = false;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 100_000) {
        tooLarge = true;
        return;
      }
      body += chunk;
    });

    req.on("end", () => {
      if (tooLarge) {
        reject(new HttpError(413, "请求内容过大。"));
        return;
      }
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new HttpError(400, "请求内容不是有效的 JSON。"));
      }
    });

    req.on("error", reject);
  });
}

function assertMutationRequest(req) {
  if (req.headers["x-cougou-client"] !== "web") {
    throw new HttpError(403, "请求来源校验失败。");
  }
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) {
        throw new HttpError(403, "跨站请求已被拒绝。");
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(403, "请求来源无效。");
    }
  }
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isAdmin: Boolean(row.is_admin),
    createdAt: row.created_at,
  };
}

function mapKitchen(row) {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    dailyTarget: row.daily_target,
    revision: row.revision,
    isSample: Boolean(row.is_sample),
    role: row.role,
    memberCount: Number(row.member_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* =========================================================
   Kitchen / membership queries
   ========================================================= */

function getMemberships(userId) {
  return db
    .prepare(
      `SELECT k.id, k.name, k.owner_id, k.daily_target, k.revision, k.is_sample,
              k.created_at, k.updated_at, m.role, u.display_name AS owner_name,
              (SELECT COUNT(*) FROM memberships cm WHERE cm.kitchen_id = k.id) AS member_count
       FROM memberships m
       JOIN kitchens k ON k.id = m.kitchen_id
       JOIN users u ON u.id = k.owner_id
       WHERE m.user_id = ?
       ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, k.updated_at DESC`,
    )
    .all(userId)
    .map(mapKitchen);
}

function getKitchenSummary(kitchenId, userId) {
  const row = db
    .prepare(
      `SELECT k.id, k.name, k.owner_id, k.daily_target, k.revision, k.is_sample,
              k.created_at, k.updated_at, m.role, u.display_name AS owner_name,
              (SELECT COUNT(*) FROM memberships cm WHERE cm.kitchen_id = k.id) AS member_count
       FROM kitchens k
       JOIN memberships m ON m.kitchen_id = k.id AND m.user_id = ?
       JOIN users u ON u.id = k.owner_id
       WHERE k.id = ?`,
    )
    .get(userId, kitchenId);
  return row ? mapKitchen(row) : null;
}

function getMembers(kitchenId) {
  return db
    .prepare(
      `SELECT u.id, u.username, u.display_name, m.role, m.joined_at
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.kitchen_id = ?
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,
                m.joined_at ASC`,
    )
    .all(kitchenId)
    .map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      joinedAt: row.joined_at,
    }));
}

function getActiveInvites(kitchenId) {
  return db
    .prepare(
      `SELECT i.id, i.code, i.role, i.expires_at, i.created_at, u.display_name AS creator_name
       FROM invites i
       JOIN users u ON u.id = i.created_by
       WHERE i.kitchen_id = ? AND i.revoked = 0 AND i.expires_at > ?
       ORDER BY i.created_at DESC`,
    )
    .all(kitchenId, nowISO())
    .map((row) => ({
      id: row.id,
      code: row.code,
      role: row.role,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      creatorName: row.creator_name,
    }));
}

function getMessages(kitchenId, limit = 50) {
  return db
    .prepare(
      `SELECT m.id, m.content, m.created_at, m.user_id,
              u.display_name AS author_name
       FROM messages m JOIN users u ON u.id = m.user_id
       WHERE m.kitchen_id = ?
       ORDER BY m.created_at DESC
       LIMIT ?`,
    )
    .all(kitchenId, limit)
    .map((row) => ({
      id: row.id,
      content: row.content,
      authorId: row.user_id,
      authorName: row.author_name,
      createdAt: row.created_at,
    }));
}

function getKitchenDetail(kitchenId, userId) {
  const kitchen = getKitchenSummary(kitchenId, userId);
  if (!kitchen) return null;
  const members = getMembers(kitchenId);
  const invites = kitchen.role === "owner" ? getActiveInvites(kitchenId) : [];
  return {
    kitchen,
    members,
    invites,
    messages: getMessages(kitchenId),
    favorites: getFavorites(kitchenId),
  };
}

function requireMembership(kitchenId, userId, { edit = false, owner = false } = {}) {
  const kitchen = getKitchenSummary(kitchenId, userId);
  if (!kitchen) throw new HttpError(404, "厨房不存在，或你还不是这个厨房的成员。");
  if (owner && kitchen.role !== "owner") {
    throw new HttpError(403, "只有厨房主人可以执行这个操作。");
  }
  if (edit && kitchen.role === "viewer") {
    throw new HttpError(403, "你是访客，暂时不能修改这个厨房。");
  }
  return kitchen;
}

function touchKitchen(kitchenId, { clearSample = false } = {}) {
  const updatedAt = nowISO();
  if (clearSample) {
    db.prepare(
      "UPDATE kitchens SET revision = revision + 1, updated_at = ?, is_sample = 0 WHERE id = ?",
    ).run(updatedAt, kitchenId);
  } else {
    db.prepare("UPDATE kitchens SET revision = revision + 1, updated_at = ? WHERE id = ?").run(
      updatedAt,
      kitchenId,
    );
  }
  const row = db.prepare("SELECT revision FROM kitchens WHERE id = ?").get(kitchenId);
  return row ? row.revision : 0;
}

/* =========================================================
   Seed data
   ========================================================= */

const STARTER_INGREDIENTS = [
  ["米饭", 232, "1 碗", "staple"],
  ["全麦吐司", 120, "2 片", "staple"],
  ["乌冬面", 220, "1 份", "staple"],
  ["藜麦", 180, "1 碗", "staple"],
  ["鸡胸肉", 165, "100 g", "protein"],
  ["三文鱼", 208, "100 g", "protein"],
  ["水煮蛋", 78, "1 个", "protein"],
  ["嫩豆腐", 84, "100 g", "protein"],
  ["牛腩", 250, "100 g", "protein"],
  ["西兰花", 34, "100 g", "vegetable"],
  ["菠菜", 28, "100 g", "vegetable"],
  ["番茄", 20, "1 个", "vegetable"],
  ["黄瓜", 16, "100 g", "vegetable"],
  ["蓝莓", 45, "50 g", "fruit"],
  ["香蕉", 89, "1 根", "fruit"],
  ["苹果", 95, "1 个", "fruit"],
  ["无糖酸奶", 90, "1 杯", "drink"],
  ["豆浆", 120, "1 杯", "drink"],
  ["美式咖啡", 5, "1 杯", "drink"],
  ["橄榄油", 40, "1 茶匙", "other"],
  ["黑巧克力", 70, "1 块", "other"],
];

const DEMO_PLAN = [
  {
    breakfast: [["牛油果吐司", 320], ["水煮蛋", 78]],
    lunch: [["番茄牛腩饭", 620], ["清炒西兰花", 95]],
    dinner: [["香煎三文鱼", 340], ["藜麦沙拉", 210]],
    snack: [["无糖酸奶", 90], ["蓝莓", 45]],
  },
  {
    breakfast: [["小米南瓜粥", 210], ["茶叶蛋", 80]],
    lunch: [["照烧鸡腿饭", 580], ["凉拌黄瓜", 60]],
    dinner: [["虾仁豆腐煲", 320], ["蒜蓉菠菜", 90]],
    snack: [["香蕉", 89], ["巴旦木", 120]],
  },
  {
    breakfast: [["全麦贝果", 260], ["奶油奶酪", 90], ["美式咖啡", 5]],
    lunch: [["泰式青咖喱鸡", 480], ["茉莉香米饭", 230]],
    dinner: [["番茄鸡蛋面", 460], ["凉拌木耳", 75]],
    snack: [["苹果", 95]],
  },
  {
    breakfast: [["希腊酸奶碗", 280], ["蜂蜜", 40]],
    lunch: [["牛肉彩椒碗", 520], ["玉米", 120]],
    dinner: [["味噌豆腐汤", 160], ["烤秋刀鱼", 280], ["糙米饭", 180]],
    snack: [["黑巧克力", 70]],
  },
  {
    breakfast: [["芝士蛋饼", 350], ["豆浆", 120]],
    lunch: [["冬阴功海鲜面", 560]],
    dinner: [["烤鸡胸沙拉", 380], ["南瓜浓汤", 150]],
    snack: [["葡萄", 80]],
  },
  {
    breakfast: [["舒芙蕾松饼", 420], ["拿铁", 130]],
    lunch: [["寿喜锅", 680], ["乌冬面", 220]],
    dinner: [["牛油果鸡肉卷", 430]],
    snack: [["草莓", 55]],
  },
  {
    breakfast: [["皮蛋瘦肉粥", 300], ["油条", 190]],
    lunch: [["家庭烤肉", 720], ["生菜包菜", 80]],
    dinner: [["菌菇鸡汤", 260], ["杂粮饭", 190]],
    snack: [["橙子", 62]],
  },
];

function seedIngredients(kitchenId, userId) {
  const createdAt = nowISO();
  const insert = db.prepare(
    `INSERT INTO ingredients
      (id, kitchen_id, name, calories, unit, category, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  STARTER_INGREDIENTS.forEach(([name, calories, unit, category]) => {
    insert.run(
      newId("ing"),
      kitchenId,
      name,
      calories,
      unit,
      category,
      userId,
      createdAt,
      createdAt,
    );
  });
}

function seedSamplePlan(kitchenId, userId) {
  const weekStart = dateKey(startOfWeek(new Date()));
  const createdAt = nowISO();
  const insert = db.prepare(
    `INSERT INTO plan_items
      (id, kitchen_id, date, meal, name, calories, position, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  weekDateKeys(weekStart).forEach((date, dayIndex) => {
    Object.entries(DEMO_PLAN[dayIndex]).forEach(([meal, items]) => {
      items.forEach(([name, calories], position) => {
        insert.run(
          newId("itm"),
          kitchenId,
          date,
          meal,
          name,
          calories,
          position,
          userId,
          createdAt,
          createdAt,
        );
      });
    });
  });
}

function createKitchenRecord(ownerId, ownerDisplayName, name, { withSamplePlan = false } = {}) {
  const kitchenId = newId("kit");
  const createdAt = nowISO();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO kitchens
        (id, name, owner_id, daily_target, revision, is_sample, created_at, updated_at)
       VALUES (?, ?, ?, 1800, 1, ?, ?, ?)`,
    ).run(kitchenId, name, ownerId, withSamplePlan ? 1 : 0, createdAt, createdAt);
    db.prepare(
      "INSERT INTO memberships (kitchen_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
    ).run(kitchenId, ownerId, createdAt);
    seedIngredients(kitchenId, ownerId);
    if (withSamplePlan) seedSamplePlan(kitchenId, ownerId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return getKitchenSummary(kitchenId, ownerId);
}

/* =========================================================
   Plan queries
   ========================================================= */

function getPlan(kitchenId, userId, weekStart) {
  const kitchen = requireMembership(kitchenId, userId);
  const normalized = normalizeWeekStart(weekStart);
  const dates = weekDateKeys(normalized);

  const days = {};
  dates.forEach((key) => {
    days[key] = { breakfast: [], lunch: [], dinner: [], snack: [] };
  });

  const rows = db
    .prepare(
      `SELECT id, date, meal, name, calories, position
       FROM plan_items
       WHERE kitchen_id = ? AND date >= ? AND date <= ?
       ORDER BY date ASC, position ASC, created_at ASC`,
    )
    .all(kitchenId, dates[0], dates[6]);

  rows.forEach((row) => {
    if (!days[row.date] || !MEALS.has(row.meal)) return;
    days[row.date][row.meal].push({
      id: row.id,
      name: row.name,
      calories: row.calories,
    });
  });

  let cooks = {};
  try {
    cooks = getCooks(kitchenId, dates[0], dates[6]);
  } catch (error) {
    console.error("[cougou] 无法读取掌勺安排：", error);
  }

  return {
    weekStart: normalized,
    days,
    cooks,
    dailyTarget: kitchen.dailyTarget,
    revision: kitchen.revision,
    canEdit: kitchen.role !== "viewer",
    role: kitchen.role,
  };
}

function nextPosition(kitchenId, date, meal) {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next_position
       FROM plan_items WHERE kitchen_id = ? AND date = ? AND meal = ?`,
    )
    .get(kitchenId, date, meal);
  return Number(row?.next_position || 0);
}

function validatePlanPayload(body, weekStart) {
  const date = String(body.date || "");
  if (!parseDateKey(date)) throw new HttpError(400, "日期格式不正确。");
  if (weekStart) {
    const start = parseDateKey(weekStart);
    const end = dateKey(addDays(start, 6));
    if (date < weekStart || date > end) throw new HttpError(400, "日期不在当前周内。");
  }
  const meal = String(body.meal || "");
  if (!MEALS.has(meal)) throw new HttpError(400, "餐次不正确。");
  const name = cleanText(body.name, 40);
  if (!name) throw new HttpError(400, "请填写食物名称。");
  const calories = normalizeCalories(body.calories);
  return { date, meal, name, calories };
}

/* =========================================================
   Week copy, templates & meal favorites
   ========================================================= */

function readWeekItems(kitchenId, weekStart) {
  const dates = weekDateKeys(weekStart);
  return db
    .prepare(
      `SELECT date, meal, name, calories, position
       FROM plan_items
       WHERE kitchen_id = ? AND date >= ? AND date <= ?
       ORDER BY date ASC, position ASC, created_at ASC`,
    )
    .all(kitchenId, dates[0], dates[6]);
}

function weekPayloadFromRows(rows, weekStart) {
  const dates = weekDateKeys(weekStart);
  const indexByDate = new Map(dates.map((date, index) => [date, index]));
  const days = dates.map(() => ({ breakfast: [], lunch: [], dinner: [], snack: [] }));
  rows.forEach((row) => {
    const index = indexByDate.get(row.date);
    if (index === undefined || !MEALS.has(row.meal)) return;
    days[index][row.meal].push({ name: row.name, calories: row.calories });
  });
  return { days };
}

function normalizeTemplatePayload(raw) {
  const sourceDays = Array.isArray(raw?.days) ? raw.days.slice(0, 7) : [];
  return Array.from({ length: 7 }, (_, index) => {
    const source = sourceDays[index] && typeof sourceDays[index] === "object" ? sourceDays[index] : {};
    const day = { breakfast: [], lunch: [], dinner: [], snack: [] };
    Object.keys(day).forEach((meal) => {
      const items = Array.isArray(source[meal]) ? source[meal].slice(0, 20) : [];
      items.forEach((item) => {
        const name = cleanText(item?.name, 40);
        const calories = Number(item?.calories);
        if (!name || !Number.isFinite(calories) || calories < 0 || calories > 5000) return;
        day[meal].push({ name, calories: Math.round(calories) });
      });
    });
    return day;
  });
}

function templateStats(days) {
  let itemCount = 0;
  let totalCalories = 0;
  let dayCount = 0;
  days.forEach((day) => {
    let dayItems = 0;
    Object.values(day).forEach((items) => {
      itemCount += items.length;
      dayItems += items.length;
      items.forEach((item) => {
        totalCalories += item.calories;
      });
    });
    if (dayItems) dayCount += 1;
  });
  return { itemCount, totalCalories, dayCount };
}

function mapTemplate(row) {
  let payload = {};
  try {
    payload = JSON.parse(row.payload);
  } catch (error) {
    payload = {};
  }
  const days = normalizeTemplatePayload(payload);
  return {
    id: row.id,
    name: row.name,
    days,
    ...templateStats(days),
    creatorId: row.created_by,
    creatorName: row.creator_name || "已离开的成员",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getTemplates(kitchenId) {
  return db
    .prepare(
      `SELECT t.id, t.name, t.payload, t.created_by, t.created_at, t.updated_at,
              u.display_name AS creator_name
       FROM week_templates t
       LEFT JOIN users u ON u.id = t.created_by
       WHERE t.kitchen_id = ?
       ORDER BY t.created_at DESC
       LIMIT 60`,
    )
    .all(kitchenId)
    .map(mapTemplate);
}

function getTemplate(kitchenId, templateId) {
  const row = db
    .prepare(
      `SELECT t.id, t.name, t.payload, t.created_by, t.created_at, t.updated_at,
              u.display_name AS creator_name
       FROM week_templates t
       LEFT JOIN users u ON u.id = t.created_by
       WHERE t.id = ? AND t.kitchen_id = ?`,
    )
    .get(templateId, kitchenId);
  return row ? mapTemplate(row) : null;
}

function maxPositionsForWeek(kitchenId, weekStart) {
  const dates = weekDateKeys(weekStart);
  const rows = db
    .prepare(
      `SELECT date, meal, MAX(position) AS max_position
       FROM plan_items
       WHERE kitchen_id = ? AND date >= ? AND date <= ?
       GROUP BY date, meal`,
    )
    .all(kitchenId, dates[0], dates[6]);
  return new Map(rows.map((row) => [`${row.date}|${row.meal}`, Number(row.max_position) + 1]));
}

function insertPlanItemAt(kitchenId, userId, date, meal, item, position) {
  const createdAt = nowISO();
  db.prepare(
    `INSERT INTO plan_items
      (id, kitchen_id, date, meal, name, calories, position, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId("itm"), kitchenId, date, meal, item.name, item.calories, position, userId, createdAt, createdAt);
}

function copyPlanWeek(kitchenId, userId, sourceWeekStart, targetWeekStart, mode) {
  const rows = readWeekItems(kitchenId, sourceWeekStart);
  if (!rows.length) {
    throw new HttpError(400, "上一周还没有安排食物，没有可以复制的食谱。");
  }
  const payload = weekPayloadFromRows(rows, sourceWeekStart);
  const targetDates = weekDateKeys(targetWeekStart);

  db.exec("BEGIN IMMEDIATE");
  try {
    if (mode === "replace") {
      db.prepare("DELETE FROM plan_items WHERE kitchen_id = ? AND date >= ? AND date <= ?").run(
        kitchenId,
        targetDates[0],
        targetDates[6],
      );
    }
    const positions = mode === "replace" ? new Map() : maxPositionsForWeek(kitchenId, targetWeekStart);
    let copied = 0;
    payload.days.forEach((day, dayIndex) => {
      Object.entries(day).forEach(([meal, items]) => {
        items.forEach((item) => {
          const key = `${targetDates[dayIndex]}|${meal}`;
          const position = positions.get(key) || 0;
          insertPlanItemAt(kitchenId, userId, targetDates[dayIndex], meal, item, position);
          positions.set(key, position + 1);
          copied += 1;
        });
      });
    });
    db.exec("COMMIT");
    return copied;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function applyWeekPayload(kitchenId, userId, weekStart, days, mode) {
  const targetDates = weekDateKeys(weekStart);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (mode === "replace") {
      db.prepare("DELETE FROM plan_items WHERE kitchen_id = ? AND date >= ? AND date <= ?").run(
        kitchenId,
        targetDates[0],
        targetDates[6],
      );
    }
    const positions = mode === "replace" ? new Map() : maxPositionsForWeek(kitchenId, weekStart);
    let applied = 0;
    days.forEach((day, dayIndex) => {
      Object.entries(day).forEach(([meal, items]) => {
        items.forEach((item) => {
          const key = `${targetDates[dayIndex]}|${meal}`;
          const position = positions.get(key) || 0;
          insertPlanItemAt(kitchenId, userId, targetDates[dayIndex], meal, item, position);
          positions.set(key, position + 1);
          applied += 1;
        });
      });
    });
    db.exec("COMMIT");
    return applied;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function mapFavorite(row) {
  let items = [];
  try {
    const parsed = JSON.parse(row.items);
    if (Array.isArray(parsed)) {
      items = parsed
        .map((item) => ({
          name: cleanText(item?.name, 40),
          calories: Math.round(Number(item?.calories)),
        }))
        .filter((item) => item.name && Number.isFinite(item.calories) && item.calories >= 0 && item.calories <= 5000);
    }
  } catch (error) {
    items = [];
  }
  return {
    id: row.id,
    name: row.name,
    meal: row.meal,
    items,
    totalCalories: items.reduce((total, item) => total + item.calories, 0),
    creatorId: row.created_by,
    creatorName: row.creator_name || "已离开的成员",
    createdAt: row.created_at,
  };
}

function getFavorites(kitchenId) {
  return db
    .prepare(
      `SELECT f.id, f.name, f.meal, f.items, f.created_by, f.created_at,
              u.display_name AS creator_name
       FROM meal_favorites f
       LEFT JOIN users u ON u.id = f.created_by
       WHERE f.kitchen_id = ?
       ORDER BY f.created_at DESC
       LIMIT 100`,
    )
    .all(kitchenId)
    .map(mapFavorite);
}

function getFavorite(kitchenId, favoriteId) {
  const row = db
    .prepare(
      `SELECT f.id, f.name, f.meal, f.items, f.created_by, f.created_at,
              u.display_name AS creator_name
       FROM meal_favorites f
       LEFT JOIN users u ON u.id = f.created_by
       WHERE f.id = ? AND f.kitchen_id = ?`,
    )
    .get(favoriteId, kitchenId);
  return row ? mapFavorite(row) : null;
}

/* =========================================================
   Table module: cooks, polls & grocery duty
   ========================================================= */

function getCooks(kitchenId, startDate, endDate) {
  const rows = db
    .prepare(
      `SELECT c.date, c.slot, c.user_id, c.updated_at, u.display_name
       FROM day_cook_slots c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.kitchen_id = ? AND c.date >= ? AND c.date <= ?
       ORDER BY c.date ASC, CASE c.slot WHEN 'morning' THEN 0 ELSE 1 END`,
    )
    .all(kitchenId, startDate, endDate);
  const cooks = {};
  rows.forEach((row) => {
    if (!cooks[row.date]) cooks[row.date] = { morning: null, afternoon: null };
    cooks[row.date][row.slot] = {
      date: row.date,
      slot: row.slot,
      userId: row.user_id,
      displayName: row.display_name || "已离开的成员",
      updatedAt: row.updated_at,
    };
  });
  return cooks;
}

function getMemberRecord(kitchenId, userId) {
  return db
    .prepare(
      `SELECT u.id, u.username, u.display_name
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.kitchen_id = ? AND m.user_id = ?`,
    )
    .get(kitchenId, userId);
}

function getGroceries(kitchenId, weekStart) {
  return db
    .prepare(
      `SELECT g.id, g.week_start, g.day_index, g.user_id, g.note, g.done,
              g.created_by, g.created_at, g.updated_at,
              u.display_name AS user_name
       FROM grocery_duties g
       LEFT JOIN users u ON u.id = g.user_id
       WHERE g.kitchen_id = ? AND g.week_start = ?
       ORDER BY COALESCE(g.day_index, 7) ASC, g.created_at ASC`,
    )
    .all(kitchenId, weekStart)
    .map((row) => ({
      id: row.id,
      weekStart: row.week_start,
      dayIndex: row.day_index === null ? null : Number(row.day_index),
      userId: row.user_id,
      userName: row.user_name || "已离开的成员",
      note: row.note,
      done: Boolean(row.done),
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
}

function getPolls(kitchenId, userId) {
  const rows = db
    .prepare(
      `SELECT p.id, p.title, p.note, p.status, p.created_by, p.created_at,
              p.updated_at, p.closed_at, u.display_name AS creator_name
       FROM meal_polls p
       LEFT JOIN users u ON u.id = p.created_by
       WHERE p.kitchen_id = ?
       ORDER BY CASE p.status WHEN 'open' THEN 0 ELSE 1 END, p.created_at DESC
       LIMIT 40`,
    )
    .all(kitchenId);

  if (!rows.length) return [];

  const optionsByPoll = new Map();
  const optionRows = db
    .prepare(
      `SELECT o.id, o.poll_id, o.label, o.position
       FROM poll_options o
       JOIN meal_polls p ON p.id = o.poll_id
       WHERE p.kitchen_id = ?
       ORDER BY o.position ASC`,
    )
    .all(kitchenId);
  optionRows.forEach((row) => {
    if (!optionsByPoll.has(row.poll_id)) optionsByPoll.set(row.poll_id, []);
    optionsByPoll.get(row.poll_id).push({
      id: row.id,
      label: row.label,
      voters: [],
    });
  });

  const voteRows = db
    .prepare(
      `SELECT v.poll_id, v.option_id, v.user_id, u.display_name
       FROM poll_votes v
       JOIN poll_options o ON o.id = v.option_id
       JOIN meal_polls p ON p.id = v.poll_id
       JOIN users u ON u.id = v.user_id
       WHERE p.kitchen_id = ?
       ORDER BY v.created_at ASC`,
    )
    .all(kitchenId);

  const myVotes = new Map();
  voteRows.forEach((row) => {
    const option = (optionsByPoll.get(row.poll_id) || []).find((item) => item.id === row.option_id);
    if (option) option.voters.push({ id: row.user_id, displayName: row.display_name });
    if (row.user_id === userId) myVotes.set(row.poll_id, row.option_id);
  });

  return rows.map((row) => {
    const options = (optionsByPoll.get(row.id) || []).map((option) => ({
      ...option,
      count: option.voters.length,
    }));
    return {
      id: row.id,
      title: row.title,
      note: row.note,
      status: row.status,
      createdBy: row.created_by,
      creatorName: row.creator_name || "已离开的成员",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at,
      options,
      totalVotes: options.reduce((total, option) => total + option.count, 0),
      myVoteOptionId: myVotes.get(row.id) || null,
    };
  });
}

function getGathering(kitchenId, userId, weekStart) {
  const kitchen = requireMembership(kitchenId, userId);
  const normalized = normalizeWeekStart(weekStart);
  const dates = weekDateKeys(normalized);
  return {
    weekStart: normalized,
    canEdit: kitchen.role !== "viewer",
    role: kitchen.role,
    members: getMembers(kitchenId),
    cooks: getCooks(kitchenId, dates[0], dates[6]),
    groceries: getGroceries(kitchenId, normalized),
    polls: getPolls(kitchenId, userId),
    messages: getMessages(kitchenId),
  };
}

function requirePoll(kitchenId, pollId) {
  const poll = db
    .prepare("SELECT id, kitchen_id, title, status, created_by FROM meal_polls WHERE id = ? AND kitchen_id = ?")
    .get(pollId, kitchenId);
  if (!poll) throw new HttpError(404, "这个投票已经不存在了。");
  return poll;
}

function canManagePoll(poll, kitchen, userId) {
  return poll.created_by === userId || kitchen.role === "owner";
}

/* =========================================================
   Week copy / template handlers
   ========================================================= */

async function handleCopyWeek(req, res, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  requireMembership(kitchenId, user.id, { edit: true });
  const body = await readJsonBody(req);
  const sourceWeekStart = normalizeWeekStart(body.sourceWeekStart);
  const targetWeekStart = normalizeWeekStart(body.targetWeekStart);
  if (sourceWeekStart === targetWeekStart) {
    throw new HttpError(400, "来源周和本周是同一周，换一周再复制吧。");
  }
  const mode = body.mode === "replace" ? "replace" : "merge";
  const copied = copyPlanWeek(kitchenId, user.id, sourceWeekStart, targetWeekStart, mode);
  const revision = touchKitchen(kitchenId, { clearSample: true });
  broadcastKitchen(kitchenId, {
    type: "plan",
    weekStart: targetWeekStart,
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
    revision,
  });
  sendJson(res, 200, {
    copied,
    mode,
    plan: getPlan(kitchenId, user.id, targetWeekStart),
  });
}

async function handleGetTemplates(req, res, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  requireMembership(kitchenId, user.id);
  sendJson(res, 200, { templates: getTemplates(kitchenId) });
}

async function handleCreateTemplate(req, res, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  requireMembership(kitchenId, user.id, { edit: true });
  const body = await readJsonBody(req);
  const weekStart = normalizeWeekStart(body.weekStart || dateKey(startOfWeek(new Date())));
  const rows = readWeekItems(kitchenId, weekStart);
  if (!rows.length) throw new HttpError(400, "这一周还没有安排食物，先加点菜再存模板吧。");
  const name = cleanText(body.name, 30) || `${weekStart.slice(5).replace("-", "/")} 的一周`;
  const count = db
    .prepare("SELECT COUNT(*) AS count FROM week_templates WHERE kitchen_id = ?")
    .get(kitchenId);
  if (Number(count.count) >= 60) throw new HttpError(400, "模板太多了，先删掉一些再保存。");
  const payload = weekPayloadFromRows(rows, weekStart);
  const id = newId("tpl");
  const createdAt = nowISO();
  db.prepare(
    `INSERT INTO week_templates (id, kitchen_id, name, payload, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, kitchenId, name, JSON.stringify(payload), user.id, createdAt, createdAt);
  sendJson(res, 201, { templates: getTemplates(kitchenId) });
}

async function handleDeleteTemplate(req, res, user, kitchenId, templateId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = requireMembership(kitchenId, user.id, { edit: true });
  const template = db
    .prepare("SELECT id, created_by FROM week_templates WHERE id = ? AND kitchen_id = ?")
    .get(templateId, kitchenId);
  if (!template) throw new HttpError(404, "这个模板已经不存在了。");
  if (template.created_by !== user.id && kitchen.role !== "owner") {
    throw new HttpError(403, "只有模板的保存者或厨房主人可以删除这个模板。");
  }
  db.prepare("DELETE FROM week_templates WHERE id = ?").run(templateId);
  sendJson(res, 200, { templates: getTemplates(kitchenId) });
}

async function handleApplyTemplate(req, res, user, kitchenId, templateId) {
  if (!user) throw new HttpError(401, "请先登录。");
  requireMembership(kitchenId, user.id, { edit: true });
  const body = await readJsonBody(req);
  const weekStart = normalizeWeekStart(body.weekStart);
  const mode = body.mode === "replace" ? "replace" : "merge";
  const template = getTemplate(kitchenId, templateId);
  if (!template) throw new HttpError(404, "这个模板已经不存在了。");
  if (!template.itemCount) throw new HttpError(400, "这个模板是空的，先保存一份有内容的模板吧。");
  const applied = applyWeekPayload(kitchenId, user.id, weekStart, template.days, mode);
  const revision = touchKitchen(kitchenId, { clearSample: true });
  broadcastKitchen(kitchenId, {
    type: "plan",
    weekStart,
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
    revision,
  });
  sendJson(res, 200, {
    applied,
    mode,
    plan: getPlan(kitchenId, user.id, weekStart),
  });
}

/* =========================================================
   Meal favorite handlers
   ========================================================= */

async function handleGetFavorites(req, res, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  requireMembership(kitchenId, user.id);
  sendJson(res, 200, { favorites: getFavorites(kitchenId) });
}

async function handleCreateFavorite(req, res, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  requireMembership(kitchenId, user.id, { edit: true });
  const body = await readJsonBody(req);
  const date = String(body.date || "");
  const meal = String(body.meal || "");
  if (!parseDateKey(date)) throw new HttpError(400, "日期格式不正确。");
  if (!MEALS.has(meal)) throw new HttpError(400, "餐次不正确。");
  const items = db
    .prepare(
      `SELECT name, calories FROM plan_items
       WHERE kitchen_id = ? AND date = ? AND meal = ?
       ORDER BY position ASC, created_at ASC`,
    )
    .all(kitchenId, date, meal);
  if (!items.length) throw new HttpError(400, "这一餐还是空的，先安排点食物再收藏吧。");
  const count = db
    .prepare("SELECT COUNT(*) AS count FROM meal_favorites WHERE kitchen_id = ?")
    .get(kitchenId);
  if (Number(count.count) >= 100) throw new HttpError(400, "收藏太多了，先整理一下吧。");
  const name =
    cleanText(body.name, 30) || `${MEAL_LABELS[meal]} · ${items[0].name}`;
  const id = newId("fav");
  const createdAt = nowISO();
  db.prepare(
    `INSERT INTO meal_favorites (id, kitchen_id, name, meal, items, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    kitchenId,
    name,
    meal,
    JSON.stringify(items.map((item) => ({ name: item.name, calories: item.calories }))),
    user.id,
    createdAt,
  );
  sendJson(res, 201, { favorites: getFavorites(kitchenId) });
}

async function handleDeleteFavorite(req, res, user, kitchenId, favoriteId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = requireMembership(kitchenId, user.id, { edit: true });
  const favorite = db
    .prepare("SELECT id, created_by FROM meal_favorites WHERE id = ? AND kitchen_id = ?")
    .get(favoriteId, kitchenId);
  if (!favorite) throw new HttpError(404, "这个收藏已经不存在了。");
  if (favorite.created_by !== user.id && kitchen.role !== "owner") {
    throw new HttpError(403, "只有收藏者或厨房主人可以删除这个收藏。");
  }
  db.prepare("DELETE FROM meal_favorites WHERE id = ?").run(favoriteId);
  sendJson(res, 200, { favorites: getFavorites(kitchenId) });
}

async function handleApplyFavorite(req, res, user, kitchenId, favoriteId) {
  if (!user) throw new HttpError(401, "请先登录。");
  requireMembership(kitchenId, user.id, { edit: true });
  const body = await readJsonBody(req);
  const weekStart = normalizeWeekStart(body.weekStart);
  const date = String(body.date || "");
  const meal = String(body.meal || "");
  const dates = weekDateKeys(weekStart);
  if (!parseDateKey(date) || !dates.includes(date)) throw new HttpError(400, "日期不在当前周内。");
  if (!MEALS.has(meal)) throw new HttpError(400, "餐次不正确。");
  const favorite = getFavorite(kitchenId, favoriteId);
  if (!favorite) throw new HttpError(404, "这个收藏已经不存在了。");
  if (!favorite.items.length) throw new HttpError(400, "这个收藏是空的。");
  const positions = maxPositionsForWeek(kitchenId, weekStart);
  const key = `${date}|${meal}`;
  let position = positions.get(key) || 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    favorite.items.forEach((item) => {
      insertPlanItemAt(kitchenId, user.id, date, meal, item, position);
      position += 1;
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const revision = touchKitchen(kitchenId, { clearSample: true });
  broadcastKitchen(kitchenId, {
    type: "plan",
    weekStart,
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
    revision,
  });
  sendJson(res, 200, {
    added: favorite.items.length,
    plan: getPlan(kitchenId, user.id, weekStart),
  });
}

/* =========================================================
   Cook / poll / grocery handlers
   ========================================================= */

async function handleSetCook(req, res, user, kitchenId, date, slot = "afternoon") {
  if (!user) throw new HttpError(401, "请先登录。");
  requireMembership(kitchenId, user.id, { edit: true });
  if (!parseDateKey(date)) throw new HttpError(400, "日期格式不正确。");
  if (!COOK_SLOTS.has(slot)) throw new HttpError(400, "做饭时段不正确。");
  const body = await readJsonBody(req);
  const member = getMemberRecord(kitchenId, String(body.userId || ""));
  if (!member) throw new HttpError(400, "请选择一位当前厨房的成员。");
  db.prepare(
    `INSERT INTO day_cook_slots (kitchen_id, date, slot, user_id, assigned_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(kitchen_id, date, slot)
     DO UPDATE SET user_id = excluded.user_id, assigned_by = excluded.assigned_by, updated_at = excluded.updated_at`,
  ).run(kitchenId, date, slot, member.id, user.id, nowISO());
  const weekStart = dateKey(startOfWeek(parseDateKey(date)));
  const dates = weekDateKeys(weekStart);
  broadcastKitchen(kitchenId, {
    type: "table",
    weekStart,
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
  });
  sendJson(res, 200, {
    weekStart,
    slot,
    cooks: getCooks(kitchenId, dates[0], dates[6]),
  });
}

async function handleClearCook(req, res, user, kitchenId, date, slot = null) {
  if (!user) throw new HttpError(401, "请先登录。");
  requireMembership(kitchenId, user.id, { edit: true });
  if (!parseDateKey(date)) throw new HttpError(400, "日期格式不正确。");
  if (slot !== null && !COOK_SLOTS.has(slot)) throw new HttpError(400, "做饭时段不正确。");
  if (slot) {
    db.prepare("DELETE FROM day_cook_slots WHERE kitchen_id = ? AND date = ? AND slot = ?").run(
      kitchenId,
      date,
      slot,
    );
  } else {
    db.prepare("DELETE FROM day_cook_slots WHERE kitchen_id = ? AND date = ?").run(kitchenId, date);
  }
  const weekStart = dateKey(startOfWeek(parseDateKey(date)));
  const dates = weekDateKeys(weekStart);
  broadcastKitchen(kitchenId, {
    type: "table",
    weekStart,
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
  });
  sendJson(res, 200, {
    weekStart,
    slot,
    cooks: getCooks(kitchenId, dates[0], dates[6]),
  });
}

async function handleGetGathering(req, res, user, kitchenId, url) {
  if (!user) throw new HttpError(401, "请先登录。");
  sendJson(res, 200, getGathering(kitchenId, user.id, url.searchParams.get("weekStart")));
}

async function handleCreateGrocery(req, res, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  requireMembership(kitchenId, user.id, { edit: true });
  const body = await readJsonBody(req);
  const weekStart = normalizeWeekStart(body.weekStart);
  const member = getMemberRecord(kitchenId, String(body.userId || ""));
  if (!member) throw new HttpError(400, "请选择一位当前厨房的成员。");
  let dayIndex = null;
  if (body.dayIndex !== null && body.dayIndex !== undefined && body.dayIndex !== "") {
    dayIndex = Number(body.dayIndex);
    if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex > 6) {
      throw new HttpError(400, "请选择本周内的某一天。");
    }
  }
  const note = cleanText(body.note, 60);
  const count = db
    .prepare("SELECT COUNT(*) AS count FROM grocery_duties WHERE kitchen_id = ? AND week_start = ?")
    .get(kitchenId, weekStart);
  if (Number(count.count) >= 20) throw new HttpError(400, "这一周的买菜安排已经很多了。");
  const id = newId("buy");
  const createdAt = nowISO();
  db.prepare(
    `INSERT INTO grocery_duties
      (id, kitchen_id, week_start, day_index, user_id, note, done, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(id, kitchenId, weekStart, dayIndex, member.id, note, user.id, createdAt, createdAt);
  broadcastKitchen(kitchenId, {
    type: "table",
    weekStart,
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
  });
  sendJson(res, 201, { groceries: getGroceries(kitchenId, weekStart) });
}

async function handleUpdateGrocery(req, res, user, kitchenId, groceryId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = requireMembership(kitchenId, user.id);
  const duty = db
    .prepare("SELECT * FROM grocery_duties WHERE id = ? AND kitchen_id = ?")
    .get(groceryId, kitchenId);
  if (!duty) throw new HttpError(404, "这项买菜安排已经不存在了。");
  const body = await readJsonBody(req);
  const keys = Object.keys(body);
  const onlyDone = keys.length === 1 && keys[0] === "done";
  const canToggleOwn = onlyDone && duty.user_id === user.id;
  if (kitchen.role === "viewer" && !canToggleOwn) {
    throw new HttpError(403, "你是访客，只能更新自己负责的买菜进度。");
  }

  let userId = duty.user_id;
  if (Object.prototype.hasOwnProperty.call(body, "userId")) {
    const member = getMemberRecord(kitchenId, String(body.userId || ""));
    if (!member) throw new HttpError(400, "请选择一位当前厨房的成员。");
    userId = member.id;
  }
  let dayIndex = duty.day_index === null ? null : Number(duty.day_index);
  if (Object.prototype.hasOwnProperty.call(body, "dayIndex")) {
    if (body.dayIndex === null || body.dayIndex === "") {
      dayIndex = null;
    } else {
      dayIndex = Number(body.dayIndex);
      if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex > 6) {
        throw new HttpError(400, "请选择本周内的某一天。");
      }
    }
  }
  const note = Object.prototype.hasOwnProperty.call(body, "note")
    ? cleanText(body.note, 60)
    : duty.note;
  const done = Object.prototype.hasOwnProperty.call(body, "done") ? (body.done ? 1 : 0) : duty.done;
  db.prepare(
    `UPDATE grocery_duties
     SET user_id = ?, day_index = ?, note = ?, done = ?, updated_at = ?
     WHERE id = ? AND kitchen_id = ?`,
  ).run(userId, dayIndex, note, done, nowISO(), groceryId, kitchenId);
  broadcastKitchen(kitchenId, {
    type: "table",
    weekStart: duty.week_start,
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
  });
  sendJson(res, 200, { groceries: getGroceries(kitchenId, duty.week_start) });
}

async function handleDeleteGrocery(req, res, user, kitchenId, groceryId) {
  if (!user) throw new HttpError(401, "请先登录。");
  requireMembership(kitchenId, user.id, { edit: true });
  const duty = db
    .prepare("SELECT id, week_start FROM grocery_duties WHERE id = ? AND kitchen_id = ?")
    .get(groceryId, kitchenId);
  if (!duty) throw new HttpError(404, "这项买菜安排已经不存在了。");
  db.prepare("DELETE FROM grocery_duties WHERE id = ?").run(groceryId);
  broadcastKitchen(kitchenId, {
    type: "table",
    weekStart: duty.week_start,
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
  });
  sendJson(res, 200, { groceries: getGroceries(kitchenId, duty.week_start) });
}

async function handleCreatePoll(req, res, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = requireMembership(kitchenId, user.id);
  const body = await readJsonBody(req);
  const title = cleanText(body.title, 40);
  if (!title) throw new HttpError(400, "给投票起个标题吧。");
  const note = cleanText(body.note, 120);
  const rawOptions = Array.isArray(body.options) ? body.options : [];
  const seen = new Set();
  const options = [];
  rawOptions.forEach((value) => {
    const label = cleanText(value, 30);
    if (!label || seen.has(label)) return;
    seen.add(label);
    options.push(label);
  });
  if (options.length < 2) throw new HttpError(400, "至少需要两个不同的选项。");
  if (options.length > 6) throw new HttpError(400, "最多只能有六个选项。");
  const open = db
    .prepare("SELECT COUNT(*) AS count FROM meal_polls WHERE kitchen_id = ? AND status = 'open'")
    .get(kitchenId);
  if (Number(open.count) >= 12) throw new HttpError(400, "进行中的投票太多了，先结束一些吧。");

  const id = newId("poll");
  const createdAt = nowISO();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO meal_polls (id, kitchen_id, title, note, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
    ).run(id, kitchenId, title, note, user.id, createdAt, createdAt);
    const insert = db.prepare(
      "INSERT INTO poll_options (id, poll_id, label, position) VALUES (?, ?, ?, ?)",
    );
    options.forEach((label, index) => insert.run(newId("opt"), id, label, index));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  broadcastKitchen(kitchenId, {
    type: "table",
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
  });
  sendJson(res, 201, { polls: getPolls(kitchenId, user.id), pollId: id });
}

async function handleVotePoll(req, res, user, kitchenId, pollId) {
  if (!user) throw new HttpError(401, "请先登录。");
  requireMembership(kitchenId, user.id);
  const poll = requirePoll(kitchenId, pollId);
  if (poll.status !== "open") throw new HttpError(400, "这个投票已经结束了。");
  const body = await readJsonBody(req);
  const optionId = String(body.optionId || "");
  const option = db
    .prepare("SELECT id FROM poll_options WHERE id = ? AND poll_id = ?")
    .get(optionId, pollId);
  if (!option) throw new HttpError(400, "这个选项不存在。");
  db.prepare(
    `INSERT INTO poll_votes (poll_id, option_id, user_id, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(poll_id, user_id)
     DO UPDATE SET option_id = excluded.option_id, created_at = excluded.created_at`,
  ).run(pollId, optionId, user.id, nowISO());
  db.prepare("UPDATE meal_polls SET updated_at = ? WHERE id = ?").run(nowISO(), pollId);
  broadcastKitchen(kitchenId, {
    type: "table",
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
  });
  sendJson(res, 200, { polls: getPolls(kitchenId, user.id) });
}

async function handleSetPollStatus(req, res, user, kitchenId, pollId, status) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = requireMembership(kitchenId, user.id);
  const poll = requirePoll(kitchenId, pollId);
  if (!canManagePoll(poll, kitchen, user.id)) {
    throw new HttpError(403, "只有发起人或厨房主人可以结束这个投票。");
  }
  db.prepare("UPDATE meal_polls SET status = ?, updated_at = ?, closed_at = ? WHERE id = ?").run(
    status,
    nowISO(),
    status === "closed" ? nowISO() : null,
    pollId,
  );
  broadcastKitchen(kitchenId, {
    type: "table",
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
  });
  sendJson(res, 200, { polls: getPolls(kitchenId, user.id) });
}

async function handleDeletePoll(req, res, user, kitchenId, pollId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = requireMembership(kitchenId, user.id);
  const poll = requirePoll(kitchenId, pollId);
  if (!canManagePoll(poll, kitchen, user.id)) {
    throw new HttpError(403, "只有发起人或厨房主人可以删除这个投票。");
  }
  db.prepare("DELETE FROM meal_polls WHERE id = ?").run(pollId);
  broadcastKitchen(kitchenId, {
    type: "table",
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
  });
  sendJson(res, 200, { polls: getPolls(kitchenId, user.id) });
}

/* =========================================================
   SSE
   ========================================================= */

const streamsByKitchen = new Map();

function addStream(kitchenId, stream) {
  if (!streamsByKitchen.has(kitchenId)) streamsByKitchen.set(kitchenId, new Set());
  streamsByKitchen.get(kitchenId).add(stream);
}

function removeStream(kitchenId, stream) {
  const set = streamsByKitchen.get(kitchenId);
  if (!set) return;
  set.delete(stream);
  if (!set.size) streamsByKitchen.delete(kitchenId);
}

function broadcastKitchen(kitchenId, payload) {
  const set = streamsByKitchen.get(kitchenId);
  if (!set || !set.size) return;
  const event = `event: kitchen\ndata: ${JSON.stringify(payload)}\n\n`;
  set.forEach((stream) => {
    try {
      stream.res.write(event);
    } catch (error) {
      removeStream(kitchenId, stream);
      try {
        stream.res.end();
      } catch (closeError) {
        // Already closed.
      }
    }
  });
}

function closeMemberStreams(kitchenId, userId) {
  const set = streamsByKitchen.get(kitchenId);
  if (!set) return;
  set.forEach((stream) => {
    if (stream.userId === userId) {
      try {
        stream.res.end();
      } catch (error) {
        // Ignore.
      }
      removeStream(kitchenId, stream);
    }
  });
}

function closeKitchenStreams(kitchenId) {
  const set = streamsByKitchen.get(kitchenId);
  if (!set) return;
  set.forEach((stream) => {
    try {
      stream.res.end();
    } catch (error) {
      // Ignore.
    }
  });
  streamsByKitchen.delete(kitchenId);
}

function closeUserStreams(userId) {
  streamsByKitchen.forEach((set, kitchenId) => {
    set.forEach((stream) => {
      if (stream.userId === userId) {
        try {
          stream.res.end();
        } catch (error) {
          // Ignore.
        }
        removeStream(kitchenId, stream);
      }
    });
  });
}

function handleEvents(req, res, kitchenId, user, clientId) {
  requireMembership(kitchenId, user.id);
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  res.write(`event: ready\ndata: ${JSON.stringify({ kitchenId })}\n\n`);

  const stream = {
    res,
    userId: user.id,
    clientId: cleanText(clientId, 80) || "unknown",
  };
  addStream(kitchenId, stream);

  req.on("close", () => {
    removeStream(kitchenId, stream);
  });
}

/* =========================================================
   Auth rate limiting
   ========================================================= */

const loginFailures = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 12;

function loginRateKey(req, username) {
  return `${req.socket.remoteAddress || "unknown"}:${String(username).toLowerCase()}`;
}

function assertLoginAllowed(req, username) {
  const key = loginRateKey(req, username);
  const entry = loginFailures.get(key);
  if (!entry) return;
  if (Date.now() - entry.first > LOGIN_WINDOW_MS) {
    loginFailures.delete(key);
    return;
  }
  if (entry.count >= LOGIN_MAX_FAILURES) {
    throw new HttpError(429, "尝试次数过多，请十分钟后再试。");
  }
}

function recordLoginFailure(req, username) {
  const key = loginRateKey(req, username);
  const entry = loginFailures.get(key);
  if (!entry || Date.now() - entry.first > LOGIN_WINDOW_MS) {
    loginFailures.set(key, { first: Date.now(), count: 1 });
    return;
  }
  entry.count += 1;
}

function clearLoginFailures(req, username) {
  loginFailures.delete(loginRateKey(req, username));
}

/* =========================================================
   API routes
   ========================================================= */

async function handleAuthRegister(req, res) {
  const body = await readJsonBody(req);
  const username = cleanText(body.username, 24);
  const password = typeof body.password === "string" ? body.password : "";
  const displayName = cleanText(body.displayName, 30) || username;

  if (!USERNAME_RE.test(username)) {
    throw new HttpError(400, "用户名需要 3–24 位，可使用中文、字母、数字、下划线或短横线。");
  }
  if (password.length < 8 || password.length > 128) {
    throw new HttpError(400, "密码需要 8–128 位。");
  }
  if (displayName.length < 1) {
    throw new HttpError(400, "请填写你的称呼。");
  }

  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (existing) throw new HttpError(409, "这个用户名已经被使用了。");

  const userId = newId("usr");
  const createdAt = nowISO();
  const passwordHash = hashPassword(password);
  const isConfiguredAdmin =
    CONFIGURED_ADMIN_USERNAME &&
    username.toLowerCase() === CONFIGURED_ADMIN_USERNAME.toLowerCase();
  db.prepare(
    "INSERT INTO users (id, username, display_name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(userId, username, displayName, passwordHash, isConfiguredAdmin ? 1 : 0, createdAt);

  createKitchenRecord(userId, displayName, `${displayName}的厨房`.slice(0, 30), {
    withSamplePlan: true,
  });

  createSession(res, req, userId);
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  sendJson(res, 201, {
    user: publicUser(user),
    kitchens: getMemberships(userId),
  });
}

async function handleAuthLogin(req, res) {
  const body = await readJsonBody(req);
  const username = cleanText(body.username, 24);
  const password = typeof body.password === "string" ? body.password : "";

  if (!username || !password) throw new HttpError(400, "请输入用户名和密码。");
  assertLoginAllowed(req, username);

  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  const passwordOk = verifyPassword(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);
  if (!user || !passwordOk) {
    recordLoginFailure(req, username);
    throw new HttpError(401, "用户名或密码不正确。");
  }

  clearLoginFailures(req, username);
  createSession(res, req, user.id);
  sendJson(res, 200, {
    user: publicUser(user),
    kitchens: getMemberships(user.id),
  });
}

async function handleAuthMe(req, res, user) {
  if (!user) throw new HttpError(401, "请先登录。");
  sendJson(res, 200, {
    user: publicUser(user),
    kitchens: getMemberships(user.id),
  });
}

async function handleUpdateProfile(req, res, user) {
  if (!user) throw new HttpError(401, "请先登录。");
  const body = await readJsonBody(req);
  const displayName = cleanText(body.displayName, 30);
  if (!displayName) throw new HttpError(400, "昵称不能为空。");

  db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(displayName, user.id);
  const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);

  const clientId = cleanText(req.headers["x-cougou-client-id"], 80) || null;
  const kitchens = db
    .prepare("SELECT kitchen_id FROM memberships WHERE user_id = ?")
    .all(user.id);
  kitchens.forEach((row) => {
    broadcastKitchen(row.kitchen_id, {
      type: "members",
      actorId: user.id,
      clientId,
    });
  });

  sendJson(res, 200, {
    user: publicUser(updated),
    kitchens: getMemberships(user.id),
  });
}

async function handleChangePassword(req, res, user) {
  if (!user) throw new HttpError(401, "请先登录。");
  const body = await readJsonBody(req);
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

  if (!currentPassword || !newPassword) {
    throw new HttpError(400, "请填写当前密码和新密码。");
  }
  if (newPassword.length < 8 || newPassword.length > 128) {
    throw new HttpError(400, "新密码需要 8–128 位。");
  }

  const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id);
  if (!row || !verifyPassword(currentPassword, row.password_hash)) {
    throw new HttpError(400, "当前密码不正确。");
  }
  if (verifyPassword(newPassword, row.password_hash)) {
    throw new HttpError(400, "新密码不能和当前密码相同。");
  }

  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
    hashPassword(newPassword),
    user.id,
  );

  const currentToken = parseCookies(req)[SESSION_COOKIE];
  const currentTokenHash = currentToken ? hashToken(currentToken) : "";
  const result = db
    .prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?")
    .run(user.id, currentTokenHash);

  sendJson(res, 200, {
    ok: true,
    revokedSessions: Number(result.changes || 0),
  });
}

async function handleCreateKitchen(req, res, user) {
  if (!user) throw new HttpError(401, "请先登录。");
  const body = await readJsonBody(req);
  const name = cleanText(body.name, 30);
  if (!name) throw new HttpError(400, "给厨房起个名字吧。");

  const kitchen = createKitchenRecord(user.id, user.display_name, name);
  sendJson(res, 201, { kitchen, kitchens: getMemberships(user.id) });
}

async function handleGetKitchen(req, res, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const detail = getKitchenDetail(kitchenId, user.id);
  if (!detail) throw new HttpError(404, "厨房不存在，或你还不是这个厨房的成员。");
  sendJson(res, 200, detail);
}

async function handleUpdateKitchen(req, res, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const body = await readJsonBody(req);
  const hasName = Object.prototype.hasOwnProperty.call(body, "name");
  const hasTarget = Object.prototype.hasOwnProperty.call(body, "dailyTarget");
  if (!hasName && !hasTarget) throw new HttpError(400, "没有需要更新的内容。");

  const kitchen = requireMembership(kitchenId, user.id);
  if (hasName && kitchen.role !== "owner") {
    throw new HttpError(403, "只有厨房主人可以重命名厨房。");
  }
  if (hasTarget && kitchen.role === "viewer") {
    throw new HttpError(403, "你是访客，不能修改每日目标。");
  }

  let name = null;
  let target = null;
  if (hasName) {
    name = cleanText(body.name, 30);
    if (!name) throw new HttpError(400, "厨房名称不能为空。");
  }
  if (hasTarget) target = normalizeDailyTarget(body.dailyTarget);

  db.prepare(
    `UPDATE kitchens
     SET name = COALESCE(?, name), daily_target = COALESCE(?, daily_target),
         revision = revision + 1, updated_at = ?
     WHERE id = ?`,
  ).run(name, target, nowISO(), kitchenId);

  const updated = getKitchenDetail(kitchenId, user.id);
  broadcastKitchen(kitchenId, {
    type: "kitchen",
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
    revision: updated.kitchen.revision,
  });
  sendJson(res, 200, updated);
}

async function handleCreateInvite(req, res, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  requireMembership(kitchenId, user.id, { owner: true });
  const body = await readJsonBody(req);
  const role = String(body.role || "viewer");
  if (!INVITE_ROLES.has(role)) throw new HttpError(400, "邀请权限不正确。");

  const code = crypto.randomBytes(18).toString("base64url");
  const createdAt = nowISO();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO invites (id, kitchen_id, code, role, created_by, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId("inv"), kitchenId, code, role, user.id, expiresAt, createdAt);

  sendJson(res, 201, {
    invite: { code, role, expiresAt, createdAt },
    invites: getActiveInvites(kitchenId),
  });
}

async function handleGetInvites(req, res, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  requireMembership(kitchenId, user.id, { owner: true });
  sendJson(res, 200, { invites: getActiveInvites(kitchenId) });
}

async function handleRevokeInvite(req, res, user, kitchenId, inviteId) {
  if (!user) throw new HttpError(401, "请先登录。");
  requireMembership(kitchenId, user.id, { owner: true });
  const result = db
    .prepare("UPDATE invites SET revoked = 1 WHERE id = ? AND kitchen_id = ?")
    .run(inviteId, kitchenId);
  if (!result.changes) throw new HttpError(404, "邀请不存在。");
  sendJson(res, 200, { invites: getActiveInvites(kitchenId) });
}

async function handleInvitePreview(req, res, code) {
  const row = db
    .prepare(
      `SELECT i.code, i.role, i.expires_at, i.revoked, k.id AS kitchen_id, k.name AS kitchen_name,
              u.display_name AS inviter_name
       FROM invites i
       JOIN kitchens k ON k.id = i.kitchen_id
       JOIN users u ON u.id = i.created_by
       WHERE i.code = ?`,
    )
    .get(code);

  if (!row) throw new HttpError(404, "邀请链接无效。");
  if (row.revoked) throw new HttpError(410, "这个邀请已经被撤销。");
  if (row.expires_at <= nowISO()) throw new HttpError(410, "这个邀请已经过期。");

  sendJson(res, 200, {
    invite: {
      code: row.code,
      role: row.role,
      expiresAt: row.expires_at,
      kitchenId: row.kitchen_id,
      kitchenName: row.kitchen_name,
      inviterName: row.inviter_name,
    },
  });
}

async function handleAcceptInvite(req, res, user, code) {
  if (!user) throw new HttpError(401, "请先登录。");
  const invite = db
    .prepare(
      `SELECT i.*, k.name AS kitchen_name
       FROM invites i JOIN kitchens k ON k.id = i.kitchen_id
       WHERE i.code = ?`,
    )
    .get(code);

  if (!invite) throw new HttpError(404, "邀请链接无效。");
  if (invite.revoked) throw new HttpError(410, "这个邀请已经被撤销。");
  if (invite.expires_at <= nowISO()) throw new HttpError(410, "这个邀请已经过期。");

  const existing = db
    .prepare("SELECT role FROM memberships WHERE kitchen_id = ? AND user_id = ?")
    .get(invite.kitchen_id, user.id);

  let joined = false;
  if (!existing) {
    db.prepare(
      "INSERT INTO memberships (kitchen_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)",
    ).run(invite.kitchen_id, user.id, invite.role, nowISO());
    joined = true;
  } else if (existing.role === "viewer" && invite.role === "editor") {
    db.prepare(
      "UPDATE memberships SET role = 'editor' WHERE kitchen_id = ? AND user_id = ?",
    ).run(invite.kitchen_id, user.id);
  }

  const revision = touchKitchen(invite.kitchen_id);
  broadcastKitchen(invite.kitchen_id, {
    type: "members",
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
    revision,
  });

  sendJson(res, 200, {
    joined,
    kitchenId: invite.kitchen_id,
    kitchenName: invite.kitchen_name,
    role: invite.role,
    kitchens: getMemberships(user.id),
  });
}

async function handleUpdateMember(req, res, user, kitchenId, memberId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = requireMembership(kitchenId, user.id, { owner: true });
  if (memberId === kitchen.ownerId) throw new HttpError(400, "不能修改厨房主人的身份。");
  const body = await readJsonBody(req);
  const role = String(body.role || "");
  if (!MEMBER_ROLES.has(role)) throw new HttpError(400, "成员身份不正确。");

  const result = db
    .prepare("UPDATE memberships SET role = ? WHERE kitchen_id = ? AND user_id = ?")
    .run(role, kitchenId, memberId);
  if (!result.changes) throw new HttpError(404, "成员不存在。");

  const revision = touchKitchen(kitchenId);
  broadcastKitchen(kitchenId, {
    type: "members",
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
    revision,
  });
  sendJson(res, 200, { members: getMembers(kitchenId) });
}

async function handleRemoveMember(req, res, user, kitchenId, memberId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = requireMembership(kitchenId, user.id, { owner: true });
  if (memberId === kitchen.ownerId) throw new HttpError(400, "不能移除厨房主人。");

  const result = db
    .prepare("DELETE FROM memberships WHERE kitchen_id = ? AND user_id = ?")
    .run(kitchenId, memberId);
  if (!result.changes) throw new HttpError(404, "成员不存在。");

  closeMemberStreams(kitchenId, memberId);
  const revision = touchKitchen(kitchenId);
  broadcastKitchen(kitchenId, {
    type: "members",
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
    revision,
  });
  sendJson(res, 200, { members: getMembers(kitchenId) });
}

async function handleLeaveKitchen(req, res, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = requireMembership(kitchenId, user.id);
  if (kitchen.role === "owner") {
    throw new HttpError(400, "厨房主人不能退出自己的厨房。");
  }
  db.prepare("DELETE FROM memberships WHERE kitchen_id = ? AND user_id = ?").run(
    kitchenId,
    user.id,
  );
  closeMemberStreams(kitchenId, user.id);
  const revision = touchKitchen(kitchenId);
  broadcastKitchen(kitchenId, {
    type: "members",
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
    revision,
  });
  sendJson(res, 200, { kitchens: getMemberships(user.id) });
}

async function handleGetIngredients(req, res, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = requireMembership(kitchenId, user.id);
  const ingredients = db
    .prepare(
      `SELECT id, name, calories, unit, category, created_at, updated_at
       FROM ingredients WHERE kitchen_id = ?
       ORDER BY category ASC, created_at ASC, name ASC`,
    )
    .all(kitchenId);
  sendJson(res, 200, {
    ingredients,
    canEdit: kitchen.role !== "viewer",
    role: kitchen.role,
  });
}

async function handleCreateIngredient(req, res, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = requireMembership(kitchenId, user.id, { edit: true });
  const body = await readJsonBody(req);
  const name = cleanText(body.name, 40);
  const unit = cleanText(body.unit, 24) || "1 份";
  const category = String(body.category || "other");
  if (!name) throw new HttpError(400, "请填写食材名称。");
  if (!INGREDIENT_CATEGORIES.has(category)) throw new HttpError(400, "食材分类不正确。");
  const calories = normalizeCalories(body.calories);

  const id = newId("ing");
  const createdAt = nowISO();
  db.prepare(
    `INSERT INTO ingredients
      (id, kitchen_id, name, calories, unit, category, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, kitchenId, name, calories, unit, category, user.id, createdAt, createdAt);

  const revision = touchKitchen(kitchenId);
  broadcastKitchen(kitchenId, {
    type: "ingredients",
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
    revision,
  });
  sendJson(res, 201, {
    ingredient: db.prepare("SELECT * FROM ingredients WHERE id = ?").get(id),
    ingredients: getIngredientsForClient(kitchenId),
    canEdit: kitchen.role !== "viewer",
  });
}

function getIngredientsForClient(kitchenId) {
  return db
    .prepare(
      `SELECT id, name, calories, unit, category, created_at, updated_at
       FROM ingredients WHERE kitchen_id = ?
       ORDER BY category ASC, created_at ASC, name ASC`,
    )
    .all(kitchenId);
}

async function handleUpdateIngredient(req, res, user, kitchenId, ingredientId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = requireMembership(kitchenId, user.id, { edit: true });
  const existing = db
    .prepare("SELECT * FROM ingredients WHERE id = ? AND kitchen_id = ?")
    .get(ingredientId, kitchenId);
  if (!existing) throw new HttpError(404, "食材不存在。");

  const body = await readJsonBody(req);
  const name = cleanText(body.name, 40);
  const unit = cleanText(body.unit, 24) || "1 份";
  const category = String(body.category || "other");
  if (!name) throw new HttpError(400, "请填写食材名称。");
  if (!INGREDIENT_CATEGORIES.has(category)) throw new HttpError(400, "食材分类不正确。");
  const calories = normalizeCalories(body.calories);

  db.prepare(
    `UPDATE ingredients SET name = ?, calories = ?, unit = ?, category = ?, updated_at = ?
     WHERE id = ? AND kitchen_id = ?`,
  ).run(name, calories, unit, category, nowISO(), ingredientId, kitchenId);

  const revision = touchKitchen(kitchenId);
  broadcastKitchen(kitchenId, {
    type: "ingredients",
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
    revision,
  });
  sendJson(res, 200, {
    ingredient: db.prepare("SELECT * FROM ingredients WHERE id = ?").get(ingredientId),
    ingredients: getIngredientsForClient(kitchenId),
    canEdit: kitchen.role !== "viewer",
  });
}

async function handleDeleteIngredient(req, res, user, kitchenId, ingredientId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = requireMembership(kitchenId, user.id, { edit: true });
  const result = db
    .prepare("DELETE FROM ingredients WHERE id = ? AND kitchen_id = ?")
    .run(ingredientId, kitchenId);
  if (!result.changes) throw new HttpError(404, "食材不存在。");

  const revision = touchKitchen(kitchenId);
  broadcastKitchen(kitchenId, {
    type: "ingredients",
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
    revision,
  });
  sendJson(res, 200, {
    ingredients: getIngredientsForClient(kitchenId),
    canEdit: kitchen.role !== "viewer",
  });
}

async function handleBatchDeleteIngredients(req, res, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = requireMembership(kitchenId, user.id, { edit: true });
  const body = await readJsonBody(req);
  const ids = Array.isArray(body.ids)
    ? [...new Set(body.ids.filter((id) => typeof id === "string" && /^[A-Za-z0-9_]+$/.test(id)))]
    : [];
  if (!ids.length) throw new HttpError(400, "请先选择要删除的食材。");
  if (ids.length > 90) throw new HttpError(400, "一次最多删除 90 种食材。");

  const placeholders = ids.map(() => "?").join(",");
  const existing = db
    .prepare(`SELECT id FROM ingredients WHERE kitchen_id = ? AND id IN (${placeholders})`)
    .all(kitchenId, ...ids);
  if (existing.length !== ids.length) {
    throw new HttpError(404, "部分食材已经不存在，请刷新后再试。");
  }

  db.prepare(`DELETE FROM ingredients WHERE kitchen_id = ? AND id IN (${placeholders})`).run(
    kitchenId,
    ...ids,
  );
  const revision = touchKitchen(kitchenId);
  broadcastKitchen(kitchenId, {
    type: "ingredients",
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
    revision,
  });
  sendJson(res, 200, {
    ingredients: getIngredientsForClient(kitchenId),
    canEdit: kitchen.role !== "viewer",
    deleted: ids.length,
  });
}

async function handleGetPlan(req, res, user, kitchenId, url) {
  if (!user) throw new HttpError(401, "请先登录。");
  const plan = getPlan(kitchenId, user.id, url.searchParams.get("weekStart"));
  sendJson(res, 200, plan);
}

async function handleCreatePlanItem(req, res, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = requireMembership(kitchenId, user.id, { edit: true });
  const body = await readJsonBody(req);
  const weekStart = normalizeWeekStart(body.weekStart);
  const payload = validatePlanPayload(body, weekStart);
  const position = nextPosition(kitchenId, payload.date, payload.meal);
  const id = newId("itm");
  const createdAt = nowISO();

  db.prepare(
    `INSERT INTO plan_items
      (id, kitchen_id, date, meal, name, calories, position, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    kitchenId,
    payload.date,
    payload.meal,
    payload.name,
    payload.calories,
    position,
    user.id,
    createdAt,
    createdAt,
  );

  const revision = touchKitchen(kitchenId, { clearSample: true });
  broadcastKitchen(kitchenId, {
    type: "plan",
    weekStart,
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
    revision,
  });
  sendJson(res, 201, {
    item: { id, name: payload.name, calories: payload.calories },
    plan: getPlan(kitchenId, user.id, weekStart),
    canEdit: kitchen.role !== "viewer",
  });
}

async function handleUpdatePlanItem(req, res, user, kitchenId, itemId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = requireMembership(kitchenId, user.id, { edit: true });
  const existing = db
    .prepare("SELECT * FROM plan_items WHERE id = ? AND kitchen_id = ?")
    .get(itemId, kitchenId);
  if (!existing) throw new HttpError(404, "这一餐食物不存在。");

  const body = await readJsonBody(req);
  const weekStart = normalizeWeekStart(body.weekStart || dateKey(startOfWeek(parseDateKey(existing.date))));
  const payload = validatePlanPayload(body, weekStart);
  const moved = existing.date !== payload.date || existing.meal !== payload.meal;
  const position = moved ? nextPosition(kitchenId, payload.date, payload.meal) : existing.position;

  db.prepare(
    `UPDATE plan_items
     SET date = ?, meal = ?, name = ?, calories = ?, position = ?, updated_at = ?
     WHERE id = ? AND kitchen_id = ?`,
  ).run(
    payload.date,
    payload.meal,
    payload.name,
    payload.calories,
    position,
    nowISO(),
    itemId,
    kitchenId,
  );

  const revision = touchKitchen(kitchenId, { clearSample: true });
  broadcastKitchen(kitchenId, {
    type: "plan",
    weekStart,
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
    revision,
  });
  sendJson(res, 200, {
    item: { id: itemId, name: payload.name, calories: payload.calories },
    plan: getPlan(kitchenId, user.id, weekStart),
    canEdit: kitchen.role !== "viewer",
  });
}

async function handleDeletePlanItem(req, res, user, kitchenId, itemId, url) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = requireMembership(kitchenId, user.id, { edit: true });
  const existing = db
    .prepare("SELECT * FROM plan_items WHERE id = ? AND kitchen_id = ?")
    .get(itemId, kitchenId);
  if (!existing) throw new HttpError(404, "这一餐食物不存在。");

  const requestedWeek = url.searchParams.get("weekStart");
  const weekStart = requestedWeek
    ? normalizeWeekStart(requestedWeek)
    : dateKey(startOfWeek(parseDateKey(existing.date)));

  db.prepare("DELETE FROM plan_items WHERE id = ? AND kitchen_id = ?").run(itemId, kitchenId);
  const revision = touchKitchen(kitchenId, { clearSample: true });
  broadcastKitchen(kitchenId, {
    type: "plan",
    weekStart,
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
    revision,
  });
  sendJson(res, 200, {
    plan: getPlan(kitchenId, user.id, weekStart),
    canEdit: kitchen.role !== "viewer",
  });
}

async function handleClearWeek(req, res, user, kitchenId, url) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = requireMembership(kitchenId, user.id, { edit: true });
  const weekStart = normalizeWeekStart(url.searchParams.get("weekStart"));
  const dates = weekDateKeys(weekStart);
  db.prepare(
    "DELETE FROM plan_items WHERE kitchen_id = ? AND date >= ? AND date <= ?",
  ).run(kitchenId, dates[0], dates[6]);

  const revision = touchKitchen(kitchenId, { clearSample: true });
  broadcastKitchen(kitchenId, {
    type: "plan",
    weekStart,
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
    revision,
  });
  sendJson(res, 200, {
    plan: getPlan(kitchenId, user.id, weekStart),
    canEdit: kitchen.role !== "viewer",
  });
}

async function handleClearDay(req, res, user, kitchenId, url) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = requireMembership(kitchenId, user.id, { edit: true });
  const date = String(url.searchParams.get("date") || "");
  const weekStart = normalizeWeekStart(url.searchParams.get("weekStart"));
  const dates = weekDateKeys(weekStart);
  if (!parseDateKey(date) || !dates.includes(date)) {
    throw new HttpError(400, "日期不在当前周内。");
  }

  const result = db
    .prepare("DELETE FROM plan_items WHERE kitchen_id = ? AND date = ?")
    .run(kitchenId, date);
  const revision = touchKitchen(kitchenId, { clearSample: true });
  broadcastKitchen(kitchenId, {
    type: "plan",
    weekStart,
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
    revision,
  });
  sendJson(res, 200, {
    plan: getPlan(kitchenId, user.id, weekStart),
    canEdit: kitchen.role !== "viewer",
    deleted: result.changes,
  });
}

/* =========================================================
   Kitchen message board
   ========================================================= */

function cleanMessageContent(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim();
}

async function handleGetMessages(req, res, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  requireMembership(kitchenId, user.id);
  sendJson(res, 200, { messages: getMessages(kitchenId) });
}

async function handleCreateMessage(req, res, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  requireMembership(kitchenId, user.id);
  const body = await readJsonBody(req);
  const content = cleanMessageContent(body.content);
  if (!content) throw new HttpError(400, "写点内容再张贴吧。");
  if (content.length > 500) throw new HttpError(400, "留言最多 500 个字。");

  const id = newId("msg");
  const createdAt = nowISO();
  db.prepare(
    "INSERT INTO messages (id, kitchen_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, kitchenId, user.id, content, createdAt);
  broadcastKitchen(kitchenId, {
    type: "messages",
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
    messageId: id,
  });
  sendJson(res, 201, { messages: getMessages(kitchenId) });
}

async function handleDeleteMessage(req, res, user, kitchenId, messageId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = requireMembership(kitchenId, user.id);
  const message = db
    .prepare("SELECT id, user_id FROM messages WHERE id = ? AND kitchen_id = ?")
    .get(messageId, kitchenId);
  if (!message) throw new HttpError(404, "这条留言已经不存在了。");
  if (message.user_id !== user.id && kitchen.role !== "owner") {
    throw new HttpError(403, "只有留言作者或厨房主人可以删除这条留言。");
  }
  db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
  broadcastKitchen(kitchenId, {
    type: "messages",
    actorId: user.id,
    clientId: cleanText(req.headers["x-cougou-client-id"], 80) || null,
    messageId,
  });
  sendJson(res, 200, { messages: getMessages(kitchenId) });
}

/* =========================================================
   Personal wellness: sleep plan + exercise burn
   ========================================================= */

function isValidClock(value) {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function sleepDurationMinutes(bedtime, wakeTime) {
  const [bedHour, bedMinute] = bedtime.split(":").map(Number);
  const [wakeHour, wakeMinute] = wakeTime.split(":").map(Number);
  const bed = bedHour * 60 + bedMinute;
  const wake = wakeHour * 60 + wakeMinute;
  return wake > bed ? wake - bed : wake + 1440 - bed;
}

function getWellnessWeek(userId, weekStart) {
  const dates = weekDateKeys(weekStart);
  const sleepRows = db
    .prepare(
      `SELECT date, bedtime, wake_time, updated_at FROM sleep_logs
       WHERE user_id = ? AND date >= ? AND date <= ?`,
    )
    .all(userId, dates[0], dates[6]);
  const exerciseRows = db
    .prepare(
      `SELECT date, calories, updated_at FROM exercise_logs
       WHERE user_id = ? AND date >= ? AND date <= ?`,
    )
    .all(userId, dates[0], dates[6]);
  const sleepByDate = new Map(sleepRows.map((row) => [row.date, row]));
  const exerciseByDate = new Map(exerciseRows.map((row) => [row.date, row]));
  const days = {};
  dates.forEach((date) => {
    const sleep = sleepByDate.get(date);
    const exercise = exerciseByDate.get(date);
    days[date] = {
      sleep: sleep
        ? {
            date: sleep.date,
            bedtime: sleep.bedtime,
            wakeTime: sleep.wake_time,
            durationMinutes: sleepDurationMinutes(sleep.bedtime, sleep.wake_time),
            updatedAt: sleep.updated_at,
          }
        : null,
      exercise: exercise
        ? { date: exercise.date, calories: exercise.calories, updatedAt: exercise.updated_at }
        : null,
    };
  });
  return { weekStart, days };
}

async function handleGetWellness(req, res, user, url) {
  if (!user) throw new HttpError(401, "请先登录。");
  const weekStart = normalizeWeekStart(url.searchParams.get("weekStart"));
  sendJson(res, 200, getWellnessWeek(user.id, weekStart));
}

async function handleSaveSleep(req, res, user) {
  if (!user) throw new HttpError(401, "请先登录。");
  const body = await readJsonBody(req);
  const date = String(body.date || "");
  const bedtime = String(body.bedtime || "");
  const wakeTime = String(body.wakeTime || "");
  if (!parseDateKey(date)) throw new HttpError(400, "日期格式不正确。");
  if (!isValidClock(bedtime) || !isValidClock(wakeTime)) {
    throw new HttpError(400, "请填写有效的入睡和起床时间。");
  }
  if (bedtime === wakeTime) throw new HttpError(400, "入睡和起床时间不能相同。");
  const weekStart = normalizeWeekStart(body.weekStart || dateKey(startOfWeek(parseDateKey(date))));
  if (!weekDateKeys(weekStart).includes(date)) throw new HttpError(400, "日期不在当前周内。");

  const now = nowISO();
  db.prepare(
    `INSERT INTO sleep_logs (user_id, date, bedtime, wake_time, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, date) DO UPDATE SET
       bedtime = excluded.bedtime,
       wake_time = excluded.wake_time,
       updated_at = excluded.updated_at`,
  ).run(user.id, date, bedtime, wakeTime, now, now);
  sendJson(res, 200, getWellnessWeek(user.id, weekStart));
}

async function handleSaveExercise(req, res, user) {
  if (!user) throw new HttpError(401, "请先登录。");
  const body = await readJsonBody(req);
  const date = String(body.date || "");
  const calories = Number(body.calories);
  if (!parseDateKey(date)) throw new HttpError(400, "日期格式不正确。");
  if (!Number.isFinite(calories) || calories < 0 || calories > 5000) {
    throw new HttpError(400, "运动消耗需要在 0–5,000 kcal 之间。");
  }
  const weekStart = normalizeWeekStart(body.weekStart || dateKey(startOfWeek(parseDateKey(date))));
  if (!weekDateKeys(weekStart).includes(date)) throw new HttpError(400, "日期不在当前周内。");

  const now = nowISO();
  db.prepare(
    `INSERT INTO exercise_logs (user_id, date, calories, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, date) DO UPDATE SET
       calories = excluded.calories,
       updated_at = excluded.updated_at`,
  ).run(user.id, date, Math.round(calories), now, now);
  sendJson(res, 200, getWellnessWeek(user.id, weekStart));
}

/* =========================================================
   Admin console data
   ========================================================= */

function requireAdmin(user) {
  if (!user) throw new HttpError(401, "请先登录。");
  if (!user.is_admin) throw new HttpError(403, "这个账号没有管理员权限。");
}

function adminUserList() {
  return db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.is_admin, u.created_at,
              (SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id) AS kitchen_count,
              (SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id AND m.role = 'owner') AS owned_kitchen_count,
              (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS active_sessions
       FROM users u
       ORDER BY u.created_at DESC`,
    )
    .all(nowISO())
    .map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      isAdmin: Boolean(row.is_admin),
      createdAt: row.created_at,
      kitchenCount: Number(row.kitchen_count || 0),
      ownedKitchenCount: Number(row.owned_kitchen_count || 0),
      activeSessions: Number(row.active_sessions || 0),
    }));
}

function adminKitchenList() {
  return db
    .prepare(
      `SELECT k.id, k.name, k.owner_id, k.daily_target, k.revision, k.is_sample,
              k.created_at, k.updated_at, u.display_name AS owner_name,
              (SELECT COUNT(*) FROM memberships m WHERE m.kitchen_id = k.id) AS member_count,
              (SELECT COUNT(*) FROM ingredients i WHERE i.kitchen_id = k.id) AS ingredient_count,
              (SELECT COUNT(*) FROM plan_items p WHERE p.kitchen_id = k.id) AS plan_item_count
       FROM kitchens k
       JOIN users u ON u.id = k.owner_id
       ORDER BY k.updated_at DESC`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      dailyTarget: row.daily_target,
      revision: row.revision,
      isSample: Boolean(row.is_sample),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      memberCount: Number(row.member_count || 0),
      ingredientCount: Number(row.ingredient_count || 0),
      planItemCount: Number(row.plan_item_count || 0),
    }));
}

function adminInviteList() {
  return db
    .prepare(
      `SELECT i.id, i.kitchen_id, i.role, i.created_by, i.expires_at, i.revoked, i.created_at,
              k.name AS kitchen_name, u.display_name AS creator_name
       FROM invites i
       JOIN kitchens k ON k.id = i.kitchen_id
       JOIN users u ON u.id = i.created_by
       ORDER BY CASE WHEN i.revoked = 0 AND i.expires_at > ? THEN 0 ELSE 1 END,
                i.created_at DESC`,
    )
    .all(nowISO())
    .map((row) => ({
      id: row.id,
      kitchenId: row.kitchen_id,
      kitchenName: row.kitchen_name,
      role: row.role,
      createdBy: row.created_by,
      creatorName: row.creator_name,
      expiresAt: row.expires_at,
      revoked: Boolean(row.revoked),
      createdAt: row.created_at,
    }));
}

function adminSessionList() {
  return db
    .prepare(
      `SELECT s.token_hash, s.user_id, s.created_at, s.expires_at,
              u.username, u.display_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.expires_at > ?
       ORDER BY s.created_at DESC`,
    )
    .all(nowISO())
    .map((row) => ({
      id: row.token_hash,
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }));
}

function adminStats() {
  const count = (sql, ...params) => Number(db.prepare(sql).get(...params).count || 0);
  return {
    users: count("SELECT COUNT(*) AS count FROM users"),
    admins: count("SELECT COUNT(*) AS count FROM users WHERE is_admin = 1"),
    kitchens: count("SELECT COUNT(*) AS count FROM kitchens"),
    memberships: count("SELECT COUNT(*) AS count FROM memberships"),
    ingredients: count("SELECT COUNT(*) AS count FROM ingredients"),
    planItems: count("SELECT COUNT(*) AS count FROM plan_items"),
    activeInvites: count(
      "SELECT COUNT(*) AS count FROM invites WHERE revoked = 0 AND expires_at > ?",
      nowISO(),
    ),
    activeSessions: count(
      "SELECT COUNT(*) AS count FROM sessions WHERE expires_at > ?",
      nowISO(),
    ),
  };
}

function adminOverview() {
  return {
    stats: adminStats(),
    recentUsers: adminUserList().slice(0, 5),
    recentKitchens: adminKitchenList().slice(0, 5),
  };
}

function adminKitchenDetail(kitchenId) {
  const row = db
    .prepare(
      `SELECT k.id, k.name, k.owner_id, k.daily_target, k.revision, k.is_sample,
              k.created_at, k.updated_at, u.display_name AS owner_name,
              (SELECT COUNT(*) FROM memberships m WHERE m.kitchen_id = k.id) AS member_count,
              (SELECT COUNT(*) FROM ingredients i WHERE i.kitchen_id = k.id) AS ingredient_count,
              (SELECT COUNT(*) FROM plan_items p WHERE p.kitchen_id = k.id) AS plan_item_count
       FROM kitchens k
       JOIN users u ON u.id = k.owner_id
       WHERE k.id = ?`,
    )
    .get(kitchenId);
  if (!row) throw new HttpError(404, "厨房不存在。");

  const planItems = db
    .prepare(
      `SELECT date, meal, name, calories, position
       FROM plan_items WHERE kitchen_id = ?
       ORDER BY date DESC, position ASC LIMIT 120`,
    )
    .all(kitchenId);

  const totals = db
    .prepare(
      "SELECT COUNT(*) AS items, COALESCE(SUM(calories), 0) AS calories FROM plan_items WHERE kitchen_id = ?",
    )
    .get(kitchenId);

  return {
    kitchen: {
      id: row.id,
      name: row.name,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      dailyTarget: row.daily_target,
      revision: row.revision,
      isSample: Boolean(row.is_sample),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      memberCount: Number(row.member_count || 0),
      ingredientCount: Number(row.ingredient_count || 0),
      planItemCount: Number(row.plan_item_count || 0),
    },
    members: getMembers(kitchenId),
    ingredients: getIngredientsForClient(kitchenId),
    planItems,
    totals: {
      items: Number(totals.items || 0),
      calories: Number(totals.calories || 0),
    },
  };
}

async function handleAdminApi(req, res, url, user) {
  requireAdmin(user);
  const pathname = url.pathname;
  const method = req.method || "GET";

  if (pathname === "/api/admin/overview" && method === "GET") {
    sendJson(res, 200, adminOverview());
    return;
  }

  if (pathname === "/api/admin/users" && method === "GET") {
    sendJson(res, 200, { users: adminUserList() });
    return;
  }

  if (pathname === "/api/admin/kitchens" && method === "GET") {
    sendJson(res, 200, { kitchens: adminKitchenList() });
    return;
  }

  if (pathname === "/api/admin/invites" && method === "GET") {
    sendJson(res, 200, { invites: adminInviteList() });
    return;
  }

  if (pathname === "/api/admin/sessions" && method === "GET") {
    sendJson(res, 200, { sessions: adminSessionList() });
    return;
  }

  let match = pathname.match(/^\/api\/admin\/kitchens\/([A-Za-z0-9_]+)$/);
  if (match && method === "GET") {
    sendJson(res, 200, adminKitchenDetail(match[1]));
    return;
  }

  if (match && method === "DELETE") {
    const kitchen = db.prepare("SELECT id, name FROM kitchens WHERE id = ?").get(match[1]);
    if (!kitchen) throw new HttpError(404, "厨房不存在。");
    closeKitchenStreams(match[1]);
    db.prepare("DELETE FROM kitchens WHERE id = ?").run(match[1]);
    console.log(`[admin] ${user.username} 删除了厨房 ${kitchen.name} (${kitchen.id})`);
    sendJson(res, 200, { ok: true });
    return;
  }

  match = pathname.match(/^\/api\/admin\/users\/([A-Za-z0-9_]+)$/);
  if (match && method === "PATCH") {
    const target = db
      .prepare("SELECT id, username, display_name, is_admin FROM users WHERE id = ?")
      .get(match[1]);
    if (!target) throw new HttpError(404, "用户不存在。");
    const body = await readJsonBody(req);
    if (typeof body.isAdmin !== "boolean") {
      throw new HttpError(400, "isAdmin 必须是布尔值。");
    }
    if (target.id === user.id) {
      throw new HttpError(400, "不能修改自己的管理员身份，请让另一位管理员操作。");
    }
    if (!body.isAdmin && target.is_admin) {
      const adminCount = Number(
        db.prepare("SELECT COUNT(*) AS count FROM users WHERE is_admin = 1").get().count || 0,
      );
      if (adminCount <= 1) throw new HttpError(400, "至少需要保留一位管理员。");
    }
    db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(body.isAdmin ? 1 : 0, target.id);
    console.log(
      `[admin] ${user.username} ${body.isAdmin ? "授予" : "移除了"} ${target.username} 的管理员权限`,
    );
    const updated = adminUserList().find((item) => item.id === target.id);
    sendJson(res, 200, { user: updated });
    return;
  }

  if (match && method === "DELETE") {
    const target = db
      .prepare("SELECT id, username, display_name, is_admin FROM users WHERE id = ?")
      .get(match[1]);
    if (!target) throw new HttpError(404, "用户不存在。");
    if (target.id === user.id) throw new HttpError(400, "不能删除自己的账号。");
    if (target.is_admin) {
      const adminCount = Number(
        db.prepare("SELECT COUNT(*) AS count FROM users WHERE is_admin = 1").get().count || 0,
      );
      if (adminCount <= 1) throw new HttpError(400, "至少需要保留一位管理员。");
    }

    const ownedKitchens = db
      .prepare("SELECT id FROM kitchens WHERE owner_id = ?")
      .all(target.id);
    ownedKitchens.forEach((row) => closeKitchenStreams(row.id));
    closeUserStreams(target.id);
    db.prepare("DELETE FROM users WHERE id = ?").run(target.id);
    console.log(`[admin] ${user.username} 删除了用户 ${target.username} (${target.id})`);
    sendJson(res, 200, { ok: true });
    return;
  }

  match = pathname.match(/^\/api\/admin\/invites\/([A-Za-z0-9_]+)$/);
  if (match && method === "DELETE") {
    const invite = db.prepare("SELECT id FROM invites WHERE id = ?").get(match[1]);
    if (!invite) throw new HttpError(404, "邀请不存在。");
    db.prepare("UPDATE invites SET revoked = 1 WHERE id = ?").run(match[1]);
    console.log(`[admin] ${user.username} 撤回了邀请 ${match[1]}`);
    sendJson(res, 200, { ok: true });
    return;
  }

  match = pathname.match(/^\/api\/admin\/sessions\/([a-f0-9]{64})$/);
  if (match && method === "DELETE") {
    const result = db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(match[1]);
    if (!result.changes) throw new HttpError(404, "会话不存在或已经过期。");
    console.log(`[admin] ${user.username} 撤销了一个登录会话`);
    sendJson(res, 200, { ok: true });
    return;
  }

  throw new HttpError(404, "没有找到这个管理接口。");
}

/* =========================================================
   API dispatcher
   ========================================================= */

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const method = req.method || "GET";

  if (method !== "GET" && method !== "HEAD") {
    assertMutationRequest(req);
  }

  if (pathname === "/api/health" && method === "GET") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/runtime" && method === "GET") {
    sendJson(res, 200, { realtime: true, platform: "node" });
    return;
  }

  if (pathname === "/api/auth/register" && method === "POST") {
    await handleAuthRegister(req, res);
    return;
  }

  if (pathname === "/api/auth/login" && method === "POST") {
    await handleAuthLogin(req, res);
    return;
  }

  if (pathname === "/api/auth/logout" && method === "POST") {
    deleteCurrentSession(req);
    res.setHeader("Set-Cookie", clearSessionCookie(req));
    sendJson(res, 200, { ok: true });
    return;
  }

  const user = getSession(req);

  if (pathname === "/api/wellness" && method === "GET") {
    return handleGetWellness(req, res, user, url);
  }

  if (pathname === "/api/wellness/sleep" && method === "PUT") {
    return handleSaveSleep(req, res, user);
  }

  if (pathname === "/api/wellness/exercise" && method === "PUT") {
    return handleSaveExercise(req, res, user);
  }

  if (pathname.startsWith("/api/admin/")) {
    await handleAdminApi(req, res, url, user);
    return;
  }

  if (pathname === "/api/auth/profile" && method === "PATCH") {
    await handleUpdateProfile(req, res, user);
    return;
  }

  if (pathname === "/api/auth/password" && method === "POST") {
    await handleChangePassword(req, res, user);
    return;
  }

  if (pathname === "/api/auth/me" && method === "GET") {
    await handleAuthMe(req, res, user);
    return;
  }

  if (pathname === "/api/kitchens" && method === "GET") {
    if (!user) throw new HttpError(401, "请先登录。");
    sendJson(res, 200, { user: publicUser(user), kitchens: getMemberships(user.id) });
    return;
  }

  if (pathname === "/api/kitchens" && method === "POST") {
    await handleCreateKitchen(req, res, user);
    return;
  }

  let match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)$/);
  if (match) {
    const kitchenId = match[1];
    if (method === "GET") return handleGetKitchen(req, res, user, kitchenId);
    if (method === "PATCH") return handleUpdateKitchen(req, res, user, kitchenId);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/plan$/);
  if (match) {
    const kitchenId = match[1];
    if (method === "GET") return handleGetPlan(req, res, user, kitchenId, url);
    if (method === "DELETE") return handleClearWeek(req, res, user, kitchenId, url);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/plan\/day$/);
  if (match && method === "DELETE") {
    return handleClearDay(req, res, user, match[1], url);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/plan\/items$/);
  if (match && method === "POST") {
    return handleCreatePlanItem(req, res, user, match[1]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/plan\/items\/([A-Za-z0-9_]+)$/);
  if (match) {
    const kitchenId = match[1];
    const itemId = match[2];
    if (method === "PATCH") return handleUpdatePlanItem(req, res, user, kitchenId, itemId);
    if (method === "DELETE") return handleDeletePlanItem(req, res, user, kitchenId, itemId, url);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/plan\/copy$/);
  if (match && method === "POST") {
    return handleCopyWeek(req, res, user, match[1]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/templates$/);
  if (match) {
    const kitchenId = match[1];
    if (method === "GET") return handleGetTemplates(req, res, user, kitchenId);
    if (method === "POST") return handleCreateTemplate(req, res, user, kitchenId);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/templates\/([A-Za-z0-9_]+)\/apply$/);
  if (match && method === "POST") {
    return handleApplyTemplate(req, res, user, match[1], match[2]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/templates\/([A-Za-z0-9_]+)$/);
  if (match && method === "DELETE") {
    return handleDeleteTemplate(req, res, user, match[1], match[2]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/favorites$/);
  if (match) {
    const kitchenId = match[1];
    if (method === "GET") return handleGetFavorites(req, res, user, kitchenId);
    if (method === "POST") return handleCreateFavorite(req, res, user, kitchenId);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/favorites\/([A-Za-z0-9_]+)\/apply$/);
  if (match && method === "POST") {
    return handleApplyFavorite(req, res, user, match[1], match[2]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/favorites\/([A-Za-z0-9_]+)$/);
  if (match && method === "DELETE") {
    return handleDeleteFavorite(req, res, user, match[1], match[2]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/cooks\/(\d{4}-\d{2}-\d{2})\/(morning|afternoon)$/);
  if (match) {
    const kitchenId = match[1];
    const date = match[2];
    const slot = match[3];
    if (method === "PUT") return handleSetCook(req, res, user, kitchenId, date, slot);
    if (method === "DELETE") return handleClearCook(req, res, user, kitchenId, date, slot);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/cooks\/(\d{4}-\d{2}-\d{2})$/);
  if (match) {
    const kitchenId = match[1];
    const date = match[2];
    if (method === "PUT") return handleSetCook(req, res, user, kitchenId, date, "afternoon");
    if (method === "DELETE") return handleClearCook(req, res, user, kitchenId, date);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/groceries$/);
  if (match) {
    if (method === "GET") return handleGetGathering(req, res, user, match[1], url);
    if (method === "POST") return handleCreateGrocery(req, res, user, match[1]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/groceries\/([A-Za-z0-9_]+)$/);
  if (match) {
    const kitchenId = match[1];
    const groceryId = match[2];
    if (method === "PATCH") return handleUpdateGrocery(req, res, user, kitchenId, groceryId);
    if (method === "DELETE") return handleDeleteGrocery(req, res, user, kitchenId, groceryId);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/polls$/);
  if (match) {
    const kitchenId = match[1];
    if (method === "GET") return handleGetGathering(req, res, user, kitchenId, url);
    if (method === "POST") return handleCreatePoll(req, res, user, kitchenId);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/polls\/([A-Za-z0-9_]+)\/vote$/);
  if (match && method === "POST") {
    return handleVotePoll(req, res, user, match[1], match[2]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/polls\/([A-Za-z0-9_]+)\/close$/);
  if (match && method === "POST") {
    return handleSetPollStatus(req, res, user, match[1], match[2], "closed");
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/polls\/([A-Za-z0-9_]+)\/reopen$/);
  if (match && method === "POST") {
    return handleSetPollStatus(req, res, user, match[1], match[2], "open");
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/polls\/([A-Za-z0-9_]+)$/);
  if (match && method === "DELETE") {
    return handleDeletePoll(req, res, user, match[1], match[2]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/table$/);
  if (match && method === "GET") {
    return handleGetGathering(req, res, user, match[1], url);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/ingredients$/);
  if (match) {
    const kitchenId = match[1];
    if (method === "GET") return handleGetIngredients(req, res, user, kitchenId);
    if (method === "POST") return handleCreateIngredient(req, res, user, kitchenId);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/ingredients\/batch-delete$/);
  if (match && method === "POST") {
    return handleBatchDeleteIngredients(req, res, user, match[1]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/ingredients\/([A-Za-z0-9_]+)$/);
  if (match) {
    const kitchenId = match[1];
    const ingredientId = match[2];
    if (method === "PATCH") {
      return handleUpdateIngredient(req, res, user, kitchenId, ingredientId);
    }
    if (method === "DELETE") {
      return handleDeleteIngredient(req, res, user, kitchenId, ingredientId);
    }
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/messages$/);
  if (match) {
    if (method === "GET") return handleGetMessages(req, res, user, match[1]);
    if (method === "POST") return handleCreateMessage(req, res, user, match[1]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/messages\/([A-Za-z0-9_]+)$/);
  if (match && method === "DELETE") {
    return handleDeleteMessage(req, res, user, match[1], match[2]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/invites$/);
  if (match) {
    const kitchenId = match[1];
    if (method === "GET") return handleGetInvites(req, res, user, kitchenId);
    if (method === "POST") return handleCreateInvite(req, res, user, kitchenId);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/invites\/([A-Za-z0-9_]+)$/);
  if (match && method === "DELETE") {
    return handleRevokeInvite(req, res, user, match[1], match[2]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/members\/([A-Za-z0-9_]+)$/);
  if (match) {
    const kitchenId = match[1];
    const memberId = match[2];
    if (method === "PATCH") return handleUpdateMember(req, res, user, kitchenId, memberId);
    if (method === "DELETE") return handleRemoveMember(req, res, user, kitchenId, memberId);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/leave$/);
  if (match && method === "POST") {
    return handleLeaveKitchen(req, res, user, match[1]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/events$/);
  if (match && method === "GET") {
    if (!user) throw new HttpError(401, "请先登录。");
    handleEvents(req, res, match[1], user, url.searchParams.get("clientId"));
    return;
  }

  match = pathname.match(/^\/api\/invites\/([A-Za-z0-9_-]+)$/);
  if (match && method === "GET") {
    return handleInvitePreview(req, res, match[1]);
  }

  match = pathname.match(/^\/api\/invites\/([A-Za-z0-9_-]+)\/accept$/);
  if (match && method === "POST") {
    return handleAcceptInvite(req, res, user, match[1]);
  }

  throw new HttpError(404, "没有找到这个接口。");
}

/* =========================================================
   Static files
   ========================================================= */

const STATIC_ASSETS = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/admin", { file: "admin.html", type: "text/html; charset=utf-8" }],
  ["/admin/", { file: "admin.html", type: "text/html; charset=utf-8" }],
  ["/admin.html", { file: "admin.html", type: "text/html; charset=utf-8" }],
  ["/admin.css", { file: "admin.css", type: "text/css; charset=utf-8" }],
  ["/admin.js", { file: "admin.js", type: "text/javascript; charset=utf-8" }],
]);

async function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    throw new HttpError(405, "这个地址只支持 GET 请求。");
  }

  if (pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  const isJoinRoute = pathname === "/join" || pathname.startsWith("/join/");
  let assetPath = pathname;
  if (isJoinRoute && pathname.endsWith("/styles.css")) assetPath = "/styles.css";
  if (isJoinRoute && pathname.endsWith("/app.js")) assetPath = "/app.js";
  const asset = STATIC_ASSETS.get(assetPath) || (isJoinRoute ? STATIC_ASSETS.get("/") : null);
  if (!asset) throw new HttpError(404, "页面不存在。");

  const filePath = path.join(ROOT, asset.file);
  const data = await fs.promises.readFile(filePath);
  res.writeHead(200, {
    "Content-Type": asset.type,
    "Content-Length": data.length,
    "Cache-Control": "no-cache",
  });
  if (req.method === "HEAD") {
    res.end();
  } else {
    res.end(data);
  }
}

/* =========================================================
   Server
   ========================================================= */

const server = http.createServer(async (req, res) => {
  baseSecurityHeaders(res);
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url.pathname);
    }
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.message });
      return;
    }
    console.error("[cougou] unhandled error:", error);
    sendJson(res, 500, { error: "服务器开小差了，请稍后再试。" });
  }
});

pruneExpiredSessions();
setInterval(pruneExpiredSessions, 6 * 60 * 60 * 1000).unref();
setInterval(() => {
  streamsByKitchen.forEach((set) => {
    set.forEach((stream) => {
      try {
        stream.res.write(": ping\n\n");
      } catch (error) {
        try {
          stream.res.end();
        } catch (closeError) {
          // Ignore.
        }
      }
    });
  });
}, 25_000).unref();

server.listen(PORT, HOST, () => {
  console.log(`凑狗厨房已启动：http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`);
});

function shutdown() {
  console.log("正在关闭凑狗厨房…");
  streamsByKitchen.forEach((set) => {
    set.forEach((stream) => {
      try {
        stream.res.end();
      } catch (error) {
        // Ignore.
      }
    });
  });
  server.close(() => {
    try {
      db.close();
    } catch (error) {
      // Ignore.
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
