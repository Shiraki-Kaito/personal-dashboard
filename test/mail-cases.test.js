import test from "node:test";
import assert from "node:assert/strict";
import { agendaHome, saveAgendaCase } from "../src/agenda-home.js";
import { normalizeCaseRecords } from "../src/mail-cases.js";
import { digest, extractAppointment } from "../src/agenda-rules.js";
import {
  readTimingConfirmation,
  saveTimingConfirmation,
} from "../src/timing-confirmations.js";
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
  for (const [index, account] of accounts.entries()) {
    const subject = "面接日程の確認【サンプル株式会社】";
    const excerpt = "11月18日 10:00〜11:00です。ご返信ください。";
    await s.put("agenda:cache:" + account.id, {
      lastSuccess: new Date(now).toISOString(),
      messages: [
        {
          id: (index + 1).toString(16),
          subject,
          excerpt,
          from: "jobs@example.test",
          receivedAt: new Date(now).toISOString(),
          candidate: extractAppointment(subject, excerpt),
        },
      ],
    });
  }
  return { s, accounts };
}
const inputFor = (group, overrides = {}) => ({
  caseId: group.caseState.id,
  sourceRevision: group.caseState.sourceRevision,
  expectedRevision: group.caseState.revision,
  status: "done",
  snoozeUntil: null,
  note: "応募先への提出を確認",
  confirmed: true,
  ...overrides,
});

test("確定日時の内容変更で再表示し、内容が同じ復元では対応済みを保持する", async () => {
  const { s, accounts } = await setup();
  const selection = { accountId: accounts[0].id, messageId: "1" };
  const original = (await readTimingConfirmation(s, selection)).timings[0];
  const timingInput = {
    ...selection,
    timingId: original.timingId,
    sourceRevision: original.sourceRevision,
    expectedRevision: original.revision,
    confirm: true,
    value: {
      kind: "event",
      action: "面接を受ける",
      date: "2026-11-18",
      time: "10:00",
      endDate: "2026-11-18",
      endTime: "11:00",
    },
  };
  await saveTimingConfirmation(s, timingInput, now);
  const done = await saveAgendaCase(
    s,
    inputFor((await agendaHome(s, now)).groups[0]),
    now,
  );
  const backup = await createAgendaBackup(s),
    target = memory();
  await target.put("agenda:accounts", accounts);
  for (const [key, value] of (await agendaRestoreEntries(target, backup))
    .entries)
    await target.put(key, value);
  assert.equal(
    (await agendaHome(target, now)).groups[0].caseState.status,
    "done",
  );
  const current = (await readTimingConfirmation(s, selection)).timings[0];
  await saveTimingConfirmation(
    s,
    {
      ...timingInput,
      expectedRevision: current.revision,
      value: {
        ...timingInput.value,
        date: "2026-11-19",
        endDate: "2026-11-19",
      },
    },
    now + 1,
  );
  assert.equal((await agendaHome(s, now)).groups[0].caseState.status, "open");
  await assert.rejects(
    saveAgendaCase(s, inputFor(done.groups[0]), now + 2),
    /変わりました/,
  );
});

