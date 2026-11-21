import test from "node:test";
import assert from "node:assert/strict";
import {noteDrafts} from "../src/note-drafts.js";
function fixture() {
  const values = new Map([["notes:config",{owner:"test",repo:"notes",branch:"",folder:""}], ["notes:cache",{commit:"a".repeat(40),files:[{path:"a.md",readable:true}]}]]);
  const s={get:async k=>structuredClone(values.get(k)),put:async(k,v)=>values.set(k,structuredClone(v)),list:async({prefix})=>new Map([...values].filter(([k])=>k.startsWith(prefix)))};
  s.delete=async k=>values.delete(k);
  let queue=Promise.resolve(); s.transaction=fn=>{const result=queue.then(()=>fn(s));queue=result.catch(()=>{});return result;};
  return {s, input:{action:"draftSave",id:crypto.randomUUID(),operationId:crypto.randomUUID(),scope:'["test","notes","",""]',path:"a.md",commit:"a".repeat(40),revision:"",text:"試験下書き"}};
}
test("保存・本文なし一覧・再取得と応答消失後の同じ操作の照合",async()=>{
  const {s,input}=fixture(); const saved=await noteDrafts(s,input);
  assert.deepEqual(await noteDrafts(s,input),saved);
  assert.deepEqual(await noteDrafts(s,{action:"draftLoad",id:saved.id}),saved);
  const list=await noteDrafts(s,{action:"draftList"}); assert.equal(list.records[0].text,undefined);
  await s.put("notes:config",null);
  assert.equal((await noteDrafts(s,{action:"draftList"})).records[0].currentScope,false);
  assert.equal((await noteDrafts(s,{...input,revision:saved.revision,operationId:crypto.randomUUID(),text:"範囲変更後も保持"})).text,"範囲変更後も保持");
});

test("専用バックアップ・削除確認・不足分復元と再送は既存本文を保護する",async()=>{
  const {s,input}=fixture(); const saved=await noteDrafts(s,input);
  const backup=await noteDrafts(s,{action:"draftExport"});
  assert.equal(backup.records[0].operationId,undefined);
  assert.equal(backup.records[0].revision,undefined);
  await assert.rejects(noteDrafts(s,{action:"draftDelete",id:saved.id,revision:saved.revision}),/確認/);
  await assert.rejects(noteDrafts(s,{action:"draftDelete",id:saved.id,revision:"stale",confirmed:true}),/変更/);
  await noteDrafts(s,{action:"draftDelete",id:saved.id,revision:saved.revision,confirmed:true});
  await noteDrafts(s,{action:"draftDelete",id:saved.id,revision:saved.revision,confirmed:true});
  const plan=await noteDrafts(s,{action:"draftRestorePreview",backup});
  assert.equal(plan.added.length,1);
  assert.equal((await noteDrafts(s,{action:"draftList"})).records.length,0);
  await assert.rejects(noteDrafts(s,{action:"draftRestore",backup}),/確認/);
  await noteDrafts(s,{action:"draftRestore",backup,confirmed:true});
  assert.equal((await noteDrafts(s,{action:"draftRestore",backup,confirmed:true})).existing,1);
  const restored=await noteDrafts(s,{action:"draftLoad",id:saved.id});
  assert.equal(restored.text,saved.text); assert.notEqual(restored.revision,saved.revision);
  await assert.rejects(noteDrafts(s,{...input,revision:saved.revision}),/別の画面/);
  backup.records[0].text="バックアップの異なる内容";
  await assert.rejects(noteDrafts(s,{action:"draftRestore",backup,confirmed:true}),/上書きせず/);
  assert.equal((await noteDrafts(s,{action:"draftLoad",id:saved.id})).text,saved.text);
});

test("復元入力の対象外・重複・容量超過を拒否し、プレビュー後の変更でも上書きしない",async()=>{
  const {s,input}=fixture(); await noteDrafts(s,input);
  const backup=await noteDrafts(s,{action:"draftExport"});
  for (const patch of [{path:"private_L.md"},{path:"../a.md"},{scope:"null"},{commit:"bad"},{text:"あ".repeat(50000)}]) {
    const invalid=structuredClone(backup); Object.assign(invalid.records[0],patch);
    await assert.rejects(noteDrafts(s,{action:"draftRestore",backup:invalid,confirmed:true}));
  }
  await assert.rejects(noteDrafts(s,{action:"draftRestore",backup:{...backup,records:[...backup.records,...backup.records]},confirmed:true}));
  const full={...backup,records:Array.from({length:20},()=>({...backup.records[0],id:crypto.randomUUID()}))};
  await assert.rejects(noteDrafts(s,{action:"draftRestore",backup:full,confirmed:true}),/20件/);
  const current=await noteDrafts(s,{action:"draftLoad",id:input.id});
  await noteDrafts(s,{action:"draftRestorePreview",backup});
  await noteDrafts(s,{...input,revision:current.revision,operationId:crypto.randomUUID(),text:"最新"});
  await assert.rejects(noteDrafts(s,{action:"draftRestore",backup,confirmed:true}),/上書きせず/);
});
test("並行保存の片方を停止し、容量超過・対象外を以前の値で保護",async()=>{
  const {s,input}=fixture(); const saved=await noteDrafts(s,input);
  const attempts=await Promise.allSettled(["A","B"].map(text=>noteDrafts(s,{...input,text,revision:saved.revision,operationId:crypto.randomUUID()})));
  assert.equal(attempts.filter(x=>x.status==="fulfilled").length,1);
  const latest=await noteDrafts(s,{action:"draftLoad",id:input.id});
  await assert.rejects(noteDrafts(s,{...input,revision:latest.revision,operationId:crypto.randomUUID(),text:"あ".repeat(50000)}),/容量/);
  assert.deepEqual(await noteDrafts(s,{action:"draftLoad",id:input.id}),latest);
  for(const path of ["a_L.md","missing.md"]) await assert.rejects(noteDrafts(s,{...input,id:crypto.randomUUID(),path}));
});
