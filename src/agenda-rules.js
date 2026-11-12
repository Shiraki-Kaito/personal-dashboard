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
  const dates = [
    ...source.matchAll(/(20\d{2})[年/.-](\d{1,2})[月/.-](\d{1,2})(?:日)?/g),
  ].map((m) => `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`);
  const unique = [...new Set(dates)];
  const ranges = [
    ...source.matchAll(
      /(\d{1,2}):([0-5]\d)\s*[〜～~－–—-]\s*(\d{1,2}):([0-5]\d)/g,
    ),
  ];
  const isCandidate =
    /面接|面談|説明会|打合せ|打ち合わせ|ミーティング|会議|登壇|勉強会|懇親会|日程調整|日時\s*[:：]|予定\s*[:：]/.test(
      source,
    ) ||
    (dates.length > 0 && ranges.length > 0);
  const reasons = [];
  if (unique.length !== 1)
    reasons.push(
      unique.length ? "日付が複数あります" : "年を含む日付を確認してください",
    );
  if (ranges.length !== 1) reasons.push("開始・終了時刻を確認してください");
  if (
    /候補|調整中|未定|いずれか|キャンセル|中止|取消|変更前|旧日程|UTC|GMT|PST|EST|CET|[+-]\d\d:?\d\d/i.test(
      source,
    )
  )
    reasons.push("候補・変更・タイムゾーンなどの確認が必要です");
  let start = "",
    end = "";
  if (unique.length === 1 && ranges.length === 1) {
    const m = ranges[0];
    start = unique[0] + "T" + m[1].padStart(2, "0") + ":" + m[2];
    end = unique[0] + "T" + m[3].padStart(2, "0") + ":" + m[4];
    try {
      if (japanInstant(end) <= japanInstant(start)) throw Error();
    } catch {
      start = end = "";
      reasons.push("日時の値を確認してください");
    }
  }
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
