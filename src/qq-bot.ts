#!/usr/bin/env node
/**
 * qq-bot — QQ official Bot -> Muse (Dash) pull bridge.
 *
 * TypeScript on Node 24, zero external dependencies. Mirrors the wx-bot
 * pull/CLI/SQLite shape, but the transport is the QQ official Bot API
 * (WebSocket gateway), NOT OneBot/NapCat and NOT OpenClaw.
 *
 * Ported from Bun 2026-11-19: Bun's WebSocket fails on this VM with a
 * TLS handshake error (WRONG_VERSION_NUMBER) against the QQ sandbox
 * gateway, while Node 24's built-in WebSocket connects and reaches
 * READY. SQLite moved from bun:sqlite to Node 24's built-in
 * node:sqlite (DatabaseSync); stdin heredoc reading moved from
 * Bun.stdin to process.stdin. See DESIGN.md.
 *
 * See DESIGN.md for the full design. Credentials are NEVER printed,
 * logged, or stored anywhere except ~/.config/qq-bot/env (0600),
 * read at runtime. This file contains no real credential.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const VERSION = "0.1.0";

/* ------------------------------------------------------------------ */
/* Paths / config / env                                                */
/* ------------------------------------------------------------------ */

export function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function defaultConfigPath(): string {
  return join(homedir(), ".config", "qq-bot", "config.json");
}
export function defaultEnvPath(): string {
  return join(homedir(), ".config", "qq-bot", "env");
}

export interface QQConfig {
  chatlog_days: number;
  state_dir: string;
  media_dir: string;
  binding: string;
  delivery: string;
  sandbox: boolean;
  allow_from: string[];
  group_allow_from: string[];
  intents: number;
}

export const DEFAULT_CONFIG: QQConfig = {
  chatlog_days: 30,
  state_dir: "~/.local/state/qq-bot",
  media_dir: "~/.local/state/qq-bot/media",
  binding: "muse",
  delivery: "pull",
  sandbox: false,
  allow_from: [],
  group_allow_from: [],
  intents: 1107296256,
};

export function loadConfig(path = defaultConfigPath()): QQConfig {
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(path, "utf8")) };
}

/** Load KEY=VALUE lines from the env file into process.env (no logging). */
export function loadEnvFile(path = defaultEnvPath()): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
}

export function getCredentials(): { appId: string; appSecret: string } {
  return {
    appId: process.env.QQ_APP_ID ?? "",
    appSecret: process.env.QQ_APP_SECRET ?? "",
  };
}

export function credentialsPresent(): boolean {
  const { appId, appSecret } = getCredentials();
  return Boolean(appId && appSecret && appId !== "PLACEHOLDER" && appSecret !== "PLACEHOLDER");
}

/* ------------------------------------------------------------------ */
/* Durations                                                           */
/* ------------------------------------------------------------------ */

