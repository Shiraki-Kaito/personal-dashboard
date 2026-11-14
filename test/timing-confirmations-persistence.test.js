import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ローカル試験専用。実運用のWorkerには初期データ投入・障害注入APIを追加しない。
const fixtureSource = `
import { DurableObject } from "cloudflare:workers";
import { readTimingConfirmation, saveTimingConfirmation } from "./src/timing-confirmations.js";
import { agendaHome } from "./src/agenda-home.js";
export class TimingFixture extends DurableObject {
  seed(entries) { return this.ctx.storage.put(Object.fromEntries(entries)); }
  view(input) { return readTimingConfirmation(this.ctx.storage,input); }
  home(now) { return agendaHome(this.ctx.storage,now); }
  async save(input,now,fail=false) {
    const storage=this.ctx.storage;
    const wrapped=fail ? {transaction:fn=>storage.transaction(tx=>fn(new Proxy(tx,{
      get(target,name) {
        if(name==="put") return async(...args)=>{await target.put(...args);throw Error("fixture rollback");};
        const value=target[name];return typeof value==="function" ? value.bind(target) : value;
      }
    })))} : storage;
    try { return {view:await saveTimingConfirmation(wrapped,input,now)}; }
    catch(error) {return {error:error.message};}
  }
}
export default {fetch(){return new Response("local fixture");}};
`;
test("SQLiteで日時確定の並行保存・応答喪失後の照合・ロールバック・再起動を検証", async () => {
  const persist = await mkdtemp(path.join(tmpdir(), "dashboard-timing-"));
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
          FIXTURE: { className: "TimingFixture", useSQLite: true },
        },
        resourcePersistencePath: persist,
      }),
    );
  let app = boot();
  const stubFor = async () => {
    const namespace = await app.getDurableObjectNamespace("FIXTURE");
    return namespace.get(namespace.idFromName("timing-test"));
  };
  const now = Date.parse("2026-11-14T03:00:00Z");
  try {
    let stub = await stubFor();
    await stub.seed([
      ["agenda:accounts", [{ id: "one", email: "one@example.test" }]],
      [
        "agenda:cache:one",
        {
          lastSuccess: new Date(now).toISOString(),
          messages: [
            {
              id: "abc",
              subject: "成績証明書の提出",
              excerpt: "提出期限：11月15日",
              receivedAt: new Date(now).toISOString(),
              candidate: { isCandidate: false },
            },
          ],
        },
      ],
    ]);
    const target = (await stub.view({ accountId: "one", messageId: "abc" }))
      .timings[0];
    const input = {
      accountId: "one",
      messageId: "abc",
      timingId: target.timingId,
      sourceRevision: target.sourceRevision,
      expectedRevision: null,
      confirm: true,
      value: {
        kind: "deadline",
        action: "書類提出",
        date: "2026-11-14",
        time: "17:00",
        endDate: "",
        endTime: "",
      },
    };
    assert.match((await stub.save(input, now, true)).error, /fixture rollback/);
    assert.equal((await stub.view(input)).timings[0].revision, null);
    const outcomes = await Promise.all([
      stub.save(input, now),
      stub.save(input, now),
    ]);
    assert.equal(outcomes.filter((result) => result.view).length, 1);
    assert.equal(outcomes.filter((result) => result.error).length, 1);
    // 書き込み応答を受け取れなかったクライアントは読み直して照合でき、旧版の再送は拒否される。
    const saved = (await stub.view(input)).timings[0];
    assert.ok(saved.manual);
    assert.match((await stub.save(input, now)).error, /別の画面/);
    await app.dispose();
    app = boot();
    stub = await stubFor();
    assert.equal((await stub.view(input)).timings[0].revision, saved.revision);
    assert.equal((await stub.home(now)).groups[0].priority.rank, 2);
    const reset = { ...input, expectedRevision: saved.revision, reset: true };
    assert.ok((await stub.save(reset, now + 1)).view);
    await app.dispose();
    app = boot();
    stub = await stubFor();
    assert.equal((await stub.view(input)).timings[0].manual, null);
    assert.equal((await stub.home(now)).groups[0].priority.rank, 4);
    assert.match((await stub.save(input, now)).error, /別の画面/);
  } finally {
    await app.dispose();
    const resolved = path.resolve(persist);
    assert.ok(
      resolved.startsWith(path.resolve(tmpdir()) + path.sep) &&
        path.basename(resolved).startsWith("dashboard-timing-"),
    );
    await rm(resolved, { recursive: true, force: true });
  }
});
