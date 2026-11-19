import test from "node:test";
import assert from "node:assert/strict";
import { reviewMailBody, mailBodyRevision } from "../src/mail-body-review.js";
import { readMailPage } from "../src/agenda-mail.js";
import { priorityWithRules } from "../src/mail-priority-rules.js";
import { mailPriority } from "../src/agenda-priority.js";
import { maximumCachedTimingBytes } from "../src/mail-body-coverage.js";

const now=Date.now();
const body="通常の連絡\n".repeat(400)+"提出期限：2026/12/15 17:00";
function fixture() {
  const message={id:"abc",subject:"確認したいお知らせ",from:"sender@example.test",receivedAt:new Date(now-86400000).toISOString(),excerpt:"",bodyCoverage:"excluded",bodyRetention:"excluded",contentLimited:true,priority:mailPriority({subject:"確認したいお知らせ"}),candidate:{title:"",start:"",end:"",location:"",isCandidate:false,reasons:[],status:"確認待ち"}};
  const records=new Map([
    ['agenda:accounts',[{id:'a',email:'a@example.test'}]],
    ['agenda:credential:a',{token:'fixture',expires:now+3600000}],
    ['agenda:cache:a',{lastSuccess:message.receivedAt,messages:[message,{...message,id:'def'}],standardIds:['abc','def'],priorityIds:[],nextPageToken:'more'}],
    ['agenda:reviews:a',{def:{reviewedAt:message.receivedAt}}],
  ]);
  const storage={records,get:async key=>structuredClone(records.get(key)),put:async(key,value)=>records.set(key,structuredClone(value))};
  let transactionTail=Promise.resolve();
  storage.transaction=fn=>{
    const result=transactionTail.then(()=>fn(storage));
    transactionTail=result.catch(()=>{});
    return result;
  };
  return {storage,message};
}
async function input(message, keepBody=true) {return {accountId:'a',messageId:message.id,revision:await mailBodyRevision(message),keepBody,confirm:true};}
function sender(calls, status=200, text=body) {return async(url,options)=>{
  calls.push({path:new URL(url).pathname,method:options?.method || 'GET'});
  if(status!==200)return Response.json({error:{message:'private error'}},{status});
  const id=new URL(url).pathname.split('/').at(-1);
  if(id==='messages')return Response.json({messages:[{id:'abc'}]});
  return Response.json({id,internalDate:String(now-86400000),payload:{mimeType:'text/plain',headers:[{name:'Subject',value:'確認したいお知らせ'}],body:{data:Buffer.from(text).toString('base64url')}}});
};}

test('選択した1通だけをGETで再取得し、本人指定と本文を保存する',async()=>{
  const {storage,message}=fixture(), calls=[];
  const before=await storage.get('agenda:cache:a');
  await reviewMailBody({},storage,await input(message),sender(calls),now);
  const saved=await storage.get('agenda:cache:a');
  assert.deepEqual(calls,[{path:'/gmail/v1/users/me/messages/abc',method:'GET'}]);
  assert.equal(saved.messages[0].timingText,body);
  assert.equal(saved.messages[0].keepBody,true);
  assert.equal(priorityWithRules(saved.messages[0]).important,true);
  assert.equal(saved.lastSuccess,before.lastSuccess);
  assert.equal(saved.nextPageToken,'more');
  assert.deepEqual(saved.messages[1],before.messages[1]);
  assert.ok((await storage.get('agenda:reviews:a')).def);
  const page=await readMailPage({},storage,{id:'a',email:'a@example.test'},null,sender([]));
  assert.equal(page.messages[0].keepBody,true);
  assert.equal(page.messages[0].timingText,body);
  assert.equal(page.messages[0].bodyRetention,'protected');
});

test('解除は本人指定だけを外し、自動判定・確定日時の保護を適用する',async()=>{
  const {storage,message}=fixture();
  await reviewMailBody({},storage,await input(message),sender([]),now);
  let saved=(await storage.get('agenda:cache:a')).messages[0];
  await reviewMailBody({},storage,await input(saved,false),()=>{throw Error('unexpected network');},now);
  saved=(await storage.get('agenda:cache:a')).messages[0];
  assert.equal(saved.keepBody,false);assert.equal(saved.bodyCoverage,'excluded');assert.equal(saved.timingText,undefined);
  await reviewMailBody({},storage,await input(saved),sender([]),now+61000);
  saved=(await storage.get('agenda:cache:a')).messages[0];
  await storage.put('agenda:timingConfirmations:a',{'abc:fixture':{value:'keep'}});
  await reviewMailBody({},storage,await input(saved,false),sender([]),now+62000);
  assert.equal((await storage.get('agenda:cache:a')).messages[0].timingText,body);
  assert.deepEqual(await storage.get('agenda:timingConfirmations:a'),{'abc:fixture':{value:'keep'}});
});

test('権限不足・削除・本文未取得・容量超過は本文や本人指定を変更しない',async()=>{
  for(const status of [403,404,200]) {
    const {storage,message}=fixture();
    const before=await storage.get('agenda:cache:a');
    await assert.rejects(reviewMailBody({},storage,await input(message),sender([],status,''),now));
    assert.deepEqual(await storage.get('agenda:cache:a'),before);
  }
  const {storage,message}=fixture();
  const cache=await storage.get('agenda:cache:a');
  cache.messages[1].timingText='x'.repeat(maximumCachedTimingBytes);
  await storage.put('agenda:cache:a',cache);
  await assert.rejects(reviewMailBody({},storage,await input(message),sender([]),now),/保存枠/);
  assert.deepEqual(await storage.get('agenda:cache:a'),cache);
});

test('一覧外ID・古い画面・取得中・直後の再送を拒否する',async()=>{
  const {storage,message}=fixture();
  const valid=await input(message);
  for(const patch of [{accountId:'other'},{messageId:'unknown'},{revision:'stale'},{confirm:false}])
    await assert.rejects(reviewMailBody({},storage,{...valid,...patch},()=>{throw Error('unexpected request');},now));
  await storage.put('agenda:mailJob',{active:true});
  await assert.rejects(reviewMailBody({},storage,valid,sender([]),now),/自動取得中/);
  storage.records.delete('agenda:mailJob');
  await reviewMailBody({},storage,valid,sender([]),now);
  await assert.rejects(reviewMailBody({},storage,valid,sender([]),now),/変更/);
  const saved=(await storage.get('agenda:cache:a')).messages[0];
  await assert.rejects(reviewMailBody({},storage,await input(saved),sender([]),now+1000),/60秒/);
});

test('通信中に一覧が変化した場合は別操作を上書きしない',async()=>{
  const {storage,message}=fixture();
  const send=sender([]);
  await assert.rejects(reviewMailBody({},storage,await input(message),async(...args)=>{
    const cache=await storage.get('agenda:cache:a');cache.messages[1].subject='別の更新';
    await storage.put('agenda:cache:a',cache);
    return send(...args);
  },now),/一覧が変わり/);
  const cache=await storage.get('agenda:cache:a');
  assert.equal(cache.messages[0].bodyCoverage,'excluded');
  assert.equal(cache.messages[1].subject,'別の更新');
});

test('同じ版からの並行操作は1件だけ確定する',async()=>{
  const {storage,message}=fixture();
  const request=await input(message);
  const results=await Promise.allSettled([
    reviewMailBody({},storage,request,sender([]),now),
    reviewMailBody({},storage,request,sender([]),now),
  ]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal((await storage.get('agenda:cache:a')).messages[0].keepBody,true);
});
