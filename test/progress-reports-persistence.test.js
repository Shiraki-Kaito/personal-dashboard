import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const script = `
import {DurableObject} from 'cloudflare:workers';
import {generateProgressReport,saveProgressReport,loadProgressReport,progressReportView} from './src/progress-reports.js';
export class Fixture extends DurableObject {
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
  const stubFor = async () => {
    const ns = await app.getDurableObjectNamespace("FIXTURE");
    return ns.get(ns.idFromName("report"));
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
    await app.dispose();
    app = boot();
    stub = await stubFor();
    assert.equal((await stub.load(id)).status, "final");
    assert.equal((await stub.view()).history.length, 1);
    assert.ok(
      (await stub.save({ ...edit, expectedRevision: finalRevision })).error,
    );
  } finally {
    await app.dispose();
    await rm(persist, { recursive: true, force: true });
  }
});
