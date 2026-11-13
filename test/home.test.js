import test from "node:test";
import assert from "node:assert/strict";
import { homeView, prioritizeTask, todayInJapan } from "../src/home.js";
import { ownerId } from "../src/github.js";
import { settingsFixture } from "./project-fixture.js";
const now = Date.parse("2026-11-11T15:30:00Z");
const cfg = {
  project: "p",
  title: "Tasks",
  mode: "production",
  kind: "production",
  status_field: "s",
  due_field: "d",
  options: [
    { id: "todo", name: "Todo" },
    { id: "done", name: "Done" },
  ],
  url: "https://github.com/users/owner/projects/1",
};
const env = {
  PROJECT_CONFIG: JSON.stringify({
    projects: [cfg, { ...cfg, project: "trial", kind: "test" }],
  }),
  DRIVE_CONFIG: JSON.stringify({ folderId: "root", includeSubfolders: true }),
  GOOGLE_CLIENT_ID: "1-fixture.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "fixture",
  GOOGLE_OAUTH_PUBLISHING_STATUS: "published",
};

test("番号・氏名付き個人作業の変更をホームから分離し、未確認記録は消さない", async () => {
  const storage = await setup();
  const cache = await storage.get("drive:cache");
  const personal = {...cache.unreadChanges[0], id:"personal",folder:"Root / 900_白木_個人作業 / notes"};
  await storage.put("drive:cache", {...cache,unreadChanges:[...cache.unreadChanges,personal]});
  const view = await homeView(env,storage,()=>assert.fail(),false,now);
  assert.deepEqual(view.drive.files.map(file=>file.id),["file"]);
  assert.equal(view.drive.personalCount,1);
  assert.equal((await storage.get("drive:cache")).unreadChanges.length,2);
});
function memory() {
  const data = new Map();
  return {
    get: async (k) => structuredClone(data.get(k)),
    put: async (k, v) => data.set(k, structuredClone(v)),
    list: async ({ prefix }) =>
      new Map([...data].filter(([key]) => key.startsWith(prefix))),
  };
}
async function setup() {
  const storage = memory();
  const items = [
    {
      id: "late",
      title: "Late",
      editable: true,
      fieldsComplete: true,
      status: "todo",
      due: "2026-11-11",
    },
    {
      id: "today",
      title: "Today",
      editable: true,
      fieldsComplete: true,
      status: "todo",
      due: "2026-11-12",
    },
    {
      id: "later",
      title: "Later",
      editable: true,
      fieldsComplete: true,
      status: "todo",
      due: "2026-11-13",
    },
    {
      id: "done",
      title: "Done",
      editable: true,
      fieldsComplete: true,
      status: "done",
      due: "2026-11-01",
    },
    { id: "archive", title: "Archive", editable: false, archived: true },
  ];
  await storage.put("catalog:p", {
    items,
    total: items.length,
    hasPriorityFields: true,
    lastSuccess: new Date(now).toISOString(),
    lastAttempt: new Date(now).toISOString(),
    error: null,
  });
  await storage.put("drive:credential", {
    grantedPublishingStatus: "published",
    connectedAt: now,
  });
  await storage.put("drive:cache", {
    scope: "root:true",
    files: [],
    folderCount: 1,
    lastSuccess: new Date(now).toISOString(),
    unreadChanges: [
      {
        id: "file",
        name: "File",
        events: ["更新"],
        changeId: "version",
        detectedAt: now,
      },
    ],
    viewVersion: 3,
  });
  return storage;
}
test("日本時間の日付で期限を分類し、完了タスクを期限超過にしない", () => {
  assert.equal(todayInJapan(Date.parse("2026-11-11T14:59:59Z")), "2026-11-11");
  assert.equal(todayInJapan(Date.parse("2026-11-11T15:00:00Z")), "2026-11-12");
  const task = {
    id: "a",
    title: "A",
    editable: true,
    fieldsComplete: true,
    due: "2026-11-11",
    status: "done",
  };
  const source = { lastSuccess: new Date(now).toISOString() };
  assert.equal(prioritizeTask(task, cfg, null, source, now).category, "done");
  const pending = prioritizeTask(
    task,
    cfg,
    { pending: { id: "op" }, phase: "競合・上書き停止" },
    source,
    now,
  );
  assert.equal(pending.category, "priority");
  assert.deepEqual(pending.reasons, ["競合・上書き停止"]);
});
test("実運用だけを集計し、一覧から消えた未同期操作も見せる", async () => {
  const storage = await setup();
  await storage.put("task:p:late", {
    pending: { id: "op" },
    phase: "競合・上書き停止",
  });
  await storage.put("task:p:gone", {
    pending: { id: "orphan" },
    remote: { title: "Missing", due: "2026-11-10" },
  });
  const view = await homeView(
    env,
    storage,
    () => assert.fail("保存済み表示は外部取得しない"),
    false,
    now,
  );
  assert.equal(view.sources.length, 1);
  assert.equal(view.sources[0].total, 5);
  assert.deepEqual(view.counts, { priority: 3, other: 2, done: 1, drive: 1 });
  assert.deepEqual(view.tasks.find((t) => t.id === "late").reasons, [
    "競合・上書き停止",
    "期限超過",
  ]);
  assert.equal(view.tasks.find((t) => t.id === "gone").actionable, false);
  assert.equal(view.complete, true);
});
test("取得失敗・古いキャッシュを全体で警告し、確認不要と断定しない", async () => {
  const storage = await setup();
  const saved = await storage.get("catalog:p");
  await storage.put("catalog:p", { ...saved, error: "権限不足" });
  const drive = await storage.get("drive:cache");
  await storage.put("drive:cache", {
    ...drive,
    lastSuccess: new Date(now - 91 * 60000).toISOString(),
  });
  const view = await homeView(env, storage, () => assert.fail(), false, now);
  assert.equal(view.complete, false);
  assert.equal(view.alerts.length, 2);
  assert.equal(view.tasks.find((t) => t.id === "late").stale, true);
  assert.equal(view.drive.files.length, 1);
  assert.deepEqual((await storage.get("catalog:p")).items, saved.items);
});
test("直前に反映確認した状態を古い一覧で巻き戻さず表示する", async () => {
  const storage = await setup();
  const saved = await storage.get("catalog:p");
  await storage.put("catalog:p", {
    ...saved,
    lastSuccess: new Date(now - 1000).toISOString(),
  });
  await storage.put("task:p:late", {
    remote: { status: "done", due: "2026-11-11" },
    lastSuccess: new Date(now).toISOString(),
    pending: null,
  });
  const view = await homeView(env, storage, () => assert.fail(), false, now);
  assert.equal(view.tasks.find((t) => t.id === "late").category, "done");
});

test("ホームの更新でGitHub側の完了変更と全件数を取り込む", async () => {
  const storage = await setup();
  const view = await homeView(
    env,
    storage,
    async (_, variables) =>
      variables.settingsProject
        ? settingsFixture(cfg)
        : {
            viewer: { id: ownerId },
            node: {
              id: cfg.project,
              title: cfg.title,
              url: cfg.url,
              owner: { id: ownerId },
              items: {
                totalCount: 1,
                pageInfo: { hasNextPage: false },
                nodes: [
                  {
                    id: "late",
                    content: { title: "Late" },
                    fieldValues: {
                      pageInfo: { hasNextPage: false },
                      nodes: [{ optionId: "done", field: { id: "s" } }],
                    },
                  },
                ],
              },
            },
          },
    true,
    now,
  );
  assert.equal(view.sources[0].total, 1);
  assert.equal(view.tasks[0].category, "done");
  assert.equal(view.tasks[0].due, null);
  assert.equal(view.counts.priority, 0);
});
