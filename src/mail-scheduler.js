import { limitTimingText } from "./mail-body-coverage.js";
import { retainImportantMailBodies } from "./mail-body-retention.js";
import { priorityRulesView } from "./mail-priority-rules.js";
import {
  prioritySearchPlan,
  mergeMailLanes,
  standardMailQuery,
} from "./mail-retrieval.js";
import { agendaAccounts, AgendaError } from "./agenda-google.js";
import { readMailPage, recordMailRun } from "./agenda-mail.js";
const batchDelayMs = 15000,
  retryDelaysMs = [60000, 300000],
  maximumPages = 5,
  maximumMessages = 100;
export async function queueMailSync(
  storage,
  now = Date.now(),
  source = "cron",
) {
  if (source === "cron")
    await storage.put("agenda:mailScheduler", {
      lastTriggeredAt: new Date(now).toISOString(),
    });
  if (await storage.get("agenda:mailJob")) return;
  const accounts = (await agendaAccounts(storage)).filter(
    (a) => !a.disconnectedAt,
  );
  if (!accounts.length) return;
  await storage.put("agenda:mailJob", {
    accountIds: accounts.map((a) => a.id),
    index: 0,
    source,
    phase: "standard",
    nextAt: now + batchDelayMs,
    messages: [],
    cursor: null,
    cursors: [],
    pages: 0,
    retries: 0,
    startedAt: new Date(now).toISOString(),
  });
}
async function advance(storage, job, now) {
  if (job.index + 1 >= job.accountIds.length)
    return storage.delete("agenda:mailJob");
  await storage.put("agenda:mailJob", {
    ...job,
    index: job.index + 1,
    phase: "standard",
    standardMessages: [],
    standardNextPageToken: null,
    standardPages: 0,
    priorityPlan: null,
    nextAt: now + batchDelayMs,
    messages: [],
    cursor: null,
    cursors: [],
    pages: 0,
    retries: 0,
    startedAt: new Date(now).toISOString(),
  });
}
// 一回のAlarmでは一接続・一ページだけ取得し、Driveとは別の実行枠を使う。
export async function runMailBatch(
  env,
  storage,
  send = fetch,
  now = Date.now(),
) {
  const job = await storage.get("agenda:mailJob");
  if (!job || job.nextAt > now) return;
  const account = (await agendaAccounts(storage)).find(
    (a) => a.id === job.accountIds[job.index] && !a.disconnectedAt,
  );
  if (!account) return advance(storage, job, now);
  const key = "agenda:cache:" + account.id,
    cache = (await storage.get(key)) || { messages: [], lastSuccess: null };
  if (cache.retryAt > now) {
    await storage.put("agenda:mailJob", { ...job, nextAt: cache.retryAt });
    return;
  }
  const attempt = { ...cache, lastAttempt: new Date(now).toISOString() };
  await storage.put(key, attempt);
  try {
    const priorityPhase = job.phase === "priority";
    if (priorityPhase) {
      const currentPlan = await prioritySearchPlan(
        (await priorityRulesView(storage, account.id)).rules,
      );
      if (currentPlan.queryHash !== job.priorityPlan.queryHash)
        throw new AgendaError(
          "取得中に重要メールの検索条件が変わりました。前回の一覧を保持して次回に再取得します",
          "incomplete",
        );
    }
    const page = await readMailPage(
      env,
      storage,
      account,
      job.cursor,
      send,
      priorityPhase ? job.priorityPlan.query : standardMailQuery,
    );
    const messages = limitTimingText([...job.messages, ...page.messages]);
    if (
      messages.length > maximumMessages ||
      new Set(messages.map((m) => m.id)).size !== messages.length ||
      (page.nextPageToken && job.cursors.includes(page.nextPageToken))
    )
      throw new AgendaError(
        "取得中にメール一覧が変化・循環しました。次回の先頭から再取得します",
        "incomplete",
      );
    const pages = job.pages + 1;
    if (
      page.nextPageToken &&
      pages < maximumPages &&
      messages.length < maximumMessages
    ) {
      await storage.put("agenda:mailJob", {
        ...job,
        messages,
        pages,
        cursor: page.nextPageToken,
        cursors: [...job.cursors, page.nextPageToken],
        retries: 0,
        nextAt: now + batchDelayMs,
      });
      return;
    }
    if (!priorityPhase && page.nextPageToken) {
      const plan = await prioritySearchPlan(
        (await priorityRulesView(storage, account.id)).rules,
      );
      await storage.put("agenda:mailJob", {
        ...job,
        phase: "priority",
        standardMessages: messages,
        standardNextPageToken: page.nextPageToken,
        standardPages: pages,
        priorityPlan: plan,
        messages: [],
        cursor: null,
        cursors: [],
        pages: 0,
        retries: 0,
        nextAt: now + batchDelayMs,
      });
      return;
    }
    const regular = priorityPhase ? job.standardMessages : messages;
    const supplement = priorityPhase ? messages : [];
    const regularIds = regular.map((message) => message.id);
    const combined = mergeMailLanes(await retainImportantMailBodies(storage, account.id, regular), await retainImportantMailBodies(storage, account.id, supplement));
    const standardToken = priorityPhase
      ? job.standardNextPageToken
      : page.nextPageToken;
    const finishedAt = new Date(Math.max(now, Date.now())).toISOString();
    await storage.transaction(async (tx) => {
      await tx.put(key, {
        ...attempt,
        messages: combined,
        standardIds: regularIds,
        priorityIds: supplement.map((message) => message.id),
        retrieval: {
          version: 1,
          completedAt: finishedAt,
          standard: {
            count: regular.length,
            pages: priorityPhase ? job.standardPages : pages,
            hasMore: !!standardToken,
          },
          priority: priorityPhase
            ? {
                count: supplement.length,
                pages,
                hasMore: !!page.nextPageToken,
                queryHash: job.priorityPlan.queryHash,
                omittedTerms: job.priorityPlan.omittedTerms,
                extraCount: supplement.filter(
                  (message) => !regularIds.includes(message.id),
                ).length,
              }
            : null,
        },
        nextPageToken: standardToken,
        limited: !!standardToken,
        lastSuccess: finishedAt,
        retryAt: now + 60000,
        error: null,
        errorCode: null,
      });
      await recordMailRun(tx, account.id, {
        source: job.source,
        startedAt: job.startedAt,
        finishedAt,
        outcome: "success",
        errorCode: null,
        count: combined.length,
        fetchedCount: regular.length + supplement.length,
        pages: priorityPhase ? job.standardPages + pages : pages,
        standardCount: regular.length,
        priorityCount: supplement.length,
        extraCount: supplement.filter(
          (message) => !regularIds.includes(message.id),
        ).length,
        hasMore: !!standardToken || (priorityPhase && !!page.nextPageToken),
      });
      await advance(tx, job, now);
    });
  } catch (error) {
    const safe =
      error instanceof AgendaError
        ? error
        : new AgendaError(
            "メール自動取得に失敗しました。保存済み情報を保持しています",
            "incomplete",
          );
    const retryable =
      ["network", "remote", "rate"].includes(safe.code) &&
      job.retries < retryDelaysMs.length;
    await storage.transaction(async (tx) => {
      await tx.put(key, {
        ...attempt,
        error: safe.message,
        errorCode: safe.code,
        retryAt: safe.retryAt || null,
      });
      await recordMailRun(tx, account.id, {
        source: job.source,
        startedAt: job.startedAt,
        finishedAt: new Date(Math.max(now, Date.now())).toISOString(),
        outcome: "failure",
        errorCode: safe.code,
        count: cache.messages.length,
        fetchedCount: job.messages.length,
        pages: job.pages,
        hasMore: !!cache.nextPageToken,
      });
      if (retryable)
        await tx.put("agenda:mailJob", {
          ...job,
          retries: job.retries + 1,
          nextAt: Math.max(safe.retryAt || 0, now + retryDelaysMs[job.retries]),
        });
      else await advance(tx, job, now);
    });
  }
}
