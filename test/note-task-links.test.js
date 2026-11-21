import test from "node:test";
import assert from "node:assert/strict";
import {noteTaskLinksView, changeNoteTaskLink, normalizeNoteTaskLinks} from "../src/note-task-links.js";
import {createBackup, backupPlan, restoreBackup} from "../src/backup.js";
import {assertBackupEnvelope} from "../public/backup-format.js";

const env = {PROJECT_CONFIG:JSON.stringify({project:"p"})};
const now = Date.now();
function memory() {
  const values = new Map();
  const storage = {get:async key=>structuredClone(values.get(key)),put:async (key,value)=>values.set(key,structuredClone(value)),
    list:async ({prefix})=>new Map([...values].filter(([key])=>key.startsWith(prefix))),delete:async key=>values.delete(key)};
  let queue = Promise.resolve();
  storage.transaction = fn => {const next=queue.then(()=>fn(storage));queue=next.catch(()=>{});return next;};
  return storage;
}
async function fixture() {
  const storage = memory();
  await storage.put("notes:config",{owner:"example",repo:"notes",branch:"",folder:""});
  await storage.put("notes:cache",{files:[{path:"a.md"}],lastSuccess:new Date(now).toISOString()});
  await storage.put("catalog:p",{items:[{id:"i",title:"Task",editable:true}],lastSuccess:new Date(now).toISOString()});
  const view = await noteTaskLinksView(env,storage,now);
  const link = {scope:view.scope,path:"a.md",projectId:"p",itemId:"i"};
  return {storage,link,revision:view.revision};
}
test("関連を保存して再取得・重複防止・解除する",async()=>{
  const {storage,link,revision}=await fixture();
  const saved=await changeNoteTaskLink(env,storage,{action:"linkAdd",link,revision},now);
  assert.equal(saved.records[0].title,"Task");
  const duplicate=await changeNoteTaskLink(env,storage,{action:"linkAdd",link,revision:saved.revision},now);
  assert.equal(duplicate.records.length,1);
  const removed=await changeNoteTaskLink(env,storage,{action:"linkRemove",link,revision:duplicate.revision},now);
  assert.equal(removed.records.length,0);
});
test("同じ版からの二重操作では一方だけ保存する",async()=>{
  const {storage,link,revision}=await fixture();
  const results=await Promise.allSettled([1,2].map(()=>changeNoteTaskLink(env,storage,{action:"linkAdd",link,revision},now)));
  assert.equal(results.filter(result=>result.status==="fulfilled").length,1);
  assert.equal((await noteTaskLinksView(env,storage,now)).records.length,1);
});
test("古い一覧・対象外ノート・対象外タスク・ローカル限定ノートを拒否",async()=>{
  for (const change of [{path:"secret_L.md"},{path:"missing.md"},{itemId:"other"},{projectId:"other"},{scope:'["other","notes","",""]'}]) {
    const {storage,link,revision}=await fixture();
    await assert.rejects(changeNoteTaskLink(env,storage,{action:"linkAdd",link:{...link,...change},revision},now));
  }
  const {storage,link,revision}=await fixture();
  await assert.rejects(changeNoteTaskLink(env,storage,{action:"linkAdd",link,revision},now+121000),/古い/);
});
test("範囲外になった関連は勝手に削除せず、解除だけ可能",async()=>{
  const {storage,link,revision}=await fixture();
  const saved=await changeNoteTaskLink(env,storage,{action:"linkAdd",link,revision},now);
  await storage.delete("notes:config"); await storage.delete("catalog:p");
  const view=await noteTaskLinksView(env,storage,now);
  assert.equal(view.records[0].available,false);
  assert.equal((await changeNoteTaskLink(env,storage,{action:"linkRemove",link,revision:saved.revision},now)).records.length,0);
});
test("バックアップは参照だけを保存し、空の保存先へ復元・既存保存先は拒否",async()=>{
  const {storage,link,revision}=await fixture();
  await changeNoteTaskLink(env,storage,{action:"linkAdd",link,revision},now);
  const backup=await createBackup(env,storage);
  assertBackupEnvelope(backup);
  assert.deepEqual(backup.noteTaskLinks.records,[link]);
  const empty=memory(); const plan=await backupPlan(env,empty,backup);
  assert.equal(plan.noteTaskLinks,1);
  await restoreBackup(env,empty,backup,plan.checksum);
  assert.notEqual((await empty.get("notes:taskLinks")).revision,backup.noteTaskLinks.revision);
  assert.equal((await noteTaskLinksView(env,empty,now)).records[0].available,false);
  await assert.rejects(restoreBackup(env,empty,backup,plan.checksum),/保存済み/);
});
test("不正なバックアップと上限超過を拒否",async()=>{
  const {link}=await fixture();
  for(const bad of [null,{records:[null]},{records:[{...link,path:"../x.md"}]},{records:[{...link,itemId:null}]},{records:[link,link]},
    {records:Array.from({length:201},(_,i)=>({...link,itemId:"i"+i}))}]) assert.throws(()=>normalizeNoteTaskLinks(bad));
});
