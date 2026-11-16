import { InputError } from "./sync.js";
import { groupView, homeDriveGroups } from "./drive-groups.js";

const storageKey = "drive:meetingReports";
const maximumRecords = 24;
const maximumStoreBytes = 96 * 1024;
const fields = ["ownProgress", "ownNext", "teamProgress", "teamNext", "risks"];
const audiences = ["personal", "organizer", "plenary"];
const summaryCharacterLimit = 320;
const summaryLineLimit = 4;
const validDay = (value) =>
  typeof value === "string" &&
  /^20\d\d-\d\d-\d\d$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const safeText = (value, limit) =>
  typeof value === "string" &&
  value.length <= limit &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);

export function meetingInput(input) {
  if (
    !input ||
    !validDay(input.meetingDate) ||
    fields.some((key) => !safeText(input[key], 1000))
  )
    throw new InputError(
      "会議日と進捗・Next Actionを確認してください。各欄1000文字までです",
    );
  return Object.fromEntries(
    ["meetingDate", ...fields].map((key) => [key, input[key].trim()]),
  );
}
function reportTexts(input) {
  if (!input || audiences.some((key) => !safeText(input[key], 6000)))
    throw new InputError("報告文は用途ごとに6000文字までです");
  return Object.fromEntries(audiences.map((key) => [key, input[key]]));
}
export function normalizeMeetingStore(value) {
  if (
    !value ||
    typeof value.scope !== "string" ||
    !value.scope ||
    !Array.isArray(value.records) ||
    value.records.length > maximumRecords
  )
    throw new InputError("会議記録の形式・保存件数が不正です");
  const seen = new Set();
  const records = value.records.map((record) => {
    const input = meetingInput(record);
    if (
      seen.has(input.meetingDate) ||
      typeof record.revision !== "string" ||
      !/^[a-f0-9-]{36}$/.test(record.revision) ||
      typeof record.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(record.updatedAt))
    )
      throw new InputError("会議記録の日付・保存版が不正です");
    seen.add(input.meetingDate);
    return {
      ...input,
      reports: reportTexts(record.reports),
      revision: record.revision,
      updatedAt: record.updatedAt,
    };
  });
  const result = { scope: value.scope, records };
  if (
    new TextEncoder().encode(JSON.stringify(result)).length > maximumStoreBytes
  )
    throw new InputError(
      "会議記録の保存上限96KiBです。記録を変更せず停止しました",
    );
  return result;
}
const section = (title, text) => `【${title}】\n${text || "未記入"}`;
function brief(text) {
  const lines = text.split(/\r?\n/),
    excerpt = lines.slice(0, summaryLineLimit).join("\n");
  return (
    excerpt.slice(0, summaryCharacterLimit) +
    (lines.length > summaryLineLimit || excerpt.length > summaryCharacterLimit
      ? "\n…（詳細はOrganizer向けを参照）"
      : "")
  );
}
// 入力された記録を用途別に整形する。未記入やDriveの更新量を実績へ変換しない。
export function composeMeetingReports(input) {
  const record = meetingInput(input),
    date = record.meetingDate.replaceAll("-", "/");
  return {
    personal: [
      `集客広報チームMTG｜${date}`,
      section("自分の進捗", record.ownProgress),
      section("自分のNext Action", record.ownNext),
      section("相談・確認事項", record.risks),
    ].join("\n\n"),
    organizer: [
      `Organizer向け｜集客広報｜${date}`,
      section("チームの進捗", record.teamProgress),
      section("Next Action", record.teamNext),
      section("相談・確認事項", record.risks),
    ].join("\n\n"),
    plenary: [
      `全体定例｜集客広報｜${date}`,
      section("進捗", brief(record.teamProgress)),
      section("次にすること", brief(record.teamNext)),
      ...(record.risks ? [section("共有・相談", brief(record.risks))] : []),
    ].join("\n\n"),
  };
}
export async function meetingView(storage, scope) {
  const saved = await storage.get(storageKey);
  if (saved && saved.scope !== scope)
    throw new InputError(
      "別のDrive接続範囲の会議記録が残っています。上書きせず停止しました",
    );
  const store = normalizeMeetingStore(saved || { scope, records: [] });
  const cache = await storage.get("drive:cache");
  const groups =
    cache?.scope === scope
      ? groupView(cache, await storage.get("drive:groups"))
      : [];
  const teams = homeDriveGroups({ groups, unreadChanges: [] }).highlighted;
  return {
    ...store,
    records: store.records.sort((a, b) =>
      b.meetingDate.localeCompare(a.meetingDate),
    ),
    teams: teams.map((team) => ({
      name: team.name,
      status: team.status,
      nextAction: team.nextAction,
      due: team.due,
      updatedAt: team.updatedAt,
    })),
    maximumRecords,
    lastDriveSuccess: cache?.scope === scope ? cache.lastSuccess || null : null,
  };
}
export async function saveMeeting(storage, scope, input, now = Date.now()) {
  const record = meetingInput(input),
    reports = reportTexts(input.reports);
  if (
    input.scope !== scope ||
    !(
      input.expectedRevision === null ||
      (typeof input.expectedRevision === "string" &&
        /^[a-f0-9-]{36}$/.test(input.expectedRevision))
    )
  )
    throw new InputError("会議記録の接続範囲・保存版を確認してください");
  return storage.transaction(async (tx) => {
    const previous = await tx.get(storageKey);
    if (previous && previous.scope !== scope)
      throw new InputError("Driveの接続範囲が変わりました。保存を停止しました");
    const store = normalizeMeetingStore(previous || { scope, records: [] });
    const old = store.records.find(
      (item) => item.meetingDate === record.meetingDate,
    );
    if ((old?.revision || null) !== input.expectedRevision)
      throw new InputError(
        "別の画面で会議記録が変更されました。入力を保持して停止しました。保存内容を再取得して確認してください",
      );
    const saved = {
      ...record,
      reports,
      revision: crypto.randomUUID(),
      updatedAt: new Date(now).toISOString(),
    };
    await tx.put(
      storageKey,
      normalizeMeetingStore({
        scope,
        records: [
          ...store.records.filter(
            (item) => item.meetingDate !== record.meetingDate,
          ),
          saved,
        ],
      }),
    );
    return saved;
  });
}
