# QQ official Bot -> Muse (Dash) pull bridge — design

Status: **implemented 2026-11-19 (qq-bot v0.1.0), ported Bun → Node 24
the same day, and verified end-to-end the same day against real QQ
credentials in sandbox mode**: token + gateway + READY, and two C2C
private-chat rounds ("你好" / "收到") replied and acked. Bridge code:
`src/qq-bot.ts` (single file, Node 24, zero deps), tests in
`tests/qq-bot.test.ts` (19 pass under `node --test`), installed wrapper
`~/.local/bin/qq-bot` (sh wrapper that execs `node src/qq-bot.ts` —
Node type-stripping needs the `.ts` extension, so an extensionless copy
does not work), config `~/.config/qq-bot/config.json` (0600), env
`~/.config/qq-bot/env` (0600, placeholders only), SQLite
`~/.local/state/qq-bot/qq-bot.db`. systemd unit
`adapters/muse/qq-bot.service` is enabled, keepalive
`adapters/muse/qq-bot-keepalive` installed, Muse hook
`adapters/muse/qq-bot-hook.sh` polling every 5 s. Credentials are
placeholders only — never put the real AppSecret in this repo, in
chat, or in memory.

## Implementation divergences from this design (2026-11-19)

1. **msg_seq offset not needed.** §4 offsets the counter by
   `Date.now() % 1e8` at process start to avoid collisions after a
   restart. The implementation persists `msg_seq_next` per event in
   SQLite instead, so it survives restarts without an offset.
   Added `rollbackMsgSeq()`: a failed send does not burn the
   `msg_seq` / reply-count for that `msg_id` (verified by test).
2. **Run state file.** The daemon writes `~/.local/state/qq-bot/run.json`
   (`{pid, connected, last_heartbeat_at, last_heartbeat_ack_at,
   session_id, intent_level, gateway_url}`) so `status` / `health`
   can tell whether the gateway is connected without a live query.
   It is removed on SIGINT/SIGTERM.
3. **health semantics.** `health --grace 0` exits 0 only if credentials
   are present AND the daemon's run state shows connected with a
   heartbeat ack within 90 s (+ grace). It does not fetch a token
   itself.
4. **Single-file implementation.** `src/qq-bot.ts` only (plus
   `src/cli.ts` was not split out); helpers are exported for
   `bun:test`. `package.json` has `build` / `test` scripts.
5. **Config sandbox flag.** Created with `"sandbox": false` per the
   build task. Memory now records the user's bot is in sandbox mode
   with C2C enabled — flip to `"sandbox": true` (one line) before
   the token/gateway test if the parent wants sandbox first.
6. **CLI arg parsing.** Flags after the subcommand belong to the
   subcommand; only `-config` / `--json` before the command are
   global. `--text -` (stdin heredoc) is parsed correctly.
   Two bugs found by the E2E test and fixed: top-level flag parsing
   swallowing subcommand flags, and `-config <path>` being mistaken
   for the command.
7. **Ported Bun → Node 24 (2026-11-19).** Bun's WebSocket fails on
   this VM against the QQ gateway: `TLS handshake failed:
   error:100000f7:SSL routines:OPENSSL_internal:WRONG_VERSION_NUMBER`,
   close 1006, even with proxy env vars removed. Node 24's built-in
   WebSocket to the same URL opens, receives op 10 Hello, Identify
   with intents 1107296256 succeeds, and READY arrives (parent
   verified with real credentials; the port itself used placeholders
   only and ran no live gateway test). Changes: `bun:sqlite` →
   `node:sqlite` (`DatabaseSync`; `db.query()` → `db.prepare()`;
   `get()` returns `undefined` instead of `null` for a missing row,
   which existing falsy checks already handle); `Bun.stdin.stream()`
   → `process.stdin` async iteration; shebang `bun` → `node`;
   tests `bun:test` + `expect` → `node:test` + `node:assert/strict`
   (all 19 pass); `package.json` scripts now use Node, and `node
   --test` needs the test file named explicitly (`node --test
   tests/` fails to load it). Installed `~/.local/bin/qq-bot` is a
   small sh wrapper (`exec node …/src/qq-bot.ts "$@"`) because Node
   only type-strips files with a `.ts` extension. The Node build
   reads the same `~/.local/state/qq-bot/qq-bot.db` created by the
   Bun build (verified: `status` / `inbox count` / `chatlog` /
   `inbox pull` all work against it). `health --grace 0` exits 1
   because no daemon is running (it now gets past the credentials
   check — the env holds the parent's test credentials, not
   placeholders).

