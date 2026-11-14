import test from "node:test";
import assert from "node:assert/strict";
import {
  scanDrive,
  driveChanges,
  orderedDriveFiles,
  refreshDrive,
  driveView,
  acknowledgeDrive,
} from "../src/drive.js";
import { DriveError, driveClient } from "../src/drive-http.js";
import {
  googleConnect,
  driveToken,
  driveScope,
  googleAuthorizationStatus,
} from "../src/drive-auth.js";

test("Client IDの取り違えを外部送信前に拒否し、設定値を応答へ出さない", async () => {
  const invalid = { ...env, GOOGLE_CLIENT_ID: "fixture-private-value" };
  const storage = memory();
  const response = await googleConnect(
    new Request("https://unit.test/auth/google/start", { method: "POST" }),
    invalid,
    storage,
    { key: "owner" },
    () => assert.fail("外部送信は禁止"),
  );
  assert.equal(response.status, 503);
  assert.equal(
    (await response.text()).includes("fixture-private-value"),
    false,
  );
  assert.equal(await storage.get("drive:flow"), undefined);
  const view = await refreshDrive(
    invalid,
    storage,
    () => assert.fail("取得は禁止"),
    now,
  );
  assert.equal(view.configured, false);
  assert.equal(JSON.stringify(view).includes("fixture-private-value"), false);
});

const folderType = "application/vnd.google-apps.folder";
test("40フォルダを超える一覧を永続化し、再開後に全件取得を確定する", async () => {
  const storage = memory(),
    start = Date.now();
  await storage.put("drive:credential", {
    token: "fixture-token",
    accountFingerprint: "fixture-account",
    refresh: "fixture-refresh",
    expires: start + 3600000,
  });
  const send = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/root"))
      return Response.json({ id: "root", name: "Root", mimeType: folderType });
    const parent = u.searchParams.get("q").split("'")[1];
    if (parent === "root")
      return Response.json({
        files: Array.from({ length: 45 }, (_, i) => ({
          id: "folder" + i,
          name: "Folder " + i,
          mimeType: folderType,
          parents: ["root"],
        })),
      });
    return Response.json({
      files: [file("file" + parent, "2026-01-01T00:00:00Z", parent)],
    });
  };
  let result = await refreshDrive(env, storage, send, start);
  assert.equal(result.scanning, true);
  assert.equal(result.lastSuccess, null);
  assert.equal(result.files.length, 0);
  assert.equal(result.runHistory.length, 0);
  assert.equal(result.activeRun.startedAt, new Date(start).toISOString());
  assert.ok(await storage.get("drive:job"));
  let rounds = 1;
  while (result.scanning && rounds < 10) {
    result = await refreshDrive(env, storage, send, start + rounds * 3000);
    rounds++;
  }
  assert.equal(result.scanning, false);
  assert.equal(result.inventoryCount, 45);
  assert.equal(result.folderCount, 46);
  assert.ok(result.lastSuccess);
  assert.equal(result.error, null);
  assert.equal(await storage.get("drive:job"), undefined);
  assert.equal(rounds, 3);
  assert.equal(result.runHistory.length, 1);
  assert.equal(result.runHistory[0].outcome, "success");
  assert.equal(result.runHistory[0].startedAt, new Date(start).toISOString());
  assert.equal(result.activeRun, null);
});
const now = Date.parse("2026-11-11T03:00:00Z");
const config = { folderId: "root", includeSubfolders: true };
test("最終更新者は表示名だけ保存し、未取得を推測せず、過去の変更へ新しい人物を付けない", async () => {
  const result = await scanDrive(config, async (path, params) => {
    if(path === "files/root") return {id:"root",name:"Root",mimeType:folderType};
    assert.match(params.fields,/lastModifyingUser\(displayName\)/);
    return {files:[{...file("one"),lastModifyingUser:{displayName:"担当者",emailAddress:"not-needed@example.test"}},file("two")]};
  });
  assert.equal(result.files[0].lastModifiedBy,"担当者");
  assert.equal(result.files[1].lastModifiedBy,null);
  assert.equal(JSON.stringify(result).includes("not-needed"),false);
  const storage=memory();
  await storage.put("drive:cache",{scope:"root:true",files:[{...result.files[0],modifiedTime:"2026-02-01T00:00:00Z",lastModifiedBy:"別の人"}],unreadChanges:[{...result.files[0],lastModifiedBy:null}],viewVersion:3});
  const view=await driveView(env,storage,now);
  assert.equal(view.unreadChanges[0].lastModifiedBy,null);
  const cache=await storage.get("drive:cache");
  cache.files[0].modifiedTime=result.files[0].modifiedTime;
  await storage.put("drive:cache",cache);
  assert.equal((await driveView(env,storage,now)).unreadChanges[0].lastModifiedBy,"別の人");
});
const env = {
  DRIVE_CONFIG: JSON.stringify(config),
  GOOGLE_CLIENT_ID: "1234-fixture.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "fixture-secret",
};
function file(id, modifiedTime = "2026-01-01T00:00:00Z", parent = "root") {
  return {
    id,
    name: id,
    mimeType: "text/plain",
    createdTime: "2026-01-01T00:00:00Z",
    modifiedTime,
    parents: [parent],
  };
}
function memory() {
  const data = new Map();
  const store = {
    get: async (key) => structuredClone(data.get(key)),
    put: async (key, value) => data.set(key, structuredClone(value)),
    delete: async (key) => data.delete(key),
    transaction: async (callback) => callback(store),
  };
  return store;
}
test("日時の窓で除外せず、更新順で全ファイルを表示して前回との差を区別する", () => {
  const previous = [file("unchanged"), file("updated"), file("gone")];
  const current = [
    file("unchanged"),
    file("updated", "2026-11-11T03:00:00Z"),
    file("new", "2026-10-01T00:00:00Z"),
  ];
  const changes = driveChanges(previous, current, now);
  assert.deepEqual(
    changes.map((f) => [f.id, f.events]),
    [
      ["updated", ["更新"]],
      ["new", ["追加を検知"]],
      ["gone", ["対象範囲外"]],
    ],
  );
  assert.deepEqual(
    orderedDriveFiles(current).map((f) => f.id),
    ["updated", "new", "unchanged"],
  );
  const renamed = { ...current[0], name: "Changed", folder: "Other" };
  assert.deepEqual(driveChanges([current[0]], [renamed], now)[0].events, [
    "名前変更",
    "保存場所変更",
  ]);
});

