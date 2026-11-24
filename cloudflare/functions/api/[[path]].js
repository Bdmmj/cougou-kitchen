/**
 * 凑狗厨房 · Cloudflare Pages Functions API
 * D1-backed port of the local Node server.
 */

const MEALS = ["breakfast", "lunch", "dinner", "snack"];
const MEAL_LABELS = { breakfast: "早餐", lunch: "午餐", dinner: "晚餐", snack: "加餐" };
const COOK_SLOTS = new Set(["morning", "afternoon"]);
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

async function getMessages(env, kitchenId, limit = 50) {
  const rows = await all(
    env,
    `SELECT m.id, m.content, m.created_at, m.user_id,
            u.display_name AS author_name
     FROM messages m JOIN users u ON u.id = m.user_id
     WHERE m.kitchen_id = ?
     ORDER BY m.created_at DESC
     LIMIT ?`,
    kitchenId,
    limit,
  );
  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    authorId: row.user_id,
    authorName: row.author_name,
    createdAt: row.created_at,
  }));
}

async function getKitchenDetail(env, kitchenId, userId) {
  const kitchen = await getKitchenSummary(env, kitchenId, userId);
  if (!kitchen) return null;
  const members = await getMembers(env, kitchenId);
  const invites = kitchen.role === "owner" ? await getActiveInvites(env, kitchenId) : [];
  return { kitchen, members, invites, messages: await getMessages(env, kitchenId) };
}

