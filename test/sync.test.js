import test from "node:test";
import assert from "node:assert/strict";
import { synchronize } from "../src/sync.js";
import { RemoteError, github, transport } from "../src/github.js";

function fixture() {
  const config = { options: [{ id: "a" }, { id: "b" }] };
  const values = new Map();
  const storage = {
    get: async (k) => structuredClone(values.get(k)),
    put: async (k, v) => values.set(k, structuredClone(v)),
  };
  const f = {
    remote: { revision: "1", due: null, status: "a" },
    reads: 0,
    writes: 0,
  };
  const api = {
    async read() {
      f.reads++;
      if (f.failRead) throw new RemoteError("通信失敗");
      return structuredClone(f.remote);
    },
    async write(field, value) {
      f.writes++;
      if (f.failWrite) throw new RemoteError("権限不足");
      f.remote[field] = value;
      f.remote.revision = String(+f.remote.revision + 1);
      if (f.lost) throw new RemoteError("タイムアウト");
    },
  };
  f.call = (action, input = {}) =>
    synchronize(action, input, config, api, storage);
  f.edit = async (field = "status", value = "b") =>
    f.call("edit", { field, value, base: (await f.call("state")).remote });
  return f;
}
test("期限設定と解除を再取得で確認する", async () => {
  const f = fixture();
  await f.call("refresh");
  assert.equal((await f.edit("due", "2028-02-29")).remote.due, "2028-02-29");
  assert.equal((await f.edit("due", null)).pending, null);
  await assert.rejects(f.edit("due", "2027-02-29"));
  assert.equal(f.writes, 2);
});
test("取得失敗時は成功時刻とキャッシュを維持する", async () => {
  const f = fixture(),
    before = await f.call("refresh");
  f.failRead = true;
  const s = await f.call("refresh");
  assert.equal(s.error, "通信失敗");
  assert.deepEqual(s.remote, before.remote);
  assert.equal(s.lastSuccess, before.lastSuccess);
});
test("応答喪失後、保存状態から再開し再送せず照合する", async () => {
  const f = fixture();
  await f.call("refresh");
  f.lost = true;
  const failed = await f.edit();
  assert.ok(failed.pending);
  assert.equal(failed.error, "タイムアウト");
  const s = await f.call("retry", { id: failed.pending.id });
  assert.equal(s.pending, null);
  assert.equal(f.writes, 1);
});
test("権限復旧後に照合してから再試行する", async () => {
  const f = fixture();
  await f.call("refresh");
  f.failWrite = true;
  const s = await f.edit();
  assert.equal(s.error, "権限不足");
  f.failWrite = false;
  assert.equal(
    (await f.call("retry", { id: s.pending.id })).remote.status,
    "b",
  );
  assert.equal(f.writes, 2);
});
test("競合、二重編集、古い破棄を拒否する", async () => {
  const f = fixture();
  await f.call("refresh");
  f.remote.due = "2027-01-01";
  const conflict = await f.edit();
  assert.match(conflict.phase, /競合/);
  await assert.rejects(f.edit());
  await assert.rejects(f.call("discard", { id: "old" }));
  assert.match(
    (await f.call("retry", { id: conflict.pending.id })).phase,
    /競合/,
  );
  assert.equal(
    (await f.call("discard", { id: conflict.pending.id })).pending,
    null,
  );
  assert.equal(f.writes, 0);
});
test("APIエラーを分類し、mutationは一度だけ送る", async () => {
  for (const [status, expected] of [
    [401, "認証"],
    [403, "権限"],
    [429, "レート"],
    [503, "一時障害"],
  ]) {
    let count = 0;
    const request = transport("test", async () => {
      count++;
      return Response.json({}, { status });
    });
    await assert.rejects(request("mutation", {}, false), new RegExp(expected));
    assert.equal(count, 1);
  }
});
test("一時的な読み取り失敗は待機後に一度だけ再試行", async () => {
  let count = 0;
  const request = transport("test", async () =>
    ++count === 1
      ? new Response("", { status: 502 })
      : Response.json({ data: { ok: true } }),
  );
  assert.deepEqual(await request("query", {}, true), { ok: true });
  assert.equal(count, 2);
});
test("取得できないIDを検出する", async () => {
  const api = github({}, async () => ({
    viewer: { id: "U_kgDODg51tg" },
    node: null,
  }));
  await assert.rejects(api.read(), /対象消失/);
});

test("複数ページ取得の要求上限を越えたら部分取得を止める", async () => {
  let requests = 0;
  const send = transport("fixture", async () => {
    requests++;
    return Response.json({ data: { ok: true } });
  });
  for (let i = 0; i < 40; i++) await send("query", {}, true);
  await assert.rejects(send("query", {}, true), /取得要求数の上限/);
  assert.equal(requests, 40);
});
