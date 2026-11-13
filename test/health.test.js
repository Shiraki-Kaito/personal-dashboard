import test from "node:test";
import assert from "node:assert/strict";
import { healthView } from "../src/health.js";

const now = Date.parse("2026-11-13T07:00:00Z");
const recent = new Date(now - 60000).toISOString(),
  old = new Date(now - 2 * 60 * 60 * 1000).toISOString();
const env = {
  PROJECT_CONFIG: JSON.stringify({ project: "p", title: "タスク" }),
};
function memory(entries = []) {
  const map = new Map(entries);
  return {
    get: async (k) => structuredClone(map.get(k)),
    list: async ({ prefix, limit }) =>
      new Map([...map].filter(([k]) => k.startsWith(prefix)).slice(0, limit)),
  };
}
test("保存情報だけから取得失敗・古さ・未取得を区別し、本文・認証情報を返さない", async () => {
  const storage = memory([
    [
      "catalog:p",
      {
        lastAttempt: recent,
        lastSuccess: old,
        items: [{ title: "private body" }],
      },
    ],
    ["notes:config", { owner: "owner", repo: "notes" }],
    ["notes:token", "credential sentinel"],
    [
      "notes:cache",
      {
        lastAttempt: recent,
        lastSuccess: recent,
        error: "credential sentinel",
        errorCode: "auth",
        files: [{ path: "private body" }],
      },
    ],
    ["agenda:accounts", [{ id: "a", email: "fixture@example.test" }]],
    ["agenda:credential:a", { token: "credential sentinel" }],
    [
      "agenda:cache:a",
      {
        lastSuccess: recent,
        lastAttempt: recent,
        messages: [{ subject: "private body" }],
      },
    ],
  ]);
  const before = JSON.stringify(await storage.get("notes:cache"));
  const result = await healthView(env, storage, now);
  assert.equal(result.externalRequests, 0);
  assert.equal(
    result.sources.find((s) => s.service === "github").state,
    "stale",
  );
  assert.equal(
    result.sources.find((s) => s.service === "notes").state,
    "error",
  );
  assert.equal(result.sources.find((s) => s.service === "mail").state, "ok");
  assert.equal(
    result.sources.find((s) => s.service === "calendar").state,
    "never",
  );
  assert.equal(JSON.stringify(result).includes("credential sentinel"), false);
  assert.equal(JSON.stringify(result).includes("private body"), false);
  assert.equal(JSON.stringify(await storage.get("notes:cache")), before);
});
test("未接続を成功にせず、結果未確認・未同期を件数だけ集約し再送しない", async () => {
  const storage = memory([
    [
      "agenda:accounts",
      [{ id: "a", email: "fixture@example.test", disconnectedAt: recent }],
    ],
    ["agenda:pending:a", ["m1", "m2"]],
    ["agenda:mailJob", { nextAt: now - 6 * 60000 }],
    ["task:p:a", { pending: { value: "private body" }, phase: "競合" }],
  ]);
  const result = await healthView(env, storage, now);
  assert.equal(result.pending.find((p) => p.service === "github").count, 1);
  assert.equal(result.pending.find((p) => p.service === "calendar").count, 2);
  assert.equal(
    result.sources.find((s) => s.service === "mail").state,
    "disconnected",
  );
  assert.equal(
    result.sources.find((s) => s.service === "slack").state,
    "disconnected",
  );
  assert.equal(
    result.sources.find((s) => s.service === "notes").state,
    "disconnected",
  );
  assert.equal(result.jobs[0].delayed, true);
  assert.equal(JSON.stringify(result).includes("private body"), false);
});
test("GitHub未同期調査は上限付きで、不完全な件数を全件扱いにしない", async () => {
  const storage = memory(
    Array.from({ length: 1001 }, (_, i) => ["task:p:" + i, { pending: {} }]),
  );
  const result = await healthView(env, storage, now);
  assert.equal(result.pending[0].count, 1001);
  assert.equal(result.pending[0].limited, true);
});

test("試験Projectの古さは実運用の要確認件数へ混ぜない", async () => {
  const storage = memory([["catalog:p", { lastSuccess: old }]]);
  const result = await healthView(env, storage, now);
  assert.equal(
    result.sources.find((source) => source.service === "github").test,
    true,
  );
  assert.equal(result.attentionCount, 3);
});
