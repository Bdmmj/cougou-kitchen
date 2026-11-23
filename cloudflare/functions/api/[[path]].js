/**
 * 凑狗厨房 · Cloudflare Pages Functions API
 * D1-backed port of the local Node server.
 */

const MEALS = ["breakfast", "lunch", "dinner", "snack"];
const MEAL_LABELS = { breakfast: "早餐", lunch: "午餐", dinner: "晚餐", snack: "加餐" };
const INGREDIENT_CATEGORIES = new Set(["staple", "protein", "vegetable", "fruit", "drink", "other"]);
const SESSION_COOKIE = "cougou_session";
const SESSION_AGE = 60 * 60 * 24 * 30;
const USERNAME_RE = /^[\p{L}\p{N}_-]{3,24}$/u;
const PBKDF2_ITERATIONS = 100000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* =========================================================
   Basic helpers
   ========================================================= */

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

function weekDateKeys(weekStart) {
  const start = parseDateKey(weekStart);
  return Array.from({ length: 7 }, (_, index) => dateKey(addDays(start, index)));
}

function normalizeWeekStart(value) {
  const date = parseDateKey(value);
  if (!date) throw new HttpError(400, "周份日期格式不正确。");
  return dateKey(startOfWeek(date));
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

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function json(data, status = 200, extraHeaders = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  return new Response(JSON.stringify(data), { status, headers });
}

function requireHeaderCsrf(request) {
  if (request.method === "GET" || request.method === "HEAD") return;
  if (request.headers.get("x-cougou-client") !== "web") {
    throw new HttpError(403, "请求来源校验失败。");
  }
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(request.url).host) {
        throw new HttpError(403, "跨站请求已被拒绝。");
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(403, "请求来源无效。");
    }
  }
}

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  if (text.length > 120000) throw new HttpError(413, "请求内容过大。");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new HttpError(400, "请求内容不是有效的 JSON。");
  }
}

/* =========================================================
   D1 wrappers
   ========================================================= */

async function one(env, sql, ...params) {
  const statement = env.DB.prepare(sql);
  const bound = params.length ? statement.bind(...params) : statement;
  return (await bound.first()) || null;
}

async function all(env, sql, ...params) {
  const statement = env.DB.prepare(sql);
  const bound = params.length ? statement.bind(...params) : statement;
  const result = await bound.all();
  return result.results || [];
}

async function run(env, sql, ...params) {
  const statement = env.DB.prepare(sql);
  const bound = params.length ? statement.bind(...params) : statement;
  return bound.run();
}

/* =========================================================
   Crypto / sessions
   ========================================================= */

const encoder = new TextEncoder();

function bytesToBase64Url(bytes) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function randomToken(bytes = 32) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return bytesToBase64Url(buffer);
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hashPassword(password) {
  const salt = randomToken(16);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: base64UrlToBytes(salt),
      iterations: PBKDF2_ITERATIONS,
    },
    key,
    256,
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt}$${bytesToBase64Url(new Uint8Array(bits))}`;
}

async function verifyPassword(password, stored) {
  try {
    const [algorithm, iterations, salt, expected] = String(stored).split("$");
    if (algorithm !== "pbkdf2") return false;
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: base64UrlToBytes(salt),
        iterations: Number(iterations),
      },
      key,
      256,
    );
    const actualBytes = new Uint8Array(bits);
    const expectedBytes = base64UrlToBytes(expected);
    if (actualBytes.length !== expectedBytes.length) return false;
    let difference = 0;
    for (let i = 0; i < actualBytes.length; i += 1) {
      difference |= actualBytes[i] ^ expectedBytes[i];
    }
    return difference === 0;
  } catch (error) {
    return false;
  }
}

function parseCookies(request) {
  const header = request.headers.get("cookie") || "";
  const result = {};
  header.split(";").forEach((chunk) => {
    const index = chunk.indexOf("=");
    if (index === -1) return;
    const key = chunk.slice(0, index).trim();
    const value = chunk.slice(index + 1).trim();
    if (key) result[key] = value;
  });
  return result;
}

function sessionCookie(request, token, maxAge) {
  const secure = new URL(request.url).protocol === "https:";
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

async function createSession(env, request, userId) {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const createdAt = nowISO();
  const expiresAt = new Date(Date.now() + SESSION_AGE * 1000).toISOString();
  await run(
    env,
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    tokenHash,
    userId,
    createdAt,
    expiresAt,
  );
  return { token, cookie: sessionCookie(request, token, SESSION_AGE) };
}

async function getSession(env, request) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  return one(
    env,
    `SELECT u.id, u.username, u.display_name, u.is_admin, u.created_at, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    tokenHash,
    nowISO(),
  );
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

/* =========================================================
   Seed data
   ========================================================= */

const STARTER_INGREDIENTS = [
  ["米饭", 232, "1 碗", "staple"], ["全麦吐司", 120, "2 片", "staple"],
  ["乌冬面", 220, "1 份", "staple"], ["藜麦", 180, "1 碗", "staple"],
  ["鸡胸肉", 165, "100 g", "protein"], ["三文鱼", 208, "100 g", "protein"],
  ["水煮蛋", 78, "1 个", "protein"], ["嫩豆腐", 84, "100 g", "protein"],
  ["牛腩", 250, "100 g", "protein"], ["西兰花", 34, "100 g", "vegetable"],
  ["菠菜", 28, "100 g", "vegetable"], ["番茄", 20, "1 个", "vegetable"],
  ["黄瓜", 16, "100 g", "vegetable"], ["蓝莓", 45, "50 g", "fruit"],
  ["香蕉", 89, "1 根", "fruit"], ["苹果", 95, "1 个", "fruit"],
  ["无糖酸奶", 90, "1 杯", "drink"], ["豆浆", 120, "1 杯", "drink"],
  ["美式咖啡", 5, "1 杯", "drink"], ["橄榄油", 40, "1 茶匙", "other"],
  ["黑巧克力", 70, "1 块", "other"],
];

