import test from "node:test";
import assert from "node:assert/strict";
import {
  composeMeetingReports,
  saveMeeting,
  meetingView,
  normalizeMeetingStore,
} from "../src/drive-meetings.js";
import { createBackup, backupPlan, restoreBackup } from "../src/backup.js";
import { assertBackupEnvelope } from "../public/backup-format.js";
const env = {
  DRIVE_CONFIG: JSON.stringify({ folderId: "root", includeSubfolders: true }),
  PROJECT_CONFIG: JSON.stringify({
    projects: [{ project: "p", status_field: "s", due_field: "d" }],
  }),
};
const entry = (overrides = {}) => ({
  meetingDate: "2026-11-16",
  ownProgress: "SNS原稿を作成",
  ownNext: "11/18に確認依頼",
  teamProgress: "LP確認中\nデザイン完成",
  teamNext: "LP修正\n告知画像を確認",
  risks: "掲載日の確認を依頼",
  ...overrides,
});
function memory() {
  const values = new Map();
  let tail = Promise.resolve();
  const s = {
    values,
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => values.set(key, structuredClone(value)),
    list: async ({ prefix }) =>
      new Map([...values].filter(([key]) => key.startsWith(prefix))),
  };
  s.transaction = (fn) => {
    const pending = tail.then(async () => {
      const before = structuredClone(values);
      try {
        return await fn(s);
      } catch (error) {
        values.clear();
        for (const [key, value] of before) values.set(key, value);
        throw error;
      }
    });
    tail = pending.catch(() => {});
    return pending;
  };
  return s;
}
const input = (overrides = {}) => {
  const record = entry(overrides);
  return {
    ...record,
    reports: composeMeetingReports(record),
    scope: "root:true",
    expectedRevision: null,
  };
};
test("3用途で自分とチームの実績を混ぜず、短い定例文の省略と未記入を明示する", () => {
  const reports = composeMeetingReports(entry());
  assert.match(reports.personal, /SNS原稿を作成/);
  assert.doesNotMatch(reports.personal, /LP確認中/);
  assert.match(reports.organizer, /LP確認中/);
  assert.doesNotMatch(reports.organizer, /SNS原稿を作成/);
  assert.match(reports.plenary, /全体定例/);
  const long = composeMeetingReports(
    entry({ teamProgress: "あ".repeat(1000) }),
  );
  assert.ok(long.plenary.length < long.organizer.length);
  assert.match(long.plenary, /詳細はOrganizer/);
  assert.match(
    composeMeetingReports(entry({ ownProgress: "" })).personal,
    /未記入/,
  );
});
test("会議日別に保存・更新し、二重送信・並行編集・別スコープを拒否する", async () => {
  const s = memory(),
    first = await saveMeeting(s, "root:true", input());
  const proposals = await Promise.allSettled([
    saveMeeting(s, "root:true", {
      ...input(),
      expectedRevision: first.revision,
      ownProgress: "変更A",
    }),
    saveMeeting(s, "root:true", {
      ...input(),
      expectedRevision: first.revision,
      ownProgress: "変更B",
    }),
  ]);
  assert.equal(
    proposals.filter((item) => item.status === "fulfilled").length,
    1,
  );
  await assert.rejects(saveMeeting(s, "root:true", input()), /別の画面/);
  await saveMeeting(s, "root:true", input({ meetingDate: "2026-11-17" }));
  assert.equal((await meetingView(s, "root:true")).records.length, 2);
  await assert.rejects(meetingView(s, "other:true"), /別のDrive/);
  await assert.rejects(saveMeeting(s, "other:true", input()), /接続範囲/);
});
test("日付・制御文字・入力長・保存容量を検証し、失敗時は既存記録を保持する", async () => {
  const s = memory();
  await saveMeeting(s, "root:true", input());
  const before = structuredClone(s.values);
  for (const overrides of [
    { meetingDate: "2026-02-30" },
    { ownProgress: "a".repeat(1001) },
    { ownNext: "\u0000" },
    { reports: { personal: "a".repeat(6001), organizer: "", plenary: "" } },
  ])
    await assert.rejects(
      saveMeeting(s, "root:true", { ...input(), ...overrides }),
    );
  assert.deepEqual(s.values, before);
  const view = await meetingView(s, "root:true");
  assert.throws(() =>
    normalizeMeetingStore({
      scope: "root:true",
      records: Array.from({ length: 25 }, () => view.records[0]),
    }),
  );
  const records = Array.from({ length: 8 }, (_, index) => ({
    ...view.records[0],
    meetingDate: `2026-11-${String(index + 1).padStart(2, "0")}`,
    reports: {
      personal: "あ".repeat(6000),
      organizer: "あ".repeat(6000),
      plenary: "あ".repeat(6000),
    },
  }));
  assert.throws(
    () => normalizeMeetingStore({ scope: "root:true", records }),
    /96KiB/,
  );
});
test("4チームの設定だけを取り込み候補へ返し、ファイル数から実績を作らない", async () => {
  const s = memory();
  await s.put("drive:cache", {
    scope: "root:true",
    files: [
      {
        id: "file",
        folder: "集客広報 / 100_SNS運用",
        modifiedTime: "2026-11-16T00:00:00Z",
      },
    ],
    unreadChanges: [],
  });
  const view = await meetingView(s, "root:true");
  assert.equal(view.teams.length, 4);
  assert.equal(view.teams[0].status, "未設定");
  assert.equal(view.teams[0].nextAction, "");
  assert.equal(view.records.length, 0);
  assert.equal(s.values.has("drive:meetingReports"), false);
});
test("バックアップ・復元で報告の手動編集を保持し、版を更新して既存記録の上書きを拒否する", async () => {
  const s = memory(),
    original = input();
  original.reports.organizer = "手動で編集した報告文";
  await saveMeeting(s, "root:true", original);
  const backup = await createBackup(env, s);
  assertBackupEnvelope(backup);
  assert.equal(
    backup.driveMeetings.records[0].reports.organizer,
    original.reports.organizer,
  );
  const target = memory(),
    plan = await backupPlan(env, target, backup);
  assert.equal(plan.meetingReports, 1);
  await restoreBackup(env, target, backup, plan.checksum);
  const restored = (await meetingView(target, "root:true")).records[0];
  assert.notEqual(restored.revision, backup.driveMeetings.records[0].revision);
  assert.equal(restored.reports.organizer, original.reports.organizer);
  assert.ok(
    (await backupPlan(env, target, backup)).conflicts.includes(
      "drive:meetingReports",
    ),
  );
  const older = { ...backup };
  delete older.driveMeetings;
  assertBackupEnvelope(older);
  assert.equal((await backupPlan(env, memory(), older)).meetingReports, 0);
});
