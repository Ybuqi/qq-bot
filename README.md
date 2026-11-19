# qq-bot — QQ 官方机器人 → Muse（Dash）pull 桥

用 QQ 官方 Bot API 把 QQ 私聊接到 Muse 个人助手（Dash）。消息先存本地收件箱，
Muse 每几秒拉取一次，处理完再通过官方接口回过去。不用个人 QQ 号，不用 NapCat /
OneBot，不依赖 OpenClaw。

思路照着微信的 [wx-bot](https://github.com/lawrencewzen/wx-bot) pull 模式抄的：
pull 收件箱 + systemd 常驻 + keepalive + hook 轮询，处理前先读最近 40 条上下文。

> 状态：2026-11-19 已在沙箱模式下端到端验证通过 —— token、网关、READY、
> 两轮 C2C 私聊（“你好” / “收到”）均已回复并确认。当前版本 v0.3.0
> （v0.2.0 直接发图片/视频；v0.3.0 收图：入站图片下载到本地）。

## 目录结构

```text
qq-bot-bridge/
├── src/qq-bot.ts              # 桥的全部实现（Node 24，零外部依赖）
├── tests/qq-bot.test.ts      # 19 个测试（node --test）
├── package.json              # npm scripts：test / build / start
├── .env.example              # 凭证模板（占位符，绝不要填真值提交）
├── config.example.json       # 配置模板
├── DESIGN.md                 # 完整设计文档：API、网关、intents、限流
├── LICENSE                   # MIT
├── scripts/install.sh        # 安装：把 qq-bot 装到 ~/.local/bin
└── adapters/muse/
    ├── qq-bot.service        # systemd 模板（__HOME__ / __USER__ 需替换）
    ├── qq-bot-keepalive      # 保活脚本：输出 ok / restarted: … / NEED_USER: …
    └── qq-bot-hook.sh        # Muse hook 轮询脚本（每 5 秒扫收件箱）
```

## 工作原理

```text
QQ 用户私聊 → QQ 官方网关 (wss) → qq-bot 守护进程 → SQLite 收件箱
                                                            ↓ 每 5 秒
                                              Muse hook 唤醒 → 读最近 40 条
                                              → inbox pull --lease 30m
                                              → 回复（纯文本）→ ack
```

- **收到消息**：守护进程连 QQ 网关 WebSocket，`C2C_MESSAGE_CREATE` / `GROUP_AT_MESSAGE_CREATE`
  事件按 `d.id` 去重后写入 SQLite（`~/.local/state/qq-bot/qq-bot.db`）。
- **收图（v0.3.0）**：消息里的 `d.attachments` 不再丢弃。守护进程收到带附件的事件后
  立刻把图片下载到 `~/.local/state/qq-bot/media/`（文件名 `<event_id>-<序号>-<原文件名>`），
  因为 QQ CDN 链接很快就过期，只存链接不可靠。下载失败不影响事件入队（记日志、留原链接）。
  事件里带上附件（含本地路径），`inbox pull` 能直接看到；chatlog 里图片记为
  `[图片] <本地路径>`，文字+图片一起处理。纯文字消息的行为完全不变。
  附件字段形状见 DESIGN.md §3（`content_type` / `filename` / `height` / `width` / `size` / `url`）。
- **拉取**：`qq-bot inbox pull --lease 30m` 领走事件，30 分钟内未 ack 会重新出现。
- **回复**：`qq-bot send --to <openid> --kind c2c --msg-id <d.id> --text -`，
  只发纯文本。被动回复窗口：私聊 60 分钟、每条消息最多 5 次；群 5 分钟。
  过期绝不改发主动消息（主动消息每月每人只有 4 条）。
- **上下文**：每次处理新消息前先跑 `qq-bot chatlog --since 7d --limit 40`。

## 前置条件

- Node.js 24（用到了 Node 内置的 WebSocket 和 `node:sqlite`；
  注意：Bun 的 WebSocket 在某些云主机上连 QQ 网关会 TLS 握手失败，
  本项目因此从 Bun 迁到了 Node，见 DESIGN.md）
- 一个 QQ 机器人：在 [QQ 开放平台 q.qq.com](https://q.qq.com) 创建机器人，
  开通 **C2C 私聊**权限，拿到 AppID 和 AppSecret
- 建议先开**沙箱模式**：沙箱免生产 IP 白名单，适合测试；
  生产环境要求调用方出口 IP 在平台白名单里（否则报错 11298）

## 安装

```bash
git clone <你的仓库地址> qq-bot-bridge
cd qq-bot-bridge
node --test tests/qq-bot.test.ts   # 19 个测试应全部通过
sh scripts/install.sh             # 装到 ~/.local/bin/qq-bot
```

## 配置

```bash
mkdir -p ~/.config/qq-bot
cp config.example.json ~/.config/qq-bot/config.json
chmod 0600 ~/.config/qq-bot/config.json
```

按你的情况改 `~/.config/qq-bot/config.json`：

| 字段 | 说明 |
|---|---|
| `sandbox` | `true` 沙箱 / `false` 生产 |
| `intents` | `1107296256`（C2C + 群 @ + 频道）。不要加 `GUILD_MESSAGES`，Identify 会被拒 |
| `allow_from` | 允许回复的 QQ 用户 openid 列表（白名单，陌生人不回） |
| `chatlog_days` | 聊天记录保留天数，默认 30 |
| `binding` / `delivery` | `muse` / `pull`，不要改 |

凭证**只**放在 `~/.config/qq-bot/env`（0600），绝不要进仓库：

```bash
cat > ~/.config/qq-bot/env <<'EOF'
QQ_APP_ID=你的 AppID
QQ_APP_SECRET=你的 AppSecret
EOF
chmod 0600 ~/.config/qq-bot/env
# 如果机器走代理，systemd 服务读不到 shell 的代理变量，也要把代理变量写进这个文件
```

获取自己的 openid：先跑起来后给机器人发一条私聊，
`qq-bot chatlog --since 7d --limit 40` 里 `from_openid` 就是，
把它加进 `allow_from` 再重启服务。

## 常驻运行（systemd + keepalive）

```bash
HOME_ABS="$(cd ~ && pwd)"
USER_NAME="$(stat -c '%U' "$HOME_ABS" 2>/dev/null || id -un)"
sed "s|__HOME__|${HOME_ABS}|g; s|__USER__|${USER_NAME}|g" \
  adapters/muse/qq-bot.service | sudo tee /etc/systemd/system/qq-bot.service >/dev/null
sudo systemctl daemon-reload && sudo systemctl enable --now qq-bot
sleep 15
~/.local/bin/qq-bot health --grace 0   # 退出码必须为 0
~/.local/bin/qq-bot status
```

保活：`~/.local/bin/qq-bot-keepalive`（安装脚本已复制过去），
只输出一行 `ok` / `restarted: …` / `NEED_USER: …`。
机器重启后 systemd 会自己拉起服务；如果运行环境被替换、`/etc` 被清空，
按上面步骤重装 unit 即可，登录态是 AppID/AppSecret 换 token，不用扫码。

## 接入 Muse（hook，每 5 秒轮询）

把 `adapters/muse/qq-bot-hook.sh` 放到 Muse 的 hook 脚本目录，
注册一个 hook：`poll_interval_secs` 设为 5，唤醒指令写清——

1. 先 `qq-bot chatlog --binding muse --since 7d --limit 40` 看最近 40 条；
2. 再 `qq-bot inbox pull --binding muse --lease 30m` 拉取；
3. 只回白名单用户，纯文本回复，处理完每条都 ack；
4. 生成了图片、视频等文件时：优先用 `send-media` 直接发到 QQ
   （见下面“直接发图片/视频”一节），配文单独发一条文本；
   媒体发送失败再退回发下载链接，同时在主聊天交付文件。

## 直接发图片/视频（v0.2.0）

QQ 官方 Bot API 支持富媒体：先上传文件拿到 `file_info`，再用
`msg_type: 7` 发送。被动回复规则和文本完全一样（私聊 60 分钟窗口、
每条消息最多 5 次，配文不能和媒体同发，要单独发一条文本）。

```bash
# 只上传不发（测试用），拿到 file_info
qq-bot upload-media --to <openid> --kind c2c --type image --url <公网URL>

# 上传 + 作为被动回复发出去（--msg-id 是收到的那条 QQ 消息的 d.id）
qq-bot send-media --to <openid> --kind c2c --msg-id <d.id> \
  --type image --url <公网URL>
qq-bot send-media --to <openid> --kind c2c --msg-id <d.id> \
  --type video --file /path/to/video.mp4
```

`--type` 是 `image`（file_type 1）/ `video`（2）/ `audio`（3）/ `file`（4）。
两种上传方式：

- `--file <本地路径>`：文件以 base64（`file_data`）直接上传，≤ 5 MB。
  图片是 webp 时会自动先转成 png（python3 + Pillow，ffmpeg 备用），
  因为 QQ 图片白名单一般是 png/jpg/jpeg/gif。
- `--url <公网URL>`：QQ 平台自己去下载，适合 > 5 MB 的文件。

**实测结论（2026-11-19，沙箱）：`--file` 模式图片和视频都成功拿到了
`file_info`；`--url` 模式用 Muse 内置存储（muse.ai）的链接两次都失败，
报错 `850027 富媒体文件上传超时`，连 1 KB 的小图也超时，说明 QQ 服务器
拉不到这类链接。所以目前优先用 `--file`；超过 5 MB 的视频先试 `--url`，
失败就改发下载链接文本。**

chatlog 里媒体记为 `[图片] <url或文件名>` / `[视频] …`，上下文里能看到。

## 常用命令

```bash
qq-bot status                              # 网关、token、收件箱状态
qq-bot health --grace 0                    # 健康检查，退出码 0 为正常
qq-bot inbox count                         # 待处理 / 已租 / 已确认 / 死信
qq-bot chatlog --since 7d --limit 40       # 最近 40 条上下文
qq-bot inbox pull --binding muse --lease 30m
qq-bot inbox ack <event_id>                # 确认一条事件
qq-bot inbox requeue <event_id>            # 把一条事件放回待处理
printf '你好\n' | qq-bot send --binding muse --to <openid> --kind c2c \
  --msg-id <d.id> --text -                 # 被动回复一条私聊
qq-bot run                                 # 前台跑守护进程（一般由 systemd 跑）
```

## 限制（实测过的）

- 回复很慢是结构性的：hook 每 5 秒扫一次没错，但每次唤醒都要重新启动处理、
  读 40 条上下文、生成回复，简单问候也要 40–70 秒；视频生成本身还要两三分钟。
- 私聊被动回复 60 分钟窗口、每条 5 次；群 5 分钟；主动消息每月每人 4 条。
- 沙箱只能测 C2C 私聊和频道，群聊 @ 要到生产环境测。
- 生产环境出口 IP 必须在 q.qq.com 白名单，共享代理出口一般加不进去。

## 排障

| 现象 | 排查 |
|---|---|
| `health` 失败 | 先看 `qq-bot status`，再看 `journalctl -u qq-bot`；常见是 env 里没代理变量导致 token 拉不到 |
| `systemctl cat qq-bot` 找不到 unit | 运行环境被替换，`/etc` 被清空，按上面重装 unit |
| 消息进了收件箱但没人回 | `qq-bot inbox count` 看 pending 数，hook 是否启用；被动窗口过期就不会再回 |
| Identify 被拒（op 9） | intents 里混进了 `GUILD_MESSAGES`，改回 1107296256 |
| Bun 报 TLS 握手失败 | 换 Node 24 跑，本项目已迁移 |

## 安全

- AppSecret 只存在 `~/.config/qq-bot/env`（0600），不要发到聊天、不要提交到仓库。
- 仓库里只有占位符；提交前用 `git status` 确认没有 `.env`、`.db`、`*run.json`。
- `allow_from` 白名单默认只回你本人；对外公开仓库前确认里面没有你的 openid。