test("空ページも末尾まで取得し、古いサブフォルダを再帰、ショートカット先はたどらない", async () => {
  const calls = [];
  const read = async (path, params) => {
    calls.push({ path, params });
    if (path === "files/root")
      return {
        id: "root",
        name: "Root",
        mimeType: folderType,
        driveId: "shared",
      };
    assert.equal(params.driveId, "shared");
    assert.equal(params.corpora, "drive");
    if (params.q.includes("'child'"))
      return { files: [file("nested", "2026-11-11T01:00:00Z", "child")] };
    if (!params.pageToken) return { files: [], nextPageToken: "next" };
    return {
      files: [
        { id: "child", name: "Child", mimeType: folderType, parents: ["root"] },
        {
          ...file("shortcut"),
          mimeType: "application/vnd.google-apps.shortcut",
        },
      ],
    };
  };
  const result = await scanDrive(config, read);
  assert.equal(result.folderCount, 2);
  assert.equal(result.files.length, 2);
  assert.equal(calls.length, 4);
  assert.equal(
    result.files.find((f) => f.id === "nested").folder,
    "Root / Child",
  );
});
test("直下指定、不完全検索、カーソル循環を扱う", async () => {
  const root = { id: "root", name: "Root", mimeType: folderType };
  const immediate = await scanDrive(
    { ...config, includeSubfolders: false },
    async (path) =>
      path === "files/root"
        ? root
        : {
            files: [
              {
                id: "child",
                name: "Child",
                mimeType: folderType,
                parents: ["root"],
              },
              file("direct"),
            ],
          },
  );
  assert.equal(immediate.folderCount, 1);
  assert.equal(immediate.files.length, 1);
  await assert.rejects(
    scanDrive(config, async (path) =>
      path === "files/root" ? root : { files: [], incompleteSearch: true },
    ),
    /未完了/,
  );
  await assert.rejects(
    scanDrive(config, async (path) =>
      path === "files/root" ? root : { files: [], nextPageToken: "loop" },
    ),
    /繰り返/,
  );
});
test("初回の古いファイルは追加扱いせず、次回の追加を検知、失敗時は基準を保持", async () => {
  const storage = memory();
  await storage.put("drive:credential", {
    token: "fixture-token",
    accountFingerprint: "fixture-account",
    refresh: "fixture-refresh",
    expires: Date.now() + 3600000,
  });
  let items = [file("old")],
    fail = false;
  const send = async (url) => {
    if (fail)
      return Response.json(
        { error: { errors: [{ reason: "forbidden" }] } },
        { status: 403 },
      );
    if (new URL(url).pathname.endsWith("/root"))
      return Response.json({ id: "root", name: "Root", mimeType: folderType });
    return Response.json({ files: items });
  };
  const initial = await refreshDrive(env, storage, send, now);
  assert.equal(initial.files.length, 1);
  assert.equal(initial.changes.length, 0);
  assert.equal(initial.inventoryCount, 1);
  items = [file("old"), file("new")];
  const next = await refreshDrive(env, storage, send, now + 300000);
  assert.equal(next.changes[0].id, "new");
  assert.deepEqual(next.changes[0].events, ["追加を検知"]);
  fail = true;
  const failed = await refreshDrive(env, storage, send, now + 600000);
  assert.match(failed.error, /権限/);
  assert.equal(failed.lastSuccess, next.lastSuccess);
  assert.equal(failed.inventoryCount, 2);
  const view = JSON.stringify(await driveView(env, storage, now + 600000));
  assert.equal(view.includes("fixture-token"), false);
  assert.equal(view.includes("fixture-refresh"), false);
});
test("失効時はリフレッシュし、再認可が必要なら未接続を表示", async () => {
  const storage = memory();
  await storage.put("drive:credential", {
    token: "old",
    refresh: "refresh",
    expires: 0,
  });
  assert.equal(
    await driveToken(env, storage, async () =>
      Response.json({ access_token: "renewed", expires_in: 3600 }),
    ),
    "renewed",
  );
  const credential = await storage.get("drive:credential");
  assert.equal(credential.refresh, "refresh");
  const first = (await driveView(env, storage)).authorization;
  assert.equal(first.refresh.count, 1);
  assert.ok(first.refresh.lastAttempt);
  assert.ok(first.refresh.lastSuccess);
  assert.equal(first.refresh.error, null);
  assert.ok(Date.parse(first.accessTokenExpiresAt) > Date.now());
  assert.equal(
    await driveToken(env, storage, () => assert.fail("期限内は交換しない")),
    "renewed",
  );
  await storage.put("drive:credential", { ...credential, expires: 0 });
  await assert.rejects(
    driveToken(env, storage, async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    ),
    /再接続/,
  );
  assert.equal((await driveView(env, storage, now)).connected, false);
  const failedRefresh = (await driveView(env, storage)).authorization.refresh;
  assert.equal(failedRefresh.count, 1);
  assert.equal(failedRefresh.lastSuccess, first.refresh.lastSuccess);
  assert.match(failedRefresh.error, /再接続/);
  assert.equal(JSON.stringify(failedRefresh).includes("renewed"), false);
});
test("OAuthのstateを本人セッションに結び付け、成功時も資格情報をブラウザーへ返さない", async () => {
  const storage = memory(),
    session = { key: "owner-session" };
  const start = await googleConnect(
    new Request("https://unit.test/auth/google/start", { method: "POST" }),
    env,
    storage,
    session,
  );
  assert.equal(start.status, 200);
  const auth = new URL((await start.json()).authorizationUrl);
  assert.equal(auth.searchParams.get("scope"), driveScope);
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  const callback = new Request(
    "https://unit.test/auth/google/callback?code=test&state=" +
      auth.searchParams.get("state"),
  );
  const bad = await googleConnect(
    callback,
    env,
    storage,
    { key: "other" },
    () => assert.fail(),
  );
  assert.equal(bad.status, 403);
  const good = await googleConnect(
    callback,
    env,
    storage,
    session,
    async (url) =>
      new URL(url).pathname.endsWith("/about")
        ? Response.json({ user: { permissionId: "fixture-account" } })
        : Response.json({
            access_token: "fixture-token",
            refresh_token: "fixture-refresh",
            expires_in: 3600,
            scope: driveScope,
          }),
  );
  assert.equal(good.status, 303);
  assert.equal(good.headers.get("Location"), "/");
  assert.equal(await good.text(), "");
  assert.equal(await storage.get("drive:flow"), undefined);
});
test("Driveのレート制限・認証・権限・削除を区別し、要求数の上限で部分取得を停止", async () => {
  for (const [status, code] of [
    [429, "rate"],
    [401, "authentication"],
    [403, "permission"],
    [404, "missing"],
  ]) {
    const read = driveClient("fixture", async () =>
      Response.json({}, { status }),
    );
    await assert.rejects(
      read("files", {}),
      (error) => error instanceof DriveError && error.code === code,
    );
  }
  const read = driveClient("fixture", async () => Response.json({ files: [] }));
  for (let i = 0; i < 40; i++) await read("files", {});
  await assert.rejects(read("files", {}), /取得上限/);
});

