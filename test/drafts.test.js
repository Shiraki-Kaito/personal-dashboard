import test from "node:test";
import assert from "node:assert/strict";
import { TaskDrafts } from "../public/task-drafts.js";
const base = { revision: "1", status: "todo", due: null };

test("状態反映後も期限の入力を保持し、自分の反映だけ基準へ取り込む", () => {
  const drafts = new TaskDrafts();
  drafts.edit("status", "done", base);
  drafts.edit("due", "2026-12-01", base);
  const submitted = drafts.submission("status");
  const remote = { ...base, status: "done", revision: "2" };
  drafts.receive({ remote, pending: null }, submitted);
  assert.equal(drafts.entries.has("status"), false);
  assert.equal(drafts.value("due", remote), "2026-12-01");
  assert.deepEqual(drafts.submission("due").base, remote);
  assert.equal(drafts.dirty, true);
  const due = drafts.submission("due");
  drafts.receive(
    { remote: { ...remote, due: due.value, revision: "3" }, pending: null },
    due,
  );
  assert.equal(drafts.dirty, false);
});

test("他方の項目が外部で変わったとき、古い編集基準を勝手に更新しない", () => {
  const drafts = new TaskDrafts();
  drafts.edit("due", "2026-12-01", base);
  drafts.edit("status", "done", base);
  const submitted = drafts.submission("status");
  drafts.receive(
    {
      remote: { ...base, status: "done", due: "2026-12-02", revision: "2" },
      pending: null,
    },
    submitted,
  );
  assert.deepEqual(drafts.submission("due").base, base);
  assert.equal(drafts.value("due"), "2026-12-01");
});

test("未同期・競合・再取得では入力を保持し、明示的な破棄だけで消す", () => {
  const drafts = new TaskDrafts();
  drafts.edit("status", "done", base);
  const submitted = drafts.submission("status");
  drafts.receive({ remote: base, pending: submitted }, submitted);
  drafts.receive(
    { remote: { ...base, revision: "other" }, pending: null },
    null,
  );
  assert.deepEqual(drafts.submission("status"), submitted);
  drafts.edit("status", "todo", base);
  assert.equal(drafts.dirty, false);
  drafts.edit("due", "2026-12-01", base);
  drafts.clear();
  assert.equal(drafts.dirty, false);
});
