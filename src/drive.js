import { driveClient, DriveError } from "./drive-http.js";
import { driveToken, googleConfigured } from "./drive-auth.js";

export const driveRefreshIntervalMs = 60 * 60 * 1000;
const minimumRefreshMs = 60 * 1000;
const folderType = "application/vnd.google-apps.folder";
const maxInventoryFiles = 10000;
const maxMetadataBytes = 6 * 1024 * 1024;
export function driveConfig(env) {
  if (!env.DRIVE_CONFIG) return null;
  const config = JSON.parse(env.DRIVE_CONFIG);
  if (
    !/^[a-zA-Z0-9_-]+$/.test(config.folderId) ||
    typeof config.includeSubfolders !== "boolean"
  )
    throw new DriveError(
      "Driveフォルダのサーバー設定が不正です",
      "configuration",
    );
  return config;
}
function configKey(config) {
  return config.folderId + ":" + config.includeSubfolders;
}

const pagesPerBatch = 16;
const batchDelayMs = 2000;
const scanVersion = 3;

async function startScan(config, read, now) {
  const root = await read("files/" + encodeURIComponent(config.folderId), {
    fields: "id,name,mimeType,trashed,driveId",
    supportsAllDrives: "true",
  });
  if (
    root.id !== config.folderId ||
    root.mimeType !== folderType ||
    root.trashed
  )
    throw new DriveError(
      "対象は利用可能なフォルダではありません",
      "configuration",
    );
  return {
    scope: configKey(config),
    startedAt: now,
    nextBatchAt: now,
    driveId: root.driveId || null,
    folderName: root.name,
    folders: [{ id: root.id, path: root.name }],
    index: 0,
    cursor: "",
    cursors: [],
    currentIds: [],
    files: [],
  };
}
async function advanceScan(config, job, read) {
  const seenFolders = new Set(job.folders.map((folder) => folder.id));
  const files = new Map(job.files.map((file) => [file.id, file]));
  let pageCount = 0;
  while (job.index < job.folders.length && pageCount < pagesPerBatch) {
    const folder = job.folders[job.index];
    const parameters = {
      q: "'" + folder.id + "' in parents and trashed = false",
      fields:
        "nextPageToken,incompleteSearch,files(id,name,mimeType,createdTime,modifiedTime,parents)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      corpora: job.driveId ? "drive" : "user",
    };
    if (job.driveId) parameters.driveId = job.driveId;
    if (job.cursor) parameters.pageToken = job.cursor;
    const page = await read("files", parameters);
    pageCount++;
    if (page.incompleteSearch || !Array.isArray(page.files))
      throw new DriveError("Driveの検索結果が未完了です", "incomplete");
    const currentIds = new Set(job.currentIds);
    for (const file of page.files) {
      if (
        !file.id ||
        !/^[a-zA-Z0-9_-]+$/.test(file.id) ||
        !file.parents?.includes(folder.id) ||
        currentIds.has(file.id)
      )
        throw new DriveError(
          "Drive一覧の取得に不整合がありました",
          "incomplete",
        );
      currentIds.add(file.id);
      if (file.mimeType === folderType) {
        if (config.includeSubfolders && !seenFolders.has(file.id)) {
          seenFolders.add(file.id);
          job.folders.push({
            id: file.id,
            path: folder.path + " / " + file.name,
          });
        }
      } else {
        if (
          !Number.isFinite(Date.parse(file.createdTime)) ||
          !Number.isFinite(Date.parse(file.modifiedTime))
        )
          throw new DriveError(
            "日時を取得できないファイルがあり、一覧は未完了です",
            "incomplete",
          );
        files.set(file.id, {
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          createdTime: file.createdTime,
          modifiedTime: file.modifiedTime,
          folder: folder.path,
        });
        if (files.size > maxInventoryFiles)
          throw new DriveError(
            "ファイル取得上限に達したため一覧は未完了です",
            "limit",
          );
      }
    }
    job.cursor = page.nextPageToken || "";
    if (job.cursor) {
      if (job.cursors.includes(job.cursor))
        throw new DriveError(
          "ページ取得が繰り返されたため停止しました",
          "incomplete",
        );
      job.cursors.push(job.cursor);
      job.currentIds = [...currentIds];
    } else {
      job.index++;
      job.cursors = [];
      job.currentIds = [];
    }
  }
  job.files = [...files.values()];
  if (new TextEncoder().encode(JSON.stringify(job)).length > maxMetadataBytes)
    throw new DriveError(
      "メタデータの保存上限に達したため一覧は未完了です",
      "limit",
    );
  return job.index === job.folders.length;
}
// 単体取得用の入口も分割取得と同じページ処理を使う。
export async function scanDrive(config, read) {
  const job = await startScan(config, read, Date.now());
  while (!(await advanceScan(config, job, read))) {}
  return {
    files: job.files,
    folderName: job.folderName,
    folderCount: job.folders.length,
  };
}

