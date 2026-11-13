import { agendaAccounts, agendaClient, AgendaError } from "./agenda-google.js";
import { displayAccounts } from "./agenda-labels.js";

const dayMs = 86400000,
  freshnessMs = 3600000,
  minimumRefreshMs = 60000;
const pageSize = 100,
  maximumPages = 5,
  maximumCacheBytes = 1024 * 1024;
export function calendarRange(now) {
  const today = new Date(now + 9 * 3600000).toISOString().slice(0, 10);
  const start = Date.parse(today + "T00:00:00+09:00");
  return {
    start: new Date(start).toISOString(),
    end: new Date(start + 7 * dayMs).toISOString(),
  };
}
function eventTime(value) {
  if (
    typeof value?.date === "string" &&
    /^\d{4}-\d\d-\d\d$/.test(value.date) &&
    Number.isFinite(Date.parse(value.date)) &&
    new Date(value.date).toISOString().slice(0, 10) === value.date
  )
    return { date: value.date };
  if (
    typeof value?.dateTime === "string" &&
    /(?:Z|[+-]\d\d:\d\d)$/.test(value.dateTime) &&
    Number.isFinite(Date.parse(value.dateTime))
  )
    return { dateTime: new Date(value.dateTime).toISOString() };
  throw new AgendaError(
    "予定の日時が不正です。保存済み情報を保持しました",
    "incomplete",
  );
}
function calendarLink(link, email) {
  if (typeof link !== "string" || link.length > 4096) return null;
  try {
    const url = new URL(link);
    if (
      url.protocol === "https:" &&
      (url.hostname === "calendar.google.com" ||
        (url.hostname === "www.google.com" &&
          url.pathname.startsWith("/calendar/event")))
    ) {
      url.searchParams.set("authuser", email);
      return url.href;
    }
  } catch {}
  return null;
}
function normalizeEvent(event, email, timezone) {
  if (!event || typeof event.id !== "string" || event.id.length > 1024)
    throw new AgendaError("予定のIDが不正です", "incomplete");
  const start = eventTime(event.start),
    end = eventTime(event.end);
  if (
    !!start.date !== !!end.date ||
    Date.parse(end.date || end.dateTime) <=
      Date.parse(start.date || start.dateTime)
  )
    throw new AgendaError("予定の期間が不正です", "incomplete");
  return {
    id: event.id,
    title: String(event.summary || "名称非公開").slice(0, 300),
    location: String(event.location || "").slice(0, 500),
    start,
    end,
    allDay: !!start.date,
    timezone: timezone || "不明",
    url: calendarLink(event.htmlLink, email),
    tentative: event.status === "tentative",
    transparent: event.transparency === "transparent",
  };
}
export async function upcomingCalendarView(storage, now = Date.now()) {
  const accounts = [],
    events = [],
    range = calendarRange(now);
  for (const account of await displayAccounts(storage)) {
    const cache = (await storage.get("agenda:calendar:" + account.id)) || {};
    const stale =
      !!account.disconnectedAt ||
      !cache.lastSuccess ||
      now - Date.parse(cache.lastSuccess) > freshnessMs ||
      cache.rangeStart !== range.start ||
      cache.rangeEnd !== range.end;
    accounts.push({
      accountId: account.id,
      email: account.email,
      label: account.label,
      count: cache.events?.length || 0,
      lastAttempt: cache.lastAttempt || null,
      source: cache.source || null,
      lastAttemptSource: cache.lastAttemptSource || null,
      lastSuccess: cache.lastSuccess || null,
      error: account.disconnectedAt ? "接続停止中・保存情報です" : cache.error || null,
      errorCode: account.disconnectedAt ? "disconnected" : cache.errorCode || null,
      retryAt: cache.retryAt || null,
      rangeStart: cache.rangeStart || null,
      rangeEnd: cache.rangeEnd || null,
      pages: cache.pages ?? null,
      receivedCount: cache.receivedCount ?? null,
      stale,
    });
    events.push(
      ...(cache.events || []).map((event) => ({
        ...event,
        accountId: account.id,
        email: account.email,
        label: account.label,
        stale,
        cachedWithError: !!cache.error || !!account.disconnectedAt,
      })),
    );
  }
  events.sort(
    (a, b) =>
      Date.parse(a.start.dateTime || a.start.date + "T00:00:00+09:00") -
        Date.parse(b.start.dateTime || b.start.date + "T00:00:00+09:00") ||
      a.accountId.localeCompare(b.accountId) ||
      a.id.localeCompare(b.id),
  );
  return {
    range,
    accounts,
    events,
    job: (await storage.get("agenda:calendarJob"))
      ? { active: true, nextAt: (await storage.get("agenda:calendarJob")).nextAt }
      : { active: false },
    scheduler: (await storage.get("agenda:calendarScheduler")) || null,
    complete:
      accounts.length > 0 && accounts.every((a) => !a.stale && !a.error),
    maximumEventsPerAccount: pageSize * maximumPages,
  };
}
// ページを最後まで取得したアカウントだけ確定する。失敗時は前の完全な一覧を維持する。
export async function refreshUpcomingCalendar(
  env,
  storage,
  send = fetch,
  now = Date.now(),
  options = {},
) {
  const range = calendarRange(now),
    budget = { remaining: 30 };
  for (const account of await agendaAccounts(storage)) {
    if (account.disconnectedAt || (options.accountId && account.id !== options.accountId)) continue;
    const key = "agenda:calendar:" + account.id,
      cache = (await storage.get(key)) || {};
    if (cache.retryAt > now) continue;
    const attempt = {
      ...cache,
      lastAttempt: new Date(now).toISOString(),
      lastAttemptSource: options.source || "manual",
      retryAt: now + minimumRefreshMs,
    };
    await storage.put(key, attempt);
    try {
      const read = await agendaClient(env, storage, account, send, budget),
        events = [],
        seen = new Set(),
        cursors = new Set();
      let cursor = null;
      let pages = 0,
        receivedCount = 0;
      for (let page = 0; ; page++) {
        if (page >= maximumPages)
          throw new AgendaError(
            "予定取得の上限500件に達しました。前の完全な一覧を保持します",
            "limit",
          );
        const result = await read("calendar", "events", {
          timeMin: range.start,
          timeMax: range.end,
          singleEvents: "true",
          orderBy: "startTime",
          timeZone: "Asia/Tokyo",
          showDeleted: "false",
          maxResults: String(pageSize),
          ...(cursor ? { pageToken: cursor } : {}),
          fields:
            "kind,timeZone,nextPageToken,items(id,status,summary,location,start,end,htmlLink,transparency)",
        });
        if (
          result.kind !== "calendar#events" ||
          (result.items !== undefined && !Array.isArray(result.items)) ||
          (result.items || []).length > pageSize
        )
          throw new AgendaError("予定一覧の応答が未完了です", "incomplete");
        pages++;
        receivedCount += (result.items || []).length;
        for (const event of result.items || []) {
          if (event.status === "cancelled") continue;
          const value = normalizeEvent(event, account.email, result.timeZone);
          if (seen.has(value.id))
            throw new AgendaError(
              "予定一覧に重複があります。再取得してください",
              "incomplete",
            );
          seen.add(value.id);
          events.push(value);
        }
        if (!result.nextPageToken) break;
        if (
          typeof result.nextPageToken !== "string" ||
          cursors.has(result.nextPageToken)
        )
          throw new AgendaError(
            "予定一覧のページが不正・循環しています",
            "incomplete",
          );
        cursor = result.nextPageToken;
        cursors.add(cursor);
      }
      const completed = {
        events,
        pages,
        receivedCount,
        rangeStart: range.start,
        rangeEnd: range.end,
        lastAttempt: attempt.lastAttempt,
        lastAttemptSource: attempt.lastAttemptSource,
        source: attempt.lastAttemptSource,
        lastSuccess: new Date(Math.max(now, Date.now())).toISOString(),
        retryAt: attempt.retryAt,
        error: null,
        errorCode: null,
      };
      if (
        new TextEncoder().encode(JSON.stringify(completed)).length >
        maximumCacheBytes
      )
        throw new AgendaError(
          "予定一覧の保存上限1MiBを超えました。前の完全な一覧を保持します",
          "limit",
        );
      await storage.put(key, completed);
    } catch (error) {
      const safe =
        error instanceof AgendaError
          ? error
          : new AgendaError(
              "予定の取得に失敗しました。保存済みの一覧を表示します",
              "incomplete",
            );
      await storage.put(key, {
        ...attempt,
        error: safe.message,
        errorCode: safe.code,
        retryAt: Math.max(attempt.retryAt, safe.retryAt || 0),
      });
    }
  }
  return upcomingCalendarView(storage, now);
}
