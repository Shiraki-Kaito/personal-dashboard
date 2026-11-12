import { readMailPage, recordMailRun } from "./agenda-mail.js";
import { displayAccounts, saveAccountLabel } from "./agenda-labels.js";
import { mailPriority } from "./agenda-priority.js";
import { maximumAgendaAccounts } from "./agenda-account-rules.js";
import { InputError } from "./sync.js";
import {
  upcomingCalendarView,
  refreshUpcomingCalendar,
} from "./agenda-calendar.js";
import {
  agendaAccounts,
  agendaClient,
  AgendaError,
  agendaConnectionStatus,
} from "./agenda-google.js";
import { googleConfigured } from "./drive-auth.js";
import {
  validateAppointment,
  compareAppointments,
  digest,
} from "./agenda-rules.js";
const pageSize = 20,
  maxMessages = 100,
  minimumRefreshMs = 60000;
async function selected(storage, id) {
  const accounts = await agendaAccounts(storage);
  const account = accounts.find((a) => a.id === (id || accounts[0]?.id));
  if (!account) throw new InputError("接続アカウントを選択してください");
  return account;
}
async function operationView(storage, accounts, key) {
  const operation = await storage.get(key);
  if (!operation) return null;
  const target = accounts.find(
    (account) => account.id === operation.targetAccountId,
  );
  return {
    ...operation,
    calendarUrl:
      target && operation.calendarUrl
        ? calendarUrl({ htmlLink: operation.calendarUrl }, target.email)
        : null,
  };
}
export async function agendaView(env, storage, id) {
  const accounts = await displayAccounts(storage),
    account = accounts.find((a) => a.id === (id || accounts[0]?.id));
  if (id && !account) throw new InputError("接続アカウントが不正です");
  const cache = account
    ? (await storage.get("agenda:cache:" + account.id)) || {}
    : {};
  const reviews = account
    ? (await storage.get("agenda:reviews:" + account.id)) || {}
    : {};
  return {
    configured: googleConfigured(env),
    accountLimit: maximumAgendaAccounts,
    mailJob: (await storage.get("agenda:mailJob"))
      ? { active: true, nextAt: (await storage.get("agenda:mailJob")).nextAt }
      : { active: false },
    mailHistory: account
      ? (await storage.get("agenda:history:" + account.id)) || []
      : [],
    mailScheduler: (await storage.get("agenda:mailScheduler")) || null,
    calendar: await upcomingCalendarView(storage),
    accounts: await Promise.all(
      accounts.map(async (a) => ({
        ...a,
        ...agendaConnectionStatus(
          await storage.get("agenda:credential:" + a.id),
        ),
      })),
    ),
    accountId: account?.id || null,
    ...cache,
    manualRegistrations: account
      ? await Promise.all(
          ((await storage.get("agenda:manualHistory:" + account.id)) || []).map(
            async (messageId) => ({
              messageId,
              ...(await operationView(
                storage,
                accounts,
                "agenda:operation:" + account.id + ":" + messageId,
              )),
            }),
          ),
        )
      : [],
    pendingRegistrations: account
      ? await Promise.all(
          ((await storage.get("agenda:pending:" + account.id)) || []).map(
            async (messageId) => ({
              messageId,
              ...(await operationView(
                storage,
                accounts,
                "agenda:operation:" + account.id + ":" + messageId,
              )),
            }),
          ),
        )
      : [],
    messages: await Promise.all(
      (cache.messages || []).map(async (message) => ({
        ...message,
        priority: message.priority || mailPriority(message),
        review: reviews[message.id] || null,
        operation:
          (await operationView(
            storage,
            accounts,
            "agenda:operation:" + account.id + ":" + message.id,
          )) || null,
      })),
    ),
    maxMessages,
    pageSize,
  };
}
export async function reviewAgenda(env, storage, input) {
  const account = await selected(storage, input.accountId),
    cache = await storage.get("agenda:cache:" + account.id);
  if (
    typeof input.reviewed !== "boolean" ||
    !cache?.messages.some((message) => message.id === input.messageId)
  )
    throw new InputError("表示中のメールを選択してください");
  const key = "agenda:reviews:" + account.id,
    now = Date.now();
  const reviews = Object.fromEntries(
    Object.entries((await storage.get(key)) || {}).filter(
      ([, value]) => now - Date.parse(value.reviewedAt) < 14 * 86400000,
    ),
  );
  if (input.reviewed)
    reviews[input.messageId] = { reviewedAt: new Date(now).toISOString() };
  else delete reviews[input.messageId];
  if (Object.keys(reviews).length > 5000)
    throw new InputError(
      "確認記録の上限です。古い記録の期限後に再試行してください",
    );
  await storage.put(key, reviews);
  return agendaView(env, storage, account.id);
}
export async function refreshAgendaCalendar(env, storage, input, send = fetch) {
  await refreshUpcomingCalendar(env, storage, send);
  return agendaView(env, storage, input.accountId);
}
export async function refreshAgenda(
  env,
  storage,
  input,
  send = fetch,
  now = Date.now(),
) {
  const account = await selected(storage, input.accountId),
    key = "agenda:cache:" + account.id;
  if (await storage.get("agenda:mailJob"))
    throw new InputError("メールの自動取得中です。完了後に再取得してください");
  const cache = (await storage.get(key)) || { messages: [], lastSuccess: null };
  if (cache.retryAt > now) return agendaView(env, storage, account.id);
  if (
    input.more &&
    (!cache.nextPageToken || cache.messages.length >= maxMessages)
  )
    throw new InputError(
      "続きの取得はありません。上限の場合はメール元で確認してください",
    );
  const attempt = {
    ...cache,
    lastAttempt: new Date(now).toISOString(),
    retryAt: now + minimumRefreshMs,
  };
  await storage.put(key, attempt);
  let fetchedCount = 0;
  try {
    const page = await readMailPage(
      env,
      storage,
      account,
      input.more ? cache.nextPageToken : null,
      send,
    );
    const messages = page.messages;
    fetchedCount = messages.length;
    const combined = input.more ? [...cache.messages, ...messages] : messages;
    const ids = new Set(combined.map((m) => m.id));
    if (ids.size !== combined.length)
      throw new AgendaError(
        "ページ取得中にメール一覧が変化しました。最初から更新してください",
        "incomplete",
      );
    await storage.put(key, {
      ...attempt,
      messages: combined,
      nextPageToken: page.nextPageToken || null,
      limited: combined.length >= maxMessages && !!page.nextPageToken,
      lastSuccess: new Date(Math.max(now, Date.now())).toISOString(),
      error: null,
      errorCode: null,
    });
  } catch (error) {
    const safe =
      error instanceof AgendaError
        ? error
        : new AgendaError(
            "メール取得に失敗しました。保存済みの一覧を表示します",
            "incomplete",
          );
    await storage.put(key, {
      ...attempt,
      error: safe.message,
      errorCode: safe.code,
      retryAt: Math.max(attempt.retryAt, safe.retryAt || 0),
    });
  }
  const result = await storage.get(key);
  await recordMailRun(storage, account.id, {
    source: "manual",
    startedAt: attempt.lastAttempt,
    finishedAt: new Date().toISOString(),
    outcome: result.error ? "failure" : "success",
    errorCode: result.errorCode || null,
    count: result.messages.length,
    fetchedCount,
    pages: result.error ? 0 : 1,
    hasMore: !!result.nextPageToken,
  });
  return agendaView(env, storage, account.id);
}
export async function renameAgendaAccount(env, storage, input) {
  await saveAccountLabel(storage, input);
  return agendaView(env, storage, input.accountId);
}
async function calendarEvents(env, storage, draft, send) {
  const events = [];
  // 5接続のトークン更新・登録後照合を含めても、1要求の通信数を抑える。
  const budget = { remaining: 30 };
  for (const account of await agendaAccounts(storage)) {
    const read = await agendaClient(env, storage, account, send, budget);
    let cursor = null;
    const cursors = new Set();
    for (let page = 0; ; page++) {
      if (page >= 5)
        throw new AgendaError(
          "カレンダーの全件照合が上限に達しました。登録を停止します",
          "limit",
        );
      const result = await read("calendar", "events", {
        timeMin: draft.start,
        timeMax: draft.end,
        singleEvents: "true",
        maxResults: "250",
        ...(cursor ? { pageToken: cursor } : {}),
        fields:
          "kind,timeZone,nextPageToken,items(id,etag,status,summary,start,end,transparency)",
      });
      if (
        result.kind !== "calendar#events" ||
        (result.items !== undefined && !Array.isArray(result.items))
      )
        throw new AgendaError("予定一覧が未完了です", "incomplete");
      if (
        result.timeZone &&
        result.timeZone !== "Asia/Tokyo" &&
        (result.items || []).some((event) => event.start?.date)
      )
        throw new AgendaError(
          "日本時間以外の終日予定が含まれています。元のカレンダーで確認してください",
          "incomplete",
        );
      events.push(
        ...(result.items || []).map((event) => ({
          ...event,
          accountId: account.id,
        })),
      );
      if (!result.nextPageToken) break;
      if (cursors.has(result.nextPageToken))
        throw new AgendaError("予定一覧のページが循環しています", "incomplete");
      cursor = result.nextPageToken;
      cursors.add(cursor);
    }
  }
  return events;
}
async function operationContext(storage, input) {
  const source = await selected(storage, input.accountId),
    target = await selected(storage, input.targetAccountId);
  const cache = await storage.get("agenda:cache:" + source.id);
  const manual = input.manual === true;
  if (
    manual &&
    !/^manual-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      input.messageId || "",
    )
  )
    throw new InputError("手入力予定の識別子が不正です");
  const message = manual
    ? { id: input.messageId }
    : cache?.messages.find((m) => m.id === input.messageId);
  if (!message) throw new InputError("保存済みのメールを選択してください");
  let draft;
  try {
    draft = validateAppointment(input.draft);
  } catch (error) {
    throw new InputError(error.message);
  }
  return {
    source,
    target,
    message,
    draft,
    key: "agenda:operation:" + source.id + ":" + message.id,
  };
}
export async function previewAppointment(env, storage, input, send = fetch) {
  const context = await operationContext(storage, input),
    { source, target, message, draft, key } = context;
  if (await storage.get(key))
    throw new InputError("登録処理がすでにあります。結果を照合してください");
  const matches = compareAppointments(
    draft,
    await calendarEvents(env, storage, draft, send),
  );
  matches.sort((a, b) =>
    (a.accountId + a.id).localeCompare(b.accountId + b.id),
  );
  const checksum = await digest({
    source: source.id,
    target: target.id,
    message: message.id,
    draft,
    matches,
  });
  await storage.put("agenda:preview:" + source.id + ":" + message.id, {
    checksum,
    expires: Date.now() + 600000,
  });
  return {
    checksum,
    matches,
    calendar: target.email + " のメインカレンダー",
    draft,
  };
}
function eventMatches(event, operation) {
  return (
    event?.status !== "cancelled" &&
    event?.summary === operation.draft.title &&
    (event?.location || "") === operation.draft.location &&
    Date.parse(event?.start?.dateTime) === Date.parse(operation.draft.start) &&
    Date.parse(event?.end?.dateTime) === Date.parse(operation.draft.end) &&
    event?.extendedProperties?.private?.dashboardOperation === operation.eventId
  );
}
function calendarUrl(event, email) {
  try {
    const url = new URL(event.htmlLink);
    if (
      url.protocol === "https:" &&
      (url.hostname === "calendar.google.com" ||
        (url.hostname === "www.google.com" &&
          url.pathname === "/calendar/event"))
    ) {
      // 複数ログイン時も、登録先と異なる既定アカウントで開かないよう指定する。
      url.searchParams.set("authuser", email);
      return url.href;
    }
  } catch {}
  return null;
}
export async function registerAppointment(env, storage, input, send = fetch) {
  if (input.confirmed !== true)
    throw new InputError("内容の本人確認が必要です");
  const { source, target, message, draft, key } = await operationContext(
    storage,
    input,
  );
  if (await storage.get(key))
    throw new InputError("二重登録を停止しました。結果を照合してください");
  const saved = await storage.get(
    "agenda:preview:" + source.id + ":" + message.id,
  );
  if (!saved || saved.expires < Date.now() || saved.checksum !== input.checksum)
    throw new InputError("確認内容が古いため、予定を再照合してください");
  const current = await previewAppointment(env, storage, input, send);
  if (current.checksum !== input.checksum)
    throw new InputError("予定が変わりました。再確認してください");
  if (current.matches.some((m) => m.duplicate))
    throw new InputError(
      "同じ日時・予定名の予定があります。元の予定を確認してください",
    );
  if (current.matches.length && input.allowConflict !== true)
    throw new InputError("時間が重なる予定があります。確認してください");
  const eventId =
    "pd" + (await digest({ source: source.id, message: message.id }));
  let operation = {
    eventId,
    targetAccountId: target.id,
    draft,
    phase: "登録結果未確認",
    lastAttempt: new Date().toISOString(),
    error: null,
    sourceType: input.manual === true ? "manual" : "mail",
  };
  const read = await agendaClient(env, storage, target, send);
  const existing = await read("calendar", "events/" + eventId, {}, null, true);
  if (existing)
    throw new AgendaError(
      "登録IDが存在します。元のカレンダーを確認してください",
      "conflict",
    );
  const pendingKey = "agenda:pending:" + source.id,
    pending = (await storage.get(pendingKey)) || [];
  if (pending.length >= 100)
    throw new AgendaError(
      "未確認の登録が100件あります。先に結果を照合してください",
      "limit",
    );
  await storage.transaction(async (tx) => {
    await tx.put(key, operation);
    await tx.put(pendingKey, [...pending, message.id]);
    if (input.manual === true) {
      const historyKey = "agenda:manualHistory:" + source.id;
      await tx.put(
        historyKey,
        [
          message.id,
          ...((await tx.get(historyKey)) || []).filter(
            (id) => id !== message.id,
          ),
        ].slice(0, 100),
      );
    }
  });
  try {
    await read(
      "calendar",
      "events",
      { sendUpdates: "none" },
      {
        id: eventId,
        summary: draft.title,
        location: draft.location,
        start: { dateTime: draft.start, timeZone: "Asia/Tokyo" },
        end: { dateTime: draft.end, timeZone: "Asia/Tokyo" },
        visibility: "private",
        extendedProperties: { private: { dashboardOperation: eventId } },
      },
    );
    const event = await read("calendar", "events/" + eventId);
    if (!eventMatches(event, operation))
      throw new AgendaError(
        "登録後の予定が一致しません。上書きせず停止します",
        "conflict",
      );
    operation = {
      ...operation,
      phase: "登録確認済み",
      lastSuccess: new Date().toISOString(),
      calendarUrl: calendarUrl(event, target.email),
    };
  } catch (error) {
    operation = {
      ...operation,
      error:
        error instanceof AgendaError
          ? error.message
          : "登録結果を確認できません。照合してください",
    };
  }
  await storage.transaction(async (tx) => {
    await tx.put(key, operation);
    if (operation.phase === "登録確認済み")
      await tx.put(
        pendingKey,
        pending.filter((id) => id !== message.id),
      );
  });
  return agendaView(env, storage, source.id);
}
export async function reconcileAppointment(env, storage, input, send = fetch) {
  const account = await selected(storage, input.accountId),
    key = "agenda:operation:" + account.id + ":" + input.messageId;
  const operation = await storage.get(key);
  if (!operation) throw new InputError("照合対象がありません");
  operation.lastAttempt = new Date().toISOString();
  const target = await selected(storage, operation.targetAccountId);
  try {
    const read = await agendaClient(env, storage, target, send),
      event = await read(
        "calendar",
        "events/" + operation.eventId,
        {},
        null,
        true,
      );
    if (!event)
      throw new AgendaError(
        "予定が見つかりません。結果不明のため再送していません。カレンダーで確認してください",
        "missing",
      );
    if (!eventMatches(event, operation))
      throw new AgendaError(
        "予定が変更・削除されています。上書きせず停止します",
        "conflict",
      );
    await storage.put(key, {
      ...operation,
      phase: "登録確認済み",
      error: null,
      lastSuccess: new Date().toISOString(),
      calendarUrl: calendarUrl(event, target.email),
    });
    const pendingKey = "agenda:pending:" + account.id;
    await storage.put(
      pendingKey,
      ((await storage.get(pendingKey)) || []).filter(
        (id) => id !== input.messageId,
      ),
    );
  } catch (error) {
    await storage.put(key, {
      ...operation,
      phase:
        error instanceof AgendaError &&
        ["missing", "conflict"].includes(error.code)
          ? "予定の変更・削除を検知"
          : "登録状態の確認失敗",
      error:
        error instanceof AgendaError ? error.message : "結果を照合できません",
    });
  }
  return agendaView(env, storage, account.id);
}
