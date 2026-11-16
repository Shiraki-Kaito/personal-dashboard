import { extractMailTiming } from "./mail-timing.js";
import { currentMailText } from "./mail-intent.js";
import { maximumTimingTextCharacters } from "./mail-body-coverage.js";

const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthName = "(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan\\.?|Feb\\.?|Mar\\.?|Apr\\.?|Jun\\.?|Jul\\.?|Aug\\.?|Sep(?:t)?\\.?|Oct\\.?|Nov\\.?|Dec\\.?)";
const monthFirst = new RegExp(`\\b(${monthName})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`, "gi");
const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthName})(?:,?\\s+(20\\d{2}))?\\b`, "gi");
const key = (row) => JSON.stringify([row.kind, row.action, row.display]);

function englishDates(text) {
  const day = (month, date, year) =>
    (year ? year + "/" : "") + (months.indexOf(month.slice(0, 3).toLowerCase()) + 1) + "/" + date;
  return text.replace(monthFirst, (_, month, date, year) => day(month, date, year))
    .replace(dayFirst, (_, date, month, year) => day(month, date, year));
}

// 通常の抽出・保存IDは維持し、追加範囲・英語書式からの未確定候補だけを補う。
export function additionalMailTimings(message, baseline) {
  const text = currentMailText(message.timingText || message.excerpt || "", maximumTimingTextCharacters);
  const entry = { kind: "mail", title: message.subject || "件名なし", excerpt: text };
  const candidates = message.timingText ? extractMailTiming(entry, maximumTimingTextCharacters) : [];
  const lines = [entry.title, ...text.split(/\r?\n/)];
  let previous = "";
  for (const line of lines) {
    const context = (previous.length < 80 ? previous + "\n" : "") + line;
    const occurrences = [...context.matchAll(monthFirst), ...context.matchAll(dayFirst)];
    for (const occurrence of occurrences) {
      // 根拠が長い行でも、実際に見つけた英語日付の周辺を表示する。
      const evidence = context.slice(Math.max(0, occurrence.index - 80), occurrence.index + 160);
      const translated = englishDates(evidence)
        .replace(/\b(?:deadline|due(?:\s+date)?|submit\s+by|RSVP\s+by|respond\s+by)\b/gi, "締切")
        .replace(/\binterview\b/gi, "面接")
        .replace(/\b(?:meeting|webinar|orientation)\b/gi, "会議")
        .replace(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/gi, (_, hour, minute, period) => period + hour + ":" + (minute || "00"));
      for (const row of extractMailTiming({ ...entry, title: "", excerpt: translated }, maximumTimingTextCharacters)) {
        candidates.push({ ...row, evidence });
      }
    }
    previous = line.trim();
  }
  const seen = new Set(baseline.map(key));
  return candidates.filter((row) => {
    if (seen.has(key(row))) return false;
    seen.add(key(row));
    return true;
  }).map((row) => ({
    ...row,
    action: row.kind === "deadline" ? "原文で締切・対象を確認する" : "原文で予定日時を確認する",
    confirmed: false,
    reasons: [...new Set([...row.reasons, "追加範囲・別書式からの日時候補です。原文・年・タイムゾーン・対象の手続きを確認してください"])],
  }));
}