test("未確認の変更は次回取得・取得失敗・保存状態の再読込を越えて保持する", async () => {
  const s = memory();
  await s.put("drive:credential", {
    token: "fixture",
    accountFingerprint: "fixture-account",
    expires: Date.now() + 3600000,
  });
  let items = [file("first")],
    fail = false;
  const send = async (url) => {
    if (fail) return Response.json({}, { status: 403 });
    if (new URL(url).pathname.endsWith("/root"))
      return Response.json({ id: "root", name: "Root", mimeType: folderType });
    return Response.json({ files: items });
  };
  await refreshDrive(env, s, send, now);
  items = [file("first"), file("second")];
  const changed = await refreshDrive(env, s, send, now + 60000);
  assert.equal(changed.unreadChanges.length, 1);
  const unchanged = await refreshDrive(env, s, send, now + 120000);
  assert.deepEqual(unchanged.unreadChanges, changed.unreadChanges);
  fail = true;
  const failed = await refreshDrive(env, s, send, now + 180000);
  assert.ok(failed.error);
  assert.deepEqual(failed.unreadChanges, changed.unreadChanges);
  const restarted = memory();
  await restarted.put("drive:cache", await s.get("drive:cache"));
  const loaded = await driveView(env, restarted);
  assert.deepEqual(loaded.unreadChanges, changed.unreadChanges);
  const acknowledged = await acknowledgeDrive(
    env,
    restarted,
    loaded.unreadChanges,
  );
  assert.equal(acknowledged.unreadChanges.length, 0);
  assert.equal(acknowledged.acknowledged, 1);
  assert.equal(acknowledged.files.length, 2);
  assert.equal((await driveView(env, restarted)).unreadChanges.length, 0);
});

