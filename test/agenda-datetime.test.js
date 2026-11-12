import test from "node:test";
import assert from "node:assert/strict";
import { extractAppointment } from "../src/agenda-rules.js";

test("日本語の時・分・半と午前午後を日本時間の入力候補へ変換する", () => {
  for (const [range, start, end] of [
    ["14時から15時半まで", "14:00", "15:30"],
    ["午後2時〜3時", "14:00", "15:00"],
    ["午前10時30分～午前11時45分", "10:30", "11:45"],
    ["午後12時〜午後1時", "12:00", "13:00"],
    ["AM10:00 to AM11:00", "10:00", "11:00"],
    ["１４時３０分～１５時００分", "14:30", "15:00"],
  ]) {
    const value = extractAppointment(
      "面接",
      "日時：2027年1月12日(火) " + range,
    );
    assert.equal(value.start, "2027-01-12T" + start, range);
    assert.equal(value.end, "2027-01-12T" + end, range);
    assert.equal(value.status, "内容確認待ち", range);
  }
});
test("年省略・相対日付・曜日不一致・複数候補・取消・外国時間を確認待ちにする", () => {
  for (const body of [
    "1月12日(火) 14時〜15時",
    "明日14時〜15時",
    "2027/1/12(月) 14時〜15時",
    "2027年1月12日 水曜日 14時〜15時",
    "2027/1/12 14時〜15時 または2027/1/13 14時〜15時",
    "2027/1/12 14時〜15時 または16時〜17時",
    "日程変更：2027/1/12 14時〜15時",
    "キャンセル 2027/1/12 14時〜15時",
    "2027/1/12 14時〜15時 PST",
    "2027/1/12 23時〜1時",
    "2027/2/29 14時〜15時",
    "2027/1/12 14時〜25時",
    "2027/1/12 14時〜15時75分",
  ])
    assert.equal(extractAppointment("面接", body).status, "確認待ち", body);
  assert.equal(extractAppointment("面接", "1月12日14時〜15時").start, "");
});
test("件名と本文の同一日時の繰り返しを別候補扱いせず、一般メールは候補なしにする", () => {
  const v = extractAppointment(
    "面接 2027/1/12 14時〜15時",
    "日時：2027/1/12 14時〜15時",
  );
  assert.equal(v.status, "内容確認待ち");
  assert.equal(
    extractAppointment("ニュース", "新製品を紹介します").isCandidate,
    false,
  );
});
