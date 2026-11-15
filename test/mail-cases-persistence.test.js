import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ローカル専用。実運用のWorkerには試験用の投入・障害APIを加えない。
const fixtureSource = `
import { DurableObject } from "cloudflare:workers";
import { agendaHome, saveAgendaCase } from "./src/agenda-home.js";
export class CaseFixture extends DurableObject {
  seed(entries) { return this.ctx.storage.put(Object.fromEntries(entries)); }
  view(now) { return agendaHome(this.ctx.storage,now); }
  async save(input,now,fail=false) {
    const storage=this.ctx.storage;
    const wrapped=fail ? {transaction:fn=>storage.transaction(tx=>fn(new Proxy(tx,{
      get(target,name) {
        if(name==="put") return async(...args)=>{await target.put(...args);throw Error("fixture rollback");};
        const value=target[name];return typeof value==="function" ? value.bind(target) : value;
      }
    })))} : storage;
    try { return {view:await saveAgendaCase(wrapped,input,now)}; }
    catch(error) {return {error:error.message};}
  }
}
export default {fetch(){return new Response("local fixture");}};
`;

test("SQLiteの案件保存は全宛先で原子的に確定し、並行保存・応答喪失・再起動でも上書きしない", async () => {
  const persist = await mkdtemp(path.join(tmpdir(), "dashboard-cases-"));
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
          FIXTURE: { className: "CaseFixture", useSQLite: true },
        },
        resourcePersistencePath: persist,
      }),
    );
  let app = boot();
  const stubFor = async () => {
    const ns = await app.getDurableObjectNamespace("FIXTURE");
    return ns.get(ns.idFromName("cases-test"));
  };
  const now = Date.parse("2026-11-15T13:00:00Z");
  try {
    let stub = await stubFor();
    await stub.seed([
      [
        "agenda:accounts",
        ["one", "two"].map((id) => ({ id, email: id + "@example.test" })),
      ],
      ...["one", "two"].map((id, index) => [
        "agenda:cache:" + id,
        {
          lastSuccess: new Date(now).toISOString(),
          messages: [
            {
              id: (index + 1).toString(16),
              subject: "面接日程の確認【試験株式会社】",
              excerpt: "ご返信ください",
              from: "jobs@example.test",
              receivedAt: new Date(now).toISOString(),
              candidate: { isCandidate: false },
            },
          ],
        },
      ]),
    ]);
    const first = (await stub.view(now)).groups[0].caseState;
    const input = {
      caseId: first.id,
      sourceRevision: first.sourceRevision,
      expectedRevision: first.revision,
      status: "done",
      note: "検証用",
      snoozeUntil: null,
      confirmed: true,
    };
    assert.match((await stub.save(input, now, true)).error, /rollback/);
    assert.equal(
      (await stub.view(now)).groups[0].caseState.revision,
      first.revision,
    );
    const outcomes = await Promise.all([
      stub.save(input, now),
      stub.save(input, now),
    ]);
    assert.equal(outcomes.filter((result) => result.view).length, 1);
    assert.equal(outcomes.filter((result) => result.error).length, 1);
    const saved = (await stub.view(now)).groups[0].caseState;
    assert.equal(saved.status, "done");
    assert.match((await stub.save(input, now)).error, /変わりました/);
    await app.dispose();
    app = boot();
    stub = await stubFor();
    assert.equal(
      (await stub.view(now)).groups[0].caseState.revision,
      saved.revision,
    );
    const reset = {
      ...input,
      status: "open",
      expectedRevision: saved.revision,
    };
    assert.equal(
      (await stub.save(reset, now + 1)).view.groups[0].caseState.status,
      "open",
    );
    await app.dispose();
    app = boot();
    stub = await stubFor();
    assert.equal((await stub.view(now)).groups[0].caseState.status, "open");
    assert.match((await stub.save(reset, now + 2)).error, /変わりました/);
  } finally {
    await app.dispose();
    await rm(persist, { recursive: true, force: true });
  }
});
