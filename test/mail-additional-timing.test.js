import test from "node:test";
import assert from "node:assert/strict";
import { messageTimingView, saveTimingConfirmation } from "../src/timing-confirmations.js";
import { requireConfirmedTiming } from "../src/timing-calendar.js";
import { extractMailTiming } from "../src/mail-timing.js";
import { digest } from "../src/agenda-rules.js";
import { readMailPage } from "../src/agenda-mail.js";
import { mailBodyNotice, limitTimingText, validBodyCoverage } from "../src/mail-body-coverage.js";
import { groupMailSuggestions } from "../src/mail-suggestions.js";
import { mailCaseView } from "../src/mail-cases.js";

const now = Date.parse("2026-11-17T03:00:00Z");
const message = (text) => ({
  id: "abc", subject: "面接のお知らせ【検証株式会社】", from: "jobs@example.test",
  receivedAt: new Date(now).toISOString(), excerpt: text.slice(0, 1600),
  timingText: text, bodyCoverage: "complete", contentLimited: text.length > 1600,
});
const longText = "面接日時：11/25 10:00\n" + "通常の連絡文\n".repeat(250) + "\n回答期限：2026/11/27 17:00";
function memory(messageValue) {
  const values = new Map([
    ["agenda:accounts", [{ id: "a", email: "a@example.test", calendar: "primary" }]],
    ["agenda:credential:a", { token: "fixture", expires: Date.now() + 3600000 }],
    ["agenda:cache:a", { messages: messageValue ? [messageValue] : [] }],
  ]);
  const storage = {
    get: async key => structuredClone(values.get(key)),
    put: async (key, value) => values.set(key, structuredClone(value)),
    list: async ({ prefix }) => new Map([...values].filter(([key]) => key.startsWith(prefix))),
  };
  storage.transaction = async callback => callback(storage);
  return storage;
}

test("先頭1600文字より後の締切を補い、従来の抽出ID・元本文を維持する", async () => {
  const original = message(longText), before = structuredClone(original);
  const view = await messageTimingView(original);
  assert.ok(view.timings.some(row => row.additional && row.date === "2026-11-27"));
  const baseline = extractMailTiming({kind:"mail",title:original.subject,excerpt:original.excerpt});
  for (const row of baseline) {
    const expectedId = await digest(row);
    assert.ok(view.timings.some(timing => timing.timingId === expectedId));
  }
  assert.deepEqual(original, before);
  assert.match(view.notice, /6,000文字/);
  assert.ok(view.timings.filter(row => row.additional).every(row => !row.confirmed));
  const sameDay = "履歴書の提出期限：2026/12/1 17:00\n" + "連絡\n".repeat(600) + "\n成績証明書の提出期限：2026/12/1 17:00";
  const sameDayView = await messageTimingView(message(sameDay));
  assert.ok(sameDayView.timings.some(row=>row.additional && row.evidence.includes("成績証明書")));
});

test("英語月名・省略形・日月順・午前午後を候補にし、年省略・外国時間・不正日は確定しない", async () => {
  for (const [text, date, clock] of [
    ["Interview: November 20, 2026 3:30 PM JST", "2026-11-20", "15:30"],
    ["Deadline: 20 Nov 2026 10 AM", "2026-11-20", "10:00"],
    ["Meeting: Nov. 20th, 2026 12 PM PST", "2026-11-20", "12:00"],
    ["Due: November 20 5 PM", null, null],
    ["Interview: February 30, 2026 10 AM", null, null],
  ]) {
    const view = await messageTimingView(message(text));
    const row = view.timings.find(row => row.additional);
    assert.ok(row, text);
    assert.equal(row.date, date, text);
    assert.equal(row.confirmed, false, text);
    if (clock) assert.equal(row.editValue.time, clock);
    assert.match(row.evidence, /Nov|Feb/);
    assert.match(row.reasons.join(" "), /タイムゾーン/);
  }
});

test("追加範囲の引用・転送・署名の日時やリンク先を読み取った扱いにしない", async () => {
  for (const boundary of ["-----Original Message-----", "From: old@example.test", "--"]) {
    const text = "連絡\n".repeat(450) + "\n" + boundary + "\nInterview: November 20, 2026 10 AM\n面接日時：2026/11/21 10:00";
    const view = await messageTimingView(message(text));
    assert.equal(view.timings.filter(row => row.additional).length, 0);
  }
});

test("追加候補を本人確定・再取得でき、追加本文変更で旧確定の転用・カレンダー登録を止める", async () => {
  const original = message(longText), storage = memory(original);
  const view = await messageTimingView(original);
  const timing = view.timings.find(row => row.additional);
  const input = {
    accountId:"a",messageId:"abc",timingId:timing.timingId,sourceRevision:view.sourceRevision,
    expectedRevision:null,confirm:true,
    value:{kind:"deadline",action:"回答する",date:"2026-11-27",time:"17:00",endDate:"",endTime:""},
  };
  const saved = await saveTimingConfirmation(storage, input, now);
  const confirmed = saved.timings.find(row => row.timingId === timing.timingId);
  assert.ok(confirmed.manual);
  const ref = {messageId:"abc",timingId:timing.timingId,sourceRevision:view.sourceRevision,revision:confirmed.revision};
  assert.equal((await requireConfirmedTiming(storage,"a",ref)).date,"2026-11-27");
  await storage.put("agenda:cache:a",{messages:[{...original,timingText:original.timingText+"\n別の追記"}]});
  await assert.rejects(requireConfirmedTiming(storage,"a",ref),/変更|元メール/);
  const records = await storage.get("agenda:timingConfirmations:a");
  const refreshed = await messageTimingView({...original,timingText:original.timingText+"\n別の追記"},records);
  assert.match(refreshed.notice,/以前の確定/);
  assert.ok(!refreshed.timings.some(row => row.additional && row.manual));
});

