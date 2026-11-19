import test from "node:test";
import assert from "node:assert/strict";
import { readMailPage } from "../src/agenda-mail.js";
import { retainImportantMailBodies } from "../src/mail-body-retention.js";
import { mergeMailLanes } from "../src/mail-retrieval.js";
import { messageTimingView } from "../src/timing-confirmations.js";
import { mailPriority } from "../src/agenda-priority.js";
import { priorityWithRules, emptyPriorityRules } from "../src/mail-priority-rules.js";
import { validBodyCoverage, maximumCachedTimingBytes } from "../src/mail-body-coverage.js";
const body="連絡事項\n".repeat(700)+"\n提出期限：2026/12/15 17:00";
function storage() {
  const values=new Map([["agenda:credential:a",{token:"fixture",expires:Date.now()+3600000}]]);
  return {values,get:async key=>structuredClone(values.get(key))};
}
function message(id,subject="セールのお知らせ") {
  return {id,subject,from:"notice@example.test",receivedAt:new Date().toISOString(),excerpt:body.slice(0,1600),timingText:body,bodyCoverage:"complete",priority:mailPriority({subject},body),candidate:{isCandidate:false}};
}
test("1ページの重要10通は32KiBを超えても締切を保持し、その他の本文だけを整理する",async()=>{
  const store=storage();
  const page=await readMailPage({},store,{id:"a",email:"a@example.test"},null,async url=>{
    const path=new URL(url).pathname;
    if(path.endsWith("/messages"))return Response.json({messages:Array.from({length:20},(_,i)=>({id:i.toString(16)}))});
    const id=path.split("/").at(-1);
    return Response.json({id,internalDate:String(Date.now()),payload:{mimeType:"text/plain",headers:[{name:"Subject",value:parseInt(id,16)<10?"選考の提出依頼":"セールのお知らせ"}],body:{data:Buffer.from(body).toString("base64url")}}});
  });
  const saved=mergeMailLanes(page.messages,[]);
  assert.equal(saved.length,20);
  for(const mail of saved) {
    if(parseInt(mail.id,16)<10) {
      assert.equal(mail.timingText,body);
      assert.ok((await messageTimingView(mail)).timings.some(t=>t.additional && t.date==="2026-12-15"));
    } else {
      assert.equal(mail.excerpt,"");assert.equal(mail.timingText,undefined);
      assert.equal(mail.bodyCoverage,"excluded");assert.ok(validBodyCoverage(mail));
    }
  }
  const bytes=saved.reduce((sum,m)=>sum+new TextEncoder().encode(m.timingText||"").length,0);
  assert.ok(bytes>32*1024 && bytes<=maximumCachedTimingBytes);
});
test("本人の優先・除外設定を本文整理より先に適用し、整理後の再判定で除外を取り消さない",async()=>{
  const store=storage();
  const rules={...emptyPriorityRules(),prioritySenders:["notice@example.test"],excludedKeywords:["対象外"]};
  store.values.set("agenda:priorityRules:a",{rules});
  const original=[message("a"),{...message("b","選考の提出依頼"),excerpt:"対象外"}];
  const kept=await retainImportantMailBodies(store,"a",original);
  assert.equal(kept[0].timingText,body);
  assert.equal(kept[1].bodyCoverage,"excluded");
  assert.equal(priorityWithRules(kept[1],rules).important,false);
  assert.equal(original[1].excerpt,"対象外");
});
test("確定日時・予定登録・結果不明と本文未取得は整理から保護し、記録を変更しない",async()=>{
  const store=storage();
  store.values.set("agenda:timingConfirmations:a",{"a:timing":{value:"fixture"}});
  store.values.set("agenda:pending:a",["b"]);
  store.values.set("agenda:operation:a:c",{phase:"登録結果未確認"});
  const before=structuredClone(store.values);
  const kept=await retainImportantMailBodies(store,"a",[message("a"),message("b"),message("c"),{...message("d"),bodyCoverage:"unavailable",timingText:undefined},message("e")]);
  assert.ok(kept.slice(0,4).every(m=>m.bodyRetention==="protected"));
  assert.ok(kept.slice(0,3).every(m=>m.timingText===body));
  assert.equal(kept[4].bodyCoverage,"excluded");
  assert.deepEqual(store.values,before);
});
test("新しい取得では重要になったメール本文を再保存できる",async()=>{
  const store=storage();
  assert.equal((await retainImportantMailBodies(store,"a",[message("a")]))[0].bodyCoverage,"excluded");
  store.values.set("agenda:priorityRules:a",{rules:{...emptyPriorityRules(),prioritySenders:["notice@example.test"]}});
  assert.equal((await retainImportantMailBodies(store,"a",[message("a")]))[0].timingText,body);
});

