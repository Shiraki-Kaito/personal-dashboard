import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
// 試験専用Worker。本番へデータ投入や障害注入のAPIは追加しない。
const source = `
import {DurableObject} from "cloudflare:workers";
import {agendaHome,saveAgendaCase,saveAgendaSplit,manageAgendaSplit} from "./src/agenda-home.js";
export class ManagerFixture extends DurableObject {
 seed(entries){return this.ctx.storage.put(Object.fromEntries(entries));}
 view(now){return agendaHome(this.ctx.storage,now);}
 state(input,now){return saveAgendaCase(this.ctx.storage,input,now);}
 split(input,now){return saveAgendaSplit(this.ctx.storage,input,now);}
 async clear(){await this.ctx.storage.delete("agenda:cache:one");await this.ctx.storage.delete("agenda:cache:two");}
 async manage(input,now,failAfter=0){
  const storage=this.ctx.storage;let writes=0;
  const wrapped=failAfter ? {transaction:fn=>storage.transaction(tx=>fn(new Proxy(tx,{get(target,name){
   if(name==="put")return async(...args)=>{await target.put(...args);if(++writes===failAfter)throw Error("fixture rollback");};
   const value=target[name];return typeof value==="function"?value.bind(target):value;
  }})))} : storage;
  try{return {view:await manageAgendaSplit(wrapped,input,now)};}catch(error){return {error:error.message};}
 }
}
export default {fetch(){return new Response("local fixture");}};
`;
test("SQLiteで改名・一覧外の解除を原子的に確定し、同時編集・再起動・応答喪失を検証", async () => {
  const persist = await mkdtemp(
    path.join(tmpdir(), "dashboard-split-manager-"),
  );
  const bundle = await build({
    stdin: { contents: source, resolveDir: process.cwd() },
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
        durableObjects: {
          FIXTURE: { className: "ManagerFixture", useSQLite: true },
        },
        resourcePersistencePath: persist,
      }),
    );
  let app = boot();
  const stubFor = async () => {
    const ns = await app.getDurableObjectNamespace("FIXTURE");
    return ns.get(ns.idFromName("manager-test"));
  };
  const now = Date.parse("2026-11-16T03:00:00Z");
  const state = (group, status) => ({
    caseId: group.caseState.id,
    sourceRevision: group.caseState.sourceRevision,
    expectedRevision: group.caseState.revision,
    confirmed: true,
    status,
    note: "保持するメモ",
    snoozeUntil: status === "hold" ? "2026-11-20" : null,
  });
  const management = (view, id, label, operation = "rename") => ({
    targetId: id,
    label,
    operation,
    expectedSplitRevision: view.splitRevision,
    confirmed: true,
  });
  try {
    let stub = await stubFor();
    await stub.seed([
      [
        "agenda:accounts",
        ["one", "two"].map((id) => ({ id, email: id + "@example.test" })),
      ],
      ...["one", "two"].map((id) => [
        "agenda:cache:" + id,
        {
          lastSuccess: new Date(now).toISOString(),
          messages: ["1", "2"].map((id) => ({
            id,
            subject:
              (id === "1" ? "面接日程の確認" : "書類選考の依頼") +
              "【検証株式会社】",
            from: "jobs@example.test",
            excerpt: "ご返信ください",
            receivedAt: new Date(now).toISOString(),
            candidate: { isCandidate: false },
          })),
        },
      ]),
    ]);
    let view = await stub.view(now),
      parent = view.groups[0];
    view = await stub.split(
      {
        caseId: parent.caseState.id,
        sourceRevision: parent.caseState.sourceRevision,
        expectedRevision: parent.caseState.revision,
        expectedSplitRevision: view.splitRevision,
        confirmed: true,
        reset: false,
        targetId: null,
        label: "面接",
        messages: parent.entries
          .filter((entry) => entry.messageId === "1")
          .map(({ accountId, messageId }) => ({ accountId, messageId })),
      },
      now,
    );
    const id = view.splitCases[0].id;
    await stub.state(
      state(
        view.groups.find((group) => group.manualCaseId === id),
        "hold",
      ),
      now,
    );
    view = await stub.view(now);
    parent = view.groups.find((group) => !group.manualCaseId);
    await stub.state(state(parent, "done"), now);
    view = await stub.view(now);
    const input = management(view, id, "一次面接");
    assert.match((await stub.manage(input, now, 3)).error, /rollback/);
    assert.equal((await stub.view(now)).splitRevision, view.splitRevision);
    assert.equal((await stub.view(now)).splitCases[0].label, "面接");
    const results = await Promise.all([
      stub.manage(input, now),
      stub.manage({ ...input, label: "別画面の名前" }, now),
    ]);
    assert.equal(results.filter((result) => result.view).length, 1);
    assert.equal(results.filter((result) => result.error).length, 1);
    view = await stub.view(now);
    const label = view.splitCases[0].label;
    assert.equal(
      view.groups.find((group) => group.manualCaseId === id).caseState.status,
      "hold",
    );
    await app.dispose();
    app = boot();
    stub = await stubFor();
    view = await stub.view(now);
    assert.equal(view.splitCases[0].label, label);
    await stub.clear();
    view = await stub.view(now);
    assert.equal(view.splitCases[0].cachedCount, 0);
    assert.equal(view.splitCases[0].homeCount, 0);
    const rename = management(view, id, "一覧外の面接");
    assert.ok((await stub.manage(rename, now)).view);
    await app.dispose();
    app = boot();
    stub = await stubFor();
    view = await stub.view(now);
    assert.equal(view.splitCases[0].label, "一覧外の面接");
    assert.equal(view.splitCases[0].status, "hold");
    assert.match((await stub.manage(rename, now)).error, /変わった/);
    const reset = management(view, id, "", "reset");
    assert.match((await stub.manage(reset, now, 3)).error, /rollback/);
    assert.equal((await stub.view(now)).splitCases.length, 1);
    assert.equal(
      (await stub.view(now)).caseHistory.find(
        (record) => record.id === parent.caseState.id,
      ).status,
      "done",
    );
    assert.ok((await stub.manage(reset, now)).view);
    await app.dispose();
    app = boot();
    stub = await stubFor();
    view = await stub.view(now);
    assert.equal(view.splitCases.length, 0);
    assert.equal(view.caseHistory.length, 1);
    assert.equal(view.caseHistory[0].label, "一覧外の面接");
    assert.equal(view.caseHistory[0].note, "保持するメモ");
    assert.match((await stub.manage(reset, now)).error, /変わった/);
  } finally {
    await app.dispose();
    assert.equal(path.dirname(persist), path.resolve(tmpdir()));
    assert.ok(path.basename(persist).startsWith("dashboard-split-manager-"));
    await rm(persist, { recursive: true, force: true });
  }
});
