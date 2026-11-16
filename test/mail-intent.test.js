import test from "node:test";
import assert from "node:assert/strict";
import { analyzeMailIntent, currentMailText } from "../src/mail-intent.js";
import {
  groupMailSuggestions,
  mailSuggestion,
} from "../src/mail-suggestions.js";
import { mailCaseView } from "../src/mail-cases.js";

const mail = (overrides = {}) => ({
  kind: "mail",
  accountId: "a",
  messageId: "new",
  from: "jobs@example.test",
  title: "成績証明書の提出確認とグループ面接のご案内【試験株式会社】",
  excerpt:
    "成績証明書をご提出いただきありがとうございます。必要書類はすべて提出完了しました。次の選考ステップはグループ面接です。",
  receivedAt: "2026-11-16T02:00:00Z",
  ...overrides,
});
const now = Date.parse("2026-11-16T03:00:00Z");
test("本文の受付と次の面接を認識し、件名の提出を再提出依頼にしない", () => {
  const suggestion = mailSuggestion(mail());
  assert.equal(suggestion.category, "受付後の日程確認");
  assert.equal(suggestion.hasSubmissionRequest, false);
  assert.ok(suggestion.checks.every((text) => !text.includes("提出する書類")));
  assert.match(suggestion.evidence, /ありがとう/);
});
test("否定・条件・操作説明を受付完了と断定しない", () => {
  for (const [title, excerpt] of [
    ["提出済みの場合の案内", "提出済みの場合は返信不要です。"],
    ["受付完了までに必要な手順", "受付完了ボタンを押してください。"],
    ["提出完了のお知らせ", "書類はまだ受領しておりません。"],
    ["書類の確認", "成績証明書は未提出です。"],
    ["書類の確認", "成績証明書の受領はできておりません。"],
  ])
    assert.equal(
      analyzeMailIntent(mail({ title, excerpt })).receipt,
      false,
      title + excerpt,
    );
});
test("引用・転送の完了通知を現在の受付と混同しない", () => {
  for (const quote of [
    "> 成績証明書を受領しました。",
    "-----Original Message-----\n成績証明書を受領しました。",
    "From: jobs@example.test\n受付が完了しました。",
  ]) {
    const entry = mail({
      title: "成績証明書の再提出依頼",
      excerpt: "成績証明書を再提出してください。\n" + quote,
    });
    assert.equal(analyzeMailIntent(entry).receipt, false);
    assert.equal(mailSuggestion(entry).category, "提出の確認");
  }
  assert.equal(currentMailText("現在の案内\n> 引用\n--\n署名"), "現在の案内");
});
test("受付後の別書類・明示的な再提出・回答は残し、不要な再提出は勧めない", () => {
  for (const request of [
    "履歴書を提出してください。",
    "成績証明書を改めて再提出してください。",
  ]) {
    const suggestion = mailSuggestion(
      mail({ excerpt: "成績証明書を受領しました。" + request }),
    );
    assert.equal(suggestion.hasSubmissionRequest, true, request);
    assert.equal(suggestion.category, "受付と追加依頼の確認");
  }
  assert.equal(
    mailSuggestion(
      mail({ excerpt: "成績証明書を受領しました。再提出は不要です。" }),
    ).hasSubmissionRequest,
    false,
  );
  assert.equal(
    mailSuggestion(
      mail({
        excerpt: "成績証明書を受領しましたが、履歴書を提出してください。",
      }),
    ).hasSubmissionRequest,
    true,
  );
  const response = mailSuggestion(
    mail({
      title: "書類の確認",
      excerpt: "成績証明書を受領しました。出欠をご回答ください。",
    }),
  );
  assert.ok(response.checks.some((text) => text.includes("返信")));
});
test("最新受付は古い同一宛先の締切を優先しないが、元案内を保持する", () => {
  const groups = groupMailSuggestions(
    [
      mail({
        messageId: "old",
        title: "成績証明書の提出依頼【試験株式会社】",
        excerpt: "提出期限は2026年11月10日です。",
        receivedAt: "2026-11-09T02:00:00Z",
      }),
      mail({
        title: "成績証明書の提出確認【試験株式会社】",
        excerpt: "成績証明書を受領しました。提出期限は2026年11月10日でした。",
      }),
    ],
    now,
  );
  assert.equal(groups[0].suggestion.hasSubmissionRequest, false);
  assert.equal(groups[0].proposalTimings.length, 0);
  assert.ok(groups[0].referenceTimings.length > 0);
  assert.equal(groups[0].priority.rank, 7);
  assert.equal(groups[0].entries[1].recency, "過去の関連案内");
  assert.equal(groups[0].entries[0].recency, "この宛先の最新案内");
});
test("同時刻・日時不明は前後を決めず、異なる提出物の過去依頼も注意を残す", () => {
  const old = mail({
    messageId: "old",
    title: "履歴書の提出依頼【試験株式会社】",
    excerpt: "履歴書を提出してください。",
  });
  for (const receivedAt of [old.receivedAt, null]) {
    const group = groupMailSuggestions([old, mail({ receivedAt })], now)[0];
    assert.equal(group.currentSources.length, 2);
    assert.equal(group.chronologyUncertain, true);
    assert.equal(group.suggestion.category, "案内ごとの確認");
  }
  const group = groupMailSuggestions(
    [
      old,
      mail({
        receivedAt: "2026-11-16T03:00:00Z",
        excerpt: "成績証明書を受領しました。",
      }),
    ],
    now,
  )[0];
  assert.ok(group.historyNotices.some((text) => text.includes("完了範囲")));
});
test("本人確定日時と案件の保存用日時を維持し、部分本文には注意を付ける", async () => {
  const timing = {
    kind: "deadline",
    action: "成績証明書を提出",
    date: "2026-11-17",
    confirmed: true,
    manual: true,
    timingId: "saved",
    sourceRevision: "revision",
  };
  const group = groupMailSuggestions(
    [mail({ timings: [timing], contentLimited: true })],
    now,
  )[0];
  assert.equal(group.proposalTimings[0].timingId, "saved");
  assert.match(group.proposalTimings[0].receiptNotice, /本人確定日時/);
  assert.equal(group.timings[0].timingId, "saved");
  assert.match(group.suggestion.reason, /本文の一部/);
  const storage = { get: async () => undefined };
  const actual = await mailCaseView(storage, [{ id: "a" }], [group], now);
  const legacy = await mailCaseView(
    storage,
    [{ id: "a" }],
    [
      {
        ...group,
        proposalTimings: [],
        referenceTimings: [],
        suggestion: {},
        entries: group.entries.map(({ recency, ...entry }) => entry),
      },
    ],
    now,
  );
  assert.equal(
    actual.groups[0].caseState.sourceRevision,
    legacy.groups[0].caseState.sourceRevision,
  );
});
