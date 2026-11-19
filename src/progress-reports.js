import { validateProgressBackup } from "./progress-backup.js";
import {
  readReportRecord,
  writeReportRecord,
} from "./progress-record-store.js";
import { InputError } from "./sync.js";
import { minutesReadScope, sheetsReadScope } from "./drive-auth.js";
import {
  meetingKinds,
  validReportDate,
  composeProgressReports,
} from "./progress-evidence.js";
import {
  reportTeams,
  reportSourceCatalog,
  maximumReportSources,
  expandReportSources,
  readProgressSources,
} from "./progress-sources.js";

const indexKey = "drive:progress:index";
const maximumHistory = 24;
const maximumStoredHistory = 96;
const uuid = (value) =>
  typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const safeText = (value, maximum) =>
  typeof value === "string" &&
  value.length <= maximum &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
async function indexView(storage, scope) {
  const index = await storage.get(indexKey);
  if (index && index.scope !== scope)
    throw new InputError(
      "別のDrive接続の報告履歴が残っています。上書きせず停止しました",
    );
  return index || { scope, revision: null, records: [] };
}
export async function progressReportView(storage, scope) {
  const cache = await storage.get("drive:cache"),
    credential = await storage.get("drive:credential"),
    index = await indexView(storage, scope);
  const valid = cache?.scope === scope;
  const savedWeekly = await storage.get("drive:weeklySettings");
  const weekly = savedWeekly?.scope === scope ? savedWeekly : null;
  const sources = valid ? reportSourceCatalog(cache) : [];
  const last = index.records.find((record) => !record.archivedAt);
  const previous = last ? await readReportRecord(storage, last.id) : null;
  return {
    scope,
    teams: valid ? reportTeams(cache) : [],
    sources,
    folders: [...new Set(sources.map((file) => file.folder))].sort(),
    history: index.records.filter((record) => !record.archivedAt),
    archivedHistory: index.records.filter((record) => record.archivedAt),
    maximumHistory,
    maximumSources: maximumReportSources,
    lastDriveSuccess: valid ? cache.lastSuccess : null,
    driveWarning:
      !valid ||
      cache.error ||
      !cache.lastSuccess ||
      Date.now() - Date.parse(cache.lastSuccess) > 90 * 60000
        ? "Driveの一覧は未取得・保存情報・古い情報の可能性があります。取得範囲を確認してください"
        : null,
    authorized: {
      docs: !!credential?.scopes?.includes(minutesReadScope),
      sheets: !!credential?.scopes?.includes(sheetsReadScope),
    },
    defaults: {
      reporter: "白木海斗",
      aliases: weekly?.ownerName ? [weekly.ownerName] : [],
      sources: weekly?.minutesId
        ? [{ id: weekly.minutesId, role: "personal" }]
        : sources
            .filter((source) => source.recommended)
            .slice(0, 6)
            .map((source) => ({ id: source.id, role: source.suggestedRole })),
      ...previous?.request,
    },
  };
}
export async function loadProgressReport(storage, scope, id) {
  if (!uuid(id)) throw new InputError("報告の識別子が不正です");
  const index = await indexView(storage, scope);
  if (!index.records.some((record) => record.id === id))
    throw new InputError("報告が見つかりません");
  const record = await readReportRecord(storage, id);
  if (!record || record.scope !== scope)
    throw new InputError("報告の保存状態を確認できません");
  return record;
}
function validateRequest(input, catalog) {
  const request = {
    kind: input.kind,
    reportDate: input.reportDate,
    startDate: input.startDate || null,
    endDate: input.endDate || input.reportDate,
    reporter: input.reporter,
    aliases: input.aliases || [],
    teams: input.teams,
    sources: input.sources,
    folders: input.folders || [],
  };
  if (
    !meetingKinds.includes(request.kind) ||
    !validReportDate(request.reportDate) ||
    (request.startDate && !validReportDate(request.startDate)) ||
    !validReportDate(request.endDate) ||
    !safeText(request.reporter, 40) ||
    !request.reporter.trim() ||
    !Array.isArray(request.aliases) ||
    request.aliases.length > 5 ||
    request.aliases.some((alias) => !safeText(alias, 40) || !alias.trim()) ||
    !Array.isArray(request.teams) ||
    !request.teams.length ||
    request.teams.length > 12 ||
    new Set(request.teams).size !== request.teams.length ||
    request.teams.some((path) => !catalog.some((team) => team.path === path)) ||
    !Array.isArray(request.sources) ||
    request.sources.length > maximumReportSources ||
    request.sources.some(
      (source) => !source || typeof source.id !== "string",
    ) ||
    !Array.isArray(request.folders) ||
    request.folders.length > 12 ||
    request.folders.some((folder) => !safeText(folder, 1000))
  )
    throw new InputError(
      "定例・日付・チーム・報告者・参照範囲を確認してください",
    );
  return request;
}
function recordMetadata(record) {
  return {
    id: record.id,
    kind: record.request.kind,
    reportDate: record.request.reportDate,
    teams: record.results.map((result) => result.team.name),
    status: record.status,
    generatedAt: record.generatedAt,
    updatedAt: record.updatedAt,
    revision: record.revision,
    archivedAt: record.archivedAt || null,
  };
}
export async function generateProgressReport(
  env,
  storage,
  scope,
  input,
  send = fetch,
) {
  if (!uuid(input.id))
    throw new InputError("作成操作の識別子を再取得してください");
  const view = await progressReportView(storage, scope),
    request = validateRequest(input, view.teams),
    index = await indexView(storage, scope);
  if (input.scope !== scope)
    throw new InputError("Driveの対象範囲が変わっています");
  const existing = await readReportRecord(storage, input.id);
  if (existing) {
    if (
      existing.scope !== scope ||
      JSON.stringify(existing.request) !== JSON.stringify(request)
    )
      throw new InputError("同じ操作IDで別の報告は作成できません");
    return existing;
  }
  if (index.records.length >= maximumStoredHistory)
    throw new InputError(
      "アーカイブを含む履歴96件の上限です。バックアップで保存内容を確認してください",
    );
  if (
    index.records.filter((record) => !record.archivedAt).length >=
    maximumHistory
  )
    throw new InputError(
      "通常の生成履歴24件の上限です。履歴をアーカイブして枠を空けてください",
    );
  const selected = expandReportSources(view.sources, request);
  const cache = await storage.get("drive:cache");
  const sources = await readProgressSources(
    env,
    storage,
    selected,
    [request.reporter, ...request.aliases],
    send,
  );
  // 下書きや根拠の全文は前回比較に不要。大きな履歴を並列展開しない。
  const history = [];
  for (const entry of index.records) {
    if (entry.status !== "final" || entry.kind !== request.kind ||
        entry.reportDate >= request.reportDate) continue;
    const previous = await readReportRecord(storage, entry.id);
    if (!previous || previous.revision !== entry.revision)
      throw new InputError("比較元の保存版を確認できません。履歴を再取得してください");
    if (request.kind === "personal" && previous.request.reporter !== request.reporter) continue;
    history.push({
      id: previous.id, status: previous.status, request: previous.request,
      results: previous.results.map(result => ({
        team: result.team, text: result.text,
        items: result.items.map(({ references, ...item }) => item),
      })),
    });
  }
  const result = composeProgressReports({
    request,
    sources,
    teams: view.teams.filter((team) => request.teams.includes(team.path)),
    previous: history.filter(Boolean),
  });
  const checks = [
    {
      message: `選択した${selected.length}資料だけを読み取ります。Drive一覧の候補${view.sources.length}資料。選択外の資料本文は読みません。`,
    },
    ...(view.driveWarning ? [{ message: view.driveWarning }] : []),
    ...sources.flatMap((source) => source.checks),
    ...(result.period.provisional
      ? [
          {
            message:
              "前回の同じ定例日を確認できず、直近7日間を仮設定しました。対象期間を確認してください",
          },
        ]
      : []),
  ];
  for (const source of sources)
    if (
      sources.some(
        (other) => other.id !== source.id && other.name === source.name,
      )
    )
      checks.push({
        sourceId: source.id,
        message:
          "同名資料があります。保存場所・内容・更新日時を根拠で比較し、現行版を確認してください",
      });
  const generatedAt = new Date().toISOString();
  const record = {
    id: input.id,
    scope,
    request,
    period: result.period,
    results: result.results,
    sources: sources.map(({ facts, ...source }) => source),
    checks,
    status: "draft",
    revision: crypto.randomUUID(),
    generatedAt,
    updatedAt: generatedAt,
    finalizedAt: null,
    edited: false,
  };
  return storage.transaction(async (tx) => {
    if (
      (await indexView(tx, scope)).revision !== index.revision ||
      (await tx.get("drive:cache"))?.lastSuccess !== cache?.lastSuccess
    )
      throw new InputError(
        "作成中に履歴またはDrive一覧が変わりました。再取得してください",
      );
    await writeReportRecord(tx, record);
    await tx.put(indexKey, {
      scope,
      revision: crypto.randomUUID(),
      records: [recordMetadata(record), ...index.records],
    });
    return record;
  });
}
export async function saveProgressReport(storage, scope, input) {
  if (
    input.scope !== scope ||
    !uuid(input.id) ||
    !uuid(input.expectedRevision) ||
    !["draft", "final"].includes(input.status) ||
    !Array.isArray(input.texts) ||
    input.texts.some((text) => !safeText(text, 6000)) ||
    (input.status === "final" && input.confirmUsed !== true)
  )
    throw new InputError("保存内容・確認・保存版が不正です");
  return storage.transaction(async (tx) => {
    const index = await indexView(tx, scope),
      record = await loadProgressReport(tx, scope, input.id);
    if (record.revision !== input.expectedRevision)
      throw new InputError(
        "別の画面で報告が変更されました。編集を保持して停止しました。履歴から再取得してください",
      );
    if (record.status === "final")
      throw new InputError(
        "使用済み確定版は変更できません。新しい下書きを作成してください",
      );
    if (input.texts.length !== record.results.length)
      throw new InputError("対象チームが一致しません");
    const updatedAt = new Date().toISOString();
    const saved = {
      ...record,
      results: record.results.map((result, index) => ({
        ...result,
        text: input.texts[index],
      })),
      edited:
        record.edited ||
        record.results.some(
          (result, index) => result.text !== input.texts[index],
        ),
      status: input.status,
      revision: crypto.randomUUID(),
      updatedAt,
      finalizedAt: input.status === "final" ? updatedAt : null,
    };
    await writeReportRecord(tx, saved);
    await tx.put(indexKey, {
      scope,
      revision: crypto.randomUUID(),
      records: index.records.map((item) =>
        item.id === saved.id ? recordMetadata(saved) : item,
      ),
    });
    return saved;
  });
}

