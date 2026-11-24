# FishJoy 第二阶段：账号与云端存档部署

## 当前实现

- 游戏昵称 + 密码注册、登录、退出和会话验证
- D1 保存账号、密码哈希、会话和云端游戏存档
- 注册时把当前游客存档一起迁移到新账号
- 登录后读取云端存档；账号尚无云端存档时保留当前本地进度
- 会话使用 HttpOnly + Secure + SameSite=Lax Cookie
- 密码使用 PBKDF2-HMAC-SHA256 派生哈希，不保存明文密码

## Cloudflare Pages 配置

1. 在 Cloudflare Dashboard 创建 D1 数据库，建议名称 `fishjoy-account-db`。
2. 打开 D1 数据库的 Console，执行 `migrations/0001_accounts.sql` 全部 SQL。
3. 打开游戏对应的 Cloudflare Pages 项目：Settings → Functions → D1 database bindings。
4. 添加绑定：Variable name 填 `DB`，Database 选择刚创建的数据库。
5. 保存设置并重新部署 Pages 项目。Pages Functions 会自动部署 `functions/api/[[path]].js`。

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
