import test from "node:test";
import assert from "node:assert/strict";
import {
  agendaHome,
  saveAgendaCase,
  saveAgendaSplit,
} from "../src/agenda-home.js";
import { normalizeSplitStore } from "../src/mail-case-splits.js";
import { digest, extractAppointment } from "../src/agenda-rules.js";
import {
  createAgendaBackup,
  agendaRestoreEntries,
} from "../src/agenda-backup.js";
import {
  clearAccountCache,
  previewAccountDeletion,
  deleteAccount,
} from "../src/agenda-management.js";
const now = Date.parse("2026-11-15T13:00:00Z");
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
  const s = memory();
  const accounts = await Promise.all(
    ["one@example.test", "two@example.test"].map(async (email) => ({
      id: await digest(email),
      email,
      calendar: "primary",
    })),
  );
  await s.put("agenda:accounts", accounts);
  for (const account of accounts) {
    const make = (id, subject, excerpt) => ({
      id,
      subject,
      excerpt,
      from: "jobs@example.test",
      receivedAt: new Date(now).toISOString(),
      candidate: extractAppointment(subject, excerpt),
    });
    await s.put("agenda:cache:" + account.id, {
      lastSuccess: new Date(now).toISOString(),
      messages: [
        make(
          "1",
          "面接日程の確認【試験株式会社】",
          "2026年11月18日 10:00〜11:00です。ご返信ください。",
        ),
        make(
          "2",
          "成績証明書の提出依頼【試験株式会社】",
          "提出期限は2026年11月17日です。",
        ),
      ],
    });
  }
  return { s, accounts };
}
function splitInput(view, group = view.groups[0], overrides = {}) {
  return {
    caseId: group.caseState.id,
    expectedRevision: group.caseState.revision,
    sourceRevision: group.caseState.sourceRevision,
    expectedSplitRevision: view.splitRevision,
    confirmed: true,
    reset: false,
    targetId: null,
    label: "面接",
    messages: group.entries
      .filter((entry) => entry.messageId === "1")
      .map(({ accountId, messageId }) => ({ accountId, messageId })),
    ...overrides,
  };
}
const statusInput = (group, status) => ({
  caseId: group.caseState.id,
  expectedRevision: group.caseState.revision,
  sourceRevision: group.caseState.sourceRevision,
  status,
  note: "",
  snoozeUntil: status === "hold" ? "2026-11-18" : null,
  confirmed: true,
});

test("同じ会社の複数宛先メールを分け、各案件の対応済み・保留と日時を独立して保持する", async () => {
  const { s } = await setup();
  const view = await agendaHome(s, now);
  const split = await saveAgendaSplit(s, splitInput(view), now);
  assert.equal(split.groups.length, 2);
  assert.equal(split.splitResult.count, 2);
  const child = split.groups.find((group) => group.manualCaseId),
    parent = split.groups.find((group) => !group.manualCaseId);
  assert.equal(child.label, "面接");
  assert.equal(child.accountCount, 2);
  assert.equal(child.entries.length, 2);
  assert.ok(child.timings.every((timing) => timing.messageId === "1"));
  assert.ok(parent.timings.every((timing) => timing.messageId === "2"));
  await saveAgendaCase(s, statusInput(child, "done"), now);
  const held = await saveAgendaCase(s, statusInput(parent, "hold"), now);
  assert.equal(
    held.groups.find((group) => group.manualCaseId).caseState.status,
    "done",
  );
  assert.equal(
    held.groups.find((group) => !group.manualCaseId).caseState.status,
    "hold",
  );
  assert.equal(
    (await agendaHome(memory(s.values), now)).groups.find(
      (group) => group.manualCaseId,
    ).caseState.status,
    "done",
  );
});
test("新着は自動候補に残し、本人選択で既存の分割案件へ追加して再確認する", async () => {
  const { s, accounts } = await setup();
  let split = await saveAgendaSplit(
    s,
    splitInput(await agendaHome(s, now)),
    now,
  );
  const child = split.groups.find((group) => group.manualCaseId);
  await saveAgendaCase(s, statusInput(child, "done"), now);
  const cache = await s.get("agenda:cache:" + accounts[0].id);
  cache.messages.push({
    ...cache.messages[0],
    id: "3",
    subject: "面接のリマインド【試験株式会社】",
    receivedAt: new Date(now + 1000).toISOString(),
  });
  await s.put("agenda:cache:" + accounts[0].id, cache);
  let view = await agendaHome(s, now);
  assert.equal(
    view.groups.find((group) => group.manualCaseId).caseState.status,
    "done",
  );
  const parent = view.groups.find((group) => !group.manualCaseId);
  assert.ok(parent.entries.some((entry) => entry.messageId === "3"));
  split = await saveAgendaSplit(
    s,
    splitInput(view, parent, {
      targetId: child.manualCaseId,
      messages: [{ accountId: accounts[0].id, messageId: "3" }],
    }),
    now,
  );
  assert.equal(
    split.groups.find((group) => group.manualCaseId).entries.length,
    3,
  );
  assert.equal(
    split.groups.find((group) => group.manualCaseId).caseState.status,
    "open",
  );
});

