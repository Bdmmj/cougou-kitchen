"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const username = (process.argv[2] || "").trim();
const dbFile = path.join(__dirname, "..", "data", "cougou.sqlite");

if (!username) {
  console.error("用法：npm run make-admin -- <用户名>");
  process.exit(1);
}

if (!fs.existsSync(dbFile)) {
  console.error("还没有数据库。请先运行 npm start，再注册账号，然后执行这个命令。");
  process.exit(1);
}

const db = new DatabaseSync(dbFile);
const columns = db.prepare("PRAGMA table_info(users)").all();
if (!columns.some((column) => column.name === "is_admin")) {
  db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
}

const user = db.prepare("SELECT id, username, display_name, is_admin FROM users WHERE username = ?").get(username);
if (!user) {
  console.error(`没有找到用户「${username}」。请确认用户名，或先在网站注册。`);
  const available = db.prepare("SELECT username FROM users ORDER BY created_at ASC LIMIT 12").all();
  if (available.length) {
    console.error(`现有用户：${available.map((row) => row.username).join("、")}`);
  }
  db.close();
  process.exit(1);
}

if (user.is_admin) {
  console.log(`「${user.display_name}」(@${user.username}) 已经是管理员了。`);
} else {
  db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(user.id);
  console.log(`已授权「${user.display_name}」(@${user.username}) 为管理员。`);
  console.log("现在可以打开 http://127.0.0.1:4174/admin 登录后台。");
}

db.close();
