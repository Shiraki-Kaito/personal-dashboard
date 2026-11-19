import test from "node:test";
import assert from "node:assert/strict";
import {
  documentFacts,
  spreadsheetFacts,
  composeProgressReports,
  defaultReportPeriod,
  validReportDate,
} from "../src/progress-evidence.js";
import {
  reportSourceCatalog,
  reportTeams,
  expandReportSources,
  readProgressSources,
} from "../src/progress-sources.js";
import {
  previewProgressRestore,
  restoreProgressReports,
  archiveProgressReport,
  exportProgressReports,
  generateProgressReport,
  progressReportView,
  saveProgressReport,
  loadProgressReport,
} from "../src/progress-reports.js";
import {
  driveScope,
  minutesReadScope,
  sheetsReadScope,
  googleConnect,
} from "../src/drive-auth.js";
const scope = "root:true",
  root = "07_集客広報";
const source = {
  id: "doc1",
  name: "定例議事録",
  folder: root,
  mimeType: "application/vnd.google-apps.document",
  supported: true,
  modifiedTime: "2026-11-17T00:00:00Z",
  role: "personal",
};
const p = (text, level = null, heading = "NORMAL_TEXT") => ({
  startIndex: 10,
  paragraph: {
    elements: [{ textRun: { content: text + "\n" } }],
    ...(level === null ? {} : { bullet: { nestingLevel: level } }),
    paragraphStyle: { namedStyleType: heading },
  },
});
const document = {
  documentId: "doc1",
  revisionId: "fixture",
  body: {
    content: [
      p("2026-11-10", null, "HEADING_1"),
      p("進捗報告", 0),
      p("白木海斗", 1),
      p("完了", 2),
      p("過去の草案作成", 3),
      p("2026-11-17", null, "HEADING_1"),
      p("進捗報告", 0),
      p("白木海斗", 1),
      p("完了", 2),
      p("過去の草案作成", 3),
      p("LP草案の作成完了", 3),
      p("承認予定", 3),
      p("Next Actions", 2),
      p("資料の確認 期限 2026-11-16", 3),
      p("別の担当者", 1),
      p("完了", 2),
      p("別担当の制作完了", 3),
      p("Next Actions", 2),
      p("別担当の次の作業", 3),
      p("相談事項", 0),
      p("デザイン班へ判断依頼", 1),
      p("2026-11-18", null, "HEADING_1"),
      p("完了", 0),
      p("未来の実績", 1),
    ],
  },
};
const facts = documentFacts(document, source, ["白木海斗"]);
const request = {
  kind: "personal",
  reportDate: "2026-11-17",
  reporter: "白木海斗",
  aliases: [],
  startDate: null,
  endDate: "2026-11-17",
  teams: [root],
  sources: [{ id: "doc1", role: "personal" }],
  folders: [],
};
const makeSources = () => [
  { ...source, ...structuredClone(facts), status: "read" },
];
const teams = [{ path: root, name: "集客広報" }];
function compose(overrides = {}, sources = makeSources(), previous = []) {
  return composeProgressReports({
    request: { ...request, ...overrides },
    sources,
    teams,
    previous,
  });
}
function memory(values = new Map()) {
  let tail = Promise.resolve();
  const storage = {
    values,
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => values.set(key, structuredClone(value)),
    delete: async (key) => values.delete(key),
    transaction: (fn) => {
      const current = tail.then(async () => {
        const before = structuredClone(values);
        try {
          return await fn(storage);
        } catch (error) {
          values.clear();
          for (const entry of before) values.set(...entry);
          throw error;
        }
      });
      tail = current.catch(() => {});
      return current;
    },
  };
  return storage;
}
function fixture() {
  const storage = memory(
    new Map([
      [
        "drive:cache",
        {
          scope,
          folderName: root,
          lastSuccess: new Date().toISOString(),
          files: [source],
        },
      ],
      [
        "drive:credential",
        {
          token: "fixture",
          expires: Date.now() + 3600000,
          accountFingerprint: "fixture",
          scopes: [driveScope, minutesReadScope],
        },
      ],
    ]),
  );
  let calls = 0;
  return {
    storage,
    send: async (url, options) => {
      calls++;
      assert.equal(options.method, undefined);
      assert.equal(new URL(url).hostname, "docs.googleapis.com");
      return Response.json(document);
    },
    count: () => calls,
  };
}