test("追加本文を取得しただけでは既存の案件の対応済み・保留照合を変えない", async () => {
  const original = message(longText);
  const {timingText,bodyCoverage,...legacy} = original;
  const entry = (source, timings) => ({kind:"mail",accountId:"a",messageId:source.id,title:source.subject,from:source.from,excerpt:source.excerpt,receivedAt:source.receivedAt,timings});
  const oldGroups = groupMailSuggestions([entry(legacy,(await messageTimingView(legacy)).timings)],now);
  const newGroups = groupMailSuggestions([entry(original,(await messageTimingView(original)).timings)],now);
  const empty = {get:async()=>undefined};
  const before = await mailCaseView(empty,[{id:"a"}],oldGroups,now);
  const after = await mailCaseView(empty,[{id:"a"}],newGroups,now);
  assert.equal(before.groups[0].caseState.sourceRevision,after.groups[0].caseState.sourceRevision);
  for (const row of (await messageTimingView(legacy)).timings)
    assert.ok((await messageTimingView(original)).timings.some(timing => timing.timingId === row.timingId));
});

test("本文取得と保存の上限、参照だけの本文、空本文、旧キャッシュを明示する", async () => {
  const payloads = [
    {mimeType:"text/plain",body:{data:Buffer.from("連絡".repeat(4000)).toString("base64url")}},
    {mimeType:"text/plain",body:{attachmentId:"reference"}},
    {mimeType:"text/plain",body:{}},
  ];
  for (const [index,payload] of payloads.entries()) {
    const result = await readMailPage({},memory(null),{id:"a",email:"a@example.test"},null,async url => {
      if(new URL(url).pathname.endsWith("/messages"))return Response.json({messages:[{id:"abc"}]});
      return Response.json({id:"abc",internalDate:String(now),snippet:index===2?"":"抜粋",payload:{...payload,headers:[{name:"Subject",value:"面接日時のご連絡"}]}});
    });
    const mail = result.messages[0];
    assert.equal(mail.bodyCoverage,index===0?"partial":"unavailable");
    assert.ok(mail.contentLimited);
    assert.match(mailBodyNotice(mail),/確認できていません/);
    assert.ok((mail.timingText || "").length <= 6000);
  }
  const expanded = message(longText);
  const limited = limitTimingText([expanded],1)[0];
  assert.equal(limited.timingText,undefined);
  assert.equal(limited.excerpt,expanded.excerpt);
  assert.equal(limited.bodyCoverage,"capacity");
  assert.match(mailBodyNotice(limited),/保存容量/);
  assert.match(mailBodyNotice({excerpt:"a".repeat(1600)}),/原文全体を確認できていません/);
  assert.equal(validBodyCoverage({...expanded,timingText:"unrelated"}),false);
  assert.equal(validBodyCoverage({...expanded,timingText:"a".repeat(6001)}),false);
});

test("追加日時20件上限の省略を表示し、末尾まで確認済みと扱わない", async () => {
  const text = "連絡\n".repeat(600)+Array.from({length:25},(_,index)=>`面接日時：2026/12/${index+1} 10:00`).join("\n");
  const view = await messageTimingView(message(text));
  assert.equal(view.timings.filter(row=>row.additional).length,20);
  assert.match(view.notice,/ほか5件は省略/);
});

test("複数メールの追加保存量をUTF-8バイトで制限し、メール自体は全件保持する", () => {
  const mails = Array.from({length:100},(_,index)=>({...message("あ".repeat(6000)),id:index.toString(16)}));
  const retained = limitTimingText(mails);
  const bytes = retained.reduce((total,mail)=>total+new TextEncoder().encode(mail.timingText || "").length,0);
  assert.equal(retained.length,100);
  assert.ok(bytes<=256*1024);
  assert.ok(retained.some(mail=>mail.bodyCoverage==="capacity"));
  assert.deepEqual(retained.map(mail=>mail.id),mails.map(mail=>mail.id));
  assert.equal(mails[99].timingText.length,6000);
  const first = {...message("a".repeat(6000)),id:"1",priority:{important:false}};
  const important = {...message("b".repeat(6000)),id:"2",priority:{important:true}};
  const selected = limitTimingText([first,important],6000);
  assert.equal(selected[0].bodyCoverage,"capacity");
  assert.equal(selected[1].timingText,important.timingText);
  assert.deepEqual(selected.map(mail=>mail.id),["1","2"]);
});