test("重要本文だけで総上限を超えた場合も省略を明示し、保護対象の削除は停止する", async()=>{
  const {limitTimingText}=await import('../src/mail-body-coverage.js');
  const important={...message('a','選考の提出依頼'),bodyRetention:'important'};
  const other={...message('b','選考の提出依頼'),bodyRetention:'important'};
  const oneSize=new TextEncoder().encode(important.timingText).length;
  const limited=limitTimingText([important,other],oneSize);
  assert.equal(limited[0].timingText,body);
  assert.equal(limited[1].bodyCoverage,'capacity');
  assert.throws(()=>limitTimingText([{...important,bodyRetention:'protected'}],1),/保護対象/);
});

test("本文整理後の設定プレビューは再取得が必要な件数を明示する",async()=>{
  const {previewPriorityRules}=await import('../src/mail-priority-rules.js');
  const store=storage();
  store.values.set('agenda:accounts',[{id:'a',email:'a@example.test'}]);
  store.values.set('agenda:cache:a',{messages:await retainImportantMailBodies(store,'a',[message('a')])});
  const preview=await previewPriorityRules(store,{accountId:'a',rules:{...emptyPriorityRules(),prioritySenders:['notice@example.test']}});
  assert.equal(preview.unavailableCount,1);
});

test("Cron経路で分割取得・再起動・通信再試行を経ても重要本文と不要本文の整理を確定する",async()=>{
  const {queueMailSync,runMailBatch}=await import('../src/mail-scheduler.js');
  const now=Date.now();
  function durableMemory(records) {
    const store={
      records,
      get:async key=>structuredClone(records.get(key)),
      put:async(key,value)=>records.set(key,structuredClone(value)),
      delete:async key=>records.delete(key),
    };
    store.transaction=async action=>action(store);
    return store;
  }
  let store=durableMemory(new Map([
    ['agenda:accounts',[{id:'a',email:'a@example.test'}]],
    ['agenda:credential:a',{token:'fixture',expires:now+3600000}],
    ['agenda:cache:a',{messages:[message('ff','選考の提出依頼')],lastSuccess:new Date(now-3600000).toISOString()}],
  ]));
  let fail=false;
  const send=async url=>{
    const endpoint=new URL(url);
    if(fail) throw Error('simulated network failure');
    if(endpoint.pathname.endsWith('/messages')) {
      const second=endpoint.searchParams.get('pageToken')==='page2';
      return Response.json({messages:Array.from({length:20},(_,i)=>({id:(i+(second?20:0)).toString(16)})),...(second?{}:{nextPageToken:'page2'})});
    }
    const id=endpoint.pathname.split('/').at(-1);
    return Response.json({id,internalDate:String(now),payload:{mimeType:'text/plain',headers:[{name:'Subject',value:parseInt(id,16)%20<5?'選考の提出依頼':'セールのお知らせ'}],body:{data:Buffer.from(body).toString('base64url')}}});
  };
  await queueMailSync(store,now); // sourceの既定値は実Cronと同じcron。
  let job=await store.get('agenda:mailJob');
  await runMailBatch({},store,send,job.nextAt);
  assert.equal((await store.get('agenda:cache:a')).messages[0].id,'ff');
  // 保存した途中状態から再起動する。通信失敗でも前回成功の一覧を残す。
  store=durableMemory(structuredClone(store.records));
  fail=true;
  job=await store.get('agenda:mailJob');
  await runMailBatch({},store,send,job.nextAt);
  assert.equal((await store.get('agenda:cache:a')).messages[0].id,'ff');
  job=await store.get('agenda:mailJob');
  assert.equal(job.retries,1);
  fail=false;
  await runMailBatch({},store,send,job.nextAt);
  const cache=await store.get('agenda:cache:a');
  assert.equal(cache.error,null);
  assert.equal(cache.messages.length,40);
  assert.equal(cache.messages.filter(m=>m.bodyCoverage==='excluded').length,30);
  assert.equal(cache.messages.filter(m=>m.timingText===body).length,10);
  assert.equal(cache.messages.filter(m=>m.bodyCoverage==='capacity').length,0);
  assert.equal(await store.get('agenda:mailJob'),undefined);
  const history=await store.get('agenda:history:a');
  assert.equal(history[0].source,'cron');
  assert.equal(history[0].outcome,'success');
  assert.equal(history[0].pages,2);
  assert.equal(history[1].outcome,'failure');
});

test("取得時に本文後半で重要と判定したメールを整理せず、締切候補まで保持する",async()=>{
  const store=storage();
  const page=await readMailPage({},store,{id:'a',email:'a@example.test'},null,async url=>{
    if(new URL(url).pathname.endsWith('/messages'))return Response.json({messages:[{id:'abc'}]});
    return Response.json({id:'abc',internalDate:String(Date.now()),payload:{mimeType:'text/plain',headers:[{name:'Subject',value:'採用に関するご連絡'}],body:{data:Buffer.from(body).toString('base64url')}}});
  });
  const saved=mergeMailLanes(page.messages,[])[0];
  assert.equal(saved.bodyRetention,'important');
  assert.equal(saved.timingText,body);
  assert.ok((await messageTimingView(saved)).timings.some(t=>t.additional && t.date==='2026-12-15'));
});
