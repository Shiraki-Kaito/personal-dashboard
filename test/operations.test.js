import test from "node:test";
import assert from "node:assert/strict";
import { nextRecovery } from "../src/recovery.js";
import { projectSettings, github, RemoteError } from "../src/github.js";
import { settingsFixture } from "./project-fixture.js";
import { abandonPending } from "../src/catalog.js";
import { refreshDrive } from "../src/drive.js";
import { nextAlarmAt } from "../src/scheduler.js";

function memory(entries = []) {
  const values = new Map(entries);
  return {
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => values.set(key, structuredClone(value)),
    delete: async (key) => values.delete(key),
    entries: () => structuredClone([...values]),
  };
}
function storage(entries) {
  const result = memory(entries);
  result.transaction = async (fn) => fn(result);
  return result;
}

test("一時障害の待機・上限を守り、認証と権限エラーを自動再送しない", () => {
  let previous = null;
  for (const delay of [60000, 300000, 900000]) {
    previous = nextRecovery({ code: "network" }, previous, 1000);
    assert.equal(previous.nextAt, 1000 + delay);
  }
  assert.equal(nextRecovery({ code: "network" }, previous, 1000).nextAt, null);
  assert.equal(
    nextRecovery({ code: "rate", retryAt: 9999999 }, null, 1000).nextAt,
    9999999,
  );
  for (const code of [
    "authentication",
    "permission",
    "missing",
    "configuration",
    "incomplete",
  ])
    assert.equal(nextRecovery({ code }, null, 1000), null);
});

test("再起動後も再取得予定と未確認を保持し、成功で障害予定を解消する", async () => {
  let s = storage();
  const now = Date.now();
  const env = {
    GOOGLE_CLIENT_ID: "1-fixture.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "fixture",
    DRIVE_CONFIG: JSON.stringify({ folderId: "root", includeSubfolders: true }),
  };
  const file = {
    id: "f",
    name: "File",
    folder: "Root",
    mimeType: "text/plain",
    createdTime: new Date(now).toISOString(),
    modifiedTime: new Date(now).toISOString(),
  };
  const unread = [
    { ...file, events: ["更新"], changeId: "v1", detectedAt: now },
  ];
  await s.put("drive:credential", {
    token: "fixture",
    accountFingerprint: "fixture-account",
    expires: now + 3600000,
  });
  await s.put("drive:cache", {
    scope: "root:true",
    files: [file],
    baselineAt: now,
    viewVersion: 3,
    unreadChanges: unread,
    lastSuccess: new Date(now).toISOString(),
  });
  const failed = await refreshDrive(
    env,
    s,
    async () => Response.json({}, { status: 429 }),
    now,
  );
  assert.equal(failed.errorCode, "rate");
  assert.deepEqual(failed.unreadChanges, unread.map(file=>({...file,editorNameSource:"email-unavailable"})));
  s = storage(s.entries());
  assert.equal(await nextAlarmAt(s, now), failed.recovery.nextAt);
  const recovered = await refreshDrive(
    env,
    s,
    async (url) => {
      if (new URL(url).pathname.endsWith("/root"))
        return Response.json({
          id: "root",
          name: "Root",
          mimeType: "application/vnd.google-apps.folder",
        });
      return Response.json({ files: [{ ...file, parents: ["root"] }] });
    },
    failed.recovery.nextAt,
  );
  assert.equal(recovered.error, null);
  assert.equal(recovered.recovery, null);
  assert.deepEqual(recovered.unreadChanges, unread.map(file=>({...file,editorNameSource:"email-unavailable"})));
  assert.deepEqual(
    recovered.runHistory.map((run) => [run.source, run.outcome, run.errorCode]),
    [
      ["recovery", "success", null],
      ["manual", "failure", "rate"],
    ],
  );
});

const config = {
  project: "p",
  mode: "production",
  options: [{ id: "a", name: "Todo" }],
  status_field: "s",
  due_field: "d",
};
test("状態の名前変更・追加を取得し、削除されたフィールドと選択肢では送信しない", async () => {
  const fixture = settingsFixture(config);
  fixture.node.fields.nodes[0].options = [
    { id: "a", name: "変更後" },
    { id: "new", name: "新規" },
  ];
  const settings = await projectSettings(config, async () => fixture);
  assert.equal(settings.options[0].name, "変更後");
  let mutations = 0;
  const api = github(config, async (query) => {
    if (query.startsWith("mutation")) mutations++;
    return fixture;
  });
  await assert.rejects(api.write("status", "deleted"), /削除/);
  fixture.node.fields.nodes.pop();
  await assert.rejects(api.read(), /フィールド/);
  assert.equal(mutations, 0);
});

test("Project設定のページ循環と本人以外の接続を拒否する", async () => {
  const fixture = settingsFixture(config);
  fixture.node.fields.pageInfo = { hasNextPage: true, endCursor: "repeat" };
  await assert.rejects(
    projectSettings(config, async () => fixture),
    /ページ/,
  );
  fixture.viewer.id = "other";
  await assert.rejects(
    projectSettings(config, async () => fixture),
    RemoteError,
  );
});

test("消失タスクの未同期破棄は指定した操作だけを対象にし、元サービスに書かない", async () => {
  const s = storage();
  await s.put("task:p:gone", {
    pending: { id: "operation" },
    remote: { title: "Gone" },
  });
  await assert.rejects(
    abandonPending([config], { projectId: "p", itemId: "gone", id: "old" }, s),
  );
  await assert.rejects(
    abandonPending(
      [config],
      { projectId: "other", itemId: "gone", id: "operation" },
      s,
    ),
  );
  await abandonPending(
    [config],
    { projectId: "p", itemId: "gone", id: "operation" },
    s,
  );
  assert.equal((await s.get("task:p:gone")).pending, null);
  assert.equal((await s.get("task:p:gone")).remote.title, "Gone");
  await assert.rejects(
    abandonPending(
      [config],
      { projectId: "p", itemId: "gone", id: "operation" },
      s,
    ),
  );
});
