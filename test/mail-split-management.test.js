import test from "node:test";
import assert from "node:assert/strict";
import {
  agendaHome,
  saveAgendaCase,
  saveAgendaSplit,
  manageAgendaSplit,
} from "../src/agenda-home.js";
import { digest, extractAppointment } from "../src/agenda-rules.js";
import {
  createAgendaBackup,
  agendaRestoreEntries,
} from "../src/agenda-backup.js";
import {
  clearAccountCache,
  deleteAccount,
  previewAccountDeletion,
} from "../src/agenda-management.js";
const now = Date.parse("2026-11-16T03:00:00Z");
function memory(values = new Map()) {
  const s = {
    values,
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => values.set(key, structuredClone(value)),
    delete: async (key) => values.delete(key),
    list: async ({ prefix }) =>
      new Map([...values].filter(([key]) => key.startsWith(prefix))),
    transaction: async (fn) => fn(s),
  };
  return s;
}
async function setup() {
  const s = memory(),
    accounts = await Promise.all(
      ["one@example.test", "two@example.test"].map(async (email) => ({
        id: await digest(email),
        email,
        calendar: "primary",
      })),
    );
  await s.put("agenda:accounts", accounts);
  for (const account of accounts)
    await s.put("agenda:cache:" + account.id, {
      lastSuccess: new Date(now).toISOString(),
      messages: ["1", "2"].map((id) => {
        const subject =
            (id === "1" ? "面接日程の確認" : "成績証明書の提出依頼") +
            "【検証株式会社】",
          excerpt = "2026年11月18日 10:00〜11:00です。ご返信ください。";
        return {
          id,
          subject,
          excerpt,
          from: "jobs@example.test",
          receivedAt: new Date(now).toISOString(),
          candidate: extractAppointment(subject, excerpt),
        };
      }),
    });
  let view = await agendaHome(s, now),
    group = view.groups[0];
  view = await saveAgendaSplit(
    s,
    {
      caseId: group.caseState.id,
      sourceRevision: group.caseState.sourceRevision,
      expectedRevision: group.caseState.revision,
      expectedSplitRevision: view.splitRevision,
      confirmed: true,
      reset: false,
      targetId: null,
      label: "面接",
      messages: group.entries
        .filter((entry) => entry.messageId === "1")
        .map(({ accountId, messageId }) => ({ accountId, messageId })),
    },
    now,
  );
  return { s, accounts, id: view.splitCases[0].id };
}
const stateInput = (group, status) => ({
  caseId: group.caseState.id,
  sourceRevision: group.caseState.sourceRevision,
  expectedRevision: group.caseState.revision,
  confirmed: true,
  status,
  note: "元のメモ",
  snoozeUntil: status === "hold" ? "2026-11-20" : null,
});
const manage = (view, id, operation = "rename", label = "一次面接") => ({
  targetId: id,
  expectedSplitRevision: view.splitRevision,
  confirmed: true,
  operation,
  label,
});

