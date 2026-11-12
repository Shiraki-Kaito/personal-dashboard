import test from "node:test";
import assert from "node:assert/strict";
import {
  extractAppointment,
  validateAppointment,
  compareAppointments,
  messageText,
} from "../src/agenda-rules.js";
import {
  agendaView,
  refreshAgenda,
  previewAppointment,
  registerAppointment,
  reconcileAppointment,
} from "../src/agenda.js";
import { agendaConnect, agendaScopes } from "../src/agenda-google.js";
const env = {
  GOOGLE_CLIENT_ID: "1-fixture.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "fixture",
};
function memory(values = new Map()) {
  const s = {
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => values.set(key, structuredClone(value)),
    delete: async (key) => values.delete(key),
    transaction: async (fn) => fn(s),
    values,
  };
  return s;
}
const local = {
  title: "面接",
  start: "2027-01-12T10:00",
  end: "2027-01-12T11:00",
  location: "会場",
};
const base = {
  accountId: "a",
  targetAccountId: "b",
  messageId: "abc",
  draft: local,
};

test("メールの続きページを明示取得し、件数と候補を保持する", async () => {
  const { storage } = await setup();
  const now = Date.now();
  const send = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/messages"))
      return Response.json({
        messages: [{ id: u.searchParams.has("pageToken") ? "def" : "abc" }],
        ...(u.searchParams.has("pageToken") ? {} : { nextPageToken: "next" }),
      });
    return Response.json({
      id: u.pathname.split("/").at(-1),
      internalDate: String(now),
      payload: {
        mimeType: "text/plain",
        headers: [{ name: "Subject", value: "面接" }],
        body: {
          data: Buffer.from("2027/1/12 10:00〜11:00").toString("base64url"),
        },
      },
    });
  };
  let view = await refreshAgenda(env, storage, { accountId: "a" }, send, now);
  assert.equal(view.messages.length, 1);
  assert.equal(view.nextPageToken, "next");
  assert.equal(view.messages[0].candidate.start, "2027-01-12T10:00");
  view = await refreshAgenda(
    env,
    storage,
    { accountId: "a", more: true },
    send,
    now + 61000,
  );
  assert.equal(view.messages.length, 2);
  assert.equal(view.nextPageToken, null);
});
test("別アカウントを追加・再接続しても他の接続・Drive資格情報を変更しない", async () => {
  const { storage } = await setup();
  await storage.put("drive:credential", { token: "drive-private" });
  const connect = async (email) => {
    const response = await agendaConnect(
      new Request("https://unit.test/auth/agenda/start", { method: "POST" }),
      env,
      storage,
      { key: "owner" },
    );
    const state = new URL(
      (await response.json()).authorizationUrl,
    ).searchParams.get("state");
    return agendaConnect(
      new Request(
        "https://unit.test/auth/google/callback?code=fixture&state=" + state,
      ),
      env,
      storage,
      { key: "owner" },
      async (url) =>
        new URL(url).pathname.endsWith("/profile")
          ? Response.json({ emailAddress: email })
          : new URL(url).pathname.endsWith("/events")
            ? Response.json({ accessRole: "owner" })
            : Response.json({
                access_token: "new",
                refresh_token: "new-refresh",
                expires_in: 3600,
                scope: agendaScopes.join(" "),
              }),
    );
  };
  assert.equal((await connect("new@example.test")).status, 303);
  assert.equal((await connect("new@example.test")).status, 303);
  const view = await agendaView(env, storage);
  assert.equal(view.accounts.length, 3);
  assert.deepEqual(await storage.get("drive:credential"), {
    token: "drive-private",
  });
  assert.equal((await storage.get("agenda:credential:a")).token, "token-a");
});
test("APIの認証失効は対象アカウントだけ未接続にし、キャッシュを保持する", async () => {
  const { storage } = await setup();
  const view = await refreshAgenda(env, storage, { accountId: "a" }, async () =>
    Response.json({}, { status: 401 }),
  );
  assert.equal(view.accounts.find((a) => a.id === "a").connected, false);
  assert.equal(view.accounts.find((a) => a.id === "b").connected, true);
  assert.equal(view.messages.length, 1);
});
async function setup() {
  const storage = memory();
  await storage.put("agenda:accounts", [
    { id: "a", email: "a@example.test" },
    { id: "b", email: "b@example.test" },
  ]);
  for (const id of ["a", "b"])
    await storage.put("agenda:credential:" + id, {
      token: "token-" + id,
      refresh: "secret-refresh",
      expires: Date.now() + 3600000,
    });
  await storage.put("agenda:cache:a", {
    messages: [{ id: "abc", candidate: {}, subject: "面接" }],
    lastSuccess: "2026-11-12T00:00:00Z",
  });
  const f = {
    events: [],
    inserted: null,
    writes: 0,
    failInsert: false,
    failReadback: false,
    failRead: false,
    pageLoop: false,
  };
  f.send = async (url, options = {}) => {
    const u = new URL(url);
    if (f.failRead) return Response.json({}, { status: 403 });
    if (u.pathname.endsWith("/events")) {
      if (options.method === "POST") {
        f.writes++;
        f.inserted = {
          ...JSON.parse(options.body),
          htmlLink: "https://www.google.com/calendar/event?eid=fixture",
        };
        if (f.failInsert) throw Error("private-error");
        return Response.json(f.inserted);
      }
      return Response.json({
        kind: "calendar#events",
        items: f.events,
        ...(f.pageLoop ? { nextPageToken: "same" } : {}),
      });
    }
    if (u.pathname.includes("/events/")) {
      if (f.failReadback && f.inserted) throw Error("private-error");
      return f.inserted
        ? Response.json(f.inserted)
        : Response.json({}, { status: 404 });
    }
    throw Error("unexpected test request");
  };
  return { storage, f };
}
test("絶対日付・時刻・場所を抽出し、年省略・複数日・変更・不正日付を確認待ちにする", () => {
  assert.deepEqual(
    extractAppointment("面接", "日時：2027年1月12日 10:00〜11:00\n場所：東京")
      .start,
    "2027-01-12T10:00",
  );
  for (const body of [
    "1月12日 10:00〜11:00",
    "2027/1/12 または2027/1/13 10:00〜11:00",
    "2027/1/12 候補 10:00〜11:00",
    "2027/2/29 10:00〜11:00",
  ])
    assert.equal(extractAppointment("面接", body).status, "確認待ち");
  assert.throws(() => validateAppointment({ ...local, end: local.start }));
  assert.throws(() =>
    validateAppointment({ ...local, start: "2027-02-29T10:00" }),
  );
});
test("重複・隣接・終日・予定なし・キャンセルを区別する", () => {
  const draft = validateAppointment(local),
    event = {
      id: "1",
      summary: "面接",
      start: { dateTime: draft.start },
      end: { dateTime: draft.end },
    };
  assert.equal(compareAppointments(draft, [event])[0].duplicate, true);
  assert.equal(
    compareAppointments(draft, [{ ...event, transparency: "transparent" }])
      .length,
    0,
  );
  assert.equal(
    compareAppointments(draft, [
      {
        ...event,
        start: { dateTime: draft.end },
        end: { dateTime: "2027-01-12T12:00:00+09:00" },
      },
    ]).length,
    0,
  );
  assert.equal(
    compareAppointments(draft, [
      { ...event, start: { date: "2027-01-12" }, end: { date: "2027-01-13" } },
    ]).length,
    1,
  );
});
test("メールの平文を優先し、添付本文を読まない", () => {
  const data = Buffer.from("予定です").toString("base64url");
  assert.equal(
    messageText({
      parts: [
        { mimeType: "text/plain", body: { data } },
        { mimeType: "text/plain", filename: "attached.txt", body: { data } },
      ],
    }),
    "予定です",
  );
});
test("複数アカウントの予定を再照合し、変更があれば登録しない", async () => {
  const { storage, f } = await setup(),
    p = await previewAppointment(env, storage, base, f.send);
  f.events = [
    {
      id: "e",
      summary: "別の予定",
      start: { dateTime: p.draft.start },
      end: { dateTime: p.draft.end },
    },
  ];
  await assert.rejects(
    registerAppointment(
      env,
      storage,
      { ...base, confirmed: true, checksum: p.checksum, allowConflict: true },
      f.send,
    ),
    /変わりました/,
  );
  assert.equal(f.writes, 0);
});
test("内容確認後だけ登録し、読み直しで一致確認、二重操作を拒否する", async () => {
  const { storage, f } = await setup(),
    p = await previewAppointment(env, storage, base, f.send);
  await assert.rejects(
    registerAppointment(
      env,
      storage,
      { ...base, checksum: p.checksum },
      f.send,
    ),
    /本人確認/,
  );
  const view = await registerAppointment(
    env,
    storage,
    { ...base, checksum: p.checksum, confirmed: true },
    f.send,
  );
  assert.equal(view.messages[0].operation.phase, "登録確認済み");
  assert.equal(f.writes, 1);
  assert.equal(f.inserted.visibility, "private");
  assert.equal(
    new URL(view.messages[0].operation.calendarUrl).searchParams.get(
      "authuser",
    ),
    "b@example.test",
  );
  assert.equal(f.inserted.attendees, undefined);
  await storage.put("agenda:operation:a:abc", {
    ...view.messages[0].operation,
    calendarUrl: "https://www.google.com/calendar/event?eid=fixture",
  });
  assert.equal(
    new URL(
      (await agendaView(env, storage, "a")).messages[0].operation.calendarUrl,
    ).searchParams.get("authuser"),
    "b@example.test",
  );
  await assert.rejects(
    registerAppointment(
      env,
      storage,
      { ...base, checksum: p.checksum, confirmed: true },
      f.send,
    ),
    /二重登録/,
  );
  assert.equal(JSON.stringify(view).includes("secret-refresh"), false);
  assert.equal(JSON.stringify(view).includes("token-a"), false);
});
test("書き込み後の応答だけ喪失しても永続化・再読込後の照合で再送しない", async () => {
  let { storage, f } = await setup();
  const p = await previewAppointment(env, storage, base, f.send);
  f.failInsert = true;
  const failed = await registerAppointment(
    env,
    storage,
    { ...base, checksum: p.checksum, confirmed: true },
    f.send,
  );
  assert.equal(failed.messages[0].operation.phase, "登録結果未確認");
  storage = memory(storage.values);
  f.failInsert = false;
  const verified = await reconcileAppointment(env, storage, base, f.send);
  assert.equal(verified.messages[0].operation.phase, "登録確認済み");
  assert.equal(f.writes, 1);
});

