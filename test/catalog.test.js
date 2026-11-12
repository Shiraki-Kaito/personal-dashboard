import test from "node:test";
import assert from "node:assert/strict";
import { catalog, selectTask, taskStorage } from "../src/catalog.js";
import { ownerId } from "../src/github.js";
import { synchronize } from "../src/sync.js";
import { settingsFixture } from "./project-fixture.js";

function memory() {
  const data = new Map();
  return {
    get: async (k) => structuredClone(data.get(k)),
    put: async (k, v) => data.set(k, structuredClone(v)),
  };
}
test("全ページ取得と件数照合、失敗時の一覧保持", async () => {
  const storage = memory(),
    config = { project: "p", mode: "production" };
  let calls = 0,
    fail = false;
  const request = async (_, v) => {
    calls++;
    const nodes = v.cursor
      ? [{ id: "b", isArchived: true, content: { title: "B" } }]
      : [{ id: "a", isArchived: false, content: { title: "A" } }];
    return {
      viewer: { id: ownerId },
      node: {
        id: "p",
        owner: { id: ownerId },
        title: "Tasks",
        url: "https://github.com",
        items: {
          totalCount: fail ? 3 : 2,
          nodes,
          pageInfo: { hasNextPage: !v.cursor, endCursor: "next" },
        },
      },
    };
  };
  const before = await catalog(config, request, storage, true);
  assert.equal(calls, 2);
  assert.equal(before.items.length, 2);
  assert.equal(before.items[1].editable, false);
  fail = true;
  const after = await catalog(config, request, storage, true);
  assert.match(after.error, /件数/);
  assert.deepEqual(after.items, before.items);
  assert.equal(after.lastSuccess, before.lastSuccess);
  await assert.rejects(selectTask([config], "p", "b", storage));
  await assert.rejects(selectTask([config], "other", "a", storage));
});
test("旧状態を継承し、別タスクの未同期操作を分離する", async () => {
  const storage = memory();
  const config = {
    project: "p",
    item: "old",
    options: [{ id: "a" }, { id: "b" }],
  };
  const remote = { status: "a", due: null, revision: "1" };
  await storage.put("sync", {
    remote,
    pending: { id: "pending", field: "status", value: "b", base: remote },
  });
  const old = taskStorage(storage, config, "old");
  assert.equal((await old.get()).pending.id, "pending");
  const other = taskStorage(storage, { ...config, item: "other" }, "old");
  assert.equal(await other.get(), undefined);
  const api = { read: async () => ({ ...remote }), write: async () => {} };
  await synchronize("refresh", {}, config, api, other);
  assert.equal((await other.get()).pending, null);
  assert.equal((await old.get()).pending.id, "pending");
});

test("一覧でも状態と期限を取り、フィールドの続きは全ページを照合する", async () => {
  const storage = memory(),
    config = {
      project: "p",
      mode: "production",
      status_field: "s",
      due_field: "d",
    };
  let changeRevision = false;
  const request = async (_, variables) => {
    if (variables.settingsProject) return settingsFixture(config);
    if (variables.project)
      return {
        viewer: { id: ownerId },
        node: {
          id: "p",
          owner: { id: ownerId },
          title: "Tasks",
          url: "https://github.com",
          items: {
            totalCount: 2,
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                id: "a",
                updatedAt: "a1",
                content: { title: "A" },
                fieldValues: {
                  pageInfo: { hasNextPage: false },
                  nodes: [
                    { optionId: "done", field: { id: "s" } },
                    { date: "2026-11-12", field: { id: "d" } },
                  ],
                },
              },
              {
                id: "b",
                updatedAt: "b1",
                content: { title: "B" },
                fieldValues: {
                  pageInfo: { hasNextPage: true, endCursor: "more" },
                  nodes: [],
                },
              },
            ],
          },
        },
      };
    return {
      viewer: { id: ownerId },
      node: {
        id: "b",
        updatedAt: changeRevision && variables.cursor ? "b2" : "b1",
        project: { id: "p", owner: { id: ownerId }, items: { totalCount: 2 } },
        content: { title: "B" },
        fieldValues: {
          pageInfo: { hasNextPage: !variables.cursor, endCursor: "next" },
          nodes: variables.cursor
            ? [{ optionId: "todo", field: { id: "s" } }]
            : [{ date: "2026-11-13", field: { id: "d" } }],
        },
      },
    };
  };
  const before = await catalog(config, request, storage, true);
  assert.equal(before.hasPriorityFields, true);
  assert.equal(before.items[0].status, "done");
  assert.equal(before.items[0].due, "2026-11-12");
  assert.equal(before.items[1].status, "todo");
  assert.equal(before.items[1].due, "2026-11-13");
  changeRevision = true;
  const failed = await catalog(config, request, storage, true);
  assert.match(failed.error, /取得中に変更/);
  assert.deepEqual(failed.items, before.items);
});