test("個人・チームを区別し、持ち越し完了と未来実績と承認予定を新規完了にしない", () => {
  const result = compose(),
    text = result.results[0].text;
  assert.match(text, /LP草案の作成完了/);
  assert.match(text, /草案作成/);
  assert.doesNotMatch(text, /過去の草案作成|別担当|未来の実績|承認予定/);
  assert.match(
    result.results[0].checks.map((check) => check.message).join(),
    /期限超過/,
  );
  assert.match(
    compose({ kind: "organizer", startDate: "2026-11-11" }).results[0].text,
    /別担当の制作完了/,
  );
  assert.ok(result.results[0].items.every((item) => item.references?.length));
});
test("同じ実績の複数資料をまとめて根拠は両方保持し、少ない実績を水増ししない", () => {
  const sources = makeSources();
  sources.push({
    ...sources[0],
    id: "doc2",
    facts: sources[0].facts.map((fact) => ({ ...fact, sourceId: "doc2" })),
  });
  const result = compose({}, sources).results[0];
  assert.equal(
    result.items.filter((item) => item.text === "LP草案の作成完了").length,
    1,
  );
  assert.equal(
    result.items.find((item) => item.text === "LP草案の作成完了").references
      .length,
    2,
  );
  assert.match(
    compose({}, [{ ...source, facts: [], dates: [], checks: [] }]).results[0]
      .text,
    /新規の完了実績は確認できませんでした/,
  );
});
test("前回確定版を優先し、未使用の下書きでは実績を消さない", () => {
  const old = {
    id: crypto.randomUUID(),
    status: "draft",
    request: { ...request, reportDate: "2026-11-16" },
    results: compose().results,
  };
  assert.match(compose({}, makeSources(), [old]).results[0].text, /LP草案/);
  old.status = "final";
  const result = compose({}, makeSources(), [old]).results[0];
  assert.doesNotMatch(result.text, /LP草案/);
  assert.equal(result.baseline.id, old.id);
});
test("期間は同じ定例の前回日を優先し、不明なら7日間、終了日後の実績を含めない", () => {
  assert.equal(
    defaultReportPeriod("2026-11-17", "personal", makeSources()).startDate,
    "2026-11-10",
  );
  assert.equal(
    defaultReportPeriod("2026-11-17", "plenary", makeSources()).startDate,
    "2026-11-11",
  );
  assert.equal(validReportDate("2026-99-99"), false);
  assert.throws(() => compose({ startDate: "2026-11-18" }));
  assert.throws(() => compose({ endDate: "2026-11-18" }));
  assert.doesNotMatch(
    compose({ startDate: "2026-11-10", endDate: "2026-11-16" }).results[0].text,
    /LP草案/,
  );
});
test("全選択はチームごとに分かれ、フォルダ外の実績を混ぜない", () => {
  const a = {
    ...source,
    folder: root + " / 100_SNS運用",
    facts: [
      {
        ...facts.facts.find((fact) => fact.text === "LP草案の作成完了"),
        sourceId: "a",
      },
    ],
    dates: [],
    checks: [],
  };
  const result = composeProgressReports({
    request: { ...request, kind: "plenary", startDate: "2026-11-11" },
    sources: [a],
    teams: [
      { path: a.folder, name: "SNS運用" },
      { path: root + " / 200_LP", name: "LP" },
    ],
    previous: [],
  });
  assert.match(result.results[0].text, /LP草案/);
  assert.doesNotMatch(result.results[1].text, /LP草案/);
});
test("連絡・返信・連携確定を別集計し、同じ団体の反復連絡と累計を加算しない", () => {
  const sheet = {
    title: "管理表",
    id: 0,
    values: [
      ["団体名", "状態", "担当者", "段階実施日", "期限"],
      ["団体A", "初回連絡済", "白木海斗", "2026/11/12", ""],
      ["団体A", "初回連絡済", "白木海斗", "2026/11/13", ""],
      ["団体A", "返信済", "白木海斗", "2026/11/14", ""],
      ["団体B", "連携確定", "白木海斗", "2026/11/15", ""],
      ["団体C", "連携確定", "白木海斗", "", ""],
      ["団体D", "連携確定", "白木海斗", "2026/10/01", ""],
    ],
  };
  const parsed = spreadsheetFacts([sheet], source, ["白木海斗"]),
    result = compose({ kind: "organizer", startDate: "2026-11-11" }, [
      { ...source, ...parsed },
    ]).results[0];
  assert.equal(result.community["初回連絡"].period, 1);
  assert.equal(result.community["返信・交渉"].period, 1);
  assert.equal(result.community["連携確定"].period, 1);
  assert.equal(result.community["連携確定"].cumulative, 2);
  assert.doesNotMatch(result.text, /団体C/);
});
test("シートの未完了と完了が同じ作業で食い違う場合は上書きせず確認事項に分ける", () => {
  const base = {
    ...facts.facts.find((fact) => fact.kind === "done"),
    taskKey: "same",
    date: "2026-11-17",
    text: "作業：完了",
  };
  const result = compose({ kind: "organizer", startDate: "2026-11-11" }, [
    {
      ...source,
      dates: [],
      checks: [],
      facts: [
        base,
        { ...base, kind: "next", date: null, text: "作業：未完了" },
      ],
    },
  ]).results[0];
  assert.equal(result.items.length, 0);
  assert.match(result.checks.map((check) => check.message).join(), /食い違い/);
});
test("資料日付が不明な完了は更新日時で補わず、本文に名前が出るだけで本人にしない", () => {
  const result = documentFacts(
    { body: { content: [p("完了", 0), p("白木海斗が言及した作業", 1)] } },
    source,
    ["白木海斗"],
  );
  assert.equal(result.facts.length, 0);
  assert.ok(result.checks.length);
  const withDate = documentFacts(
    {
      body: {
        content: [
          p("2026-11-17", null, "HEADING_1"),
          p("完了", 0),
          p("白木海斗が言及した作業", 1),
        ],
      },
    },
    source,
    ["白木海斗"],
  );
  assert.equal(withDate.facts[0].personal, false);
});
test("生成と保存を分け、二重生成と古い編集を拒否し、確定版を不変にする", async () => {
  const f = fixture(),
    input = { ...request, scope, id: crypto.randomUUID() };
  const created = await generateProgressReport(
    {},
    f.storage,
    scope,
    input,
    f.send,
  );
  assert.equal(created.status, "draft");
  assert.equal(f.count(), 1);
  assert.deepEqual(
    await generateProgressReport({}, f.storage, scope, input, f.send),
    created,
  );
  assert.equal(f.count(), 1);
  const updated = await saveProgressReport(f.storage, scope, {
    id: created.id,
    scope,
    expectedRevision: created.revision,
    status: "draft",
    texts: [created.results[0].text + "\n本人編集"],
  });
  assert.equal(updated.edited, true);
  await assert.rejects(
    saveProgressReport(f.storage, scope, {
      id: created.id,
      scope,
      expectedRevision: created.revision,
      status: "draft",
      texts: ["古い編集"],
    }),
  );
  await assert.rejects(
    saveProgressReport(f.storage, scope, {
      id: created.id,
      scope,
      expectedRevision: updated.revision,
      status: "final",
      texts: [updated.results[0].text],
    }),
  );
  const final = await saveProgressReport(f.storage, scope, {
    id: created.id,
    scope,
    expectedRevision: updated.revision,
    status: "final",
    confirmUsed: true,
    texts: [updated.results[0].text],
  });
  await assert.rejects(
    saveProgressReport(f.storage, scope, {
      id: created.id,
      scope,
      expectedRevision: final.revision,
      status: "draft",
      texts: ["変更"],
    }),
  );
  const restarted = memory(structuredClone(f.storage.values));
  assert.equal(
    (await loadProgressReport(restarted, scope, created.id)).status,
    "final",
  );
});
test("未認可・部分取得は資料ごとの不足を保存し、秘密値と本文全体を返さない", async () => {
  const f = fixture();
  await f.storage.put("drive:credential", { scopes: [] });
  const record = await generateProgressReport(
    {},
    f.storage,
    scope,
    { ...request, scope, id: crypto.randomUUID() },
    () => {
      throw Error("should not fetch");
    },
  );
  assert.equal(record.sources[0].status, "unread");
  assert.match(record.checks.map((check) => check.message).join(), /認可/);
  assert.match(record.results[0].text, /新規の完了実績/);
  assert.ok(!record.sources[0].facts);
  assert.ok(!JSON.stringify(record).includes('"token"'));
});
test("対象外資料・大量フォルダ・不正日付・他スコープ・調査中の変更を拒否する", async () => {
  const f = fixture();
  assert.throws(() =>
    expandReportSources([source], {
      sources: [{ id: "other", role: "work" }],
      folders: [],
    }),
  );
  assert.throws(() =>
    expandReportSources(
      Array.from({ length: 13 }, (_, i) => ({ ...source, id: "x" + i })),
      { sources: [], folders: [root] },
    ),
  );
  await assert.rejects(
    generateProgressReport(
      {},
      f.storage,
      scope,
      { ...request, scope: "other", id: crypto.randomUUID() },
      f.send,
    ),
  );
  await assert.rejects(
    generateProgressReport(
      {},
      f.storage,
      scope,
      { ...request, reportDate: "2026-99-99", scope, id: crypto.randomUUID() },
      f.send,
    ),
  );
  await assert.rejects(
    generateProgressReport(
      {},
      f.storage,
      scope,
      { ...request, scope, id: crypto.randomUUID() },
      async (...args) => {
        const response = await f.send(...args);
        await f.storage.put("drive:cache", {
          ...(await f.storage.get("drive:cache")),
          lastSuccess: "changed",
        });
        return response;
      },
    ),
  );
  assert.equal((await progressReportView(f.storage, scope)).history.length, 0);
});
test("通常Drive認可を増やさず、進捗報告専用経路だけDocsとSheetsの読み取りを要求する", async () => {
  const storage = memory(),
    env = {
      GOOGLE_CLIENT_ID: "123-test.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "fixture",
    },
    session = { key: "fixture" };
  for (const path of ["start", "report-start", "progress-start"]) {
    const response = await googleConnect(
        new Request("https://dashboard.test/auth/google/" + path, {
          method: "POST",
        }),
        env,
        storage,
        session,
      ),
      url = new URL((await response.json()).authorizationUrl),
      scopes = url.searchParams.get("scope").split(" ");
    assert.equal(scopes.includes(sheetsReadScope), path === "progress-start");
    assert.equal(scopes.includes(minutesReadScope), path !== "start");
    assert.ok(scopes.every((scope) => scope.endsWith("readonly")));
  }
});