## Verdict

No existing open-source project is a drop-in "official QQ Bot -> Muse pull
bridge" analogous to `lawrencewzen/wx-bot` for WeChat iLink. A small custom
daemon is needed, but the transport logic can be adapted from
`tencent-connect/openclaw-qqbot` (`@sliverp/qqbot`, TS: `src/api.ts` +
`src/gateway.ts` + `src/session-store.ts`), and the pull/CLI/SQLite
architecture can be copied from `Reshwell/onebot-agent-bridge` (which is
OneBot/NapCat, not official API — see §6).

Biggest risks, before writing code:
1. **Production IP whitelist.** Production OpenAPI requires the caller's
   public egress IP to be whitelisted on q.qq.com; otherwise calls fail
   with `11298` / `40023002`. This VM's egress is a shared proxy, so its
   IP is not reliably whitelstable. Sandbox is exempt from the whitelist.
2. **Sandbox has no group testing since Jan 2026** — sandbox covers C2C
   and channel only. Group `@` can only be tested in production.
3. **Passive replies only, in practice.** Active (proactive) messages are
   4/month per user / per group. The bridge must reply inside the passive
   window or it cannot reply at all.

## 1. Access token

- Endpoint: `POST https://bots.qq.com/app/getAppAccessToken`
  (2026 unified domain also: `POST https://api.bot.qq.com/app/getAppAccessToken`)
- Body (JSON): `{"appId": "<QQ_APP_ID>", "clientSecret": "<QQ_APP_SECRET>"}`
- Response: `{"access_token": "...", "expires_in": "7200"}`
  (`expires_in` is 7200 seconds; some SDKs see it as a string, some as a
  number — parse both.)
- No refresh-token grant. Re-request before expiry; requesting within
  60 s of expiry returns a new token while the old one stays valid for
  that 60 s overlap. Cache the token and refresh proactively 5 min
  before expiry (openclaw-qqbot pattern, with 0–30 s jitter), and
  re-fetch on every reconnect and on 401 / 11243.
- All later calls: `Authorization: QQBot <access_token>`
  (note: `QQBot`, not `Bot` / `Bearer`). Newer v5 clients also send
  `X-Union-Appid: <QQ_APP_ID>`.

Token test (placeholders only — read credentials from the env file, do
not paste them on a command line):

```bash
# ~/.config/qq-bot/env (0600) holds QQ_APP_ID / QQ_APP_SECRET; source it first
set -a; . ~/.config/qq-bot/env; set +a
curl -s -X POST "https://bots.qq.com/app/getAppAccessToken" \
  -H "Content-Type: application/json" \
  -d "{\"appId\":\"$QQ_APP_ID\",\"clientSecret\":\"$QQ_APP_SECRET\"}"
# Expected: {"access_token":"...","expires_in":"7200"}
# Error:    {"code":100016,"message":"invalid appid or secret"}
```

A 200 here proves only that the AppID/AppSecret pair is valid. It does
not prove gateway, IP-whitelist, intent, or send permission.

## 2. Gateway WebSocket

- Discover URL: `GET https://api.sgroup.qq.com/gateway`
  (unified domain: `GET https://api.bot.qq.com/gateway`;
  `GET /gateway/bot` variant also returns a URL) with the QQBot token.
  Response: `{"url": "wss://<host>/websocket"}`.
  Sandbox: `GET https://sandbox.api.sgroup.qq.com/gateway`.
- Protocol is Discord-like. Envelope: `{op, s, t, d}` plus `id` for
  some events. Opcodes seen in the reference implementations:
  `0` Dispatch, `1` Heartbeat, `2` Identify, `6` Resume,
  `9` Invalid Session, `10` Hello, `11` Heartbeat ACK.
- Flow:
  1. Connect to the discovered `wss://…/websocket`.
  2. Server sends `op=10 Hello` with `d.heartbeat_interval` (ms).
  3. Client authenticates, then heartbeats `op=1` with the last `s`
     at that interval; server replies `op=11`.
  4. `READY` gives `session_id`; persist `{session_id, last_seq,
     intent_level}` to disk (5-min expiry, as in openclaw-qqbot's
     session store) so a reconnect can Resume instead of Identify.
