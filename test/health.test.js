import test from "node:test";
import assert from "node:assert/strict";
import { healthView } from "../src/health.js";
import { connectionRecovery } from "../src/connection-recovery.js";

const now = Date.parse("2026-11-13T07:00:00Z");
const recent = new Date(now - 60000).toISOString(),
  old = new Date(now - 2 * 60 * 60 * 1000).toISOString();
const env = {
  PROJECT_CONFIG: JSON.stringify({ project: "p", title: "タスク" }),
};
function memory(entries = []) {
  const map = new Map(entries);
  return {
    get: async (k) => structuredClone(map.get(k)),
    list: async ({ prefix, limit }) =>
      new Map([...map].filter(([k]) => k.startsWith(prefix)).slice(0, limit)),
  };
}
test("保存情報だけから取得失敗・古さ・未取得を区別し、本文・認証情報を返さない", async () => {
  const storage = memory([
    [
      "catalog:p",
      {
        lastAttempt: old,
        lastSuccess: old,
        items: [{ title: "private body" }],
      },
    ],
    ["notes:config", { owner: "owner", repo: "notes" }],
    ["notes:token", "credential sentinel"],
    [
      "notes:cache",
      {
        lastAttempt: recent,
        lastSuccess: recent,
        error: "credential sentinel",
        errorCode: "auth",
        files: [{ path: "private body" }],
      },
    ],
    ["agenda:accounts", [{ id: "a", email: "fixture@example.test" }]],
    ["agenda:credential:a", { token: "credential sentinel" }],
    [
      "agenda:cache:a",
      {
        lastSuccess: recent,
        lastAttempt: recent,
        messages: [{ subject: "private body" }],
      },
    ],
  ]);
  const before = JSON.stringify(await storage.get("notes:cache"));
  const result = await healthView(env, storage, now);
  assert.equal(result.externalRequests, 0);
  assert.equal(
    result.sources.find((s) => s.service === "github").state,
    "stale",
  );
  assert.equal(
    result.sources.find((s) => s.service === "notes").state,
    "error",
  );
  assert.equal(result.sources.find((s) => s.service === "mail").state, "ok");
  assert.equal(
    result.sources.find((s) => s.service === "calendar").state,
    "never",
  );
  assert.equal(JSON.stringify(result).includes("credential sentinel"), false);
  assert.equal(JSON.stringify(result).includes("private body"), false);
  assert.equal(JSON.stringify(await storage.get("notes:cache")), before);
});
test("未接続を成功にせず、結果未確認・未同期を件数だけ集約し再送しない", async () => {
  const storage = memory([
    [
      "agenda:accounts",
      [{ id: "a", email: "fixture@example.test", disconnectedAt: recent }],
    ],
    ["agenda:pending:a", ["m1", "m2"]],
    ["agenda:mailJob", { nextAt: now - 6 * 60000 }],
    ["task:p:a", { pending: { value: "private body" }, phase: "競合" }],
  ]);
  const result = await healthView(env, storage, now);
  assert.equal(result.pending.find((p) => p.service === "github").count, 1);
  assert.equal(result.pending.find((p) => p.service === "calendar").count, 2);
  assert.equal(
    result.sources.find((s) => s.service === "mail").state,
    "disconnected",
  );
  assert.equal(
    result.sources.find((s) => s.service === "slack").state,
    "disconnected",
  );
  assert.equal(
    result.sources.find((s) => s.service === "notes").state,
    "disconnected",
  );
  assert.equal(result.jobs[0].delayed, true);
  assert.equal(JSON.stringify(result).includes("private body"), false);
});
test("GitHub未同期調査は上限付きで、不完全な件数を全件扱いにしない", async () => {
  const storage = memory(
    Array.from({ length: 1001 }, (_, i) => ["task:p:" + i, { pending: {} }]),
  );
  const result = await healthView(env, storage, now);
  assert.equal(result.pending[0].count, 1001);
  assert.equal(result.pending[0].limited, true);
});

