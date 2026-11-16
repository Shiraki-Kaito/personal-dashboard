import { normalizeGroupStore } from "./drive-groups.js";
import { normalizeGroupDisplay } from "./drive-group-display.js";
import { normalizeMeetingStore } from "./drive-meetings.js";
import { normalizeWeeklySettings } from "./weekly-drive.js";
import { projectsFrom } from "./catalog.js";
import { ownerId } from "./github.js";
import { driveConfig } from "./drive.js";
import { InputError } from "./sync.js";
import { unreadChanges } from "./drive-review.js";
import { createAgendaBackup, agendaRestoreEntries } from "./agenda-backup.js";

const maximumBackupBytes = 8 * 1024 * 1024;
const pick = (value, keys) =>
  Object.fromEntries(
    keys
      .filter((key) => value?.[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
const remoteKeys = ["title", "url", "revision", "status", "due", "total"];
const fileKeys = [
  "id",
  "name",
  "mimeType",
  "createdTime",
  "modifiedTime",
  "lastModifiedBy",
  "folder",
];
const changeKeys = [
  ...fileKeys,
  "events",
  "changeId",
  "detectedAt",
  "firstDetectedAt",
  "occurrences",
];
function scope(env) {
  const drive = driveConfig(env);
  return {
    projects: projectsFrom(env.PROJECT_CONFIG).map((project) =>
      pick(project, ["project", "status_field", "due_field"]),
    ),
    drive: drive ? drive.folderId + ":" + drive.includeSubfolders : null,
  };
}
function pendingTask(projectId, itemId, state) {
  return {
    projectId,
    itemId,
    remote: pick(state.remote, remoteKeys),
    pending: {
      ...pick(state.pending, ["id", "field", "value"]),
      base: pick(state.pending.base, remoteKeys),
    },
    lastSuccess: state.lastSuccess || null,
  };
}
// 認証・セッション・環境Secretsを読み出さず、復旧に必要なアプリデータだけを選ぶ。
export async function createBackup(env, storage) {
  const target = scope(env),
    tasks = [];
  for (const project of projectsFrom(env.PROJECT_CONFIG)) {
    const prefix = "task:" + project.project + ":";
    const states = await storage.list({ prefix });
    if (project.item && !states.has(prefix + project.item)) {
      const legacy = await storage.get("sync");
      if (legacy) states.set(prefix + project.item, legacy);
    }
    for (const [key, state] of states)
      if (state.pending)
        tasks.push(
          pendingTask(project.project, key.slice(prefix.length), state),
        );
  }
  const cache = await storage.get("drive:cache");
  const drive =
    cache?.scope === target.drive
      ? {
          ...pick(cache, [
            "scope",
            "folderName",
            "folderCount",
            "baselineAt",
            "lastSuccess",
            "viewVersion",
          ]),
          files: cache.files.map((file) => pick(file, fileKeys)),
          unreadChanges: unreadChanges(cache).map((file) =>
            pick(file, changeKeys),
          ),
        }
      : null;
  const backup = {
    version: 2,
    ownerId,
    createdAt: new Date().toISOString(),
    scope: target,
    tasks,
    drive,
    driveGroups: (await storage.get("drive:groups"))?.scope === target.drive ? normalizeGroupStore(await storage.get("drive:groups")) : null,
    driveGroupDisplay:(await storage.get("drive:groupDisplay"))?.scope===target.drive ? normalizeGroupDisplay(await storage.get("drive:groupDisplay")) : null,
    driveMeetings: (await storage.get("drive:meetingReports"))?.scope === target.drive ? normalizeMeetingStore(await storage.get("drive:meetingReports")) : null,
    weeklySettings:(await storage.get("drive:weeklySettings"))?.scope===target.drive ? normalizeWeeklySettings(await storage.get("drive:weeklySettings")) : null,
    agenda: await createAgendaBackup(storage),
  };
  checkSize(backup);
  return backup;
}
function checkSize(value) {
  if (
    new TextEncoder().encode(JSON.stringify(value)).length > maximumBackupBytes
  )
    throw new InputError("バックアップの上限8MiBを超えています");
}
const validDate = (value) =>
  value === null ||
  (typeof value === "string" &&
    /^\d{4}-\d\d-\d\d$/.test(value) &&
    Number.isFinite(Date.parse(value + "T00:00:00Z")) &&
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value);
function validRemote(remote) {
  return (
    remote &&
    typeof remote.revision === "string" &&
    (remote.status === null || typeof remote.status === "string") &&
    validDate(remote.due)
  );
}
async function restoreEntries(env, storage, backup) {
  checkSize(backup);
  if (
    ![1, 2].includes(backup?.version) ||
    backup.ownerId !== ownerId ||
    JSON.stringify(backup.scope) !== JSON.stringify(scope(env)) ||
    !Array.isArray(backup.tasks)
  )
    throw new InputError("本人・接続先・形式が一致しないバックアップです");
  const entries = new Map();
  for (const task of backup.tasks) {
    if (
      !task ||
      typeof task !== "object" ||
      !backup.scope.projects.some(
        (project) => project.project === task.projectId,
      ) ||
      typeof task.itemId !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(task.itemId) ||
      !validRemote(task.remote) ||
      !validRemote(task.pending?.base) ||
      typeof task.pending.id !== "string" ||
      !["status", "due"].includes(task.pending.field) ||
      !(task.pending.field === "due"
        ? validDate(task.pending.value)
        : task.pending.value === null || typeof task.pending.value === "string")
    )
      throw new InputError("未同期操作の形式が不正です");
    const key = "task:" + task.projectId + ":" + task.itemId;
    if (entries.has(key)) throw new InputError("重複した未同期操作があります");
    const safe = pendingTask(task.projectId, task.itemId, task);
    entries.set(key, {
      remote: safe.remote,
      pending: safe.pending,
      lastSuccess: safe.lastSuccess,
      lastAttempt: null,
      phase: "バックアップから復元・再照合待ち",
      error: "復元した情報です。GitHubから再取得してください",
    });
  }
  if (backup.drive) {
    const value = backup.drive;
    if (
      !backup.scope.drive ||
      value.scope !== backup.scope.drive ||
      !Array.isArray(value.files) ||
      !Array.isArray(value.unreadChanges) ||
      value.files.length > 10000 ||
      value.unreadChanges.length > 10000 ||
      new TextEncoder().encode(JSON.stringify(value)).length > 6 * 1024 * 1024
    )
      throw new InputError("Driveバックアップの形式が不正です");
    for (const file of [...value.files, ...value.unreadChanges])
      if (
        !file ||
        typeof file !== "object" ||
        typeof file.id !== "string" ||
        !/^[A-Za-z0-9_-]+$/.test(file.id) ||
        typeof file.name !== "string" ||
        typeof file.mimeType !== "string" ||
        typeof file.folder !== "string" ||
        !Number.isFinite(Date.parse(file.modifiedTime)) ||
        !Number.isFinite(Date.parse(file.createdTime)) ||
        (file.lastModifiedBy !== undefined && file.lastModifiedBy !== null &&
          (typeof file.lastModifiedBy !== "string" || file.lastModifiedBy.length > 200))
      )
        throw new InputError("Driveのファイル情報が不正です");
    for (const change of value.unreadChanges)
      if (
        typeof change.changeId !== "string" ||
        !Number.isFinite(change.detectedAt) ||
        !Array.isArray(change.events) ||
        !change.events.every((event) => typeof event === "string")
      )
        throw new InputError("未確認変更の形式が不正です");
    entries.set("drive:cache", {
      ...pick(value, [
        "scope",
        "folderName",
        "folderCount",
        "baselineAt",
        "lastSuccess",
        "viewVersion",
      ]),
      files: value.files.map((file) => pick(file, fileKeys)),
      unreadChanges: value.unreadChanges.map((file) => pick(file, changeKeys)),
      error: "バックアップから復元・再取得待ち",
      errorCode: "restored",
      retryAt: null,
    });
  }
  if (backup.driveGroups) {
    const groups = normalizeGroupStore(backup.driveGroups);
    if (groups.scope !== backup.scope.drive) throw new InputError("グループ設定の接続範囲が一致しません");
    entries.set("drive:groups", { ...groups, records: groups.records.map(record=>({...record,revision:crypto.randomUUID()})) });
  }
  if (backup.driveMeetings) {
    const meetings=normalizeMeetingStore(backup.driveMeetings);
    if(meetings.scope!==backup.scope.drive) throw new InputError("会議記録の接続範囲が一致しません");
    entries.set("drive:meetingReports",{...meetings,records:meetings.records.map(record=>({...record,revision:crypto.randomUUID()}))});
  }
  if(backup.weeklySettings){const settings=normalizeWeeklySettings(backup.weeklySettings);if(settings.scope!==backup.scope.drive)throw new InputError("週報の参照設定の接続範囲が一致しません");entries.set("drive:weeklySettings",{...settings,revision:crypto.randomUUID()});}
  if(backup.driveGroupDisplay){const display=normalizeGroupDisplay(backup.driveGroupDisplay);if(display.scope!==backup.scope.drive)throw new InputError("表示設定の接続範囲が一致しません");entries.set("drive:groupDisplay",{...display,revision:crypto.randomUUID()});}
  const agenda =
    backup.version === 2
      ? await agendaRestoreEntries(storage, backup.agenda)
      : { entries: new Map(), conflicts: [] };
  for (const [key, value] of agenda.entries) entries.set(key, value);
  return { entries, conflicts: agenda.conflicts };
}
export async function backupPlan(env, storage, backup) {
  const { entries, conflicts } = await restoreEntries(env, storage, backup);
  for (const key of entries.keys())
    if ((await storage.get(key)) !== undefined) conflicts.push(key);
  for (const project of projectsFrom(env.PROJECT_CONFIG))
    if (
      project.item &&
      entries.has("task:" + project.project + ":" + project.item) &&
      (await storage.get("sync")) !== undefined
    )
      conflicts.push("sync");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(backup)),
  );
  return {
    tasks: backup.tasks.length,
    driveFiles: backup.drive?.files.length || 0,
    meetingReports: backup.driveMeetings?.records.length || 0,
    agendaAccounts: backup.agenda?.length || 0,
    agendaMessages: (backup.agenda || []).reduce(
      (n, a) => n + (a.cache?.messages.length || 0),
      0,
    ),
    splitMessages: (backup.agenda || []).reduce((count,item)=>count+Object.keys(item.caseSplits?.assignments || {}).length,0),
    agendaCases: (backup.agenda || []).reduce((count, item) => count + Object.keys(item.cases || {}).length, 0),
    agendaOperations: (backup.agenda || []).reduce(
      (n, a) => n + a.operations.length,
      0,
    ),
    entries: entries.size,
    conflicts,
    checksum: [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join(""),
  };
}
export async function restoreBackup(env, storage, backup, checksum) {
  return storage.transaction(async (tx) => {
    const plan = await backupPlan(env, tx, backup);
    if (plan.conflicts.length || checksum !== plan.checksum)
      throw new InputError(
        "保存済みデータがあるか、確認したバックアップが変わっています。復元を停止しました",
      );
    for (const [key, value] of (await restoreEntries(env, tx, backup)).entries)
      await tx.put(key, value);
    return { restored: plan.entries };
  });
}