test("Sheetsは明示範囲のGETだけを行い、範囲外・同名資料・権限不足を隠さない", async () => {
  const f = fixture(),
    sheet = {
      ...source,
      id: "sheet",
      mimeType: "application/vnd.google-apps.spreadsheet",
      supported: true,
    };
  await f.storage.put("drive:credential", {
    token: "fixture",
    expires: Date.now() + 3600000,
    accountFingerprint: "fixture",
    scopes: [driveScope, sheetsReadScope],
  });
  const calls = [];
  const send = async (url, options) => {
    calls.push(String(url));
    assert.equal(options.method, undefined);
    const value = new URL(url);
    assert.equal(value.hostname, "sheets.googleapis.com");
    return Response.json(
      value.pathname.endsWith("batchGet")
        ? {
            spreadsheetId: "sheet",
            valueRanges: [
              {
                values: [
                  ["タスク", "状態", "担当者", "完了日"],
                  ["草案作成", "完了", "白木海斗", "2026/11/17"],
                ],
              },
            ],
          }
        : {
            spreadsheetId: "sheet",
            sheets: [
              {
                properties: {
                  sheetId: 0,
                  title: "タスク",
                  gridProperties: { rowCount: 1100, columnCount: 40 },
                },
              },
            ],
          },
    );
  };
  const result = await readProgressSources(
    {},
    f.storage,
    [sheet],
    ["白木海斗"],
    send,
  );
  assert.equal(calls.length, 2);
  assert.match(new URL(calls[1]).searchParams.get("ranges"), /A1:AF1000/);
  assert.equal(result[0].facts.length, 1);
  assert.match(result[0].checks[0].message, /範囲外/);
  const denied = await readProgressSources(
    {},
    f.storage,
    [sheet],
    ["白木海斗"],
    async () => new Response("secret fixture", { status: 403 }),
  );
  assert.equal(denied[0].status, "unread");
  assert.ok(!JSON.stringify(denied).includes("secret fixture"));
  const catalog = reportSourceCatalog({
    files: [{ ...source, name: "private_L.md" }, sheet],
  });
  assert.equal(catalog.length, 1);
});

