import test from "node:test";
import assert from "node:assert/strict";
import {
  slackConnect,
  slackToken,
  publicSlackScopes,
  configureSlackApplication,
} from "../src/slack-auth.js";
import { SlackError, slackRequest } from "../src/slack-http.js";
import { slackWorkspaceStore } from "../src/slack-store.js";
import {
  dashboardSlackView,
  addSlackChannel,
  queueAllSlackSync,
  runNextSlackBatch,
  queueSlackSync,
  runSlackBatch,
  slackMessagesView,
  reviewSlackMessage,
  stopSlack,
} from "../src/slack.js";
import { nextAlarmAt } from "../src/scheduler.js";

const env = {
  SLACK_CLIENT_ID: "fixture-client",
  SLACK_CLIENT_SECRET: "fixture-secret",
};
const team = "T00000001",
  other = "T00000002",
  channel = "C00000001";
function memory(values = new Map()) {
  const storage = {
    values,
    get: async (k) => structuredClone(values.get(k)),
    put: async (k, v) => values.set(k, structuredClone(v)),
    delete: async (k) => values.delete(k),
    transaction: async (fn) => fn(storage),
  };
  return storage;
}
const start = (s, teamId = team, includePrivate = false) =>
  slackConnect(
    new Request("https://dashboard.test/auth/slack/start", {
      method: "POST",
      body: JSON.stringify({ teamId, includePrivate }),
    }),
    env,
    s,
    { key: "owner" },
  );
async function callback(s, send, sessionKey = "owner") {
  const flow = await s.get("slack:flow");
  return slackConnect(
    new Request(
      "https://dashboard.test/auth/slack/callback?code=fixture&state=" +
        flow.state,
    ),
    env,
    s,
    { key: sessionKey },
    send,
  );
}
function oauth(teamId = team, scope = publicSlackScopes.join(",")) {
  return async (url) =>
    Response.json(
      String(url).endsWith("auth.test")
        ? { ok: true, team_id: teamId, bot_id: "B00000001" }
        : {
            ok: true,
            team: { id: teamId, name: "試験Slack" },
            token_type: "bot",
            scope,
            access_token: "fixture-bot",
          },
    );
}
async function setup(s = memory()) {
  await start(s);
  assert.equal((await callback(s, oauth())).status, 303);
  const scoped = slackWorkspaceStore(s, team);
  await scoped.put("slack:channels", [
    { id: channel, name: "試験", private: false },
  ]);
  return { s, scoped };
}
const message = (
  ts = "1763000000.000001",
  text = "[試験] 対応お願いします",
) => ({ type: "message", ts, text, user: "U00000001", reply_count: 2 });
const page = (messages, extra = {}) =>
  Response.json({ ok: true, messages, ...extra });

test("専用OAuthの最小権限、本人state、対象team、権限過不足を検証する", async () => {
  const s = memory(),
    response = await start(s),
    url = new URL((await response.json()).authorizationUrl);
  assert.equal(url.searchParams.get("scope"), "channels:read,channels:history");
  assert.equal(url.searchParams.has("user_scope"), false);
  await assert.rejects(callback(s, () => assert.fail(), "other"));
  assert.equal((await callback(s, oauth())).status, 303);
  const view = await dashboardSlackView(env, s);
  assert.equal(view.workspaces[0].connected, true);
  assert.equal(JSON.stringify(view).includes("fixture-bot"), false);
  for (const [requestedPrivate, responseTeam, scope] of [
    [false, other, "channels:read,channels:history"],
    [false, team, "channels:read,channels:history,chat:write"],
    [true, team, "channels:read,channels:history"],
  ]) {
    const rejected = memory();
    await start(rejected, team, requestedPrivate);
    assert.equal(
      (await callback(rejected, oauth(responseTeam, scope))).status,
      409,
    );
    assert.equal(await rejected.get("slack:workspaces"), undefined);
  }
});

