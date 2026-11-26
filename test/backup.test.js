import test from "node:test";
import assert from "node:assert/strict";
import { createBackup, backupPlan, restoreBackup } from "../src/backup.js";
import {encryptBackup,decryptBackup} from '../public/backup-crypto.js';
const env = {
  PROJECT_CONFIG: JSON.stringify({
    projects: [
      { project: "p", item: "task", status_field: "s", due_field: "d" },
    ],
  }),
  DRIVE_CONFIG: JSON.stringify({ folderId: "root", includeSubfolders: true }),
};
function memory() {
  const values = new Map();
  const s = {
    get: async (key) => {
      if (/credential|session|flow/.test(key))
        throw Error("資格情報を読まない");
      return structuredClone(values.get(key));
    },
    put: async (key, value) => values.set(key, structuredClone(value)),
    list: async ({ prefix }) =>
      new Map([...values].filter(([key]) => key.startsWith(prefix))),
    transaction: async (fn) => fn(s),
  };
  return s;
}
async function fixture() {
  const s = memory();
  const remote = {
    title: "Task",
    status: "a",
    due: null,
    revision: "1",
    total: 1,
  };
  await s.put("task:p:task", {
    remote,
    pending: { id: "op", field: "status", value: "b", base: remote },
    lastSuccess: "2026-11-12T00:00:00Z",
    error: "fixture-private-value",
  });
  const file = {
    id: "f",
    name: "File",
    mimeType: "text/plain",
    folder: "Root",
    createdTime: "2026-11-12T00:00:00Z",
    modifiedTime: "2026-11-12T00:00:00Z",
    lastModifiedBy: "検証担当者", lastModifiedEmail: "member@example.test",
  };
  await s.put("drive:cache", {
    scope: "root:true",
    files: [file],
    unreadChanges: [
      {
        ...file,
        changeId: "v1",
        events: ["更新"],
        detectedAt: 1000,
        occurrences: 2,
      },
    ],
    baselineAt: 1000,
    viewVersion: 3,
  });
  return s;
}
test("資格情報を読まず、未同期と未確認を選んでバックアップする", async () => {
  const source = await fixture(),
    backup = await createBackup(env, source);
  assert.equal(backup.tasks.length, 1);
  assert.equal(backup.drive.unreadChanges[0].occurrences, 2);
  assert.equal(backup.drive.files[0].lastModifiedBy, "検証担当者");
  assert.equal(JSON.stringify(backup).includes("fixture-private-value"), false);
});

test('暗号化保存から復号・プレビュー・空保存先への復元まで元APIの保護を維持する',async(t)=>{
  const start=performance.now();
  const backup=await createBackup(env,await fixture());
  const password='fixture-only-long-passphrase-2026';
  const envelope=await encryptBackup(JSON.stringify(backup),password);
  const reopened=JSON.parse(JSON.stringify(envelope));
  const candidate=JSON.parse(await decryptBackup(reopened,password));
  const target=memory();
  const plan=await backupPlan(env,target,candidate);
  assert.equal(plan.conflicts.length,0);
  assert.equal((await restoreBackup(env,target,candidate,plan.checksum)).restored,2);
  assert.equal((await target.get('drive:cache')).files[0].name,'File');
  assert.match((await target.get('task:p:task')).phase,/再照合待ち/);
  await assert.rejects(restoreBackup(env,target,candidate,plan.checksum));
  t.diagnostic('架空データの暗号化→復元所要時間(ms): '+Math.round(performance.now()-start));
});
test("空の保存先だけに復元し、既存データ・競合・確認後の変更を上書きしない", async () => {
  const backup = await createBackup(env, await fixture()),
    target = memory();
  const plan = await backupPlan(env, target, backup);
  assert.deepEqual(plan.conflicts, []);
  await assert.rejects(restoreBackup(env, target, backup, "old"));
  assert.equal(await target.get("drive:cache"), undefined);
  assert.equal(
    (await restoreBackup(env, target, backup, plan.checksum)).restored,
    2,
  );
  const restored = await target.get("task:p:task");
  assert.equal((await target.get("drive:cache")).files[0].lastModifiedBy, "検証担当者");
  assert.equal((await target.get("drive:cache")).files[0].lastModifiedEmail, "member@example.test");
  assert.equal(restored.pending.id, "op");
  assert.match(restored.phase, /再照合待ち/);
  assert.equal(
    (await target.get("drive:cache")).unreadChanges[0].changeId,
    "v1",
  );
  await assert.rejects(restoreBackup(env, target, backup, plan.checksum));
  assert.deepEqual(await target.get("task:p:task"), restored);
});
test("別人・別対象・不正日付を拒否し、任意キーを保存しない", async () => {
  const backup = await createBackup(env, await fixture()),
    target = memory();
  await assert.rejects(
    backupPlan(env, target, { ...backup, ownerId: "other" }),
  );
  await assert.rejects(
    backupPlan(
      {
        ...env,
        DRIVE_CONFIG: JSON.stringify({
          folderId: "other",
          includeSubfolders: true,
        }),
      },
      target,
      backup,
    ),
  );
  const invalid = structuredClone(backup);
  invalid.tasks[0].pending = {
    ...invalid.tasks[0].pending,
    field: "due",
    value: "2026-99-99",
  };
  await assert.rejects(backupPlan(env, target, invalid), /形式/);
  backup.tasks[0].remote.token = "fixture-secret";
  const plan = await backupPlan(env, target, backup);
  await restoreBackup(env, target, backup, plan.checksum);
  assert.equal(
    JSON.stringify(await target.get("task:p:task")).includes("fixture-secret"),
    false,
  );
});
