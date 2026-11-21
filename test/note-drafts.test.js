import test from "node:test";
import assert from "node:assert/strict";
import {noteDrafts} from "../src/note-drafts.js";
function fixture() {
  const values = new Map([["notes:config",{owner:"test",repo:"notes",branch:"",folder:""}], ["notes:cache",{commit:"a".repeat(40),files:[{path:"a.md",readable:true}]}]]);
  const s={get:async k=>structuredClone(values.get(k)),put:async(k,v)=>values.set(k,structuredClone(v)),list:async({prefix})=>new Map([...values].filter(([k])=>k.startsWith(prefix)))};
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
test("並行保存の片方を停止し、容量超過・対象外を以前の値で保護",async()=>{
  const {s,input}=fixture(); const saved=await noteDrafts(s,input);
  const attempts=await Promise.allSettled(["A","B"].map(text=>noteDrafts(s,{...input,text,revision:saved.revision,operationId:crypto.randomUUID()})));
  assert.equal(attempts.filter(x=>x.status==="fulfilled").length,1);
  const latest=await noteDrafts(s,{action:"draftLoad",id:input.id});
  await assert.rejects(noteDrafts(s,{...input,revision:latest.revision,operationId:crypto.randomUUID(),text:"あ".repeat(50000)}),/容量/);
  assert.deepEqual(await noteDrafts(s,{action:"draftLoad",id:input.id}),latest);
  for(const path of ["a_L.md","missing.md"]) await assert.rejects(noteDrafts(s,{...input,id:crypto.randomUUID(),path}));
});
