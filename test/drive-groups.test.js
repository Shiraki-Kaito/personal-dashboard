import test from "node:test";
import assert from "node:assert/strict";
import {
  groupView,
  saveDriveGroup,
  defaultGroupColor,
  normalizeGroupStore,
} from "../src/drive-groups.js";
import { createBackup, backupPlan, restoreBackup } from "../src/backup.js";
import { assertBackupEnvelope } from "../public/backup-format.js";
const file = (id, folder) => ({
  id,
  folder,
  name: id,
  mimeType: "text/plain",
  modifiedTime: "2026-11-15T00:00:00Z",
  createdTime: "2026-11-14T00:00:00Z",
  lastModifiedBy: "担当者",
});
function memory() {
  const data = new Map([
    [
      "drive:cache",
      {
        scope: "root:true",
        files: [
          file("a", "チーム / SNS / 投稿"),
          file("b", "チーム / LP"),
          file("private", "チーム / SNS / 個人作業"),
        ],
        unreadChanges: [],
      },
    ],
  ]);
  let pending = Promise.resolve();
  const storage = {
    get: async (key) => structuredClone(data.get(key)),
    put: async (key, value) => data.set(key, structuredClone(value)),
    list: async ({ prefix }) =>
      new Map([...data].filter(([key]) => key.startsWith(prefix))),
  };
  storage.transaction = (callback) => {
    const result = pending.then(() => callback(storage));
    pending = result.catch(() => {});
    return result;
  };
  return storage;
}
const input = () => ({
  scope: "root:true",
  path: "チーム / SNS",
  expectedRevision: null,
  name: "SNSチーム",
  color: "rose",
  status: "進行中",
  nextAction: "投稿案を確認",
  due: "2026-11-20",
});
test("保存場所で分け、個人作業を除外して更新者を残し、進捗を推測しない", async () => {
  assert.deepEqual(groupView(null, undefined), []);
  const s = memory(),
    groups = groupView(await s.get("drive:cache"));
  assert.equal(groups.length, 2);
  const sns = groups.find((group) => group.path.endsWith("SNS"));
  assert.equal(sns.recent.length, 1);
  assert.equal(sns.recent[0].lastModifiedBy, "担当者");
  assert.equal(sns.status, "未設定");
  assert.equal(sns.color, defaultGroupColor(sns.path));
});
test("色・表示名・進捗を保存し、再読込と範囲外移動後も記録を保持する", async () => {
  const s = memory();
  await saveDriveGroup(s, input());
  let saved = await s.get("drive:groups");
  let view = groupView(await s.get("drive:cache"), saved).find(
    (group) => group.name === "SNSチーム",
  );
  assert.equal(view.color, "rose");
  assert.equal(view.status, "進行中");
  assert.equal(view.nextAction, "投稿案を確認");
  assert.equal(
    groupView({ scope: "root:true", files: [] }, saved)[0].available,
    false,
  );
  assert.deepEqual(groupView({ scope: "other:true", files: [] }, saved), []);
});
test("二重保存と古いフォームを拒否し、新しいグループ記録を上書きしない", async () => {
  const s = memory();
  const results = await Promise.allSettled([
    saveDriveGroup(s, input()),
    saveDriveGroup(s, input()),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const saved = (await s.get("drive:groups")).records[0];
  await assert.rejects(saveDriveGroup(s, input()), /別の画面/);
  await saveDriveGroup(s, {
    ...input(),
    expectedRevision: saved.revision,
    color: "blue",
  });
  assert.equal((await s.get("drive:groups")).records[0].color, "blue");
});
test("不正な色・日付・過大入力・対象外や個人作業のグループを拒否する", async () => {
  for (const change of [
    { color: "url(evil)" },
    { due: "2026-02-30" },
    { nextAction: "a".repeat(501) },
    { path: "チーム / 不明" },
    { scope: "other:true" },
    { path: "チーム / SNS / 個人作業" },
  ])
    await assert.rejects(saveDriveGroup(memory(), { ...input(), ...change }));
  assert.throws(() =>
    normalizeGroupStore({ scope: "root:true", records: Array(81).fill({}) }),
  );
});
test("バックアップに色と進捗を含め、復元後の旧版保存・既存設定の上書きを防ぐ", async () => {
  const s = memory();
  await saveDriveGroup(s, input());
  const env = {
    PROJECT_CONFIG: JSON.stringify({
      projects: [{ project: "p", status_field: "s", due_field: "d" }],
    }),
    DRIVE_CONFIG: JSON.stringify({ folderId: "root", includeSubfolders: true }),
  };
  const backup = await createBackup(env, s);
  assertBackupEnvelope(backup);
  assert.equal(backup.driveGroups.records[0].color, "rose");
  const empty = memory();
  await empty.put("drive:cache", undefined);
  const plan = await backupPlan(env, empty, backup);
  assert.deepEqual(plan.conflicts, []);
  await restoreBackup(env, empty, backup, plan.checksum);
  const restored = await empty.get("drive:groups");
  assert.notEqual(
    restored.records[0].revision,
    backup.driveGroups.records[0].revision,
  );
  await assert.rejects(
    saveDriveGroup(empty, {
      ...input(),
      expectedRevision: backup.driveGroups.records[0].revision,
    }),
    /別の画面/,
  );
  assert.ok(
    (await backupPlan(env, empty, backup)).conflicts.includes("drive:groups"),
  );
});
