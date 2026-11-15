import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
// 本番には含めない、SQLiteの複数キー更新を検証する専用Worker。
const fixtureSource = `
import {DurableObject} from "cloudflare:workers";
import {agendaHome,saveAgendaCase,saveAgendaSplit} from "./src/agenda-home.js";
export class SplitFixture extends DurableObject {
 seed(entries){return this.ctx.storage.put(Object.fromEntries(entries));}
 view(now){return agendaHome(this.ctx.storage,now);}
 state(input,now){return saveAgendaCase(this.ctx.storage,input,now);}
 async split(input,now,fail=false){
  const storage=this.ctx.storage;
  const wrapped=fail?{transaction:fn=>storage.transaction(tx=>fn(new Proxy(tx,{get(target,name){
    if(name==="put")return async(...args)=>{await target.put(...args);throw Error("fixture rollback");};
    const value=target[name];return typeof value==="function"?value.bind(target):value;
  }})))}:storage;
  try{return {view:await saveAgendaSplit(wrapped,input,now)};}catch(error){return {error:error.message};}
 }
}
export default {fetch(){return new Response("local fixture");}};
`;
test("SQLiteで分割・対応状態を原子的に保存し、並行操作・ロールバック・応答喪失・再起動を検証", async () => {
  const persist = await mkdtemp(path.join(tmpdir(), "dashboard-splits-"));
  const bundle = await build({
    stdin: { contents: fixtureSource, resolveDir: process.cwd() },
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
          FIXTURE: { className: "SplitFixture", useSQLite: true },
        },
        resourcePersistencePath: persist,
      }),
    );
  let app = boot();
  const stubFor = async () => {
    const ns = await app.getDurableObjectNamespace("FIXTURE");
    return ns.get(ns.idFromName("split-test"));
  };
  const now = Date.parse("2026-11-15T13:00:00Z");
  const stateInput = (group, status) => ({
    caseId: group.caseState.id,
    sourceRevision: group.caseState.sourceRevision,
    expectedRevision: group.caseState.revision,
    status,
    note: "",
    snoozeUntil: status === "hold" ? "2026-11-18" : null,
    confirmed: true,
  });
  const splitInput = (view, group, reset = false) => ({
    caseId: group.caseState.id,
    sourceRevision: group.caseState.sourceRevision,
    expectedRevision: group.caseState.revision,
    expectedSplitRevision: view.splitRevision,
    confirmed: true,
    reset,
    targetId: null,
    label: "面接",
    messages: group.entries
      .filter((entry) => entry.messageId === "1")
      .map(({ accountId, messageId }) => ({ accountId, messageId })),
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
          messages: ["1", "2"].map((messageId) => ({
            id: messageId,
            subject:
              (messageId === "1" ? "面接日程の確認" : "成績証明書の提出依頼") +
              "【検証株式会社】",
            excerpt: "ご返信ください",
            from: "jobs@example.test",
            receivedAt: new Date(now).toISOString(),
            candidate: { isCandidate: false },
          })),
        },
      ]),
    ]);
    let view = await stub.view(now);
    await stub.state(stateInput(view.groups[0], "done"), now);
    view = await stub.view(now);
    const input = splitInput(view, view.groups[0]);
    assert.match((await stub.split(input, now, true)).error, /rollback/);
    assert.equal((await stub.view(now)).splitRevision, view.splitRevision);
    assert.equal((await stub.view(now)).groups[0].caseState.status, "done");
    const outcomes = await Promise.all([
      stub.split(input, now),
      stub.split(input, now),
    ]);
    assert.equal(outcomes.filter((result) => result.view).length, 1);
    assert.equal(outcomes.filter((result) => result.error).length, 1);
    view = await stub.view(now);
    assert.equal(view.groups.length, 2);
    assert.ok(view.groups.every((group) => group.caseState.status === "open"));
    await stub.state(
      stateInput(
        view.groups.find((group) => group.manualCaseId),
        "done",
      ),
      now,
    );
    view = await stub.view(now);
    await stub.state(
      stateInput(
        view.groups.find((group) => !group.manualCaseId),
        "hold",
      ),
      now,
    );
    await app.dispose();
    app = boot();
    stub = await stubFor();
    view = await stub.view(now);
    assert.equal(
      view.groups.find((group) => group.manualCaseId).caseState.status,
      "done",
    );
    assert.equal(
      view.groups.find((group) => !group.manualCaseId).caseState.status,
      "hold",
    );
    assert.match((await stub.split(input, now)).error, /変わった/);
    const reset = splitInput(
      view,
      view.groups.find((group) => group.manualCaseId),
      true,
    );
    assert.match((await stub.split(reset, now, true)).error, /rollback/);
    assert.equal((await stub.view(now)).groups.length, 2);
    assert.ok((await stub.split(reset, now)).view);
    await app.dispose();
    app = boot();
    stub = await stubFor();
    view = await stub.view(now);
    assert.equal(view.groups.length, 1);
    assert.equal(view.groups[0].caseState.status, "open");
    assert.equal(view.splitCases.length, 0);
    assert.match((await stub.split(reset, now)).error, /変わった/);
  } finally {
    await app.dispose();
    assert.equal(path.dirname(persist), path.resolve(tmpdir()));
    assert.ok(path.basename(persist).startsWith("dashboard-splits-"));
    await rm(persist, { recursive: true, force: true });
  }
});