test("試験Projectの古さは実運用の要確認件数へ混ぜない", async () => {
  const storage = memory([["catalog:p", { lastSuccess: old }]]);
  const result = await healthView(env, storage, now);
  assert.equal(
    result.sources.find((source) => source.service === "github").test,
    true,
  );
  assert.equal(result.attentionCount, 3);
});

test("完了済み・取得中・順番待ちを接続別に分け、前回の成功時刻を維持する", async () => {
  const entries = [
    [
      "agenda:accounts",
      ["a", "b", "c"].map((id) => ({ id, email: id + "@example.test" })),
    ],
    [
      "agenda:mailJob",
      { accountIds: ["a", "b", "c"], index: 1, nextAt: now + 15000 },
    ],
  ];
  for (const id of ["a", "b", "c"])
    entries.push(
      ["agenda:credential:" + id, { token: "not-returned" }],
      [
        "agenda:cache:" + id,
        { lastAttempt: recent, lastSuccess: recent, messages: [] },
      ],
    );
  let result = await healthView(env, memory(entries), now);
  const mail = result.sources.filter((source) => source.service === "mail");
  assert.deepEqual(
    mail.map((source) => source.state),
    ["ok", "running", "queued"],
  );
  assert.equal(mail[1].lastSuccess, recent);
  entries.push([
    "agenda:cache:b",
    {
      lastAttempt: recent,
      lastSuccess: old,
      error: "safe failure",
      errorCode: "network",
    },
  ]);
  result = await healthView(env, memory(entries), now);
  assert.equal(
    result.sources.filter((source) => source.service === "mail")[1].state,
    "retrying",
  );
});

test("取得ジョブがないのに試行だけ新しい場合は成功と表示しない", async () => {
  const result = await healthView(
    env,
    memory([
      ["catalog:p", { lastAttempt: recent, lastSuccess: old }],
      ["notes:config", { owner: "fixture", repo: "notes" }],
      ["notes:cache", { lastAttempt: recent, lastSuccess: recent }],
    ]),
    now,
  );
  assert.equal(
    result.sources.find((source) => source.service === "github").state,
    "interrupted",
  );
  assert.equal(
    result.sources.find((source) => source.service === "notes").state,
    "ok",
  );
});

test("Slackもチャンネル単位で取得中と順番待ちを区別する", async () => {
  const prefix = "slack:workspace:T:";
  const result = await healthView(
    env,
    memory([
      ["slack:workspaces", [{ teamId: "T", teamName: "fixture" }]],
      [prefix + "credential", { token: "not-returned" }],
      [
        prefix + "channels",
        [
          { id: "C1", name: "one" },
          { id: "C2", name: "two" },
        ],
      ],
      [
        prefix + "job",
        { index: 0, channelIds: ["C1", "C2"], nextAt: now + 61000 },
      ],
      [prefix + "cache:C1", { lastSuccess: recent, messages: [] }],
      [prefix + "cache:C2", { lastSuccess: recent, messages: [] }],
    ]),
    now,
  );
  assert.deepEqual(
    result.sources
      .filter((source) => source.service === "slack")
      .map((source) => source.state),
    ["running", "queued"],
  );
  assert.equal(JSON.stringify(result).includes("not-returned"), false);
});

test("メールの取得成功と未取得・本文未確認を分け、対象アカウントとGmail検索を返す", async () => {
  const result = await healthView(env, memory([
    ["agenda:accounts", [{ id:"a",email:"a@example.test",label:"就活" }]],
    ["agenda:credential:a", {token:"secret sentinel"}],
    ["agenda:cache:a", {
      lastAttempt:recent,lastSuccess:recent,nextPageToken:"cursor must stay private",limited:true,
      messages:[{id:"abc",excerpt:"private body",contentLimited:true}],
    }],
  ]),now);
  const mail = result.sources.find(source=>source.service==="mail");
  assert.equal(mail.state,"limited");
  assert.equal(mail.accountId,"a");
  assert.equal(mail.coverage.standardHasMore,true);
  assert.equal(mail.coverage.bodyLimitedCount,1);
  assert.equal(mail.coverage.hasSnapshot,true);
  assert.equal(mail.coverage.snapshotAt,recent);
  assert.equal(mail.coverage.supplementCurrent,false);
  assert.equal(mail.recovery.kind,"coverage");
  assert.equal(new URL(mail.coverage.standardUrl).hostname,"mail.google.com");
  assert.match(decodeURIComponent(mail.coverage.standardUrl),/a@example.test/);
  assert.equal(mail.lastSuccess,recent);
  for (const secret of ["private body","secret sentinel","cursor must stay private"])
    assert.equal(JSON.stringify(result).includes(secret),false);
});

