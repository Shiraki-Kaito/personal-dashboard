import { InputError } from "./sync.js";
import { isPersonalWork, unreadChanges } from "./drive-review.js";

export const groupStatuses = ["未設定", "進行中", "確認待ち", "要対応", "完了"];
const maximumGroups = 80;
export const maximumImportantFiles = 5;
function importantIds(value = []) {
  if (!Array.isArray(value) || value.length > maximumImportantFiles || new Set(value).size !== value.length || value.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(id)))
    throw new InputError("重要資料は重複なしで最大5件まで選択してください");
  return [...value];
}
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
    return { importantFileIds: importantIds(record.importantFileIds), ...Object.fromEntries(
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
    ) };
  });
  const result = { scope: value.scope, records };
  if (new TextEncoder().encode(JSON.stringify(result)).length > maximumBytes)
    throw new InputError("グループ設定の保存上限64KiBを超えています");
  return result;
}
// 同じルート内で指定4チームの番号だけが変わった場合に、設定を一意に引き継ぐ。
// 旧フォルダも残る場合や候補が複数なら、別グループを勝手に統合しない。
function resolvedGroupRecords(cache, saved) {
  if (!saved || !cache || saved.scope !== cache.scope) return [];
  const paths = [
    ...new Set(
      (cache.files || [])
        .filter((file) => !isPersonalWork(file))
        .map(driveGroupPath),
    ),
  ];
  return saved.records.map((record) => {
    if (paths.includes(record.path)) return record;
    const team = teamForPath(record.path);
    if (
      !team ||
      saved.records.filter(
        (other) =>
          other.path.split(" / ")[0] === record.path.split(" / ")[0] &&
          teamForPath(other.path)?.key === team.key,
      ).length !== 1
    )
      return record;
    const matches = paths.filter(
      (path) =>
        path.split(" / ")[0] === record.path.split(" / ")[0] &&
        teamForPath(path)?.key === team.key,
    );
    if (
      matches.length !== 1 ||
      saved.records.some((other) => other.path === matches[0])
    )
      return record;
    return { ...record, path: matches[0], name: record.name === record.path.split(" / ").at(-1) ? matches[0].split(" / ").at(-1) : record.name };
  });
}
export function groupView(cache, saved) {
  const groups = new Map();
  for (const file of cache?.files || []) {
    if (isPersonalWork(file)) continue;
    const path = driveGroupPath(file);
    if (!groups.has(path)) groups.set(path, []);
    groups.get(path).push(file);
  }
  const records = resolvedGroupRecords(cache, saved);
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
        importantFileIds: record?.importantFileIds || [],
        importantFiles: (record?.importantFileIds || []).map(id => {
          const file = (cache?.files || []).find(file => file.id === id && !isPersonalWork(file));
          return file || {id, name:"取得範囲で参照できない資料", unavailable:true};
        }),
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
    const records = resolvedGroupRecords(cache, previous);
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
    const selectedIds = importantIds(input.importantFileIds ?? old?.importantFileIds);
    if (selectedIds.some(id => !(old?.importantFileIds || []).includes(id) && !cache.files.some(file => file.id === id && !isPersonalWork(file))))
      throw new InputError("重要資料は現在の取得範囲から選択してください（個人作業は対象外）");
    const record = {
      importantFileIds: selectedIds,
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

const homeTeams = [
  { key: "sns", label: "SNS運用" },
  { key: "lp", label: "LP" },
  { key: "community", label: "コミュニティ連携" },
  { key: "design", label: "デザイン" },
];
const homeUpdateLimit = 1;
function teamForPath(path) {
  // フォルダ番号の変更でチームを取り違えない。本人が付けた表示名とは独立させる。
  const name = path
    .split(" / ")
    .at(-1)
    .normalize("NFKC")
    .replace(/^\d+[_\s-]*/, "")
    .toLowerCase();
  return homeTeams.find((team) => team.label.toLowerCase() === name);
}
// ホームは指定の4チームを大きく表示し、他の保存場所は省略せず小さな導線へまとめる。
export function homeDriveGroups(drive) {
  const files = drive.unreadChanges.filter(
    (file) => !file.personal && !isPersonalWork(file),
  );
  const groups = [...(drive.groups || [])].map((group) => ({ ...group }));
  for (const file of files) {
    const path = driveGroupPath(file);
    if (!groups.some((group) => group.path === path))
      groups.push({
        path,
        name: path.split(" / ").at(-1) || "その他",
        color: defaultGroupColor(path),
        recent: [],
        available: false,
      });
  }
  const ordered = groups.sort(
    (a, b) =>
      Number(b.available) - Number(a.available) ||
      a.path.localeCompare(b.path, "ja"),
  );
  const used = new Set();
  const highlighted = homeTeams.map((team) => {
    const matching = ordered.filter(
      (group) => teamForPath(group.path)?.key === team.key,
    );
    matching.forEach((group) => used.add(group.path));
    const primary = matching[0];
    const pending = files
      .filter((file) => teamForPath(driveGroupPath(file))?.key === team.key)
      .sort((a, b) => b.detectedAt - a.detectedAt || a.id.localeCompare(b.id));
    return {
      key: team.key,
      name: primary?.name || team.label,
      path: primary?.path || null,
      color: primary?.color || "slate",
      available: matching.some((group) => group.available),
      importantFiles: primary?.importantFiles || [],
      status: primary?.status || "未設定",
      nextAction: primary?.nextAction || "",
      due: primary?.due || "",
      updatedAt: primary?.updatedAt || null,
      pendingCount: pending.length,
      updates: pending.slice(0, homeUpdateLimit),
      remaining: Math.max(0, pending.length - homeUpdateLimit),
      latest: pending.length ? null : primary?.recent?.[0] || null,
    };
  });
  const others = ordered
    .filter((group) => !used.has(group.path))
    .map((group) => ({
      path: group.path,
      name: group.name,
      color: group.color,
      pendingCount: files.filter((file) => driveGroupPath(file) === group.path)
        .length,
    }));
  return { highlighted, others };
}
