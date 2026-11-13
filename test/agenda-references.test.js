import test from "node:test";
import assert from "node:assert/strict";
import { cleanupAccountReferences } from "../src/agenda-references.js";
import { previewAccountDeletion, deleteAccount } from "../src/agenda-management.js";
import { createAgendaBackup, agendaRestoreEntries } from "../src/agenda-backup.js";
import { digest } from "../src/agenda-rules.js";

function memory(values=new Map()) {
  const s={get:async k=>structuredClone(values.get(k)),put:async(k,v)=>values.set(k,structuredClone(v)),
    delete:async k=>values.delete(k),list:async({prefix})=>new Map([...values].filter(([k])=>k.startsWith(prefix))),
    transaction:async fn=>fn(s)};
  return s;
}
async function setup() {
  const s=memory(), source=await digest("source@example.test"),target=await digest("target@example.test");
  const manual="manual-00000000-0000-4000-8000-000000000001";
  await s.put("agenda:accounts",[{id:source,email:"source@example.test",calendar:"primary"},{id:target,email:"target@example.test",calendar:"primary"}]);
  for(const id of [source,target])await s.put("agenda:credential:"+id,{token:"fixture-secret"});
  await s.put("drive:credential",{token:"fixture-drive"});
  await s.put("agenda:label:"+source,"登録元");
  await s.put("agenda:cache:"+source,{messages:[]});
  await s.put("agenda:reviews:"+source,{abc:{reviewedAt:"2026-11-13T00:00:00Z"}});
  for(const messageId of ["abc",manual,"def"])await s.put("agenda:operation:"+source+":"+messageId,{
    eventId:"pd"+await digest({source,message:messageId}),targetAccountId:messageId==="def"?source:target,
    sourceType:messageId===manual?"manual":"mail",phase:messageId===manual?"登録結果未確認":"登録確認済み",
    lastSuccess:messageId===manual?null:"2026-11-13T00:00:00Z",
    draft:{title:"試験 "+messageId,start:"2027-01-12T01:00:00.000Z",end:"2027-01-12T02:00:00.000Z",location:""},
  });
  await s.put("agenda:pending:"+source,[manual]);
  await s.put("agenda:manualHistory:"+source,[manual]);
  return {s,source,target,manual};
}
const request=(plan,selected)=>({accountId:plan.account.id,checksum:plan.referenceChecksum,selected,confirm:true});

test("参照を一覧化し選んだ確認済み記録だけ整理する。未確認・接続・メール・確認記録は保持",async()=>{
  const {s,source,target,manual}=await setup();
  const plan=await previewAccountDeletion(s,{accountId:target});
  assert.equal(plan.references.length,2);
  assert.equal(plan.references.find(r=>r.messageId===manual).eligible,false);
  assert.equal(plan.references[0].sourceLabel,"登録元");
  assert.equal(JSON.stringify(plan).includes("fixture-secret"),false);
  const result=await cleanupAccountReferences(s,request(plan,[source+":abc"]));
  assert.equal(result.removed,1);
  assert.equal(await s.get("agenda:operation:"+source+":abc"),undefined);
  assert.ok(await s.get("agenda:operation:"+source+":"+manual));
  assert.ok(await s.get("agenda:operation:"+source+":def"));
  assert.ok(await s.get("agenda:credential:"+target));
  assert.ok(await s.get("agenda:credential:"+source));
  assert.ok(await s.get("drive:credential"));
  assert.ok((await s.get("agenda:reviews:"+source)).abc);
  assert.deepEqual((await s.get("agenda:cache:"+source)).messages,[]);
  assert.equal((await s.get("agenda:accounts")).length,2);
  assert.equal((await previewAccountDeletion(s,{accountId:target})).checksum,null);
});

test("確認後の変更・未確認選択・誤対象・未選択・重複・期限切れ・使い回しを拒否",async()=>{
  for(const kind of ["changed","unknown","other","empty","duplicate","expired","reuse","confirm"]) {
    const {s,source,target,manual}=await setup();
    const plan=await previewAccountDeletion(s,{accountId:target},1000),input=request(plan,[source+":abc"]);
    if(kind==="changed")await s.put("agenda:manualHistory:"+source,[]);
    if(kind==="unknown")input.selected=[source+":"+manual];
    if(kind==="other")input.selected=[source+":def"];
    if(kind==="empty")input.selected=[];
    if(kind==="duplicate")input.selected.push(source+":abc");
    if(kind==="reuse")await previewAccountDeletion(s,{accountId:target},1001);
    if(kind==="confirm")input.confirm=false;
    await assert.rejects(cleanupAccountReferences(s,input,kind==="expired"?601000:1002));
    assert.ok(await s.get("agenda:operation:"+source+":abc"));
    assert.ok(await s.get("agenda:credential:"+target));
  }
});

test("再照合済みになってから整理・別途アカウント削除し、残るバックアップを復元できる",async()=>{
  const {s,source,target,manual}=await setup();
  const key="agenda:operation:"+source+":"+manual;
  await s.put(key,{...await s.get(key),phase:"登録確認済み",lastSuccess:"2026-11-13T01:00:00Z"});
  await s.put("agenda:pending:"+source,[]);
  const plan=await previewAccountDeletion(s,{accountId:target});
  await cleanupAccountReferences(s,request(plan,plan.references.map(r=>r.id)));
  assert.deepEqual(await s.get("agenda:manualHistory:"+source),[]);
  const deletion=await previewAccountDeletion(s,{accountId:target});
  assert.ok(deletion.checksum);
  assert.equal((await s.get("agenda:accounts")).length,2);
  await deleteAccount(s,{accountId:target,email:deletion.account.email,checksum:deletion.checksum,confirm:true});
  const backup=await createAgendaBackup(s);
  const restored=memory();
  await restored.put("agenda:accounts",await s.get("agenda:accounts"));
  const result=await agendaRestoreEntries(restored,backup);
  assert.equal(result.conflicts.length,0);
  assert.equal(backup.length,1);
  assert.equal(backup[0].operations.length,1);
  assert.equal(backup[0].operations[0].messageId,"def");
});
