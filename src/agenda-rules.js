import { extractDateTime } from "./agenda-datetime.js";
// 本文から確実に読める絶対日付・時間帯だけを候補にし、登録判断は本人に委ねる。
export function japanInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value))
    throw Error("日時は日本時間の年月日・時刻で指定してください");
  const instant = new Date(value + ":00+09:00");
  if (
    !Number.isFinite(+instant) ||
    new Date(+instant + 9 * 3600000).toISOString().slice(0, 16) !== value
  )
    throw Error("日時が不正です");
  return instant.toISOString();
}
export function extractAppointment(subject, text) {
  const source = (subject + "\n" + text).normalize("NFKC");
  const { start, end, reasons, hasDateTime } = extractDateTime(source);
  const isCandidate =
    /面接|面談|説明会|打合せ|打ち合わせ|ミーティング|会議|登壇|勉強会|懇親会|日程調整|招待|日時\s*[:：]|予定\s*[:：]/.test(
      source,
    ) || hasDateTime;
  return {
    title: subject.slice(0, 300),
    start,
    end,
    location: (
      source.match(/(?:場所|会場)\s*[:：]\s*([^\n\r]{1,300})/)?.[1] || ""
    ).trim(),
    reasons: isCandidate ? reasons : [],
    isCandidate,
    status: !isCandidate
      ? "予定候補なし"
      : reasons.length
        ? "確認待ち"
        : "内容確認待ち",
  };
}
export function validateAppointment(input) {
  if (
    !input ||
    typeof input.title !== "string" ||
    !input.title.trim() ||
    input.title.length > 300 ||
    typeof input.location !== "string" ||
    input.location.length > 500
  )
    throw Error("予定名・場所を確認してください");
  const start = japanInstant(input.start),
    end = japanInstant(input.end);
  if (end <= start || Date.parse(end) - Date.parse(start) > 7 * 86400000)
    throw Error("終了は開始後、7日以内で指定してください");
  return {
    title: input.title.trim(),
    location: input.location.trim(),
    start,
    end,
  };
}
function eventInstant(value) {
  return (
    value?.dateTime || (value?.date ? value.date + "T00:00:00+09:00" : null)
  );
}
export function compareAppointments(draft, events) {
  const start = Date.parse(draft.start),
    end = Date.parse(draft.end);
  return events
    .filter((e) => e.status !== "cancelled" && e.transparency !== "transparent")
    .flatMap((event) => {
      const a = Date.parse(eventInstant(event.start)),
        b = Date.parse(eventInstant(event.end));
      if (!Number.isFinite(a) || !Number.isFinite(b))
        throw Error("既存予定の日時を照合できません");
      if (a >= end || b <= start) return [];
      return [
        {
          id: event.id,
          etag: event.etag || null,
          accountId: event.accountId,
          title: (event.summary || "名称非公開").slice(0, 300),
          start: eventInstant(event.start),
          end: eventInstant(event.end),
          duplicate:
            a === start &&
            b === end &&
            (event.summary || "").normalize("NFKC").trim() ===
              draft.title.normalize("NFKC").trim(),
        },
      ];
    });
}
export async function digest(value) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export function messageText(payload) {
  const found = { plain: [], html: [] };
  function visit(part, depth = 0) {
    if (depth > 12) return;
    if (
      part.body?.data &&
      !part.filename &&
      ["text/plain", "text/html"].includes(part.mimeType)
    ) {
      const data = part.body.data;
      if (data.length > 200000)
        throw Error("メール本文が取得上限を超えています");
      const text = new TextDecoder().decode(
        Uint8Array.from(
          atob(data.replaceAll("-", "+").replaceAll("_", "/")),
          (c) => c.charCodeAt(0),
        ),
      );
      found[part.mimeType === "text/plain" ? "plain" : "html"].push(text);
    }
    for (const child of part.parts || []) visit(child, depth + 1);
  }
  visit(payload);
  return (
    found.plain.length
      ? found.plain.join("\n")
      : found.html
          .join("\n")
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]*>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
  ).slice(0, 60000);
}
