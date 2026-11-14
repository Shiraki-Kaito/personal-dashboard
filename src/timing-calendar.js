import { readTimingConfirmation } from "./timing-confirmations.js";
import { digest } from "./agenda-rules.js";
import { InputError } from "./sync.js";

export function validTimingReference(ref) {
  return (
    ref &&
    /^[a-f0-9]{1,64}$/.test(ref.messageId) &&
    /^[a-f0-9]{64}$/.test(ref.timingId) &&
    /^[a-f0-9]{64}$/.test(ref.sourceRevision) &&
    typeof ref.revision === "string" &&
    /^[a-f0-9-]{36}$/.test(ref.revision)
  );
}
// 既存の直接登録・復旧領域を使い、メール内の日時ごとに安定した識別子を作る。認証用の値ではない。
export async function timingOperationId(ref) {
  const hex = (
    await digest({ messageId: ref.messageId, timingId: ref.timingId })
  )
    .slice(0, 32)
    .split("");
  hex[12] = "4";
  hex[16] = "8";
  const id = hex.join("");
  return `manual-${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}
export async function requireConfirmedTiming(storage, accountId, ref) {
  if (!validTimingReference(ref))
    throw new InputError("本人確定日時を選択してください");
  const view = await readTimingConfirmation(storage, {
    accountId,
    messageId: ref.messageId,
  });
  const timing = view.timings.find(
    (timing) => timing.timingId === ref.timingId,
  );
  if (
    !timing?.manual ||
    timing.revision !== ref.revision ||
    view.sourceRevision !== ref.sourceRevision
  )
    throw new InputError(
      "確定日時が変更・解除されたか、元メールが変わりました。最新の日時から予定を確認してください",
    );
  return timing;
}
export async function timingCalendarSeed(storage, input) {
  const timing = await requireConfirmedTiming(
    storage,
    input.accountId,
    input.timingRef,
  );
  const id = await timingOperationId(input.timingRef);
  const operation = await storage.get(
    "agenda:operation:" + input.accountId + ":" + id,
  );
  const timingRef = {
    messageId: input.timingRef.messageId,
    timingId: timing.timingId,
    sourceRevision: timing.sourceRevision,
    revision: timing.revision,
  };
  return {
    id,
    timingRef,
    display: timing.display,
    kind: timing.kind,
    candidate: {
      title: timing.action,
      start: timing.editValue.time
        ? timing.editValue.date + "T" + timing.editValue.time
        : "",
      end: timing.editValue.endTime
        ? timing.editValue.endDate + "T" + timing.editValue.endTime
        : "",
      location: "",
      status: "本人確定日時からの予定",
      reasons: [
        "登録先・予定名・開始と終了を確認してから、全アカウントの予定を照合してください。未指定の時刻は補完していません。",
      ],
    },
    operation: operation
      ? Object.fromEntries(
          [
            "eventId",
            "targetAccountId",
            "draft",
            "phase",
            "lastAttempt",
            "lastSuccess",
            "error",
            "sourceType",
            "timingRef",
            "calendarUrl",
          ]
            .filter((key) => operation[key] !== undefined)
            .map((key) => [key, operation[key]]),
        )
      : null,
  };
}
export async function validateTimingDraft(
  storage,
  accountId,
  operationId,
  ref,
  draft,
) {
  const timing = await requireConfirmedTiming(storage, accountId, ref);
  if (operationId !== (await timingOperationId(ref)))
    throw new InputError("確定日時の登録識別子が不正です");
  const local = (instant) =>
    new Date(Date.parse(instant) + 9 * 3600000).toISOString().slice(0, 16);
  const start = local(draft.start),
    end = local(draft.end),
    value = timing.editValue;
  if (
    start.slice(0, 10) !== value.date ||
    (value.time && start !== value.date + "T" + value.time) ||
    (value.endTime && end !== value.endDate + "T" + value.endTime)
  )
    throw new InputError(
      "予定の日時が本人確定内容と異なります。日時の編集から修正・確定し直してください",
    );
  return {
    messageId: ref.messageId,
    timingId: ref.timingId,
    sourceRevision: ref.sourceRevision,
    revision: ref.revision,
  };
}
