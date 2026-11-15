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
const maximumEncodedBodyCharacters = 200000;
const maximumMailTextCharacters = 60000;
const maximumMimeDepth = 12;
const maximumMimeParts = 512;
// 表示用HTMLを実行せずテキスト化する。閉じタグのない入力でも同じ領域を繰り返し走査しない。
function mailHtmlText(html) {
  const lower = html.toLowerCase(),
    chunks = [];
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start === -1) {
      chunks.push(html.slice(cursor));
      break;
    }
    chunks.push(html.slice(cursor, start));
    if (lower.startsWith("<!--", start)) {
      const end = lower.indexOf("-->", start + 4);
      if (end === -1) break;
      cursor = end + 3;
      continue;
    }
    const end = html.indexOf(">", start + 1);
    if (end === -1) break;
    const tag = lower
      .slice(start + 1, end)
      .match(/^\s*(script|style)(?:\s|\/|$)/)?.[1];
    if (tag) {
      const close = lower.indexOf("</" + tag, end + 1);
      if (close === -1) break;
      const closeEnd = html.indexOf(">", close);
      if (closeEnd === -1) break;
      cursor = closeEnd + 1;
    } else cursor = end + 1;
    chunks.push(" ");
  }
  return chunks
    .join("")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}
// MIMEの構造と本文解析量を制限し、制限したことを取得側へ返す。
export function decodeMessageContent(payload) {
  const found = { plain: [], html: [] };
  let parts = 0,
    limited = false;
  function visit(part, depth = 0) {
    if (depth > maximumMimeDepth || ++parts > maximumMimeParts) {
      limited = true;
      return;
    }
    if (!part || typeof part !== "object") throw Error("本文構造が不正です");
    if (!part.filename && ["text/plain", "text/html"].includes(part.mimeType)) {
      if (part.body?.data) {
        if (typeof part.body.data !== "string")
          throw Error("本文データが不正です");
        found[part.mimeType === "text/plain" ? "plain" : "html"].push(
          part.body.data,
        );
      } else if (part.body?.attachmentId) limited = true;
    }
    if (part.parts !== undefined && !Array.isArray(part.parts))
      throw Error("本文構造が不正です");
    for (const child of part.parts || []) {
      if (parts >= maximumMimeParts) {
        limited = true;
        break;
      }
      visit(child, depth + 1);
    }
  }
  visit(payload);
  const plain = found.plain.length > 0;
  const selected = plain ? found.plain : found.html;
  let remaining = maximumEncodedBodyCharacters;
  const chunks = [];
  for (const data of selected) {
    if (!remaining) {
      limited = true;
      break;
    }
    // base64の4文字境界で切り、本文全体をデコードしてから捨てる処理を避ける。
    const length = Math.min(data.length, remaining);
    const clipped = length < data.length;
    const prefix = data.slice(0, clipped ? length - (length % 4) : length);
    limited ||= clipped;
    remaining -= prefix.length;
    chunks.push(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(prefix.replaceAll("-", "+").replaceAll("_", "/")),
          (c) => c.charCodeAt(0),
        ),
      ),
    );
  }
  let text = chunks.join("\n");
  if (!plain) text = mailHtmlText(text);
  limited ||= text.length > maximumMailTextCharacters;
  return { text: text.slice(0, maximumMailTextCharacters), limited };
}
export function messageText(payload) {
  return decodeMessageContent(payload).text;
}
