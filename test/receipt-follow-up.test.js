import test from "node:test";
import assert from "node:assert/strict";
import { extractMailTiming } from "../src/mail-timing.js";
import { groupMailSuggestions } from "../src/mail-suggestions.js";
import { mailCaseView } from "../src/mail-cases.js";
import {
  messageTimingView,
  saveTimingConfirmation,
} from "../src/timing-confirmations.js";
const mail = (excerpt, overrides = {}) => ({
  kind: "mail",
  accountId: "a",
  messageId: "abc",
  title: "成績証明書の受付完了と次のご案内【試験株式会社】",
  from: "jobs@example.test",
  receivedAt: "2026-11-16T01:00:00Z",
  excerpt,
  ...overrides,
});
const body =
  "2026年11月15日に成績証明書を受領しました。\n受付日：2026年11月15日\n成績証明書の提出期限は2026年11月14日でした。\n面接日時：\n2026年11月18日 10:00〜11:00\n出欠の回答期限：\n2026年11月17日 17:00";
const message = (entry) => ({
  id: entry.messageId,
  subject: entry.title,
  from: entry.from,
  receivedAt: entry.receivedAt,
  excerpt: entry.excerpt,
});
test("受付件名でも後続の面接・回答期限を別々に抽出し、旧提出期限と受付日を採用しない", () => {
  const entry = mail(body),
    rows = extractMailTiming(entry);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["event", "deadline"],
  );
  assert.match(rows[0].display, /2026\/11\/18 10:00〜11:00/);
  assert.equal(rows[1].action, "返信・回答する");
  assert.ok(rows.every((row) => row.followUp && !row.confirmed));
  assert.ok(
    rows.every((row) =>
      row.reasons.some((reason) => reason.includes("受付後")),
    ),
  );
  const group = groupMailSuggestions(
    [entry],
    Date.parse("2026-11-16T03:00:00Z"),
  )[0];
  assert.equal(group.proposalTimings.length, 2);
  assert.equal(group.priority.rank, 4);
});
test("受付後の別書類依頼を残し、受付だけ・引用・署名の日時を復活させない", () => {
  assert.equal(
    extractMailTiming(
      mail(
        "成績証明書を受領しました。履歴書を提出してください。提出期限：2026年11月20日",
      ),
    ).length,
    1,
  );
  for (const excerpt of [
    "成績証明書を受領しました。提出期限：2026年11月10日",
    "成績証明書を受領しました。\n> 面接日時：2026年11月20日10:00",
    "成績証明書を受領しました。\nFrom: jobs@example.test\n面接日時：2026年11月20日10:00",
    "成績証明書を受領しました。\n--\n会議日時：2026年11月20日10:00",
  ])
    assert.deepEqual(extractMailTiming(mail(excerpt)), [], excerpt);
});
test("取消・変更・年省略・部分本文から確定済みや新しい年月日を創作しない", () => {
  for (const [excerpt, title] of [
    ["成績証明書を受領しました。面接日時：11月18日10:00", undefined],
    [
      "成績証明書を受領しました。面接日時：2026年11月18日10:00",
      "受付完了・面接中止のお知らせ",
    ],
    ["成績証明書を受領しました。旧日程：2026年11月18日10:00", undefined],
  ]) {
    const rows = extractMailTiming(mail(excerpt, title ? { title } : {}));
    assert.ok(rows.every((row) => !row.confirmed));
  }
  const group = groupMailSuggestions([mail(body, { contentLimited: true })])[0];
  assert.match(group.suggestion.reason, /本文の一部/);
});
test("従来の通常メールの抽出結果と本人確定IDを変えず、新候補もサーバーで確定・再照合できる", async () => {
  const ordinary = mail("面接日時：2026年11月18日10:00〜11:00", {
    title: "面接日程の案内",
  });
  const original = await messageTimingView(message(ordinary));
  assert.equal(original.timings[0].followUp, undefined);
  const entry = mail(body),
    values = new Map([
      ["agenda:accounts", [{ id: "a", email: "a@example.test" }]],
      ["agenda:cache:a", { messages: [message(entry)] }],
    ]);
  const storage = {
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => values.set(key, structuredClone(value)),
    list: async () => new Map(),
    transaction: async (fn) => fn(storage),
  };
  const before = await messageTimingView(message(entry));
  const timing = before.timings.find((row) => row.kind === "event");
  const result = await saveTimingConfirmation(storage, {
    accountId: "a",
    messageId: "abc",
    timingId: timing.timingId,
    sourceRevision: timing.sourceRevision,
    expectedRevision: null,
    confirm: true,
    value: {
      kind: "event",
      action: "試験用の面接確認",
      date: "2026-11-18",
      time: "10:00",
      endDate: "2026-11-18",
      endTime: "11:00",
    },
  });
  const saved = result.timings.find((row) => row.timingId === timing.timingId);
  assert.ok(saved.manual);
  assert.equal(saved.confirmed, true);
  const reloaded = await messageTimingView(
    message(entry),
    values.get("agenda:timingConfirmations:a"),
  );
  assert.deepEqual(reloaded.timings, result.timings);
  const legacy = await messageTimingView(message(ordinary), {
    ["abc:" + original.timings[0].timingId]: {
      sourceRevision: original.sourceRevision,
      revision: crypto.randomUUID(),
      updatedAt: new Date().toISOString(),
      value: {
        kind: "event",
        action: "既存の確認",
        date: "2026-11-19",
        time: "12:00",
        endDate: "",
        endTime: "",
      },
    },
  });
  assert.equal(legacy.timings[0].timingId, original.timings[0].timingId);
  assert.equal(legacy.timings[0].date, "2026-11-19");
});
test("抽出改善だけでは対応済み・保留の照合値を変えず、本人確定後は再確認対象にする", async () => {
  const group = groupMailSuggestions([mail(body)])[0],
    storage = { get: async () => undefined };
  const legacy = await mailCaseView(
    storage,
    [{ id: "a" }],
    [{ ...group, timings: [] }],
  );
  const updated = await mailCaseView(storage, [{ id: "a" }], [group]);
  assert.equal(
    legacy.groups[0].caseState.sourceRevision,
    updated.groups[0].caseState.sourceRevision,
  );
  const confirmed = await mailCaseView(
    storage,
    [{ id: "a" }],
    [
      {
        ...group,
        timings: group.timings.map((row) => ({
          ...row,
          manual: { confirmedAt: new Date().toISOString() },
          confirmed: true,
        })),
      },
    ],
  );
  assert.notEqual(
    updated.groups[0].caseState.sourceRevision,
    confirmed.groups[0].caseState.sourceRevision,
  );
});