/** "30m" | "5m" | "1h" | "7d" | "90s" | "3600" (seconds) -> ms. */
export function parseDuration(s: string): number {
  const m = /^(\d+)\s*([smhd]?)$/.exec(s.trim());
  if (!m) throw new Error(`invalid duration: ${s}`);
  const n = Number(m[1]);
  const mult: Record<string, number> = { "": 1000, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return n * mult[m[2]];
}

/* ------------------------------------------------------------------ */
/* Intents                                                             */
/* ------------------------------------------------------------------ */

/** Intent degradation levels (full -> group+C2C -> channel-only). */
export const INTENT_LEVELS = [1107296256, 33554432, 1073741824] as const;
export const INTENT_LEVEL_NAMES = ["group+c2c+channel", "group+c2c only", "channel only"] as const;

export function nextIntentLevel(level: number): number | null {
  return level + 1 < INTENT_LEVELS.length ? level + 1 : null;
}

/* ------------------------------------------------------------------ */
/* SQLite store                                                        */
/* ------------------------------------------------------------------ */

export interface QQEvent {
  id?: number;
  event_id: string;
  kind: string; // 'c2c' | 'group'
  from_openid: string;
  target_openid: string;
  content: string;
  author_name: string;
  received_at: number;
  msg_seq_next: number;
  status: string; // pending | leased | acked | dead
  lease_until: number | null;
  reply_count: number;
}

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT UNIQUE,
        kind TEXT,
        from_openid TEXT,
        target_openid TEXT,
        content TEXT,
        author_name TEXT,
        received_at INTEGER,
        msg_seq_next INTEGER DEFAULT 1,
        status TEXT DEFAULT 'pending',
        lease_until INTEGER,
        reply_count INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS chatlog(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT, target_openid TEXT, from_openid TEXT,
        role TEXT, content TEXT, ts INTEGER
      );
      CREATE TABLE IF NOT EXISTS session(
        k TEXT PRIMARY KEY, v TEXT
      );
      CREATE TABLE IF NOT EXISTS send_log(
        request_id TEXT PRIMARY KEY, event_id TEXT, target_openid TEXT,
        content TEXT, sent_at INTEGER, result TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
      CREATE INDEX IF NOT EXISTS idx_chatlog_target ON chatlog(target_openid, ts);
    `);
  }

  close() { this.db.close(); }

  getSession(k: string): string | null {
    const row = this.db.prepare("SELECT v FROM session WHERE k=?").get(k) as { v: string } | null;
    return row ? row.v : null;
  }
  setSession(k: string, v: string) {
    this.db.prepare("INSERT INTO session(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v);
  }

  /** Insert an inbound event; returns false if d.id was already seen. */
  insertEvent(e: Omit<QQEvent, "id" | "msg_seq_next" | "status" | "lease_until" | "reply_count">): boolean {
    const r = this.db.prepare(
      `INSERT OR IGNORE INTO events(event_id,kind,from_openid,target_openid,content,author_name,received_at)
       VALUES(?,?,?,?,?,?,?)`
    ).run(e.event_id, e.kind, e.from_openid, e.target_openid, e.content, e.author_name, e.received_at);
    if (r.changes === 0) return false;
    this.db.prepare(
      `INSERT INTO chatlog(kind,target_openid,from_openid,role,content,ts) VALUES(?,?,?,'user',?,?)`
    ).run(e.kind, e.target_openid, e.from_openid, e.content, e.received_at);
    return true;
  }

  getEvent(eventId: string): QQEvent | null {
    return this.db.prepare("SELECT * FROM events WHERE event_id=?").get(eventId) as QQEvent | null;
  }

  counts(): { pending: number; leased: number; acked: number; dead: number } {
    const rows = this.db.prepare("SELECT status, COUNT(*) c FROM events GROUP BY status").all() as { status: string; c: number }[];
    const out = { pending: 0, leased: 0, acked: 0, dead: 0 };
    for (const r of rows) if (r.status in out) (out as any)[r.status] = r.c;
    return out;
  }

  /** Claim pending (or lease-expired) events for `leaseMs`; returns claimed rows. */
  claimEvents(limit: number, leaseMs: number): QQEvent[] {
    const now = Date.now();
    const until = now + leaseMs;
    // Release expired leases first.
    this.db.prepare("UPDATE events SET status='pending', lease_until=NULL WHERE status='leased' AND lease_until IS NOT NULL AND lease_until < ?").run(now);
    const rows = this.db.prepare(
      "SELECT * FROM events WHERE status='pending' ORDER BY received_at ASC LIMIT ?"
    ).all(limit) as QQEvent[];
    const upd = this.db.prepare("UPDATE events SET status='leased', lease_until=? WHERE event_id=? AND status='pending'");
    const claimed: QQEvent[] = [];
    for (const row of rows) {
      const r = upd.run(until, row.event_id);
      if (r.changes > 0) claimed.push({ ...row, status: "leased", lease_until: until });
    }
    return claimed;
  }

  ackEvents(ids: string[]): number {
    let n = 0;
    const q = this.db.prepare("UPDATE events SET status='acked', lease_until=NULL WHERE event_id=?");
    for (const id of ids) n += q.run(id).changes;
    return n;
  }

  requeueEvents(ids: string[]): number {
    let n = 0;
    const q = this.db.prepare("UPDATE events SET status='pending', lease_until=NULL WHERE event_id=?");
    for (const id of ids) n += q.run(id).changes;
    return n;
  }

  /** Requeue all leases that have expired. Returns count. */
  requeueExpired(): number {
    return this.db.prepare(
      "UPDATE events SET status='pending', lease_until=NULL WHERE status='leased' AND lease_until IS NOT NULL AND lease_until < ?"
    ).run(Date.now()).changes;
  }

  chatlogRows(opts: { sinceMs?: number; limit?: number; withOpenid?: string } = {}): any[] {
    const where: string[] = [];
    const params: any[] = [];
    if (opts.sinceMs) { where.push("ts >= ?"); params.push(Date.now() - opts.sinceMs); }
    if (opts.withOpenid) { where.push("(target_openid=? OR from_openid=?)"); params.push(opts.withOpenid, opts.withOpenid); }
    const sql = `SELECT kind,target_openid,from_openid,role,content,ts FROM chatlog ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ts ASC LIMIT ?`;
    params.push(opts.limit ?? 40);
    return this.db.prepare(sql).all(...params);
  }

  /** Context for one conversation: last N chatlog rows, oldest first. */
  contextFor(targetOpenid: string, limit = 40): any[] {
    return this.db.prepare(
      `SELECT kind,target_openid,from_openid,role,content,ts FROM chatlog
       WHERE target_openid=? ORDER BY ts DESC LIMIT ?`
    ).all(targetOpenid, limit).reverse();
  }

  pruneChatlog(days: number) {
    const cutoff = Date.now() - days * 86_400_000;
    this.db.prepare("DELETE FROM chatlog WHERE ts < ?").run(cutoff);
  }

  /** Take the next msg_seq for an event (persisted counter; see DESIGN divergence note). */
  takeMsgSeq(eventId: string): number | null {
    const row = this.getEvent(eventId);
    if (!row) return null;
    const seq = row.msg_seq_next;
    this.db.prepare("UPDATE events SET msg_seq_next=msg_seq_next+1, reply_count=reply_count+1 WHERE event_id=?").run(eventId);
    return seq;
  }

  /** Undo a takeMsgSeq (e.g. the send failed before the platform accepted it). */
  rollbackMsgSeq(eventId: string) {
    this.db.prepare(
      "UPDATE events SET msg_seq_next=MAX(1,msg_seq_next-1), reply_count=MAX(0,reply_count-1) WHERE event_id=?"
    ).run(eventId);
  }

  recordSend(requestId: string, eventId: string, targetOpenid: string, content: string, result: string) {
    this.db.prepare(
      "INSERT OR REPLACE INTO send_log(request_id,event_id,target_openid,content,sent_at,result) VALUES(?,?,?,?,?,?)"
    ).run(requestId, eventId, targetOpenid, content, Date.now(), result);
  }
  appendBotChatlog(kind: string, targetOpenid: string, fromOpenid: string, content: string) {
    this.db.prepare(
      "INSERT INTO chatlog(kind,target_openid,from_openid,role,content,ts) VALUES(?,?,?,'bot',?,?)"
    ).run(kind, targetOpenid, fromOpenid, content, Date.now());
  }
}

export function openStore(config: QQConfig): Store {
  const dir = expandHome(config.state_dir);
  mkdirSync(dir, { recursive: true });
  const store = new Store(join(dir, "qq-bot.db"));
  store.pruneChatlog(config.chatlog_days);
  return store;
}

/* ------------------------------------------------------------------ */
/* QQ API: token, gateway, send                                        */
/* ------------------------------------------------------------------ */

export function apiBase(sandbox: boolean): string {
  return sandbox ? "https://sandbox.api.sgroup.qq.com" : "https://api.sgroup.qq.com";
}
export function tokenUrl(): string {
  return "https://bots.qq.com/app/getAppAccessToken";
}

export interface TokenCache {
  token: string | null;
  expiresAt: number; // ms epoch
}

export const tokenCache: TokenCache = { token: null, expiresAt: 0 };

/** Parse expires_in which may be a string ("7200") or a number. */
export function parseExpiresIn(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : 7200;
}

export function tokenIsFresh(cache: TokenCache, earlyRefreshMs = 5 * 60_000): boolean {
  // Refresh 5 min early, with 0-30s jitter (applied at fetch time).
  return Boolean(cache.token) && Date.now() + earlyRefreshMs < cache.expiresAt;
}

export async function fetchAccessToken(appId: string, appSecret: string): Promise<{ token: string; expiresIn: number }> {
  const res = await fetch(tokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId, clientSecret: appSecret }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const code = body.code ?? res.status;
    const msg = body.message ?? body.msg ?? res.statusText;
    throw new Error(`getAppAccessToken failed: code=${code} message=${msg}`);
  }
  return { token: body.access_token, expiresIn: parseExpiresIn(body.expires_in) };
}

export async function getAccessToken(store: Store, force = false): Promise<string> {
  if (!force && tokenIsFresh(tokenCache)) return tokenCache.token!;
  const { appId, appSecret } = getCredentials();
  if (!appId || !appSecret) throw new Error("QQ_APP_ID / QQ_APP_SECRET not set — put them in ~/.config/qq-bot/env (0600)");
  const { token, expiresIn } = await fetchAccessToken(appId, appSecret);
  const jitter = Math.floor(Math.random() * 30_000);
  tokenCache.token = token;
  tokenCache.expiresAt = Date.now() + expiresIn * 1000 - jitter;
  store.setSession("token_expires_at", String(tokenCache.expiresAt));
  return token;
}

export async function getGatewayUrl(token: string, sandbox: boolean, appId: string): Promise<string> {
  const res = await fetch(`${apiBase(sandbox)}/gateway`, {
    headers: { Authorization: `QQBot ${token}`, "X-Union-Appid": appId },
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.url) throw new Error(`gateway discovery failed: ${res.status} ${body.message ?? ""}`);
  return body.url as string;
}

export interface SendResult { ok: boolean; message?: string; raw?: any }

/** Passive window: C2C 60 min, group 5 min from receipt. */
export function passiveWindowMs(kind: string): number {
  return kind === "group" ? 5 * 60_000 : 60 * 60_000;
}
export function passiveExpired(ev: QQEvent): boolean {
  return Date.now() - ev.received_at > passiveWindowMs(ev.kind);
}

export async function sendMessage(opts: {
  store: Store; config: QQConfig; kind: "c2c" | "group";
  to: string; text: string; msgId?: string; active?: boolean;
}): Promise<SendResult> {
  const { store, config, kind, to, text } = opts;
  if (!text.trim()) return { ok: false, message: "empty text: nothing to send" };

  let event: QQEvent | null = null;
  let seq: number | null = null;
  let requestId = `active-${to}-${Date.now()}`;
  if (opts.msgId) {
    event = store.getEvent(opts.msgId);
    if (!event) return { ok: false, message: `unknown msg-id: ${opts.msgId} (no such event in inbox; passive reply needs the inbound d.id)` };
    if (event.kind !== kind) return { ok: false, message: `msg-id kind mismatch: event is ${event.kind}, send kind is ${kind}` };
    if (event.target_openid !== to) return { ok: false, message: `msg-id target mismatch: event target is ${event.target_openid}` };
    if (passiveExpired(event)) {
      return { ok: false, message: `expired: passive window (${kind === "group" ? "5 min" : "60 min"}) for msg ${opts.msgId} has passed; refusing instead of falling back to an active send` };
    }
    if (event.reply_count >= 5) return { ok: false, message: `quota: already 5 passive replies for msg ${opts.msgId}` };
    seq = store.takeMsgSeq(opts.msgId);
    if (seq === null) return { ok: false, message: `unknown msg-id: ${opts.msgId}` };
    requestId = `reply-${opts.msgId}-${seq}`;
  } else if (!opts.active) {
    return { ok: false, message: "refusing active send: pass --msg-id for a passive reply, or --active explicitly (active quota is 4/month)" };
  }

  const { appId } = getCredentials();
  const base = apiBase(config.sandbox);
  const path = kind === "c2c" ? `/v2/users/${encodeURIComponent(to)}/messages` : `/v2/groups/${encodeURIComponent(to)}/messages`;

  const doPost = async (token: string, body: any): Promise<any> => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: `QQBot ${token}`, "Content-Type": "application/json", "X-Union-Appid": appId },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  let body: any = { content: text, msg_type: 0 };
  if (opts.msgId) { body.msg_id = opts.msgId; body.msg_seq = seq; }

  // A failed send must not burn the msg_seq / reply-count for this msg_id.
  const failWith = (message: string): SendResult => {
    if (opts.msgId) store.rollbackMsgSeq(opts.msgId);
    return { ok: false, message };
  };

  try {
    let token = await getAccessToken(store);
    let r = await doPost(token, body);
    // 401 / 11243: token invalid — refresh once and retry.
    if (r.status === 401 || r.body?.code === 11243) {
      token = await getAccessToken(store, true);
      r = await doPost(token, body);
    }
    if (!r.body || typeof r.body !== "object") {
      return failWith(`send failed: non-JSON response (HTTP ${r.status})`);
    }
    // Group sends: one reference implementation sends without msg_seq;
    // if the platform rejects msg_seq, retry without it.
    if (r.body.code) {
      const code = r.body.code;
      const msg = String(r.body.message ?? "");
      if (kind === "group" && opts.msgId && /msg_seq/i.test(msg)) {
        const { msg_seq, ...noSeq } = body;
        r = await doPost(token, noSeq);
        if (r.body?.code) return failWith(`send failed: code=${r.body.code} message=${r.body.message ?? ""}`);
      } else if (code === 11298 || code === 40023002) {
        return failWith(`IP whitelist (code ${code}): this machine's egress IP is not whitelisted on q.qq.com; switch to sandbox for C2C testing`);
      } else {
        return failWith(`send failed: code=${code} message=${msg} (status ${r.status})`);
      }
    }

    const fromOpenid = event ? event.from_openid : to;
    store.recordSend(requestId, opts.msgId ?? "", to, text, JSON.stringify(r.body ?? {}));
    store.appendBotChatlog(kind, to, fromOpenid, text);
    return { ok: true, raw: r.body };
  } catch (err: any) {
    return failWith(err?.message ?? String(err));
  }
}

