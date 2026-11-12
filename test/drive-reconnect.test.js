import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureDriveAccount,
  googleConnect,
  googleAuthorizationStatus,
  driveScope,
} from "../src/drive-auth.js";
const env = {
  GOOGLE_CLIENT_ID: "1-fixture.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "fixture-secret",
  GOOGLE_OAUTH_PUBLISHING_STATUS: "published",
};
const session = { key: "owner" };
function memory() {
  const data = new Map();
  const s = {
    get: async (key) => structuredClone(data.get(key)),
    put: async (key, value) => data.set(key, structuredClone(value)),
    delete: async (key) => data.delete(key),
    transaction: async (fn) => fn(s),
  };
  return s;
}
async function connect(storage, identity = "account-one", fail = false) {
  const result = await googleConnect(
    new Request("https://unit.test/auth/google/start", { method: "POST" }),
    env,
    storage,
    session,
  );
  const state = new URL(
    (await result.json()).authorizationUrl,
  ).searchParams.get("state");
  return googleConnect(
    new Request(
      "https://unit.test/auth/google/callback?code=fixture&state=" + state,
    ),
    env,
    storage,
    session,
    async (url) =>
      new URL(url).pathname.endsWith("/about")
        ? Response.json(
            { user: { permissionId: identity } },
            { status: fail ? 403 : 200 },
          )
        : Response.json({
            access_token: "new-token",
            refresh_token: "new-refresh",
            expires_in: 3600,
            scope: driveScope,
          }),
  );
}
async function setup() {
  const s = memory();
  await s.put("drive:credential", {
    token: "old-token",
    refresh: "old-refresh",
    expires: Date.now() + 3600000,
  });
  await ensureDriveAccount(s, "old-token", async () =>
    Response.json({ user: { permissionId: "account-one" } }),
  );
  await s.put("drive:cache", {
    files: [{ id: "file" }],
    unreadChanges: [{ id: "file", changeId: "version" }],
    lastSuccess: "2026-11-12T03:01:05.769Z",
  });
  return s;
}
test("既存接続を照合し、識別子と資格情報は表示用メタデータへ返さない", async () => {
  const s = await setup(),
    credential = await s.get("drive:credential");
  assert.match(credential.accountFingerprint, /^[0-9a-f]{64}$/);
  await ensureDriveAccount(s, "old-token", () =>
    assert.fail("照合済みなら再取得しない"),
  );
  const view = googleAuthorizationStatus(env, credential);
  assert.equal(view.accountVerified, true);
  for (const value of [
    "account-one",
    credential.accountFingerprint,
    "old-token",
    "old-refresh",
  ])
    assert.equal(JSON.stringify(view).includes(value), false);
});
test("失効した同一アカウントの再認可で未確認を保持し、再取得予定を保存する", async () => {
  const s = await setup(),
    before = await s.get("drive:cache");
  await s.put("drive:credential", {
    ...(await s.get("drive:credential")),
    invalid: true,
  });
  await s.put("drive:job", { partial: true });
  assert.equal((await connect(s)).status, 303);
  const after = await s.get("drive:cache");
  assert.deepEqual(after.files, before.files);
  assert.deepEqual(after.unreadChanges, before.unreadChanges);
  assert.equal(after.lastSuccess, before.lastSuccess);
  assert.equal(after.errorCode, "reauthorized");
  assert.equal((await s.get("drive:credential")).invalid, undefined);
  assert.ok((await s.get("drive:recovery")).nextAt > Date.now());
  assert.equal(await s.get("drive:job"), undefined);
});
test("別アカウント・照合失敗では、古い資格情報と未確認を変更しない", async () => {
  for (const [identity, fail] of [
    ["account-two", false],
    ["account-one", true],
  ]) {
    const s = await setup(),
      credential = await s.get("drive:credential"),
      cache = await s.get("drive:cache");
    assert.equal((await connect(s, identity, fail)).status, 503);
    assert.deepEqual(await s.get("drive:credential"), credential);
    assert.deepEqual(await s.get("drive:cache"), cache);
  }
});
test("本人照合がない旧キャッシュを、再認可した別の接続へ勝手に結び付けない", async () => {
  const s = memory();
  await s.put("drive:credential", { token: "old-token" });
  await s.put("drive:cache", {
    files: [{ id: "file" }],
    unreadChanges: [{ changeId: "v" }],
  });
  assert.equal((await connect(s)).status, 503);
  assert.equal((await s.get("drive:cache")).unreadChanges.length, 1);
  assert.equal((await s.get("drive:credential")).token, "old-token");
});
test("照合中に接続が変わった場合は、新しい接続を古い照合で上書きしない", async () => {
  const s = memory();
  await s.put("drive:credential", { token: "old-token" });
  await assert.rejects(
    ensureDriveAccount(s, "old-token", async () => {
      await s.put("drive:credential", { token: "another-token" });
      return Response.json({ user: { permissionId: "account-one" } });
    }),
    /変更されています/,
  );
  assert.deepEqual(await s.get("drive:credential"), { token: "another-token" });
});