test("全体・Organizerの共通議事録はチームの見出しがない項目を混ぜない", () => {
  const entry = {
    ...facts.facts.find((fact) => fact.text === "LP草案の作成完了"),
    path: "進捗報告 / 別チーム / 完了",
  };
  const result = compose({ kind: "organizer", startDate: "2026-11-11" }, [
    { ...source, role: "organizer", facts: [entry], dates: [], checks: [] },
  ]);
  assert.doesNotMatch(result.results[0].text, /LP草案/);
  entry.path = "進捗報告 / 集客広報 / 完了";
  assert.match(
    compose({ kind: "organizer", startDate: "2026-11-11" }, [
      { ...source, role: "organizer", facts: [entry], dates: [], checks: [] },
    ]).results[0].text,
    /LP草案/,
  );
});

test("前回使用済み版の日付を初期期間に使い、期限超過をNext Actionsで催促しない", () => {
  const previous = {
    id: crypto.randomUUID(),
    status: "final",
    request: { ...request, reportDate: "2026-11-14" },
    results: [
      {
        team: teams[0],
        text: "白木海斗\n\n完了\n別の実績\n\nNext Actions\n",
        items: [],
      },
    ],
  };
  const result = compose({}, makeSources(), [previous]);
  assert.equal(result.period.startDate, "2026-11-14");
  assert.doesNotMatch(result.results[0].text, /資料の確認/);
  assert.match(
    result.results[0].checks.map((check) => check.message).join(),
    /期限超過/,
  );
});