test("手動案件をさらに分けても、メール構成が変わらない別案件の保留・対応済みは維持する", async () => {
  const { s } = await setup();
  let view = await saveAgendaSplit(
    s,
    splitInput(await agendaHome(s, now)),
    now,
  );
  await saveAgendaCase(
    s,
    statusInput(
      view.groups.find((group) => !group.manualCaseId),
      "hold",
    ),
    now,
  );
  view = await agendaHome(s, now);
  const child = view.groups.find((group) => group.manualCaseId);
  const nested = await saveAgendaSplit(
    s,
    splitInput(view, child, {
      label: "面接・別の宛先",
      messages: [
        {
          accountId: child.entries[0].accountId,
          messageId: child.entries[0].messageId,
        },
      ],
    }),
    now,
  );
  assert.equal(nested.groups.length, 3);
  assert.equal(
    nested.groups.find((group) => !group.manualCaseId).caseState.status,
    "hold",
  );
  const remaining = nested.groups.find(
    (group) => group.manualCaseId === child.manualCaseId,
  );
  await saveAgendaCase(s, statusInput(remaining, "done"), now);
  view = await agendaHome(s, now);
  const latest = view.groups.find(
    (group) => group.manualCaseId === nested.splitResult.targetId,
  );
  const reset = await saveAgendaSplit(
    s,
    splitInput(view, latest, { reset: true }),
    now,
  );
  assert.equal(
    reset.groups.find((group) => !group.manualCaseId).caseState.status,
    "open",
  );
  assert.equal(
    reset.groups.find((group) => group.manualCaseId === child.manualCaseId)
      .caseState.status,
    "done",
  );
});
test("古い案内・対応版・分類版、二重送信、混入メール、不正な名前や別会社への移動を拒否する", async () => {
  const { s, accounts } = await setup();
  const view = await agendaHome(s, now);
  const input = splitInput(view);
  for (const invalid of [
    { confirmed: false },
    { label: " " },
    { label: "a".repeat(101) },
    { messages: [] },
    { messages: [...input.messages, input.messages[0]] },
    { messages: [{ accountId: accounts[0].id, messageId: "ffff" }] },
    { expectedSplitRevision: "a".repeat(64) },
    { targetId: crypto.randomUUID() },
  ])
    await assert.rejects(saveAgendaSplit(s, { ...input, ...invalid }, now));
  const split = await saveAgendaSplit(s, input, now);
  await assert.rejects(saveAgendaSplit(s, input, now));
  await assert.rejects(
    saveAgendaCase(s, statusInput(view.groups[0], "done"), now),
  );
  const parent = split.groups.find((group) => !group.manualCaseId);
  await saveAgendaCase(s, statusInput(parent, "done"), now);
  await assert.rejects(saveAgendaSplit(s, splitInput(split, parent), now));
  const other = await setup();
  const otherView = await agendaHome(other.s, now);
  const storeKey = "agenda:caseSplits:" + other.accounts[0].id;
  const id = crypto.randomUUID();
  await other.s.put(storeKey, {
    revision: crypto.randomUUID(),
    assignments: {
      fff: { caseId: id, label: "他社", originalCaseId: "f".repeat(64) },
    },
  });
  const latest = await agendaHome(other.s, now);
  await assert.rejects(
    saveAgendaSplit(
      other.s,
      splitInput(latest, latest.groups[0], { targetId: id }),
      now,
    ),
    /同じ元/,
  );
});

