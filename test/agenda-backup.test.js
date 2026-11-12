import test from "node:test";
import assert from "node:assert/strict";
import { createBackup, backupPlan, restoreBackup } from "../src/backup.js";
import { digest, extractAppointment } from "../src/agenda-rules.js";
import { assertBackupEnvelope } from "../public/backup-format.js";
import { reconcileAppointment } from "../src/agenda.js";

const env = { PROJECT_CONFIG: JSON.stringify({ projects: [] }) };
test("表示名と重要判定を復元し、既存の別名を上書きしない", async () => {
  const { source, target, accounts } = await fixture();
  await source.put("agenda:label:" + accounts[0].id, "就活");
  const key = "agenda:cache:" + accounts[0].id,
    cache = await source.get(key);
  cache.messages[0].priority = {
    category: "career",
    important: true,
    reason: "選考の連絡",
  };
  await source.put(key, cache);
  const backup = await createBackup(env, source),
    plan = await backupPlan(env, target, backup);
  await restoreBackup(env, target, backup, plan.checksum);
  assert.equal(await target.get("agenda:label:" + accounts[0].id), "就活");
  assert.equal((await target.get(key)).messages[0].priority.important, true);
  const fresh = memory();
  await fresh.put("agenda:accounts", accounts);
  await fresh.put("agenda:label:" + accounts[0].id, "private");
  const conflict = await backupPlan(env, fresh, backup);
  assert.ok(conflict.conflicts.length);
  await assert.rejects(restoreBackup(env, fresh, backup, conflict.checksum));
  assert.equal(await fresh.get("agenda:label:" + accounts[0].id), "private");
});
function memory() {
  const values = new Map();
  const s = {
    values,
    get: async (key) => {
      if (/credential|session|flow/.test(key))
        throw Error("資格情報へのアクセス禁止");
      return structuredClone(values.get(key));
    },
    put: async (key, value) => values.set(key, structuredClone(value)),
    list: async ({ prefix }) =>
      new Map([...values].filter(([key]) => key.startsWith(prefix))),
    transaction: async (fn) => fn(s),
  };
  return s;
}
async function fixture() {
  const source = memory(),
    target = memory();
  const accounts = await Promise.all(
    ["one@example.test", "two@example.test"].map(async (email) => ({
      id: await digest(email),
      email,
      calendar: "primary",
    })),
  );
  await source.put("agenda:accounts", accounts);
  await target.put("agenda:accounts", accounts);
  const [a, b] = accounts;
  const manual = "manual-00000000-0000-4000-8000-000000000001";
  const message = {
    id: "abc",
    subject: "会議",
    from: "fixture@example.test",
    receivedAt: "2026-11-12T00:00:00Z",
    excerpt: "本文抜粋",
    candidate: extractAppointment("会議", "2027/1/12 10:00-11:00"),
    url: "https://untrusted.test",
  };
  await source.put("agenda:cache:" + a.id, {
    messages: [message],
    lastSuccess: message.receivedAt,
    nextPageToken: "not-exported",
    error: "not-exported",
  });
  await source.put("agenda:reviews:" + a.id, {
    abc: { reviewedAt: message.receivedAt },
  });
  for (const id of ["abc", manual])
    await source.put("agenda:operation:" + a.id + ":" + id, {
      eventId: "pd" + (await digest({ source: a.id, message: id })),
      targetAccountId: b.id,
      draft: {
        title: "試験",
        location: "",
        start: "2027-01-12T01:00:00.000Z",
        end: "2027-01-12T02:00:00.000Z",
      },
      sourceType: id === manual ? "manual" : "mail",
      phase: "登録確認済み",
      lastSuccess: message.receivedAt,
      calendarUrl: "https://untrusted.test",
      error: "not-exported",
    });
  await source.put("agenda:pending:" + a.id, [manual]);
  await source.put("agenda:manualHistory:" + a.id, [manual]);
  await source.put("agenda:preview:" + a.id + ":abc", {
    checksum: "not-exported",
  });
  return { source, target, accounts, manual };
}

