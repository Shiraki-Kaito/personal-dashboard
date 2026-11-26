import { projectsFrom } from "./catalog.js";
import { monitoringView } from "./security-monitor.js";
import { displayAccounts } from "./agenda-labels.js";
import { upcomingCalendarView } from "./agenda-calendar.js";
import { driveView } from "./drive.js";
import { slackWorkspaces, slackWorkspaceStore } from "./slack-store.js";
import { prioritySearchPlan, mailRetrievalView, standardMailQuery } from "./mail-retrieval.js";
import { priorityRulesView } from "./mail-priority-rules.js";
import { mailBodyNotice } from "./mail-body-coverage.js";
import { connectionRecovery } from "./connection-recovery.js";

const hourlyFreshnessMs = 90 * 60 * 1000;
const githubFreshnessMs = 2 * 60 * 1000;
const maximumTaskStates = 1000;
const delayedJobMs = 5 * 60 * 1000;

const sourceGuidance = {
  disconnected: "接続設定から再接続してください",
  queued:
    "この接続の取得は順番待ちです。表示中の件数と成功時刻は前回の記録です",
  retrying: "取得失敗後の再試行待ちです。前回成功の一覧を保持しています",
  interrupted: "最終試行の完了を確認できません。対象の画面で再取得してください",
  error: "元の画面でエラーを確認し、権限・待機時刻を確認して再取得してください",
  running: "取得中です。前回成功の情報は取得完了まで保持します",
  never: "まだ取得に成功していません",
  stale: "保存情報が古くなっています。元の画面で更新してください",
  ok: "取得成功を記録しています",
  limited: "取得成功ですが、未取得・未確認の範囲があります",
};

// 本文・秘密値・保存されたエラーの生文字列を応答へ含めず、復旧の行き先を示す。
function sourceStatus({
  service,
  label,
  panel,
  cache = {},
  connected = true,
  active = false,
  activity = null,
  count = null,
  freshnessMs = hourlyFreshnessMs,
  now,
  stale = false,
  cron = null,
  test = false,
  accountId = null,
  stopped = false,
  coverage = null,
  progress = null,
}) {
  const success = Date.parse(cache.lastSuccess);
  const old = stale || !Number.isFinite(success) || now - success > freshnessMs;
  const activityState = activity || (active ? "running" : null);
  const incomplete =
    Number.isFinite(Date.parse(cache.lastAttempt)) &&
    (!Number.isFinite(success) || Date.parse(cache.lastAttempt) > success);
  let state;
  if (!connected) state = "disconnected";
  else if (cache.error) state = activityState === "running" ? "retrying" : activityState === "queued" ? "queued" : "error";
  else if (activityState) state = activityState;
  else if (incomplete) state = "interrupted";
  else if (!Number.isFinite(success)) state = "never";
  else state = old ? "stale" : coverage?.limited ? "limited" : "ok";
  return {
    service,
    accountId,
    test,
    label,
    panel,
    state,
    count,
    lastAttempt: cache.lastAttempt || null,
    lastSuccess: cache.lastSuccess || null,
    errorCode: cache.errorCode || (cache.error ? "fetch_failed" : null),
    retryAt: cache.retryAt || null,
    cron,
    guidance: sourceGuidance[state],
    coverage,
    progress,
    recovery: connectionRecovery(state, cache.errorCode, cache.retryAt, now, stopped),
  };
}