test("後から別ワークスペース・チャンネルを追加し、同じchannel IDでも保存領域を混ぜない", async () => {
  const { s, scoped } = await setup();
  await start(s, other);
  await callback(s, oauth(other));
  const second = slackWorkspaceStore(s, other);
  await second.put("slack:channels", [{ id: channel, name: "別の試験" }]);
  await scoped.put("slack:cache:" + channel, {
    messages: [{ ts: "1763000000.000001", text: "one" }],
  });
  await second.put("slack:cache:" + channel, {
    messages: [{ ts: "1763000000.000001", text: "two" }],
  });
  assert.equal(
    (await dashboardSlackView(env, s, team)).channels[0].messages[0].text,
    "one",
  );
  assert.equal(
    (await dashboardSlackView(env, s, other)).channels[0].messages[0].text,
    "two",
  );
  await addSlackChannel(env, scoped, { channelId: "C00000002" }, async () =>
    Response.json({
      ok: true,
      channel: { id: "C00000002", name: "追加", is_member: true },
    }),
  );
  assert.equal((await scoped.get("slack:channels")).length, 2);
  await assert.rejects(
    addSlackChannel(env, scoped, { channelId: "C00000003" }, async () =>
      Response.json({
        ok: true,
        channel: { id: "C00000003", is_member: false },
      }),
    ),
    /参加/,
  );
  await assert.rejects(
    addSlackChannel(env, scoped, { channelId: "G00000001" }, async () =>
      Response.json({
        ok: true,
        channel: { id: "G00000001", is_member: true, is_private: true },
      }),
    ),
    /非公開/,
  );
});

test("Cron・ページ取得・再起動で前回一覧を保持し、全ページ完了時だけ確定する", async () => {
  const { s, scoped } = await setup(),
    now = Date.now();
  await scoped.put("slack:cache:" + channel, {
    messages: [{ ts: "1762000000.000001", text: "old" }],
    lastSuccess: "2026-11-01T00:00:00Z",
  });
  await queueAllSlackSync(s, now);
  assert.equal(await nextAlarmAt(s, now), now + 61000);
  const original = await scoped.get("slack:job");
  await queueAllSlackSync(s, now + 1);
  assert.deepEqual(await scoped.get("slack:job"), original);
  await runNextSlackBatch(
    env,
    s,
    async (url, init) => {
      assert.equal(new URLSearchParams(init.body).get("limit"), "15");
      return page([message()], {
        has_more: true,
        response_metadata: { next_cursor: "next" },
      });
    },
    now + 61000,
  );
  assert.equal(
    (await scoped.get("slack:cache:" + channel)).messages[0].text,
    "old",
  );
  const restored = memory(structuredClone(s.values)),
    restoredScope = slackWorkspaceStore(restored, team);
  await runNextSlackBatch(
    env,
    restored,
    async () => page([message("1763000001.000001")]),
    now + 122000,
  );
  assert.equal(await restoredScope.get("slack:job"), undefined);
  const result = await slackMessagesView(env, restoredScope);
  assert.equal(result.channels[0].messages.length, 2);
  assert.equal(result.channels[0].source, "cron");
  assert.ok(result.channels[0].messages[0].revision);
});

test("429・一時障害は待機と上限を守り、権限エラー・循環では旧キャッシュを保持", async () => {
  const { scoped } = await setup(),
    now = Date.now();
  await scoped.put("slack:cache:" + channel, {
    messages: [],
    lastSuccess: "2026-11-01T00:00:00Z",
  });
  await queueSlackSync(scoped, now);
  const limited = async () =>
    new Response("", { status: 429, headers: { "retry-after": "120" } });
  await runSlackBatch(env, scoped, limited, now + 61000);
  let job = await scoped.get("slack:job");
  assert.equal(job.retries, 1);
  assert.ok(job.nextAt >= now + 121000);
  await runSlackBatch(
    env,
    scoped,
    async () =>
      Response.json({
        ok: false,
        error: "missing_scope",
        detail: "secret detail",
      }),
    job.nextAt,
  );
  assert.equal(await scoped.get("slack:job"), undefined);
  const cache = await scoped.get("slack:cache:" + channel);
  assert.equal(cache.lastSuccess, "2026-11-01T00:00:00Z");
  assert.equal(cache.errorCode, "permission");
  assert.equal(JSON.stringify(cache).includes("secret detail"), false);
  await queueSlackSync(scoped, now);
  for (let i = 0; i < 3; i++) {
    job = await scoped.get("slack:job");
    await runSlackBatch(
      env,
      scoped,
      async () => new Response("", { status: 503 }),
      job.nextAt,
    );
  }
  assert.equal(await scoped.get("slack:job"), undefined);
});

