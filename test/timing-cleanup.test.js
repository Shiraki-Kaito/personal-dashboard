import test from "node:test";
import assert from "node:assert/strict";
import { prepareTimingCleanup, cleanupTimings } from "../src/timing-cleanup.js";
import { messageTimingView, readTimingConfirmation, saveTimingConfirmation } from "../src/timing-confirmations.js";
import { timingOperationId } from "../src/timing-calendar.js";
import { previewAppointment } from "../src/agenda.js";

const now=Date.parse("2026-11-17T03:00:00Z");
const value={kind:"deadline",action:"提出する",date:"2026-12-01",time:"17:00",endDate:"",endTime:""};
function memory() {
  const values=new Map();
  const storage={values,get:async key=>structuredClone(values.get(key)),put:async(key,value)=>values.set(key,structuredClone(value)),delete:async key=>values.delete(key),
    list:async({prefix,limit})=>new Map([...values].filter(([key])=>key.startsWith(prefix)).slice(0,limit))};
  storage.transaction=async fn=>fn(storage);
  return storage;
}
async function fixture() {
  const storage=memory();
  const message={id:"abc",subject:"提出依頼",from:"fixture@example.test",receivedAt:new Date(now).toISOString(),excerpt:"提出期限：2026/12/1 17:00"};
  const timing=(await messageTimingView(message)).timings[0];
  const id="abc:"+timing.timingId;
  const record={sourceRevision:timing.sourceRevision,revision:crypto.randomUUID(),updatedAt:new Date(now).toISOString(),value};
  await storage.put("agenda:accounts",[{id:"a",email:"a@example.test"},{id:"b",email:"b@example.test"}]);
  await storage.put("agenda:cache:a",{messages:[]});
  await storage.put("agenda:timingConfirmations:a",{[id]:record});
  await storage.put("agenda:timingConfirmations:b",{[id]:record});
  return {storage,message,timing,id,record};
}

test("一覧外だけを選択して整理し、他アカウント・メール・関連しない記録を変更しない",async()=>{
  const {storage,id,record}=await fixture();
  const other="def:"+"a".repeat(64);
  await storage.put("agenda:timingConfirmations:a",{[id]:record,[other]:{...record,value:null}});
  await storage.put("agenda:operation:b:unrelated",{phase:"登録結果未確認",draft:{title:"別の予定"}});
  const beforeOther=await storage.get("agenda:timingConfirmations:b");
  const plan=await prepareTimingCleanup(storage,{accountId:"a"},now);
  assert.equal(plan.eligibleCount,2);
  const result=await cleanupTimings(storage,{accountId:"a",selected:[id],checksum:plan.checksum,confirm:true},now);
  assert.deepEqual(result.removed,[id]);
  assert.equal(result.remaining,1);
  assert.ok((await storage.get("agenda:timingConfirmations:a"))[other]);
  assert.deepEqual(await storage.get("agenda:timingConfirmations:b"),beforeOther);
  assert.deepEqual(await storage.get("agenda:cache:a"),{messages:[]});
  assert.equal((await storage.get("agenda:operation:b:unrelated")).draft.title,"別の予定");
});

test("一覧内・結果未確認・確認済み登録・他アカウントの参照・期限切れプレビュー・索引を保護する",async()=>{
  for(const kind of ["listed","pendingOperation","confirmedOperation","foreignReference","expiredPreview","pendingIndex","historyIndex","mailJob"]){
    const {storage,message,timing,id}=await fixture();
    const operationId=await timingOperationId({messageId:message.id,timingId:timing.timingId});
    if(kind==="listed")await storage.put("agenda:cache:a",{messages:[message]});
    if(kind==="pendingOperation" || kind==="confirmedOperation")await storage.put("agenda:operation:a:"+operationId,{phase:kind==="confirmedOperation"?"登録確認済み":"登録結果未確認"});
    if(kind==="foreignReference")await storage.put("agenda:operation:b:foreign",{phase:"登録確認済み",timingRef:{messageId:message.id,timingId:timing.timingId}});
    if(kind==="expiredPreview")await storage.put("agenda:preview:a:"+operationId,{expires:now-1});
    if(kind==="pendingIndex")await storage.put("agenda:pending:a",[operationId]);
    if(kind==="historyIndex")await storage.put("agenda:manualHistory:a",[operationId]);
    if(kind==="mailJob")await storage.put("agenda:mailJob",{accountIds:["a"],index:0});
    const plan=await prepareTimingCleanup(storage,{accountId:"a"},now);
    assert.equal(plan.rows[0].eligible,false,kind);
    assert.ok(plan.rows[0].reasons.length,kind);
    await assert.rejects(cleanupTimings(storage,{accountId:"a",selected:[id],checksum:plan.checksum,confirm:true},now));
    assert.ok((await storage.get("agenda:timingConfirmations:a"))[id],kind);
  }
});

