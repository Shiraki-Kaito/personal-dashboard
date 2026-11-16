import test from "node:test";
import assert from "node:assert/strict";
import {
  minutesParagraphs,
  weeklyEvidence,
  composeWeeklyReports,
  weeklyPeriod,
} from "../src/weekly-report.js";
import { configureWeekly, generateWeekly } from "../src/weekly-drive.js";
import {
  googleConnect,
  driveScope,
  minutesReadScope,
} from "../src/drive-auth.js";
import { createBackup, backupPlan, restoreBackup } from "../src/backup.js";
const p = (text, level = null, extra = {}) => ({
  startIndex: 10,
  paragraph: {
    elements: [{ textRun: { content: text + "\n" } }],
    ...(level === null ? {} : { bullet: { nestingLevel: level } }),
    paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
    ...extra,
  },
});
const date = (value) =>
  p("", null, {
    elements: [
      {
        dateElement: {
          dateElementProperties: {
            timestamp: value + "T12:00:00Z",
            displayText: value,
          },
        },
      },
    ],
    paragraphStyle: { namedStyleType: "HEADING_2" },
  });
const body = [
  date("2026-11-12"),
  p("Agenda"),
  p("進捗報告", 0),
  p("完了", 1),
  p("議題だけの記載", 2),
  p("Contents"),
  p("進捗報告", 0),
  p("オーガナイザー", 1),
  p("白木", 2),
  p("完了", 3),
  p("告知内容を調整", 4),
  p("Next Actions", 3),
  p("11月20日までに確認依頼", 4),
  p("SNS", 1),
  p("別担当", 2),
  p("完了", 3),
  p("白木に確認した別担当の作業", 4),
  p("NextAction", 3),
  p("投稿を確認", 4),
  p("相談事項", 0),
  p("公開日の判断が必要", 1),
  date("2026-11-05"),
  p("Contents"),
  p("進捗報告", 0),
  p("白木", 1),
  p("完了", 2),
  p("先週の実績", 3),
];
const document = () => ({
  documentId: "minutes",
  title: "試験用議事録",
  tabs: [
    {
      tabProperties: { tabId: "main", title: "main" },
      documentTab: { body: { content: structuredClone(body) } },
      childTabs: [
        {
          tabProperties: { tabId: "template", title: "template" },
          documentTab: { body: { content: body } },
        },
      ],
    },
    {
      tabProperties: { tabId: "old", title: "Old notes" },
      documentTab: { body: { content: body } },
    },
  ],
});
const cache = {
  scope: "root:true",
  lastSuccess: "2026-11-16T01:00:00Z",
  files: [
    {
      id: "minutes",
      name: "試験用議事録",
      mimeType: "application/vnd.google-apps.document",
      folder: "チーム / 000_Meeting",
      modifiedTime: "2026-11-12T12:00:00Z",
      lastModifiedBy: "担当者",
    },
    {
      id: "private",
      name: "個人作業",
      folder: "チーム / 900_個人作業",
      modifiedTime: "2026-11-12T12:00:00Z",
    },
    {
      id: "local",
      name: "note_L.md",
      folder: "チーム",
      modifiedTime: "2026-11-12T12:00:00Z",
    },
  ],
};
function memory() {
  const values = new Map([
    ["drive:cache", cache],
    [
      "drive:credential",
      {
        token: "fixture",
        refresh: "fixture",
        expires: Date.now() + 3600000,
        accountFingerprint: "known",
        scopes: [driveScope, minutesReadScope],
      },
    ],
  ]);
  const s = {
    get: async (k) => structuredClone(values.get(k)),
    put: async (k, v) => values.set(k, structuredClone(v)),
    delete: async (k) => values.delete(k),
    list: async ({ prefix }) =>
      new Map([...values].filter(([k]) => k.startsWith(prefix))),
    transaction: async (fn) => fn(s),
  };
  return s;
}
const settings = {
  scope: "root:true",
  minutesId: "minutes",
  ownerName: "白木",
  expectedRevision: null,
};
test("日付チップ・リスト階層・担当者を保持し、古い記録とテンプレートと議題だけの項目を除外する", () => {
  const evidence = weeklyEvidence(cache, document(), {
    endDate: "2026-11-16",
    ownerName: "白木",
  });
  assert.equal(evidence.entries.filter((e) => e.personal).length, 2);
  assert.equal(evidence.entries.length, 5);
  assert.ok(
    evidence.entries.every(
      (e) => e.meetingDate === "2026-11-12" && e.tabId === "main",
    ),
  );
  assert.deepEqual(
    evidence.files.map((file) => file.id),
    ["minutes"],
  );
  const reports = composeWeeklyReports(evidence);
  assert.match(reports.personal, /告知内容を調整/);
  assert.doesNotMatch(reports.personal, /別担当|先週|議題だけ/);
  assert.match(reports.organizer, /別担当/);
  assert.match(reports.plenary, /Next Action/);
});
test("同じ週に複数の会議があっても古いNext Actionを最新として出さず、重複実績をまとめる", () => {
  const doc = document();
  doc.tabs[0].documentTab.body.content.push(
    date("2026-11-14"),
    p("Contents"),
    p("進捗報告", 0),
    p("オーガナイザー", 1),
    p("白木", 2),
    p("完了", 3),
    p("告知内容を調整", 4),
  );
  const evidence = weeklyEvidence(cache, doc, {
      endDate: "2026-11-16",
      ownerName: "白木",
    }),
    report = composeWeeklyReports(evidence).personal;
  assert.equal(evidence.latestMeetingDate, "2026-11-14");
  assert.equal(report.split("告知内容を調整").length - 1, 1);
  assert.doesNotMatch(report, /11月20日まで/);
  assert.ok(evidence.entries.some((entry) => entry.kind === "next"));
});
test("対象期間が不明・範囲外なら実績を創作せず、JSTの週境界を使う", () => {
  assert.deepEqual(weeklyPeriod("2026-11-16").startDate, "2026-11-10");
  assert.throws(() => weeklyPeriod("2026-02-30"));
  const evidence = weeklyEvidence(cache, document(), {
    endDate: "2026-12-16",
    ownerName: "白木",
  });
  assert.equal(evidence.entries.length, 0);
  assert.match(composeWeeklyReports(evidence).personal, /確認できません/);
  const invalid = document();
  invalid.tabs[0].documentTab.body.content = [
    date("invalid"),
    ...body.slice(1),
  ];
  assert.equal(
    weeklyEvidence(cache, invalid, { endDate: "2026-11-16", ownerName: "白木" })
      .entries.length,
    0,
  );
});
test("表・子タブを読み、解析上限超過では部分取得の完了扱いをしない", () => {
  const doc = {
    tabs: [
      {
        tabProperties: { title: "main", tabId: "a" },
        documentTab: {
          body: {
            content: [
              {
                table: {
                  tableRows: [{ tableCells: [{ content: [p("表の本文")] }] }],
                },
              },
            ],
          },
        },
        childTabs: [
          {
            tabProperties: { title: "子タブ", tabId: "b" },
            documentTab: { body: { content: [p("子の本文")] } },
          },
        ],
      },
    ],
  };
  assert.deepEqual(
    minutesParagraphs(doc).map((row) => row.text),
    ["表の本文", "子の本文"],
  );
  assert.throws(
    () => minutesParagraphs({ body: { content: [p("a".repeat(200001))] } }),
    /上限/,
  );
});
test("元文書へGETだけを行い、選択元・保存版・追加認可を検証し、秘密値を応答へ出さない", async () => {
  const s = memory(),
    configured = await configureWeekly(s, "root:true", settings);
  let calls = 0;
  const send = async (url, options) => {
    calls++;
    assert.equal(options.method, undefined);
    assert.equal(new URL(url).hostname, "docs.googleapis.com");
    assert.equal(new URL(url).searchParams.get("includeTabsContent"), "true");
    const fields=new URL(url).searchParams.get("fields");
    assert.ok(fields.includes("dateElementProperties(timestamp,displayText)"));
    assert.ok(fields.includes("bullet(nestingLevel)"));
    assert.notEqual(fields,"documentId,title,revisionId,tabs");
    return Response.json(document());
  };
  const result = await generateWeekly(
    {},
    s,
    "root:true",
    { endDate: "2026-11-16", settingsRevision: configured.revision },
    send,
  );
  assert.equal(calls, 1);
  assert.ok(result.reports.personal);
  assert.doesNotMatch(JSON.stringify(result), /fixture|Bearer/);
  await assert.rejects(
    generateWeekly(
      {},
      s,
      "root:true",
      { endDate: "2026-11-16", settingsRevision: "old" },
      send,
    ),
    /設定が変わり/,
  );
  await s.put("drive:credential", { scopes: [driveScope] });
  await assert.rejects(
    generateWeekly(
      {},
      s,
      "root:true",
      { endDate: "2026-11-16", settingsRevision: configured.revision },
      () => assert.fail(),
    ),
    /追加認可/,
  );
  await assert.rejects(
    configureWeekly(s, "root:true", {
      ...settings,
      minutesId: "outside",
      expectedRevision: configured.revision,
    }),
    /対象フォルダ/,
  );
});
test("読み取り障害・API無効・削除・利用制限・過大本文を成功扱いしない", async () => {
  const s = memory(),
    configured = await configureWeekly(s, "root:true", settings),
    input = { endDate: "2026-11-16", settingsRevision: configured.revision };
  for (const status of [401, 403, 404, 429, 503])
    await assert.rejects(
      generateWeekly(
        {},
        s,
        "root:true",
        input,
        async () => new Response("", { status }),
      ),
    );
  await assert.rejects(
    generateWeekly(
      {},
      s,
      "root:true",
      input,
      async () => new Response("a".repeat(2 * 1024 * 1024 + 1)),
    ),
    /2MiB/,
  );
  assert.equal(
    (await s.get("drive:weeklySettings")).revision,
    configured.revision,
  );
});
test("通常接続の権限を増やさず、専用開始経路だけで編集を含まないDocs読み取りを要求する", async () => {
  const s = memory(),
    env = {
      GOOGLE_CLIENT_ID: "1-fixture.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "fixture",
    },
    session = { key: "owner" };
  for (const [path, expected] of [
    ["start", false],
    ["report-start", true],
  ]) {
    const result = await googleConnect(
      new Request("https://unit.test/auth/google/" + path, { method: "POST" }),
      env,
      s,
      session,
    );
    const scopes = new URL((await result.json()).authorizationUrl).searchParams
      .get("scope")
      .split(" ");
    assert.equal(scopes.includes(minutesReadScope), expected);
    assert.ok(scopes.includes(driveScope));
    assert.ok(scopes.every((scope) => /readonly$/.test(scope)));
  }
  const flow = await s.get("drive:flow"),
    before = await s.get("drive:credential");
  const denied = await googleConnect(
    new Request(
      "https://unit.test/auth/google/callback?code=test&state=" + flow.state,
    ),
    env,
    s,
    session,
    async () =>
      Response.json({
        access_token: "fixture",
        refresh_token: "fixture",
        expires_in: 3600,
        scope: driveScope,
      }),
  );
  assert.equal(denied.status, 503);
  assert.deepEqual(await s.get("drive:credential"), before);
});
test("参照設定のバックアップ・復元で版を更新し、資格情報を含めず既存設定を上書きしない", async () => {
  const s = memory(),
    configured = await configureWeekly(s, "root:true", settings),
    env = {
      DRIVE_CONFIG: JSON.stringify({
        folderId: "root",
        includeSubfolders: true,
      }),
      PROJECT_CONFIG: JSON.stringify({
        projects: [{ project: "p", status_field: "s", due_field: "d" }],
      }),
    };
  await s.delete("drive:cache");
  const backup = await createBackup(env, s);
  assert.doesNotMatch(JSON.stringify(backup), /fixture|Bearer/);
  assert.equal(backup.weeklySettings.minutesId, "minutes");
  const target = memory();
  await target.delete("drive:cache");
  const plan = await backupPlan(env, target, backup);
  await restoreBackup(env, target, backup, plan.checksum);
  assert.notEqual(
    (await target.get("drive:weeklySettings")).revision,
    configured.revision,
  );
  assert.ok(
    (await backupPlan(env, target, backup)).conflicts.includes(
      "drive:weeklySettings",
    ),
  );
});