export function driveChanges(previous, current, now) {
  const before = new Map(previous.map((file) => [file.id, file]));
  const after = new Map(current.map((file) => [file.id, file]));
  const changes = [];
  for (const file of current) {
    const old = before.get(file.id),
      events = [];
    if (!old) events.push("追加を検知");
    else {
      if (file.modifiedTime !== old.modifiedTime) events.push("更新");
      if (file.name !== old.name) events.push("名前変更");
      if (file.folder !== old.folder) events.push("保存場所変更");
    }
    if (events.length) changes.push({ ...file, events, detectedAt: now });
  }
  for (const file of previous) {
    if (!after.has(file.id))
      changes.push({ ...file, events: ["対象範囲外"], detectedAt: now });
  }
  return changes;
}
export function orderedDriveFiles(files) {
  return [...files].sort(
    (a, b) =>
      Date.parse(b.modifiedTime) - Date.parse(a.modifiedTime) ||
      a.id.localeCompare(b.id),
  );
}
export async function driveView(env, storage, now = Date.now()) {
  const config = driveConfig(env);
  const credential = await storage.get("drive:credential");
  let cache = await storage.get("drive:cache");
  if (!config || cache?.scope !== configKey(config)) cache = null;
  let job = await storage.get("drive:job");
  if (!config || job?.scope !== configKey(config)) job = null;
  return {
    configured: !!config && googleConfigured(env),
    configurationError:
      env.GOOGLE_CLIENT_ID && !googleConfigured(env)
        ? "Google OAuth設定を確認してください。Client IDの末尾は.apps.googleusercontent.comです。"
        : null,
    connected: !!credential && !credential.invalid,
    folderId: config?.folderId || null,
    includeSubfolders: config?.includeSubfolders ?? null,
    folderName: cache?.folderName || config?.label || null,
    inventoryCount: cache?.files.length ?? null,
    folderCount: cache?.folderCount ?? null,
    files: orderedDriveFiles(cache?.files || []),
    changes: cache?.changes || [],
    changesKnown: cache?.viewVersion === 3,
    nextScheduledAt: new Date(
      (Math.floor(now / driveRefreshIntervalMs) + 1) * driveRefreshIntervalMs,
    ).toISOString(),
    automatic: (await storage.get("drive:scheduler")) || null,
    lastAttempt: cache?.lastAttempt || null,
    lastSuccess: cache?.lastSuccess || null,
    error: cache?.error || null,
    retryAt: cache?.scanVersion === scanVersion ? cache.retryAt || null : null,
    scanning: !!job,
    progress: job
      ? {
          foldersDone: job.index,
          foldersFound: job.folders.length,
          filesFound: job.files.length,
        }
      : null,
  };
}
export async function refreshDrive(
  env,
  storage,
  send = fetch,
  now = Date.now(),
) {
  const config = driveConfig(env);
  if (!config || !googleConfigured(env)) return driveView(env, storage, now);
  let cache = await storage.get("drive:cache");
  if (cache?.scope !== configKey(config))
    cache = {
      scope: configKey(config),
      files: [],
      baselineAt: null,
      lastAttempt: null,
      lastSuccess: null,
    };
  let job = await storage.get("drive:job");
  if (job?.scope !== configKey(config)) job = null;
  if (
    job
      ? job.nextBatchAt > now
      : cache.scanVersion === scanVersion && cache.retryAt > now
  )
    return driveView(env, storage, now);
  cache.scanVersion = scanVersion;
  cache.lastAttempt = new Date(now).toISOString();
  cache.retryAt = now + minimumRefreshMs;
  await storage.put("drive:cache", cache);
  try {
    const token = await driveToken(env, storage, send);
    const read = driveClient(token, send);
    job ??= await startScan(config, read, now);
    const done = await advanceScan(config, job, read);
    if (!done) {
      job.nextBatchAt = now + batchDelayMs;
      cache.error = null;
      cache.retryAt = job.nextBatchAt;
      await storage.transaction(async (tx) => {
        await tx.put("drive:job", job);
        await tx.put("drive:cache", cache);
      });
      return driveView(env, storage, now);
    }
    const result = {
      files: job.files,
      folderName: job.folderName,
      folderCount: job.folders.length,
    };
    const files = result.files;
    const changes = cache.baselineAt
      ? driveChanges(cache.files, files, now)
      : [];
    if (
      new TextEncoder().encode(JSON.stringify(files)).length > maxMetadataBytes
    )
      throw new DriveError(
        "メタデータの保存上限に達したため一覧は未完了です",
        "limit",
      );
    Object.assign(cache, result, {
      files,
      baselineAt: cache.baselineAt || now,
      changes,
      viewVersion: 3,
      lastSuccess: new Date(now).toISOString(),
      error: null,
      retryAt: now + minimumRefreshMs,
    });
  } catch (error) {
    if (!(error instanceof DriveError)) throw error;
    if (error.code === "authentication") {
      const credential = await storage.get("drive:credential");
      if (credential)
        await storage.put("drive:credential", { ...credential, invalid: true });
    }
    cache.error = error.message;
    cache.retryAt = Math.max(cache.retryAt, error.retryAt || 0);
  }
  await storage.transaction(async (tx) => {
    await tx.put("drive:cache", cache);
    await tx.delete("drive:job");
  });
  return driveView(env, storage, now);
}
