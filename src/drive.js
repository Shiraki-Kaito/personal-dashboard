import { groupView } from "./drive-groups.js";
import { isPersonalWork } from "./drive-review.js";
export { isPersonalWork } from "./drive-review.js";
import { driveClient, DriveError } from "./drive-http.js";
import { nextRecovery } from "./recovery.js";
import {
  beginDriveRun,
  finishDriveRun,
  driveHistoryLimit,
} from "./drive-history.js";
import {
  driveToken,
  googleConfigured,
  googleAuthorizationStatus,
  ensureDriveAccount,
} from "./drive-auth.js";
import {
  unreadChanges,
  mergeUnread,
  reviewChanges,
  DriveReviewError,
} from "./drive-review.js";

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
        "nextPageToken,incompleteSearch,files(id,name,mimeType,createdTime,modifiedTime,parents,lastModifyingUser(displayName))",
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
          lastModifiedBy: typeof file.lastModifyingUser?.displayName === "string"
            ? file.lastModifyingUser.displayName.trim().slice(0, 200) || null
            : null,
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
  const authorization = googleAuthorizationStatus(env, credential);
  let cache = await storage.get("drive:cache");
  if (!config || cache?.scope !== configKey(config)) cache = null;
  let job = await storage.get("drive:job");
  const currentFiles = new Map((cache?.files || []).map(file => [file.id, file]));
  if (!config || job?.scope !== configKey(config)) job = null;
  return {
    groups: groupView(cache, await storage.get("drive:groups")),
    configured: !!config && googleConfigured(env),
    configurationError:
      env.GOOGLE_CLIENT_ID && !googleConfigured(env)
        ? "Google OAuth設定を確認してください。Client IDの末尾は.apps.googleusercontent.comです。"
        : null,
    connected: !!credential && !credential.invalid,
    authorization,
    authorizationReviewAt: authorization.reviewAt,
    folderId: config?.folderId || null,
    includeSubfolders: config?.includeSubfolders ?? null,
    folderName: cache?.folderName || config?.label || null,
    inventoryCount: cache?.files.length ?? null,
    folderCount: cache?.folderCount ?? null,
    files: orderedDriveFiles(cache?.files || []).map((file) =>
      isPersonalWork(file) ? { ...file, personal: true } : file,
    ),
    changes: cache?.changes || [],
    unreadChanges: unreadChanges(cache).map((file) => {
      const current = currentFiles.get(file.id);
      // 同じ更新時刻のスナップショットだけ補完する。新しい更新者を過去の検知に付けない。
      const enriched = current?.modifiedTime === file.modifiedTime && current?.lastModifiedBy
        ? { ...file, lastModifiedBy: current.lastModifiedBy }
        : file;
      return isPersonalWork(enriched) ? { ...enriched, personal: true } : enriched;
    }),
    changesKnown: cache?.viewVersion === 3,
    nextScheduledAt: new Date(
      (Math.floor(now / driveRefreshIntervalMs) + 1) * driveRefreshIntervalMs,
    ).toISOString(),
    automatic: (await storage.get("drive:scheduler")) || null,
    runHistory: (await storage.get("drive:history")) || [],
    activeRun: (await storage.get("drive:activeRun")) || null,
    historyLimit: driveHistoryLimit,
    lastAttempt: cache?.lastAttempt || null,
    lastSuccess: cache?.lastSuccess || null,
    error: cache?.error || null,
    errorCode: cache?.errorCode || null,
    recovery: (await storage.get("drive:recovery")) || null,
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
  source = "manual",
) {
  const config = driveConfig(env);
  if (!config || !googleConfigured(env)) {
    await storage.delete("drive:recovery");
    return driveView(env, storage, now);
  }
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
  const scheduledRecovery = await storage.get("drive:recovery");
  await beginDriveRun(storage, scheduledRecovery ? "recovery" : source, now);
  if (scheduledRecovery?.nextAt)
    await storage.put("drive:recovery", { ...scheduledRecovery, nextAt: null });
  try {
    const token = await driveToken(env, storage, send);
    await ensureDriveAccount(storage, token, send);
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
    const unread = mergeUnread(unreadChanges(cache), changes);
    if (
      new TextEncoder().encode(JSON.stringify({ files, unread })).length >
      maxMetadataBytes
    )
      throw new DriveReviewError(
        "一覧と未確認の変更が保存上限に達しました。前回の一覧を保持します",
      );
    Object.assign(cache, result, {
      files,
      baselineAt: cache.baselineAt || now,
      changes,
      unreadChanges: unread,
      viewVersion: 3,
      lastSuccess: new Date(now).toISOString(),
      error: null,
      errorCode: null,
      retryAt: now + minimumRefreshMs,
    });
    await storage.delete("drive:recovery");
  } catch (error) {
    if (
      !(error instanceof DriveError) &&
      !(error instanceof DriveReviewError)
    ) {
      // 想定外の失敗も古い成功表示に戻さない。例外の本文には秘密値が含まれ得る。
      error = new DriveError(
        "Driveの取得処理に失敗しました。保存済みの一覧を保持します",
        "unexpected",
      );
    }
    if (error.code === "authentication") {
      const credential = await storage.get("drive:credential");
      if (credential)
        await storage.put("drive:credential", { ...credential, invalid: true });
    }
    cache.error = error.message;
    cache.errorCode = error.code || "limit";
    cache.retryAt = Math.max(cache.retryAt, error.retryAt || 0);
    const recovery = nextRecovery(
      error,
      await storage.get("drive:recovery"),
      now,
    );
    if (recovery) await storage.put("drive:recovery", recovery);
    else await storage.delete("drive:recovery");
  }
  await storage.transaction(async (tx) => {
    await tx.put("drive:cache", cache);
    await tx.delete("drive:job");
    await finishDriveRun(tx, cache, now);
  });
  return driveView(env, storage, now);
}

export async function acknowledgeDrive(env, storage, entries) {
  const config = driveConfig(env);
  const cache = await storage.get("drive:cache");
  if (!config || !cache || cache.scope !== configKey(config))
    throw new DriveReviewError("対象の一覧を取得してから確認してください");
  const { remaining, acknowledged } = reviewChanges(cache, entries);
  await storage.put("drive:cache", { ...cache, unreadChanges: remaining });
  return { ...(await driveView(env, storage)), acknowledged };
}
