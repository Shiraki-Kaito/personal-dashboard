import test from "node:test";
import assert from "node:assert/strict";
import {
  SessionConnection,
  SessionExpiredError,
} from "../public/session-connection.js";

test("期限切れ後の二重送信を止め、再ログイン後も保存操作を自動再送しない", async () => {
  const calls = [];
  let authorized = false,
    changes = 0;
  const connection = new SessionConnection(
    async (url, options) => {
      calls.push({ url, method: options?.method || "GET" });
      return authorized
        ? Response.json({ expiresAt: Date.now() + 3600000 })
        : Response.json({}, { status: 401 });
    },
    () => changes++,
  );
  await assert.rejects(
    connection.request("/api/edit", { method: "POST", body: "draft" }),
    SessionExpiredError,
  );
  await assert.rejects(
    connection.request("/api/edit", { method: "POST", body: "draft" }),
    SessionExpiredError,
  );
  assert.equal(calls.length, 1);
  assert.equal(changes, 1);
  await assert.rejects(connection.check(), SessionExpiredError);
  authorized = true;
  await connection.check();
  assert.equal(connection.expired, false);
  assert.equal(calls.filter((call) => call.url === "/api/edit").length, 1);
  await connection.request("/api/state");
  assert.equal(calls.at(-1).url, "/api/state");
});
test("通信失敗を期限切れと誤認せず、失敗した接続確認で送信を再開しない", async () => {
  let online = false;
  const connection = new SessionConnection(async () => {
    if (!online) throw Error("network");
    return Response.json({ expiresAt: 1 });
  });
  await assert.rejects(connection.request("/api/state"));
  assert.equal(connection.expired, false);
  connection.fail();
  await assert.rejects(connection.check());
  assert.equal(connection.expired, true);
  online = true;
  await connection.check();
  assert.equal(connection.expired, false);
});
test("古い401応答で新しいログイン確認を無効にせず、接続確認を二重に開始しない", async () => {
  let finish,
    checks = 0;
  const connection = new SessionConnection(async (url) => {
    if (url === "/api/session") {
      checks++;
      return Response.json({ expiresAt: 1 });
    }
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const late = connection.request("/api/state");
  await Promise.all([connection.check(), connection.check()]);
  assert.equal(checks, 1);
  finish(Response.json({}, { status: 401 }));
  await assert.rejects(late, SessionExpiredError);
  assert.equal(connection.expired, false);
});
