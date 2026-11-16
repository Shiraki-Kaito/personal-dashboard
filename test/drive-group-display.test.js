import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultGroupVisible,
  groupDisplayView,
  saveGroupDisplay,
  normalizeGroupDisplay,
} from "../src/drive-group-display.js";
import { groupView } from "../src/drive-groups.js";
import { driveView } from "../src/drive.js";
import { createBackup, backupPlan, restoreBackup } from "../src/backup.js";
import { assertBackupEnvelope } from "../public/backup-format.js";
const root = "07_集客広報",
  names = [
    root,
    "000_Meeting",
    "001_確定文書",
    "100_SNS運用",
    "200_LP",
    "300_コミュニティ連携",
    "400_デザイン",
    "500_クラウドファンディング",
  ];
const cache = {
  scope: "root:true",
  files: names.map((name, index) => ({
    id: String(index),
    name: "File" + index,
    mimeType: "text/plain",
    folder: name === root ? root : root + " / " + name,
    createdTime: "2026-11-12T00:00:00Z",
    modifiedTime: "2026-11-16T00:00:00Z",
  })),
  unreadChanges: [],
  lastSuccess: "2026-11-16T00:00:00Z",
};
const env = {
  DRIVE_CONFIG: JSON.stringify({ folderId: "root", includeSubfolders: true }),
  PROJECT_CONFIG: JSON.stringify({
    projects: [{ project: "p", status_field: "s", due_field: "d" }],
  }),
};
function memory(seed = true) {
  const values = new Map(seed ? [["drive:cache", cache]] : []);
  let tail = Promise.resolve();
  const s = {
    values,
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => values.set(key, structuredClone(value)),
    list: async ({ prefix }) =>
      new Map([...values].filter(([key]) => key.startsWith(prefix))),
  };
  s.transaction = (fn) => {
    const job = tail.then(async () => {
      const before = structuredClone(values);
      try {
        return await fn(s);
      } catch (error) {
        values.clear();
        for (const [key, value] of before) values.set(key, value);
        throw error;
      }
    });
    tail = job.catch(() => {});
    return job;
  };
  return s;
}
const input = (overrides = [], expectedRevision = null) => ({
  scope: "root:true",
  overrides,
  expectedRevision,
});
test("既定は100〜400の4チームだけで、ルート・Meeting・確定文書は表示しない", async () => {
  const s = memory(),
    view = await driveView(env, s);
  assert.deepEqual(
    view.groupDisplay.groups
      .filter((group) => group.visible)
      .map((group) => group.name),
    names.slice(3, 7),
  );
  assert.equal(defaultGroupVisible(root + " / １００_SNS運用"), true);
  assert.equal(view.groups.length, 8);
  assert.equal(view.files.length, 8);
});
test("表示と非表示を保存し、再取得後も保持するがファイル・未確認・進捗は変更しない", async () => {
  const s = memory(),
    before = structuredClone(s.values),
    overrides = [
      { path: root + " / 000_Meeting", visible: true },
      { path: root + " / 100_SNS運用", visible: false },
    ];
  const saved = await saveGroupDisplay(s, "root:true", input(overrides));
  const view = await driveView(env, s);
  assert.equal(view.groupDisplay.revision, saved.revision);
  assert.equal(
    view.groupDisplay.groups.find((group) => group.path.endsWith("000_Meeting"))
      .visible,
    true,
  );
  assert.equal(
    view.groupDisplay.groups.find((group) => group.path.endsWith("100_SNS運用"))
      .visible,
    false,
  );
  assert.deepEqual(await s.get("drive:cache"), before.get("drive:cache"));
  assert.equal(s.values.size, before.size + 1);
  await saveGroupDisplay(s, "root:true", input([], saved.revision));
  assert.equal(
    (await driveView(env, s)).groupDisplay.groups.filter(
      (group) => group.visible,
    ).length,
    4,
  );
});
test("古い版・二重送信・並行編集・別範囲・対象外・不正入力を上書きせず拒否する", async () => {
  const s = memory();
  const results = await Promise.allSettled([
    saveGroupDisplay(s, "root:true", input()),
    saveGroupDisplay(s, "root:true", input()),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const saved = await s.get("drive:groupDisplay"),
    before = structuredClone(s.values);
  for (const request of [
    input(),
    { ...input([], saved.revision), scope: "other:true" },
    input([{ path: "outside", visible: true }], saved.revision),
    input([{ path: root, visible: "yes" }], saved.revision),
  ])
    await assert.rejects(saveGroupDisplay(s, "root:true", request));
  assert.deepEqual(s.values, before);
  assert.throws(() =>
    normalizeGroupDisplay({
      ...saved,
      overrides: Array(129).fill({ path: root, visible: true }),
    }),
  );
});
test("新しく見つかったグループの既定と、現在範囲外の保存設定を混同しない", () => {
  const saved = normalizeGroupDisplay({
    scope: "root:true",
    revision: crypto.randomUUID(),
    overrides: [
      { path: root + " / 500_クラウドファンディング", visible: true },
    ],
  });
  const groups = groupView(cache, null);
  assert.equal(
    groupDisplayView("other:true", groups, saved).groups.find((group) =>
      group.path.endsWith("500_クラウドファンディング"),
    ).visible,
    false,
  );
  assert.equal(
    groupDisplayView("root:true", groups, saved).groups.find((group) =>
      group.path.endsWith("400_デザイン"),
    ).visible,
    true,
  );
});
test("表示設定をバックアップへ含め、復元時に版を更新して既存設定の上書きを拒否する", async () => {
  const s = memory(),
    saved = await saveGroupDisplay(
      s,
      "root:true",
      input([{ path: root, visible: true }]),
    );
  const backup = await createBackup(env, s);
  assertBackupEnvelope(backup);
  assert.deepEqual(backup.driveGroupDisplay, saved);
  const target = memory(false),
    plan = await backupPlan(env, target, backup);
  await restoreBackup(env, target, backup, plan.checksum);
  assert.notEqual(
    (await target.get("drive:groupDisplay")).revision,
    saved.revision,
  );
  assert.deepEqual(
    (await target.get("drive:groupDisplay")).overrides,
    saved.overrides,
  );
  assert.ok(
    (await backupPlan(env, target, backup)).conflicts.includes(
      "drive:groupDisplay",
    ),
  );
});