test("複数宛先の名前を変更しても案件ID・対応済み・メモ・保存時刻を維持し、旧フォームを拒否する", async () => {
  const { s, accounts, id } = await setup();
  let view = await agendaHome(s, now);
  const child = view.groups.find((group) => group.manualCaseId === id);
  await saveAgendaCase(s, stateInput(child, "done"), now);
  view = await agendaHome(s, now);
  const before = view.groups.find((group) => group.manualCaseId === id),
    oldForm = stateInput(before, "hold");
  const renamed = await manageAgendaSplit(s, manage(view, id), now + 1),
    after = renamed.groups.find((group) => group.manualCaseId === id);
  assert.equal(after.label, "一次面接");
  assert.equal(after.caseState.id, before.caseState.id);
  assert.equal(after.caseState.sourceRevision, before.caseState.sourceRevision);
  assert.equal(after.caseState.status, "done");
  assert.equal(after.caseState.note, "元のメモ");
  assert.equal(after.caseState.updatedAt, before.caseState.updatedAt);
  assert.notEqual(after.caseState.revision, before.caseState.revision);
  await assert.rejects(saveAgendaCase(s, oldForm, now + 2), /変わりました/);
  for (const account of accounts) {
    const store = await s.get("agenda:caseSplits:" + account.id);
    assert.equal(store.assignments["1"].label, "一次面接");
  }
  assert.equal(
    (await agendaHome(memory(s.values), now)).groups.find(
      (group) => group.manualCaseId === id,
    ).label,
    "一次面接",
  );
});
test("全メールが取得一覧外でも件数を明示して改名・解除でき、保留・メモは履歴に残る", async () => {
  const { s, accounts, id } = await setup();
  let view = await agendaHome(s, now);
  const child = view.groups.find((group) => group.manualCaseId === id);
  await saveAgendaCase(s, stateInput(child, "hold"), now);
  for (const account of accounts)
    await clearAccountCache(s, { accountId: account.id, confirm: true });
  view = await agendaHome(s, now);
  const item = view.splitCases[0];
  assert.equal(item.count, 2);
  assert.equal(item.cachedCount, 0);
  assert.equal(item.homeCount, 0);
  assert.equal(item.accountCount, 2);
  assert.equal(item.status, "hold");
  const renamed = await manageAgendaSplit(
    s,
    manage(view, id, "rename", "面接・確認待ち"),
    now + 1,
  );
  const history = renamed.caseHistory.find(
    (record) => record.id === child.caseState.id,
  );
  assert.equal(history.label, "面接・確認待ち");
  assert.equal(history.note, "元のメモ");
  assert.equal(history.status, "hold");
  assert.equal(history.snoozeUntil, "2026-11-20");
  const reset = await manageAgendaSplit(
    s,
    manage(renamed, id, "reset"),
    now + 2,
  );
  assert.equal(reset.splitCases.length, 0);
  assert.equal(reset.splitManagementResult.count, 2);
  assert.equal(
    reset.caseHistory.find((record) => record.id === child.caseState.id).note,
    "元のメモ",
  );
  for (const account of accounts)
    assert.deepEqual(
      (await s.get("agenda:caseSplits:" + account.id)).assignments,
      {},
    );
});
test("取得済みだがホーム対象外のメールは、取得一覧外と区別する", async () => {
  const { s, accounts, id } = await setup();
  for (const account of accounts)
    await s.put("agenda:reviews:" + account.id, {
      1: { reviewedAt: new Date(now).toISOString() },
    });
  let view = await agendaHome(s, now),
    item = view.splitCases.find((item) => item.id === id);
  assert.equal(item.cachedCount, 2);
  assert.equal(item.homeCount, 0);
  assert.equal(item.count, 2);
  view = await manageAgendaSplit(
    s,
    manage(view, id, "rename", "確認済みの面接"),
    now,
  );
  assert.equal(view.splitCases[0].label, "確認済みの面接");
  assert.equal(view.splitCases[0].homeCount, 0);
});
test("不正な名前・未確認・未知案件・古い版・二重送信を副作用なしで拒否する", async () => {
  const { s, id } = await setup();
  const view = await agendaHome(s, now),
    input = manage(view, id),
    before = structuredClone(s.values);
  for (const invalid of [
    { confirmed: false },
    { label: " " },
    { label: "x".repeat(101) },
    { label: "a\nb" },
    { label: "面接" },
    { operation: "delete" },
    { targetId: crypto.randomUUID() },
    { expectedSplitRevision: "a".repeat(64) },
  ])
    await assert.rejects(manageAgendaSplit(s, { ...input, ...invalid }, now));
  assert.deepEqual(s.values, before);
  await manageAgendaSplit(s, input, now);
  const saved = structuredClone(s.values);
  await assert.rejects(manageAgendaSplit(s, input, now), /変わった/);
  assert.deepEqual(s.values, saved);
});
test("他画面で変更された対応状況・メモや取得範囲を管理画面から上書きしない", async () => {
  const { s, accounts, id } = await setup();
  let view = await agendaHome(s, now);
  const old = manage(view, id, "reset");
  await saveAgendaCase(
    s,
    stateInput(
      view.groups.find((group) => group.manualCaseId === id),
      "hold",
    ),
    now,
  );
  let before = structuredClone(s.values);
  await assert.rejects(manageAgendaSplit(s, old, now), /変わった/);
  assert.deepEqual(s.values, before);
  view = await agendaHome(s, now);
  const beforeCache = manage(view, id);
  await clearAccountCache(s, { accountId: accounts[0].id, confirm: true });
  before = structuredClone(s.values);
  await assert.rejects(manageAgendaSplit(s, beforeCache, now), /変わった/);
  assert.deepEqual(s.values, before);
});
test("元々宛先間で異なる版の記録を、改名だけで対応済みへ揃えない", async () => {
  const { s, accounts, id } = await setup();
  let view = await agendaHome(s, now);
  const child = view.groups.find((group) => group.manualCaseId === id);
  await saveAgendaCase(s, stateInput(child, "done"), now);
  const key = "agenda:cases:" + accounts[1].id,
    records = await s.get(key);
  records[child.caseState.id] = {
    ...records[child.caseState.id],
    status: "open",
    revision: crypto.randomUUID(),
  };
  await s.put(key, records);
  view = await agendaHome(s, now);
  assert.equal(
    view.groups.find((group) => group.manualCaseId === id).caseState.status,
    "open",
  );
  const renamed = await manageAgendaSplit(s, manage(view, id), now);
  assert.equal(
    renamed.groups.find((group) => group.manualCaseId === id).caseState.status,
    "open",
  );
  const first = (await s.get("agenda:cases:" + accounts[0].id))[
      child.caseState.id
    ],
    second = (await s.get(key))[child.caseState.id];
  assert.notEqual(first.revision, second.revision);
  assert.equal(first.status, "done");
  assert.equal(second.status, "open");
});
test("改名をバックアップ復元し、解除後も他案件・元メール・予定の記録は維持する", async () => {
  const { s, accounts, id } = await setup();
  let view = await agendaHome(s, now);
  await saveAgendaCase(
    s,
    stateInput(
      view.groups.find((group) => group.manualCaseId === id),
      "hold",
    ),
    now,
  );
  view = await manageAgendaSplit(s, manage(await agendaHome(s, now), id), now);
  const backup = await createAgendaBackup(s),
    target = memory();
  await target.put("agenda:accounts", accounts);
  for (const [key, value] of (await agendaRestoreEntries(target, backup))
    .entries)
    await target.put(key, value);
  const restored = await agendaHome(target, now);
  assert.equal(restored.splitCases[0].label, "一次面接");
  assert.equal(restored.splitCases[0].status, "hold");
  const beforeCache = await target.get("agenda:cache:" + accounts[0].id);
  const result = await manageAgendaSplit(
    target,
    manage(restored, id, "reset"),
    now,
  );
  assert.deepEqual(
    await target.get("agenda:cache:" + accounts[0].id),
    beforeCache,
  );
  assert.equal(result.groups.filter((group) => !group.manualCaseId).length, 1);
  assert.equal(result.caseHistory[0].label, "一次面接");
  assert.equal(result.caseHistory[0].note, "元のメモ");
  const plan = await previewAccountDeletion(
    s,
    { accountId: accounts[0].id },
    now,
  );
  await deleteAccount(
    s,
    {
      accountId: accounts[0].id,
      email: accounts[0].email,
      checksum: plan.checksum,
      confirm: true,
    },
    now,
  );
  assert.equal((await agendaHome(s, now)).splitCases[0].label, "一次面接");
});