test("移動先や戻り先の対応状態・メールが変わった場合も古い分類フォームを拒否する", async () => {
  const { s, accounts } = await setup();
  let view = await saveAgendaSplit(
    s,
    splitInput(await agendaHome(s, now)),
    now,
  );
  let child = view.groups.find((group) => group.manualCaseId),
    parent = view.groups.find((group) => !group.manualCaseId);
  const stale = splitInput(view, parent, { targetId: child.manualCaseId });
  await saveAgendaCase(s, statusInput(child, "done"), now);
  let before = structuredClone(s.values);
  await assert.rejects(saveAgendaSplit(s, stale, now), /変わった/);
  assert.deepEqual(s.values, before);
  view = await agendaHome(s, now);
  child = view.groups.find((group) => group.manualCaseId);
  parent = view.groups.find((group) => !group.manualCaseId);
  const targetChanged = splitInput(view, parent, {
    targetId: child.manualCaseId,
  });
  const cache = await s.get("agenda:cache:" + accounts[0].id);
  cache.messages[0].excerpt = "面接日程が変更されました。";
  await s.put("agenda:cache:" + accounts[0].id, cache);
  assert.equal(
    (await agendaHome(s, now)).groups.find((group) => !group.manualCaseId)
      .caseState.sourceRevision,
    parent.caseState.sourceRevision,
  );
  await assert.rejects(saveAgendaSplit(s, targetChanged, now), /変わった/);
  view = await agendaHome(s, now);
  child = view.groups.find((group) => group.manualCaseId);
  parent = view.groups.find((group) => !group.manualCaseId);
  const oldReset = splitInput(view, child, { reset: true });
  await saveAgendaCase(s, statusInput(parent, "hold"), now);
  before = structuredClone(s.values);
  await assert.rejects(saveAgendaSplit(s, oldReset, now), /変わった/);
  assert.deepEqual(s.values, before);
});
test("自動へ戻す際は取得範囲外の分類も戻し、元の対応済みを復活させず記録を保持する", async () => {
  const { s, accounts } = await setup();
  let view = await agendaHome(s, now);
  view = await saveAgendaCase(s, statusInput(view.groups[0], "done"), now);
  let split = await saveAgendaSplit(s, splitInput(view), now);
  const child = split.groups.find((group) => group.manualCaseId);
  assert.ok(split.groups.every((group) => group.caseState.status === "open"));
  await saveAgendaCase(s, statusInput(child, "done"), now);
  const cache = await s.get("agenda:cache:" + accounts[1].id);
  cache.messages = cache.messages.filter((message) => message.id !== "1");
  await s.put("agenda:cache:" + accounts[1].id, cache);
  view = await agendaHome(s, now);
  const current = view.groups.find((group) => group.manualCaseId);
  const reset = await saveAgendaSplit(
    s,
    splitInput(view, current, { reset: true }),
    now,
  );
  assert.equal(reset.splitResult.count, 2);
  assert.equal(reset.splitCases.length, 0);
  assert.equal(reset.groups.length, 1);
  assert.equal(reset.groups[0].caseState.status, "open");
  assert.ok(
    reset.caseHistory.some((record) => record.id === child.caseState.id),
  );
  for (const account of accounts)
    assert.deepEqual(
      (await s.get("agenda:caseSplits:" + account.id)).assignments,
      {},
    );
});
test("キャッシュ整理とバックアップ復元で分割を保持し、復元版・既存データの競合を検知する", async () => {
  const { s, accounts } = await setup();
  const split = await saveAgendaSplit(
    s,
    splitInput(await agendaHome(s, now)),
    now,
  );
  await saveAgendaCase(
    s,
    statusInput(
      split.groups.find((group) => group.manualCaseId),
      "done",
    ),
    now,
  );
  const backup = await createAgendaBackup(s),
    target = memory();
  await target.put("agenda:accounts", accounts);
  for (const [key, value] of (await agendaRestoreEntries(target, backup))
    .entries)
    await target.put(key, value);
  const restored = await agendaHome(target, now);
  assert.equal(restored.groups.length, 2);
  assert.equal(
    restored.groups.find((group) => group.manualCaseId).caseState.status,
    "done",
  );
  assert.notEqual(restored.splitRevision, split.splitRevision);
  assert.ok(
    (await agendaRestoreEntries(target, backup)).conflicts.includes(
      "agenda:caseSplits:" + accounts[0].id,
    ),
  );
  await clearAccountCache(s, { accountId: accounts[0].id, confirm: true });
  assert.equal(
    Object.keys(
      (await s.get("agenda:caseSplits:" + accounts[0].id)).assignments,
    ).length,
    1,
  );
});
test("一方の保存上限を超えた分割は、もう一方や対応記録も変更せず止める", async () => {
  const { s, accounts } = await setup();
  const key = "agenda:caseSplits:" + accounts[1].id;
  const assignments = Object.fromEntries(
    Array.from({ length: 1000 }, (_, index) => [
      (index + 100).toString(16),
      {
        caseId: crypto.randomUUID(),
        label: "保存済み",
        originalCaseId: "a".repeat(64),
      },
    ]),
  );
  await s.put(key, { revision: crypto.randomUUID(), assignments });
  const view = await agendaHome(s, now);
  const before = structuredClone(s.values);
  await assert.rejects(saveAgendaSplit(s, splitInput(view), now), /1000/);
  assert.deepEqual(s.values, before);
  const invalid = structuredClone(await s.get(key));
  invalid.assignments["64"].label = "x\nname";
  assert.throws(() => normalizeSplitStore(invalid));
});
test("アカウント完全削除はその宛先の分類だけを対象にし、別アカウントは維持する", async () => {
  const { s, accounts } = await setup();
  await saveAgendaSplit(s, splitInput(await agendaHome(s, now)), now);
  const plan = await previewAccountDeletion(
    s,
    { accountId: accounts[0].id },
    now,
  );
  assert.equal(plan.counts.splitMessages, 1);
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
  assert.equal(await s.get("agenda:caseSplits:" + accounts[0].id), undefined);
  assert.equal(
    Object.keys(
      (await s.get("agenda:caseSplits:" + accounts[1].id)).assignments,
    ).length,
    1,
  );
});
test("結果未確認の操作を分割対象にせず、名前の食い違う復元も拒否する", async () => {
  const { s, accounts } = await setup();
  await s.put("agenda:pending:" + accounts[0].id, ["manual-fixture"]);
  await s.put("agenda:operation:" + accounts[0].id + ":manual-fixture", {
    draft: { title: "試験" },
    phase: "結果不明",
  });
  const view = await agendaHome(s, now);
  const parent = view.groups.find((group) => !group.pending);
  const split = await saveAgendaSplit(s, splitInput(view, parent), now);
  assert.equal(split.groups.filter((group) => group.pending).length, 1);
  await s.delete("agenda:pending:" + accounts[0].id);
  await s.delete("agenda:operation:" + accounts[0].id + ":manual-fixture");
  const backup = await createAgendaBackup(s);
  const id = Object.keys(backup[1].caseSplits.assignments)[0];
  backup[1].caseSplits.assignments[id].label = "違う名前";
  const target = memory();
  await target.put("agenda:accounts", accounts);
  await assert.rejects(agendaRestoreEntries(target, backup), /名前が一致/);
});
