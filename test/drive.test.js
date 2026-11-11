import test from "node:test";
import assert from "node:assert/strict";
import {
  scanDrive,
  recentFiles,
  recentWindowMs,
  refreshDrive,
  driveView,
} from "../src/drive.js";
import { DriveError, driveClient } from "../src/drive-http.js";
import { googleConnect, driveToken, driveScope } from "../src/drive-auth.js";

const folderType = "application/vnd.google-apps.folder";
const now = Date.parse("2026-11-11T03:00:00Z");
const config = { folderId: "root", includeSubfolders: true };
const env = {
  DRIVE_CONFIG: JSON.stringify(config),
  GOOGLE_CLIENT_ID: "fixture-id",
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
test("12時間の境界、未来の日時、作成・更新・追加検知を区別する", () => {
  const values = [
    {
      ...file("boundary"),
      modifiedTime: new Date(now - recentWindowMs).toISOString(),
    },
    {
      ...file("old"),
      modifiedTime: new Date(now - recentWindowMs - 1).toISOString(),
    },
    { ...file("added"), observedAddedAt: now - 1000 },
    { ...file("future"), modifiedTime: new Date(now + 1).toISOString() },
  ];
  const result = recentFiles(values, now);
  assert.deepEqual(
    result.map((f) => f.id),
    ["added", "boundary"],
  );
  assert.deepEqual(result[0].events, ["追加を検知"]);
  assert.equal(
    recentFiles(values, now + recentWindowMs + 1).some((f) => f.id === "added"),
    false,
  );
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
  assert.equal(initial.files.length, 0);
  assert.equal(initial.inventoryCount, 1);
  items = [file("old"), file("new")];
  const next = await refreshDrive(env, storage, send, now + 300000);
  assert.equal(next.files[0].id, "new");
  assert.deepEqual(next.files[0].events, ["追加を検知"]);
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
  await storage.put("drive:credential", { ...credential, expires: 0 });
  await assert.rejects(
    driveToken(env, storage, async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    ),
    /再接続/,
  );
  assert.equal((await driveView(env, storage, now)).connected, false);
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
  const auth = new URL(start.headers.get("Location"));
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
  const good = await googleConnect(callback, env, storage, session, async () =>
    Response.json({
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
