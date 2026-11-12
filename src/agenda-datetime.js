// 日付の年や日を推測せず、明記された日本時間の範囲だけを入力候補にする。
const weekdays = "日月火水木金土";
const timePattern =
  "(?:(?:午前|午後|AM|PM)\\s*)?\\d{1,2}(?::\\d{2}|時(?:\\d{1,2}分?|半)?)(?![\\d:])";
function readTime(value, inheritedPeriod) {
  const match = value.match(
    /^(?:(午前|午後|AM|PM)\s*)?(\d{1,2})(?::(\d{2})|時(?:(\d{1,2})分?|(半))?)$/i,
  );
  if (!match) return null;
  const period = match[1]?.toUpperCase() || inheritedPeriod;
  let hour = Number(match[2]);
  const minute = Number(match[3] || match[4] || (match[5] ? 30 : 0));
  if (period) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (["午後", "PM"].includes(period) ? 12 : 0);
  }
  return hour < 24 && minute < 60
    ? {
        clock:
          String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0"),
        period,
      }
    : null;
}
export function extractDateTime(source) {
  const reasons = [],
    dates = [];
  for (const match of source.matchAll(
    /(?<!\d)(?:(20\d{2})[年/.-])?(\d{1,2})[月/.-](\d{1,2})(?:日)?(?:\s*(?:\(([日月火水木金土])(?:曜(?:日)?)?\)|([日月火水木金土])曜日))?(?!\d)/g,
  )) {
    if (!match[1]) {
      reasons.push("年が省略されています。年を確認してください");
      continue;
    }
    const day = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
    const parsed = new Date(day + "T00:00:00Z");
    if (
      !Number.isFinite(+parsed) ||
      parsed.toISOString().slice(0, 10) !== day
    ) {
      reasons.push("日付の値を確認してください");
      continue;
    }
    const weekday = match[4] || match[5];
    if (weekday && weekdays[parsed.getUTCDay()] !== weekday)
      reasons.push("日付と曜日が一致しません");
    dates.push(day);
  }
  const days = [...new Set(dates)];
  if (days.length !== 1)
    reasons.push(
      days.length ? "日付が複数あります" : "年を含む日付を確認してください",
    );
  if (/今日|明日|明後日|来週|今週|翌日/.test(source))
    reasons.push("相対的な日付は年月日を確認してください");
  const ranges = [
    ...source.matchAll(
      new RegExp(
        `(${timePattern})\\s*(?:[〜~－–—-]|から|to)\\s*(${timePattern})`,
        "gi",
      ),
    ),
  ];
  const clocks = ranges.map((match) => {
    const start = readTime(match[1]),
      end = readTime(match[2], start?.period);
    return start && end ? [start.clock, end.clock] : null;
  });
  const uniqueClocks = [
    ...new Map(
      clocks.filter(Boolean).map((value) => [value.join("/"), value]),
    ).values(),
  ];
  if (clocks.some((value) => !value))
    reasons.push("時刻の値を確認してください");
  if (uniqueClocks.length !== 1)
    reasons.push("開始・終了時刻を確認してください");
  if (
    /候補|調整中|未定|いずれか|キャンセル|中止|取消|変更前|旧日程|日程変更|延期/.test(
      source,
    )
  )
    reasons.push("候補・変更・取消の確認が必要です");
  if (
    /UTC|GMT|PST|PDT|EST|EDT|CET|[+-]\d\d:?\d\d/i.test(
      source.replaceAll("+09:00", ""),
    )
  )
    reasons.push("日本時間かタイムゾーンを確認してください");
  let start = "",
    end = "";
  if (
    days.length === 1 &&
    uniqueClocks.length === 1 &&
    !clocks.some((value) => !value)
  ) {
    start = days[0] + "T" + uniqueClocks[0][0];
    end = days[0] + "T" + uniqueClocks[0][1];
    if (end <= start) {
      start = end = "";
      reasons.push("終了日・終了時刻を確認してください");
    }
  }
  return {
    start,
    end,
    reasons: [...new Set(reasons)],
    hasDateTime:
      (dates.length > 0 || reasons.some((r) => r.startsWith("年が"))) &&
      ranges.length > 0,
  };
}
