import test from "node:test";
import assert from "node:assert/strict";
import { extractMailTiming, timingRevisionNotice } from "../src/mail-timing.js";
import { groupMailSuggestions } from "../src/mail-suggestions.js";
import { messageTimingView } from "../src/timing-confirmations.js";
import { mailCaseView } from "../src/mail-cases.js";
import { digest } from "../src/agenda-rules.js";

const now = Date.parse("2026-11-17T03:00:00Z");
const mail = (excerpt) => ({
  kind: "mail", accountId: "a", messageId: "abc", title: "面接日程変更【検証株式会社】",
  from: "jobs@example.test", receivedAt: "2026-11-17T00:00:00Z", excerpt,
});

test("同じ記載の変更前・変更後を区別し、旧日時を優先から外して根拠に残す", () => {
  const entry = mail("面接日時 変更前：2026/11/16 10:00 → 変更後：2026/11/20 11:00");
  const before = structuredClone(entry);
  const group = groupMailSuggestions([entry], now)[0];
  assert.equal(group.referenceTimings.length, 1);
  assert.match(group.referenceTimings[0].display, /11\/16/);
  assert.match(group.referenceTimings[0].referenceReason, /変更前/);
  assert.equal(group.proposalTimings.length, 1);
  assert.match(group.proposalTimings[0].display, /11\/20/);
  assert.equal(group.proposalTimings[0].confirmed, false);
  assert.match(group.proposalTimings[0].changeNotice, /変更後/);
  assert.equal(group.priority.rank, 4);
  assert.equal(group.timings.length, 2);
  assert.deepEqual(entry, before);
});

test("同日の時刻変更、別行のラベル、全角を区別する", () => {
  for (const body of [
    "面接 変更前：2026/11/20 10:00 → 変更後：2026/11/20 11:00",
    "旧日程：\n２０２６年１１月２０日１０：００\n新日程：\n２０２６年１１月２０日１１：００",
  ]) {
    const rows = extractMailTiming(mail(body));
    assert.deepEqual(rows.map(timing => timingRevisionNotice(timing)?.state), ["previous", "revised"]);
  }
});

test("変更前しかない案内は新日時の確認を促し、期限超過や期限なしに誤分類しない", () => {
  const group = groupMailSuggestions([mail("旧締切：2026/11/15 17:00")], now)[0];
  assert.equal(group.proposalTimings.length, 0);
  assert.equal(group.referenceTimings.length, 1);
  assert.equal(group.priority.rank, 4);
  assert.equal(group.priority.label, "変更後の日時を確認");
});

test("条件・否定・同一時刻の新旧・ラベルなしの別日時は旧日時と断定しない", () => {
  for (const body of [
    "面接は変更前2026/11/20 10:00と同じです",
    "記入例 変更前2026/11/20 10:00",
    "面接は変更前2026/11/20 10:00ではなく調整中",
    "変更前2026/11/20 10:00 → 変更後2026/11/20 10:00",
  ]) {
    const group = groupMailSuggestions([mail(body)], now)[0];
    assert.equal(group.referenceTimings.length, 0, body);
    assert.ok(group.proposalTimings.every(row => !row.confirmed), body);
  }
  const rows = extractMailTiming(mail("変更前2026/11/20 10:00 面接2026/11/21 10:00"));
  assert.equal(timingRevisionNotice(rows[1]).state, "ambiguous");
  const normal = groupMailSuggestions([{...mail("面接日時：2026/11/20 10:00"),title:"面接案内"}], now)[0];
  assert.equal(normal.proposalTimings[0].confirmed, true);
  assert.equal(normal.proposalTimings[0].changeNotice, undefined);
});

test("新旧の分類で本人確定ID・確定値・案件の保存用版を変更しない", async () => {
  const entry = mail("面接 変更前：2026/11/16 10:00 → 変更後：2026/11/20 11:00");
  const message = { id: entry.messageId, subject: entry.title, from: entry.from, receivedAt: entry.receivedAt, excerpt: entry.excerpt };
  const view = await messageTimingView(message);
  for (const timing of view.timings) assert.equal(timing.timingId, await digest(timing.original));
  const old = view.timings[0];
  const records = { [message.id+":"+old.timingId]: {
    sourceRevision: view.sourceRevision, revision: crypto.randomUUID(), updatedAt: new Date(now).toISOString(),
    value: {kind:"event",action:"本人が確認した面接",date:"2026-11-21",time:"12:00",endDate:"",endTime:""},
  }};
  const confirmed = await messageTimingView(message, records);
  const group = groupMailSuggestions([{...entry,timings:confirmed.timings}], now)[0];
  const manual = group.proposalTimings.find(timing => timing.manual);
  assert.equal(manual.timingId, old.timingId);
  assert.equal(manual.date, "2026-11-21");
  assert.equal(manual.confirmed, true);
  assert.match(manual.changeNotice, /本人確定日時を維持/);
  const storage = {get:async()=>undefined};
  const actual = await mailCaseView(storage,[{id:"a"}],[group],now);
  const legacy = await mailCaseView(storage,[{id:"a"}],[{...group,proposalTimings:[],referenceTimings:[]}],now);
  assert.equal(actual.groups[0].caseState.sourceRevision,legacy.groups[0].caseState.sourceRevision);
  assert.deepEqual(records[message.id+":"+old.timingId].value,manual.editValue);
});
