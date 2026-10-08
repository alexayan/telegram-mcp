# 使用 cf CLI 部署 Telegram MCP

本文面向首次把源码部署到**自己的 Cloudflare 账号**的用户。核对日期：2026-09-29；适用项目锁文件中的 `cf 1.0.0-beta.5`、Node.js 24 和现有部署脚本。

全部命令从项目根目录执行。Shell 示例适用于 macOS / Linux 的 Bash 或 Zsh；Windows 可使用 WSL。先完成首次配置，之后更新只需 `npm ci` 和 `npm run deploy`。

当前已有资源创建命令、图片桶初始化脚本和发布脚本；尚未提供全自动交互式初始化向导。本文中的账号 ID、资源 ID 和域名均由部署者填写。

## 1. 部署前准备

- 安装 Node.js 24+ 和 npm，并取得包含 `package-lock.json` 的完整源码。
- 准备自己的 Cloudflare 账号，以及在该账号创建 Workers、SQLite Durable Objects、D1、KV、R2 和 Cron 的权限。
- 在**目标账号**开通 R2：Cloudflare 控制台 → Storage & databases → R2 → Overview，完成订阅开通流程。创建桶的 CLI 命令不能替代首次开通。[官方说明](https://developers.cloudflare.com/r2/get-started/)
- 在目标账号的 Workers 设置中确认或注册自己的 `workers.dev` 子域名。若子域名是 `your-subdomain`，默认公开服务地址就是 `https://telegram-mcp.your-subdomain.workers.dev`。[域名说明](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)

部署会使用以下资源。D1、KV 在后续步骤手动创建；R2 由 `setup:images` 创建；Worker、Durable Object 和 Cron 由发布流程配置。

| 资源                  | 默认名称              | 用途                                  |
| --------------------- | --------------------- | ------------------------------------- |
| 公开 Worker           | `telegram-mcp`        | OAuth 页面、管理页面和 MCP            |
| 私有 Worker           | `telegram-mcp-sync`   | Telegram 消息采集、图片下载           |
| D1                    | `telegram-mcp`        | 会话、消息和图片索引                  |
| KV                    | `telegram-mcp-oauth`  | OAuth 授权与令牌数据                  |
| R2                    | `telegram-mcp-images` | 私有图片和普通附件                    |
| SQLite Durable Object | `BotCollector`        | 每个 bot 的凭证、消息游标与待处理更新 |
| Cron                  | `*/5 * * * *`         | 唤醒遗漏的采集任务及清理过期数据      |

Worker 名称目前固定。若账号中已有同名服务，先确认它是否属于本项目；不要直接覆盖其他服务。同一账号部署多个独立实例需要统一修改 Worker 名称、内部绑定及脚本中的名称，单改 R2 桶名不够。

## 2. 安装依赖并登录目标账号

```bash
npm ci
npx --no-install cf --version
```

使用项目锁定的 CLI，不需要额外全局安装 Wrangler 或 cf。`npm run ...` 会自动使用项目内的 cf。

先查看本机已有的登录配置：

```bash
npx --no-install cf auth list
```

如果尚无合适的 profile，创建一个命名 profile，例如 `telegram-mcp`，按 CLI 提示在浏览器完成 Cloudflare 授权：

```bash
npx --no-install cf auth create telegram-mcp
```

如果已有对应 profile，跳过创建。随后把它绑定到当前项目目录，并查看该登录可访问的账号：

```bash
npx --no-install cf auth activate telegram-mcp
npx --no-install cf accounts list --per-page 50
```

将返回的目标账号 `id` 填入下面的变量。一个登录可以访问多个账号，因此需要显式选择部署目标：

```bash
export CLOUDFLARE_ACCOUNT_ID='<目标 Cloudflare Account ID>'
```

注意：profile 代表登录凭证，`CLOUDFLARE_ACCOUNT_ID` 代表本次操作的资源归属，两者必须匹配。profile 绑定保存在本机 cf 配置中，不会随源码复制；换电脑或 CI 环境后需重新配置凭证。已有 `CLOUDFLARE_API_TOKEN` 环境变量时，应先确认其归属；本指南使用 OAuth profile，不混用另一份 API Token。

## 3. 创建 D1 和 OAuth KV

以下命令仅用于首次创建。已有本项目资源时，使用其现有 ID，跳过重复创建。

```bash
npx --no-install cf d1 create --name telegram-mcp --read-replication-mode disabled
npx --no-install cf kv namespaces create --title telegram-mcp-oauth
```

分别记录 D1 返回的 `uuid` 和 KV 返回的 `id`，填入变量。不要把资源名称误填为 ID：

```bash
export D1_DATABASE_ID='<D1 uuid>'
export OAUTH_KV_ID='<KV namespace id>'
export PUBLIC_ORIGIN='https://telegram-mcp.<你的 workers.dev 子域名>.workers.dev'
export R2_BUCKET_NAME='telegram-mcp-images'
```

`PUBLIC_ORIGIN` 必须是正式 HTTPS origin：不带结尾 `/`、`/mcp`、查询参数或片段。它决定 OAuth issuer、resource audience 和页面来源校验。改用自定义域名时，需要先配置公开 Worker 的域名绑定，再使用该域名作为唯一的 `PUBLIC_ORIGIN` 并重新部署；访问另一个主机名会返回 `421 Invalid host`。

## 4. 生成独立生产密钥并保存配置

以下代码只在**新部署**时运行。它检查上一步的变量，生成独立的 32 字节随机密钥，写入权限为 `0600` 的文件，并拒绝覆盖已有配置或密钥。密钥值不会打印到终端。

```bash
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const required = ['CLOUDFLARE_ACCOUNT_ID', 'D1_DATABASE_ID', 'OAUTH_KV_ID', 'PUBLIC_ORIGIN'];
for (const name of required) {
  if (!process.env[name] || /[<>\r\n]/.test(process.env[name])) {
    throw new Error(`请先填写有效的 ${name}`);
  }
}
for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'OAUTH_KV_ID']) {
  if (!/^[a-f0-9]{32}$/i.test(process.env[name])) throw new Error(`${name} 应为 32 位十六进制 ID`);
}
if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(process.env.D1_DATABASE_ID)) {
  throw new Error('D1_DATABASE_ID 应为数据库 UUID');
}
const origin = new URL(process.env.PUBLIC_ORIGIN);
if (origin.protocol !== 'https:' || origin.origin !== process.env.PUBLIC_ORIGIN) {
  throw new Error('PUBLIC_ORIGIN 必须是没有结尾斜杠的 HTTPS origin');
}
const dir = resolve('.cloudflare/production');
const envPath = resolve(dir, 'deployment.env');
const secretPath = resolve(dir, 'sync-secrets.json');
if (existsSync(envPath) || existsSync(secretPath)) {
  throw new Error('生产配置或密钥已存在，请保留并使用已有文件，不要重新生成');
}
mkdirSync(dir, { recursive: true, mode: 0o700 });
const keyRing = { v1: randomBytes(32).toString('base64url') };
writeFileSync(secretPath, JSON.stringify({ BOT_KEYS: JSON.stringify(keyRing) }, null, 2) + '\n', {
  mode: 0o600, flag: 'wx',
});
const values = Object.fromEntries(required.map(name => [name, process.env[name]]));
values.R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'telegram-mcp-images';
values.ACTIVE_KEY_ID = 'v1';
values.SYNC_SECRETS_FILE = secretPath;
writeFileSync(envPath, Object.entries(values).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n') + '\n', {
  mode: 0o600, flag: 'wx',
});
console.log('已保存生产配置和独立密钥；密钥未打印。');
JS
```

生成的文件均位于项目已忽略的 `.cloudflare/` 目录中：

| 文件 / 字段                                | 作用                                                |
| ------------------------------------------ | --------------------------------------------------- |
| `.cloudflare/production/deployment.env`    | 后续部署自动读取的账号、资源 ID、域名和密钥文件路径 |
| `.cloudflare/production/sync-secrets.json` | 私有同步 Worker 使用的 `BOT_KEYS` key ring          |
| `SYNC_SECRETS_FILE`                        | 密钥文件的绝对路径；移动项目后应更新此项            |
| `ACTIVE_KEY_ID`                            | 当前写入所用密钥版本，初始为 `v1`                   |

`BOT_KEYS` 用于加密 Bot Token、待处理更新和待下载图片与附件的文件 ID，**不是 Telegram Bot Token**。Bot Token 在部署完成后的网页授权流程输入，无需写入部署配置。

`npm run deploy` 和 `npm run setup:images` 会自动读取 `deployment.env`。单独执行 `npx cf ...` 不会运行这两个脚本，因此本指南的 CLI 命令依赖当前 Shell 中已设置的 `CLOUDFLARE_ACCOUNT_ID`。另开终端做资源操作时，先重新设置正确的账号 ID。

Shell 中已经存在的同名变量优先于文件内容。切换账号时应同时核对 profile、Shell 变量和 `deployment.env`，避免旧环境变量覆盖新配置。

请把生产配置和密钥备份到自己的安全存储。升级时沿用原密钥；只保存源码无法恢复被原密钥加密的凭证。移动项目时也不要遗失 `.cloudflare/production/`。

若希望源码目录中不保留生产账号和密钥，可以将 `deployment.env` 与 `sync-secrets.json` 保存在项目外，并把 `SYNC_SECRETS_FILE` 改为该密钥文件的绝对路径。在项目根目录执行以下命令（先替换示例路径）：

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
node --env-file=/absolute/private/deployment.env scripts/setup-images.mjs
node --env-file=/absolute/private/deployment.env scripts/deploy.mjs
```

使用这种方式时，后续更新也通过 `--env-file` 加载外部配置；普通 `npm run deploy` 不会自动寻找项目外的配置。首次升级附件功能时，已有桶也需要运行一次 `setup:images` 以补充附件生命周期规则。

## 5. 初始化私有图片桶并发布

```bash
npm run setup:images
npm run deploy
```

`setup:images` 会查找或创建 `R2_BUCKET_NAME` 指定的桶，确认 r2.dev 和自定义域名的公开访问均关闭，并设置 `images/` 和 `documents/` 前缀 90 天过期规则。桶应为本项目专用；脚本会保留其他生命周期规则。

`deploy` 会验证生产配置、密钥文件和图片桶私有状态，然后按以下顺序执行：

1. `cf build`。
2. `cf d1 migrations apply <数据库 ID> --dir migrations`，仅应用尚未执行的迁移。
3. 发布 `telegram-mcp-sync`，只给该 Worker 上传 `BOT_KEYS`。
4. 发布 `telegram-mcp`，配置其内部服务绑定。

当前迁移包括 `0001_initial.sql`、`0002_all_bot_chats.sql`、`0003_images.sql`、`0004_documents.sql`、`0005_retention_90_days.sql` 和 `0006_channel_management.sql`。最后一项添加网页退出频道的一次性确认和状态字段，保留已有聊天数据。无需先执行本地迁移，也无需单独手动创建 Durable Object namespace 或 Cron。

成功后，CLI 输出公开 Worker URL。确认该 URL 与 `PUBLIC_ORIGIN` 一致。MCP 地址为：

```text
https://telegram-mcp.<你的 workers.dev 子域名>.workers.dev/mcp
```

## 6. 验证部署

仍在首次部署的同一个 Shell 中时，可以直接使用 `PUBLIC_ORIGIN`；另开终端时先设置它。

```bash
curl -i "$PUBLIC_ORIGIN/health"
curl -i "$PUBLIC_ORIGIN/.well-known/oauth-authorization-server"
curl -i "$PUBLIC_ORIGIN/.well-known/oauth-protected-resource/mcp"
curl -i "$PUBLIC_ORIGIN/mcp"
```

预期结果：

| 请求                                | 预期                                                    |
| ----------------------------------- | ------------------------------------------------------- |
| `/health`                           | HTTP 200，正文包含 `{"ok":true}`                        |
| OAuth authorization server metadata | HTTP 200，`issuer` 和授权、令牌端点使用自己的正式域名   |
| Protected resource metadata         | HTTP 200，`resource` 为自己的 `PUBLIC_ORIGIN` 加 `/mcp` |
| 未携带凭证的 `/mcp`                 | HTTP 401，包含 `WWW-Authenticate` 鉴权提示              |

`/health` 只证明 HTTP 服务可用，不能代替真实 Bot 采集与 MCP 查询验证。

检查部署隔离，只列出 secret 名称，不读取密钥值：

```bash
npx --no-install cf workers secrets list --worker telegram-mcp
npx --no-install cf workers secrets list --worker telegram-mcp-sync
npx --no-install cf workers get telegram-mcp-sync
```

公开 Worker 的 secrets 应为空，私有 Worker 应只有 `BOT_KEYS`；私有 Worker 的 `subdomain.enabled` 和 `subdomain.previews_enabled` 应均为 `false`。不要为了排障把私有同步 Worker 或图片桶改为公开。

## 7. 接入 Telegram 与 MCP 客户端

1. 在 BotFather 创建自己的专用 bot。群聊接入需要 bot 确实已加入群，并正确设置 Group Privacy Mode；只读取群消息不必授予管理权限。
2. 确认没有其他程序对同一个 bot 调用 `getUpdates`，且没有已配置的 webhook。当前服务不会自动删除别人的 webhook。
3. 在支持 OAuth 的 MCP 客户端添加上面的 `/mcp` 地址，从客户端发起连接，在本服务授权页面输入 Bot Token。
4. 验证成功后直接返回客户端，不需要选择会话，也不必等待消息出现才能授权。普通 bot 不要求开启 Business 模式。
5. 在 bot 有权接收消息的聊天中发送新文字、图片和普通附件，依次检查以下工具。

| 工具              | 检查内容                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `get_sync_status` | `last_sync` 持续更新，`error_code` 为空                                                  |
| `list_chats`      | 已接收到消息的会话出现，取得 `source_key` 和 `chat_id`                                   |
| `get_messages`    | 查询指定会话的新消息；图片出现 `image_id` 和状态，附件出现 `file_id`、`file_name` 和状态 |
| `search_messages` | 使用消息中的词进行搜索                                                                   |
| `get_image`       | 图片状态为 `ready` 后，使用 `image_id` 读取图片                                          |
| `get_file`        | 附件状态为 `ready` 后，使用 `file_id` 读取文件名及原始文件字节                           |

管理入口为 `PUBLIC_ORIGIN` 加 `/manage`，支持撤销授权、暂停、恢复和删除数据。暂停或撤销后，旧 MCP 授权立即失效；恢复同步后客户端需要重新授权。

Bot 只能接收 Telegram 实际投递给它的消息，不会因为部署服务而取得用户所有群的权限，也不能补拉完整历史。当前保留期是 90 天。图片和普通附件的单文件上限均为 20,000,000 字节；旧版本未记录可下载文件 ID 的媒体不能补存。

## 8. 更新与备份

升级到 90 天保留期时，先运行 `npm run setup:images` 替换旧 R2 过期规则，再运行 `npm run deploy`。数据库升级会把仍有效的现有图片和附件延长至原消息时间加 90 天；已过期或删除的数据不会恢复。外部配置用户使用第 4 节对应命令。

首次从仅支持图片的版本升级时，先运行 `npm run setup:images`，为现有私有桶补充 `documents/` 的 90 天生命周期规则；外部配置用户使用第 4 节对应命令。`deploy` 会自动应用新增的附件表结构。

同一账号更新：保留生产配置与密钥，更新源码后从项目根目录执行：

```bash
npm ci
npm run deploy
```

修改业务代码后，可在发布前运行 `npm run check` 完成类型检查、workerd 测试与构建。`npm run build` 或 `npm run check` 单独运行时不会自动读取生产配置；正式发布使用 `npm run deploy`，它会在加载生产配置后重新构建。

换电脑部署时，需要恢复密钥文件、更新 `SYNC_SECRETS_FILE`、重新登录并绑定 profile。不要重新生成密钥代替旧密钥。

备份范围包括 D1 数据、R2 图片与附件、生产配置和 key ring。仅 D1 导出不包含图片或附件原文件、OAuth KV 或 Durable Object 内的凭证/进度，也不能把数据库导入当作完整恢复。回退 Worker 代码不会自动回退数据库 schema，应先确认版本与迁移兼容。

## 9. 常见问题

| 现象                                                      | 排查方式                                                                                           |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `10042 Please enable R2 through the Cloudflare Dashboard` | 检查 CLI 实际选择的账号，并在该账号完成 R2 开通；开通另一个账号无效                                |
| 找不到目标账号或资源、出现权限错误                        | 核对 profile、`CLOUDFLARE_ACCOUNT_ID` 和资源归属；必要时为对应 profile 重新授权                    |
| `Set production D1_DATABASE_ID and OAUTH_KV_ID`           | 生产配置缺失或仍是占位值；填写实际 ID，不能使用本地测试 ID                                         |
| `PUBLIC_ORIGIN must be an HTTPS origin…`                  | 使用完整 HTTPS origin，去掉末尾 `/`、`/mcp` 和其他路径                                             |
| `421 Invalid host`、OAuth 来源或回调失败                  | 检查访问域名和 `PUBLIC_ORIGIN`；改配置后重新部署，再从客户端重新发起 OAuth，不复用已过期的授权页面 |
| `Images require a private R2 bucket…`                     | 检查指定桶的 r2.dev 和自定义域名公开访问是否关闭                                                   |
| `SYNC_SECRETS_FILE` 找不到或 key ring 无效                | 检查绝对路径；`BOT_KEYS` 必须是 JSON 字符串，包含 `ACTIVE_KEY_ID` 对应的 32 字节 base64url 密钥    |
| 授权提示 `webhook_conflict`                               | 先处理原有 webhook 服务；本项目不自动抢占消息接收方式                                              |
| 同步错误 `telegram_409`                                   | 通常有其他 poller 或 webhook 冲突；停止冲突服务后，在管理页恢复同步并重新授权                      |
| 同步错误 `telegram_401`                                   | Bot Token 已失效；使用当前有效 Token 在授权或管理页面重新登记                                      |
| 群聊普通消息收不到                                        | 确认 bot 实际仍是群成员，并检查隐私模式；调整隐私设置后按 Telegram 要求重新加入群，再发送新消息    |
| 没有旧消息或旧图片                                        | 当前 Bot API 采集没有历史回补；使用新消息验证，图片需等待 `ready`                                  |
| Docker / OrbStack 提示，但 build 成功                     | 该版本 cf 可能探测 Docker；本项目不使用 Containers，以命令退出状态和实际构建、发布结果为准         |

排查时保留安全错误代码，不要输出 Bot Token、密钥、OAuth access/refresh token、完整请求头或聊天正文。Telegram 凭证出现在 API URL 路径中，不要开启会捕获完整子请求 URL 的日志或 tracing。

## 10. 分享源码与隐私边界

分享源码时排除 `.cloudflare/`、`.wrangler/`、`.dev.vars`、生产 secret 文件和聊天备份。`.gitignore` 只影响 Git 的忽略规则，不会自动过滤手工压缩的目录，也不会移除已经提交的文件。

当前部署提供的是只读 Telegram MCP；登录后的管理页另提供确认退出频道的 `leaveChat` 操作，MCP 客户端不能调用。Bot Token 和待处理更新有应用层加密；聊天正文在 D1 中可查询，图片和附件以原始文件内容存入私有 R2。**这不是端到端加密**；部署管理员仍处于数据的信任边界内。

生产配置与 key ring 不应提交到源码仓库。清理 `.cloudflare/` 前先备份；该目录在本项目中同时包含可再生成的构建产物和不可随意丢失的生产配置、密钥与本地数据。

## 参考

- [Cloudflare cf CLI 发布说明](https://blog.cloudflare.com/cloudflare-cf-cli-launch/)
- [R2 首次开通](https://developers.cloudflare.com/r2/get-started/)
- [workers.dev 域名](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [项目 README](../README.md)

cf 仍处于 beta；升级锁文件中的版本后，应重新核对命令。发现命令可先使用 `npx cf cli search '描述资源和操作'`，再查看对应命令的 `--help`。搜索描述不要包含账号 ID、邮箱、Token 或其他私人信息。
