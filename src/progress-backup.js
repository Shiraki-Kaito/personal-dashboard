import { validReportDate } from "./progress-evidence.js";
import { InputError } from "./sync.js";
import { maximumReportBytes } from "./progress-record-store.js";
export const maximumProgressBackupBytes = 16 * 1024 * 1024;
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string";
const timestamp = (value) => text(value) && Number.isFinite(Date.parse(value));

const sourceId = (value) => text(value) && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const period = (value) =>
  object(value) &&
  validReportDate(value.startDate) &&
  validReportDate(value.endDate) &&
  value.startDate <= value.endDate;
const checks = (value) =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      object(item) &&
      text(item.message) &&
      (!item.sourceId || sourceId(item.sourceId)),
  );
function assertDetails(record) {
  const request = record.request;
  if (
    !validReportDate(request.reportDate) ||
    !period(record.period) ||
    record.period.endDate > request.reportDate ||
    !Array.isArray(request.aliases) ||
    !request.aliases.every(text) ||
    !Array.isArray(request.folders) ||
    !request.folders.every(text) ||
    !checks(record.checks)
  )
    throw new InputError("報告の日付・設定・確認事項が不正です");
  const sources = new Set();
  for (const source of record.sources) {
    if (
      !object(source) ||
      !sourceId(source.id) ||
      sources.has(source.id) ||
      !text(source.name) ||
      !text(source.folder) ||
      !text(source.mimeType) ||
      !["read", "unread"].includes(source.status) ||
      !checks(source.checks) ||
      !Array.isArray(source.dates) ||
      !source.dates.every(validReportDate)
    )
      throw new InputError("報告の参照資料が不正です");
    sources.add(source.id);
  }
  for (const result of record.results) {
    if (
      !period(result.period) ||
      !checks(result.checks) ||
      !text(result.baseline.kind) ||
      !object(result.comparison) ||
      !Array.isArray(result.comparison.previousOnly) ||
      !result.comparison.previousOnly.every(text) ||
      !request.teams.includes(result.team.path)
    )
      throw new InputError("報告の比較結果が不正です");
    for (const count of Object.values(result.community))
      if (
        !object(count) ||
        !Number.isSafeInteger(count.period) ||
        count.period < 0 ||
        !Number.isSafeInteger(count.cumulative) ||
        count.cumulative < 0 ||
        !text(count.basis)
      )
        throw new InputError("報告の集計が不正です");
    for (const item of result.items) {
      if (
        !object(item) ||
        !text(item.text) ||
        !["done", "next", "consult"].includes(item.kind) ||
        !text(item.path) ||
        !sources.has(item.sourceId) ||
        !Array.isArray(item.references) ||
        !item.references.length
      )
        throw new InputError("報告の根拠が不正です");
      for (const reference of item.references)
        if (
          !object(reference) ||
          !sources.has(reference.sourceId) ||
          !text(reference.text) ||
          !text(reference.path)
        )
          throw new InputError("根拠の参照先が不正です");
    }
  }
}

// 復元ファイルは外部入力。永続化する前に画面と比較処理が使う構造を確認する。
export function validateProgressBackup(backup, scope) {
  if (
    !object(backup) ||
    backup.format !== "personal-dashboard-progress" ||
    backup.version !== 1 ||
    backup.scope !== scope ||
    !Array.isArray(backup.records) ||
    backup.records.length > 96 ||
    !timestamp(backup.exportedAt)
  )
    throw new InputError("報告バックアップの形式・対象範囲が一致しません");
  if (
    new TextEncoder().encode(JSON.stringify(backup)).length >
    maximumProgressBackupBytes
  )
    throw new InputError("報告バックアップの上限16MiBを超えています");
  const ids = new Set();
  for (const record of backup.records) {
    if (
      !object(record) ||
      !uuid(record.id) ||
      ids.has(record.id) ||
      record.scope !== scope ||
      !uuid(record.revision) ||
      !["draft", "final"].includes(record.status) ||
      !timestamp(record.generatedAt) ||
      !timestamp(record.updatedAt) ||
      (record.status === "final" && !timestamp(record.finalizedAt)) ||
      (record.archivedAt && !timestamp(record.archivedAt))
    )
      throw new InputError("報告の識別子・保存版・状態が不正か重複しています");
    ids.add(record.id);
    const request = record.request;
    if (
      !object(request) ||
      !["personal", "organizer", "plenary"].includes(request.kind) ||
      !text(request.reporter) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(request.reportDate) ||
      !Array.isArray(request.teams) ||
      !request.teams.every(text) ||
      !Array.isArray(request.sources) ||
      !object(record.period) ||
      !Array.isArray(record.results) ||
      !record.results.length ||
      record.results.length > 12 ||
      !Array.isArray(record.sources) ||
      !Array.isArray(record.checks)
    )
      throw new InputError("報告の条件・根拠の構造が不正です");
    for (const result of record.results)
      if (
        !object(result) ||
        !object(result.team) ||
        !text(result.team.path) ||
        !text(result.team.name) ||
        !text(result.text) ||
        result.text.length > 6000 ||
        !Array.isArray(result.items) ||
        !Array.isArray(result.checks) ||
        !object(result.community) ||
        !object(result.baseline)
      )
        throw new InputError("報告本文・チーム・根拠の構造が不正です");
    assertDetails(record);
    if (
      new TextEncoder().encode(JSON.stringify(record)).length >
      maximumReportBytes
    )
      throw new InputError("報告1件の保存上限2MiBを超えています");
  }
  return backup.records;
}