/* ------------------------------------------------------------------ */
/* Gateway daemon (qq-bot run)                                         */
/* ------------------------------------------------------------------ */

export interface RunState {
  pid: number; connected: boolean; started_at: number;
  last_heartbeat_at: number | null; last_heartbeat_ack_at: number | null;
  session_id: string | null; intent_level: number; gateway_url: string | null;
}

export function runStatePath(config: QQConfig): string {
  return join(expandHome(config.state_dir), "run.json");
}
export function writeRunState(config: QQConfig, s: RunState) {
  writeFileSync(runStatePath(config), JSON.stringify(s), "utf8");
}
export function readRunState(config: QQConfig): RunState | null {
  try { return JSON.parse(readFileSync(runStatePath(config), "utf8")); } catch { return null; }
}
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Strip a leading @bot mention from group content, if present. */
export function stripAtMention(content: string): string {
  return content.replace(/^\s*(<qqbot-at-user[^>]*\/>|@\S+)\s*/, "").trim();
}

export function normalizeTimestamp(ts: unknown, fallback = Date.now()): number {
  if (typeof ts === "number") return ts > 1e12 ? ts : ts * 1000;
  if (typeof ts === "string") {
    const n = Date.parse(ts);
    if (!Number.isNaN(n)) return n;
    const asNum = Number(ts);
    if (Number.isFinite(asNum)) return asNum > 1e12 ? asNum : asNum * 1000;
  }
  return fallback;
}