test("元メールが一覧から外れても、結果不明の操作を保持して照合できる", async () => {
  const { storage, f } = await setup(),
    p = await previewAppointment(env, storage, base, f.send);
  f.failInsert = true;
  await registerAppointment(
    env,
    storage,
    { ...base, checksum: p.checksum, confirmed: true },
    f.send,
  );
  await storage.put("agenda:cache:a", { messages: [] });
  const saved = await agendaView(env, storage, "a");
  assert.equal(saved.pendingRegistrations.length, 1);
  assert.equal(saved.pendingRegistrations[0].messageId, "abc");
  f.failInsert = false;
  const view = await reconcileAppointment(env, storage, base, f.send);
  assert.equal(view.pendingRegistrations.length, 0);
  assert.equal(f.writes, 1);
  assert.equal(
    (await storage.get("agenda:operation:a:abc")).phase,
    "登録確認済み",
  );
});

test("手入力は実メールと区別し、登録確認と再読込後の記録を保持する", async () => {
  const { storage, f } = await setup();
  const input = {
    ...base,
    manual: true,
    messageId: "manual-" + crypto.randomUUID(),
  };
  const p = await previewAppointment(env, storage, input, f.send);
  const view = await registerAppointment(
    env,
    storage,
    { ...input, checksum: p.checksum, confirmed: true },
    f.send,
  );
  assert.equal(view.messages[0].operation, null);
  assert.equal(view.manualRegistrations.length, 1);
  assert.equal(view.manualRegistrations[0].sourceType, "manual");
  assert.equal(view.manualRegistrations[0].phase, "登録確認済み");
  const reloaded = await agendaView(env, memory(storage.values), "a");
  assert.equal(
    reloaded.manualRegistrations[0].eventId,
    view.manualRegistrations[0].eventId,
  );
  assert.equal(f.writes, 1);
  await assert.rejects(
    previewAppointment(env, storage, { ...input, messageId: "abc" }, f.send),
    /識別子/,
  );
  await assert.rejects(
    previewAppointment(env, storage, { ...input, manual: false }, f.send),
    /保存済み/,
  );
});
test("結果不明の予定が見つからない場合は再送せず、外部編集も上書きしない", async () => {
  const { storage, f } = await setup(),
    p = await previewAppointment(env, storage, base, f.send);
  f.failReadback = true;
  await registerAppointment(
    env,
    storage,
    { ...base, checksum: p.checksum, confirmed: true },
    f.send,
  );
  f.failReadback = false;
  f.inserted.summary = "外部変更";
  let result = await reconcileAppointment(env, storage, base, f.send);
  assert.match(result.messages[0].operation.error, /変更・削除/);
  assert.equal(result.messages[0].operation.phase, "予定の変更・削除を検知");
  f.inserted = null;
  result = await reconcileAppointment(env, storage, base, f.send);
  assert.match(result.messages[0].operation.error, /再送していません/);
  assert.equal(f.writes, 1);
});
test("重複・権限不足・ページ循環では登録を停止する", async () => {
  for (const scenario of ["duplicate", "permission", "loop"]) {
    const { storage, f } = await setup();
    if (scenario === "duplicate") {
      const d = validateAppointment(local);
      f.events = [
        {
          id: "e",
          summary: d.title,
          start: { dateTime: d.start },
          end: { dateTime: d.end },
        },
      ];
      const p = await previewAppointment(env, storage, base, f.send);
      await assert.rejects(
        registerAppointment(
          env,
          storage,
          {
            ...base,
            checksum: p.checksum,
            confirmed: true,
            allowConflict: true,
          },
          f.send,
        ),
        /同じ日時/,
      );
    } else {
      f.failRead = scenario === "permission";
      f.pageLoop = scenario === "loop";
      await assert.rejects(previewAppointment(env, storage, base, f.send));
    }
    assert.equal(f.writes, 0);
  }
});
test("メール取得失敗でも最後の一覧を保持し、秘密値を返さない", async () => {
  const { storage } = await setup();
  const view = await refreshAgenda(env, storage, { accountId: "a" }, async () =>
    Response.json({}, { status: 403 }),
  );
  assert.equal(view.errorCode, "permission");
  assert.equal(view.messages[0].id, "abc");
  assert.equal(view.lastSuccess, "2026-11-12T00:00:00Z");
});
test("OAuth stateをセッションに結び付け、許可不足時は既存接続を保持する", async () => {
  const { storage } = await setup();
  const start = await agendaConnect(
    new Request("https://unit.test/auth/agenda/start", { method: "POST" }),
    env,
    storage,
    { key: "owner" },
  );
  const state = new URL((await start.json()).authorizationUrl).searchParams.get(
    "state",
  );
  const callback = new Request(
    "https://unit.test/auth/google/callback?code=fixture&state=" + state,
  );
  assert.equal(
    (
      await agendaConnect(callback, env, storage, { key: "other" }, () =>
        assert.fail(),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await agendaConnect(callback, env, storage, { key: "owner" }, async () =>
        Response.json({
          access_token: "new",
          refresh_token: "new-refresh",
          expires_in: 3600,
          scope: agendaScopes[0],
        }),
      )
    ).status,
    503,
  );
  assert.equal((await agendaView(env, storage)).accounts.length, 2);
});