test("取得中・再試行待ち・順番待ちを区別し、完了済み接続を巻き戻さない", async () => {
  const entries = [
    ["agenda:accounts",["a","b","c"].map(id=>({id,email:id+"@example.test"}))],
    ["agenda:mailJob",{accountIds:["a","b","c"],index:1,phase:"priority",standardPages:5,pages:1,nextAt:now+60000}],
  ];
  for(const id of ["a","b","c"])entries.push(
    ["agenda:credential:"+id,{token:"private"}],
    ["agenda:cache:"+id,{lastAttempt:recent,lastSuccess:recent,messages:[],...(id!=="a"?{error:"old failure",errorCode:"network"}:{})}],
  );
  const result = await healthView(env,memory(entries),now);
  const sources = result.sources.filter(source=>source.service==="mail");
  assert.deepEqual(sources.map(source=>source.state),["ok","retrying","queued"]);
  assert.equal(sources[0].progress,null);
  assert.deepEqual(sources[1].progress,{position:2,total:3,phase:"重要候補の補完",pages:6,nextAt:now+60000});
  assert.equal(sources[2].progress.phase,"順番待ち");
  assert.equal(sources[1].recovery.kind,"wait");
});

test("認可・権限・利用制限・通信・削除・停止に応じて再送なしの復旧先を選ぶ", () => {
  for(const code of ["authentication","auth","permission","forbidden"])
    assert.equal(connectionRecovery("error",code,null,now).kind,"reconnect");
  assert.equal(connectionRecovery("error","rate",now+60000,now).kind,"wait");
  assert.equal(connectionRecovery("error","network",now+60000,now).kind,"wait");
  assert.equal(connectionRecovery("error","network",now-1,now).kind,"refresh");
  assert.equal(connectionRecovery("error","not_found",null,now).kind,"source");
  assert.equal(connectionRecovery("disconnected",null,null,now,true).kind,"reconnect");
  assert.equal(connectionRecovery("interrupted",null,null,now).kind,"refresh");
  assert.equal(connectionRecovery("ok","authentication",null,now).kind,"refresh");
  assert.equal(connectionRecovery("limited","rate",now+60000,now).kind,"coverage");
});

test("予定登録の結果未確認も登録元アカウントを指し、取得範囲の末尾を制限と混同しない", async () => {
  const result = await healthView(env,memory([
    ["agenda:accounts",[{id:"a",email:"a@example.test"}]],
    ["agenda:credential:a",{token:"private"}],
    ["agenda:pending:a",["operation1"]],
    ["agenda:cache:a",{lastAttempt:recent,lastSuccess:recent,messages:[],nextPageToken:null}],
  ]),now);
  assert.equal(result.pending.find(item=>item.service==="calendar").accountId,"a");
  assert.equal(result.pending.find(item=>item.service==="calendar").recovery.kind,"reconcile");
  assert.equal(result.sources.find(item=>item.service==="mail").state,"ok");
  assert.equal(result.sources.find(item=>item.service==="mail").coverage.standardHasMore,false);
  const never = await healthView(env,memory([
    ["agenda:accounts",[{id:"a",email:"a@example.test"}]],
    ["agenda:credential:a",{token:"private"}],
  ]),now);
  assert.equal(never.sources.find(item=>item.service==="mail").coverage.hasSnapshot,false);
  assert.equal(never.sources.find(item=>item.service==="mail").state,"never");
});
