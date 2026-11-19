import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Store, parseDuration, parseExpiresIn, tokenIsFresh,
  passiveWindowMs, passiveExpired, stripAtMention, normalizeTimestamp,
  INTENT_LEVELS, nextIntentLevel, handleDispatch, parseFlags, splitGlobalArgs, type QQConfig,
} from "../src/qq-bot.ts";

const CFG: QQConfig = {
  chatlog_days: 30, state_dir: "~/.local/state/qq-bot", media_dir: "",
  binding: "muse", delivery: "pull", sandbox: false,
  allow_from: [], group_allow_from: [], intents: 1107296256,
};

let dir = "";
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qq-bot-test-"));
  store = new Store(join(dir, "qq-bot.db"));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const fakeC2C = (id = "msg-1", content = "hello", ts = Date.now()) => ({
  event_id: id, kind: "c2c", from_openid: "user-1", target_openid: "user-1",
  content, author_name: "alice", received_at: ts,
});

describe("parseDuration", () => {
  test("units", () => {
    assert.strictEqual(parseDuration("30m"), 30 * 60_000);
    assert.strictEqual(parseDuration("7d"), 7 * 86_400_000);
    assert.strictEqual(parseDuration("24h"), 24 * 3_600_000);
    assert.strictEqual(parseDuration("90s"), 90_000);
    assert.strictEqual(parseDuration("3600"), 3_600_000);
  });
  test("invalid throws", () => { assert.throws(() => parseDuration("abc")); });
});

describe("token helpers", () => {
  test("parseExpiresIn accepts string and number", () => {
    assert.strictEqual(parseExpiresIn("7200"), 7200);
    assert.strictEqual(parseExpiresIn(7200), 7200);
    assert.strictEqual(parseExpiresIn("bogus"), 7200);
  });
  test("tokenIsFresh respects the 5-min early refresh", () => {
    assert.strictEqual(tokenIsFresh({ token: "t", expiresAt: Date.now() + 60_000 }), false);
    assert.strictEqual(tokenIsFresh({ token: "t", expiresAt: Date.now() + 10 * 60_000 }), true);
    assert.strictEqual(tokenIsFresh({ token: null, expiresAt: Date.now() + 10 * 60_000 }), false);
  });
});

describe("intents", () => {
  test("levels degrade full -> group+c2c -> channel-only, then stop", () => {
    assert.deepStrictEqual([...INTENT_LEVELS], [1107296256, 33554432, 1073741824]);
    assert.strictEqual(nextIntentLevel(0), 1);
    assert.strictEqual(nextIntentLevel(1), 2);
    assert.strictEqual(nextIntentLevel(2), null);
  });
});

describe("store: dedupe + inbox flow", () => {
  test("insertEvent dedupes on d.id and writes chatlog once", () => {
    assert.strictEqual(store.insertEvent(fakeC2C()), true);
    assert.strictEqual(store.insertEvent(fakeC2C()), false); // duplicate d.id
    assert.strictEqual(store.counts().pending, 1);
    assert.strictEqual(store.chatlogRows({ limit: 10 }).length, 1);
  });

  test("claim / ack / requeue round-trip", () => {
    store.insertEvent(fakeC2C("m1"));
    store.insertEvent(fakeC2C("m2"));
    const claimed = store.claimEvents(10, 30 * 60_000);
    assert.deepStrictEqual(claimed.map((e) => e.event_id), ["m1", "m2"]);
    assert.strictEqual(store.counts().pending, 0);
    assert.strictEqual(store.counts().leased, 2);
    // Second pull claims nothing while leased.
    assert.strictEqual(store.claimEvents(10, 30 * 60_000).length, 0);
    assert.strictEqual(store.ackEvents(["m1"]), 1);
    assert.strictEqual(store.counts().acked, 1);
    assert.strictEqual(store.requeueEvents(["m2"]), 1);
    assert.strictEqual(store.counts().pending, 1);
  });

  test("expired leases are reclaimed on next pull", () => {
    store.insertEvent(fakeC2C("m1"));
    store.claimEvents(10, 1); // 1ms lease
    assert.strictEqual(store.counts().leased, 1);
    // Busy-wait past the lease, then pull again.
    const until = Date.now() + 5;
    while (Date.now() < until) {}
    assert.strictEqual(store.claimEvents(10, 30 * 60_000).length, 1);
  });

  test("chatlog context returns last 40 rows oldest-first for a target", () => {
    for (let i = 0; i < 3; i++) store.insertEvent(fakeC2C(`m${i}`, `msg ${i}`));
    const ctx = store.contextFor("user-1", 40);
    assert.deepStrictEqual(ctx.map((r: any) => r.content), ["msg 0", "msg 1", "msg 2"]);
  });

  test("msg_seq increments per event and persists", () => {
    store.insertEvent(fakeC2C("m1"));
    assert.strictEqual(store.takeMsgSeq("m1"), 1);
    assert.strictEqual(store.takeMsgSeq("m1"), 2);
    assert.strictEqual(store.takeMsgSeq("m1"), 3);
    assert.strictEqual(store.getEvent("m1")!.msg_seq_next, 4);
    assert.strictEqual(store.takeMsgSeq("nope"), null);
  });

  test("rollbackMsgSeq undoes a failed send without going below 1/0", () => {
    store.insertEvent(fakeC2C("m1"));
    assert.strictEqual(store.takeMsgSeq("m1"), 1);
    store.rollbackMsgSeq("m1");
    assert.strictEqual(store.getEvent("m1")!.msg_seq_next, 1);
    assert.strictEqual(store.getEvent("m1")!.reply_count, 0);
    store.rollbackMsgSeq("m1"); // no-op floor
    assert.strictEqual(store.getEvent("m1")!.msg_seq_next, 1);
  });
});

