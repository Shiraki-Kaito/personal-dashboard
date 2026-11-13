import { agendaAccounts } from "./agenda-google.js";
import { refreshUpcomingCalendar } from "./agenda-calendar.js";

const batchDelayMs = 15000;
const retryDelaysMs = [60000, 300000];

export async function queueCalendarSync(storage, now = Date.now(), source = "cron") {
  if (source === "cron") await storage.put("agenda:calendarScheduler", {
    lastTriggeredAt: new Date(now).toISOString(),
  });
  if (await storage.get("agenda:calendarJob")) return;
  const accounts = (await agendaAccounts(storage)).filter(account => !account.disconnectedAt);
  if (!accounts.length) return;
  await storage.put("agenda:calendarJob", {
    accountIds: accounts.map(account => account.id), index: 0,
    source, retries: 0, nextAt: now + batchDelayMs,
  });
}

async function advance(storage, job, now) {
  if (job.index + 1 >= job.accountIds.length) {
    await storage.delete("agenda:calendarJob");
    return;
  }
  await storage.put("agenda:calendarJob", {
    ...job, index: job.index + 1, retries: 0, nextAt: now + batchDelayMs,
  });
}

// 一回のAlarmで一接続を処理し、前回の完全な一覧は成功するまで保持する。
export async function runCalendarBatch(env, storage, send = fetch, now = Date.now()) {
  const job = await storage.get("agenda:calendarJob");
  if (!job || job.nextAt > now) return;
  const account = (await agendaAccounts(storage)).find(account =>
    account.id === job.accountIds[job.index] && !account.disconnectedAt,
  );
  if (!account) return advance(storage, job, now);
  const cache = (await storage.get("agenda:calendar:" + account.id)) || {};
  if (cache.retryAt > now) {
    await storage.put("agenda:calendarJob", { ...job, nextAt: cache.retryAt });
    return;
  }
  await refreshUpcomingCalendar(env, storage, send, now, { accountId: account.id, source: job.source });
  const result = await storage.get("agenda:calendar:" + account.id);
  if (["network", "remote", "rate"].includes(result?.errorCode) && job.retries < retryDelaysMs.length) {
    await storage.put("agenda:calendarJob", {
      ...job, retries: job.retries + 1,
      nextAt: Math.max(result.retryAt || 0, now + retryDelaysMs[job.retries]),
    });
    return;
  }
  await advance(storage, job, now);
}