const DEMO_PLAN = [
  { breakfast: [["牛油果吐司", 320], ["水煮蛋", 78]], lunch: [["番茄牛腩饭", 620], ["清炒西兰花", 95]], dinner: [["香煎三文鱼", 340], ["藜麦沙拉", 210]], snack: [["无糖酸奶", 90], ["蓝莓", 45]] },
  { breakfast: [["小米南瓜粥", 210], ["茶叶蛋", 80]], lunch: [["照烧鸡腿饭", 580], ["凉拌黄瓜", 60]], dinner: [["虾仁豆腐煲", 320], ["蒜蓉菠菜", 90]], snack: [["香蕉", 89], ["巴旦木", 120]] },
  { breakfast: [["全麦贝果", 260], ["奶油奶酪", 90], ["美式咖啡", 5]], lunch: [["泰式青咖喱鸡", 480], ["茉莉香米饭", 230]], dinner: [["番茄鸡蛋面", 460], ["凉拌木耳", 75]], snack: [["苹果", 95]] },
  { breakfast: [["希腊酸奶碗", 280], ["蜂蜜", 40]], lunch: [["牛肉彩椒碗", 520], ["玉米", 120]], dinner: [["味噌豆腐汤", 160], ["烤秋刀鱼", 280], ["糙米饭", 180]], snack: [["黑巧克力", 70]] },
  { breakfast: [["芝士蛋饼", 350], ["豆浆", 120]], lunch: [["冬阴功海鲜面", 560]], dinner: [["烤鸡胸沙拉", 380], ["南瓜浓汤", 150]], snack: [["葡萄", 80]] },
  { breakfast: [["舒芙蕾松饼", 420], ["拿铁", 130]], lunch: [["寿喜锅", 680], ["乌冬面", 220]], dinner: [["牛油果鸡肉卷", 430]], snack: [["草莓", 55]] },
  { breakfast: [["皮蛋瘦肉粥", 300], ["油条", 190]], lunch: [["家庭烤肉", 720], ["生菜包菜", 80]], dinner: [["菌菇鸡汤", 260], ["杂粮饭", 190]], snack: [["橙子", 62]] },
];

