import test from "node:test";
import assert from "node:assert/strict";
import { refreshAgenda, reviewAgenda } from "../src/agenda.js";
import { queueMailSync, runMailBatch } from "../src/mail-scheduler.js";
import {
  prioritySearchPlan,
  mailRetrievalView,
  retrievalBackupFields,
} from "../src/mail-retrieval.js";

function memory(values = new Map()) {
  const storage = {
    values,
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => values.set(key, structuredClone(value)),
    delete: async (key) => values.delete(key),
    transaction: async (fn) => fn(storage),
  };
  return storage;
}
async function setup() {
  const storage = memory();
  await storage.put("agenda:accounts", [
    { id: "a", email: "a@example.test", calendar: "primary" },
  ]);
  await storage.put("agenda:credential:a", {
    token: "fixture",
    expires: Date.now() + 3600000,
  });
  await storage.put("agenda:cache:a", {
    messages: [{ id: "old" }],
    lastSuccess: "2026-01-01T00:00:00Z",
  });
  await queueMailSync(storage);
  return storage;
}
function sender({ overlap = false, capped = false, failure = null } = {}) {
  return async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/messages")) {
      const priority = u.searchParams.get("q").includes("is:important");
      if (priority && failure)
        return new Response("fixture", { status: failure });
      const page = Number(u.searchParams.get("pageToken") || 1);
      const count = priority && !capped ? 2 : 20;
      const offset = priority && !overlap ? 100 : 0;
      return Response.json({
        messages: Array.from({ length: count }, (_, i) => ({
          id: (offset + (page - 1) * 20 + i + 1).toString(16),
        })),
        ...(!priority || capped ? { nextPageToken: String(page + 1) } : {}),
      });
    }
    const id = u.pathname.split("/").at(-1);
    return Response.json({
      id,
      internalDate: "1794700000000",
      payload: {
        mimeType: "text/plain",
        headers: [
          {
            name: "Subject",
            value: parseInt(id, 16) > 100 ? "面接日程の確認" : "メルマガ",
          },
          { name: "From", value: "recruit@example.test" },
        ],
        body: { data: Buffer.from("ご返信ください").toString("base64url") },
      },
    });
  };
}
async function step(storage, send) {
  const job = await storage.get("agenda:mailJob");
  await runMailBatch({}, storage, send, job.nextAt);
}
async function finish(storage, send) {
  let steps = 0;
  while (await storage.get("agenda:mailJob")) {
    assert.ok(++steps <= 12);
    await step(storage, send);
  }
}
test("通常100件の外の重要メールを別検索で取得し、再起動しても両枠完了まで旧一覧を保つ", async () => {
  let storage = await setup();
  for (let i = 0; i < 5; i++) await step(storage, sender());
  assert.equal((await storage.get("agenda:mailJob")).phase, "priority");
  assert.equal((await storage.get("agenda:cache:a")).messages[0].id, "old");
  storage = memory(storage.values);
  await finish(storage, sender());
  const cache = await storage.get("agenda:cache:a");
  assert.equal(cache.messages.length, 102);
  assert.equal(cache.messages.filter((m) => m.priority.important).length, 2);
  assert.equal(cache.retrieval.priority.extraCount, 2);
  assert.equal(cache.retrieval.priority.hasMore, false);
  const plan = await prioritySearchPlan();
  assert.equal(mailRetrievalView(cache, plan).notice, "");
  assert.match(
    mailRetrievalView(
      cache,
      plan,
      Date.parse(cache.retrieval.completedAt) + 91 * 60000,
    ).notice,
    /未取得/,
  );
});
test("重複する候補は一件にまとめ、候補側100件の未取得を警告する", async () => {
  const storage = await setup();
  await finish(storage, sender({ overlap: true, capped: true }));
  const cache = await storage.get("agenda:cache:a");
  assert.equal(cache.messages.length, 100);
  assert.equal(cache.retrieval.priority.count, 100);
  assert.equal(cache.retrieval.priority.extraCount, 0);
  assert.match(
    mailRetrievalView(cache, await prioritySearchPlan()).notice,
    /100件上限/,
  );
});
test("補完検索の権限失敗・通信再試行では通常枠だけを成功保存しない", async () => {
  for (const failure of [403, 503]) {
    const storage = await setup();
    for (let i = 0; i < 5; i++) await step(storage, sender());
    await step(storage, sender({ failure }));
    assert.equal((await storage.get("agenda:cache:a")).messages[0].id, "old");
    if (failure === 503) {
      assert.equal((await storage.get("agenda:mailJob")).retries, 1);
      await finish(storage, sender());
      assert.equal((await storage.get("agenda:cache:a")).messages.length, 102);
    } else {
      assert.equal(await storage.get("agenda:mailJob"), undefined);
      assert.ok((await storage.get("agenda:cache:a")).error);
    }
  }
});
test("優先条件は安全に検索へ加え、除外条件を押し込まず、条件変更中は旧一覧を保つ", async () => {
  const rules = {
    prioritySenders: ["@example.test"],
    priorityKeywords: ["卒業式", 'x" OR in:anywhere'],
    excludedKeywords: ["大学"],
  };
  const plan = await prioritySearchPlan(rules);
  assert.match(plan.query, /from:"example.test"/);
  assert.match(plan.query, /"卒業式"/);
  assert.equal(plan.omittedTerms, 1);
  assert.ok(!plan.query.includes("in:anywhere"));
  assert.equal(
    plan.queryHash,
    (await prioritySearchPlan({ ...rules, excludedKeywords: [] })).queryHash,
  );
  const storage = await setup();
  for (let i = 0; i < 5; i++) await step(storage, sender());
  await storage.put("agenda:priorityRules:a", {
    prioritySenders: [],
    priorityKeywords: ["卒業式"],
    excludedSenders: [],
    excludedKeywords: [],
  });
  // 保存形式は設定APIと共通のラッパー。
  const stored = await storage.get("agenda:priorityRules:a");
  await storage.put("agenda:priorityRules:a", { rules: stored });
  await step(storage, () => assert.fail("条件が変わったまま取得しない"));
  assert.equal((await storage.get("agenda:cache:a")).messages[0].id, "old");
});
test("最大200件の取得範囲は復元可能で、識別子や件数の改ざんを拒否する", async () => {
  const storage = await setup();
  await finish(storage, sender({ capped: true }));
  const cache = await storage.get("agenda:cache:a");
  assert.equal(cache.messages.length, 200);
  const fields = retrievalBackupFields(cache);
  assert.deepEqual(retrievalBackupFields({ ...cache, ...fields }), fields);
  assert.throws(() =>
    retrievalBackupFields({ ...cache, priorityIds: ["ffff"] }),
  );
  const corrupt = structuredClone(cache);
  corrupt.retrieval.priority.extraCount = 0;
  assert.throws(() => retrievalBackupFields(corrupt));
  assert.deepEqual(retrievalBackupFields({ messages: [] }), {});
});

