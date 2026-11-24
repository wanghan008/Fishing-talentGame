# FishJoy 第二阶段：账号与云端存档部署

## 当前实现

- 游戏昵称 + 密码注册、登录、退出和会话验证
- D1 保存账号、密码哈希、会话和云端游戏存档
- 注册时把当前游客存档一起迁移到新账号
- 登录后读取云端存档；账号尚无云端存档时保留当前本地进度
- 会话使用 HttpOnly + Secure + SameSite=Lax Cookie
- 密码使用 PBKDF2-HMAC-SHA256 派生哈希，不保存明文密码

## Cloudflare Workers 配置

仓库已配置普通 Workers 入口和 Workers Static Assets：

- `worker.js`：把 `/api/*` 请求转发给现有账号 API，其余请求交给静态资源。
- `wrangler.jsonc`：声明 Worker 入口、静态资源目录和 `ASSETS` 绑定。
- `.assetsignore`：避免把后端代码、迁移 SQL 和项目说明作为公开静态资源上传。

操作步骤：

1. 在 Cloudflare Dashboard 打开 Workers & Pages → `fishing-talentgame`。
2. 等待 GitHub 最新提交自动构建部署成功；如果没有自动触发，在 Deployments 中重新部署最新提交。
3. 打开 Settings → Bindings → Add，选择 D1 database。
4. Variable name 必须填写 `DB`。
5. Database 选择已执行 `migrations/0001_accounts.sql` 的 D1 数据库。
6. 保存后重新部署 Worker，使绑定在新版本中生效。

注意：D1 数据库必须先执行 `migrations/0001_accounts.sql` 创建 `users`、`player_saves`、`sessions` 三张表。仅绑定数据库不会自动创建表。

## 验证

- 打开游戏，点击“账号/云存档”，注册一个昵称和密码。
- 注册成功后应显示已登录，并把游客金币、炮台、图鉴等存档迁移到 D1。
- 换浏览器/设备登录相同账号，检查金币和进度是否恢复。
- 退出后应回到游客状态；原设备游客存档不会被删除。

## 注意

- 昵称规则：3-20 位汉字、字母、数字、下划线或短横线；密码 8-72 位。
- 请使用 HTTPS 域名部署，Secure Cookie 需要 HTTPS。
- 此版本实现账号隔离和云端存档，但游戏经济仍由浏览器端运行。恶意用户可以修改自己客户端的金币后上传；如果以后需要可信排行榜、交易或付费系统，应把金币增减和奖励结算迁移到服务器端。
- 这是第一版账号系统，不包含密码找回（无邮箱）、昵称修改和账号注销。