// 一覧と本文を同じ保存時点で読み、欠けた履歴を正常なバックアップにしない。
export async function exportProgressReports(storage, scope, selectedId = null) {
  if (selectedId !== null && !uuid(selectedId))
    throw new InputError("バックアップ対象が不正です");
  return storage.transaction(async (tx) => {
    const index = await indexView(tx, scope);
    const entries = selectedId === null ? index.records : index.records.filter(entry => entry.id === selectedId);
    if (selectedId !== null && entries.length !== 1)
      throw new InputError("バックアップ対象が見つかりません");
    const records = [];
    // 全件をメモリへ積む前に上限を確認する。大きな履歴は1件ずつ取り出せる。
    let encodedBytes = 1024;
    for (const entry of entries) {
      const record = await loadProgressReport(tx, scope, entry.id);
      if (record.revision !== entry.revision)
        throw new InputError(
          "報告の履歴と保存版が一致しません。バックアップを停止しました",
        );
      encodedBytes += new TextEncoder().encode(JSON.stringify(record)).length + 1;
      if (encodedBytes > 16 * 1024 * 1024)
        throw new InputError("一括バックアップの上限16MiBです。表示中の報告を1件ずつバックアップしてください");
      records.push(record);
    }
    const backup = {
      format: "personal-dashboard-progress",
      version: 1,
      scope,
      exportedAt: new Date().toISOString(),
      records,
    };
    if (
      new TextEncoder().encode(JSON.stringify(backup)).length >
      16 * 1024 * 1024
    )
      throw new InputError("報告バックアップの上限16MiBを超えています");
    return backup;
  });
}

