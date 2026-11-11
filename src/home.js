import { catalog, projectsFrom, taskStorage } from "./catalog.js";
import { driveView } from "./drive.js";

const githubFreshMs = 2 * 60 * 1000;
const driveFreshMs = 90 * 60 * 1000;
const japanOffsetMs = 9 * 60 * 60 * 1000;
export const todayInJapan = (now) =>
  new Date(now + japanOffsetMs).toISOString().slice(0, 10);
const isStale = (success, interval, now) =>
  !Number.isFinite(Date.parse(success)) || now - Date.parse(success) > interval;

// GitHubの状態・期限と保存済み未同期操作から、確認の理由を付ける。元データは変更しない。
export function prioritizeTask(item, config, sync, source, now) {
  const completedOptions =
    config.completed_options ||
    config.options
      .filter((option) => ["Done", "完了"].includes(option.name))
      .map((option) => option.id);
  const completed = completedOptions.includes(item.status);
  const reasons = [];
  if (item.outOfCatalog) reasons.push("一覧にないタスク");
  if (sync?.pending)
    reasons.push(
      sync.phase?.includes("競合") ? "競合・上書き停止" : "未同期の変更",
    );
  if (
    sync?.error &&
    (sync.pending ||
      !source.lastSuccess ||
      sync.lastAttempt > source.lastSuccess)
  )
    reasons.push("同期エラー");
  const active = item.editable && !completed && item.fieldsComplete;
  const today = todayInJapan(now);
  if (active && item.due && item.due < today) reasons.push("期限超過");
  else if (active && item.due === today) reasons.push("今日が期限");
  const category = reasons.length ? "priority" : completed ? "done" : "other";
  const score = reasons.some((reason) => /競合|未同期|エラー/.test(reason))
    ? 0
    : reasons.includes("期限超過")
      ? 1
      : 2;
  return {
    ...item,
    projectId: config.project,
    projectTitle: config.title,
    projectUrl: config.url,
    statusName: item.fieldsComplete
      ? config.options.find((option) => option.id === item.status)?.name ||
        "状態未設定"
      : "状態未取得",
    pending: !!sync?.pending,
    reasons,
    category,
    score,
    stale: !!source.error || isStale(source.lastSuccess, githubFreshMs, now),
    lastSuccess: source.lastSuccess,
    actionable: !!item.editable,
  };
}

export async function homeView(
  env,
  storage,
  request,
  refresh = false,
  now = Date.now(),
) {
  const allProjects = projectsFrom(env.PROJECT_CONFIG);
  const projects = allProjects.filter(
    (project) =>
      project.mode === "production" &&
      (project.kind || "production") === "production",
  );
  const sources = [],
    tasks = [],
    alerts = [];
  if (!projects.length)
    alerts.push({ service: "github", message: "実運用Projectが未設定です" });
  for (const config of projects) {
    const source = await catalog(config, request, storage, refresh);
    const detailsReady = source.hasPriorityFields === true;
    sources.push({
      projectId: config.project,
      title: config.title,
      total: source.total,
      count: source.items.length,
      lastAttempt: source.lastAttempt,
      lastSuccess: source.lastSuccess,
      error: source.error,
      stale:
        !!source.error ||
        !detailsReady ||
        isStale(source.lastSuccess, githubFreshMs, now),
      detailsReady,
    });
    if (
      source.error ||
      !detailsReady ||
      isStale(source.lastSuccess, githubFreshMs, now)
    )
      alerts.push({
        service: "github",
        message:
          config.title +
          "：" +
          (source.error ||
            (!detailsReady ? "状態・期限を未取得" : "保存済みの情報を表示中")),
      });
    const seen = new Set();
    for (const item of source.items) {
      seen.add(item.id);
      const sync = await taskStorage(
        storage,
        { ...config, item: item.id },
        allProjects.find((project) => project.item)?.item,
      ).get();
      const effective =
        sync?.remote && sync.lastSuccess > source.lastSuccess
          ? {
              ...item,
              status: sync.remote.status,
              due: sync.remote.due,
              fieldsComplete: true,
            }
          : item;
      tasks.push(prioritizeTask(effective, config, sync, source, now));
    }
    // 一覧から消えたタスクでも未同期操作の存在を隠さない。対象の復旧まで書き込みは提供しない。
    for (const [key, sync] of await storage.list({
      prefix: "task:" + config.project + ":",
    })) {
      const itemId = key.slice(("task:" + config.project + ":").length);
      if (sync?.pending && !seen.has(itemId))
        tasks.push(
          prioritizeTask(
            {
              id: itemId,
              title: sync.remote?.title || "一覧にないタスク",
              editable: false,
              outOfCatalog: true,
              due: sync.remote?.due,
            },
            config,
            sync,
            source,
            now,
          ),
        );
    }
  }
  tasks.sort(
    (a, b) =>
      a.score - b.score ||
      (a.due || "9999").localeCompare(b.due || "9999") ||
      a.title.localeCompare(b.title, "ja"),
  );
  const drive = await driveView(env, storage, now);
  const driveStale =
    !!drive.error || isStale(drive.lastSuccess, driveFreshMs, now);
  if (
    !drive.configured ||
    !drive.connected ||
    drive.error ||
    driveStale ||
    drive.authorization.requiresReauthorization
  )
    alerts.push({
      service: "drive",
      message:
        "Drive：" +
        (drive.error ||
          (!drive.connected
            ? "再接続が必要"
            : drive.authorization.requiresReauthorization
              ? "再認可待ち"
              : !drive.configured
                ? "設定待ち"
                : "保存済みの一覧を表示中")),
    });
  return {
    generatedAt: new Date(now).toISOString(),
    today: todayInJapan(now),
    tasks,
    sources,
    alerts,
    complete:
      projects.length > 0 &&
      sources.every((source) => source.detailsReady && !source.stale) &&
      drive.connected &&
      drive.configured &&
      !driveStale &&
      !drive.scanning &&
      !drive.authorization.requiresReauthorization,
    counts: {
      priority: tasks.filter((task) => task.category === "priority").length,
      other: tasks.filter((task) => task.category === "other").length,
      done: tasks.filter((task) => task.category === "done").length,
      drive: drive.unreadChanges.length,
    },
    drive: {
      files: drive.unreadChanges,
      lastSuccess: drive.lastSuccess,
      lastAttempt: drive.lastAttempt,
      error: drive.error,
      stale: driveStale,
      scanning: drive.scanning,
      connected: drive.connected,
    },
  };
}