describe("passive windows", () => {
  test("C2C 60 min, group 5 min", () => {
    assert.strictEqual(passiveWindowMs("c2c"), 60 * 60_000);
    assert.strictEqual(passiveWindowMs("group"), 5 * 60_000);
    const fresh = { ...fakeC2C(), received_at: Date.now() } as any;
    const oldC2C = { ...fakeC2C(), received_at: Date.now() - 61 * 60_000 } as any;
    const oldGroup = { ...fakeC2C(), kind: "group", received_at: Date.now() - 6 * 60_000 } as any;
    assert.strictEqual(passiveExpired(fresh), false);
    assert.strictEqual(passiveExpired(oldC2C), true);
    assert.strictEqual(passiveExpired(oldGroup), true);
  });
});

describe("dispatch handling", () => {
  test("C2C_MESSAGE_CREATE queues; duplicate is ignored", () => {
    const d = { id: "d1", author: { user_openid: "u1", username: "a" }, content: "hi", timestamp: new Date().toISOString() };
    assert.strictEqual(handleDispatch(store, "C2C_MESSAGE_CREATE", d), true);
    assert.strictEqual(handleDispatch(store, "C2C_MESSAGE_CREATE", d), false);
    const ev = store.getEvent("d1")!;
    assert.strictEqual(ev.kind, "c2c");
    assert.strictEqual(ev.target_openid, "u1");
  });
  test("GROUP_AT_MESSAGE_CREATE strips the @ mention", () => {
    const d = { id: "g1", group_openid: "grp", author: { member_openid: "m1" }, content: "<qqbot-at-user id=\"x\" /> hello", timestamp: Date.now() };
    assert.strictEqual(handleDispatch(store, "GROUP_AT_MESSAGE_CREATE", d), true);
    assert.strictEqual(store.getEvent("g1")!.content, "hello");
  });
  test("unknown events are ignored", () => {
    assert.strictEqual(handleDispatch(store, "AT_MESSAGE_CREATE", { id: "x" }), false);
  });
});

describe("parseFlags", () => {
  test("--text - keeps the dash as the value (stdin heredoc)", () => {
    const { flags, rest } = parseFlags(["--to", "u1", "--kind", "c2c", "--msg-id", "m1", "--text", "-"]);
    assert.strictEqual(flags.text, "-");
    assert.strictEqual(flags.to, "u1");
    assert.strictEqual(flags["msg-id"], "m1");
    assert.deepStrictEqual(rest, []);
  });
  test("flags before the command are global; subcommand flags stay with the subcommand", () => {
    const argv = ["-config", "/tmp/x.json", "send", "--to", "u1", "--text", "-"];
    const { globalArgs, rest } = splitGlobalArgs(argv);
    const { flags } = parseFlags(globalArgs);
    const sub = parseFlags(rest.slice(1));
    assert.strictEqual(rest[0], "send");
    assert.strictEqual(flags.config, "/tmp/x.json");
    assert.strictEqual(sub.flags.text, "-");
    assert.strictEqual(sub.flags.to, "u1");
  });
});

describe("text helpers", () => {
  test("stripAtMention", () => {
    assert.strictEqual(stripAtMention("@bot hi"), "hi");
    assert.strictEqual(stripAtMention("plain"), "plain");
  });
  test("normalizeTimestamp", () => {
    assert.strictEqual(normalizeTimestamp("2026-11-19T09:00:00Z"), Date.parse("2026-11-19T09:00:00Z"));
    assert.strictEqual(normalizeTimestamp(1790000000), 1790000000 * 1000);
    assert.strictEqual(normalizeTimestamp(1790000000000), 1790000000000);
  });
});
