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
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS kitchens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  daily_target INTEGER NOT NULL DEFAULT 1800,
  revision INTEGER NOT NULL DEFAULT 1,
  is_sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  kitchen_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (kitchen_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships (user_id);

CREATE TABLE IF NOT EXISTS ingredients (
  id TEXT PRIMARY KEY,
  kitchen_id TEXT NOT NULL,
  name TEXT NOT NULL,
  calories INTEGER NOT NULL,
  unit TEXT NOT NULL DEFAULT '1 份',
  category TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ingredients_kitchen ON ingredients (kitchen_id, category);

CREATE TABLE IF NOT EXISTS plan_items (
  id TEXT PRIMARY KEY,
  kitchen_id TEXT NOT NULL,
  date TEXT NOT NULL,
  meal TEXT NOT NULL,
  name TEXT NOT NULL,
  calories INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_kitchen_date ON plan_items (kitchen_id, date, meal, position);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  kitchen_id TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  created_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_kitchen ON invites (kitchen_id, revoked, expires_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  kitchen_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_kitchen_created ON messages (kitchen_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sleep_logs (
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  bedtime TEXT NOT NULL,
  wake_time TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, date)
);

CREATE TABLE IF NOT EXISTS exercise_logs (
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  calories INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, date)
);

CREATE TABLE IF NOT EXISTS week_templates (
  id TEXT PRIMARY KEY,
  kitchen_id TEXT NOT NULL,
  name TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_week_templates_kitchen ON week_templates (kitchen_id, created_at DESC);

CREATE TABLE IF NOT EXISTS meal_favorites (
  id TEXT PRIMARY KEY,
  kitchen_id TEXT NOT NULL,
  name TEXT NOT NULL,
  meal TEXT NOT NULL,
  items TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meal_favorites_kitchen ON meal_favorites (kitchen_id, created_at DESC);

CREATE TABLE IF NOT EXISTS day_cooks (
  kitchen_id TEXT NOT NULL,
  date TEXT NOT NULL,
  user_id TEXT,
  assigned_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kitchen_id, date)
);

CREATE TABLE IF NOT EXISTS meal_polls (
  id TEXT PRIMARY KEY,
  kitchen_id TEXT NOT NULL,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_meal_polls_kitchen ON meal_polls (kitchen_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS poll_options (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL,
  label TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options (poll_id, position);

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (poll_id, user_id)
);

CREATE TABLE IF NOT EXISTS grocery_duties (
  id TEXT PRIMARY KEY,
  kitchen_id TEXT NOT NULL,
  week_start TEXT NOT NULL,
  day_index INTEGER,
  user_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grocery_duties_kitchen_week ON grocery_duties (kitchen_id, week_start, day_index);

-- Cook roster split into morning/afternoon slots.
-- The old day_cooks table is kept for migration compatibility and can be ignored.
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS day_cook_slots (
  kitchen_id TEXT NOT NULL,
  date TEXT NOT NULL,
  slot TEXT NOT NULL,
  user_id TEXT,
  assigned_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kitchen_id, date, slot)
);
CREATE INDEX IF NOT EXISTS idx_day_cook_slots_kitchen_date ON day_cook_slots (kitchen_id, date);

INSERT OR IGNORE INTO day_cook_slots (kitchen_id, date, slot, user_id, assigned_by, updated_at)
SELECT kitchen_id, date, 'morning', user_id, assigned_by, updated_at
FROM day_cooks
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'day_cooks_split_v1');

INSERT OR IGNORE INTO day_cook_slots (kitchen_id, date, slot, user_id, assigned_by, updated_at)
SELECT kitchen_id, date, 'afternoon', user_id, assigned_by, updated_at
FROM day_cooks
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = 'day_cooks_split_v1');

INSERT OR IGNORE INTO schema_migrations (id) VALUES ('day_cooks_split_v1');
