import { projectsFrom } from "./catalog.js";
import { displayAccounts } from "./agenda-labels.js";
import { upcomingCalendarView } from "./agenda-calendar.js";
import { driveView } from "./drive.js";
import { slackWorkspaces, slackWorkspaceStore } from "./slack-store.js";

const hourlyFreshnessMs = 90 * 60 * 1000;
const githubFreshnessMs = 2 * 60 * 1000;
const maximumTaskStates = 1000;
const delayedJobMs = 5 * 60 * 1000;

// 本文・秘密値・保存されたエラーの生文字列を応答へ含めず、復旧の行き先を示す。
function sourceStatus({
  service,
  label,
  panel,
  cache = {},
  connected = true,
  active = false,
  count = null,
  freshnessMs = hourlyFreshnessMs,
  now,
  stale = false,
  cron = null,
  test = false,
}) {
  const success = Date.parse(cache.lastSuccess);
  const old = stale || !Number.isFinite(success) || now - success > freshnessMs;
  const state = !connected
    ? "disconnected"
    : cache.error
      ? "error"
      : active
        ? "running"
        : !Number.isFinite(success)
          ? "never"
          : old
            ? "stale"
            : "ok";
  return {
    service,
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
    guidance:
      state === "disconnected"
        ? "接続設定から再接続してください"
        : state === "error"
          ? "元の画面でエラーを確認し、権限・待機時刻を確認して再取得してください"
          : state === "running"
            ? "取得中です。前回成功の情報は取得完了まで保持します"
            : state === "never"
              ? "まだ取得に成功していません"
              : state === "stale"
                ? "保存情報が古くなっています。元の画面で更新してください"
                : "取得成功を記録しています",
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
    sources.push(
      sourceStatus({
        service: "mail",
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
        count: unresolved.length,
        limited: false,
        guidance:
          "予定の登録結果が未確認です。メール・予定画面で結果を照合してください。自動再登録しません",
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
      freshnessMs: 60 * 60 * 1000,
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
    for (const channel of (await scoped.get("slack:channels")) || []) {
      const cache = (await scoped.get("slack:cache:" + channel.id)) || {};
      sources.push(
        sourceStatus({
          service: "slack",
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
    sources,
    pending,
    jobs,
    attentionCount:
      sources.filter((s) => !s.test && !["ok", "running"].includes(s.state))
        .length +
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
