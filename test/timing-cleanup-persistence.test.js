import test from "node:test";
import assert from "node:assert/strict";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {build} from "esbuild";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

// 障害注入・初期値投入はローカル試験だけに置き、本番へ配信しない。
const source=`
import {DurableObject} from 'cloudflare:workers';
import {prepareTimingCleanup,cleanupTimings} from './src/timing-cleanup.js';
export class Fixture extends DurableObject {
 seed(entries){return this.ctx.storage.put(Object.fromEntries(entries));}
 async dump(key){return JSON.stringify({value:await this.ctx.storage.get(key)});}
 plan(input,now){return prepareTimingCleanup(this.ctx.storage,input,now);}
 async clean(input,now,fail=false){
  const storage=this.ctx.storage;
  const wrapped=fail?{transaction:fn=>storage.transaction(tx=>fn(new Proxy(tx,{
   get(target,name){
    if(name==='put')return async(...args)=>{await target.put(...args);throw Error('fixture rollback');};
    const value=target[name];return typeof value==='function'?value.bind(target):value;
   }
  })))}:storage;
  try{return {result:await cleanupTimings(wrapped,input,now)};}catch(error){return {error:error.message};}
 }
}
export default{fetch(){return new Response('local fixture');}};
`;
test("SQLiteで整理の並行実行・途中失敗の原子性・応答喪失後の照合・再起動を検証する",async()=>{
 const persist=await mkdtemp(path.join(tmpdir(),"timing-cleanup-"));
 const bundle=await build({stdin:{contents:source,resolveDir:process.cwd()},bundle:true,write:false,format:"esm",platform:"browser",external:["cloudflare:workers"]});
 const boot=()=>new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:"2026-11-10",durableObjects:{FIXTURE:{className:"Fixture",useSQLite:true}},resourcePersistencePath:persist}));
 let app=boot();
 const stubFor=async()=>{const namespace=await app.getDurableObjectNamespace("FIXTURE");return namespace.get(namespace.idFromName("cleanup"));};
 const now=Date.parse("2026-11-17T03:00:00Z"),id="abc:"+"a".repeat(64);
 const record={sourceRevision:"b".repeat(64),revision:crypto.randomUUID(),updatedAt:new Date(now).toISOString(),value:{kind:"deadline",action:"架空の提出",date:"2026-12-01",time:"17:00",endDate:"",endTime:""}};
 try{
  let stub=await stubFor();
  const read=async key=>JSON.parse(await stub.dump(key)).value;
  await stub.seed([["agenda:accounts",[{id:"a",email:"a@example.test"}]],["agenda:cache:a",{messages:[]}],["agenda:timingConfirmations:a",{[id]:record}]]);
  let plan=await stub.plan({accountId:"a"},now);
  let input={accountId:"a",checksum:plan.checksum,selected:[id],confirm:true};
  assert.match((await stub.clean(input,now,true)).error,/rollback/);
  assert.deepEqual(await read("agenda:timingConfirmations:a"),{[id]:record});
  assert.equal(await read("agenda:timingCollection:a"),undefined);
  assert.ok(await read("agenda:timingCleanupPlan:a"));
  const parallel=await Promise.all([stub.clean(input,now),stub.clean(input,now)]);
  assert.equal(parallel.filter(result=>result.result).length,1);
  assert.equal(parallel.filter(result=>result.error).length,1);
  // 成功応答を利用できなかった場合も、再送せず保存内容を照合する。
  assert.deepEqual(await read("agenda:timingConfirmations:a"),{});
  const collection=await read("agenda:timingCollection:a");
  assert.ok(collection);
  await app.dispose();app=boot();stub=await stubFor();
  plan=await stub.plan({accountId:"a"},now);
  assert.equal(plan.count,0);
  assert.equal(await read("agenda:timingCollection:a"),collection);
  assert.ok((await stub.clean(input,now)).error);
 }finally{await app.dispose();await rm(persist,{recursive:true,force:true});}
});