test("確認後の変更・期限切れ・使い回し・二重操作では一部も整理しない",async()=>{
  for(const change of ["record","cache","operation","preview","pending","history","job","expired","checksum"]){
    const {storage,message,id,record}=await fixture();
    const plan=await prepareTimingCleanup(storage,{accountId:"a"},now);
    if(change==="record")await storage.put("agenda:timingConfirmations:a",{[id]:{...record,revision:crypto.randomUUID()}});
    if(change==="cache")await storage.put("agenda:cache:a",{messages:[message]});
    if(change==="operation")await storage.put("agenda:operation:b:new",{});
    if(change==="preview")await storage.put("agenda:preview:a:new",{});
    if(change==="pending")await storage.put("agenda:pending:a",["new"]);
    if(change==="history")await storage.put("agenda:manualHistory:a",["new"]);
    if(change==="job")await storage.put("agenda:mailJob",{accountIds:["a"],index:0});
    const before=await storage.get("agenda:timingConfirmations:a");
    await assert.rejects(cleanupTimings(storage,{accountId:"a",selected:[id],checksum:change==="checksum"?"wrong":plan.checksum,confirm:true},change==="expired"?now+600000:now));
    assert.deepEqual(await storage.get("agenda:timingConfirmations:a"),before);
  }
  const {storage,id}=await fixture();
  const plan=await prepareTimingCleanup(storage,{accountId:"a"},now);
  const input={accountId:"a",selected:[id],checksum:plan.checksum,confirm:true};
  await cleanupTimings(storage,input,now);
  await assert.rejects(cleanupTimings(storage,input,now));
  const afterLoss=await prepareTimingCleanup(storage,{accountId:"a"},now);
  assert.equal(afterLoss.count,0);
});

test("確認不足・空選択・重複・別の対象・選択混入を拒否する",async()=>{
  const {storage,id}=await fixture();
  const plan=await prepareTimingCleanup(storage,{accountId:"a"},now);
  const base={accountId:"a",checksum:plan.checksum,confirm:true,selected:[id]};
  for(const override of [{confirm:false},{selected:[]},{selected:[id,id]},{accountId:"b"},{selected:[id,"bad"]}]){
    await assert.rejects(cleanupTimings(storage,{...base,...override},now));
    assert.ok((await storage.get("agenda:timingConfirmations:a"))[id]);
  }
});

test("整理前の未保存フォームを復活させず、残る確定値と新しいフォームの保存を維持する",async()=>{
  const {storage,message,timing,id,record}=await fixture();
  const otherMessage={...message,id:"def"};
  const otherTiming=(await messageTimingView(otherMessage)).timings[0];
  const otherId="def:"+otherTiming.timingId;
  await storage.put("agenda:timingConfirmations:a",{[id]:record,[otherId]:{...record,sourceRevision:otherTiming.sourceRevision}});
  const plan=await prepareTimingCleanup(storage,{accountId:"a"},now);
  await cleanupTimings(storage,{accountId:"a",checksum:plan.checksum,confirm:true,selected:[id]},now);
  await storage.put("agenda:cache:a",{messages:[message,otherMessage]});
  const input={accountId:"a",messageId:"abc",timingId:timing.timingId,sourceRevision:timing.sourceRevision,expectedRevision:null,value,confirm:true};
  await assert.rejects(saveTimingConfirmation(storage,input,now),/整理・復元/);
  const surviving=await readTimingConfirmation(storage,{accountId:"a",messageId:"def"});
  assert.ok(surviving.timings[0].manual);
  assert.deepEqual(surviving.timings[0].editValue,value);
  const current=await readTimingConfirmation(storage,{accountId:"a",messageId:"abc"});
  const saved=await saveTimingConfirmation(storage,{...input,collectionRevision:current.collectionRevision},now);
  assert.ok(saved.timings[0].manual);
});

test("関連記録の調査上限を超えたら整理計画を作らない",async()=>{
  for(const namespace of ["operation","preview"]){
    const {storage}=await fixture();
    for(let index=0;index<5001;index++)await storage.put("agenda:"+namespace+":b:"+index,{});
    await assert.rejects(prepareTimingCleanup(storage,{accountId:"a"},now),/調査上限/);
    assert.equal(await storage.get("agenda:timingCleanupPlan:a"),undefined);
  }
});

test("外部の予定照合中に整理された確定日時へ、後からプレビューを作らない",async()=>{
  const {storage,message,timing,record}=await fixture();
  await storage.put("agenda:accounts",[{id:"a",email:"a@example.test",calendar:"primary"}]);
  await storage.put("agenda:credential:a",{token:"fixture",expires:Date.now()+3600000});
  await storage.put("agenda:cache:a",{messages:[message]});
  const operationId=await timingOperationId({messageId:"abc",timingId:timing.timingId});
  const ref={messageId:"abc",timingId:timing.timingId,sourceRevision:timing.sourceRevision,revision:record.revision};
  const input={accountId:"a",targetAccountId:"a",messageId:operationId,manual:true,timingRef:ref,
    draft:{title:"検証用",start:"2026-12-01T17:00",end:"2026-12-01T17:05",location:""}};
  let cleaned=false;
  await assert.rejects(previewAppointment({},storage,input,async()=>{
    await storage.put("agenda:cache:a",{messages:[]});
    const plan=await prepareTimingCleanup(storage,{accountId:"a"},now);
    await cleanupTimings(storage,{accountId:"a",selected:["abc:"+timing.timingId],checksum:plan.checksum,confirm:true},now);
    cleaned=true;
    return Response.json({kind:"calendar#events",timeZone:"Asia/Tokyo",items:[]});
  }));
  assert.equal(cleaned,true);
  assert.equal(await storage.get("agenda:preview:a:"+operationId),undefined);
});