test("Docsの表の断片や担当者の見出しを完了実績にせず、明示した別名だけを本人と照合する", () => {
  const parsed = documentFacts(
    {
      body: {
        content: [
          p("2026-11-17", null, "HEADING_1"),
          p("完了", 0),
          {
            table: {
              tableRows: [
                {
                  tableCells: [
                    { content: [p("LP")] },
                    { content: [p("未完了")] },
                  ],
                },
              ],
            },
          },
        ],
      },
    },
    source,
    ["白木海斗"],
  );
  assert.equal(parsed.facts.length, 0);
  assert.ok(parsed.checks.some((check) => check.code === "doc_table"));
  const alias = documentFacts(
    {
      body: {
        content: [
          p("2026-11-17", null, "HEADING_1"),
          p("進捗報告", 0),
          p("白木", 1),
          p("完了", 2),
          p("依頼書を作成完了", 3),
        ],
      },
    },
    source,
    ["白木海斗", "白木"],
  );
  assert.equal(alias.facts.length, 1);
  assert.equal(alias.facts[0].personal, true);
  assert.equal(alias.facts[0].owner, "白木海斗");
});

test("同じ作業のDocs間の同日矛盾は完了へ寄せず、古い予定だけを後の実施日で解消する", () => {
  const make = (text, kind, date) => ({
    ...source,
    role: "work",
    dates: [],
    checks: [],
    facts: [
      {
        text,
        kind,
        date,
        path: "",
        sourceId: text,
        personal: true,
        stage: "資料・作業",
        taskKey: "lp公開",
        meetingDate: null,
      },
    ],
  });
  const conflict = compose({ kind: "organizer", startDate: "2026-11-11" }, [
    make("LP公開：完了", "done", "2026-11-17"),
    make("LP公開：未完了", "next", "2026-11-17"),
  ]);
  assert.equal(conflict.results[0].items.length, 0);
  const resolved = compose({ kind: "organizer", startDate: "2026-11-11" }, [
    make("LP公開：完了", "done", "2026-11-17"),
    make("LP公開：未完了", "next", "2026-11-16"),
  ]);
  assert.equal(resolved.results[0].items.length, 1);
  assert.equal(resolved.results[0].items[0].kind, "done");
});
test("本文の完了日と次の期限を混同せず、前回の定例日とタスクの期限も分ける", () => {
  const parsed = documentFacts(
    {
      body: {
        content: [
          p("2026-11-17", null, "HEADING_1"),
          p("白木海斗", 0),
          p("完了", 1),
          p("草案作成 完了日 2026/11/16 締切 2026/11/21", 2),
          p("Next Actions", 1),
          p("2026/11/22までに確認する", 2),
        ],
      },
    },
    source,
    ["白木海斗"],
  );
  assert.equal(parsed.facts[0].date, "2026-11-16");
  assert.equal(parsed.facts[0].due, "2026-11-21");
  assert.equal(parsed.facts[1].due, "2026-11-22");
  assert.deepEqual(parsed.dates, ["2026-11-17"]);
});

