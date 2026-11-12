import test from "node:test";
import assert from "node:assert/strict";
import { agendaHome } from "../src/agenda-home.js";
import { extractAppointment } from "../src/agenda-rules.js";
import { agendaToken, agendaConnectionStatus } from "../src/agenda-google.js";
import { reviewAgenda } from "../src/agenda.js";
const env = {
  GOOGLE_CLIENT_ID: "1-fixture.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "fixture",
};
function memory(values = new Map()) {
  const s = {
    values,
    get: async (k) => structuredClone(values.get(k)),
    put: async (k, v) => values.set(k, structuredClone(v)),
    delete: async (k) => values.delete(k),
    transaction: async (fn) => fn(s),
  };
  return s;
}
async function setup() {
  const s = memory(),
    now = Date.now();
  await s.put("agenda:accounts", [
    { id: "a", email: "a@example.test" },
    { id: "b", email: "b@example.test" },
  ]);
  for (const id of ["a", "b"])
    await s.put("agenda:credential:" + id, {
      token: "private-token",
      refresh: "private-refresh",
      expires: now + 3600000,
    });
  await s.put("agenda:cache:a", {
    lastSuccess: new Date(now).toISOString(),
    nextPageToken: "more",
    messages: [
      {
        id: "aaa",
        subject: "面談",
        candidate: extractAppointment("面談", "日程未定"),
      },
      {
        id: "bbb",
        subject: "確認済み",
        candidate: { isCandidate: true, status: "確認待ち" },
      },
      {
        id: "ccc",
        subject: "登録済み",
        candidate: { isCandidate: true, status: "確認待ち" },
      },
      {
        id: "ddd",
        subject: "セール",
        candidate: extractAppointment("セール", "商品を割引販売します"),
      },
    ],
  });
  await s.put("agenda:reviews:a", {
    bbb: { reviewedAt: new Date(now).toISOString() },
  });
  await s.put("agenda:operation:a:ccc", { phase: "登録確認済み" });
  await s.put("agenda:pending:a", ["manual-pending"]);
  await s.put("agenda:operation:a:manual-pending", {
    draft: { title: "結果不明の予定" },
    phase: "登録結果未確認",
  });
  return { s, now };
}
test("ホームは予定候補と結果不明を優先し、通常メール・確認済み・登録済みを除外する", async () => {
  const { s, now } = await setup(),
    view = await agendaHome(s, now);
  assert.deepEqual(
    view.entries.map((e) => [e.kind, e.messageId]),
    [
      ["pending", "manual-pending"],
      ["mail", "aaa"],
    ],
  );
  assert.equal(view.candidates, 1);
  assert.equal(view.pending, 1);
  assert.equal(view.complete, false);
  assert.match(view.alerts[0].message, /未取得/);
  assert.equal(JSON.stringify(view).includes("private-"), false);
});
test("旧判定・古い取得・認証失効を問題なしと表示しない", async () => {
  const { s, now } = await setup();
  await s.put("agenda:cache:b", {
    messages: [{ id: "old", candidate: { status: "確認待ち" } }],
    lastSuccess: new Date(now - 7200000).toISOString(),
  });
  let view = await agendaHome(s, now);
  assert.equal(view.accounts[1].unclassified, 1);
  assert.equal(view.accounts[1].stale, true);
  assert.match(view.alerts[0].message, /更新/);
  await s.put("agenda:credential:b", { invalid: true });
  view = await agendaHome(s, now);
  assert.match(view.alerts[0].message, /再接続/);
});
test("予定と無関係なメールは候補なしとし、面談の日時不足は確認待ちにする", () => {
  assert.equal(
    extractAppointment("セールのお知らせ", "割引情報です").isCandidate,
    false,
  );
  assert.equal(
    extractAppointment("セールのお知らせ", "割引情報です").status,
    "予定候補なし",
  );
  assert.equal(
    extractAppointment("面談について", "11/13 10:00〜11:00").status,
    "確認待ち",
  );
});
test("メールの確認記録を永続化・復元し、元情報と別アカウントを変更しない", async () => {
  const { s } = await setup(),
    before = await s.get("agenda:cache:a");
  const reviewed = await reviewAgenda(env, s, {
    accountId: "a",
    messageId: "aaa",
    reviewed: true,
  });
  assert.ok(reviewed.messages[0].review);
  const reloaded = memory(s.values);
  assert.equal((await agendaHome(reloaded)).candidates, 0);
  assert.deepEqual(await s.get("agenda:cache:a"), before);
  await assert.rejects(
    reviewAgenda(env, s, { accountId: "b", messageId: "aaa", reviewed: true }),
  );
  await reviewAgenda(env, s, {
    accountId: "a",
    messageId: "aaa",
    reviewed: false,
  });
  assert.equal((await agendaHome(s)).candidates, 1);
});
test("アカウント別の更新試行・成功・回数を分け、秘密値を返さない", async () => {
  const { s } = await setup(),
    account = { id: "a" };
  await s.put("agenda:credential:a", {
    token: "old-private",
    refresh: "old-refresh",
    expires: 0,
  });
  let requests = 0;
  const send = async () => {
    requests++;
    return Response.json({ access_token: "new-private", expires_in: 3600 });
  };
  assert.equal(await agendaToken(env, s, account, send), "new-private");
  await agendaToken(env, s, account, send);
  assert.equal(requests, 1);
  let credential = await s.get("agenda:credential:a"),
    view = agendaConnectionStatus(credential);
  assert.equal(view.refresh.count, 1);
  assert.ok(view.refresh.lastSuccess);
  assert.ok(view.refresh.lastAttempt);
  assert.equal(JSON.stringify(view).includes("private"), false);
  await s.put("agenda:credential:a", { ...credential, expires: 0 });
  await assert.rejects(
    agendaToken(env, s, account, async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    ),
  );
  view = agendaConnectionStatus(await s.get("agenda:credential:a"));
  assert.equal(view.connected, false);
  assert.equal(view.refresh.count, 1);
  assert.equal(view.refresh.lastSuccess, credential.lastRefreshedAt);
  assert.ok(view.refresh.error);
  assert.equal((await s.get("agenda:credential:b")).token, "private-token");
});
