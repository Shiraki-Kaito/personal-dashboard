import test from "node:test";
import assert from "node:assert/strict";
import { disconnectAccount, clearAccountCache } from "../src/agenda-management.js";
import { agendaToken } from "../src/agenda-google.js";
import { queueMailSync, runMailBatch } from "../src/mail-scheduler.js";
import { refreshUpcomingCalendar, upcomingCalendarView } from "../src/agenda-calendar.js";
import { agendaHome } from "../src/agenda-home.js";
import { digest } from "../src/agenda-rules.js";
import { createAgendaBackup } from "../src/agenda-backup.js";

function memory(initial = []) {
  const values = new Map(initial);
  const storage = {
    get: async key => structuredClone(values.get(key)),
    put: async (key, value) => values.set(key, structuredClone(value)),
    delete: async key => values.delete(key),
    list: async ({prefix}) => new Map([...values].filter(([key]) => key.startsWith(prefix)).map(([k,v]) => [k,structuredClone(v)])),
    transaction: async fn => fn(storage),
  };
  return storage;
}
async function setup() {
  const id = await digest("one@example.test"), other = await digest("two@example.test");
  const s = memory([
    ["agenda:accounts", [{id,email:"one@example.test",calendar:"primary"},{id:other,email:"two@example.test",calendar:"primary"}]],
    ["agenda:credential:"+id,{token:"fixture",expires:Date.now()+3600000}],
    ["agenda:credential:"+other,{token:"fixture-other",expires:Date.now()+3600000}],
    ["drive:credential",{token:"fixture-drive"}],
    ["agenda:cache:"+id,{messages:[],lastSuccess:new Date().toISOString()}],
    ["agenda:calendar:"+id,{events:[]}],
    ["agenda:label:"+id,"就活"],
    ["agenda:reviews:"+id,{abc:{reviewedAt:"2026-11-12T00:00:00Z"}}],
    ["agenda:operation:"+id+":abc",{phase:"登録結果未確認",targetAccountId:other,draft:{title:"試験"}}],
    ["agenda:pending:"+id,["abc"]],
    ["agenda:manualHistory:"+id,["abc"]],
    ["agenda:history:"+id,[{outcome:"success"}]],
    ["agenda:preview:"+id+":abc",{checksum:"fixture"}],
    ["agenda:flow",{state:"fixture"}],
  ]);
  return {s,id,other};
}

test("接続停止は資格情報と対象ジョブだけを除き、復旧記録・他接続・Driveを保持", async () => {
  const {s,id,other} = await setup();
  await queueMailSync(s,1000);
  const job = await s.get("agenda:mailJob");
  await s.put("agenda:mailJob",{...job,messages:[{id:"stage"}],pages:1,cursor:"next"});
  await disconnectAccount(s,{accountId:id,confirm:true},2000);
  assert.equal(await s.get("agenda:credential:"+id),undefined);
  assert.equal((await s.get("agenda:credential:"+other)).token,"fixture-other");
  assert.equal((await s.get("drive:credential")).token,"fixture-drive");
  assert.equal(await s.get("agenda:flow"),undefined);
  assert.equal(await s.get("agenda:label:"+id),"就活");
  assert.equal((await s.get("agenda:operation:"+id+":abc")).phase,"登録結果未確認");
  assert.deepEqual(await s.get("agenda:pending:"+id),["abc"]);
  assert.ok(await s.get("agenda:reviews:"+id));
  assert.ok(await s.get("agenda:cache:"+id));
  assert.deepEqual((await s.get("agenda:mailJob")).accountIds,[other]);
  assert.deepEqual((await s.get("agenda:mailJob")).messages,[]);
  await disconnectAccount(s,{accountId:other,confirm:true});
  assert.equal(await s.get("agenda:mailJob"),undefined);
  await queueMailSync(s);
  assert.equal(await s.get("agenda:mailJob"),undefined);
  const accounts = await s.get("agenda:accounts");
  await assert.rejects(agendaToken({},s,accounts[0],()=>assert.fail()),/再接続/);
  await refreshUpcomingCalendar({},s,()=>assert.fail());
  const calendar = await upcomingCalendarView(s);
  assert.equal(calendar.complete,false);
  assert.equal(calendar.accounts[0].errorCode,"disconnected");
  assert.equal((await agendaHome(s)).entries.filter(e=>e.kind==="pending").length,1);
  assert.equal((await createAgendaBackup(s)).length,2);
});

test("停止対象が後続ジョブなら別接続の途中ページを変えない",async()=>{
  const {s,id,other}=await setup();
  await queueMailSync(s,1000);
  const job={...await s.get("agenda:mailJob"),messages:[{id:"staged"}],pages:1,cursor:"next",retries:1};
  await s.put("agenda:mailJob",job);
  await disconnectAccount(s,{accountId:other,confirm:true});
  const after=await s.get("agenda:mailJob");
  assert.deepEqual(after.accountIds,[id]);
  for(const key of ["messages","cursor","pages","retries","startedAt","nextAt"]) assert.deepEqual(after[key],job[key]);
});

test("キャッシュ整理は確認・登録・未確定記録・名前・資格情報を消さない",async()=>{
  const {s,id,other}=await setup();
  await s.put("agenda:cache:"+other,{messages:[]});
  await clearAccountCache(s,{accountId:id,confirm:true});
  for(const key of ["cache","calendar","history"]) assert.equal(await s.get("agenda:"+key+":"+id),undefined);
  assert.equal((await s.list({prefix:"agenda:preview:"+id+":"})).size,0);
  for(const key of ["reviews","pending","manualHistory","label","credential"]) assert.ok(await s.get("agenda:"+key+":"+id));
  assert.ok(await s.get("agenda:operation:"+id+":abc"));
  assert.ok(await s.get("agenda:cache:"+other));
});

test("未確認・不正対象・取得中の整理を拒否し、古いジョブでも停止接続へ通信しない",async()=>{
  const {s,id,other}=await setup();
  for(const fn of [disconnectAccount,clearAccountCache]) {
    await assert.rejects(fn(s,{accountId:id}),/確認/);
    await assert.rejects(fn(s,{accountId:"missing",confirm:true}),/保存済み/);
  }
  await queueMailSync(s,1000);
  await assert.rejects(clearAccountCache(s,{accountId:id,confirm:true}),/取得中/);
  assert.ok(await s.get("agenda:cache:"+id));
  const stale=await s.get("agenda:mailJob");
  await disconnectAccount(s,{accountId:id,confirm:true});
  await s.put("agenda:mailJob",stale);
  await runMailBatch({},s,()=>assert.fail("停止接続へ通信した"),100000);
  assert.equal((await s.get("agenda:mailJob")).accountIds[(await s.get("agenda:mailJob")).index],other);
});
