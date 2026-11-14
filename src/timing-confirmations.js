import { extractMailTiming } from "./mail-timing.js";
import { digest } from "./agenda-rules.js";
import { InputError } from "./sync.js";

const parserVersion = 1;
const maximumRecords = 100;
const maximumBytes = 64 * 1024;
const maximumEventMs = 7 * 86400000;
const hash = /^[a-f0-9]{64}$/;
const mailId = /^[a-f0-9]{1,64}$/;
const revisionPattern = /^[a-f0-9-]{36}$/;
const stateKey = (accountId) => "agenda:timingConfirmations:" + accountId;

function validDay(value) {
  if (typeof value !== "string" || !/^20\d\d-\d\d-\d\d$/.test(value))
    return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}
function validClock(value) {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}
export function normalizeTimingValue(input) {
  if (
    !input ||
    !["deadline", "event"].includes(input.kind) ||
    typeof input.action !== "string" ||
    !input.action.trim() ||
    input.action.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(input.action) ||
    !validDay(input.date) ||
    typeof input.time !== "string" ||
    (input.time !== "" && !validClock(input.time)) ||
    typeof input.endDate !== "string" ||
    typeof input.endTime !== "string"
  )
    throw new InputError(
      "種別・対応内容・年月日・時刻を確認してください。日時は日本時間で指定します",
    );
  if (input.kind === "event" && !input.time)
    throw new InputError("予定には開始時刻が必要です");
  if (input.kind === "deadline" && (input.endDate || input.endTime))
    throw new InputError("締切には終了日時を指定しません");
  if (input.endDate || input.endTime) {
    if (!validDay(input.endDate) || !validClock(input.endTime))
      throw new InputError("終了日と終了時刻を両方指定してください");
    const start = Date.parse(input.date + "T" + input.time + ":00+09:00");
    const end = Date.parse(input.endDate + "T" + input.endTime + ":00+09:00");
    if (end <= start || end - start > maximumEventMs)
      throw new InputError("終了は開始後、7日以内で指定してください");
  }
  return {
    kind: input.kind,
    action: input.action.trim(),
    date: input.date,
    time: input.time,
    endDate: input.endDate,
    endTime: input.endTime,
  };
}
export function normalizeTimingRecords(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length > maximumRecords
  )
    throw new InputError("日時の確定記録の形式または保存件数が不正です");
  const result = {};
  for (const [key, record] of Object.entries(input)) {
    const [messageId, timingId, ...extra] = key.split(":");
    if (
      extra.length ||
      !mailId.test(messageId) ||
      !hash.test(timingId) ||
      !record ||
      !hash.test(record.sourceRevision) ||
      !revisionPattern.test(record.revision) ||
      typeof record.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(record.updatedAt))
    )
      throw new InputError("日時の確定記録が不正です");
    result[key] = {
      sourceRevision: record.sourceRevision,
      revision: record.revision,
      updatedAt: record.updatedAt,
      value: record.value === null ? null : normalizeTimingValue(record.value),
    };
  }
  if (new TextEncoder().encode(JSON.stringify(result)).length > maximumBytes)
    throw new InputError("日時の確定記録が保存容量の上限です");
  return result;
}
function originalValue(timing) {
  const local = (instant) =>
    new Date(instant + 9 * 3600000).toISOString().slice(0, 16);
  return {
    kind: timing.kind === "date" ? "" : timing.kind,
    action: timing.action,
    date: timing.date || "",
    time: timing.startAt === null ? "" : local(timing.startAt).slice(11),
    endDate: timing.endAt === null ? "" : local(timing.endAt).slice(0, 10),
    endTime: timing.endAt === null ? "" : local(timing.endAt).slice(11),
  };
}
function confirmedTiming(original, value) {
  const day = (date) => date.replaceAll("-", "/");
  return {
    ...original,
    kind: value.kind,
    action: value.action,
    date: value.date,
    display:
      day(value.date) +
      (value.time ? " " + value.time : "（時刻記載なし）") +
      (value.endTime
        ? "〜" +
          (value.endDate === value.date ? "" : day(value.endDate) + " ") +
          value.endTime
        : ""),
    startAt: value.time
      ? Date.parse(value.date + "T" + value.time + ":00+09:00")
      : null,
    endAt: value.endTime
      ? Date.parse(value.endDate + "T" + value.endTime + ":00+09:00")
      : null,
    precision: value.time ? "minute" : "date",
    confirmed: true,
    reasons: [],
  };
}
// 認可済みメールのスナップショットと抽出結果にだけ確定値を適用する。
export async function messageTimingView(message, records = {}) {
  const sourceRevision = await digest({
    version: parserVersion,
    id: message.id,
    subject: message.subject || "",
    from: message.from || "",
    receivedAt: message.receivedAt || "",
    excerpt: message.excerpt || "",
  });
  const timings = await Promise.all(
    extractMailTiming({
      kind: "mail",
      title: message.subject || "件名なし",
      excerpt: message.excerpt || "",
    }).map(async (original) => {
      const timingId = await digest(original);
      const record = records[message.id + ":" + timingId];
      const applied =
        !!record?.value && record.sourceRevision === sourceRevision;
      return {
        ...(applied ? confirmedTiming(original, record.value) : original),
        timingId,
        sourceRevision,
        revision: record?.revision || null,
        editValue: applied ? record.value : originalValue(original),
        original,
        manual: applied ? { confirmedAt: record.updatedAt } : null,
      };
    }),
  );
  const currentIds = new Set(timings.map((timing) => timing.timingId));
  const inactive = Object.entries(records).some(
    ([key, record]) =>
      key.startsWith(message.id + ":") &&
      record.value &&
      (record.sourceRevision !== sourceRevision ||
        !currentIds.has(key.slice(message.id.length + 1))),
  );
  return {
    sourceRevision,
    timings,
    notice: inactive
      ? "元メールまたは抽出結果が変わったため、以前の確定日時は適用していません。再確認してください。"
      : null,
  };
}
async function selectedMessage(storage, input) {
  const accounts = (await storage.get("agenda:accounts")) || [];
  const account = accounts.find((account) => account.id === input.accountId);
  if (!account || account.disconnectedAt || !mailId.test(input.messageId))
    throw new InputError(
      "接続中のアカウントと保存済みメールを選択してください",
    );
  const message = (
    await storage.get("agenda:cache:" + account.id)
  )?.messages?.find((message) => message.id === input.messageId);
  if (!message)
    throw new InputError(
      "元メールを取得できません。再取得してから日時を確認してください",
    );
  return message;
}
export async function readTimingConfirmation(storage, input) {
  const message = await selectedMessage(storage, input);
  return messageTimingView(
    message,
    (await storage.get(stateKey(input.accountId))) || {},
  );
}
export async function saveTimingConfirmation(storage, input, now = Date.now()) {
  if (
    input.confirm !== true ||
    !hash.test(input.timingId) ||
    !hash.test(input.sourceRevision) ||
    !(
      input.expectedRevision === null ||
      (typeof input.expectedRevision === "string" &&
        revisionPattern.test(input.expectedRevision))
    )
  )
    throw new InputError("確定する日時の内容を確認してください");
  const value = input.reset === true ? null : normalizeTimingValue(input.value);
  return storage.transaction(async (tx) => {
    const message = await selectedMessage(tx, input);
    const key = stateKey(input.accountId),
      records = (await tx.get(key)) || {};
    const view = await messageTimingView(message, records);
    const timing = view.timings.find(
      (timing) => timing.timingId === input.timingId,
    );
    if (!timing || view.sourceRevision !== input.sourceRevision)
      throw new InputError(
        "元メールまたは日時が変更されています。最新情報を再読込してください",
      );
    if (timing.revision !== input.expectedRevision)
      throw new InputError(
        "別の画面で日時が変更されています。再読込して確認してください",
      );
    const currentIds = new Set(view.timings.map((timing) => timing.timingId));
    const retained = Object.fromEntries(
      Object.entries(records).filter(
        ([key, record]) =>
          !key.startsWith(message.id + ":") ||
          (record.sourceRevision === view.sourceRevision &&
            currentIds.has(key.slice(message.id.length + 1))),
      ),
    );
    const updated = normalizeTimingRecords({
      ...retained,
      [message.id + ":" + input.timingId]: {
        sourceRevision: view.sourceRevision,
        revision: crypto.randomUUID(),
        updatedAt: new Date(now).toISOString(),
        value,
      },
    });
    // 解除後も版を残し、保存前→解除後の古いフォームによる上書きを止める。
    await tx.put(key, updated);
    return messageTimingView(message, updated);
  });
}