test("複数アカウントの案件を対応済み・保留・未対応へ保存し、元メールや確認記録は変えない", async () => {
  const { s, accounts } = await setup();
  const group = (await agendaHome(s, now)).groups[0];
  assert.equal(group.accountCount, 2);
  const before = await s.get("agenda:cache:" + accounts[0].id);
  const done = await saveAgendaCase(s, inputFor(group), now);
  assert.equal(done.groups[0].caseState.status, "done");
  assert.deepEqual(await s.get("agenda:cache:" + accounts[0].id), before);
  assert.equal(await s.get("agenda:reviews:" + accounts[0].id), undefined);
  const hold = await saveAgendaCase(
    s,
    inputFor(done.groups[0], { status: "hold", snoozeUntil: "2026-11-18" }),
    now + 1,
  );
  assert.equal(hold.groups[0].caseState.status, "hold");
  const restarted = memory(s.values);
  assert.equal(
    (await agendaHome(restarted, now + 2)).groups[0].caseState.status,
    "hold",
  );
  const reopened = await saveAgendaCase(
    s,
    inputFor(hold.groups[0], { status: "open", note: "" }),
    now + 2,
  );
  assert.equal(reopened.groups[0].caseState.status, "open");
});
test("新しい関連メールや元メールの内容変更で未対応へ戻し、古いフォームから隠せない", async () => {
  const { s, accounts } = await setup();
  const done = await saveAgendaCase(
    s,
    inputFor((await agendaHome(s, now)).groups[0]),
    now,
  );
  const old = inputFor(done.groups[0]);
  const cache = await s.get("agenda:cache:" + accounts[0].id);
  cache.messages.push({
    ...cache.messages[0],
    id: "abc",
    receivedAt: new Date(now + 1000).toISOString(),
  });
  await s.put("agenda:cache:" + accounts[0].id, cache);
  let current = (await agendaHome(s, now)).groups[0];
  assert.equal(current.caseState.status, "open");
  assert.match(current.caseState.notice, /変わった/);
  await assert.rejects(saveAgendaCase(s, old, now), /変わりました/);
  await saveAgendaCase(s, inputFor(current), now + 1);
  cache.messages[0].excerpt = "日程を変更します。11月19日です。";
  await s.put("agenda:cache:" + accounts[0].id, cache);
  current = (await agendaHome(s, now)).groups[0];
  assert.equal(current.caseState.status, "open");
});
test("保留期限は日本時間0時に再表示し、期限なし保留は自動解除しない", async () => {
  const { s } = await setup();
  let saved = await saveAgendaCase(
    s,
    inputFor((await agendaHome(s, now)).groups[0], {
      status: "hold",
      snoozeUntil: "2026-11-16",
    }),
    now,
  );
  assert.equal(
    (await agendaHome(s, Date.parse("2026-11-15T14:59:59Z"))).groups[0]
      .caseState.status,
    "hold",
  );
  const expired = (await agendaHome(s, Date.parse("2026-11-15T15:00:00Z")))
    .groups[0].caseState;
  assert.equal(expired.status, "open");
  assert.match(expired.notice, /再表示日/);
  saved = await saveAgendaCase(
    s,
    inputFor(saved.groups[0], { status: "hold" }),
    now + 1,
  );
  assert.equal(
    (await agendaHome(s, now + 30 * 86400000)).groups[0].caseState.status,
    "hold",
  );
});
test("二重保存・古い解除フォーム・未確認や不正な日時・メモ・未知案件を拒否する", async () => {
  const { s } = await setup();
  const group = (await agendaHome(s, now)).groups[0];
  const input = inputFor(group);
  for (const invalid of [
    { confirmed: false },
    { status: "unknown" },
    { status: "hold", snoozeUntil: "2026-02-30" },
    { status: "hold", snoozeUntil: "2026-11-15" },
    { note: "a".repeat(201) },
    { caseId: "a".repeat(64) },
  ])
    await assert.rejects(saveAgendaCase(s, { ...input, ...invalid }, now));
  const saved = await saveAgendaCase(s, input, now);
  await assert.rejects(saveAgendaCase(s, input, now), /変わりました/);
  const reset = inputFor(saved.groups[0], { status: "open" });
  await saveAgendaCase(s, reset, now + 1);
  await assert.rejects(saveAgendaCase(s, reset, now + 2), /変わりました/);
});
test("登録結果が未確認の操作は案件を対応済みにしても独立して表示する", async () => {
  const { s, accounts } = await setup();
  await s.put("agenda:pending:" + accounts[0].id, ["manual-fixture"]);
  await s.put("agenda:operation:" + accounts[0].id + ":manual-fixture", {
    draft: { title: "面接日程の確認【サンプル株式会社】" },
    phase: "結果不明",
  });
  const home = await agendaHome(s, now);
  const group = home.groups.find((group) => !group.pending);
  const saved = await saveAgendaCase(s, inputFor(group), now);
  assert.equal(saved.groups.filter((group) => group.pending).length, 1);
  assert.equal(saved.groups.find((group) => group.pending).caseState, null);
});
test("キャッシュがなくても対応記録は一覧へ残り、未対応へ戻せる", async () => {
  const { s, accounts } = await setup();
  await saveAgendaCase(
    s,
    inputFor((await agendaHome(s, now)).groups[0], { status: "hold" }),
    now,
  );
  for (const account of accounts)
    await clearAccountCache(s, { accountId: account.id, confirm: true });
  const view = await agendaHome(s, now);
  assert.equal(view.groups.length, 0);
  assert.equal(view.caseHistory.length, 1);
  const record = view.caseHistory[0];
  await assert.rejects(
    saveAgendaCase(
      s,
      {
        caseId: record.id,
        sourceRevision: null,
        expectedRevision: record.revision,
        status: "done",
        snoozeUntil: null,
        note: "",
        confirmed: true,
      },
      now,
    ),
    /未対応/,
  );
  const reset = await saveAgendaCase(
    s,
    {
      caseId: record.id,
      sourceRevision: null,
      expectedRevision: record.revision,
      status: "open",
      snoozeUntil: null,
      note: "",
      confirmed: true,
    },
    now,
  );
  assert.equal(reset.caseHistory.length, 0);
});

