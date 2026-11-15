import test from "node:test";
import assert from "node:assert/strict";
import { queueMailSync, runMailBatch } from "../src/mail-scheduler.js";
import { mailPriority } from "../src/agenda-priority.js";
import { recordMailRun } from "../src/agenda-mail.js";
import { saveAccountLabel, displayAccounts } from "../src/agenda-labels.js";
import { isPersonalWork, driveView } from "../src/drive.js";
import { nextAlarmAt } from "../src/scheduler.js";

function memory(values = new Map()) {
  const s = {
    values,
    get: async (k) => structuredClone(values.get(k)),
    put: async (k, v) => values.set(k, structuredClone(v)),
    delete: async (k) => values.delete(k),
    transaction: async (fn) => fn(s),
  };
  return s;
}
async function setup() {
  const s = memory();
  await s.put(
    "agenda:accounts",
    ["a", "b"].map((id) => ({
      id,
      email: id + "@example.test",
      calendar: "primary",
    })),
  );
  for (const id of ["a", "b"])
    await s.put("agenda:credential:" + id, {
      token: "fixture-" + id,
      expires: Date.now() + 3600000,
    });
  return s;
}
const sender = async (url, init) => {
  assert.equal(init.method, "GET");
  const u = new URL(url);
  if (u.pathname.endsWith("/messages")) {
    const page = Number(u.searchParams.get("pageToken") || 1);
    return Response.json({
      messages: Array.from({ length: 20 }, (_, i) => ({
        id: ((page - 1) * 20 + i + 1).toString(16),
      })),
      nextPageToken: String(page + 1),
    });
  }
  return Response.json({
    id: u.pathname.split("/").at(-1),
    internalDate: String(Date.now()),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "Subject", value: "面接日程の確認" },
        { name: "From", value: "recruit@example.test" },
      ],
      body: {
        data: Buffer.from("ご返信ください 2027/1/12 14時〜15時").toString(
          "base64url",
        ),
      },
    },
  });
};
test("定期取得は分割・上限・再起動・重複開始を扱い、通常・重要候補の両枠完了までは古い一覧を保持する", async () => {
  let s = await setup();
  const now = Date.now();
  await s.put("agenda:cache:a", {
    messages: [{ id: "old" }],
    lastSuccess: "2026-01-01T00:00:00Z",
  });
  await queueMailSync(s, now);
  const first = await s.get("agenda:mailJob");
  await queueMailSync(s, now + 1);
  assert.deepEqual(await s.get("agenda:mailJob"), first);
  assert.equal(await nextAlarmAt(s, now), first.nextAt);
  let batches = 0;
  while (await s.get("agenda:mailJob")) {
    const job = await s.get("agenda:mailJob");
    let calls = 0;
    await runMailBatch(
      {},
      s,
      async (...args) => {
        calls++;
        return sender(...args);
      },
      job.nextAt,
    );
    assert.ok(calls <= 21);
    batches++;
    if (batches === 1) {
      assert.equal((await s.get("agenda:cache:a")).messages[0].id, "old");
      s = memory(s.values);
    }
    assert.ok(batches <= 20);
  }
  assert.equal(batches, 20);
  for (const id of ["a", "b"]) {
    const cache = await s.get("agenda:cache:" + id),
      history = await s.get("agenda:history:" + id);
    assert.equal(cache.messages.length, 100);
    assert.equal(cache.limited, true);
    assert.equal(cache.error, null);
    assert.equal(history.length, 1);
    assert.equal(history[0].source, "cron");
    assert.equal(history[0].pages, 10);
    assert.equal(history[0].hasMore, true);
    assert.ok(cache.messages.every((m) => m.priority.important));
  }
});
test("通信失敗の待機と回数に上限を設け、復旧後は履歴と成功時刻を残す", async () => {
  let s = await setup();
  await s.put("agenda:accounts", [{ id: "a", email: "a@example.test" }]);
  const now = Date.now();
  await queueMailSync(s, now);
  const start = await s.get("agenda:mailJob");
  await runMailBatch(
    {},
    s,
    async () => {
      throw Error("fixture private");
    },
    start.nextAt,
  );
  let job = await s.get("agenda:mailJob");
  assert.equal(job.retries, 1);
  assert.ok(job.nextAt >= start.nextAt + 60000);
  await runMailBatch({}, s, () => assert.fail("待機中"), job.nextAt - 1);
  s = memory(s.values);
  await runMailBatch(
    {},
    s,
    async () => Response.json({ messages: [] }),
    job.nextAt,
  );
  assert.equal(await s.get("agenda:mailJob"), undefined);
  const history = await s.get("agenda:history:a");
  assert.deepEqual(
    history.map((h) => h.outcome),
    ["success", "failure"],
  );
  assert.equal(history[1].errorCode, "network");
  assert.equal(JSON.stringify(history).includes("fixture private"), false);
});
test("再試行を使い切ったら次の接続へ進み、認証失効でも前の一覧・成功時刻を保持する", async () => {
  const s = await setup(),
    now = Date.now();
  await s.put("agenda:cache:a", {
    messages: [{ id: "old" }],
    lastSuccess: "2026-01-01T00:00:00Z",
  });
  await queueMailSync(s, now);
  for (let i = 0; i < 3; i++) {
    const job = await s.get("agenda:mailJob");
    assert.equal(job.index, 0);
    await runMailBatch(
      {},
      s,
      async () => Response.json({}, { status: 500 }),
      job.nextAt,
    );
  }
  const job = await s.get("agenda:mailJob");
  assert.equal(job.index, 1);
  await runMailBatch(
    {},
    s,
    async () => Response.json({}, { status: 401 }),
    job.nextAt,
  );
  assert.equal(await s.get("agenda:mailJob"), undefined);
  assert.equal((await s.get("agenda:cache:a")).messages[0].id, "old");
  assert.equal(
    (await s.get("agenda:cache:a")).lastSuccess,
    "2026-01-01T00:00:00Z",
  );
  assert.equal((await s.get("agenda:credential:b")).invalid, true);
  assert.equal((await s.get("agenda:credential:a")).invalid, undefined);
});
test("履歴は72件で止まり、表示名は接続や認証を変更せず保存・再読込・解除できる", async () => {
  const s = await setup(),
    before = await s.get("agenda:credential:a");
  for (let i = 0; i < 80; i++) await recordMailRun(s, "a", { count: i });
  assert.equal((await s.get("agenda:history:a")).length, 72);
  await saveAccountLabel(s, { accountId: "a", label: "就活" });
  assert.equal((await displayAccounts(memory(s.values)))[0].label, "就活");
  assert.deepEqual(await s.get("agenda:credential:a"), before);
  assert.equal((await displayAccounts(s))[1].label, "");
  for (const input of [
    { accountId: "other", label: "private" },
    { accountId: "a", label: "x".repeat(41) },
    { accountId: "a", label: "bad\nlabel" },
  ])
    await assert.rejects(saveAccountLabel(s, input));
  await saveAccountLabel(s, { accountId: "a", label: "" });
  assert.equal((await displayAccounts(s))[0].label, "");
});
test("就活と学校の対応事項を優先し、販促と金融ニュースはその他へ残す", () => {
  for (const m of [
    { subject: "一次面接の日程確定" },
    { subject: "履修登録の提出締切" },
    { subject: "授業の連絡", from: "教務 <office@example.ac.jp>" },
  ])
    assert.equal(mailPriority(m).important, true);
  for (const subject of [
    "おすすめ求人キャンペーン",
    "銀行の年末ATM休止のご案内",
    "ニュース・面接対策特集",
    "ファンド投票受付中",
  ])
    assert.equal(mailPriority({ subject }).important, false);
});
test("Driveの個人作業は正確なパス区分だけで分け、元の未確認を保持する", async () => {
  assert.equal(
    isPersonalWork({ folder: "Root / 個人作業 / 名前 / 依頼書" }),
    true,
  );
  assert.equal(isPersonalWork({ folder: "Root / 個人作業用 / 名前" }), true);
  for (const name of ["900_白木_個人作業", "９００＿白木＿個人作業用", "白木-個人作業", "900 個人作業"])
    assert.equal(isPersonalWork({ folder: "Root / " + name + " / 子フォルダ" }), true);
  assert.equal(isPersonalWork({ folder: "Root / 個人作業の共有成果" }), false);
  assert.equal(isPersonalWork({ folder: "Root / 900_個人作業_共有成果" }), false);
  const s = memory();
  const file = {
    id: "f",
    folder: "Root / 個人作業 / 名前",
    name: "試験",
    mimeType: "text/plain",
    createdTime: new Date().toISOString(),
    modifiedTime: new Date().toISOString(),
    events: ["更新"],
    changeId: "v1",
    detectedAt: Date.now(),
  };
  await s.put("drive:cache", {
    scope: "root:true",
    files: [file],
    unreadChanges: [file],
    viewVersion: 3,
  });
  const view = await driveView(
    {
      DRIVE_CONFIG: JSON.stringify({
        folderId: "root",
        includeSubfolders: true,
      }),
    },
    s,
  );
  assert.equal(view.unreadChanges[0].personal, true);
  assert.equal((await s.get("drive:cache")).unreadChanges.length, 1);
  assert.equal((await s.get("drive:cache")).unreadChanges[0].changeId, "v1");
});
