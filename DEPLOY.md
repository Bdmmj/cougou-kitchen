# 部署指南

这是一个 Node.js + SQLite 的单进程应用。部署时必须满足两件事：

1. 能运行长期在线的 Node.js 进程；
2. `/app/data` 有一个**持久化磁盘**，否则 SQLite 数据会在重启后丢失。

## 推荐：Railway（免费计划 + 持久卷）

Railway 的免费计划支持 Node/Docker 服务，并允许给服务挂载一个持久卷。这个项目已经包含 `Dockerfile` 和 `railway.json`。

### 1. 创建账号

打开 <https://railway.com> 注册并登录。免费计划有月度用量上限，超出后会暂停服务，但卷上的数据会保留。

### 2. 安装并登录 CLI

```bash
npm install -g @railway/cli
railway login
```

`railway login` 会打开浏览器，需要你本人在浏览器里完成登录授权。

### 3. 部署项目

在项目目录执行：

```bash
cd "/Users/kyyd/Desktop/凑狗厨房"
railway init
railway up
```

### 4. 添加持久卷

在 Railway 控制台：

1. 打开刚创建的服务；
2. **Settings → Volumes**；
3. 新建一个 Volume，挂载路径填写：

```text
/app/data
```

这一步非常重要。没有持久卷，SQLite 数据会在重新部署时被清空。

### 5. 配置管理员

在服务的 **Variables** 中添加：

```text
ADMIN_USERNAME=你的用户名
```

然后部署。第一次用这个用户名注册时，账号会自动获得管理员权限。也可以部署完成后访问网站注册任意账号，再通过 Railway 的命令环境执行：

```bash
npm run make-admin -- 用户名
```

对于没有终端入口的托管环境，建议直接使用 `ADMIN_USERNAME`。

### 6. 生成公网域名

在服务 **Settings → Networking → Public Networking** 中点击生成域名。

打开域名后：

- 正常注册 / 登录；
- 访问 `/admin` 登录管理后台；
- 邀请链接会基于当前公网域名自动生成。

### 7. 验证

```text
https://你的域名/api/health
```

应返回：

```json
{"ok":true}
```

## 备选平台

### Northflank Sandbox

Northflank 的 Sandbox 免费额度更充足，也支持常驻服务和持久卷，但配置步骤比 Railway 多。服务需要监听 `0.0.0.0` 和平台注入的 `PORT`，本项目已经支持。

### 不推荐：Render 免费 Web Service

Render 的免费 Web Service **不能挂载持久磁盘**。SQLite 会随容器重启/休眠而丢失，除非额外接入 Turso 等外部数据库。

### 不推荐：Vercel / Netlify Functions

这是长期运行的 Node HTTP 服务，使用 SQLite 和 SSE 实时同步，不适合改成纯 Serverless Function。

## 临时公网预览

如果只是想马上让朋友打开看一眼，可以用 Cloudflare Quick Tunnel（无需账号），但：

- 地址是随机生成且临时的；
- 你的 Mac 必须保持开机、服务和隧道都保持运行；
- 隧道重启后地址会变化；
- 不适合作为长期正式部署。

正式分享建议使用 Railway 持久卷方案。

## 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PORT` | 监听端口，平台通常会自动注入 | `4174` |
| `HOST` | 监听地址 | `127.0.0.1`，Docker 镜像内为 `0.0.0.0` |
| `ADMIN_USERNAME` | 该用户名注册/启动时自动成为管理员 | 空 |

## 数据备份

本地开发时：

```bash
sqlite3 data/cougou.sqlite ".backup 'data/cougou-backup.sqlite'"
```

托管环境优先使用平台的 Volume 快照/备份功能。备份前最好停止写入，或使用 SQLite 的 `.backup` 命令获取一致性快照。
