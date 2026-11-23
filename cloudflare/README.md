# 凑狗厨房 · Cloudflare Pages + D1

线上地址：

- https://cougou-kitchen.pages.dev
- 管理后台：https://cougou-kitchen.pages.dev/admin

## 结构

```text
cloudflare/
├── functions/api/[[path]].js   # Pages Functions API
├── schema.sql                  # D1 表结构
├── build.mjs                   # 生成 public/ 静态产物
├── public/                     # 构建产物，不提交
└── wrangler.toml               # Pages / D1 绑定
```

- Pages 项目：`cougou-kitchen`
- D1 数据库：`cougou-kitchen`（`54d6a6de-d2ff-4cce-97b1-559c8a59d51b`）
- 环境变量：`ADMIN_USERNAME=kyyd`
- 线上同步：每 10 秒轮询（Cloudflare Pages 不提供常驻 SSE）

## 本地验证

```bash
cd cloudflare
node build.mjs
npx wrangler pages dev public --d1 DB --persist-to .wrangler/state
```

首次需要把 `schema.sql` 应用到本地 D1：

```bash
npx wrangler d1 execute cougou-kitchen --local --persist-to .wrangler/state --file=schema.sql
```

## 更新线上

```bash
cd cloudflare
node build.mjs
npx wrangler pages deploy public --project-name cougou-kitchen --branch main
```

如果修改了表结构：

```bash
npx wrangler d1 execute cougou-kitchen --remote --file=schema.sql
```

## 说明

- 线上数据库是独立的 D1，本地 `data/cougou.sqlite` 不会自动同步。
- 密码使用 PBKDF2-SHA256（100,000 次迭代）；Cloudflare Workers 的 PBKDF2 上限为 100,000 次。
- 管理员通过 `ADMIN_USERNAME` 在注册时自动授权；已有账号可用 D1 SQL 更新 `users.is_admin`。