async function readSheetFixture(valueRanges, errorBody = null) {
  const f = fixture();
  await f.storage.put("drive:credential", {
    token: "fixture",
    expires: Date.now() + 3600000,
    accountFingerprint: "fixture",
    scopes: [driveScope, sheetsReadScope],
  });
  const sheet = {
    ...source,
    id: "sheet",
    mimeType: "application/vnd.google-apps.spreadsheet",
  };
  return (
    await readProgressSources(
      {},
      f.storage,
      [sheet],
      ["白木海斗"],
      async (url) => {
        if (errorBody) return Response.json(errorBody, { status: 403 });
        if (new URL(url).pathname.endsWith("batchGet"))
          return Response.json({ spreadsheetId: "sheet", valueRanges });
        return Response.json({
          spreadsheetId: "sheet",
          sheets: valueRanges.map((_, index) => ({
            properties: {
              sheetId: index,
              title: "管理" + index,
              gridProperties: { rowCount: 1000, columnCount: 32 },
            },
          })),
        });
      },
    )
  )[0];
}

test("Sheetsの空白の確保領域を合算せず、返却データで上限を検証する", async () => {
  const result = await readSheetFixture([
    {
      values: [
        ["タスク", "状態", "担当者", "完了日"],
        ["草案作成", "完了", "白木海斗", "2026/11/17"],
      ],
    },
    { values: [] },
  ]);
  assert.equal(result.status, "read");
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].text.includes("草案作成"), true);
});

