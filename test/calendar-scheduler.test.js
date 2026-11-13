import test from "node:test";
import assert from "node:assert/strict";
import { queueCalendarSync, runCalendarBatch } from "../src/calendar-scheduler.js";
import { upcomingCalendarView } from "../src/agenda-calendar.js";
import { nextAlarmAt } from "../src/scheduler.js";
import { disconnectAccount, clearAccountCache, previewAccountDeletion, deleteAccount } from "../src/agenda-management.js";

const now = Date.parse("2027-01-12T03:00:00Z");
function memory(values = new Map()) {
  const storage = {
    values,
    get: async key => structuredClone(values.get(key)),
    put: async (key,value) => values.set(key,structuredClone(value)),
    delete: async key => values.delete(key),
    list: async ({prefix}) => new Map([...values].filter(([key])=>key.startsWith(prefix))),
    transaction: async fn => fn(storage),
  };
  return storage;
}
async function setup() {
  const s=memory();
  await s.put("agenda:accounts",["a","b"].map(id=>({id,email:id+"@example.test",calendar:"primary"})));
  for(const id of ["a","b"]) await s.put("agenda:credential:"+id,{token:"fixture-"+id,expires:now+86400000});
  return s;
}
const upstream = async () => Response.json({kind:"calendar#events",timeZone:"Asia/Tokyo",items:[]});

test("Cronは一接続ずつ取得し、重複開始を抑え、再起動後も次接続から再開する",async()=>{
  const s=await setup();
  await queueCalendarSync(s,now);
  const job=await s.get("agenda:calendarJob");
  assert.equal(await nextAlarmAt(s,now),now+15000);
  await queueCalendarSync(s,now+1000);
  assert.deepEqual(await s.get("agenda:calendarJob"),job);
  let calls=0;
  await runCalendarBatch({},s,async(...args)=>{calls++;return upstream(...args);},now+15000);
  assert.equal(calls,1);
  assert.equal((await s.get("agenda:calendarJob")).index,1);
  const restored=memory(structuredClone(s.values));
  await runCalendarBatch({},restored,upstream,now+30000);
  assert.equal(await restored.get("agenda:calendarJob"),undefined);
  const view=await upcomingCalendarView(restored,now+30000);
  assert.equal(view.complete,true);
  assert.equal(view.accounts[0].source,"cron");
  assert.equal(view.accounts[1].pages,1);
  assert.ok(view.scheduler.lastTriggeredAt);
});

test("一時障害は旧一覧を保持して上限付き再試行し、回復後に成功時刻を更新する",async()=>{
  const s=await setup(), previous="2027-01-11T03:00:00Z";
  await s.put("agenda:calendar:a",{events:[],lastSuccess:previous});
  await queueCalendarSync(s,now);
  const failure=async()=>Response.json({}, {status:503});
  await runCalendarBatch({},s,failure,now+15000);
  assert.equal((await s.get("agenda:calendar:a")).lastSuccess,previous);
  let job=await s.get("agenda:calendarJob");
  assert.equal(job.retries,1);
  assert.equal(job.nextAt,now+75000);
  await runCalendarBatch({},s,upstream,job.nextAt);
  assert.equal((await s.get("agenda:calendar:a")).error,null);
  assert.equal((await s.get("agenda:calendarJob")).index,1);
  await runCalendarBatch({},s,failure,now+90000);
  job=await s.get("agenda:calendarJob");
  await runCalendarBatch({},s,failure,job.nextAt);
  job=await s.get("agenda:calendarJob");
  assert.equal(job.retries,2);
  await runCalendarBatch({},s,failure,job.nextAt);
  assert.equal(await s.get("agenda:calendarJob"),undefined);
  assert.equal((await s.get("agenda:calendar:b")).errorCode,"remote");
});

test("認証エラーは自動再送せず次接続へ進み、停止・削除後は通信しない",async()=>{
  const s=await setup();
  await queueCalendarSync(s,now);
  await runCalendarBatch({},s,async()=>Response.json({}, {status:401}),now+15000);
  assert.equal((await s.get("agenda:calendarJob")).index,1);
  await assert.rejects(clearAccountCache(s,{accountId:"b",confirm:true}),/取得中/);
  await disconnectAccount(s,{accountId:"b",confirm:true},now+20000);
  assert.equal(await s.get("agenda:calendarJob"),undefined);
  const plan=await previewAccountDeletion(s,{accountId:"a"},now);
  await queueCalendarSync(s,now);
  await deleteAccount(s,{accountId:"a",email:"a@example.test",checksum:plan.checksum,confirm:true},now+1);
  assert.equal(await s.get("agenda:calendarJob"),undefined);
  await queueCalendarSync(s,now+2);
  assert.equal(await s.get("agenda:calendarJob"),undefined);
  await runCalendarBatch({},s,()=>assert.fail(),now+100000);
});
