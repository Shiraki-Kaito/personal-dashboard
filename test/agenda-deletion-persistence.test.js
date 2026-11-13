import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// 実SQLite用のローカル試験専用RPC。本番Workerには組み込まない。
const fixtureSource = `
import { DurableObject } from "cloudflare:workers";
import { previewAccountDeletion, deleteAccount } from "./src/agenda-management.js";
export class DeletionFixture extends DurableObject {
  seed(entries) { return this.ctx.storage.put(Object.fromEntries(entries)); }
  async read(key) { return JSON.stringify(await this.ctx.storage.get(key)) ?? null; }
  plan(input) { return previewAccountDeletion(this.ctx.storage, input); }
  async remove(input, injectFailure = false) {
    const storage = this.ctx.storage;
    let deletes = 0;
    const wrapped = { transaction: fn => storage.transaction(tx => fn(new Proxy(tx, {
      get(target, name) {
        if (name === "delete" && injectFailure) return async key => {
          if (++deletes === 2) throw Error("fixture rollback");
          return target.delete(key);
        };
        const value = target[name];
        return typeof value === "function" ? value.bind(target) : value;
      },
    }))) };
    try {
      await deleteAccount(wrapped, input);
      return { removed: true };
    } catch (error) {
      return { error: error.message };
    }
  }
}
export default { fetch() { return new Response("fixture only"); } };
`;

test("SQLiteで削除途中失敗のロールバック、並行削除、再起動後の枠解放を確認", async () => {
  const persist = await mkdtemp(path.join(tmpdir(), "dashboard-delete-"));
  const bundle = await build({
    stdin: { contents: fixtureSource, resolveDir: process.cwd() },
    bundle: true, write: false, format: "esm", platform: "browser",
    external: ["cloudflare:workers"],
  });
  const boot = () => new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-11-10",
    durableObjects: { FIXTURE: { className: "DeletionFixture", useSQLite: true } },
    resourcePersistencePath: persist,
  }));
  let app = boot();
  const stubFor = async () => {
    const namespace = await app.getDurableObjectNamespace("FIXTURE");
    return namespace.get(namespace.idFromName("deletion-test"));
  };
  try {
    let stub = await stubFor();
    const read = async key => {
      const value = await stub.read(key);
      return value === null ? undefined : JSON.parse(value);
    };
    const account = { id: "selected", email: "fixture@example.test", calendar: "primary" };
    await stub.seed([
      ["agenda:accounts", [account]],
      ["agenda:credential:selected", {token:"fixture-only"}],
      ["agenda:label:selected", "fixture"],
      ["agenda:cache:selected", {messages:[]}],
      ["drive:cache", {files:[{id:"keep"}]}],
    ]);
    const plan = await stub.plan({accountId:account.id});
    const input = {accountId:account.id,email:account.email,checksum:plan.checksum,confirm:true};
    assert.match((await stub.remove(input,true)).error,/fixture rollback/);
    assert.ok(await read("agenda:credential:selected"));
    assert.equal(await read("agenda:label:selected"),"fixture");
    const outcomes = await Promise.all([stub.remove(input),stub.remove(input)]);
    assert.equal(outcomes.filter(result=>result.removed).length,1);
    assert.equal(outcomes.filter(result=>result.error).length,1);
    await app.dispose();
    app = boot();
    stub = await stubFor();
    assert.deepEqual(await read("agenda:accounts"),[]);
    assert.equal(await read("agenda:credential:selected"),undefined);
    assert.equal(await read("agenda:cache:selected"),undefined);
    assert.deepEqual(await read("drive:cache"),{files:[{id:"keep"}]});
  } finally {
    await app.dispose();
    await rm(persist,{recursive:true,force:true});
  }
});