test("2アカウントのメール・確認・手入力・結果不明を秘密値なしで保存し、安全に復元する", async () => {
  const { source, target, accounts, manual } = await fixture();
  const backup = await createBackup(env, source);
  assert.equal(backup.version, 2);
  assert.equal(backup.agenda.length, 2);
  assert.doesNotThrow(() => assertBackupEnvelope(backup));
  assert.equal(JSON.stringify(backup).includes("not-exported"), false);
  const plan = await backupPlan(env, target, backup);
  assert.equal(plan.agendaMessages, 1);
  assert.equal(plan.agendaOperations, 2);
  assert.deepEqual(plan.conflicts, []);
  await restoreBackup(env, target, backup, plan.checksum);
  const id = accounts[0].id;
  const cache = await target.get("agenda:cache:" + id);
  assert.equal(cache.messages[0].excerpt, "本文抜粋");
  assert.equal(cache.messages[0].candidate.isCandidate, true);
  assert.match(cache.messages[0].url, /^https:\/\/mail.google.com\//);
  assert.equal(cache.nextPageToken, null);
  assert.equal(cache.limited, true);
  assert.equal(cache.errorCode, "restored");
  assert.deepEqual(await target.get("agenda:pending:" + id), ["abc", manual]);
  assert.equal(
    (await target.get("agenda:reviews:" + id)).abc.reviewedAt,
    "2026-11-12T00:00:00Z",
  );
  assert.match(
    (await target.get("agenda:operation:" + id + ":abc")).phase,
    /再照合待ち/,
  );
  assert.equal(
    (await target.get("agenda:operation:" + id + ":abc")).calendarUrl,
    null,
  );
  assert.deepEqual(await target.get("agenda:accounts"), accounts);
  assert.equal(
    [...target.values.keys()].some((k) => /credential|preview/.test(k)),
    false,
  );
  await assert.rejects(
    restoreBackup(env, target, backup, plan.checksum),
    /停止/,
  );
});

test("接続先の相違・孤立参照・改変ID・件数超過を拒否する", async () => {
  const { source, target } = await fixture(),
    backup = await createBackup(env, source);
  await assert.rejects(backupPlan(env, memory(), backup), /先に接続/);
  for (const mutate of [
    (b) => (b.agenda[0].account.email = "other@example.test"),
    (b) => (b.agenda[0].operations[0].targetAccountId = "other"),
    (b) => (b.agenda[0].operations[0].eventId = "pd" + "a".repeat(64)),
    (b) => (b.agenda[0].pending = ["deadbeef"]),
    (b) => (b.agenda[0].manualHistory = ["abc"]),
    (b) => b.agenda[0].cache.messages.push(b.agenda[0].cache.messages[0]),
    (b) => (b.agenda[0].cache.messages[0].candidate.reasons = null),
    (b) => (b.agenda[0].operations[0].draft.end = "bad-date"),
    (b) => b.agenda.push(...Array(5).fill(b.agenda[0])),
  ]) {
    const invalid = structuredClone(backup);
    mutate(invalid);
    await assert.rejects(backupPlan(env, target, invalid));
    assert.equal(
      await target.get("agenda:cache:" + backup.agenda[0].account.id),
      undefined,
    );
  }
});

test("確認後に追加された孤立操作も検知し、一部だけ復元しない", async () => {
  const { source, target, accounts } = await fixture(),
    backup = await createBackup(env, source);
  const plan = await backupPlan(env, target, backup);
  await target.put("agenda:operation:" + accounts[0].id + ":deadbeef", {
    phase: "既存",
  });
  await assert.rejects(
    restoreBackup(env, target, backup, plan.checksum),
    /停止/,
  );
  assert.equal(await target.get("agenda:cache:" + accounts[0].id), undefined);
  assert.equal(
    (await target.get("agenda:operation:" + accounts[0].id + ":deadbeef"))
      .phase,
    "既存",
  );
});

test("v1バックアップを引き続き復元でき、メール情報を作らない", async () => {
  const backup = await createBackup(env, memory());
  backup.version = 1;
  delete backup.agenda;
  const target = memory(),
    plan = await backupPlan(env, target, backup);
  await restoreBackup(env, target, backup, plan.checksum);
  assert.equal(target.values.size, 0);
});

test("復元した登録済み操作はGET照合だけで成功へ戻し、予定を再送しない", async () => {
  const { source, target, accounts } = await fixture(),
    backup = await createBackup(env, source);
  const plan = await backupPlan(env, target, backup);
  await restoreBackup(env, target, backup, plan.checksum);
  // 照合テストに限り模擬資格情報を与える。エクスポート／復元処理は読まない。
  const get = target.get;
  target.get = async (key) =>
    key.startsWith("agenda:credential:")
      ? { token: "fixture", expires: Date.now() + 3600000 }
      : get(key);
  const operation = await get("agenda:operation:" + accounts[0].id + ":abc");
  const methods = [];
  await reconcileAppointment(
    env,
    target,
    { accountId: accounts[0].id, messageId: "abc" },
    async (url, init) => {
      methods.push(init.method);
      assert.match(String(url), new RegExp(operation.eventId));
      return Response.json({
        id: operation.eventId,
        summary: operation.draft.title,
        location: "",
        start: { dateTime: operation.draft.start },
        end: { dateTime: operation.draft.end },
        extendedProperties: {
          private: { dashboardOperation: operation.eventId },
        },
      });
    },
  );
  assert.deepEqual(methods, ["GET"]);
  assert.equal(
    (await get("agenda:operation:" + accounts[0].id + ":abc")).phase,
    "登録確認済み",
  );
  assert.equal(
    (await get("agenda:pending:" + accounts[0].id)).includes("abc"),
    false,
  );
});