/** Handle one gateway Dispatch event; returns true if a message was queued. */
export function handleDispatch(store: Store, t: string, d: any): boolean {
  if (t === "C2C_MESSAGE_CREATE" && d?.id && d?.author?.user_openid) {
    return store.insertEvent({
      event_id: String(d.id), kind: "c2c",
      from_openid: String(d.author.user_openid),
      target_openid: String(d.author.user_openid),
      content: String(d.content ?? ""),
      author_name: String(d.author.username ?? d.author.user_openid),
      received_at: normalizeTimestamp(d.timestamp),
    });
  }
  if (t === "GROUP_AT_MESSAGE_CREATE" && d?.id && d?.group_openid && d?.author?.member_openid) {
    return store.insertEvent({
      event_id: String(d.id), kind: "group",
      from_openid: String(d.author.member_openid),
      target_openid: String(d.group_openid),
      content: stripAtMention(String(d.content ?? "")),
      author_name: String(d.author.username ?? d.author.member_openid),
      received_at: normalizeTimestamp(d.timestamp),
    });
  }
  return false;
}

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000, 60000];

export async function runDaemon(config: QQConfig): Promise<never> {
  const store = openStore(config);
  loadEnvFile();
  const { appId } = getCredentials();
  let intentLevel = Number(store.getSession("intent_level") ?? "0") || 0;
  let lastSeq: number | null = null;
  const savedSeq = store.getSession("last_seq");
  if (savedSeq) lastSeq = Number(savedSeq);
  let sessionId: string | null = store.getSession("session_id");
  let rapidDisconnects = 0;
  let lastDisconnectAt = 0;
  let attempt = 0;

  const state: RunState = {
    pid: process.pid, connected: false, started_at: Date.now(),
    last_heartbeat_at: null, last_heartbeat_ack_at: null,
    session_id: sessionId, intent_level: intentLevel, gateway_url: null,
  };
  const saveState = () => writeRunState(config, state);
  saveState();
  const log = (msg: string) => console.log(`[${new Date().toISOString()}] qq-bot ${msg}`);

  const cleanup = () => { try { unlinkSync(runStatePath(config)); } catch {} process.exit(0); };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  for (;;) {
    attempt++;
    try {
      const token = await getAccessToken(store);
      const url = await getGatewayUrl(token, config.sandbox, appId);
      state.gateway_url = url;
      saveState();
      log(`gateway: ${url}`);
      const connectedAt = Date.now();
      const closed = await connectOnce({ config, store, url, token, intentLevel, sessionId, lastSeq, state, log,
        onStateChanged: () => saveState(),
        onSession: (sid, seq) => { sessionId = sid; lastSeq = seq; state.session_id = sid; store.setSession("session_id", sid); saveState(); },
        onSeq: (seq) => { lastSeq = seq; store.setSession("last_seq", String(seq)); },
        onIntentDegraded: (level) => { intentLevel = level; state.intent_level = level; store.setSession("intent_level", String(level)); saveState(); },
      });
      state.connected = false;
      saveState();
      const livedMs = Date.now() - connectedAt;
      if (livedMs < 5000) {
        rapidDisconnects++;
        if (Date.now() - lastDisconnectAt < 5000) rapidDisconnects++;
      } else rapidDisconnects = 0;
      lastDisconnectAt = Date.now();
      if (rapidDisconnects >= 3) {
        log("3 rapid disconnects — refreshing access token");
        tokenCache.token = null;
        rapidDisconnects = 0;
      }
      if (closed === "invalid-session-exhausted") {
        log("intent degradation exhausted — waiting 60s before retry");
        await sleep(60_000);
      } else {
        const delay = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
        log(`disconnected (${closed}); reconnecting in ${delay}ms`);
        await sleep(delay);
      }
    } catch (err: any) {
      const delay = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
      log(`error: ${err?.message ?? err}; retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface ConnectOpts {
  config: QQConfig; store: Store; url: string; token: string;
  intentLevel: number; sessionId: string | null; lastSeq: number | null;
  state: RunState; log: (m: string) => void;
  onSession: (sid: string, seq: number | null) => void;
  onSeq: (seq: number) => void;
  onIntentDegraded: (level: number) => void;
  onStateChanged?: () => void;
}

/** One WebSocket connection; resolves with a close reason when it ends. */
export function connectOnce(opts: ConnectOpts): Promise<string> {
  return new Promise((resolve) => {
    const { config, store } = opts;
    let level = opts.intentLevel;
    let lastSeq: number | null = opts.lastSeq;
    let sessionId: string | null = opts.sessionId;
    let heartbeatTimer: any = null;
    let settled = false;
    let identified = false;

    const ws = new WebSocket(opts.url);
    const finish = (reason: string) => {
      if (settled) return;
      settled = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      try { ws.close(); } catch {}
      resolve(reason);
    };

    const sendJson = (o: any) => { try { ws.send(JSON.stringify(o)); } catch {} };

    ws.onopen = () => opts.log("websocket connected, waiting for Hello");
    ws.onerror = () => finish("ws-error");
    ws.onclose = () => finish("closed");

    ws.onmessage = (ev: MessageEvent) => {
      let msg: any;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      const { op, s, t, d } = msg;
      if (typeof s === "number") { lastSeq = s; opts.onSeq(s); }
      if (op === 10) { // Hello
        const interval = Number(d?.heartbeat_interval ?? 45000);
        heartbeatTimer = setInterval(() => {
          opts.state.last_heartbeat_at = Date.now();
          sendJson({ op: 1, d: lastSeq });
        }, interval);
        if (sessionId) {
          sendJson({ op: 6, d: { token: `QQBot ${opts.token}`, session_id: sessionId, seq: lastSeq } });
          opts.log("sent Resume");
        } else {
          sendJson({ op: 2, d: { token: `QQBot ${opts.token}`, intents: INTENT_LEVELS[level], shard: [0, 1] } });
          opts.log(`sent Identify (intents ${INTENT_LEVELS[level]}, level ${level})`);
        }
        identified = true;
      } else if (op === 11) { // Heartbeat ACK
        opts.state.last_heartbeat_ack_at = Date.now();
        opts.onStateChanged?.();
      } else if (op === 9) { // Invalid Session
        const next = nextIntentLevel(level);
        if (next !== null) {
          level = next;
          opts.onIntentDegraded(level);
          opts.log(`op=9 Invalid Session — degrading intents to level ${level} (${INTENT_LEVELS[level]})`);
          sendJson({ op: 2, d: { token: `QQBot ${opts.token}`, intents: INTENT_LEVELS[level], shard: [0, 1] } });
        } else {
          opts.log("op=9 Invalid Session — intent degradation exhausted");
          finish("invalid-session-exhausted");
        }
      } else if (op === 0) { // Dispatch
        if (t === "READY" && d?.session_id) {
          sessionId = String(d.session_id);
          opts.onSession(sessionId, lastSeq);
          opts.state.connected = true;
          opts.onStateChanged?.();
          opts.log(`READY session=${sessionId}`);
        } else if (t === "RESUMED") {
          opts.state.connected = true;
          opts.onStateChanged?.();
          opts.log("RESUMED");
        } else if (t === "C2C_MESSAGE_CREATE" || t === "GROUP_AT_MESSAGE_CREATE") {
          const queued = handleDispatch(store, t, d);
          opts.log(`${t} ${d?.id} ${queued ? "queued" : "duplicate"}`);
        }
      } else if (op === 7) { // Reconnect (Discord-style; treat as close)
        finish("reconnect-requested");
      }
    };
    // Safety: if no Hello within 30s, give up this attempt.
    setTimeout(() => { if (!identified && !settled) finish("hello-timeout"); }, 30_000);
  });
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function usage(): string {
  return `qq-bot — QQ official Bot bridge for Muse (Dash), pull mode

Usage:
  qq-bot [flags] <command> [args]

Commands:
  run               Connect to the QQ gateway, queue messages (daemon)
  send              Send a message (see qq-bot send -h)
  inbox             Claim / ack pull events, or requeue (see qq-bot inbox -h)
  chatlog           Query recorded chats (see qq-bot chatlog -h)
  status            Show binding / gateway / inbox state
  health            Exit 0 only if the gateway is connected + token valid
  version           Print version

Flags:
  -config string    path to config.json (default ~/.config/qq-bot/config.json)
  --json            machine-readable output (status / inbox / chatlog)

Replies are plain text only. Passive replies only by default; an active
send needs --active and burns the 4/month quota.
`;
}

interface Flags { [k: string]: string | boolean }

/**
 * Split argv into [global flags before the command, command + subcommand args].
 * Global flags are only -config/--config (with a value) and --json; a flag's
 * separate value must not be mistaken for the command (e.g. "-config /tmp/x.json").
 */
export function splitGlobalArgs(argv: string[]): { globalArgs: string[]; rest: string[] } {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-config" || a === "--config") { i++; continue; }
    if (a.startsWith("-config=") || a.startsWith("--config=") || a === "--json") continue;
    if (a.startsWith("-") && a !== "-") continue; // unknown global flag: skip
    return { globalArgs: argv.slice(0, i), rest: argv.slice(i) };
  }
  return { globalArgs: argv, rest: [] };
}

export function parseFlags(args: string[]): { flags: Flags; rest: string[] } {
  const flags: Flags = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") flags.json = true;
    else if (a === "--grace" && i + 1 < args.length) flags.grace = args[++i];
    else if (a === "--liveness") flags.liveness = true;
    else if (a === "--active") flags.active = true;
    else if (a.startsWith("-config=")) flags.config = a.slice(8);
    else if (a === "-config" && i + 1 < args.length) flags.config = args[++i];
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < args.length && (!args[i + 1].startsWith("-") || args[i + 1] === "-")) flags[a.slice(2)] = args[++i];
      else flags[a.slice(2)] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function fail(msg: string): never {
  console.error(`qq-bot: ${msg}`);
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  // Only flags BEFORE the command are global (e.g. -config). Flags after
  // the command belong to the subcommand and are parsed by its handler;
  // parsing the whole argv at once would swallow them.
  const { globalArgs, rest } = splitGlobalArgs(argv);
  const { flags } = parseFlags(globalArgs);
  const configPath = typeof flags.config === "string" ? expandHome(flags.config) : defaultConfigPath();
  const config = loadConfig(configPath);
  loadEnvFile();

  const [cmd, ...args] = rest;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") { console.log(usage()); return; }
  if (cmd === "version") { console.log(`qq-bot ${VERSION}`); return; }

  const store = openStore(config);
  const asJson = Boolean(flags.json) || args.includes("--json");

  if (cmd === "status") {
    const counts = store.counts();
    const run = readRunState(config);
    const daemonAlive = run ? processAlive(run.pid) : false;
    const gateway = run && daemonAlive && run.connected ? "connected" : "not running";
    const tokenExp = store.getSession("token_expires_at");
    const tokenState = tokenIsFresh(tokenCache) ? "cached (valid)"
      : tokenExp && Number(tokenExp) > Date.now() ? `cached by daemon, valid until ${new Date(Number(tokenExp)).toISOString()}`
      : credentialsPresent() ? "not fetched yet" : "no credentials (set QQ_APP_ID/QQ_APP_SECRET in ~/.config/qq-bot/env)";
    const out = {
      binding: config.binding, delivery: config.delivery, sandbox: config.sandbox,
      intents: config.intents, intent_level: run?.intent_level ?? Number(store.getSession("intent_level") ?? "0"),
      token: tokenState, gateway, daemon_pid: run && daemonAlive ? run.pid : null,
      inbox: counts, session_id: run?.session_id ?? store.getSession("session_id"),
    };
    if (asJson) console.log(JSON.stringify(out, null, 2));
    else {
      console.log(`binding: ${out.binding}\n  delivery: ${out.delivery}\n  sandbox: ${out.sandbox}\n  intents: ${out.intents} (level ${out.intent_level})\n  token: ${tokenState}\n  gateway: ${gateway}${out.daemon_pid ? ` (pid ${out.daemon_pid})` : ""}\n  inbox: ${counts.pending} pending, ${counts.leased} leased, ${counts.acked} acked, ${counts.dead} dead`);
    }
    return;
  }

  if (cmd === "health") {
    const { flags: hf } = parseFlags(args);
    const graceMs = hf.grace !== undefined ? Number(hf.grace) * 1000 : 0;
    const run = readRunState(config);
    const failWith = (m: string): never => { console.log(`qq-bot health: ${m}`); process.exit(1); };
    if (!credentialsPresent()) failWith("no credentials: QQ_APP_ID/QQ_APP_SECRET not set in ~/.config/qq-bot/env");
    if (!run || !processAlive(run.pid)) failWith("qq-bot run is not running");
    if (!run.connected) failWith("gateway not connected (daemon running but no READY yet)");
    const lastAck = run.last_heartbeat_ack_at ?? run.last_heartbeat_at;
    if (!lastAck) failWith("no heartbeat yet");
    if (Date.now() - lastAck > 90_000 + graceMs) failWith(`heartbeat stale (${Math.round((Date.now() - lastAck) / 1000)}s since last ack)`);
    console.log("qq-bot health: ok (gateway connected)");
    return;
  }

  if (cmd === "run") {
    await runDaemon(config);
    return;
  }

  if (cmd === "inbox") {
    const [sub, ...subArgs] = args;
    if (sub === "count") {
      const c = store.counts();
      if (asJson) console.log(JSON.stringify(c));
      else console.log(`${c.pending} pending, ${c.leased} leased, ${c.acked} acked, ${c.dead} dead`);
      return;
    }
    if (sub === "pull") {
      const { flags: pf } = parseFlags(subArgs);
      const limit = pf.limit ? Number(pf.limit) : 10;
      const leaseMs = pf.lease ? parseDuration(String(pf.lease)) : 30 * 60_000;
      const claimed = store.claimEvents(limit, leaseMs);
      const events = claimed.map((e) => ({
        event_id: e.event_id, kind: e.kind, from_openid: e.from_openid,
        target_openid: e.target_openid, content: e.content, msg_id: e.event_id,
        author_name: e.author_name, received_at: e.received_at,
        context: store.contextFor(e.target_openid, 40),
      }));
      console.log(JSON.stringify({ events }, null, 2));
      return;
    }
    if (sub === "ack") {
      if (!subArgs.length) fail("usage: qq-bot inbox ack <event_id>...");
      console.log(`${store.ackEvents(subArgs)} acked`);
      return;
    }
    if (sub === "requeue") {
      if (subArgs.length) console.log(`${store.requeueEvents(subArgs)} requeued`);
      else console.log(`${store.requeueExpired()} expired leases requeued`);
      return;
    }
    fail("usage: qq-bot inbox <count|pull|ack|requeue> (see qq-bot -h)");
  }

  if (cmd === "chatlog") {
    const { flags: cf } = parseFlags(args);
    const rows = store.chatlogRows({
      sinceMs: cf.since ? parseDuration(String(cf.since)) : parseDuration("7d"),
      limit: cf.limit ? Number(cf.limit) : 40,
      withOpenid: typeof cf.with === "string" ? cf.with : undefined,
    });
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (cmd === "send") {
    const { flags: sf } = parseFlags(args);
    const to = sf.to as string | undefined;
    const kind = (sf.kind as string | undefined) ?? "c2c";
    if (!to) fail("usage: qq-bot send --to <openid> --kind c2c|group --msg-id <d.id> --text -");
    if (kind !== "c2c" && kind !== "group") fail("--kind must be c2c or group");
    let text: string;
    if (sf.text === "-") text = await readStdinText();
    else if (typeof sf.text === "string") text = sf.text;
    else fail("usage: qq-bot send --to <openid> --kind c2c|group --msg-id <d.id> --text -  (use --text - with a heredoc)");
    const msgId = typeof sf["msg-id"] === "string" ? (sf["msg-id"] as string) : undefined;
    const result = await sendMessage({
      store, config, kind: kind as "c2c" | "group", to, text,
      msgId, active: Boolean(sf.active),
    });
    if (!result.ok) fail(result.message ?? "send failed");
    console.log(JSON.stringify({ ok: true, request: result.raw ?? {} }, null, 2));
    return;
  }

  fail(`unknown command: ${cmd}\n${usage()}`);
}

if (import.meta.main) {
  main().catch((err: any) => {
    console.error(`qq-bot: ${err?.message ?? err}`);
    process.exit(1);
  });
}
