import { previewAccountDeletion, deleteAccount } from "../src/agenda-management.js";
import test from "node:test";
import assert from "node:assert/strict";
import { agendaConnect, agendaScopes } from "../src/agenda-google.js";
import { digest } from "../src/agenda-rules.js";
const env = {
  GOOGLE_CLIENT_ID: "1-fixture.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "fixture",
};
function memory() {
  const values = new Map();
  const s = {
    get: async (k) => structuredClone(values.get(k)),
    put: async (k, v) => values.set(k, structuredClone(v)),
    delete: async (k) => values.delete(k),
    list: async ({prefix}) => new Map([...values].filter(([key])=>key.startsWith(prefix))),
    transaction: async (fn) => fn(s),
  };
  return s;
}
const start = (s, label) =>
  agendaConnect(
    new Request("https://dashboard.test/auth/agenda/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    }),
    env,
    s,
    { key: "owner" },
  );
function upstream(email, role = "owner") {
  return async (url) =>
    String(url).includes("/profile")
      ? Response.json({ emailAddress: email })
      : String(url).includes("/events")
        ? Response.json({ accessRole: role })
        : Response.json({
            access_token: "fixture-access",
            refresh_token: "fixture-refresh",
            expires_in: 3600,
            scope: agendaScopes.join(" "),
          });
}
async function callback(s, email, role = "owner") {
  const flow = await s.get("agenda:flow");
  return agendaConnect(
    new Request(
      "https://dashboard.test/auth/google/callback?code=fixture&state=" +
        flow.state,
    ),
    env,
    s,
    { key: "owner" },
    upstream(email, role),
  );
}
test("サイトで入力した名前を認可完了後に保存し、対象アカウントへ戻す", async () => {
  const s = memory(),
    label = "カンファレンス",
    begin = await start(s, label),
    auth = new URL((await begin.json()).authorizationUrl);
  assert.equal(auth.searchParams.has("label"), false);
  assert.equal(auth.href.includes(encodeURIComponent(label)), false);
  const id = await digest("new@example.test");
  assert.equal(await s.get("agenda:label:" + id), undefined);
  const response = await callback(s, "new@example.test");
  assert.equal(response.status, 303);
  const destination = new URL(
    response.headers.get("Location"),
    "https://dashboard.test",
  );
  assert.equal(destination.origin, "https://dashboard.test");
  assert.equal(destination.searchParams.get("accountId"), id);
  assert.equal(destination.searchParams.get("view"), "agenda");
  assert.equal(await s.get("agenda:label:" + id), label);
  assert.equal(await s.get("agenda:flow"), undefined);
});
test("認可取消・権限不足では名前も接続も保存しない", async () => {
  for (const cancelled of [true, false]) {
    const s = memory();
    await start(s, "private");
    const flow = await s.get("agenda:flow");
    const response = cancelled
      ? await agendaConnect(
          new Request(
            "https://dashboard.test/auth/google/callback?error=access_denied&state=" +
              flow.state,
          ),
          env,
          s,
          { key: "owner" },
          () => assert.fail(),
        )
      : await callback(s, "new@example.test", "reader");
    assert.equal(response.status, cancelled ? 400 : 503);
    assert.match(await response.text(), /アカウント管理へ戻ってやり直す/);
    assert.equal(await s.get("agenda:accounts"), undefined);
    assert.equal(
      await s.get("agenda:label:" + (await digest("new@example.test"))),
      undefined,
    );
  }
});
test("再接続では既存名・他の接続を保持し、空名だけ初期設定できる", async () => {
  const s = memory(),
    email = "existing@example.test",
    id = await digest(email);
  await s.put("agenda:accounts", [
    { id, email, calendar: "primary", disconnectedAt: "2026-11-12T00:00:00Z" },
    { id: "other", email: "other@example.test" },
  ]);
  await s.put("agenda:label:" + id, "就活");
  await s.put("agenda:credential:other", { token: "fixture-other" });
  await start(s, "private");
  assert.equal((await callback(s, email)).status, 303);
  assert.equal(await s.get("agenda:label:" + id), "就活");
  assert.equal((await s.get("agenda:accounts")).find(a => a.id === id).disconnectedAt, undefined);
  assert.ok(await s.get("agenda:credential:" + id));
  assert.equal((await s.get("agenda:credential:other")).token, "fixture-other");
  await s.put("agenda:label:" + id, "");
  await start(s, "private");
  await callback(s, email);
  assert.equal(await s.get("agenda:label:" + id), "private");
});
test("不正な名前・別セッション・接続上限をサーバーで拒否する", async () => {
  for (const label of ["x".repeat(41), "bad\nname", 42]) {
    const s = memory();
    assert.equal((await start(s, label)).status, 400);
    assert.equal(await s.get("agenda:flow"), undefined);
  }
  const s = memory();
  await start(s, "就活");
  const flow = await s.get("agenda:flow");
  assert.equal(
    (
      await agendaConnect(
        new Request(
          "https://dashboard.test/auth/google/callback?code=fixture&state=" +
            flow.state,
        ),
        env,
        s,
        { key: "other" },
        () => assert.fail(),
      )
    ).status,
    403,
  );
  await s.put(
    "agenda:accounts",
    Array.from({ length: 5 }, (_, i) => ({
      id: "existing" + i,
      email: "old" + i + "@example.test",
    })),
  );
  assert.equal((await callback(s, "sixth@example.test")).status, 503);
  assert.equal((await s.get("agenda:accounts")).length, 5);
  assert.equal(
    await s.get("agenda:label:" + (await digest("sixth@example.test"))),
    undefined,
  );
});

test("上限5件から完全削除で枠を空け、新しいGoogleアカウントを認可できる", async () => {
  const s = memory();
  const accounts = await Promise.all(Array.from({length:5},async(_,index)=>{
    const email = `old${index}@example.test`;
    return {id:await digest(email),email,calendar:"primary"};
  }));
  await s.put("agenda:accounts",accounts);
  const account=accounts[0];
  await s.put("agenda:label:"+account.id,"削除する表示名");
  const plan=await previewAccountDeletion(s,{accountId:account.id});
  await deleteAccount(s,{accountId:account.id,email:account.email,checksum:plan.checksum,confirm:true});
  assert.equal((await s.get("agenda:accounts")).length,4);
  await start(s,"新しい接続");
  assert.equal((await callback(s,"replacement@example.test")).status,303);
  assert.equal((await s.get("agenda:accounts")).length,5);
  assert.equal((await s.get("agenda:accounts")).some(a=>a.id===account.id),false);
  assert.equal(await s.get("agenda:label:"+account.id),undefined);
});