test("Sheetsの実データ超過や指定範囲外の応答は部分実績を作らず停止する", async () => {
  const fullSheet = {
    values: Array.from({ length: 1000 }, () => Array(32).fill("x")),
  };
  for (const [ranges, expected] of [
    [[fullSheet, { values: [["x"]] }], /32000セル/],
    [
      [{ values: Array.from({ length: 1001 }, () => ["x"]) }],
      /指定した読み取り範囲/,
    ],
    [[{ values: [Array(33).fill("x")] }], /指定した読み取り範囲/],
    [[{ values: ["invalid row"] }], /指定した読み取り範囲/],
  ]) {
    const result = await readSheetFixture(ranges);
    assert.equal(result.status, "unread");
    assert.deepEqual(result.facts, []);
    assert.match(result.checks[0].message, expected);
  }
});

test("Google APIの無効・利用制限・権限不足を区別し、生のエラーを表示しない", async () => {
  for (const [details, errors, expected] of [
    [[{ reason: "SERVICE_DISABLED" }], [], /API.*無効/],
    [[], [{ reason: "accessNotConfigured" }], /API.*無効/],
    [[{ reason: "RATE_LIMIT_EXCEEDED" }], [], /利用制限/],
    [[], [{ reason: "userRateLimitExceeded" }], /利用制限/],
    [{ malformed: true }, [], /閲覧権限/],
    [[], [{ reason: "insufficientPermissions" }], /閲覧権限/],
  ]) {
    const result = await readSheetFixture([], {
      error: { message: "private raw diagnostic", details, errors },
    });
    assert.equal(result.status, "unread");
    assert.match(result.checks[0].message, expected);
    assert.ok(!JSON.stringify(result).includes("private raw diagnostic"));
  }
});

test("管理表の空欄・中止・名前のない状態をNext Actionsに変換しない", () => {
  const parsed = spreadsheetFacts(
    [
      {
        title: "管理",
        id: 0,
        values: [
          ["タスク", "状態", "担当者", "完了日"],
          ["状態未確認", "", "白木海斗", ""],
          ["", "進行中", "白木海斗", ""],
          ["中止した作業", "中止", "白木海斗", ""],
          ["次の作業", "進行中", "白木海斗", ""],
          ["作成した草案", " 完了 ", "白木海斗", "2026/11/17"],
        ],
      },
    ],
    source,
    ["白木海斗"],
  );
  assert.equal(parsed.facts.length, 2);
  assert.equal(parsed.facts[0].kind, "next");
  assert.equal(parsed.facts[1].kind, "done");
  assert.equal(parsed.checks.length, 3);
  assert.ok(parsed.facts.every((fact) => !fact.text.includes("中止")));
});

test("報告バックアップは本文と根拠を保持し認証情報を含めず、索引の不一致を拒否する", async () => {
  const f = fixture();
  const created = await generateProgressReport(
    {},
    f.storage,
    scope,
    { ...request, scope, id: crypto.randomUUID() },
    f.send,
  );
  const backup = await exportProgressReports(f.storage, scope);
  assert.equal(backup.records.length, 1);
  assert.deepEqual(backup.records[0], created);
  assert.ok(!JSON.stringify(backup).includes('"token"'));
  await generateProgressReport({}, f.storage, scope,
    { ...request, scope, id: crypto.randomUUID() }, f.send);
  const selected = await exportProgressReports(f.storage, scope, created.id);
  assert.deepEqual(selected.records, [created]);
  assert.equal((await exportProgressReports(f.storage, scope)).records.length, 2);
  await assert.rejects(exportProgressReports(f.storage, scope, crypto.randomUUID()), /見つかりません/);
  await assert.rejects(exportProgressReports(f.storage, scope, "invalid"), /不正/);
  await assert.rejects(exportProgressReports(f.storage, "different"));
  const index = await f.storage.get("drive:progress:index");
  index.records[0].revision = crypto.randomUUID();
  await f.storage.put("drive:progress:index", index);
  await assert.rejects(exportProgressReports(f.storage, scope), /保存版/);
});

