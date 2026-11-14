import test from "node:test";
import assert from "node:assert/strict";
import { extractMailTiming, timingPriority } from "../src/mail-timing.js";
import { groupMailSuggestions } from "../src/mail-suggestions.js";
const now = Date.parse("2026-11-14T03:00:00Z");
const mail = (excerpt, rest = {}) => ({
  kind: "mail",
  accountId: "a",
  messageId: "1",
  title: "書類の提出【サンプル株式会社】",
  from: "jobs@example.test",
  excerpt,
  receivedAt: "2026-11-14T01:00:00Z",
  ...rest,
});

test("提出締切と面接時間を別々の行動に結び付け、根拠と日本時間を返す", () => {
  const rows = extractMailTiming(
    mail(
      "成績証明書の提出期限：2026年11月15日（日）午後5時。面接日時：2026/11/16 10:00〜11:00",
    ),
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].action, "成績証明書を提出する");
  assert.equal(rows[0].kind, "deadline");
  assert.equal(rows[0].display, "2026/11/15 17:00");
  assert.equal(rows[0].startAt, Date.parse("2026-11-15T17:00:00+09:00"));
  assert.equal(rows[0].confirmed, true);
  assert.equal(rows[1].kind, "event");
  assert.equal(rows[1].confirmed, true);
  assert.match(rows[1].display, /10:00〜11:00/);
  assert.match(rows[0].evidence, /提出期限/);
});
test("見出しの次行の日付、全角と午前午後を読み、日付だけなら時刻を創作しない", () => {
  const [row] = extractMailTiming(mail("回答期限：\n２０２６年１１月１４日"));
  assert.equal(row.kind, "deadline");
  assert.equal(row.confirmed, true);
  assert.equal(row.startAt, null);
  assert.match(row.display, /時刻記載なし/);
  assert.equal(timingPriority([row], false, now).label, "今日が締切");
  assert.equal(
    extractMailTiming(mail("面談日時：2026/11/15 午後1時半〜2時"))[0].display,
    "2026/11/15 13:30〜14:00",
  );
});
test("年省略・相対日付・存在しない日・曜日不一致・外国時間を確定させない", () => {
  for (const text of [
    "締切：11月15日 17:00",
    "回答期限は明日です",
    "締切：2026/2/30 17:00",
    "締切：2026/11/15（月）17:00",
    "締切：2026/11/15 17:00 PST",
    "締切：2026/11/15 25:00",
  ]) {
    const rows = extractMailTiming(mail(text));
    assert.ok(rows.length, text);
    assert.equal(rows[0].confirmed, false, text);
    assert.equal(timingPriority(rows, false, now).rank, 4, text);
  }
});
test("候補・取消・変更前・複数日・複数締切時刻は確認待ちにする", () => {
  for (const text of [
    "面接候補：2026/11/15 10:00〜11:00",
    "面接中止：2026/11/15 10:00",
    "旧日程：2026/11/15 10:00",
    "締切：2026/11/15 または2026/11/16",
    "締切：2026/11/15 10:00〜17:00",
  ]) {
    assert.ok(
      extractMailTiming(mail(text)).every((row) => !row.confirmed),
      text,
    );
  }
});
test("引用と受付通知の古い依頼を再提出の期限として採用しない", () => {
  const quoted = extractMailTiming(
    mail(
      "ご案内を確認してください\n> 提出期限：2026/11/10 17:00\n-----Original Message-----\n締切：2026/11/09",
    ),
  );
  assert.equal(quoted.length, 0);
  assert.deepEqual(
    extractMailTiming(
      mail("提出期限：2026/11/10 17:00", {
        title: "提出ありがとうございます【サンプル株式会社】",
      }),
    ),
    [],
  );
});
test("登録結果未確認・超過・今日・3日以内・要確認・今後・期限なし・受付の順に並べる", () => {
  const entries = [
    mail("受付完了", { title: "提出ありがとうございます【受付株式会社】" }),
    mail("締切：2026/12/01 17:00", { title: "書類【将来株式会社】" }),
    mail("締切：11/15 17:00", { title: "書類【曖昧株式会社】" }),
    mail("提出期限：2026/11/16 17:00", { title: "書類【近い株式会社】" }),
    mail("締切：2026/11/14 17:00", { title: "書類【今日株式会社】" }),
    mail("締切：2026/11/13 17:00", { title: "書類【過去株式会社】" }),
    mail("日付記載なし", { title: "お知らせ【未指定株式会社】" }),
    mail("", { kind: "pending", messageId: "pending", title: "結果不明" }),
  ];
  const before = structuredClone(entries),
    groups = groupMailSuggestions(entries, now);
  assert.deepEqual(
    groups.map((g) => g.priority.rank),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
  assert.deepEqual(entries, before);
});
test("別アカウントの受付通知で未対応の締切を隠さず、同一宛先の旧案内を昇格させない", () => {
  const groups = groupMailSuggestions(
    [
      mail("締切：2026/11/15 17:00", {
        messageId: "old",
        receivedAt: "2026-11-13T01:00:00Z",
      }),
      mail("締切：2026/11/16 17:00", { messageId: "new" }),
      mail("締切：2026/11/10 17:00", {
        accountId: "b",
        title: "提出ありがとうございます【サンプル株式会社】",
        receivedAt: "2026-11-14T02:00:00Z",
      }),
    ],
    now,
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].timings.length, 1);
  assert.equal(groups[0].timings[0].messageId, "new");
  assert.match(groups[0].timings[0].display, /11\/16/);
  assert.equal(groups[0].priority.rank, 3);
});
test("日本時間で日付境界と時刻なし期限の期限超過を判定する", () => {
  const rows = extractMailTiming(mail("提出期限：2026/11/14"));
  assert.equal(
    timingPriority(rows, false, Date.parse("2026-11-14T14:59:59Z")).rank,
    2,
  );
  assert.equal(
    timingPriority(rows, false, Date.parse("2026-11-14T15:00:00Z")).rank,
    1,
  );
  const event = extractMailTiming(mail("面接日時：2026/11/14 11:00〜13:00"));
  assert.equal(timingPriority(event, false, now).rank, 3);
});

test("提案内も締切を先にし、同じ優先度の確定日時は早い順を保つ", () => {
  const groups = groupMailSuggestions(
    [mail("面接候補：11/27 10:00。提出期限：11/15。面接候補：12/3 10:00")],
    now,
  );
  assert.equal(groups[0].timings[0].kind, "deadline");
  assert.match(groups[0].timings[0].display, /11\/15/);
  const ordered = groupMailSuggestions(
    [mail("提出期限：2026/11/16 18:00。回答期限：2026/11/15 17:00")],
    now,
  );
  assert.match(ordered[0].timings[0].display, /11\/15/);
});

test("件名が取消・変更の案内は本文の日時も確定させず、秒やISO時刻の一部を誤読しない", () => {
  const canceled = extractMailTiming(
    mail("ご連絡です。\n詳細をご確認ください。\n面接日時：2026/11/16 10:00", {
      title: "面接キャンセルのお知らせ",
    }),
  );
  assert.equal(canceled[0].confirmed, false);
  for (const text of [
    "面接日時：2026-11-16T17:00:00+09:00",
    "締切：2026/11/16 17:00:30",
  ]) {
    const [row] = extractMailTiming(mail(text));
    assert.equal(row.confirmed, false);
    assert.equal(row.startAt, null);
    assert.match(row.display, /時刻要確認/);
  }
});