test("上限・Slack履歴制限を表示し、本文・スレッド返信・添付を全件取得扱いしない", async () => {
  const { scoped } = await setup(),
    now = Date.now();
  await queueSlackSync(scoped, now);
  for (let i = 0; i < 10; i++) {
    const job = await scoped.get("slack:job");
    await runSlackBatch(
      env,
      scoped,
      async () =>
        page([message(String(1763000000 + i) + ".000001", "x".repeat(7000))], {
          has_more: true,
          is_limited: true,
          response_metadata: { next_cursor: "page" + i },
        }),
      job.nextAt,
    );
  }
  const view = await slackMessagesView(env, scoped),
    cache = view.channels[0];
  assert.equal(cache.limited, true);
  assert.equal(cache.hasMore, true);
  assert.equal(cache.pages, 10);
  assert.equal(cache.messages[0].text.length, 6000);
  assert.equal(cache.messages[0].truncated, true);
  assert.equal(cache.messages[0].replyCount, 2);
});

test("確認済みは投稿変更で無効にし、接続停止は別workspaceとキャッシュを保持する", async () => {
  const { s, scoped } = await setup(),
    now = Date.now();
  await queueSlackSync(scoped, now);
  await runSlackBatch(env, scoped, async () => page([message()]), now + 61000);
  const view = await slackMessagesView(env, scoped),
    m = view.channels[0].messages[0];
  await reviewSlackMessage(env, scoped, {
    channelId: channel,
    ts: m.ts,
    revision: m.revision,
    reviewed: true,
  });
  const cache = await scoped.get("slack:cache:" + channel);
  cache.messages[0].text = "changed";
  await scoped.put("slack:cache:" + channel, cache);
  await assert.rejects(
    reviewSlackMessage(env, scoped, {
      channelId: channel,
      ts: m.ts,
      revision: m.revision,
      reviewed: true,
    }),
    /変わった/,
  );
  await start(s, other);
  await callback(s, oauth(other));
  await stopSlack(env, scoped, { confirm: true });
  assert.ok(await scoped.get("slack:cache:" + channel));
  assert.ok(await scoped.get("slack:reviews:" + channel));
  assert.equal(
    (await dashboardSlackView(env, s, other)).connection.connected,
    true,
  );
  assert.equal(
    (await dashboardSlackView(env, s, team)).connection.connected,
    false,
  );
});

test("回転トークンは更新し、更新応答不明では同じ要求を再送せず再認可にする", async () => {
  const { scoped } = await setup();
  await scoped.put("slack:credential", {
    token: "old",
    refresh: "fixture-refresh",
    expires: 1,
    scopes: publicSlackScopes,
    refreshCount: 0,
  });
  assert.equal(
    await slackToken(env, scoped, async () =>
      Response.json({
        ok: true,
        access_token: "new",
        token_type: "bot",
        refresh_token: "next",
        expires_in: 3600,
        scope: publicSlackScopes.join(","),
      }),
    ),
    "new",
  );
  assert.equal((await scoped.get("slack:credential")).refreshCount, 1);
  await scoped.put("slack:credential", {
    ...(await scoped.get("slack:credential")),
    expires: 1,
  });
  let calls = 0;
  await assert.rejects(
    slackToken(env, scoped, async () => {
      calls++;
      throw Error("lost");
    }),
    /再接続/,
  );
  await assert.rejects(
    slackToken(env, scoped, () => assert.fail()),
    /再認可/,
  );
  assert.equal(calls, 1);
});

test("サイトの初回資格情報設定は秘密値を返さず、別アプリへの無断切替を拒否", async () => {
  const s = memory(),
    input = {
      clientId: "123.456",
      clientSecret: "a".repeat(32),
      confirm: true,
    };
  await assert.rejects(
    configureSlackApplication({}, s, { ...input, confirm: false }),
  );
  await configureSlackApplication({}, s, input);
  const view = await dashboardSlackView({}, s);
  assert.equal(view.configured, true);
  assert.equal(JSON.stringify(view).includes(input.clientSecret), false);
  await s.put("slack:workspaces", [{ teamId: team }]);
  await assert.rejects(
    configureSlackApplication({}, s, { ...input, clientId: "987.654" }),
    /変更できません/,
  );
  await assert.rejects(configureSlackApplication(env, s, input), /Secrets/);
});

