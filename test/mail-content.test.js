import test from "node:test";
import assert from "node:assert/strict";
import { decodeMessageContent } from "../src/agenda-rules.js";
import { readMailPage } from "../src/agenda-mail.js";
import { queueMailSync, runMailBatch } from "../src/mail-scheduler.js";
import { agendaHome } from "../src/agenda-home.js";
const part = (text, mimeType = "text/plain") => ({
  mimeType,
  body: { data: Buffer.from(text).toString("base64url") },
});
function memory() {
  const values = new Map([
    [
      "agenda:accounts",
      [{ id: "a", email: "a@example.test", calendar: "primary" }],
    ],
    [
      "agenda:credential:a",
      { token: "fixture", expires: Date.now() + 3600000 },
    ],
  ]);
  const storage = {
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => values.set(key, structuredClone(value)),
    delete: async (key) => values.delete(key),
  };
  storage.transaction = async (callback) => callback(storage);
  return storage;
}
function sender(payload, invalidDate = false) {
  return async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/messages"))
      return Response.json({ messages: [{ id: "a" }, { id: "b" }] });
    const id = path.split("/").at(-1);
    return Response.json({
      id,
      internalDate: invalidDate ? "not-date" : String(Date.now()),
      snippet: "面接案内の抜粋",
      payload: {
        ...(id === "a" ? payload : part("学校の授業のお知らせ")),
        headers: [
          {
            name: "Subject",
            value: id === "a" ? "面接のお知らせ" : "学校の授業のお知らせ",
          },
          { name: "From", value: "recruit@example.test" },
        ],
      },
    });
  };
}
test("大きい本文も有界の範囲で解析し、本文一部の印を返す", () => {
  const result = decodeMessageContent(
    part("2027/1/12 10:00〜11:00 面接\n" + "あ".repeat(90000)),
  );
  assert.equal(result.limited, true);
  assert.ok(result.text.length <= 60000);
  assert.match(result.text, /2027/);
});
test("使わない巨大HTMLや添付本文を解析せず、通常のプレーン本文を優先する", () => {
  const result = decodeMessageContent({
    mimeType: "multipart/alternative",
    parts: [
      part("通常本文"),
      part("x".repeat(400000), "text/html"),
      { ...part("添付".repeat(100000)), filename: "attached.txt" },
    ],
  });
  assert.deepEqual(result, { text: "通常本文", limited: false });
});
test("複数パートの合計・深さ・パート数も制限し、途中のscriptを本文へ混ぜない", () => {
  const combined = decodeMessageContent({
    parts: [part("a".repeat(100000)), part("b".repeat(100000))],
  });
  assert.equal(combined.limited, true);
  assert.ok(combined.text.length <= 60000);
  let nested = part("末端");
  for (let n = 0; n < 14; n++) nested = { parts: [nested] };
  assert.equal(decodeMessageContent(nested).limited, true);
  assert.equal(
    decodeMessageContent({
      parts: Array.from({ length: 600 }, () => part("x")),
    }).limited,
    true,
  );
  const html = decodeMessageContent(
    part("<p>案内</p><script>" + "危険な文言".repeat(60000), "text/html"),
  );
  assert.equal(html.limited, true);
  assert.match(html.text, /案内/);
  assert.doesNotMatch(html.text, /危険な文言/);
});
test("実API形式の大きいメールがあっても次のメールを取得し、候補へ原文確認を付ける", async () => {
  const storage = memory();
  const result = await readMailPage(
    {},
    storage,
    { id: "a", email: "a@example.test" },
    null,
    sender(part("面接 2027/1/12 10:00〜11:00 " + "a".repeat(220000))),
  );
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].contentLimited, true);
  assert.equal(result.messages[1].contentLimited, false);
  assert.match(result.messages[0].candidate.reasons.join(" "), /本文の一部/);
  assert.equal(result.messages[0].candidate.status, "確認待ち");
});
test("本文参照だけのメールは抜粋へフォールバックし、未取得を明示する", async () => {
  const result = await readMailPage(
    {},
    memory(),
    { id: "a", email: "a@example.test" },
    null,
    sender({
      mimeType: "text/plain",
      body: { attachmentId: "fixture-reference" },
    }),
  );
  assert.equal(result.messages[0].contentLimited, true);
  assert.equal(result.messages[0].excerpt, "面接案内の抜粋");
});
test("Cronのページ完了を保持し、本文一部をホームの警告にも残す", async () => {
  const storage = memory();
  await queueMailSync(storage);
  const job = await storage.get("agenda:mailJob");
  await runMailBatch(
    {},
    storage,
    sender(part("面接の案内 " + "a".repeat(220000))),
    job.nextAt,
  );
  const cache = await storage.get("agenda:cache:a");
  assert.equal(cache.error, null);
  assert.equal(cache.messages.length, 2);
  assert.equal(cache.messages.filter(message => message.contentLimited).length, 1);
  const home = await agendaHome(storage);
  assert.equal(home.accounts[0].contentLimitedCount, 1);
  assert.equal(home.complete, false);
  assert.ok(home.alerts.some((alert) => alert.message.includes("本文の一部")));
  assert.ok(
    home.groups.some((group) =>
      group.timingNotices.some((notice) =>
        notice.message.includes("本文の一部"),
      ),
    ),
  );
});
test("壊れた本文・受信日時は成功にせず、前回の完全な一覧を保持する", async () => {
  for (const send of [
    sender({ mimeType: "text/plain", body: { data: "%%%" } }),
    sender(part("本文"), true),
  ]) {
    const storage = memory();
    const before = {
      messages: [{ id: "old" }],
      lastSuccess: "2026-01-01T00:00:00Z",
    };
    await storage.put("agenda:cache:a", before);
    await queueMailSync(storage);
    const job = await storage.get("agenda:mailJob");
    await runMailBatch({}, storage, send, job.nextAt);
    const cache = await storage.get("agenda:cache:a");
    assert.deepEqual(cache.messages, before.messages);
    assert.equal(cache.lastSuccess, before.lastSuccess);
    assert.equal(cache.errorCode, "incomplete");
    assert.match(cache.error, /形式|受信日時/);
  }
});

test("HTMLのコメント・style・scriptを本文に混ぜず、不完全なタグで巨大な結果を作らない",()=>{
 const result=decodeMessageContent(part("<p>面接案内</p><!--非表示の締切--><style>.hidden{}</style><script>非表示の予定</script><p>学校連絡</p>","text/html"));
 assert.match(result.text,/面接案内/);assert.match(result.text,/学校連絡/);assert.doesNotMatch(result.text,/非表示|hidden/);
 assert.equal(decodeMessageContent(part("<".repeat(100000),"text/html")).text,"");
});