test("取得範囲外の案件も、未対応記録を含む全宛先の版を照合してから戻す", async () => {
  const { s, accounts } = await setup();
  const done = await saveAgendaCase(
    s,
    inputFor((await agendaHome(s, now)).groups[0]),
    now,
  );
  const id = done.groups[0].caseState.id;
  const secondKey = "agenda:cases:" + accounts[1].id;
  const second = await s.get(secondKey);
  second[id] = {
    ...second[id],
    status: "open",
    updatedAt: new Date(now - 1).toISOString(),
    revision: crypto.randomUUID(),
  };
  await s.put(secondKey, second);
  for (const account of accounts)
    await clearAccountCache(s, { accountId: account.id, confirm: true });
  const record = (await agendaHome(s, now)).caseHistory[0];
  second[id].revision = crypto.randomUUID();
  second[id].note = "別の画面で変更";
  await s.put(secondKey, second);
  await assert.rejects(
    saveAgendaCase(
      s,
      {
        caseId: id,
        sourceRevision: null,
        expectedRevision: record.revision,
        status: "open",
        snoozeUntil: null,
        note: "",
        confirmed: true,
      },
      now,
    ),
    /変わりました/,
  );
  assert.equal((await s.get(secondKey))[id].note, "別の画面で変更");
});
test("バックアップは宛先間の同じ記録を保ち、復元版を更新して上書き競合を拒否する", async () => {
  const { s, accounts } = await setup();
  await saveAgendaCase(s, inputFor((await agendaHome(s, now)).groups[0]), now);
  const backup = await createAgendaBackup(s);
  const target = memory();
  await target.put("agenda:accounts", accounts);
  const plan = await agendaRestoreEntries(target, backup);
  for (const [key, value] of plan.entries) await target.put(key, value);
  const restored = (await agendaHome(target, now)).groups[0];
  assert.equal(restored.caseState.status, "done");
  const caseId = restored.caseState.id;
  assert.notEqual(
    (await target.get("agenda:cases:" + accounts[0].id))[caseId].revision,
    (await s.get("agenda:cases:" + accounts[0].id))[caseId].revision,
  );
  assert.ok(
    (await agendaRestoreEntries(target, backup)).conflicts.includes(
      "agenda:cases:" + accounts[0].id,
    ),
  );
  const corrupt = structuredClone(backup);
  corrupt[0].cases[caseId].snoozeUntil = "bad";
  await assert.rejects(agendaRestoreEntries(memory(), corrupt));
});
test("完全削除は対象アカウントの案件記録だけを除き、容量超過を黙って捨てない", async () => {
  const { s, accounts } = await setup();
  await saveAgendaCase(s, inputFor((await agendaHome(s, now)).groups[0]), now);
  const plan = await previewAccountDeletion(
    s,
    { accountId: accounts[0].id },
    now,
  );
  assert.equal(plan.counts.cases, 1);
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
  assert.equal(await s.get("agenda:cases:" + accounts[0].id), undefined);
  const remaining = await s.get("agenda:cases:" + accounts[1].id);
  assert.equal(Object.keys(remaining).length, 1);
  assert.equal((await agendaHome(s, now)).groups[0].caseState.status, "open");
  const record = Object.values(remaining)[0];
  assert.throws(
    () =>
      normalizeCaseRecords(
        Object.fromEntries(
          Array.from({ length: 1001 }, (_, i) => [
            i.toString(16).padStart(64, "0"),
            record,
          ]),
        ),
      ),
    /1000/,
  );
  assert.throws(
    () =>
      normalizeCaseRecords(
        Object.fromEntries(
          Array.from({ length: 1000 }, (_, i) => [
            i.toString(16).padStart(64, "0"),
            { ...record, note: "あ".repeat(200), label: "あ".repeat(300) },
          ]),
        ),
      ),
    /512KiB/,
  );
});