test("履歴のアーカイブは本文を保持し、一覧へ戻せて古い操作を拒否する", async () => {
  const f = fixture();
  const record = await generateProgressReport(
    {},
    f.storage,
    scope,
    { ...request, scope, id: crypto.randomUUID() },
    f.send,
  );
  const input = {
    id: record.id,
    scope,
    expectedRevision: record.revision,
    archived: true,
  };
  const archived = await archiveProgressReport(f.storage, scope, input);
  const view = await progressReportView(f.storage, scope);
  assert.equal(view.history.length, 0);
  assert.equal(view.archivedHistory.length, 1);
  assert.deepEqual(archived.results, record.results);
  assert.equal(
    (await exportProgressReports(f.storage, scope)).records.length,
    1,
  );
  await assert.rejects(
    archiveProgressReport(f.storage, scope, { ...input, archived: false }),
    /変更/,
  );
  await archiveProgressReport(f.storage, scope, {
    ...input,
    expectedRevision: archived.revision,
    archived: false,
  });
  assert.equal((await progressReportView(f.storage, scope)).history.length, 1);
});

test("報告復元は確認した内容を再構成し重複・改変・古い確認を拒否する", async () => {
  const f = fixture();
  const created = await generateProgressReport(
    {},
    f.storage,
    scope,
    { ...request, scope, id: crypto.randomUUID() },
    f.send,
  );
  const backup = await exportProgressReports(f.storage, scope);
  const target = memory();
  const plan = await previewProgressRestore(target, scope, backup);
  const input = {
    backup,
    checksum: plan.checksum,
    expectedRevision: plan.expectedRevision,
    confirm: true,
  };
  await assert.rejects(
    restoreProgressReports(target, scope, { ...input, checksum: "changed" }),
    /再確認/,
  );
  assert.equal(
    (await restoreProgressReports(target, scope, input)).restored,
    1,
  );
  const loaded = await loadProgressReport(target, scope, created.id);
  assert.deepEqual(loaded.results, created.results);
  assert.notEqual(loaded.revision, created.revision);
  await assert.rejects(
    restoreProgressReports(target, scope, input),
    /履歴が変わり/,
  );
  const conflict = await previewProgressRestore(target, scope, backup);
  assert.equal(conflict.conflicts.length, 1);
  await assert.rejects(
    restoreProgressReports(target, scope, {
      ...input,
      expectedRevision: conflict.expectedRevision,
    }),
    /重複/,
  );
  await assert.rejects(
    previewProgressRestore(target, "other", backup),
    /対象範囲/,
  );
  await assert.rejects(
    previewProgressRestore(target, scope, {
      ...backup,
      records: [created, created],
    }),
    /重複/,
  );
});

test("復元は壊れた日付・根拠参照・比較配列・集計を保存前に拒否する", async () => {
  const f = fixture();
  await generateProgressReport(
    {},
    f.storage,
    scope,
    { ...request, scope, id: crypto.randomUUID() },
    f.send,
  );
  const original = await exportProgressReports(f.storage, scope);
  for (const mutate of [
    (backup) => (backup.records[0].request.reportDate = "2026-02-30"),
    (backup) =>
      (backup.records[0].results[0].items[0].references[0].sourceId =
        "unknown"),
    (backup) => (backup.records[0].results[0].comparison.previousOnly = {}),
    (backup) =>
      (backup.records[0].results[0].community.invalid = {
        period: -1,
        cumulative: 2,
        basis: "test",
      }),
    (backup) => backup.records[0].sources.push(backup.records[0].sources[0]),
  ]) {
    const candidate = structuredClone(original);
    mutate(candidate);
    const target = memory();
    await assert.rejects(previewProgressRestore(target, scope, candidate));
    assert.equal(target.values.size, 0);
  }
});