function samplePlanStatements(env, kitchenId, userId) {
  const weekStart = dateKey(startOfWeek(new Date()));
  const dates = weekDateKeys(weekStart);
  const createdAt = nowISO();
  const statements = [];
  dates.forEach((date, dayIndex) => {
    Object.entries(DEMO_PLAN[dayIndex]).forEach(([meal, items]) => {
      items.forEach(([name, calories], position) => {
        statements.push(
          env.DB.prepare(
            `INSERT INTO plan_items (id, kitchen_id, date, meal, name, calories, position, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(newId("itm"), kitchenId, date, meal, name, calories, position, userId, createdAt, createdAt),
        );
      });
    });
  });
  return statements;
}

async function createKitchenRecord(env, ownerId, ownerDisplayName, name, { withSamplePlan = false } = {}) {
  const kitchenId = newId("kit");
  const createdAt = nowISO();
  const statements = [
    env.DB.prepare(
      `INSERT INTO kitchens (id, name, owner_id, daily_target, revision, is_sample, created_at, updated_at)
       VALUES (?, ?, ?, 1800, 1, ?, ?, ?)`,
    ).bind(kitchenId, name, ownerId, withSamplePlan ? 1 : 0, createdAt, createdAt),
    env.DB.prepare(
      "INSERT INTO memberships (kitchen_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
    ).bind(kitchenId, ownerId, createdAt),
  ];

  STARTER_INGREDIENTS.forEach(([ingredientName, calories, unit, category]) => {
    statements.push(
      env.DB.prepare(
        `INSERT INTO ingredients (id, kitchen_id, name, calories, unit, category, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(newId("ing"), kitchenId, ingredientName, calories, unit, category, ownerId, createdAt, createdAt),
    );
  });

  if (withSamplePlan) statements.push(...samplePlanStatements(env, kitchenId, ownerId));

  // D1 batch is limited; split into chunks when needed.
  for (let index = 0; index < statements.length; index += 80) {
    await env.DB.batch(statements.slice(index, index + 80));
  }

  return getKitchenSummary(env, kitchenId, ownerId);
}

/* =========================================================
   Kitchen / membership queries
   ========================================================= */

async function getMemberships(env, userId) {
  const rows = await all(
    env,
    `SELECT k.id, k.name, k.owner_id, k.daily_target, k.revision, k.is_sample,
            k.created_at, k.updated_at, m.role, u.display_name AS owner_name,
            (SELECT COUNT(*) FROM memberships cm WHERE cm.kitchen_id = k.id) AS member_count
     FROM memberships m
     JOIN kitchens k ON k.id = m.kitchen_id
     JOIN users u ON u.id = k.owner_id
     WHERE m.user_id = ?
     ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, k.updated_at DESC`,
    userId,
  );
  return rows.map(mapKitchen);
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

async function getKitchenSummary(env, kitchenId, userId) {
  const row = await one(
    env,
    `SELECT k.id, k.name, k.owner_id, k.daily_target, k.revision, k.is_sample,
            k.created_at, k.updated_at, m.role, u.display_name AS owner_name,
            (SELECT COUNT(*) FROM memberships cm WHERE cm.kitchen_id = k.id) AS member_count
     FROM kitchens k
     JOIN memberships m ON m.kitchen_id = k.id AND m.user_id = ?
     JOIN users u ON u.id = k.owner_id
     WHERE k.id = ?`,
    userId,
    kitchenId,
  );
  return row ? mapKitchen(row) : null;
}

async function getMembers(env, kitchenId) {
  const rows = await all(
    env,
    `SELECT u.id, u.username, u.display_name, m.role, m.joined_at
     FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.kitchen_id = ?
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, m.joined_at ASC`,
    kitchenId,
  );
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    joinedAt: row.joined_at,
  }));
}

async function getActiveInvites(env, kitchenId) {
  const rows = await all(
    env,
    `SELECT i.id, i.code, i.role, i.expires_at, i.created_at, u.display_name AS creator_name
     FROM invites i JOIN users u ON u.id = i.created_by
     WHERE i.kitchen_id = ? AND i.revoked = 0 AND i.expires_at > ?
     ORDER BY i.created_at DESC`,
    kitchenId,
    nowISO(),
  );
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    role: row.role,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    creatorName: row.creator_name,
  }));
}

async function getKitchenDetail(env, kitchenId, userId) {
  const kitchen = await getKitchenSummary(env, kitchenId, userId);
  if (!kitchen) return null;
  const members = await getMembers(env, kitchenId);
  const invites = kitchen.role === "owner" ? await getActiveInvites(env, kitchenId) : [];
  return { kitchen, members, invites };
}

async function requireMembership(env, kitchenId, userId, { edit = false, owner = false } = {}) {
  const kitchen = await getKitchenSummary(env, kitchenId, userId);
  if (!kitchen) throw new HttpError(404, "厨房不存在，或你还不是这个厨房的成员。");
  if (owner && kitchen.role !== "owner") throw new HttpError(403, "只有厨房主人可以执行这个操作。");
  if (edit && kitchen.role === "viewer") throw new HttpError(403, "你是观看者，暂时不能修改这个厨房。");
  return kitchen;
}

async function touchKitchen(env, kitchenId, { clearSample = false } = {}) {
  const updatedAt = nowISO();
  if (clearSample) {
    await run(
      env,
      "UPDATE kitchens SET revision = revision + 1, updated_at = ?, is_sample = 0 WHERE id = ?",
      updatedAt,
      kitchenId,
    );
  } else {
    await run(
      env,
      "UPDATE kitchens SET revision = revision + 1, updated_at = ? WHERE id = ?",
      updatedAt,
      kitchenId,
    );
  }
  const row = await one(env, "SELECT revision FROM kitchens WHERE id = ?", kitchenId);
  return row ? row.revision : 0;
}

function getIngredientsForClient(env, kitchenId) {
  return all(
    env,
    `SELECT id, name, calories, unit, category, created_at, updated_at
     FROM ingredients WHERE kitchen_id = ?
     ORDER BY category ASC, created_at ASC, name ASC`,
    kitchenId,
  );
}

/* =========================================================
   Plan queries
   ========================================================= */

async function getPlan(env, kitchenId, userId, weekStart) {
  const kitchen = await requireMembership(env, kitchenId, userId);
  const normalized = normalizeWeekStart(weekStart);
  const dates = weekDateKeys(normalized);
  const days = {};
  dates.forEach((key) => {
    days[key] = { breakfast: [], lunch: [], dinner: [], snack: [] };
  });

  const rows = await all(
    env,
    `SELECT id, date, meal, name, calories, position
     FROM plan_items
     WHERE kitchen_id = ? AND date >= ? AND date <= ?
     ORDER BY date ASC, position ASC, created_at ASC`,
    kitchenId,
    dates[0],
    dates[6],
  );

  rows.forEach((row) => {
    if (!days[row.date] || !MEALS.includes(row.meal)) return;
    days[row.date][row.meal].push({ id: row.id, name: row.name, calories: row.calories });
  });

  return {
    weekStart: normalized,
    days,
    dailyTarget: kitchen.dailyTarget,
    revision: kitchen.revision,
    canEdit: kitchen.role !== "viewer",
    role: kitchen.role,
  };
}

async function nextPosition(env, kitchenId, date, meal) {
  const row = await one(
    env,
    "SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM plan_items WHERE kitchen_id = ? AND date = ? AND meal = ?",
    kitchenId,
    date,
    meal,
  );
  return Number(row?.next_position || 0);
}

function validatePlanPayload(body, weekStart) {
  const date = String(body.date || "");
  if (!parseDateKey(date)) throw new HttpError(400, "日期格式不正确。");
  if (weekStart) {
    const end = dateKey(addDays(parseDateKey(weekStart), 6));
    if (date < weekStart || date > end) throw new HttpError(400, "日期不在当前周内。");
  }
  const meal = String(body.meal || "");
  if (!MEALS.includes(meal)) throw new HttpError(400, "餐次不正确。");
  const name = cleanText(body.name, 40);
  if (!name) throw new HttpError(400, "请填写食物名称。");
  const calories = normalizeCalories(body.calories);
  return { date, meal, name, calories };
}

/* =========================================================
   Auth handlers
   ========================================================= */

async function handleRegister(request, env) {
  const body = await readJson(request);
  const username = cleanText(body.username, 24);
  const password = typeof body.password === "string" ? body.password : "";
  const displayName = cleanText(body.displayName, 30) || username;

  if (!USERNAME_RE.test(username)) throw new HttpError(400, "用户名需要 3–24 位，可使用中文、字母、数字、下划线或短横线。");
  if (password.length < 8 || password.length > 128) throw new HttpError(400, "密码需要 8–128 位。");
  if (!displayName) throw new HttpError(400, "请填写你的称呼。");

  const existing = await one(env, "SELECT id FROM users WHERE username = ?", username);
  if (existing) throw new HttpError(409, "这个用户名已经被使用了。");

  const userId = newId("usr");
  const createdAt = nowISO();
  const passwordHash = await hashPassword(password);
  const configuredAdmin = String(env.ADMIN_USERNAME || "").trim();
  const isAdmin = configuredAdmin && username.toLowerCase() === configuredAdmin.toLowerCase();
  await run(
    env,
    "INSERT INTO users (id, username, display_name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    userId,
    username,
    displayName,
    passwordHash,
    isAdmin ? 1 : 0,
    createdAt,
  );

  await createKitchenRecord(env, userId, displayName, `${displayName}的厨房`.slice(0, 30), {
    withSamplePlan: true,
  });

  const session = await createSession(env, request, userId);
  const user = await one(env, "SELECT * FROM users WHERE id = ?", userId);
  return json(
    { user: publicUser(user), kitchens: await getMemberships(env, userId) },
    201,
    { "Set-Cookie": session.cookie },
  );
}

async function handleLogin(request, env) {
  const body = await readJson(request);
  const username = cleanText(body.username, 24);
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password) throw new HttpError(400, "请输入用户名和密码。");

  const user = await one(env, "SELECT * FROM users WHERE username = ?", username);
  const passwordOk = await verifyPassword(password, user ? user.password_hash : "pbkdf2$invalid");
  if (!user || !passwordOk) throw new HttpError(401, "用户名或密码不正确。");

  const session = await createSession(env, request, user.id);
  return json(
    { user: publicUser(user), kitchens: await getMemberships(env, user.id) },
    200,
    { "Set-Cookie": session.cookie },
  );
}

async function handleLogout(request, env, user) {
  if (user) {
    const token = parseCookies(request)[SESSION_COOKIE];
    if (token) {
      await run(env, "DELETE FROM sessions WHERE token_hash = ?", await sha256Hex(token));
    }
  }
  return json(
    { ok: true },
    200,
    {
      "Set-Cookie": sessionCookie(request, "", 0),
    },
  );
}

async function handleMe(env, user) {
  if (!user) throw new HttpError(401, "请先登录。");
  return json({
    user: publicUser(user),
    kitchens: await getMemberships(env, user.id),
  });
}

