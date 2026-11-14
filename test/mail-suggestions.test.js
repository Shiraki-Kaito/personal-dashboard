import test from "node:test";
import assert from "node:assert/strict";
import {
  groupMailSuggestions,
  mailSuggestion,
} from "../src/mail-suggestions.js";
import { calendarEventText } from "../public/calendar-cards.js";
const mail = (overrides = {}) => ({
  kind: "mail",
  accountId: "a",
  messageId: "1",
  title: "成績証明書の提出依頼【サンプル株式会社】",
  from: "採用 <jobs@example.test>",
  excerpt: "成績証明書を期限までに提出してください。",
  receivedAt: "2026-11-14T01:00:00Z",
  ...overrides,
});

test("同じ組織の関連案内を宛先を保ってまとめ、最新の受付通知から再提出を勧めない", () => {
  const entries = [
    mail(),
    mail({
      accountId: "b",
      messageId: "2",
      title: "提出ありがとうございます【サンプル株式会社】",
      receivedAt: "2026-11-14T02:00:00Z",
    }),
  ];
  const before = structuredClone(entries),
    groups = groupMailSuggestions(entries);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].accountCount, 2);
  assert.equal(groups[0].entries.length, 2);
  assert.equal(groups[0].entries[0].messageId, "2");
  assert.equal(groups[0].suggestion.category, "受付の確認");
  assert.deepEqual(entries, before);
});
test("同じ一般件名でも異なる送信者、異なる組織・卒業年度は混ぜない", () => {
  const entries = [
    mail({ title: "面談のご案内" }),
    mail({ title: "面談のご案内", from: "other@elsewhere.test" }),
    mail({ title: "2027年卒【サンプル株式会社】" }),
    mail({ title: "2028年卒【サンプル株式会社】" }),
    mail({ title: "書類提出【別の株式会社】" }),
  ];
  assert.equal(groupMailSuggestions(entries).length, 5);
});
test("結果不明は関連メールへ隠さず先頭で個別の照合案を表示する", () => {
  const groups = groupMailSuggestions([
    mail(),
    mail({ kind: "pending", messageId: "op1" }),
    mail({ kind: "pending", messageId: "op2" }),
  ]);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].pending, true);
  assert.equal(groups[1].pending, true);
  assert.equal(groups[0].suggestion.category, "結果未確認");
});
test("提出・日程・返信・判断不能を区別し、本文抜粋の語句も使う", () => {
  assert.equal(mailSuggestion(mail()).category, "提出の確認");
  assert.equal(mailSuggestion(mail({excerpt:"成績証明書を提出し、面接の日程を回答してください"})).checks.length, 3);
  assert.equal(
    mailSuggestion(mail({ title: "面談", excerpt: "日程を調整します" }))
      .category,
    "日程の確認",
  );
  assert.equal(
    mailSuggestion(
      mail({ title: "お知らせ", excerpt: "出欠の回答をお願いします" }),
    ).category,
    "回答の確認",
  );
  assert.equal(
    mailSuggestion(mail({ title: "お知らせ", excerpt: "" })).category,
    "内容の確認",
  );
  assert.equal(
    groupMailSuggestions([mail({ excerpt: "a".repeat(2000) })])[0].entries[0]
      .excerpt.length,
    240,
  );
});
test("会社名のない同じ件名もまとめるが、送信者不明の別アカウントは混ぜない", () => {
  assert.equal(
    groupMailSuggestions([
      mail({ title: "Re: 面談のご案内" }),
      mail({ title: "面談のご案内", accountId: "b" }),
    ]).length,
    1,
  );
  assert.equal(
    groupMailSuggestions([
      mail({ title: "案内", from: "" }),
      mail({ title: "案内", from: "", accountId: "b" }),
    ]).length,
    2,
  );
});
test("予定カードは終日の排他的終了日と日本時間の日付跨ぎを表示する", () => {
  assert.equal(
    calendarEventText({
      allDay: true,
      start: { date: "2026-11-14" },
      end: { date: "2026-11-15" },
    }),
    "2026-11-14・終日",
  );
  assert.equal(
    calendarEventText({
      allDay: true,
      start: { date: "2026-11-14" },
      end: { date: "2026-11-17" },
    }),
    "2026-11-14〜2026-11-16・終日",
  );
  const text = calendarEventText({
    start: { dateTime: "2026-11-14T14:30:00Z" },
    end: { dateTime: "2026-11-14T15:30:00Z" },
  });
  assert.match(text, /11\/14.*23:30/);
  assert.match(text, /11\/15.*0:30/);
});
