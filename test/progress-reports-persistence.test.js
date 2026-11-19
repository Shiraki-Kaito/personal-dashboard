import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const script = `
import {DurableObject} from 'cloudflare:workers';
import {readReportRecord,writeReportRecord} from './src/progress-record-store.js';
import {generateProgressReport,saveProgressReport,loadProgressReport,progressReportView,exportProgressReports,archiveProgressReport,previewProgressRestore,restoreProgressReports} from './src/progress-reports.js';
export class Fixture extends DurableObject {
 async storeLarge(serialized,fail=false){
  const record=JSON.parse(serialized);
  try {await this.ctx.storage.transaction(async tx=>{
   await writeReportRecord(tx,record);
   if(fail)throw Error('large rollback');
  });return 'ok';} catch(error){return error.message;}
 }
 async readLarge(id){return JSON.stringify(await readReportRecord(this.ctx.storage,id));}
 async backup(){return JSON.stringify(await exportProgressReports(this.ctx.storage,'root:true'));}
 async archive(input){return JSON.stringify(await archiveProgressReport(this.ctx.storage,'root:true',JSON.parse(input)));}
 async preview(serialized){return JSON.stringify(await previewProgressRestore(this.ctx.storage,'root:true',JSON.parse(serialized)));}
 async restore(serialized,fail=false){
  const storage=this.ctx.storage;
  const wrapped=fail?{transaction:fn=>storage.transaction(async tx=>{const result=await fn(tx);throw Error('restore rollback');})}:storage;
  try{return JSON.stringify(await restoreProgressReports(wrapped,'root:true',JSON.parse(serialized)));}catch(error){return JSON.stringify({error:error.message});}
 }
 seed(values){return this.ctx.storage.put(Object.fromEntries(values));}
 generate(input,document){return generateProgressReport({},this.ctx.storage,'root:true',input,async()=>Response.json(document));}
 load(id){return loadProgressReport(this.ctx.storage,'root:true',id);}
 view(){return progressReportView(this.ctx.storage,'root:true');}
 async save(input,fail=false){
  const storage=this.ctx.storage;
  const wrapped=fail?{transaction:fn=>storage.transaction(tx=>fn(new Proxy(tx,{get(target,key){if(key==='put')return async(...args)=>{await target.put(...args);throw Error('fixture rollback');};const value=target[key];return typeof value==='function'?value.bind(target):value;}})))}:storage;
  try{return {result:await saveProgressReport(wrapped,'root:true',input)};}catch(error){return {error:error.message};}
 }
}
export default {fetch(){return new Response('local fixture');}};
`;
test("報告のSQLite保存は並行編集・途中障害・応答喪失・再起動でも下書きと確定版を保護する", async () => {
  const persist = await mkdtemp(path.join(tmpdir(), "progress-reports-"));
  const bundle = await build({
    stdin: { contents: script, resolveDir: process.cwd() },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers"],
  });
  const boot = () =>
    new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: bundle.outputFiles[0].text,
        compatibilityDate: "2026-11-10",
        durableObjects: { FIXTURE: { className: "Fixture", useSQLite: true } },
        resourcePersistencePath: persist,
      }),
    );
  let app = boot();
  const stubFor = async (name = "report") => {
    const ns = await app.getDurableObjectNamespace("FIXTURE");
    return ns.get(ns.idFromName(name));
  };
  try {
    let stub = await stubFor();
    await stub.seed([
      [
        "drive:cache",
        {
          scope: "root:true",
          folderName: "集客広報",
          lastSuccess: new Date().toISOString(),
          files: [
            {
              id: "doc",
              name: "議事録",
              folder: "集客広報",
              mimeType: "application/vnd.google-apps.document",
            },
          ],
        },
      ],
      ["drive:credential", { scopes: [] }],
    ]);
    const largeRecord = {
      id: crypto.randomUUID(),
      evidence: "複数資料の根拠😀".repeat(30000),
    };
    assert.equal(await stub.storeLarge(JSON.stringify(largeRecord)), "ok");
    assert.deepEqual(
      JSON.parse(await stub.readLarge(largeRecord.id)),
      largeRecord,
    );
    assert.match(
      await stub.storeLarge(
        JSON.stringify({ ...largeRecord, evidence: "途中で失敗" }),
        true,
      ),
      /rollback/,
    );
    assert.deepEqual(
      JSON.parse(await stub.readLarge(largeRecord.id)),
      largeRecord,
    );
    const id = crypto.randomUUID(),
      input = {
        id,
        scope: "root:true",
        kind: "personal",
        reportDate: "2026-11-17",
        reporter: "白木海斗",
        teams: ["集客広報"],
        sources: [{ id: "doc", role: "personal" }],
        folders: [],
      };
    const generated = await stub.generate(input, {});
    const edit = {
      id,
      scope: "root:true",
      expectedRevision: generated.revision,
      status: "draft",
      texts: [generated.results[0].text + "\n本人の追記"],
    };
    assert.match((await stub.save(edit, true)).error, /rollback/);
    assert.equal((await stub.load(id)).revision, generated.revision);
    const parallel = await Promise.all([stub.save(edit), stub.save(edit)]);
    assert.equal(parallel.filter((value) => value.result).length, 1);
    assert.equal(parallel.filter((value) => value.error).length, 1);
    const changed = await stub.load(id);
    assert.equal(changed.edited, true);
    // 保存結果の応答を失っても、読み直した版でのみ確定する。
    const final = await stub.save({
      ...edit,
      expectedRevision: changed.revision,
      texts: [changed.results[0].text],
      status: "final",
      confirmUsed: true,
    });
    assert.ok(final.result);
    const finalRevision = final.result.revision;
    const archived = JSON.parse(await stub.archive(JSON.stringify({
      scope: "root:true", id, expectedRevision: finalRevision, archived: true,
    })));
    assert.equal(archived.status, "final");
    const backup = await stub.backup();
    const destination = await stubFor("restored");
    const plan = JSON.parse(await destination.preview(backup));
    const restoreInput = JSON.stringify({
      backup: JSON.parse(backup), confirm: true,
      checksum: plan.checksum, expectedRevision: plan.expectedRevision,
    });
    assert.match(JSON.parse(await destination.restore(restoreInput, true)).error, /rollback/);
    assert.equal((await destination.view()).archivedHistory.length, 0);
    assert.deepEqual(JSON.parse(await destination.restore(restoreInput)), {restored: 1});
    const restored = JSON.parse(await destination.readLarge(id));
    assert.equal(restored.status, "final");
    assert.equal(restored.archivedAt, archived.archivedAt);
    assert.deepEqual(restored.results, archived.results);
    assert.notEqual(restored.revision, archived.revision);
    assert.ok(JSON.parse(await destination.restore(restoreInput)).error);
    await app.dispose();
    app = boot();
    stub = await stubFor();
    assert.deepEqual(
      JSON.parse(await stub.readLarge(largeRecord.id)),
      largeRecord,
    );
    assert.equal((await stub.load(id)).status, "final");
    assert.equal((await stub.view()).history.length, 0);
    assert.equal((await stub.view()).archivedHistory.length, 1);
    const restartedDestination = await stubFor("restored");
    assert.equal((await restartedDestination.load(id)).revision, restored.revision);
    assert.deepEqual(JSON.parse(await restartedDestination.backup()).records[0].results, archived.results);
    assert.ok(
      (await stub.save({ ...edit, expectedRevision: finalRevision })).error,
    );
  } finally {
    await app.dispose();
    await rm(persist, { recursive: true, force: true });
  }
});
