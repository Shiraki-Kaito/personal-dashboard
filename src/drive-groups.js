import { InputError } from "./sync.js";
import { isPersonalWork, unreadChanges } from "./drive-review.js";

export const groupStatuses = ["未設定", "進行中", "確認待ち", "要対応", "完了"];
const maximumGroups = 80;
export const groupColors = [
  "teal",
  "blue",
  "violet",
  "amber",
  "rose",
  "green",
  "slate",
];
export function defaultGroupColor(path) {
  let hash = 0;
  for (const char of path) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return groupColors[hash % groupColors.length];
}
const maximumBytes = 64 * 1024;

// 取得済みの保存場所からグループを分ける。更新量を業務の完了率には変換しない。
export function driveGroupPath(file) {
  const parts = (file.folder || "").split(" / ");
  return parts.slice(0, Math.min(parts.length, 2)).join(" / ");
}
export function normalizeGroupStore(value) {
  if (
    !value ||
    typeof value.scope !== "string" ||
    !Array.isArray(value.records) ||
    value.records.length > maximumGroups
  )
    throw new InputError("グループ設定の形式が不正です");
  const seen = new Set();
  const records = value.records.map((record) => {
    if (
      !record ||
      typeof record.path !== "string" ||
      !record.path ||
      record.path.length > 1000 ||
      seen.has(record.path) ||
      typeof record.name !== "string" ||
      record.name.length > 80 ||
      !groupStatuses.includes(record.status) ||
      typeof record.nextAction !== "string" ||
      record.nextAction.length > 500 ||
      typeof record.due !== "string" ||
      (record.due &&
        (!/^\d{4}-\d\d-\d\d$/.test(record.due) ||
          !Number.isFinite(Date.parse(record.due)) ||
          new Date(record.due).toISOString().slice(0, 10) !== record.due)) ||
      !groupColors.includes(record.color) ||
      typeof record.revision !== "string" ||
      !/^[a-f0-9-]{36}$/.test(record.revision) ||
      !Number.isFinite(Date.parse(record.updatedAt))
    )
      throw new InputError("グループ設定の入力値が不正です");
    seen.add(record.path);
    return Object.fromEntries(
      [
        "path",
        "name",
        "status",
        "nextAction",
        "due",
        "color",
        "revision",
        "updatedAt",
      ].map((key) => [key, record[key]]),
    );
  });
  const result = { scope: value.scope, records };
  if (new TextEncoder().encode(JSON.stringify(result)).length > maximumBytes)
    throw new InputError("グループ設定の保存上限64KiBを超えています");
  return result;
}
export function groupView(cache, saved) {
  const groups = new Map();
  for (const file of cache?.files || []) {
    if (isPersonalWork(file)) continue;
    const path = driveGroupPath(file);
    if (!groups.has(path)) groups.set(path, []);
    groups.get(path).push(file);
  }
  const records =
    saved && cache && saved.scope === cache.scope ? saved.records : [];
  // 対象外になったグループも手動の進捗記録を黙って失わない。
  for (const record of records || [])
    if (!groups.has(record.path)) groups.set(record.path, []);
  const changes = unreadChanges(cache).filter((file) => !isPersonalWork(file));
  return [...groups]
    .map(([path, files]) => {
      const record = records?.find((record) => record.path === path);
      const sorted = [...files].sort(
        (a, b) =>
          Date.parse(b.modifiedTime) - Date.parse(a.modifiedTime) ||
          a.id.localeCompare(b.id),
      );
      return {
        path,
        name: record?.name || path.split(" / ").at(-1),
        status: record?.status || "未設定",
        nextAction: record?.nextAction || "",
        due: record?.due || "",
        revision: record?.revision || null,
        updatedAt: record?.updatedAt || null,
        color: record?.color || defaultGroupColor(path),
        recent: sorted.slice(0, 3),
        unread: changes.filter((file) => driveGroupPath(file) === path).length,
        available: files.length > 0,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path, "ja"));
}
export async function saveDriveGroup(storage, input) {
  return storage.transaction(async (tx) => {
    const cache = await tx.get("drive:cache");
    if (!cache?.scope || cache.scope !== input.scope)
      throw new InputError("Driveの接続範囲が変わりました。再読込してください");
    const previous = await tx.get("drive:groups");
    if (previous && previous.scope !== cache.scope)
      throw new InputError("別の接続範囲のグループ設定が残っています");
    const records = previous?.records || [];
    const old = records.find((record) => record.path === input.path);
    if ((old?.revision || null) !== input.expectedRevision)
      throw new InputError(
        "別の画面でグループ設定が変更されました。再読込して確認してください",
      );
    const files = cache.files.filter(
      (file) => !isPersonalWork(file) && driveGroupPath(file) === input.path,
    );
    if (!old && !files.length)
      throw new InputError("取得済みのグループを選択してください");
    const record = {
      path: input.path,
      name: input.name,
      status: input.status,
      nextAction: input.nextAction,
      due: input.due,
      color: input.color,
      revision: crypto.randomUUID(),
      updatedAt: new Date().toISOString(),
    };
    const store = normalizeGroupStore({
      scope: cache.scope,
      records: [
        ...records.filter((value) => value.path !== record.path),
        record,
      ],
    });
    await tx.put("drive:groups", store);
    return record;
  });
}
