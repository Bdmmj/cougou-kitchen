# 部署指南（Northflank Sandbox 免费计划）

这是一个长期运行的 Node.js + SQLite 服务，不是纯静态站。部署时必须同时满足：

1. 有常驻的 Node.js 容器；
2. 把持久卷挂载到 `/app/data`，否则 SQLite 数据会在重新部署时丢失。

当前已准备好：

- `Dockerfile`
- `.dockerignore`
- `railway.json`（Railway 备用）
- 本地 Git 仓库与首次提交
- 管理后台、登录、邀请与昵称/密码功能

## 为什么选 Northflank

Northflank 的 **Sandbox** 免费额度包含 2 个服务、2 个 Job、1 个数据库和每月最多 $20 的云资源，服务可以常驻不休眠；持久卷按用量从免费额度里扣。对于这个小型 SQLite 应用，成本很低。

需要你准备：

1. 一个 Northflank 账号（无需信用卡即可注册）；
2. 一个公开的 Git 仓库（GitHub / GitLab 均可），因为 Northflank 从 Git 仓库构建 Dockerfile。

## 第一步：把代码推到公开 Git 仓库

本地已经是提交好的 Git 仓库。请在你的 GitHub 或 GitLab 上新建一个空仓库，然后执行：

```bash
cd "/Users/kyyd/Desktop/凑狗厨房"
git remote add origin <你的仓库地址>
git push -u origin main
```

`data/`、`.cloudflared/`、`.DS_Store` 已加入 `.gitignore`，不会被上传。

## 第二步：在 Northflank 创建服务

1. 登录 <https://app.northflank.com>；
2. 创建 Project；
3. 创建 **Combined service**；
4. Repository 选择刚推送的公开仓库，分支 `main`；
5. Build type 选择 **Dockerfile**；
6. Dockerfile 路径填 `Dockerfile`，Build context 填 `.`；
7. 创建服务。

## 第三步：添加持久卷

在服务的 **Volumes** 设置中新增一个卷，挂载路径必须是：

```text
/app/data
```

没有这个卷，SQLite 会在重新部署或容器重建时被清空。

## 第四步：配置环境变量和端口

在服务的 **Environment / Variables** 中添加：

```text
HOST=0.0.0.0
ADMIN_USERNAME=你的用户名
```

> `ADMIN_USERNAME` 是首个管理员引导。用这个用户名注册后，账号会自动成为管理员；如果账号已经存在，服务重启后也会被提升。

在 **Networking → Ports** 中添加：

```text
端口：4174
协议：HTTP
公开：开启
```

`PORT` 通常由 Northflank 自动注入；本项目的 `server.js` 会优先使用平台注入的 `PORT`，没有时回退到 `4174`。

## 第五步：生成公网域名并验证

在 **Networking → Public URL** 生成域名，然后打开：

```text
https://你的域名/api/health
```

应该返回：

```json
{"ok":true}
```

注册账号后访问：

```text
https://你的域名/admin
```

如果该账号的用户名等于 `ADMIN_USERNAME`，它已经是管理员，可以直接登录后台。

## 用 Northflank CLI 自动部署（可选）

如果不想手动点控制台，可以创建 Northflank API Token，然后让 CLI 操作：

1. Northflank → **Account Settings → API → Tokens → Create API token**；
2. 安装 CLI：

```bash
npm install -g @northflank/cli
northflank login
```

3. 按 Northflank 文档创建 project、combined service、volume 和 public port。

如果你希望我通过 CLI 继续代部署，请先把 token 保存到项目目录的 `.northflank-token`（已加入 `.gitignore`），不要把 token 直接发到聊天里。然后我可以读取它继续。

## Railway 备用方案

项目保留了 `railway.json` 和 Dockerfile。Railway 免费计划同样支持持久卷，在控制台把卷挂载到 `/app/data` 即可。操作步骤与 Northflank 类似：连接 Git 仓库 → Dockerfile 构建 → 加卷 → 设置 `ADMIN_USERNAME` → 生成域名。

## 不推荐

- **Render 免费 Web Service**：免费实例不能挂载持久磁盘，SQLite 会重置。
- **Vercel / Netlify Functions**：不适合长期运行的 Node 服务、SQLite 和 SSE。
- **Fly.io**：没有真正的无卡永久免费层。

## 常用环境变量

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` | 监听端口，平台通常自动注入 | `4174` |
| `HOST` | 监听地址 | `127.0.0.1`；Dockerfile 内为 `0.0.0.0` |
| `ADMIN_USERNAME` | 指定用户注册/启动时自动成为管理员 | 空 |

## 数据备份

本地：

```bash
sqlite3 data/cougou.sqlite ".backup 'data/cougou-backup.sqlite'"
```

托管环境建议定期使用 Northflank 的 Volume 快照/备份能力。
