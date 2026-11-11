import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeUnread,
  unreadChanges,
  reviewChanges,
  DriveReviewError,
} from "../src/drive-review.js";
const change = (time = 1) => ({
  id: "file",
  name: "File",
  events: ["更新"],
  detectedAt: time,
});
test("変化のない次回取得でも未確認を保持し、同じファイルの再変更を集約する", () => {
  const initial = mergeUnread([], [change()]);
  assert.deepEqual(mergeUnread(initial, []), initial);
  const next = mergeUnread(initial, [{ ...change(2), events: ["名前変更"] }]);
  assert.equal(next.length, 1);
  assert.equal(next[0].firstDetectedAt, 1);
  assert.equal(next[0].occurrences, 2);
  assert.deepEqual(next[0].events, ["更新", "名前変更"]);
  assert.notEqual(next[0].changeId, initial[0].changeId);
});
test("古い画面の確認済み操作は再変更を消さず、再送も安全", () => {
  const first = mergeUnread([], [change()]);
  const next = mergeUnread(first, [change(2)]);
  const stale = reviewChanges({ unreadChanges: next }, first);
  assert.equal(stale.acknowledged, 0);
  assert.deepEqual(stale.remaining, next);
  const reviewed = reviewChanges({ unreadChanges: next }, next);
  assert.equal(reviewed.acknowledged, 1);
  assert.equal(reviewed.remaining.length, 0);
  assert.equal(reviewChanges({ unreadChanges: [] }, next).acknowledged, 0);
});
test("既存の直近差分を安定した版で継承し、不正な確認要求は拒否する", () => {
  const cache = { changes: [change()] };
  assert.deepEqual(unreadChanges(cache), unreadChanges(cache));
  assert.equal(reviewChanges(cache, unreadChanges(cache)).remaining.length, 0);
  for (const invalid of [
    null,
    [],
    [{}],
    [
      { id: "file", changeId: "a" },
      { id: "file", changeId: "b" },
    ],
  ])
    assert.throws(() => reviewChanges(cache, invalid), DriveReviewError);
});