test("手動の通常ページ更新でも補完メールの閲覧・確認記録を保持する", async () => {
  const storage = await setup();
  await finish(storage, sender());
  let cache = await storage.get("agenda:cache:a");
  const result = await refreshAgenda({}, storage, { accountId: "a" }, sender(), cache.retryAt);
  assert.equal(result.messages.length, 22);
  assert.equal(result.retrievalView.extraCount, 2);
  assert.ok(result.messages.find(m => m.id === "65").priority.important);
  const reviewed = await reviewAgenda({}, storage, { accountId: "a", messageId: "65", reviewed: true });
  assert.ok(reviewed.messages.find(m => m.id === "65").review);
  cache = await storage.get("agenda:cache:a");
  const more = await refreshAgenda({}, storage, { accountId: "a", more: true }, sender(), cache.retryAt);
  assert.equal(more.retrievalView.standardCount, 40);
  assert.equal(more.messages.length, 42);
  assert.doesNotThrow(() => retrievalBackupFields(more));
});

test("通常検索で範囲の末尾に到達すれば追加検索せず、古い補完だけを残さない", async () => {
  const storage = await setup();
  await finish(storage, sender());
  const send = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/messages")) {
      assert.ok(!u.searchParams.get("q").includes("is:important"));
      return Response.json({ messages: [{ id: "1" }] });
    }
    return sender()(url, init);
  };
  const cache = await storage.get("agenda:cache:a");
  const result = await refreshAgenda({}, storage, { accountId: "a" }, send, cache.retryAt);
  assert.equal(result.messages.length, 1);
  assert.equal(result.retrievalView.priorityCount, 0);
  assert.equal(result.retrievalView.standardHasMore, false);
  assert.doesNotThrow(() => retrievalBackupFields(result));
  await queueMailSync(storage, cache.retryAt + 60001);
  await finish(storage, send);
  assert.equal((await storage.get("agenda:cache:a")).messages.length, 1);
});