async function handleUpdateProfile(request, env, user) {
  if (!user) throw new HttpError(401, "请先登录。");
  const body = await readJson(request);
  const displayName = cleanText(body.displayName, 30);
  if (!displayName) throw new HttpError(400, "昵称不能为空。");
  await run(env, "UPDATE users SET display_name = ? WHERE id = ?", displayName, user.id);
  const updated = await one(env, "SELECT * FROM users WHERE id = ?", user.id);
  return json({
    user: publicUser(updated),
    kitchens: await getMemberships(env, user.id),
  });
}

async function handleChangePassword(request, env, user) {
  if (!user) throw new HttpError(401, "请先登录。");
  const body = await readJson(request);
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  if (!currentPassword || !newPassword) throw new HttpError(400, "请填写当前密码和新密码。");
  if (newPassword.length < 8 || newPassword.length > 128) throw new HttpError(400, "新密码需要 8–128 位。");

  const row = await one(env, "SELECT password_hash FROM users WHERE id = ?", user.id);
  if (!row || !(await verifyPassword(currentPassword, row.password_hash))) {
    throw new HttpError(400, "当前密码不正确。");
  }
  if (await verifyPassword(newPassword, row.password_hash)) {
    throw new HttpError(400, "新密码不能和当前密码相同。");
  }

  await run(env, "UPDATE users SET password_hash = ? WHERE id = ?", await hashPassword(newPassword), user.id);
  const currentToken = parseCookies(request)[SESSION_COOKIE];
  const currentTokenHash = currentToken ? await sha256Hex(currentToken) : "";
  const result = await run(
    env,
    "DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?",
    user.id,
    currentTokenHash,
  );
  return json({ ok: true, revokedSessions: Number(result.meta?.changes || 0) });
}

/* =========================================================
   Kitchen handlers
   ========================================================= */

async function handleGetKitchen(env, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const detail = await getKitchenDetail(env, kitchenId, user.id);
  if (!detail) throw new HttpError(404, "厨房不存在，或你还不是这个厨房的成员。");
  return json(detail);
}

async function handleUpdateKitchen(request, env, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const body = await readJson(request);
  const hasName = Object.prototype.hasOwnProperty.call(body, "name");
  const hasTarget = Object.prototype.hasOwnProperty.call(body, "dailyTarget");
  if (!hasName && !hasTarget) throw new HttpError(400, "没有需要更新的内容。");
  const kitchen = await requireMembership(env, kitchenId, user.id);
  if (hasName && kitchen.role !== "owner") throw new HttpError(403, "只有厨房主人可以重命名厨房。");
  if (hasTarget && kitchen.role === "viewer") throw new HttpError(403, "你是观看者，不能修改每日目标。");

  let name = null;
  let target = null;
  if (hasName) {
    name = cleanText(body.name, 30);
    if (!name) throw new HttpError(400, "厨房名称不能为空。");
  }
  if (hasTarget) target = normalizeDailyTarget(body.dailyTarget);

  await run(
    env,
    `UPDATE kitchens SET name = COALESCE(?, name), daily_target = COALESCE(?, daily_target),
     revision = revision + 1, updated_at = ? WHERE id = ?`,
    name,
    target,
    nowISO(),
    kitchenId,
  );
  return json(await getKitchenDetail(env, kitchenId, user.id));
}

async function handleCreateKitchen(request, env, user) {
  if (!user) throw new HttpError(401, "请先登录。");
  const body = await readJson(request);
  const name = cleanText(body.name, 30);
  if (!name) throw new HttpError(400, "给厨房起个名字吧。");
  const kitchen = await createKitchenRecord(env, user.id, user.display_name, name);
  return json({ kitchen, kitchens: await getMemberships(env, user.id) }, 201);
}