test("未指定なら本人がSlack認可画面でworkspaceを選び、取消・期限切れ・6件目を拒否", async () => {
  const s = memory();
  const begin = await slackConnect(
    new Request("https://dashboard.test/auth/slack/start", {
      method: "POST",
      body: JSON.stringify({ includePrivate: false }),
    }),
    env,
    s,
    { key: "owner" },
  );
  assert.equal(
    new URL((await begin.json()).authorizationUrl).searchParams.has("team"),
    false,
  );
  assert.equal((await callback(s, oauth())).status, 303);
  await start(s);
  const flow = await s.get("slack:flow");
  const cancelled = await slackConnect(
    new Request(
      "https://dashboard.test/auth/slack/callback?error=access_denied&state=" +
        flow.state,
    ),
    env,
    s,
    { key: "owner" },
    () => assert.fail(),
  );
  assert.equal(cancelled.status, 409);
  assert.equal((await dashboardSlackView(env, s)).connection.connected, true);
  await start(s);
  await s.put("slack:flow", { ...(await s.get("slack:flow")), expires: 1 });
  await assert.rejects(
    callback(s, () => assert.fail()),
    /有効期限/,
  );
  await s.put(
    "slack:workspaces",
    Array.from({ length: 5 }, (_, i) => ({ teamId: "T0000000" + i })),
  );
  await assert.rejects(start(s, "T99999999"), /5ワークスペース/);
});

test("ページ循環・重複・応答容量超過は成功扱いにせず、秘密を含むSlackエラーを漏らさない", async () => {
  const { scoped } = await setup(),
    now = Date.now();
  await scoped.put("slack:cache:" + channel, {
    messages: [],
    lastSuccess: "2026-11-01T00:00:00Z",
  });
  await queueSlackSync(scoped, now);
  await runSlackBatch(
    env,
    scoped,
    async () =>
      page([message()], {
        has_more: true,
        response_metadata: { next_cursor: "loop" },
      }),
    now + 61000,
  );
  await runSlackBatch(
    env,
    scoped,
    async () =>
      page([message("1763000001.000001")], {
        has_more: true,
        response_metadata: { next_cursor: "loop" },
      }),
    now + 122000,
  );
  assert.equal(
    (await scoped.get("slack:cache:" + channel)).lastSuccess,
    "2026-11-01T00:00:00Z",
  );
  assert.equal(
    (await scoped.get("slack:cache:" + channel)).errorCode,
    "incomplete",
  );
  await assert.rejects(
    slackRequest(
      "auth.test",
      {},
      "fixture",
      async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
    ),
    /上限/,
  );
  await assert.rejects(
    slackRequest("auth.test", {}, "fixture", async () =>
      Response.json({
        ok: false,
        error: "invalid_auth",
        token: "secret-should-not-leak",
      }),
    ),
    (error) =>
      error instanceof SlackError &&
      !error.message.includes("secret-should-not-leak"),
  );
});


test("取得途中1MiB・確認記録5000件を超える場合も前の保存情報を保持する", async () => {
  const {scoped}=await setup(),now=Date.now();
  await scoped.put("slack:cache:"+channel,{messages:[],lastSuccess:"2026-11-01T00:00:00Z"});
  await queueSlackSync(scoped,now);
  for(let pageIndex=0;pageIndex<4;pageIndex++) {
    const job=await scoped.get("slack:job");
    const messages=Array.from({length:15},(_,index)=>message(String(1763000000+pageIndex*15+index)+".000001","あ".repeat(6000)));
    await runSlackBatch(env,scoped,async()=>page(messages,{has_more:true,response_metadata:{next_cursor:"p"+pageIndex}}),job.nextAt);
  }
  assert.equal(await scoped.get("slack:job"),undefined);
  assert.equal((await scoped.get("slack:cache:"+channel)).errorCode,"limit");
  assert.equal((await scoped.get("slack:cache:"+channel)).lastSuccess,"2026-11-01T00:00:00Z");
  await scoped.put("slack:cache:"+channel,{messages:[{ts:"1763000000.000001",text:"fixture"}]});
  const reviews=Object.fromEntries(Array.from({length:5000},(_,index)=>[String(index),{reviewedAt:new Date().toISOString()}]));
  await scoped.put("slack:reviews:"+channel,reviews);
  const m=(await slackMessagesView(env,scoped)).channels[0].messages[0];
  await assert.rejects(reviewSlackMessage(env,scoped,{channelId:channel,ts:m.ts,revision:m.revision,reviewed:true}),/上限/);
  assert.equal(Object.keys(await scoped.get("slack:reviews:"+channel)).length,5000);
});
