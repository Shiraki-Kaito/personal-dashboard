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

const indexKey = "drive:progress:index",
  prefix = "drive:progress:record:";
const maximumHistory = 24,
  maximumRecordBytes = 120 * 1024;
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
  const last = index.records[0];
  const previous = last ? await storage.get(prefix + last.id) : null;
  return {
    scope,
    teams: valid ? reportTeams(cache) : [],
    sources,
    folders: [...new Set(sources.map((file) => file.folder))].sort(),
    history: index.records,
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
  const record = await storage.get(prefix + id);
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
  };
}
function assertSize(record) {
  if (
    new TextEncoder().encode(JSON.stringify(record)).length > maximumRecordBytes
  )
    throw new InputError(
      "報告の保存上限120KiBを超えました。資料・期間を絞ってください。前の履歴は保持しています",
    );
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
  const existing = await storage.get(prefix + input.id);
  if (existing) {
    if (
      existing.scope !== scope ||
      JSON.stringify(existing.request) !== JSON.stringify(request)
    )
      throw new InputError("同じ操作IDで別の報告は作成できません");
    return existing;
  }
  if (index.records.length >= maximumHistory)
    throw new InputError(
      "生成履歴24件の保存上限です。既存の確定版を勝手に削除せず停止しました",
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
  const history = await Promise.all(
    index.records.map((record) => storage.get(prefix + record.id)),
  );
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
  assertSize(record);
  return storage.transaction(async (tx) => {
    if (
      (await indexView(tx, scope)).revision !== index.revision ||
      (await tx.get("drive:cache"))?.lastSuccess !== cache?.lastSuccess
    )
      throw new InputError(
        "作成中に履歴またはDrive一覧が変わりました。再取得してください",
      );
    await tx.put(prefix + record.id, record);
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
    assertSize(saved);
    await tx.put(prefix + saved.id, saved);
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
