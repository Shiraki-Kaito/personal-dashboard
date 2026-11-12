import { InputError } from "./sync.js";
import {
  agendaAccounts,
  agendaToken,
  googleAgendaClient,
  AgendaError,
} from "./agenda-google.js";
import { googleConfigured } from "./drive-auth.js";
import {
  extractAppointment,
  validateAppointment,
  compareAppointments,
  messageText,
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
async function client(env, storage, account, send, budget) {
  const request = googleAgendaClient(
    await agendaToken(env, storage, account, send),
    send,
    budget,
  );
  return async (...args) => {
    try {
      return await request(...args);
    } catch (error) {
      if (error instanceof AgendaError && error.code === "authentication") {
        const key = "agenda:credential:" + account.id,
          credential = await storage.get(key);
        if (credential)
          await storage.put(key, { ...credential, invalid: true });
      }
      throw error;
    }
  };
}
export async function agendaView(env, storage, id) {
  const accounts = await agendaAccounts(storage),
    account = accounts.find((a) => a.id === (id || accounts[0]?.id));
  if (id && !account) throw new InputError("接続アカウントが不正です");
  const cache = account
    ? (await storage.get("agenda:cache:" + account.id)) || {}
    : {};
  return {
    configured: googleConfigured(env),
    accounts: await Promise.all(
      accounts.map(async (a) => ({
        ...a,
        connected:
          !!(await storage.get("agenda:credential:" + a.id)) &&
          !(await storage.get("agenda:credential:" + a.id))?.invalid,
      })),
    ),
    accountId: account?.id || null,
    ...cache,
    pendingRegistrations: account
      ? await Promise.all(
          ((await storage.get("agenda:pending:" + account.id)) || []).map(
            async (messageId) => ({
              messageId,
              ...(await storage.get(
                "agenda:operation:" + account.id + ":" + messageId,
              )),
            }),
          ),
        )
      : [],
    messages: await Promise.all(
      (cache.messages || []).map(async (message) => ({
        ...message,
        operation:
          (await storage.get(
            "agenda:operation:" + account.id + ":" + message.id,
          )) || null,
      })),
    ),
    maxMessages,
    pageSize,
  };
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
  try {
    const read = await client(env, storage, account, send);
    const page = await read("gmail", "messages", {
      q: "newer_than:14d -in:trash -in:spam",
      maxResults: String(pageSize),
      ...(input.more ? { pageToken: cache.nextPageToken } : {}),
    });
    if (page.messages !== undefined && !Array.isArray(page.messages))
      throw new AgendaError("メール一覧の応答が不正です", "incomplete");
    const messages = [];
    for (const entry of page.messages || []) {
      if (!/^[a-f0-9]{1,64}$/.test(entry.id))
        throw new AgendaError("メールIDが不正です", "incomplete");
      const mail = await read("gmail", "messages/" + entry.id, {
        format: "full",
        fields:
          "id,threadId,internalDate,snippet,payload(mimeType,filename,headers,body,parts)",
      });
      if (mail.id !== entry.id || !mail.payload)
        throw new AgendaError("メール本文の取得が未完了です", "incomplete");
      const header = (name) =>
        mail.payload.headers?.find((h) => h.name.toLowerCase() === name)
          ?.value || "";
      const subject = header("subject").slice(0, 300),
        text = messageText(mail.payload);
      messages.push({
        id: mail.id,
        subject,
        from: header("from").slice(0, 300),
        receivedAt: new Date(Number(mail.internalDate)).toISOString(),
        excerpt: text.slice(0, 1600),
        candidate: extractAppointment(subject, text),
        url:
          "https://mail.google.com/mail/u/" +
          encodeURIComponent(account.email) +
          "/#all/" +
          mail.id,
      });
    }
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
      lastSuccess: new Date(now).toISOString(),
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
  return agendaView(env, storage, account.id);
}
async function calendarEvents(env, storage, draft, send) {
  const events = [];
  // 5接続のトークン更新・登録後照合を含めても、1要求の通信数を抑える。
  const budget = { remaining: 30 };
  for (const account of await agendaAccounts(storage)) {
    const read = await client(env, storage, account, send, budget);
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
  const message = cache?.messages.find((m) => m.id === input.messageId);
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
  };
  const read = await client(env, storage, target, send);
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
  const target = await selected(storage, operation.targetAccountId);
  try {
    const read = await client(env, storage, target, send),
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
      error:
        error instanceof AgendaError ? error.message : "結果を照合できません",
    });
  }
  return agendaView(env, storage, account.id);
}
