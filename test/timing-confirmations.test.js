import test from "node:test";
import assert from "node:assert/strict";
import {
  messageTimingView,
  readTimingConfirmation,
  saveTimingConfirmation,
  normalizeTimingValue,
  normalizeTimingRecords,
} from "../src/timing-confirmations.js";
import { agendaHome } from "../src/agenda-home.js";
import { extractAppointment, digest } from "../src/agenda-rules.js";
import {
  createAgendaBackup,
  agendaRestoreEntries,
} from "../src/agenda-backup.js";
import {
  clearAccountCache,
  previewAccountDeletion,
  deleteAccount,
} from "../src/agenda-management.js";
const now = Date.parse("2026-11-14T03:00:00Z");
const value = {
  kind: "deadline",
  action: "成績証明書を提出する",
  date: "2026-11-14",
  time: "17:00",
  endDate: "",
  endTime: "",
};
function memory(values = new Map()) {
  const s = {
    values,
    get: async (k) => structuredClone(values.get(k)),
    put: async (k, v) => values.set(k, structuredClone(v)),
    delete: async (k) => values.delete(k),
    list: async ({ prefix }) =>
      new Map([...values].filter(([k]) => k.startsWith(prefix))),
    transaction: async (fn) => fn(s),
  };
  return s;
}
async function setup() {
  const id = await digest("one@example.test"),
    other = await digest("other@example.test"),
    s = memory();
  const message = {
    id: "abc",
    subject: "成績証明書の提出依頼【サンプル株式会社】",
    from: "jobs@example.test",
    excerpt: "提出期限：11月15日",
    receivedAt: new Date(now).toISOString(),
  };
  message.candidate = extractAppointment(message.subject, message.excerpt);
  await s.put("agenda:accounts", [
    { id, email: "one@example.test", calendar: "primary" },
    { id: other, email: "other@example.test", calendar: "primary" },
  ]);
  await s.put("agenda:cache:" + id, {
    messages: [message],
    lastSuccess: new Date(now).toISOString(),
  });
  const target = (
    await readTimingConfirmation(s, { accountId: id, messageId: "abc" })
  ).timings[0];
  const input = {
    accountId: id,
    messageId: "abc",
    timingId: target.timingId,
    sourceRevision: target.sourceRevision,
    expectedRevision: target.revision,
    confirm: true,
    value,
  };
  return { s, id, other, message, input };
}
test("本人確定日時を保存し、再読込・ホームの優先順位へ反映する", async () => {
  const { s, id, input } = await setup();
  const before = await agendaHome(s, now);
  assert.equal(before.groups[0].priority.rank, 4);
  const saved = await saveTimingConfirmation(s, input, now);
  assert.ok(saved.timings[0].manual);
  assert.equal(
    saved.timings[0].startAt,
    Date.parse("2026-11-14T17:00:00+09:00"),
  );
  assert.equal((await agendaHome(s, now)).groups[0].priority.rank, 2);
  assert.equal(
    (await readTimingConfirmation(memory(s.values), input)).timings[0].revision,
    saved.timings[0].revision,
  );
  assert.ok(await s.get("agenda:timingConfirmations:" + id));
});
test("古いフォーム・二重送信・解除後の旧フォームを上書きさせない", async () => {
  const { s, input } = await setup();
  const first = await saveTimingConfirmation(s, input, now);
  await assert.rejects(saveTimingConfirmation(s, input, now), /別の画面/);
  const reset = await saveTimingConfirmation(
    s,
    { ...input, reset: true, expectedRevision: first.timings[0].revision },
    now + 1,
  );
  assert.equal(reset.timings[0].manual, null);
  assert.notEqual(reset.timings[0].revision, first.timings[0].revision);
  assert.equal((await agendaHome(s, now)).groups[0].priority.rank, 4);
  await assert.rejects(saveTimingConfirmation(s, input, now), /別の画面/);
});
test("メール変更・新しいメール・別宛先へ古い確定内容を転用しない", async () => {
  const { s, id, other, message, input } = await setup();
  await saveTimingConfirmation(s, input, now);
  const records = await s.get("agenda:timingConfirmations:" + id);
  const changed = { ...message, excerpt: message.excerpt + "\n追加の案内です" };
  assert.equal(
    (await messageTimingView(changed, records)).timings[0].manual,
    null,
  );
  assert.match(
    (await messageTimingView(changed, records)).notice,
    /適用していません/,
  );
  await s.put("agenda:cache:" + id, { messages: [changed] });
  await assert.rejects(saveTimingConfirmation(s, input), /元メール/);
  assert.equal(
    (await messageTimingView({ ...message, id: "def" }, records)).timings[0]
      .manual,
    null,
  );
  await assert.rejects(
    saveTimingConfirmation(s, { ...input, accountId: other }),
    /元メール/,
  );
});
test("年月日・時刻・終了範囲・明示確認をサーバーで検証する", async () => {
  for (const invalid of [
    { date: "2026-02-29" },
    { date: "11-15" },
    { time: "24:00" },
    { kind: "event", time: "" },
    { kind: "event", endDate: "2026-11-14", endTime: "16:00" },
    { kind: "event", endDate: "2026-12-01", endTime: "18:00" },
    { endTime: "18:00" },
    { action: "" },
  ])
    assert.throws(() => normalizeTimingValue({ ...value, ...invalid }));
  assert.equal(normalizeTimingValue({ ...value, time: "" }).time, "");
  const { s, input } = await setup();
  await assert.rejects(
    saveTimingConfirmation(s, { ...input, confirm: false }),
    /確認/,
  );
  await assert.rejects(
    saveTimingConfirmation(s, { ...input, timingId: "0".repeat(64) }),
    /元メール/,
  );
  const empty = await readTimingConfirmation(s, input);
  assert.equal(empty.timings[0].revision, null);
});
test("キャッシュ整理でも記録を保持し、同じメールの再取得で復旧する", async () => {
  const { s, id, message, input } = await setup();
  await saveTimingConfirmation(s, input, now);
  await clearAccountCache(s, { accountId: id, confirm: true });
  assert.ok(await s.get("agenda:timingConfirmations:" + id));
  await assert.rejects(readTimingConfirmation(s, input), /元メール/);
  await s.put("agenda:cache:" + id, { messages: [message] });
  assert.ok((await readTimingConfirmation(s, input)).timings[0].manual);
});
test("バックアップは確定を保持し、復元時の版は更新・既存記録は競合にする", async () => {
  const { s, id, input } = await setup();
  const saved = await saveTimingConfirmation(s, input, now);
  const backup = await createAgendaBackup(s);
  assert.equal(
    Object.values(backup[0].timingConfirmations)[0].value.date,
    "2026-11-14",
  );
  const target = memory();
  await target.put("agenda:accounts", await s.get("agenda:accounts"));
  const plan = await agendaRestoreEntries(target, backup);
  for (const [k, v] of plan.entries) await target.put(k, v);
  const restored = (await readTimingConfirmation(target, input)).timings[0];
  assert.ok(restored.manual);
  assert.notEqual(restored.revision, saved.timings[0].revision);
  assert.ok(
    (await agendaRestoreEntries(target, backup)).conflicts.includes(
      "agenda:timingConfirmations:" + id,
    ),
  );
  assert.throws(() =>
    normalizeTimingRecords({ ...backup[0].timingConfirmations, bad: {} }),
  );
});
test("アカウント完全削除はその確定記録も確認対象に含め、別接続は保持する", async () => {
  const { s, id, other, input } = await setup();
  await saveTimingConfirmation(s, input, now);
  await s.put("agenda:timingConfirmations:" + other, {});
  const plan = await previewAccountDeletion(s, { accountId: id }, now);
  assert.equal(plan.counts.timingConfirmations, 1);
  await deleteAccount(
    s,
    {
      accountId: id,
      email: "one@example.test",
      checksum: plan.checksum,
      confirm: true,
    },
    now,
  );
  assert.equal(await s.get("agenda:timingConfirmations:" + id), undefined);
  assert.deepEqual(await s.get("agenda:timingConfirmations:" + other), {});
});

test("変更後の再確定で同じメールの未適用記録を置換し、容量超過は拒否する", async () => {
  const { s, id, message, input } = await setup();
  await saveTimingConfirmation(s, input, now);
  await s.put("agenda:cache:" + id, {
    messages: [{ ...message, excerpt: "提出期限：11月20日" }],
  });
  const target = (await readTimingConfirmation(s, input)).timings[0];
  const saved = await saveTimingConfirmation(
    s,
    {
      ...input,
      timingId: target.timingId,
      sourceRevision: target.sourceRevision,
      expectedRevision: target.revision,
    },
    now + 1,
  );
  assert.equal(saved.notice, null);
  const records = await s.get("agenda:timingConfirmations:" + id);
  assert.equal(Object.keys(records).length, 1);
  const record = Object.values(records)[0];
  const tooMany = Object.fromEntries(
    Array.from({ length: 101 }, (_, i) => [
      "abc:" + i.toString(16).padStart(64, "0"),
      record,
    ]),
  );
  assert.throws(() => normalizeTimingRecords(tooMany), /保存件数/);
});
