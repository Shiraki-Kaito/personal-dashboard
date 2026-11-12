import test from "node:test";
import assert from "node:assert/strict";
import {
  calendarRange,
  upcomingCalendarView,
  refreshUpcomingCalendar,
} from "../src/agenda-calendar.js";

const now = Date.parse("2027-01-12T03:00:00Z");
function memory(values = new Map()) {
  return {
    values,
    get: async (k) => structuredClone(values.get(k)),
    put: async (k, v) => values.set(k, structuredClone(v)),
  };
}
async function setup() {
  const s = memory();
  await s.put(
    "agenda:accounts",
    ["a", "b"].map((id) => ({
      id,
      email: id + "@example.test",
      calendar: "primary",
    })),
  );
  for (const id of ["a", "b"])
    await s.put("agenda:credential:" + id, {
      token: "fixture-" + id,
      expires: Date.now() + 3600000,
    });
  return s;
}
const event = (id, extra = {}) => ({
  id,
  summary: "試験 " + id,
  start: { dateTime: "2027-01-12T14:00:00+09:00" },
  end: { dateTime: "2027-01-12T15:00:00+09:00" },
  htmlLink: "https://calendar.google.com/calendar/event?eid=fixture",
  ...extra,
});
const result = (items, extra = {}) =>
  Response.json({
    kind: "calendar#events",
    timeZone: "Asia/Tokyo",
    items,
    ...extra,
  });