- Identify (`op=2`):
  ```json
  {"op": 2, "d": {"token": "QQBot <access_token>", "intents": 1107296256, "shard": [0, 1]}}
  ```
- Resume (`op=6`):
  ```json
  {"op": 6, "d": {"token": "QQBot <access_token>", "session_id": "<saved>", "seq": <last_seq>}}
  ```
- Intents (bitmask, decimal):
  | intent | bit | value |
  |---|---|---|
  | `GUILDS` | `1<<0` | 1 |
  | `GUILD_MEMBERS` | `1<<1` | 2 |
  | `DIRECT_MESSAGE` (guild DM) | `1<<12` | 4096 |
  | `GROUP_AND_C2C` (group @ / group all / C2C / friend) | `1<<25` | 33554432 |
  | `PUBLIC_GUILD_MESSAGES` (channel @) | `1<<30` | 1073741824 |
  - Recommended minimal for this use (C2C + group @, no guild):
    `(1<<25) | (1<<30) = 1107296256`.
    Add `(1<<12)` (= 1107300352) only if guild DMs are wanted.
  - **Do NOT include `GUILD_MESSAGES` (`1<<9`).** For unverified /
    public bots that bit is unauthorised and Identify is rejected with
    `op=9 Invalid Session` (see esengine/DeepSeek-Reasonix #7512).
  - Degradation strategy (copy from sliverp/qqbot): on `op=9`, retry
    Identify with the next lower intent level
    (full → group+channel → channel-only), persist the level that
    worked, and use it first on the next reconnect.
  - Reconnect: exponential backoff 1s, 2s, 5s, 10s, 30s, then 60s;
    60s delay on rate-limit; force a token refresh after 3 rapid
    disconnects (<5 s each).
- Webhook is the alternative delivery mode, but it needs a public
  HTTPS callback (ports 80/443/8080/8443, Ed25519 signature) and is
  mutually exclusive with WebSocket once a callback URL is configured.
  WebSocket is the right choice here — no public IP needed.

## 3. Inbound events

Only these two matter for the first version (plus `READY`/`RESUMED`):

| event | trigger | `d` fields |
|---|---|---|
| `C2C_MESSAGE_CREATE` | user DMs the bot | `id`, `author.user_openid`, `author.username` (sometimes), `content`, `timestamp`, `attachments` |
| `GROUP_AT_MESSAGE_CREATE` | user @s the bot in a group | `id`, `group_openid`, `author.member_openid`, `content`, `timestamp`, `attachments` |

Notes:
- `GROUP_MESSAGE_CREATE` (non-@ group messages) only arrives if a
  group admin enables "bot can get all group messages" in the group.
  Default is @-only. Treat non-@ group messages as context, not tasks
  (same as Reshwell/onebot-agent-bridge).
- `AT_MESSAGE_CREATE` / `DIRECT_MESSAGE_CREATE` are guild channel
  events — out of scope for v1.
- IDs are **openids, bot-specific**: they are not QQ numbers / group
  numbers and cannot be reused by another bot or reverse-looked-up.
- The platform may deliver the same `msg_id` more than once — dedupe
  on `d.id` (message id) before queueing.
- Group content: the `@bot` prefix is stripped by the platform in
  some adapters; normalise by stripping a leading `@<bot name>` /
  `<qqbot-at-user …/>` if present.

## 4. Outbound replies

Base URL: `https://api.sgroup.qq.com` (unified: `https://api.bot.qq.com`;
sandbox: `https://sandbox.api.sgroup.qq.com`).
Header: `Authorization: QQBot <access_token>`.

### C2C (private chat)

`POST /v2/users/{user_openid}/messages`

```json
{"content": "plain text reply", "msg_type": 0, "msg_id": "<inbound d.id>", "msg_seq": 1}
```

### Group

`POST /v2/groups/{group_openid}/messages`

```json
{"content": "plain text reply", "msg_type": 0, "msg_id": "<inbound d.id>", "msg_seq": 1}
```

- `msg_type`: `0` text, `2` markdown, `3` ark, `4` embed, `7` media.
  v0.1.0 只发纯文本（`msg_type: 0`）；**v0.2.0 已实现富媒体**：
  先 `POST /v2/users/{openid}/files` 或 `/v2/groups/{group_openid}/files`
  上传（`file_type` 1 图片 / 2 视频 / 3 音频 / 4 文件，
  `srv_send_msg=false`），再用 `msg_type: 7` + `media.file_info` 发送。
  上传两种模式：`url`（QQ 自己下载，适合 > 5 MB）或 `file_data`
 （base64，≤ 5 MB）。实测（2026-11-19 沙箱）：`file_data` 图片、视频
  均成功；`url` 用 Muse 内置存储链接两次失败（`850027 富媒体文件
  上传超时`，连 1 KB 小图也超时），目前优先用 `file_data`。
  webp 图片先转 png 再传。`msg_type: 7` 不能带 `content` 文本，
  配文单独发一条文本消息。
- Passive reply: include `msg_id` (= inbound `d.id`). `msg_seq` is a
  per-`msg_id` counter starting at 1, incremented for each extra reply
  to the same inbound message; the platform rejects a repeated
  `msg_id`+`msg_seq` pair. Offset the counter by `Date.now() % 1e8`
  at process start to avoid collisions after a restart
  (openclaw-qqbot `msgSeqTracker` pattern; prune to ~500 entries).
  Note: one reference implementation sends group replies with only
  `msg_id` and no `msg_seq`; if group sends reject `msg_seq`, retry
  without it.
- `event_id` is for passive replies to `INTERACTION_CREATE` /
  `GROUP_ADD_ROBOT` / `GROUP_MSG_RECEIVE` events, not for message
  replies — do not send it for `C2C/GROUP_AT_MESSAGE_CREATE`.
- Media (v2, later): upload first —
  `POST /v2/users/{openid}/files` or `/v2/groups/{group_openid}/files`
  (`file_type` 1 image / 2 video / 3 audio / 4 file,
  `srv_send_msg=false`), then send with `msg_type: 7` + `media.file_info`.
  **Implemented in v0.2.0 (2026-11-19), see README "直接发图片/视频" and
  `uploadMediaFile` / `sendMediaMessage` in src/qq-bot.ts.**

### Limits (the design constraint)

| context | active (no `msg_id`) | passive (with `msg_id`) |
|---|---|---|
| C2C | 4 / user / month | 5 replies per message, within 60 min |
| Group | 4 / group / month | 5 replies per message, within 5 min |
| Channel | 20 / day / channel | 5 min window |
| Channel DM | 2 / user / day | 5 min window |

Consequences: the Muse hook must wake and reply **fast** (group:
5 min is the hard deadline); a reply that misses the window must
not be retried as a passive reply — it would fail, and retrying as
an active message burns the 4/month quota. Never send active
messages by default; log `expired` / quota errors to the Muse chat.
One source notes active C2C pushes "stopped being provided" on
2025-04-21 — treat active send as unreliable / unavailable and
design for passive-only.

## 5. Sandbox vs production / q.qq.com setup

- Create the bot at q.qq.com, complete developer real-name
  authentication (sources say 1–2 working days), then create the
  robot and copy AppID / AppSecret immediately (the secret is not
  shown again in plaintext).
- Enable the intents/permissions the bot needs on q.qq.com:
  C2C message, group @ message (and channel message if guilds are
  ever wanted). Permission changes may need re-audit.
- Submit for audit; sources say 1–3 working days. Sandbox can be
  used while waiting.
- Sandbox: only the developer and test members can use it; no
  frequency limits; **since Jan 2026 sandbox no longer supports
  group testing — C2C and channel only**; exempt from the IP
  whitelist.
- Production: all QQ users can use it, but the caller's public IP
  must be whitelisted on q.qq.com (failure: `11298` / `40023002`),
  and active-message limits apply.
- The bot must be added to a QQ group by a group admin before it
  can receive group @ messages.
- Conflicting sources on eligibility: one 2026-03 guide says QQ
  open platform requires an enterprise licence; the OpenClaw QQ
  guide describes personal developer real-name authentication.
  Do not assume either — the user's bot is already created, so
  verify its actual status/permissions on q.qq.com instead.
- Security: AppSecret is password-equivalent — 0600 env file only,
  never in git/chat/logs; rotate every ~3 months per QQ's guidance;
  viewing it a second time on q.qq.com forces a reset.

## 6. Existing bridges — reusable vs custom

| project | transport | Muse pull? | verdict |
|---|---|---|---|
| `tencent-connect/openclaw-qqbot` (`@sliverp/qqbot`, TS) | official Bot API, WS gateway | No — OpenClaw plugin | **Best reference.** Reuse the design of `src/api.ts` (token cache + singleflight, `getGatewayUrl`, `sendC2C/sendGroup`, `msg_seq` tracker) and `src/gateway.ts` (Hello/Identify/Resume/heartbeat/backoff/intent degradation) + session store. Forking it into a standalone daemon means replacing OpenClaw dispatch with a SQLite inbox. |
| `Reshwell/onebot-agent-bridge` (Node 24, 0★, 2 commits, Oct 2026) | **OneBot v11 via NapCat/SnowLuma — not official API** | **Yes — explicitly documents Muse pull** (`fetch`/`ack`/`send`, SQLite queue, HTTP RPC, MCP, group mention-only + 20-message context, `requestId` send dedupe) | **Best architecture template.** Copy its CLI/inbox/hook shape and its Muse docs; replace its entire OneBot transport with §2–§4. Do not reuse its transport. |
| `yincongcyincong/MuseBot` (Go) | official Bot API via `botgo` (`robot/qq.go`, `QQ_APP_ID`/`QQ_APP_SECRET`, HTTP callback) + OneBot `PersonalQQRobot` | No — full LLM bot, needs its own LLM API key | Reference only for botgo handler shapes. Not a pull bridge; Go is not installed on this VM. |
| `zhin.js` `@zhin.js/adapter-qq` (TS, `qq-official-bot` lib) | official Bot API, WS gateway default, webhook/middleware optional | No — Zhin framework adapter | Reference for intent derivation from `botKind` (public/private) and multi-endpoint config. Not standalone. |
| `ruter/bub-contrib` `bub-qq` (Python) | official Bot API, C2C only | No — Bub framework | Reference for token refresh (60 s skew) and C2C `msg_id` dedupe (1024-entry cache). |
| `op7418/Claude-to-IM` qq-adapter, `chenhg5/cc-connect` qqbot, Hermes QQ adapter | official Bot API, WS | No — bound to their own agent runtimes | Reference only; same passive-reply + `msg_seq` pattern. |
| NapCat / LLOneBot / SnowLuma / Derpyu520 `qq-bridge` (OneBot) | personal QQ account protocol | No (DSH, not Muse) | **Out of scope** — third-party protocol, account-ban risk, and `Derpyu520/qq-bridge` is sunset/archived 2026-11-18. |

Conclusion: **no official-QQ → Muse pull bridge exists today.**
Build a small custom daemon; do not adopt an agent framework
(OpenClaw / Zhin / MuseBot / Hermes) just for the QQ channel.

## 7. Recommended design (this VM)

Toolchain (verified on this VM): Node v24.22.1, Bun v1.4.4,
Python 3.12.3, npm 10.9.4, pip 24.0. **Go is not installed.**
Node 24 has a global `WebSocket` and `fetch` plus built-in SQLite
(`node:sqlite`, `DatabaseSync`). **Recommendation: TypeScript on
Node 24, zero external dependencies** (no `ws`, no `botgo`, no
`websockets` — Python has neither `websocket` nor `websockets`
installed). Bun was the original recommendation, but Bun's
WebSocket cannot complete a TLS handshake with the QQ gateway on
this VM (see divergence 7); Node 24's WebSocket can.

### File layout

```
~/workspace/qq-bot-bridge/
  DESIGN.md            # this file
  package.json         # bun, no runtime deps
  src/
    qq-bot.ts          # single-file daemon + CLI (or split: token.ts, gateway.ts, api.ts, store.ts)
    cli.ts             # count / pull / ack / requeue / send / status / health
  config.json          # see below (0600, no secret inside — secret in env file)
  .env.example         # QQ_APP_ID=<placeholder> / QQ_APP_SECRET=<placeholder>
~/config/qq-bot/  -> actually ~/.config/qq-bot/
  config.json          # 0600
  env                  # 0600, QQ_APP_ID / QQ_APP_SECRET (sourced by daemon + keepalive)
~/.local/bin/qq-bot           # installed binary/script (bun build) — mirrors ~/.local/bin/wx-bot
~/.local/bin/qq-bot-keepalive # mirrors wx-bot-keepalive (system unit → sudo restart → nohup)
~/.local/state/qq-bot/
  qq-bot.db            # SQLite inbox + chatlog + session + msg_seq (see below)
  run.log
/etc/systemd/system/qq-bot.service   # mirrors wx-bot.service; NOT enabled until login/gateway verified
~/hooks/scripts/qq-bot-qq.sh         # mirrors wx-bot-wechat.sh (poll 5 s)
```

### Config (mirror of `~/.config/wx-bot/config.json`)

```json
{
  "chatlog_days": 30,
  "state_dir": "~/.local/state/qq-bot",
  "media_dir": "~/.local/state/qq-bot/media",
  "binding": "muse",
  "delivery": "pull",
  "sandbox": false,
  "allow_from": ["<owner user_openid>"],
  "group_allow_from": [],
  "intents": 1107296256
}
```

Secrets live only in `~/.config/qq-bot/env` (0600), sourced by the
daemon, the CLI and the keepalive script — exactly like
`~/.config/wx-bot/env`.

### Daemon (`qq-bot run`)

One long-lived process (systemd `Restart=always`, `RestartSec=5`):
token cache → `GET /gateway` → WS connect → Hello → Identify/Resume
→ heartbeat → on `C2C_MESSAGE_CREATE` / `GROUP_AT_MESSAGE_CREATE`,
insert into SQLite and continue. No reply is generated by the daemon
itself. On disconnect: backoff reconnect (§2); on `op=9`: degrade
intents; on 401/11243: clear token cache and re-fetch.

### Inbox storage (SQLite, one file)

```sql
CREATE TABLE events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE,          -- d.id (msg_id), dedupe key
  kind TEXT,                     -- 'c2c' | 'group'
  from_openid TEXT,              -- C2C: author.user_openid; group: author.member_openid
  target_openid TEXT,            -- C2C: user_openid; group: group_openid
  content TEXT,
  author_name TEXT,
  received_at INTEGER,           -- unix ms
  msg_seq_next INTEGER DEFAULT 1,
  status TEXT DEFAULT 'pending', -- pending | leased | acked | dead
  lease_until INTEGER,
  reply_count INTEGER DEFAULT 0
);
CREATE TABLE chatlog(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT, target_openid TEXT, from_openid TEXT,
  role TEXT,                     -- 'user' | 'bot'
  content TEXT, ts INTEGER
);
CREATE TABLE session(
  k TEXT PRIMARY KEY, v TEXT     -- session_id, last_seq, intent_level, token_expires_at
);
CREATE TABLE send_log(
  request_id TEXT PRIMARY KEY, event_id TEXT, target_openid TEXT,
  content TEXT, sent_at INTEGER, result TEXT
);
```

`chatlog` keeps 30 days (same `chatlog_days` as wx-bot) so the hook
can read the last 40 records before handling a new message — the
user's standing 40-history rule applies to QQ too.

### CLI (mirror `wx-bot inbox …`)

```
qq-bot status [--binding muse]        # logged_in/gateway/intents/inbox counts
qq-bot health --grace 0              # exit 0 only if gateway connected + token valid
qq-bot inbox count [--binding muse]  # pending count, no claim (safe for dry runs)
qq-bot inbox pull [--binding muse] [--limit N] [--lease 30m]
                                     # claim events -> {"events":[{event_id,kind,from_openid,target_openid,content,msg_id,received_at,context:[last 40 chatlog rows]}]}
qq-bot inbox ack <event_id>...       # mark handled
qq-bot inbox requeue [--binding muse] [event_id...]
qq-bot chatlog [--since 7d] [--limit 40] [--with <openid>]
qq-bot send --to <openid> --kind c2c|group --msg-id <d.id> --text -   # heredoc, plain text only
qq-bot send --to <openid> --kind c2c --text - --active   # refused by default: active quota 4/month; require explicit flag + log
```

`send` must: look up the event, take `msg_seq = msg_seq_next++`
for that `msg_id`, POST to the matching endpoint, append to
`chatlog` + `send_log` with a stable `request_id`
(`reply-<event_id>-<seq>`), and refuse if the passive window has
expired (C2C 60 min / group 5 min) instead of silently falling back
to an active send.

### Muse hook (mirror `wx-bot-wechat`, poll 5 s)

Same shape as `~/hooks/scripts/wx-bot-wechat.sh`: `inbox count` →
wake on new events → `health --liveness` → on failure run
`qq-bot-keepalive` first, then wake with the error; suppress repeat
alerts for 60 min; dry runs touch no state. Hook wake prompt:
first run `qq-bot chatlog --since 7d --limit 40`, then
`qq-bot inbox pull --lease 30m`, dedupe by `event_id`, reply in
plain text only via `qq-bot send … --text -` heredoc, ack every
event, and report `expired` / quota / `11298` failures in the Muse
chat in Chinese. Allowlist: only `allow_from` C2C openids and
`group_allow_from` groups are answered; unknown senders get no
reply (and no active message).

### Restart survival (mirror wx-bot)

1. systemd unit `/etc/systemd/system/qq-bot.service`
   (`ExecStart=~/.local/bin/qq-bot run`, `Restart=always`,
   `EnvironmentFile=-~/.config/qq-bot/env`, `WantedBy=default.target`);
   `daemon-reload && enable --now` only after gateway + a test
   message are verified, then wait 15 s and require
   `qq-bot health --grace 0` exit 0.
2. `~/.local/bin/qq-bot-keepalive`: same one-line contract as
   wx-bot-keepalive (`ok` / `restarted: …` / `NEED_USER: …`),
   restart order user unit → `sudo -n systemctl restart qq-bot` →
   `setsid nohup qq-bot run`.
3. Hook liveness check (above) is the recovery path if `/etc` is
   wiped on a VM replacement: home (`~/.local/bin/qq-bot`,
   `~/.config/qq-bot/`, `~/.local/state/qq-bot/`) survives, the unit
   does not — reinstall the unit from the repo copy, no re-login
   needed (the token is re-fetched from AppID/AppSecret; there is
   no QR login to redo, unlike WeChat).

## 8. Open questions / next steps (in order)

1. Token test (§1) with the supplied credentials — expect 200;
   if it fails with 100016, the AppID/AppSecret pair is wrong or
   was rotated.
2. Check the bot's actual status/permissions on q.qq.com:
   audit state, enabled intents (C2C + group @), and whether the
   egress IP needs whitelisting. If production calls return
   `11298`/`40023002`, switch to sandbox for the C2C test and note
   that group testing needs production + a whitelisted IP.
3. Gateway test: `GET /gateway` + WS Identify with intents
   1107296256; if `op=9`, degrade intents and record which level
   worked.
4. C2C test: user DMs the bot from QQ, verify `C2C_MESSAGE_CREATE`
   lands in the inbox, then a passive reply arrives within 60 min.
5. Group test (production only): add the bot to a group, @ it,
   verify `GROUP_AT_MESSAGE_CREATE` and a reply within 5 min.
6. Only then: enable the systemd unit, enable the hook, and
   deliver the result.

## Sources

- QQ Bot API v2 docs (tencent-connect/bot-docs, via DeepWiki):
  token `POST https://bots.qq.com/app/getAppAccessToken`,
  `expires_in` 7200, `Authorization: QQBot …`, gateway via
  `/gateway` or `/gateway/bot`, intents, `C2C_MESSAGE_CREATE` /
  `GROUP_AT_MESSAGE_CREATE`, send endpoints and rate limits.
- `tencent-connect/openclaw-qqbot` `src/api.ts` / `src/gateway.ts`
  (token cache, gateway discovery, Identify/Resume, heartbeat,
  backoff, intent degradation, `msg_seq` tracker).
- `Reshwell/onebot-agent-bridge` README (pull/CLI/SQLite/Muse
  pattern — OneBot transport only).
- `yincongcyincong/MuseBot` `robot/qq.go` (botgo official QQ),
  `zhin.js` `@zhin.js/adapter-qq`, `ruter/bub-contrib` `bub-qq`,
  esengine/DeepSeek-Reasonix #7512 (`1<<9` → `op=9`).
- QQ open platform guides (open-claw.me, NianFeng-Chat qqbot docs):
  sandbox vs production, IP whitelist `11298`/`40023002`,
  sandbox group testing removed Jan 2026, audit 1–3 days.