async function handleCreateInvite(request, env, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  await requireMembership(env, kitchenId, user.id, { owner: true });
  const body = await readJson(request);
  const role = String(body.role || "viewer");
  if (role !== "editor" && role !== "viewer") throw new HttpError(400, "邀请权限不正确。");
  const code = randomToken(18);
  const createdAt = nowISO();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await run(
    env,
    `INSERT INTO invites (id, kitchen_id, code, role, created_by, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    newId("inv"),
    kitchenId,
    code,
    role,
    user.id,
    expiresAt,
    createdAt,
  );
  return json({ invite: { code, role, expiresAt, createdAt }, invites: await getActiveInvites(env, kitchenId) }, 201);
}

async function handleGetInvites(env, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  await requireMembership(env, kitchenId, user.id, { owner: true });
  return json({ invites: await getActiveInvites(env, kitchenId) });
}

async function handleRevokeInvite(env, user, kitchenId, inviteId) {
  if (!user) throw new HttpError(401, "请先登录。");
  await requireMembership(env, kitchenId, user.id, { owner: true });
  const result = await run(env, "UPDATE invites SET revoked = 1 WHERE id = ? AND kitchen_id = ?", inviteId, kitchenId);
  if (!result.meta?.changes) throw new HttpError(404, "邀请不存在。");
  return json({ invites: await getActiveInvites(env, kitchenId) });
}

async function handleInvitePreview(env, code) {
  const row = await one(
    env,
    `SELECT i.code, i.role, i.expires_at, i.revoked, k.id AS kitchen_id, k.name AS kitchen_name,
            u.display_name AS inviter_name
     FROM invites i JOIN kitchens k ON k.id = i.kitchen_id JOIN users u ON u.id = i.created_by
     WHERE i.code = ?`,
    code,
  );
  if (!row) throw new HttpError(404, "邀请链接无效。");
  if (row.revoked) throw new HttpError(410, "这个邀请已经被撤销。");
  if (row.expires_at <= nowISO()) throw new HttpError(410, "这个邀请已经过期。");
  return json({
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

async function handleAcceptInvite(env, user, code) {
  if (!user) throw new HttpError(401, "请先登录。");
  const invite = await one(
    env,
    `SELECT i.*, k.name AS kitchen_name FROM invites i JOIN kitchens k ON k.id = i.kitchen_id WHERE i.code = ?`,
    code,
  );
  if (!invite) throw new HttpError(404, "邀请链接无效。");
  if (invite.revoked) throw new HttpError(410, "这个邀请已经被撤销。");
  if (invite.expires_at <= nowISO()) throw new HttpError(410, "这个邀请已经过期。");

  const existing = await one(
    env,
    "SELECT role FROM memberships WHERE kitchen_id = ? AND user_id = ?",
    invite.kitchen_id,
    user.id,
  );
  let joined = false;
  if (!existing) {
    await run(
      env,
      "INSERT INTO memberships (kitchen_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)",
      invite.kitchen_id,
      user.id,
      invite.role,
      nowISO(),
    );
    joined = true;
  } else if (existing.role === "viewer" && invite.role === "editor") {
    await run(env, "UPDATE memberships SET role = 'editor' WHERE kitchen_id = ? AND user_id = ?", invite.kitchen_id, user.id);
  }
  await touchKitchen(env, invite.kitchen_id);
  return json({
    joined,
    kitchenId: invite.kitchen_id,
    kitchenName: invite.kitchen_name,
    role: invite.role,
    kitchens: await getMemberships(env, user.id),
  });
}

async function handleUpdateMember(request, env, user, kitchenId, memberId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = await requireMembership(env, kitchenId, user.id, { owner: true });
  if (memberId === kitchen.ownerId) throw new HttpError(400, "不能修改厨房主人的身份。");
  const body = await readJson(request);
  const role = String(body.role || "");
  if (role !== "editor" && role !== "viewer") throw new HttpError(400, "成员身份不正确。");
  const result = await run(env, "UPDATE memberships SET role = ? WHERE kitchen_id = ? AND user_id = ?", role, kitchenId, memberId);
  if (!result.meta?.changes) throw new HttpError(404, "成员不存在。");
  await touchKitchen(env, kitchenId);
  return json({ members: await getMembers(env, kitchenId) });
}

async function handleRemoveMember(env, user, kitchenId, memberId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = await requireMembership(env, kitchenId, user.id, { owner: true });
  if (memberId === kitchen.ownerId) throw new HttpError(400, "不能移除厨房主人。");
  const result = await run(env, "DELETE FROM memberships WHERE kitchen_id = ? AND user_id = ?", kitchenId, memberId);
  if (!result.meta?.changes) throw new HttpError(404, "成员不存在。");
  await touchKitchen(env, kitchenId);
  return json({ members: await getMembers(env, kitchenId) });
}

async function handleLeaveKitchen(env, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = await requireMembership(env, kitchenId, user.id);
  if (kitchen.role === "owner") throw new HttpError(400, "厨房主人不能退出自己的厨房。");
  await run(env, "DELETE FROM memberships WHERE kitchen_id = ? AND user_id = ?", kitchenId, user.id);
  await touchKitchen(env, kitchenId);
  return json({ kitchens: await getMemberships(env, user.id) });
}

/* =========================================================
   Ingredient handlers
   ========================================================= */

async function handleGetIngredients(env, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = await requireMembership(env, kitchenId, user.id);
  return json({
    ingredients: await getIngredientsForClient(env, kitchenId),
    canEdit: kitchen.role !== "viewer",
    role: kitchen.role,
  });
}

async function handleCreateIngredient(request, env, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = await requireMembership(env, kitchenId, user.id, { edit: true });
  const body = await readJson(request);
  const name = cleanText(body.name, 40);
  const unit = cleanText(body.unit, 24) || "1 份";
  const category = String(body.category || "other");
  if (!name) throw new HttpError(400, "请填写食材名称。");
  if (!INGREDIENT_CATEGORIES.has(category)) throw new HttpError(400, "食材分类不正确。");
  const calories = normalizeCalories(body.calories);
  const id = newId("ing");
  const createdAt = nowISO();
  await run(
    env,
    `INSERT INTO ingredients (id, kitchen_id, name, calories, unit, category, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    kitchenId,
    name,
    calories,
    unit,
    category,
    user.id,
    createdAt,
    createdAt,
  );
  await touchKitchen(env, kitchenId);
  return json({
    ingredient: await one(env, "SELECT * FROM ingredients WHERE id = ?", id),
    ingredients: await getIngredientsForClient(env, kitchenId),
    canEdit: kitchen.role !== "viewer",
  }, 201);
}

async function handleUpdateIngredient(request, env, user, kitchenId, ingredientId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = await requireMembership(env, kitchenId, user.id, { edit: true });
  const existing = await one(env, "SELECT * FROM ingredients WHERE id = ? AND kitchen_id = ?", ingredientId, kitchenId);
  if (!existing) throw new HttpError(404, "食材不存在。");
  const body = await readJson(request);
  const name = cleanText(body.name, 40);
  const unit = cleanText(body.unit, 24) || "1 份";
  const category = String(body.category || "other");
  if (!name) throw new HttpError(400, "请填写食材名称。");
  if (!INGREDIENT_CATEGORIES.has(category)) throw new HttpError(400, "食材分类不正确。");
  const calories = normalizeCalories(body.calories);
  await run(
    env,
    "UPDATE ingredients SET name = ?, calories = ?, unit = ?, category = ?, updated_at = ? WHERE id = ? AND kitchen_id = ?",
    name,
    calories,
    unit,
    category,
    nowISO(),
    ingredientId,
    kitchenId,
  );
  await touchKitchen(env, kitchenId);
  return json({
    ingredient: await one(env, "SELECT * FROM ingredients WHERE id = ?", ingredientId),
    ingredients: await getIngredientsForClient(env, kitchenId),
    canEdit: kitchen.role !== "viewer",
  });
}

async function handleDeleteIngredient(env, user, kitchenId, ingredientId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = await requireMembership(env, kitchenId, user.id, { edit: true });
  const result = await run(env, "DELETE FROM ingredients WHERE id = ? AND kitchen_id = ?", ingredientId, kitchenId);
  if (!result.meta?.changes) throw new HttpError(404, "食材不存在。");
  await touchKitchen(env, kitchenId);
  return json({
    ingredients: await getIngredientsForClient(env, kitchenId),
    canEdit: kitchen.role !== "viewer",
  });
}

/* =========================================================
   Plan handlers
   ========================================================= */

async function handleBatchDeleteIngredients(request, env, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = await requireMembership(env, kitchenId, user.id, { edit: true });
  const body = await readJson(request);
  const ids = Array.isArray(body.ids)
    ? [...new Set(body.ids.filter((id) => typeof id === "string" && /^[A-Za-z0-9_]+$/.test(id)))]
    : [];
  if (!ids.length) throw new HttpError(400, "请先选择要删除的食材。");
  if (ids.length > 90) throw new HttpError(400, "一次最多删除 90 种食材。");

  const placeholders = ids.map(() => "?").join(",");
  const existing = await all(
    env,
    `SELECT id FROM ingredients WHERE kitchen_id = ? AND id IN (${placeholders})`,
    kitchenId,
    ...ids,
  );
  if (existing.length !== ids.length) {
    throw new HttpError(404, "部分食材已经不存在，请刷新后再试。");
  }

  await run(
    env,
    `DELETE FROM ingredients WHERE kitchen_id = ? AND id IN (${placeholders})`,
    kitchenId,
    ...ids,
  );
  await touchKitchen(env, kitchenId);
  return json({
    ingredients: await getIngredientsForClient(env, kitchenId),
    canEdit: kitchen.role !== "viewer",
    deleted: ids.length,
  });
}

async function handleGetPlan(env, user, kitchenId, url) {
  if (!user) throw new HttpError(401, "请先登录。");
  return json(await getPlan(env, kitchenId, user.id, url.searchParams.get("weekStart")));
}

async function handleCreatePlanItem(request, env, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = await requireMembership(env, kitchenId, user.id, { edit: true });
  const body = await readJson(request);
  const weekStart = normalizeWeekStart(body.weekStart);
  const payload = validatePlanPayload(body, weekStart);
  const position = await nextPosition(env, kitchenId, payload.date, payload.meal);
  const id = newId("itm");
  const createdAt = nowISO();
  await run(
    env,
    `INSERT INTO plan_items (id, kitchen_id, date, meal, name, calories, position, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  await touchKitchen(env, kitchenId, { clearSample: true });
  return json({
    item: { id, name: payload.name, calories: payload.calories },
    plan: await getPlan(env, kitchenId, user.id, weekStart),
    canEdit: kitchen.role !== "viewer",
  }, 201);
}

async function handleUpdatePlanItem(request, env, user, kitchenId, itemId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = await requireMembership(env, kitchenId, user.id, { edit: true });
  const existing = await one(env, "SELECT * FROM plan_items WHERE id = ? AND kitchen_id = ?", itemId, kitchenId);
  if (!existing) throw new HttpError(404, "这一餐食物不存在。");
  const body = await readJson(request);
  const weekStart = normalizeWeekStart(body.weekStart || dateKey(startOfWeek(parseDateKey(existing.date))));
  const payload = validatePlanPayload(body, weekStart);
  const moved = existing.date !== payload.date || existing.meal !== payload.meal;
  const position = moved ? await nextPosition(env, kitchenId, payload.date, payload.meal) : existing.position;
  await run(
    env,
    `UPDATE plan_items SET date = ?, meal = ?, name = ?, calories = ?, position = ?, updated_at = ?
     WHERE id = ? AND kitchen_id = ?`,
    payload.date,
    payload.meal,
    payload.name,
    payload.calories,
    position,
    nowISO(),
    itemId,
    kitchenId,
  );
  await touchKitchen(env, kitchenId, { clearSample: true });
  return json({
    item: { id: itemId, name: payload.name, calories: payload.calories },
    plan: await getPlan(env, kitchenId, user.id, weekStart),
    canEdit: kitchen.role !== "viewer",
  });
}

async function handleDeletePlanItem(env, user, kitchenId, itemId, url) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = await requireMembership(env, kitchenId, user.id, { edit: true });
  const existing = await one(env, "SELECT * FROM plan_items WHERE id = ? AND kitchen_id = ?", itemId, kitchenId);
  if (!existing) throw new HttpError(404, "这一餐食物不存在。");
  const requestedWeek = url.searchParams.get("weekStart");
  const weekStart = requestedWeek
    ? normalizeWeekStart(requestedWeek)
    : dateKey(startOfWeek(parseDateKey(existing.date)));
  await run(env, "DELETE FROM plan_items WHERE id = ? AND kitchen_id = ?", itemId, kitchenId);
  await touchKitchen(env, kitchenId, { clearSample: true });
  return json({
    plan: await getPlan(env, kitchenId, user.id, weekStart),
    canEdit: kitchen.role !== "viewer",
  });
}

async function handleClearWeek(env, user, kitchenId, url) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = await requireMembership(env, kitchenId, user.id, { edit: true });
  const weekStart = normalizeWeekStart(url.searchParams.get("weekStart"));
  const dates = weekDateKeys(weekStart);
  await run(env, "DELETE FROM plan_items WHERE kitchen_id = ? AND date >= ? AND date <= ?", kitchenId, dates[0], dates[6]);
  await touchKitchen(env, kitchenId, { clearSample: true });
  return json({
    plan: await getPlan(env, kitchenId, user.id, weekStart),
    canEdit: kitchen.role !== "viewer",
  });
}

async function handleClearDay(env, user, kitchenId, url) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = await requireMembership(env, kitchenId, user.id, { edit: true });
  const date = String(url.searchParams.get("date") || "");
  const weekStart = normalizeWeekStart(url.searchParams.get("weekStart"));
  const dates = weekDateKeys(weekStart);
  if (!parseDateKey(date) || !dates.includes(date)) {
    throw new HttpError(400, "日期不在当前周内。");
  }

  const result = await run(env, "DELETE FROM plan_items WHERE kitchen_id = ? AND date = ?", kitchenId, date);
  await touchKitchen(env, kitchenId, { clearSample: true });
  return json({
    plan: await getPlan(env, kitchenId, user.id, weekStart),
    canEdit: kitchen.role !== "viewer",
    deleted: Number(result.meta?.changes || 0),
  });
}

/* =========================================================
   Admin data
   ========================================================= */

function requireAdmin(user) {
  if (!user) throw new HttpError(401, "请先登录。");
  if (!user.is_admin) throw new HttpError(403, "这个账号没有管理员权限。");
}

async function adminUserList(env) {
  const rows = await all(
    env,
    `SELECT u.id, u.username, u.display_name, u.is_admin, u.created_at,
            (SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id) AS kitchen_count,
            (SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id AND m.role = 'owner') AS owned_kitchen_count,
            (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS active_sessions
     FROM users u ORDER BY u.created_at DESC`,
    nowISO(),
  );
  return rows.map((row) => ({
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

async function adminKitchenList(env) {
  const rows = await all(
    env,
    `SELECT k.id, k.name, k.owner_id, k.daily_target, k.revision, k.is_sample,
            k.created_at, k.updated_at, u.display_name AS owner_name,
            (SELECT COUNT(*) FROM memberships m WHERE m.kitchen_id = k.id) AS member_count,
            (SELECT COUNT(*) FROM ingredients i WHERE i.kitchen_id = k.id) AS ingredient_count,
            (SELECT COUNT(*) FROM plan_items p WHERE p.kitchen_id = k.id) AS plan_item_count
     FROM kitchens k JOIN users u ON u.id = k.owner_id
     ORDER BY k.updated_at DESC`,
  );
  return rows.map((row) => ({
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

async function adminInviteList(env) {
  const rows = await all(
    env,
    `SELECT i.id, i.kitchen_id, i.role, i.created_by, i.expires_at, i.revoked, i.created_at,
            k.name AS kitchen_name, u.display_name AS creator_name
     FROM invites i JOIN kitchens k ON k.id = i.kitchen_id JOIN users u ON u.id = i.created_by
     ORDER BY CASE WHEN i.revoked = 0 AND i.expires_at > ? THEN 0 ELSE 1 END, i.created_at DESC`,
    nowISO(),
  );
  return rows.map((row) => ({
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

async function adminSessionList(env) {
  const rows = await all(
    env,
    `SELECT s.token_hash, s.user_id, s.created_at, s.expires_at, u.username, u.display_name
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.expires_at > ? ORDER BY s.created_at DESC`,
    nowISO(),
  );
  return rows.map((row) => ({
    id: row.token_hash,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }));
}

async function adminStats(env) {
  const count = async (sql, ...params) => {
    const row = await one(env, sql, ...params);
    return Number(row?.count || 0);
  };
  return {
    users: await count("SELECT COUNT(*) AS count FROM users"),
    admins: await count("SELECT COUNT(*) AS count FROM users WHERE is_admin = 1"),
    kitchens: await count("SELECT COUNT(*) AS count FROM kitchens"),
    memberships: await count("SELECT COUNT(*) AS count FROM memberships"),
    ingredients: await count("SELECT COUNT(*) AS count FROM ingredients"),
    planItems: await count("SELECT COUNT(*) AS count FROM plan_items"),
    activeInvites: await count("SELECT COUNT(*) AS count FROM invites WHERE revoked = 0 AND expires_at > ?", nowISO()),
    activeSessions: await count("SELECT COUNT(*) AS count FROM sessions WHERE expires_at > ?", nowISO()),
  };
}

async function adminOverview(env) {
  const users = await adminUserList(env);
  const kitchens = await adminKitchenList(env);
  return {
    stats: await adminStats(env),
    recentUsers: users.slice(0, 5),
    recentKitchens: kitchens.slice(0, 5),
  };
}

async function adminKitchenDetail(env, kitchenId) {
  const row = await one(
    env,
    `SELECT k.id, k.name, k.owner_id, k.daily_target, k.revision, k.is_sample,
            k.created_at, k.updated_at, u.display_name AS owner_name,
            (SELECT COUNT(*) FROM memberships m WHERE m.kitchen_id = k.id) AS member_count,
            (SELECT COUNT(*) FROM ingredients i WHERE i.kitchen_id = k.id) AS ingredient_count,
            (SELECT COUNT(*) FROM plan_items p WHERE p.kitchen_id = k.id) AS plan_item_count
     FROM kitchens k JOIN users u ON u.id = k.owner_id WHERE k.id = ?`,
    kitchenId,
  );
  if (!row) throw new HttpError(404, "厨房不存在。");
  const planItems = await all(
    env,
    `SELECT date, meal, name, calories, position FROM plan_items
     WHERE kitchen_id = ? ORDER BY date DESC, position ASC LIMIT 120`,
    kitchenId,
  );
  const totals = await one(
    env,
    "SELECT COUNT(*) AS items, COALESCE(SUM(calories), 0) AS calories FROM plan_items WHERE kitchen_id = ?",
    kitchenId,
  );
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
    members: await getMembers(env, kitchenId),
    ingredients: await getIngredientsForClient(env, kitchenId),
    planItems,
    totals: { items: Number(totals?.items || 0), calories: Number(totals?.calories || 0) },
  };
}

async function deleteKitchenData(env, kitchenId) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM plan_items WHERE kitchen_id = ?").bind(kitchenId),
    env.DB.prepare("DELETE FROM ingredients WHERE kitchen_id = ?").bind(kitchenId),
    env.DB.prepare("DELETE FROM invites WHERE kitchen_id = ?").bind(kitchenId),
    env.DB.prepare("DELETE FROM memberships WHERE kitchen_id = ?").bind(kitchenId),
    env.DB.prepare("DELETE FROM kitchens WHERE id = ?").bind(kitchenId),
  ]);
}

async function handleAdminApi(request, env, url, user) {
  requireAdmin(user);
  const pathname = url.pathname;
  const method = request.method || "GET";

  if (pathname === "/api/admin/overview" && method === "GET") return json(await adminOverview(env));
  if (pathname === "/api/admin/users" && method === "GET") return json({ users: await adminUserList(env) });
  if (pathname === "/api/admin/kitchens" && method === "GET") return json({ kitchens: await adminKitchenList(env) });
  if (pathname === "/api/admin/invites" && method === "GET") return json({ invites: await adminInviteList(env) });
  if (pathname === "/api/admin/sessions" && method === "GET") return json({ sessions: await adminSessionList(env) });

  let match = pathname.match(/^\/api\/admin\/kitchens\/([A-Za-z0-9_]+)$/);
  if (match && method === "GET") return json(await adminKitchenDetail(env, match[1]));
  if (match && method === "DELETE") {
    const kitchen = await one(env, "SELECT id, name FROM kitchens WHERE id = ?", match[1]);
    if (!kitchen) throw new HttpError(404, "厨房不存在。");
    await deleteKitchenData(env, match[1]);
    return json({ ok: true });
  }

  match = pathname.match(/^\/api\/admin\/users\/([A-Za-z0-9_]+)$/);
  if (match && method === "PATCH") {
    const target = await one(env, "SELECT id, username, display_name, is_admin FROM users WHERE id = ?", match[1]);
    if (!target) throw new HttpError(404, "用户不存在。");
    const body = await readJson(request);
    if (typeof body.isAdmin !== "boolean") throw new HttpError(400, "isAdmin 必须是布尔值。");
    if (target.id === user.id) throw new HttpError(400, "不能修改自己的管理员身份，请让另一位管理员操作。");
    if (!body.isAdmin && target.is_admin) {
      const admins = await one(env, "SELECT COUNT(*) AS count FROM users WHERE is_admin = 1");
      if (Number(admins?.count || 0) <= 1) throw new HttpError(400, "至少需要保留一位管理员。");
    }
    await run(env, "UPDATE users SET is_admin = ? WHERE id = ?", body.isAdmin ? 1 : 0, target.id);
    const updated = (await adminUserList(env)).find((item) => item.id === target.id);
    return json({ user: updated });
  }

  if (match && method === "DELETE") {
    const target = await one(env, "SELECT id, username, display_name, is_admin FROM users WHERE id = ?", match[1]);
    if (!target) throw new HttpError(404, "用户不存在。");
    if (target.id === user.id) throw new HttpError(400, "不能删除自己的账号。");
    if (target.is_admin) {
      const admins = await one(env, "SELECT COUNT(*) AS count FROM users WHERE is_admin = 1");
      if (Number(admins?.count || 0) <= 1) throw new HttpError(400, "至少需要保留一位管理员。");
    }
    const owned = await all(env, "SELECT id FROM kitchens WHERE owner_id = ?", target.id);
    for (const kitchen of owned) await deleteKitchenData(env, kitchen.id);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM invites WHERE created_by = ?").bind(target.id),
      env.DB.prepare("DELETE FROM memberships WHERE user_id = ?").bind(target.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(target.id),
      env.DB.prepare("DELETE FROM users WHERE id = ?").bind(target.id),
    ]);
    return json({ ok: true });
  }

  match = pathname.match(/^\/api\/admin\/invites\/([A-Za-z0-9_]+)$/);
  if (match && method === "DELETE") {
    const result = await run(env, "UPDATE invites SET revoked = 1 WHERE id = ?", match[1]);
    if (!result.meta?.changes) throw new HttpError(404, "邀请不存在。");
    return json({ ok: true });
  }

  match = pathname.match(/^\/api\/admin\/sessions\/([a-f0-9]{64})$/);
  if (match && method === "DELETE") {
    const result = await run(env, "DELETE FROM sessions WHERE token_hash = ?", match[1]);
    if (!result.meta?.changes) throw new HttpError(404, "会话不存在或已经过期。");
    return json({ ok: true });
  }

  throw new HttpError(404, "没有找到这个管理接口。");
}

/* =========================================================
   Router
   ========================================================= */

async function handleRequest(request, env) {
  requireHeaderCsrf(request);
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method || "GET";

  if (method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (pathname === "/api/health" && method === "GET") {
    return json({ ok: true, platform: "cloudflare" });
  }

  if (pathname === "/api/runtime" && method === "GET") {
    return json({ realtime: false, platform: "cloudflare" });
  }

  if (pathname === "/api/auth/register" && method === "POST") {
    return handleRegister(request, env);
  }

  if (pathname === "/api/auth/login" && method === "POST") {
    return handleLogin(request, env);
  }

  const user = await getSession(env, request);

  if (pathname === "/api/auth/logout" && method === "POST") {
    return handleLogout(request, env, user);
  }

  if (pathname === "/api/auth/me" && method === "GET") {
    return handleMe(env, user);
  }

  if (pathname === "/api/auth/profile" && method === "PATCH") {
    return handleUpdateProfile(request, env, user);
  }

  if (pathname === "/api/auth/password" && method === "POST") {
    return handleChangePassword(request, env, user);
  }

  if (pathname.startsWith("/api/admin/")) {
    return handleAdminApi(request, env, url, user);
  }

  if (pathname === "/api/kitchens" && method === "GET") {
    if (!user) throw new HttpError(401, "请先登录。");
    return json({ user: publicUser(user), kitchens: await getMemberships(env, user.id) });
  }

  if (pathname === "/api/kitchens" && method === "POST") {
    return handleCreateKitchen(request, env, user);
  }

  let match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)$/);
  if (match) {
    if (method === "GET") return handleGetKitchen(env, user, match[1]);
    if (method === "PATCH") return handleUpdateKitchen(request, env, user, match[1]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/plan$/);
  if (match) {
    if (method === "GET") return handleGetPlan(env, user, match[1], url);
    if (method === "DELETE") return handleClearWeek(env, user, match[1], url);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/plan\/day$/);
  if (match && method === "DELETE") {
    return handleClearDay(env, user, match[1], url);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/plan\/items$/);
  if (match && method === "POST") {
    return handleCreatePlanItem(request, env, user, match[1]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/plan\/items\/([A-Za-z0-9_]+)$/);
  if (match) {
    if (method === "PATCH") return handleUpdatePlanItem(request, env, user, match[1], match[2]);
    if (method === "DELETE") return handleDeletePlanItem(env, user, match[1], match[2], url);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/ingredients$/);
  if (match) {
    if (method === "GET") return handleGetIngredients(env, user, match[1]);
    if (method === "POST") return handleCreateIngredient(request, env, user, match[1]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/ingredients\/batch-delete$/);
  if (match && method === "POST") {
    return handleBatchDeleteIngredients(request, env, user, match[1]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/ingredients\/([A-Za-z0-9_]+)$/);
  if (match) {
    if (method === "PATCH") return handleUpdateIngredient(request, env, user, match[1], match[2]);
    if (method === "DELETE") return handleDeleteIngredient(env, user, match[1], match[2]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/invites$/);
  if (match) {
    if (method === "GET") return handleGetInvites(env, user, match[1]);
    if (method === "POST") return handleCreateInvite(request, env, user, match[1]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/invites\/([A-Za-z0-9_]+)$/);
  if (match && method === "DELETE") {
    return handleRevokeInvite(env, user, match[1], match[2]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/members\/([A-Za-z0-9_]+)$/);
  if (match) {
    if (method === "PATCH") return handleUpdateMember(request, env, user, match[1], match[2]);
    if (method === "DELETE") return handleRemoveMember(env, user, match[1], match[2]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/leave$/);
  if (match && method === "POST") {
    return handleLeaveKitchen(env, user, match[1]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/events$/);
  if (match && method === "GET") {
    if (!user) throw new HttpError(401, "请先登录。");
    return new Response(null, { status: 204 });
  }

  match = pathname.match(/^\/api\/invites\/([A-Za-z0-9_-]+)$/);
  if (match && method === "GET") {
    return handleInvitePreview(env, match[1]);
  }

  match = pathname.match(/^\/api\/invites\/([A-Za-z0-9_-]+)\/accept$/);
  if (match && method === "POST") {
    return handleAcceptInvite(env, user, match[1]);
  }

  throw new HttpError(404, "没有找到这个接口。");
}

export async function onRequest(context) {
  try {
    return await handleRequest(context.request, context.env);
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message }, error.status);
    }
    console.error("[cougou-cloudflare]", error);
    return json({ error: "服务器开小差了，请稍后再试。" }, 500);
  }
}
