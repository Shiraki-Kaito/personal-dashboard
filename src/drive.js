import { driveClient, DriveError } from "./drive-http.js";
import { driveToken } from "./drive-auth.js";

export const recentWindowMs = 12 * 60 * 60 * 1000;
const minimumRefreshMs = 5 * 60 * 1000;
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

export async function scanDrive(config, read) {
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
  const folders = [{ id: root.id, path: root.name }];
  const seenFolders = new Set([root.id]),
    files = new Map();
  for (let index = 0; index < folders.length; index++) {
    const folder = folders[index],
      cursors = new Set(),
      folderFiles = new Set();
    let cursor = "";
    do {
      const parameters = {
        q: "'" + folder.id + "' in parents and trashed = false",
        fields:
          "nextPageToken,incompleteSearch,files(id,name,mimeType,createdTime,modifiedTime,parents)",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        corpora: root.driveId ? "drive" : "user",
      };
      if (root.driveId) parameters.driveId = root.driveId;
      if (cursor) parameters.pageToken = cursor;
      const page = await read("files", parameters);
      if (page.incompleteSearch || !Array.isArray(page.files))
        throw new DriveError("Driveの検索結果が未完了です", "incomplete");
      for (const file of page.files) {
        if (
          !file.id ||
          !/^[a-zA-Z0-9_-]+$/.test(file.id) ||
          !file.parents?.includes(folder.id) ||
          folderFiles.has(file.id)
        )
          throw new DriveError(
            "Drive一覧の取得に不整合がありました",
            "incomplete",
          );
        folderFiles.add(file.id);
        if (file.mimeType === folderType) {
          if (config.includeSubfolders && !seenFolders.has(file.id)) {
            seenFolders.add(file.id);
            folders.push({
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
      cursor = page.nextPageToken || "";
      if (cursor && cursors.has(cursor))
        throw new DriveError(
          "ページ取得が繰り返されたため停止しました",
          "incomplete",
        );
      cursors.add(cursor);
    } while (cursor);
  }
  return {
    files: [...files.values()],
    folderName: root.name,
    folderCount: folders.length,
  };
}

export function recentFiles(files, now) {
  const cutoff = now - recentWindowMs;
  return files
    .map((file) => {
      const created = Date.parse(file.createdTime),
        modified = Date.parse(file.modifiedTime);
      const observed = file.observedAddedAt || 0;
      const events = [
        { time: created, label: "作成" },
        { time: modified, label: "更新" },
        { time: observed, label: "追加を検知" },
      ].filter(
        (event) => event.time >= cutoff && event.time <= now && event.time > 0,
      );
      if (!events.length) return null;
      const eventTime = Math.max(...events.map((event) => event.time));
      return { ...file, eventTime, events: events.map((event) => event.label) };
    })
    .filter(Boolean)
    .sort((a, b) => b.eventTime - a.eventTime || a.id.localeCompare(b.id));
}
export async function driveView(env, storage, now = Date.now()) {
  const config = driveConfig(env);
  const credential = await storage.get("drive:credential");
  let cache = await storage.get("drive:cache");
  if (!config || cache?.scope !== configKey(config)) cache = null;
  return {
    configured:
      !!config && !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET,
    connected: !!credential && !credential.invalid,
    folderId: config?.folderId || null,
    includeSubfolders: config?.includeSubfolders ?? null,
    folderName: cache?.folderName || config?.label || null,
    inventoryCount: cache?.files.length ?? null,
    folderCount: cache?.folderCount ?? null,
    files: recentFiles(cache?.files || [], now),
    lastAttempt: cache?.lastAttempt || null,
    lastSuccess: cache?.lastSuccess || null,
    error: cache?.error || null,
    retryAt: cache?.retryAt || null,
    initialHistoryIncomplete:
      !cache?.baselineAt || now - cache.baselineAt < recentWindowMs,
    windowStart: new Date(now - recentWindowMs).toISOString(),
  };
}
export async function refreshDrive(
  env,
  storage,
  send = fetch,
  now = Date.now(),
) {
  const config = driveConfig(env);
  if (!config || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
    return driveView(env, storage, now);
  let cache = await storage.get("drive:cache");
  if (cache?.scope !== configKey(config))
    cache = {
      scope: configKey(config),
      files: [],
      baselineAt: null,
      lastAttempt: null,
      lastSuccess: null,
    };
  if (cache.retryAt > now) return driveView(env, storage, now);
  cache.lastAttempt = new Date(now).toISOString();
  cache.retryAt = now + minimumRefreshMs;
  await storage.put("drive:cache", cache);
  try {
    const token = await driveToken(env, storage, send);
    const result = await scanDrive(config, driveClient(token, send));
    const before = new Map(cache.files.map((file) => [file.id, file]));
    const files = result.files.map((file) => ({
      ...file,
      observedAddedAt:
        before.get(file.id)?.observedAddedAt ||
        (cache.baselineAt && !before.has(file.id) ? now : null),
    }));
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
      lastSuccess: new Date(now).toISOString(),
      error: null,
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
  await storage.put("drive:cache", cache);
  return driveView(env, storage, now);
}