test("公開だけでは既存のテスト時認可を長期接続済みにしない", () => {
  const published = { GOOGLE_OAUTH_PUBLISHING_STATUS: "published" };
  const legacy = { connectedAt: Date.parse("2026-11-11T03:16:00Z") };
  const old = googleAuthorizationStatus(published, legacy);
  assert.equal(old.requiresReauthorization, true);
  assert.equal(old.grantedPublishingStatus, "testing");
  assert.equal(old.reviewAt, "2026-11-18T03:16:00.000Z");
  const current = { ...legacy, grantedPublishingStatus: "published" };
  assert.equal(
    googleAuthorizationStatus(published, current).requiresReauthorization,
    false,
  );
  assert.equal(googleAuthorizationStatus(published, current).reviewAt, null);
  assert.equal(
    googleAuthorizationStatus(published, { ...current, invalid: true })
      .requiresReauthorization,
    true,
  );
  assert.equal(
    googleAuthorizationStatus(published, null).requiresReauthorization,
    false,
  );
});

test("新しい認可には開始時の公開設定を記録し、途中の設定変更で昇格させない", async () => {
  const session = { key: "owner-session" };
  for (const mode of ["testing", "published"]) {
    const storage = memory();
    const initialEnv = { ...env, GOOGLE_OAUTH_PUBLISHING_STATUS: mode };
    const start = await googleConnect(
      new Request("https://unit.test/auth/google/start", { method: "POST" }),
      initialEnv,
      storage,
      session,
    );
    const state = new URL(
      (await start.json()).authorizationUrl,
    ).searchParams.get("state");
    const callbackEnv = { ...env, GOOGLE_OAUTH_PUBLISHING_STATUS: "published" };
    const result = await googleConnect(
      new Request(
        "https://unit.test/auth/google/callback?code=fixture&state=" + state,
      ),
      callbackEnv,
      storage,
      session,
      async (url) =>
        new URL(url).pathname.endsWith("/about")
          ? Response.json({ user: { permissionId: "fixture-account" } })
          : Response.json({
              access_token: "fixture",
              refresh_token: "fixture-refresh",
              expires_in: 3600,
              scope: driveScope,
            }),
    );
    assert.equal(result.status, 303);
    const credential = await storage.get("drive:credential");
    assert.equal(credential.grantedPublishingStatus, mode);
    const view = await driveView(callbackEnv, storage);
    assert.equal(
      view.authorization.requiresReauthorization,
      mode === "testing",
    );
    assert.equal(JSON.stringify(view).includes("fixture-refresh"), false);
  }
});