// 外部APIを呼ばず、現在の保存状態だけを集約する。照合・再送・データ削除はしない。
export async function healthView(env, storage, now = Date.now()) {
  const sources = [],
    pending = [],
    jobs = [];
  const projects = env.PROJECT_CONFIG ? projectsFrom(env.PROJECT_CONFIG) : [];
  for (const project of projects) {
    const cache = (await storage.get("catalog:" + project.project)) || {};
    sources.push(
      sourceStatus({
        service: "github",
        test: (project.kind || project.mode) !== "production",
        label: project.title || "GitHub Project",
        panel: "tasks",
        cache,
        count: cache.items?.length ?? null,
        freshnessMs: githubFreshnessMs,
        now,
      }),
    );
    const states = await storage.list({
      prefix: "task:" + project.project + ":",
      limit: maximumTaskStates + 1,
    });
    if (
      project.item &&
      !states.has("task:" + project.project + ":" + project.item)
    ) {
      const legacy = await storage.get("sync");
      if (legacy) states.set("legacy", legacy);
    }
    const count = [...states.values()].filter((value) => value.pending).length;
    if (count || states.size > maximumTaskStates)
      pending.push({
        service: "github",
        panel: "tasks",
        label: project.title || "GitHub Project",
        count,
        limited: states.size > maximumTaskStates,
        guidance:
          "未同期・競合をタスク画面で確認してください。自動で再送しません",
      });
  }
  const drive = await driveView(env, storage, now);
  sources.push(
    sourceStatus({
      service: "drive",
      label: "Google Drive",
      panel: "drive",
      cache: drive,
      count: drive.inventoryCount,
      connected: drive.connected && drive.configured,
      active: drive.scanning,
      cron: drive.automatic?.lastTriggeredAt || null,
      now,
    }),
  );
  const mailJob = await storage.get("agenda:mailJob");
  const calendarJob = await storage.get("agenda:calendarJob");
  const accounts = await displayAccounts(storage);
  const calendars = (await upcomingCalendarView(storage, now)).accounts;
  const mailCron =
    (await storage.get("agenda:mailScheduler"))?.lastTriggeredAt || null;
  const calendarCron =
    (await storage.get("agenda:calendarScheduler"))?.lastTriggeredAt || null;
  for (const account of accounts) {
    const credential = await storage.get("agenda:credential:" + account.id);
    const connected =
      !account.disconnectedAt && !!credential && !credential.invalid;
    const label = account.label || account.email;
    const mail = (await storage.get("agenda:cache:" + account.id)) || {};
    const rules = await priorityRulesView(storage, account.id);
    const coverage = mailRetrievalView(mail, await prioritySearchPlan(rules.rules), now);
    const bodyLimitedCount = (mail.messages || []).filter(message => !!mailBodyNotice(message)).length;
    const mailCoverage = {
      hasSnapshot: Number.isFinite(Date.parse(mail.lastSuccess)),
      snapshotAt: mail.lastSuccess || null,
      standardCount: coverage.standardCount,
      priorityCount: coverage.priorityCount,
      extraCount: coverage.extraCount,
      standardHasMore: coverage.standardHasMore,
      priorityHasMore: coverage.priorityHasMore,
      supplementCurrent: coverage.current,
      bodyLimitedCount,
      limited: coverage.standardHasMore || coverage.priorityHasMore || bodyLimitedCount > 0 || !!coverage.notice,
      notice: coverage.notice,
      standardUrl: "https://mail.google.com/mail/u/" + encodeURIComponent(account.email) + "/#search/" + encodeURIComponent(standardMailQuery),
      priorityUrl: "https://mail.google.com/mail/u/" + encodeURIComponent(account.email) + "/#search/" + encodeURIComponent(coverage.query),
    };
    sources.push(
      sourceStatus({
        service: "mail",
        accountId: account.id,
        stopped: !!account.disconnectedAt,
        coverage: mailCoverage,
        progress: accountProgress(mailJob, account.id),
        activity: jobActivity(mailJob, account.id, "accountIds"),
        label: label + " · メール",
        panel: "agenda",
        cache: mail,
        count: mail.messages?.length ?? null,
        connected,
        cron: mailCron,
        now,
      }),
    );
    const calendar = calendars.find((c) => c.accountId === account.id) || {};
    sources.push(
      sourceStatus({
        service: "calendar",
        accountId: account.id,
        stopped: !!account.disconnectedAt,
        progress: accountProgress(calendarJob, account.id),
        activity: jobActivity(calendarJob, account.id, "accountIds"),
        label: label + " · 予定",
        panel: "agenda",
        cache: calendar,
        count: calendar.count ?? null,
        stale: calendar.stale,
        connected,
        cron: calendarCron,
        now,
      }),
    );
    const unresolved =
      (await storage.get("agenda:pending:" + account.id)) || [];
    if (unresolved.length)
      pending.push({
        service: "calendar",
        label,
        panel: "agenda",
        accountId: account.id,
        count: unresolved.length,
        limited: false,
        guidance:
          "予定の登録結果が未確認です。メール・予定画面で結果を照合してください。自動再登録しません",
        recovery: { kind: "reconcile", label: "登録結果の照合へ" },
      });
  }
  const notesConfig = await storage.get("notes:config");
  const notes = (await storage.get("notes:cache")) || {};
  sources.push(
    sourceStatus({
      service: "notes",
      label: "Obsidianノート",
      panel: "notes",
      cache: notes,
      count: notes.files?.length ?? null,
      connected: !!notesConfig,
      freshnessMs: hourlyFreshnessMs,
      cron: (await storage.get("notes:automatic"))?.lastTriggeredAt || null,
      now,
    }),
  );
  const workspaces = await slackWorkspaces(storage);
  if (!workspaces.length)
    sources.push(
      sourceStatus({
        service: "slack",
        label: "Slack",
        panel: "slack",
        connected: false,
        now,
      }),
    );
  for (const workspace of workspaces) {
    const scoped = slackWorkspaceStore(storage, workspace.teamId);
    const credential = await scoped.get("slack:credential");
    const job = await scoped.get("slack:job");
    for (const channel of (await scoped.get("slack:channels")) || []) {
      const cache = (await scoped.get("slack:cache:" + channel.id)) || {};
      sources.push(
        sourceStatus({
          service: "slack",
          activity: jobActivity(job, channel.id, "channelIds"),
          label: (workspace.teamName || "Slack") + " · " + channel.name,
          panel: "slack",
          cache,
          count: cache.messages?.length ?? null,
          connected: !!credential && !credential.invalid,
          now,
        }),
      );
    }
    addJob(jobs, "Slack", await scoped.get("slack:job"), now);
  }
  for (const [label, key] of [
    ["Drive", "drive:job"],
    ["メール", "agenda:mailJob"],
    ["カレンダー", "agenda:calendarJob"],
  ])
    addJob(jobs, label, await storage.get(key), now);
  return {
    checkedAt: new Date(now).toISOString(),
    externalRequests: 0,
    monitoring: await monitoringView(env,storage,now),
    sources,
    pending,
    jobs,
    attentionCount:
      sources.filter(
        (s) => !s.test && !["ok", "running", "queued"].includes(s.state),
      ).length +
      pending.length +
      jobs.filter((j) => j.delayed).length,
  };
}
function addJob(jobs, label, job, now) {
  if (!job) return;
  const nextAt = job.nextAt || job.nextBatchAt || null;
  jobs.push({
    label,
    nextAt,
    delayed: Number.isFinite(nextAt) && now - nextAt > delayedJobMs,
  });
}

// ジョブの現在位置より前の接続を、取得中へ巻き戻さない。
function jobActivity(job, id, field) {
  if (!Array.isArray(job?.[field]) || !Number.isInteger(job.index)) return null;
  const position = job[field].indexOf(id);
  if (position < 0 || position < job.index) return null;
  return position === job.index ? "running" : "queued";
}

function accountProgress(job, id) {
  if (!jobActivity(job, id, "accountIds")) return null;
  const position = job.accountIds.indexOf(id);
  return {
    position: position + 1,
    total: job.accountIds.length,
    phase: position === job.index ? (job.phase === "priority" ? "重要候補の補完" : "通常取得") : "順番待ち",
    pages: position === job.index ? (job.standardPages || 0) + (job.pages || 0) : 0,
    nextAt: position === job.index ? job.nextAt || null : null,
  };
}