export async function archiveProgressReport(storage, scope, input) {
  if (
    input.scope !== scope ||
    !uuid(input.id) ||
    !uuid(input.expectedRevision) ||
    typeof input.archived !== "boolean"
  )
    throw new InputError("整理対象と保存版を確認してください");
  return storage.transaction(async (tx) => {
    const index = await indexView(tx, scope);
    const record = await loadProgressReport(tx, scope, input.id);
    if (record.revision !== input.expectedRevision)
      throw new InputError("報告が変更されています。履歴を再取得してください");
    if (!!record.archivedAt === input.archived) return record;
    if (
      !input.archived &&
      index.records.filter((item) => !item.archivedAt).length >= maximumHistory
    )
      throw new InputError(
        "通常の履歴24件の上限です。先に別の報告をアーカイブしてください",
      );
    const updated = {
      ...record,
      archivedAt: input.archived ? new Date().toISOString() : null,
      revision: crypto.randomUUID(),
    };
    await writeReportRecord(tx, updated);
    await tx.put(indexKey, {
      ...index,
      revision: crypto.randomUUID(),
      records: index.records.map((item) =>
        item.id === updated.id ? recordMetadata(updated) : item,
      ),
    });
    return updated;
  });
}

async function progressBackupDigest(backup) {
  const bytes = new TextEncoder().encode(JSON.stringify(backup));
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}
export async function previewProgressRestore(storage, scope, backup) {
  const records = validateProgressBackup(backup, scope);
  const index = await indexView(storage, scope);
  const conflicts = records
    .filter((record) => index.records.some((entry) => entry.id === record.id))
    .map((record) => record.id);
  const active = records.filter((record) => !record.archivedAt).length;
  return {
    checksum: await progressBackupDigest(backup),
    expectedRevision: index.revision,
    records: records.length,
    active,
    archived: records.length - active,
    conflicts,
    capacityExceeded:
      index.records.length + records.length > maximumStoredHistory ||
      index.records.filter((record) => !record.archivedAt).length + active >
        maximumHistory,
  };
}
export async function restoreProgressReports(storage, scope, input) {
  const records = validateProgressBackup(input.backup, scope);
  if (
    input.confirm !== true ||
    input.checksum !== (await progressBackupDigest(input.backup))
  )
    throw new InputError("復元する内容を再確認してください");
  return storage.transaction(async (tx) => {
    const plan = await previewProgressRestore(tx, scope, input.backup);
    if (plan.expectedRevision !== input.expectedRevision)
      throw new InputError(
        "確認後に履歴が変わりました。復元内容を再確認してください",
      );
    if (plan.conflicts.length || plan.capacityExceeded)
      throw new InputError(
        "既存の報告との重複、または履歴上限のため復元できません",
      );
    const index = await indexView(tx, scope);
    const restored = [];
    for (const record of records) {
      if (await readReportRecord(tx, record.id))
        throw new InputError(
          "保存済みの報告が存在します。上書きせず停止しました",
        );
      const updated = { ...record, revision: crypto.randomUUID() };
      await writeReportRecord(tx, updated);
      restored.push(recordMetadata(updated));
    }
    await tx.put(indexKey, {
      scope,
      revision: crypto.randomUUID(),
      records: [...restored, ...index.records],
    });
    return { restored: restored.length };
  });
}