test("日本時間の今日から7日間を固定し、複数アカウント・複数ページを全件取得する", async () => {
  const s = await setup(),
    calls = [];
  const view = await refreshUpcomingCalendar(
    {},
    s,
    async (url, init) => {
      const u = new URL(url),
        account = init.headers.Authorization.endsWith("-a") ? "a" : "b";
      calls.push({ u, account, method: init.method });
      assert.equal(u.searchParams.get("timeMin"), "2027-01-11T15:00:00.000Z");
      assert.equal(u.searchParams.get("timeMax"), "2027-01-18T15:00:00.000Z");
      assert.equal(u.searchParams.get("singleEvents"), "true");
      assert.equal(u.searchParams.get("orderBy"), "startTime");
      return account === "a" && !u.searchParams.has("pageToken")
        ? result([event("one")], { nextPageToken: "page2" })
        : result([event(account === "a" ? "two" : "three")]);
    },
    now,
  );
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.method === "GET"));
  assert.equal(view.events.length, 3);
  assert.equal(view.complete, true);
  assert.deepEqual(
    view.accounts.map((a) => a.count),
    [2, 1],
  );
  assert.deepEqual(
    view.accounts.map((a) => [a.pages, a.receivedCount]),
    [
      [2, 2],
      [1, 1],
    ],
  );
  assert.equal(
    new URL(view.events[0].url).searchParams.get("authuser"),
    "a@example.test",
  );
  const reload = await upcomingCalendarView(memory(s.values), now);
  assert.equal(reload.events.length, 3);
  const before = calls.length;
  await refreshUpcomingCalendar(
    {},
    s,
    () => {
      throw Error("待機中に呼ばない");
    },
    now + 1,
  );
  assert.equal(calls.length, before);
});
test("終日・複数日の排他的終了日と透明な予定を保持し、取消を除外・不正URLを配信しない", async () => {
  const s = await setup();
  await s.put("agenda:accounts", [{ id: "a", email: "a@example.test" }]);
  const view = await refreshUpcomingCalendar(
    {},
    s,
    async () =>
      result(
        [
          event("all", {
            start: { date: "2027-01-12" },
            end: { date: "2027-01-14" },
            transparency: "transparent",
            htmlLink: "https://evil.example.test",
          }),
          event("cancel", { status: "cancelled" }),
          event("tentative", { status: "tentative" }),
        ],
        { timeZone: "America/Los_Angeles" },
      ),
    now,
  );
  assert.equal(view.events.length, 2);
  assert.equal(view.events[0].allDay, true);
  assert.equal(view.events[0].end.date, "2027-01-14");
  assert.equal(view.events[0].timezone, "America/Los_Angeles");
  assert.equal(view.events[0].transparent, true);
  assert.equal(view.events[0].url, null);
  assert.equal(view.events[1].tentative, true);
});
test("権限エラーは対象だけ失敗とし、以前の完全な一覧と成功時刻を再起動後も保持する", async () => {
  const s = await setup();
  await refreshUpcomingCalendar({}, s, async () => result([event("old")]), now);
  const success = (await s.get("agenda:calendar:a")).lastSuccess;
  const view = await refreshUpcomingCalendar(
    {},
    s,
    async (url, init) =>
      init.headers.Authorization.endsWith("-a")
        ? Response.json({}, { status: 403 })
        : result([]),
    now + 60001,
  );
  assert.equal(view.accounts[0].errorCode, "permission");
  assert.equal(view.accounts[0].lastSuccess, success);
  assert.equal(view.accounts[1].count, 0);
  assert.equal(view.complete, false);
  assert.equal(view.events[0].cachedWithError, true);
  const reloaded = await upcomingCalendarView(memory(s.values), now + 60001);
  assert.equal(reloaded.events.length, 1);
});
test("認証失効・レート制限・通信失敗を区別する", async () => {
  for (const [status, code] of [
    [401, "authentication"],
    [429, "rate"],
  ]) {
    const s = await setup();
    const view = await refreshUpcomingCalendar(
      {},
      s,
      async () => Response.json({}, { status }),
      now,
    );
    assert.equal(view.accounts[0].errorCode, code);
    assert.equal(view.complete, false);
    if (status === 401)
      assert.equal((await s.get("agenda:credential:a")).invalid, true);
  }
  const s = await setup();
  let attempts = 0;
  const view = await refreshUpcomingCalendar(
    {},
    s,
    async () => {
      attempts++;
      throw Error("fixture network");
    },
    now,
  );
  assert.equal(attempts, 4);
  assert.equal(view.accounts[0].errorCode, "network");
});
test("Googleの403利用制限を権限不足と区別し、生のエラー本文を返さない", async () => {
  const s = await setup();
  const view = await refreshUpcomingCalendar(
    {},
    s,
    async () =>
      Response.json(
        {
          error: {
            errors: [{ reason: "userRateLimitExceeded" }],
            message: "fixture-private-value",
          },
        },
        { status: 403 },
      ),
    now,
  );
  assert.equal(view.accounts[0].errorCode, "rate");
  assert.equal(JSON.stringify(view).includes("fixture-private-value"), false);
  assert.equal((await s.get("agenda:credential:a")).invalid, undefined);
});
test("ページ上限・循環・重複・不正日時で部分一覧を確定しない", async () => {
  for (const mode of ["limit", "cycle", "duplicate", "invalid"]) {
    const s = await setup();
    await s.put("agenda:accounts", [{ id: "a", email: "a@example.test" }]);
    const range = calendarRange(now);
    await s.put("agenda:calendar:a", {
      events: [
        {
          id: "old",
          start: { date: "2027-01-12" },
          end: { date: "2027-01-13" },
        },
      ],
      rangeStart: range.start,
      rangeEnd: range.end,
      lastSuccess: "2027-01-12T00:00:00Z",
    });
    let page = 0;
    const view = await refreshUpcomingCalendar(
      {},
      s,
      async () => {
        page++;
        if (mode === "invalid")
          return result([event("bad", { end: { dateTime: "not-date" } })]);
        if (mode === "duplicate") return result([event("same"), event("same")]);
        return result([event("page" + page)], {
          nextPageToken: mode === "cycle" ? "same" : "next" + page,
        });
      },
      now,
    );
    assert.deepEqual(
      view.events.map((e) => e.id),
      ["old"],
    );
    assert.ok(view.accounts[0].error);
    assert.equal(view.complete, false);
    assert.ok(page <= 5);
  }
});
test("未取得・古い期間・日付跨ぎを完全取得や予定なしと扱わない", async () => {
  const s = await setup();
  let view = await upcomingCalendarView(s, now);
  assert.equal(view.complete, false);
  await refreshUpcomingCalendar({}, s, async () => result([]), now);
  view = await upcomingCalendarView(s, now);
  assert.equal(view.complete, true);
  assert.equal(view.events.length, 0);
  view = await upcomingCalendarView(s, now + 86400000);
  assert.equal(view.complete, false);
  assert.ok(view.accounts.every((a) => a.stale));
});
test("保存容量の上限では前の完全な一覧を保持し、成功扱いにしない", async () => {
  const s = await setup();
  await s.put("agenda:accounts", [{ id: "a", email: "a@example.test" }]);
  let page = 0;
  const view = await refreshUpcomingCalendar(
    {},
    s,
    async () => {
      page++;
      return result(
        Array.from({ length: 100 }, (_, i) =>
          event(`${page}-${i}`, {
            htmlLink:
              "https://calendar.google.com/calendar/event?eid=" +
              "x".repeat(3500),
          }),
        ),
        page < 5 ? { nextPageToken: "page" + page } : {},
      );
    },
    now,
  );
  assert.equal(page, 5);
  assert.equal(view.accounts[0].errorCode, "limit");
  assert.equal(view.accounts[0].lastSuccess, null);
  assert.equal(view.events.length, 0);
  assert.equal(view.complete, false);
});