async function requireMembership(env, kitchenId, userId, { edit = false, owner = false } = {}) {
  const kitchen = await getKitchenSummary(env, kitchenId, userId);
  if (!kitchen) throw new HttpError(404, "厨房不存在，或你还不是这个厨房的成员。");
  if (owner && kitchen.role !== "owner") throw new HttpError(403, "只有厨房主人可以执行这个操作。");
  if (edit && kitchen.role === "viewer") throw new HttpError(403, "你是访客，暂时不能修改这个厨房。");
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

  let cooks = {};
  try {
    cooks = await getCooks(env, kitchenId, dates[0], dates[6]);
  } catch (error) {
    console.error("[cougou-cloudflare] 无法读取掌勺安排：", error);
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
   Week copy, templates, favorites & table module
   ========================================================= */

async function readWeekItems(env, kitchenId, weekStart) {
  const dates = weekDateKeys(weekStart);
  return all(
    env,
    `SELECT date, meal, name, calories, position
     FROM plan_items
     WHERE kitchen_id = ? AND date >= ? AND date <= ?
     ORDER BY date ASC, position ASC, created_at ASC`,
    kitchenId,
    dates[0],
    dates[6],
  );
}

function weekPayloadFromRows(rows, weekStart) {
  const dates = weekDateKeys(weekStart);
  const indexByDate = new Map(dates.map((date, index) => [date, index]));
  const days = dates.map(() => ({ breakfast: [], lunch: [], dinner: [], snack: [] }));
  rows.forEach((row) => {
    const index = indexByDate.get(row.date);
    if (index === undefined || !MEALS.includes(row.meal)) return;
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

async function getTemplates(env, kitchenId) {
  const rows = await all(
    env,
    `SELECT t.id, t.name, t.payload, t.created_by, t.created_at, t.updated_at,
            u.display_name AS creator_name
     FROM week_templates t
     LEFT JOIN users u ON u.id = t.created_by
     WHERE t.kitchen_id = ?
     ORDER BY t.created_at DESC
     LIMIT 60`,
    kitchenId,
  );
  return rows.map(mapTemplate);
}

async function getTemplate(env, kitchenId, templateId) {
  const row = await one(
    env,
    `SELECT t.id, t.name, t.payload, t.created_by, t.created_at, t.updated_at,
            u.display_name AS creator_name
     FROM week_templates t
     LEFT JOIN users u ON u.id = t.created_by
     WHERE t.id = ? AND t.kitchen_id = ?`,
    templateId,
    kitchenId,
  );
  return row ? mapTemplate(row) : null;
}

async function maxPositionsForWeek(env, kitchenId, weekStart) {
  const dates = weekDateKeys(weekStart);
  const rows = await all(
    env,
    `SELECT date, meal, MAX(position) AS max_position
     FROM plan_items
     WHERE kitchen_id = ? AND date >= ? AND date <= ?
     GROUP BY date, meal`,
    kitchenId,
    dates[0],
    dates[6],
  );
  return new Map(rows.map((row) => [`${row.date}|${row.meal}`, Number(row.max_position) + 1]));
}

function planItemStatement(env, kitchenId, userId, date, meal, item, position) {
  const createdAt = nowISO();
  return env.DB.prepare(
    `INSERT INTO plan_items
      (id, kitchen_id, date, meal, name, calories, position, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(newId("itm"), kitchenId, date, meal, item.name, item.calories, position, userId, createdAt, createdAt);
}

async function runStatements(env, statements) {
  for (let index = 0; index < statements.length; index += 60) {
    await env.DB.batch(statements.slice(index, index + 60));
  }
}

async function copyPlanWeek(env, kitchenId, userId, sourceWeekStart, targetWeekStart, mode) {
  const rows = await readWeekItems(env, kitchenId, sourceWeekStart);
  if (!rows.length) throw new HttpError(400, "上一周还没有安排食物，没有可以复制的食谱。");
  const payload = weekPayloadFromRows(rows, sourceWeekStart);
  const targetDates = weekDateKeys(targetWeekStart);
  const statements = [];
  if (mode === "replace") {
    statements.push(
      env.DB.prepare("DELETE FROM plan_items WHERE kitchen_id = ? AND date >= ? AND date <= ?").bind(
        kitchenId,
        targetDates[0],
        targetDates[6],
      ),
    );
  }
  const positions = mode === "replace" ? new Map() : await maxPositionsForWeek(env, kitchenId, targetWeekStart);
  let copied = 0;
  payload.days.forEach((day, dayIndex) => {
    Object.entries(day).forEach(([meal, items]) => {
      items.forEach((item) => {
        const key = `${targetDates[dayIndex]}|${meal}`;
        const position = positions.get(key) || 0;
        statements.push(planItemStatement(env, kitchenId, userId, targetDates[dayIndex], meal, item, position));
        positions.set(key, position + 1);
        copied += 1;
      });
    });
  });
  await runStatements(env, statements);
  return copied;
}

async function applyWeekPayload(env, kitchenId, userId, weekStart, days, mode) {
  const targetDates = weekDateKeys(weekStart);
  const statements = [];
  if (mode === "replace") {
    statements.push(
      env.DB.prepare("DELETE FROM plan_items WHERE kitchen_id = ? AND date >= ? AND date <= ?").bind(
        kitchenId,
        targetDates[0],
        targetDates[6],
      ),
    );
  }
  const positions = mode === "replace" ? new Map() : await maxPositionsForWeek(env, kitchenId, weekStart);
  let applied = 0;
  days.forEach((day, dayIndex) => {
    Object.entries(day).forEach(([meal, items]) => {
      items.forEach((item) => {
        const key = `${targetDates[dayIndex]}|${meal}`;
        const position = positions.get(key) || 0;
        statements.push(planItemStatement(env, kitchenId, userId, targetDates[dayIndex], meal, item, position));
        positions.set(key, position + 1);
        applied += 1;
      });
    });
  });
  await runStatements(env, statements);
  return applied;
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

async function getFavorites(env, kitchenId) {
  const rows = await all(
    env,
    `SELECT f.id, f.name, f.meal, f.items, f.created_by, f.created_at,
            u.display_name AS creator_name
     FROM meal_favorites f
     LEFT JOIN users u ON u.id = f.created_by
     WHERE f.kitchen_id = ?
     ORDER BY f.created_at DESC
     LIMIT 100`,
    kitchenId,
  );
  return rows.map(mapFavorite);
}

async function getFavorite(env, kitchenId, favoriteId) {
  const row = await one(
    env,
    `SELECT f.id, f.name, f.meal, f.items, f.created_by, f.created_at,
            u.display_name AS creator_name
     FROM meal_favorites f
     LEFT JOIN users u ON u.id = f.created_by
     WHERE f.id = ? AND f.kitchen_id = ?`,
    favoriteId,
    kitchenId,
  );
  return row ? mapFavorite(row) : null;
}

async function getCooks(env, kitchenId, startDate, endDate) {
  const rows = await all(
    env,
    `SELECT c.date, c.slot, c.user_id, c.updated_at, u.display_name
     FROM day_cook_slots c
     LEFT JOIN users u ON u.id = c.user_id
     WHERE c.kitchen_id = ? AND c.date >= ? AND c.date <= ?
     ORDER BY c.date ASC, CASE c.slot WHEN 'morning' THEN 0 ELSE 1 END`,
    kitchenId,
    startDate,
    endDate,
  );
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

async function getMemberRecord(env, kitchenId, userId) {
  return one(
    env,
    `SELECT u.id, u.username, u.display_name
     FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.kitchen_id = ? AND m.user_id = ?`,
    kitchenId,
    userId,
  );
}

async function getGroceries(env, kitchenId, weekStart) {
  const rows = await all(
    env,
    `SELECT g.id, g.week_start, g.day_index, g.user_id, g.note, g.done,
            g.created_by, g.created_at, g.updated_at,
            u.display_name AS user_name
     FROM grocery_duties g
     LEFT JOIN users u ON u.id = g.user_id
     WHERE g.kitchen_id = ? AND g.week_start = ?
     ORDER BY COALESCE(g.day_index, 7) ASC, g.created_at ASC`,
    kitchenId,
    weekStart,
  );
  return rows.map((row) => ({
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

async function getPolls(env, kitchenId, userId) {
  const rows = await all(
    env,
    `SELECT p.id, p.title, p.note, p.status, p.created_by, p.created_at,
            p.updated_at, p.closed_at, u.display_name AS creator_name
     FROM meal_polls p
     LEFT JOIN users u ON u.id = p.created_by
     WHERE p.kitchen_id = ?
     ORDER BY CASE p.status WHEN 'open' THEN 0 ELSE 1 END, p.created_at DESC
     LIMIT 40`,
    kitchenId,
  );
  if (!rows.length) return [];

  const optionRows = await all(
    env,
    `SELECT o.id, o.poll_id, o.label, o.position
     FROM poll_options o
     JOIN meal_polls p ON p.id = o.poll_id
     WHERE p.kitchen_id = ?
     ORDER BY o.position ASC`,
    kitchenId,
  );
  const optionsByPoll = new Map();
  optionRows.forEach((row) => {
    if (!optionsByPoll.has(row.poll_id)) optionsByPoll.set(row.poll_id, []);
    optionsByPoll.get(row.poll_id).push({ id: row.id, label: row.label, voters: [] });
  });

  const voteRows = await all(
    env,
    `SELECT v.poll_id, v.option_id, v.user_id, u.display_name
     FROM poll_votes v
     JOIN poll_options o ON o.id = v.option_id
     JOIN meal_polls p ON p.id = v.poll_id
     JOIN users u ON u.id = v.user_id
     WHERE p.kitchen_id = ?
     ORDER BY v.created_at ASC`,
    kitchenId,
  );
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

async function getGathering(env, kitchenId, userId, weekStart) {
  const kitchen = await requireMembership(env, kitchenId, userId);
  const normalized = normalizeWeekStart(weekStart);
  const dates = weekDateKeys(normalized);
  return {
    weekStart: normalized,
    canEdit: kitchen.role !== "viewer",
    role: kitchen.role,
    members: await getMembers(env, kitchenId),
    cooks: await getCooks(env, kitchenId, dates[0], dates[6]),
    groceries: await getGroceries(env, kitchenId, normalized),
    polls: await getPolls(env, kitchenId, userId),
    messages: await getMessages(env, kitchenId),
  };
}

async function requirePoll(env, kitchenId, pollId) {
  const poll = await one(
    env,
    "SELECT id, kitchen_id, title, status, created_by FROM meal_polls WHERE id = ? AND kitchen_id = ?",
    pollId,
    kitchenId,
  );
  if (!poll) throw new HttpError(404, "这个投票已经不存在了。");
  return poll;
}

function canManagePoll(poll, kitchen, userId) {
  return poll.created_by === userId || kitchen.role === "owner";
}

async function handleCopyWeek(request, env, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  await requireMembership(env, kitchenId, user.id, { edit: true });
  const body = await readJson(request);
  const sourceWeekStart = normalizeWeekStart(body.sourceWeekStart);
  const targetWeekStart = normalizeWeekStart(body.targetWeekStart);
  if (sourceWeekStart === targetWeekStart) throw new HttpError(400, "来源周和本周是同一周，换一周再复制吧。");
  const mode = body.mode === "replace" ? "replace" : "merge";
  const copied = await copyPlanWeek(env, kitchenId, user.id, sourceWeekStart, targetWeekStart, mode);
  await touchKitchen(env, kitchenId, { clearSample: true });
  return json({ copied, mode, plan: await getPlan(env, kitchenId, user.id, targetWeekStart) });
}

async function handleGetTemplates(env, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  await requireMembership(env, kitchenId, user.id);
  return json({ templates: await getTemplates(env, kitchenId) });
}

async function handleCreateTemplate(request, env, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  await requireMembership(env, kitchenId, user.id, { edit: true });
  const body = await readJson(request);
  const weekStart = normalizeWeekStart(body.weekStart || dateKey(startOfWeek(new Date())));
  const rows = await readWeekItems(env, kitchenId, weekStart);
  if (!rows.length) throw new HttpError(400, "这一周还没有安排食物，先加点菜再存模板吧。");
  const name = cleanText(body.name, 30) || `${weekStart.slice(5).replace("-", "/")} 的一周`;
  const count = await one(env, "SELECT COUNT(*) AS count FROM week_templates WHERE kitchen_id = ?", kitchenId);
  if (Number(count?.count || 0) >= 60) throw new HttpError(400, "模板太多了，先删掉一些再保存。");
  const payload = weekPayloadFromRows(rows, weekStart);
  const id = newId("tpl");
  const createdAt = nowISO();
  await run(
    env,
    `INSERT INTO week_templates (id, kitchen_id, name, payload, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    kitchenId,
    name,
    JSON.stringify(payload),
    user.id,
    createdAt,
    createdAt,
  );
  return json({ templates: await getTemplates(env, kitchenId) }, 201);
}

async function handleDeleteTemplate(env, user, kitchenId, templateId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = await requireMembership(env, kitchenId, user.id, { edit: true });
  const template = await one(
    env,
    "SELECT id, created_by FROM week_templates WHERE id = ? AND kitchen_id = ?",
    templateId,
    kitchenId,
  );
  if (!template) throw new HttpError(404, "这个模板已经不存在了。");
  if (template.created_by !== user.id && kitchen.role !== "owner") {
    throw new HttpError(403, "只有模板的保存者或厨房主人可以删除这个模板。");
  }
  await run(env, "DELETE FROM week_templates WHERE id = ?", templateId);
  return json({ templates: await getTemplates(env, kitchenId) });
}

async function handleApplyTemplate(request, env, user, kitchenId, templateId) {
  if (!user) throw new HttpError(401, "请先登录。");
  await requireMembership(env, kitchenId, user.id, { edit: true });
  const body = await readJson(request);
  const weekStart = normalizeWeekStart(body.weekStart);
  const mode = body.mode === "replace" ? "replace" : "merge";
  const template = await getTemplate(env, kitchenId, templateId);
  if (!template) throw new HttpError(404, "这个模板已经不存在了。");
  if (!template.itemCount) throw new HttpError(400, "这个模板是空的，先保存一份有内容的模板吧。");
  const applied = await applyWeekPayload(env, kitchenId, user.id, weekStart, template.days, mode);
  await touchKitchen(env, kitchenId, { clearSample: true });
  return json({ applied, mode, plan: await getPlan(env, kitchenId, user.id, weekStart) });
}

async function handleGetFavorites(env, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  await requireMembership(env, kitchenId, user.id);
  return json({ favorites: await getFavorites(env, kitchenId) });
}

async function handleCreateFavorite(request, env, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  await requireMembership(env, kitchenId, user.id, { edit: true });
  const body = await readJson(request);
  const date = String(body.date || "");
  const meal = String(body.meal || "");
  if (!parseDateKey(date)) throw new HttpError(400, "日期格式不正确。");
  if (!MEALS.includes(meal)) throw new HttpError(400, "餐次不正确。");
  const items = await all(
    env,
    `SELECT name, calories FROM plan_items
     WHERE kitchen_id = ? AND date = ? AND meal = ?
     ORDER BY position ASC, created_at ASC`,
    kitchenId,
    date,
    meal,
  );
  if (!items.length) throw new HttpError(400, "这一餐还是空的，先安排点食物再收藏吧。");
  const count = await one(env, "SELECT COUNT(*) AS count FROM meal_favorites WHERE kitchen_id = ?", kitchenId);
  if (Number(count?.count || 0) >= 100) throw new HttpError(400, "收藏太多了，先整理一下吧。");
  const name = cleanText(body.name, 30) || `${MEAL_LABELS[meal]} · ${items[0].name}`;
  await run(
    env,
    `INSERT INTO meal_favorites (id, kitchen_id, name, meal, items, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    newId("fav"),
    kitchenId,
    name,
    meal,
    JSON.stringify(items.map((item) => ({ name: item.name, calories: item.calories }))),
    user.id,
    nowISO(),
  );
  return json({ favorites: await getFavorites(env, kitchenId) }, 201);
}

async function handleDeleteFavorite(env, user, kitchenId, favoriteId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = await requireMembership(env, kitchenId, user.id, { edit: true });
  const favorite = await one(
    env,
    "SELECT id, created_by FROM meal_favorites WHERE id = ? AND kitchen_id = ?",
    favoriteId,
    kitchenId,
  );
  if (!favorite) throw new HttpError(404, "这个收藏已经不存在了。");
  if (favorite.created_by !== user.id && kitchen.role !== "owner") {
    throw new HttpError(403, "只有收藏者或厨房主人可以删除这个收藏。");
  }
  await run(env, "DELETE FROM meal_favorites WHERE id = ?", favoriteId);
  return json({ favorites: await getFavorites(env, kitchenId) });
}

async function handleApplyFavorite(request, env, user, kitchenId, favoriteId) {
  if (!user) throw new HttpError(401, "请先登录。");
  await requireMembership(env, kitchenId, user.id, { edit: true });
  const body = await readJson(request);
  const weekStart = normalizeWeekStart(body.weekStart);
  const date = String(body.date || "");
  const meal = String(body.meal || "");
  const dates = weekDateKeys(weekStart);
  if (!parseDateKey(date) || !dates.includes(date)) throw new HttpError(400, "日期不在当前周内。");
  if (!MEALS.includes(meal)) throw new HttpError(400, "餐次不正确。");
  const favorite = await getFavorite(env, kitchenId, favoriteId);
  if (!favorite) throw new HttpError(404, "这个收藏已经不存在了。");
  if (!favorite.items.length) throw new HttpError(400, "这个收藏是空的。");
  const positions = await maxPositionsForWeek(env, kitchenId, weekStart);
  const key = `${date}|${meal}`;
  let position = positions.get(key) || 0;
  const statements = [];
  favorite.items.forEach((item) => {
    statements.push(planItemStatement(env, kitchenId, user.id, date, meal, item, position));
    position += 1;
  });
  await runStatements(env, statements);
  await touchKitchen(env, kitchenId, { clearSample: true });
  return json({ added: favorite.items.length, plan: await getPlan(env, kitchenId, user.id, weekStart) });
}

async function handleSetCook(request, env, user, kitchenId, date, slot = "afternoon") {
  if (!user) throw new HttpError(401, "请先登录。");
  await requireMembership(env, kitchenId, user.id, { edit: true });
  if (!parseDateKey(date)) throw new HttpError(400, "日期格式不正确。");
  if (!COOK_SLOTS.has(slot)) throw new HttpError(400, "做饭时段不正确。");
  const body = await readJson(request);
  const member = await getMemberRecord(env, kitchenId, String(body.userId || ""));
  if (!member) throw new HttpError(400, "请选择一位当前厨房的成员。");
  await run(
    env,
    `INSERT INTO day_cook_slots (kitchen_id, date, slot, user_id, assigned_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(kitchen_id, date, slot)
     DO UPDATE SET user_id = excluded.user_id, assigned_by = excluded.assigned_by, updated_at = excluded.updated_at`,
    kitchenId,
    date,
    slot,
    member.id,
    user.id,
    nowISO(),
  );
  const weekStart = dateKey(startOfWeek(parseDateKey(date)));
  const weekDates = weekDateKeys(weekStart);
  return json({ weekStart, slot, cooks: await getCooks(env, kitchenId, weekDates[0], weekDates[6]) });
}

async function handleClearCook(env, user, kitchenId, date, slot = null) {
  if (!user) throw new HttpError(401, "请先登录。");
  await requireMembership(env, kitchenId, user.id, { edit: true });
  if (!parseDateKey(date)) throw new HttpError(400, "日期格式不正确。");
  if (slot !== null && !COOK_SLOTS.has(slot)) throw new HttpError(400, "做饭时段不正确。");
  if (slot) {
    await run(env, "DELETE FROM day_cook_slots WHERE kitchen_id = ? AND date = ? AND slot = ?", kitchenId, date, slot);
  } else {
    await run(env, "DELETE FROM day_cook_slots WHERE kitchen_id = ? AND date = ?", kitchenId, date);
  }
  const weekStart = dateKey(startOfWeek(parseDateKey(date)));
  const weekDates = weekDateKeys(weekStart);
  return json({ weekStart, slot, cooks: await getCooks(env, kitchenId, weekDates[0], weekDates[6]) });
}

async function handleGetGathering(env, user, kitchenId, url) {
  if (!user) throw new HttpError(401, "请先登录。");
  return json(await getGathering(env, kitchenId, user.id, url.searchParams.get("weekStart")));
}

async function handleCreateGrocery(request, env, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  await requireMembership(env, kitchenId, user.id, { edit: true });
  const body = await readJson(request);
  const weekStart = normalizeWeekStart(body.weekStart);
  const member = await getMemberRecord(env, kitchenId, String(body.userId || ""));
  if (!member) throw new HttpError(400, "请选择一位当前厨房的成员。");
  let dayIndex = null;
  if (body.dayIndex !== null && body.dayIndex !== undefined && body.dayIndex !== "") {
    dayIndex = Number(body.dayIndex);
    if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex > 6) {
      throw new HttpError(400, "请选择本周内的某一天。");
    }
  }
  const note = cleanText(body.note, 60);
  const count = await one(
    env,
    "SELECT COUNT(*) AS count FROM grocery_duties WHERE kitchen_id = ? AND week_start = ?",
    kitchenId,
    weekStart,
  );
  if (Number(count?.count || 0) >= 20) throw new HttpError(400, "这一周的买菜安排已经很多了。");
  const createdAt = nowISO();
  await run(
    env,
    `INSERT INTO grocery_duties
      (id, kitchen_id, week_start, day_index, user_id, note, done, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    newId("buy"),
    kitchenId,
    weekStart,
    dayIndex,
    member.id,
    note,
    user.id,
    createdAt,
    createdAt,
  );
  return json({ groceries: await getGroceries(env, kitchenId, weekStart) }, 201);
}

async function handleUpdateGrocery(request, env, user, kitchenId, groceryId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = await requireMembership(env, kitchenId, user.id);
  const duty = await one(env, "SELECT * FROM grocery_duties WHERE id = ? AND kitchen_id = ?", groceryId, kitchenId);
  if (!duty) throw new HttpError(404, "这项买菜安排已经不存在了。");
  const body = await readJson(request);
  const keys = Object.keys(body);
  const onlyDone = keys.length === 1 && keys[0] === "done";
  const canToggleOwn = onlyDone && duty.user_id === user.id;
  if (kitchen.role === "viewer" && !canToggleOwn) {
    throw new HttpError(403, "你是访客，只能更新自己负责的买菜进度。");
  }
  let userId = duty.user_id;
  if (Object.prototype.hasOwnProperty.call(body, "userId")) {
    const member = await getMemberRecord(env, kitchenId, String(body.userId || ""));
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
  const note = Object.prototype.hasOwnProperty.call(body, "note") ? cleanText(body.note, 60) : duty.note;
  const done = Object.prototype.hasOwnProperty.call(body, "done") ? (body.done ? 1 : 0) : duty.done;
  await run(
    env,
    `UPDATE grocery_duties
     SET user_id = ?, day_index = ?, note = ?, done = ?, updated_at = ?
     WHERE id = ? AND kitchen_id = ?`,
    userId,
    dayIndex,
    note,
    done,
    nowISO(),
    groceryId,
    kitchenId,
  );
  return json({ groceries: await getGroceries(env, kitchenId, duty.week_start) });
}

async function handleDeleteGrocery(env, user, kitchenId, groceryId) {
  if (!user) throw new HttpError(401, "请先登录。");
  await requireMembership(env, kitchenId, user.id, { edit: true });
  const duty = await one(
    env,
    "SELECT id, week_start FROM grocery_duties WHERE id = ? AND kitchen_id = ?",
    groceryId,
    kitchenId,
  );
  if (!duty) throw new HttpError(404, "这项买菜安排已经不存在了。");
  await run(env, "DELETE FROM grocery_duties WHERE id = ?", groceryId);
  return json({ groceries: await getGroceries(env, kitchenId, duty.week_start) });
}

async function handleCreatePoll(request, env, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  await requireMembership(env, kitchenId, user.id);
  const body = await readJson(request);
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
  const open = await one(
    env,
    "SELECT COUNT(*) AS count FROM meal_polls WHERE kitchen_id = ? AND status = 'open'",
    kitchenId,
  );
  if (Number(open?.count || 0) >= 12) throw new HttpError(400, "进行中的投票太多了，先结束一些吧。");
  const id = newId("poll");
  const createdAt = nowISO();
  const statements = [
    env.DB.prepare(
      `INSERT INTO meal_polls (id, kitchen_id, title, note, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
    ).bind(id, kitchenId, title, note, user.id, createdAt, createdAt),
  ];
  options.forEach((label, index) => {
    statements.push(
      env.DB.prepare("INSERT INTO poll_options (id, poll_id, label, position) VALUES (?, ?, ?, ?)").bind(
        newId("opt"),
        id,
        label,
        index,
      ),
    );
  });
  await env.DB.batch(statements);
  return json({ polls: await getPolls(env, kitchenId, user.id), pollId: id }, 201);
}

async function handleVotePoll(request, env, user, kitchenId, pollId) {
  if (!user) throw new HttpError(401, "请先登录。");
  await requireMembership(env, kitchenId, user.id);
  const poll = await requirePoll(env, kitchenId, pollId);
  if (poll.status !== "open") throw new HttpError(400, "这个投票已经结束了。");
  const body = await readJson(request);
  const optionId = String(body.optionId || "");
  const option = await one(
    env,
    "SELECT id FROM poll_options WHERE id = ? AND poll_id = ?",
    optionId,
    pollId,
  );
  if (!option) throw new HttpError(400, "这个选项不存在。");
  await run(
    env,
    `INSERT INTO poll_votes (poll_id, option_id, user_id, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(poll_id, user_id)
     DO UPDATE SET option_id = excluded.option_id, created_at = excluded.created_at`,
    pollId,
    optionId,
    user.id,
    nowISO(),
  );
  await run(env, "UPDATE meal_polls SET updated_at = ? WHERE id = ?", nowISO(), pollId);
  return json({ polls: await getPolls(env, kitchenId, user.id) });
}

async function handleSetPollStatus(env, user, kitchenId, pollId, status) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = await requireMembership(env, kitchenId, user.id);
  const poll = await requirePoll(env, kitchenId, pollId);
  if (!canManagePoll(poll, kitchen, user.id)) {
    throw new HttpError(403, "只有发起人或厨房主人可以结束这个投票。");
  }
  await run(
    env,
    "UPDATE meal_polls SET status = ?, updated_at = ?, closed_at = ? WHERE id = ?",
    status,
    nowISO(),
    status === "closed" ? nowISO() : null,
    pollId,
  );
  return json({ polls: await getPolls(env, kitchenId, user.id) });
}

async function handleDeletePoll(env, user, kitchenId, pollId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = await requireMembership(env, kitchenId, user.id);
  const poll = await requirePoll(env, kitchenId, pollId);
  if (!canManagePoll(poll, kitchen, user.id)) {
    throw new HttpError(403, "只有发起人或厨房主人可以删除这个投票。");
  }
  await run(env, "DELETE FROM meal_polls WHERE id = ?", pollId);
  return json({ polls: await getPolls(env, kitchenId, user.id) });
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
  if (hasTarget && kitchen.role === "viewer") throw new HttpError(403, "你是访客，不能修改每日目标。");

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
   Kitchen message board
   ========================================================= */

function cleanMessageContent(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim();
}

async function handleGetMessages(env, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  await requireMembership(env, kitchenId, user.id);
  return json({ messages: await getMessages(env, kitchenId) });
}

async function handleCreateMessage(request, env, user, kitchenId) {
  if (!user) throw new HttpError(401, "请先登录。");
  await requireMembership(env, kitchenId, user.id);
  const body = await readJson(request);
  const content = cleanMessageContent(body.content);
  if (!content) throw new HttpError(400, "写点内容再张贴吧。");
  if (content.length > 500) throw new HttpError(400, "留言最多 500 个字。");

  const id = newId("msg");
  await run(
    env,
    "INSERT INTO messages (id, kitchen_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)",
    id,
    kitchenId,
    user.id,
    content,
    nowISO(),
  );
  return json({ messages: await getMessages(env, kitchenId) }, 201);
}

async function handleDeleteMessage(env, user, kitchenId, messageId) {
  if (!user) throw new HttpError(401, "请先登录。");
  const kitchen = await requireMembership(env, kitchenId, user.id);
  const message = await one(
    env,
    "SELECT id, user_id FROM messages WHERE id = ? AND kitchen_id = ?",
    messageId,
    kitchenId,
  );
  if (!message) throw new HttpError(404, "这条留言已经不存在了。");
  if (message.user_id !== user.id && kitchen.role !== "owner") {
    throw new HttpError(403, "只有留言作者或厨房主人可以删除这条留言。");
  }
  await run(env, "DELETE FROM messages WHERE id = ?", messageId);
  return json({ messages: await getMessages(env, kitchenId) });
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

async function getWellnessWeek(env, userId, weekStart) {
  const dates = weekDateKeys(weekStart);
  const sleepRows = await all(
    env,
    `SELECT date, bedtime, wake_time, updated_at FROM sleep_logs
     WHERE user_id = ? AND date >= ? AND date <= ?`,
    userId,
    dates[0],
    dates[6],
  );
  const exerciseRows = await all(
    env,
    `SELECT date, calories, updated_at FROM exercise_logs
     WHERE user_id = ? AND date >= ? AND date <= ?`,
    userId,
    dates[0],
    dates[6],
  );
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

async function handleGetWellness(env, user, url) {
  if (!user) throw new HttpError(401, "请先登录。");
  const weekStart = normalizeWeekStart(url.searchParams.get("weekStart"));
  return json(await getWellnessWeek(env, user.id, weekStart));
}

async function handleSaveSleep(request, env, user) {
  if (!user) throw new HttpError(401, "请先登录。");
  const body = await readJson(request);
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
  await run(
    env,
    `INSERT INTO sleep_logs (user_id, date, bedtime, wake_time, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, date) DO UPDATE SET
       bedtime = excluded.bedtime,
       wake_time = excluded.wake_time,
       updated_at = excluded.updated_at`,
    user.id,
    date,
    bedtime,
    wakeTime,
    now,
    now,
  );
  return json(await getWellnessWeek(env, user.id, weekStart));
}

async function handleSaveExercise(request, env, user) {
  if (!user) throw new HttpError(401, "请先登录。");
  const body = await readJson(request);
  const date = String(body.date || "");
  const calories = Number(body.calories);
  if (!parseDateKey(date)) throw new HttpError(400, "日期格式不正确。");
  if (!Number.isFinite(calories) || calories < 0 || calories > 5000) {
    throw new HttpError(400, "运动消耗需要在 0–5,000 kcal 之间。");
  }
  const weekStart = normalizeWeekStart(body.weekStart || dateKey(startOfWeek(parseDateKey(date))));
  if (!weekDateKeys(weekStart).includes(date)) throw new HttpError(400, "日期不在当前周内。");

  const now = nowISO();
  await run(
    env,
    `INSERT INTO exercise_logs (user_id, date, calories, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, date) DO UPDATE SET
       calories = excluded.calories,
       updated_at = excluded.updated_at`,
    user.id,
    date,
    Math.round(calories),
    now,
    now,
  );
  return json(await getWellnessWeek(env, user.id, weekStart));
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
    env.DB.prepare("DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM meal_polls WHERE kitchen_id = ?)").bind(kitchenId),
    env.DB.prepare("DELETE FROM poll_options WHERE poll_id IN (SELECT id FROM meal_polls WHERE kitchen_id = ?)").bind(kitchenId),
    env.DB.prepare("DELETE FROM meal_polls WHERE kitchen_id = ?").bind(kitchenId),
    env.DB.prepare("DELETE FROM grocery_duties WHERE kitchen_id = ?").bind(kitchenId),
    env.DB.prepare("DELETE FROM day_cook_slots WHERE kitchen_id = ?").bind(kitchenId),
    env.DB.prepare("DELETE FROM day_cooks WHERE kitchen_id = ?").bind(kitchenId),
    env.DB.prepare("DELETE FROM meal_favorites WHERE kitchen_id = ?").bind(kitchenId),
    env.DB.prepare("DELETE FROM week_templates WHERE kitchen_id = ?").bind(kitchenId),
    env.DB.prepare("DELETE FROM plan_items WHERE kitchen_id = ?").bind(kitchenId),
    env.DB.prepare("DELETE FROM ingredients WHERE kitchen_id = ?").bind(kitchenId),
    env.DB.prepare("DELETE FROM invites WHERE kitchen_id = ?").bind(kitchenId),
    env.DB.prepare("DELETE FROM messages WHERE kitchen_id = ?").bind(kitchenId),
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
      env.DB.prepare("DELETE FROM poll_votes WHERE user_id = ?").bind(target.id),
      env.DB.prepare("DELETE FROM invites WHERE created_by = ?").bind(target.id),
      env.DB.prepare("DELETE FROM memberships WHERE user_id = ?").bind(target.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(target.id),
      env.DB.prepare("DELETE FROM messages WHERE user_id = ?").bind(target.id),
      env.DB.prepare("DELETE FROM sleep_logs WHERE user_id = ?").bind(target.id),
      env.DB.prepare("DELETE FROM exercise_logs WHERE user_id = ?").bind(target.id),
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

  if (pathname === "/api/wellness" && method === "GET") {
    return handleGetWellness(env, user, url);
  }

  if (pathname === "/api/wellness/sleep" && method === "PUT") {
    return handleSaveSleep(request, env, user);
  }

  if (pathname === "/api/wellness/exercise" && method === "PUT") {
    return handleSaveExercise(request, env, user);
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

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/plan\/copy$/);
  if (match && method === "POST") {
    return handleCopyWeek(request, env, user, match[1]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/templates$/);
  if (match) {
    if (method === "GET") return handleGetTemplates(env, user, match[1]);
    if (method === "POST") return handleCreateTemplate(request, env, user, match[1]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/templates\/([A-Za-z0-9_]+)\/apply$/);
  if (match && method === "POST") {
    return handleApplyTemplate(request, env, user, match[1], match[2]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/templates\/([A-Za-z0-9_]+)$/);
  if (match && method === "DELETE") {
    return handleDeleteTemplate(env, user, match[1], match[2]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/favorites$/);
  if (match) {
    if (method === "GET") return handleGetFavorites(env, user, match[1]);
    if (method === "POST") return handleCreateFavorite(request, env, user, match[1]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/favorites\/([A-Za-z0-9_]+)\/apply$/);
  if (match && method === "POST") {
    return handleApplyFavorite(request, env, user, match[1], match[2]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/favorites\/([A-Za-z0-9_]+)$/);
  if (match && method === "DELETE") {
    return handleDeleteFavorite(env, user, match[1], match[2]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/cooks\/(\d{4}-\d{2}-\d{2})\/(morning|afternoon)$/);
  if (match) {
    if (method === "PUT") return handleSetCook(request, env, user, match[1], match[2], match[3]);
    if (method === "DELETE") return handleClearCook(env, user, match[1], match[2], match[3]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/cooks\/(\d{4}-\d{2}-\d{2})$/);
  if (match) {
    if (method === "PUT") return handleSetCook(request, env, user, match[1], match[2], "afternoon");
    if (method === "DELETE") return handleClearCook(env, user, match[1], match[2]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/groceries$/);
  if (match) {
    if (method === "GET") return handleGetGathering(env, user, match[1], url);
    if (method === "POST") return handleCreateGrocery(request, env, user, match[1]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/groceries\/([A-Za-z0-9_]+)$/);
  if (match) {
    if (method === "PATCH") return handleUpdateGrocery(request, env, user, match[1], match[2]);
    if (method === "DELETE") return handleDeleteGrocery(env, user, match[1], match[2]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/polls$/);
  if (match) {
    if (method === "GET") return handleGetGathering(env, user, match[1], url);
    if (method === "POST") return handleCreatePoll(request, env, user, match[1]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/polls\/([A-Za-z0-9_]+)\/vote$/);
  if (match && method === "POST") {
    return handleVotePoll(request, env, user, match[1], match[2]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/polls\/([A-Za-z0-9_]+)\/close$/);
  if (match && method === "POST") {
    return handleSetPollStatus(env, user, match[1], match[2], "closed");
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/polls\/([A-Za-z0-9_]+)\/reopen$/);
  if (match && method === "POST") {
    return handleSetPollStatus(env, user, match[1], match[2], "open");
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/polls\/([A-Za-z0-9_]+)$/);
  if (match && method === "DELETE") {
    return handleDeletePoll(env, user, match[1], match[2]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/table$/);
  if (match && method === "GET") {
    return handleGetGathering(env, user, match[1], url);
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

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/messages$/);
  if (match) {
    if (method === "GET") return handleGetMessages(env, user, match[1]);
    if (method === "POST") return handleCreateMessage(request, env, user, match[1]);
  }

  match = pathname.match(/^\/api\/kitchens\/([A-Za-z0-9_]+)\/messages\/([A-Za-z0-9_]+)$/);
  if (match && method === "DELETE") {
    return handleDeleteMessage(env, user, match[1], match[2]);
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
