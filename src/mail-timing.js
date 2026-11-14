import { readTime } from "./agenda-datetime.js";

const japanOffsetMs = 9 * 3600000;
const soonMs = 72 * 3600000;
const weekdays = "日月火水木金土";
const datePattern =
  /(?<!\d)(?:(20\d{2})[年/.-])?(\d{1,2})[月/.-](\d{1,2})(?!\d)日?(?:\s*(?:\(([日月火水木金土])(?:曜(?:日)?)?\)|([日月火水木金土])曜日))?/g;
const clockPattern =
  /(?<![\d:])(?:(?:午前|午後|AM|PM)\s*)?\d{1,2}(?::\d{2}|時(?:\d{1,2}分?|半)?)(?:\s*(?:AM|PM))?(?![\d:])/gi;
const deadlineWords = /締切|締め切り|期限|必着|までに|提出日|回答日/;
const eventWords =
  /面接|面談|説明会|日時|開催|開始|日程|会議|ミーティング|打ち合わせ|試験/;
const uncertainWords =
  /候補|調整中|未定|いずれか|変更前|旧日程|日程変更|延期|延長|キャンセル|中止|取消/;
function actionFor(kind, context, title) {
  if (/返信|回答|出欠/.test(context)) return "返信・回答する";
  const document = (context + " " + title).match(
    /成績証明書|履歴書|エントリーシート|提出書類|レポート|課題/,
  );
  if (kind === "deadline" && document) return document[0] + "を提出する";
  if (/面接|面談/.test(context + title))
    return kind === "event"
      ? "面接・面談の日程を確認する"
      : "面接に向けた手続きを確認する";
  return kind === "deadline" ? "必要な手続きを行う" : "予定の内容を確認する";
}
function activeText(entry) {
  // 引用メールの古い期限や転送ヘッダーを、新しい指示として採用しない。
  const body = (entry.excerpt || "").slice(0, 1600).normalize("NFKC");
  const lines = [];
  for (const line of body.split(/\r?\n/)) {
    if (
      /^-{2,}\s*(?:Original Message|Forwarded message|転送|元のメッセージ)|^On .+wrote:|^.*さんは書きました[:：]/i.test(
        line.trim(),
      )
    )
      break;
    if (!/^\s*>/.test(line)) lines.push(line);
  }
  return [entry.title.normalize("NFKC"), ...lines];
}
function parsedDate(match) {
  const [, year, month, day] = match;
  const weekday = match[4] || match[5];
  // 年なしでも月日自体が不正なら候補へ採用しない。うるう日は年の確認に残す。
  const value = `${year || "2000"}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const date = new Date(value + "T00:00:00Z");
  const valid =
    Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
  return {
    date: year && valid ? value : null,
    valid,
    weekdayMismatch: !!(
      year &&
      valid &&
      weekday &&
      weekdays[date.getUTCDay()] !== weekday
    ),
  };
}
function parsedClock(raw, period) {
  const suffix = raw.match(/\s*(AM|PM)$/i);
  return readTime(
    suffix ? suffix[1] + raw.slice(0, suffix.index).trim() : raw.trim(),
    period,
  );
}
// 戻り値のstartAtは明記された年・月日・時刻だけ。時刻なしの期限に23:59を創作しない。
export function extractMailTiming(entry) {
  if (
    entry.kind === "pending" ||
    /提出ありがとう|提出いただきありがとう|受領|受付完了|登録完了|提出完了/.test(
      entry.title,
    )
  )
    return [];
  const lines = activeText(entry);
  const rows = [];
  let previous = "";
  for (const line of lines.flatMap((line) => line.split(/[。;；、]/))) {
    const segment = line.trim();
    if (!segment) continue;
    const dates = [...segment.matchAll(datePattern)];
    // 「締切：」の次行にある日付を読めるよう、直前の短い見出しも参照する。
    const context =
      (segment.length < 300 && previous.length < 80 ? previous + "\n" : "") +
      segment;
    const kind =
      deadlineWords.test(segment) || /まで/.test(segment)
        ? "deadline"
        : eventWords.test(segment)
          ? "event"
          : deadlineWords.test(previous)
            ? "deadline"
            : eventWords.test(previous)
              ? "event"
              : "date";
    previous = dates.length ? "" : segment;
    if (!dates.length) {
      const relative = segment.match(
        /今日|明日|明後日|来週[^\s。]{0,12}|今週[^\s。]{0,12}|翌日/,
      );
      if (relative && kind !== "date")
        rows.push({
          kind,
          action: actionFor(kind, context, entry.title),
          display: relative[0],
          date: null,
          startAt: null,
          endAt: null,
          precision: "unknown",
          confirmed: false,
          reasons: ["相対日付です。元メールで年月日を確認してください"],
          evidence: context.slice(0, 240),
        });
      continue;
    }
    for (let index = 0; index < dates.length; index++) {
      const match = dates[index];
      const parsed = parsedDate(match);
      const tail = segment.slice(
        match.index + match[0].length,
        dates[index + 1]?.index,
      );
      const unsupportedClock = /\dT\d\d:\d\d|\d{1,2}:\d{2}:\d{2}/.test(tail);
      const clocks = unsupportedClock ? [] : [...tail.matchAll(clockPattern)];
      const start = clocks[0] && parsedClock(clocks[0][0]);
      const end = clocks[1] && parsedClock(clocks[1][0], start?.period);
      const reasons = [];
      if (!parsed.valid) reasons.push("実在する日付か確認してください");
      if (!match[1]) reasons.push("年が省略されています");
      if (parsed.weekdayMismatch) reasons.push("日付と曜日が一致しません");
      if (dates.length > 1) reasons.push("同じ記載に複数の日付があります");
      if (uncertainWords.test(context) || uncertainWords.test(entry.title))
        reasons.push("候補・変更・取消を確認してください");
      if (unsupportedClock)
        reasons.push("秒付き・ISO形式の時刻を原文で確認してください");
      if (
        /UTC|GMT|PST|PDT|EST|EDT|CET|[+-]\d\d:?\d\d/i.test(
          context.replaceAll("+09:00", ""),
        )
      )
        reasons.push("日本時間か確認してください");
      if (
        (clocks.length && !start) ||
        (clocks.length > 1 && !end) ||
        clocks.length > 2
      )
        reasons.push("時刻を確認してください");
      if (kind === "deadline" && clocks.length > 1)
        reasons.push("締切の時刻が複数あります");
      if (end && start && end.clock <= start.clock)
        reasons.push("終了日・終了時刻を確認してください");
      if (kind === "date") reasons.push("締切か予定の日かを確認してください");
      if (kind === "event" && !clocks.length)
        reasons.push("開始時刻を確認してください");
      const dateLabel = match[1]
        ? `${match[1]}/${Number(match[2])}/${Number(match[3])}`
        : `${Number(match[2])}/${Number(match[3])}`;
      rows.push({
        kind,
        action: actionFor(kind, context, entry.title),
        display:
          dateLabel +
          (start
            ? ` ${start.clock}` + (end ? `〜${end.clock}` : "")
            : clocks.length || unsupportedClock
              ? "（時刻要確認）"
              : "（時刻記載なし）"),
        date: parsed.date,
        startAt:
          parsed.date && start
            ? Date.parse(parsed.date + "T" + start.clock + ":00+09:00")
            : null,
        endAt:
          parsed.date && end
            ? Date.parse(parsed.date + "T" + end.clock + ":00+09:00")
            : null,
        precision: start ? "minute" : "date",
        confirmed: !reasons.length,
        reasons,
        evidence:
          context.length <= 240
            ? context
            : segment.slice(Math.max(0, match.index - 80), match.index + 160),
      });
    }
  }
  const unique = [
    ...new Map(
      rows.map((row) => [
        JSON.stringify([row.kind, row.action, row.display, row.reasons]),
        row,
      ]),
    ).values(),
  ];
  if (!unique.length && lines.some((line) => deadlineWords.test(line)))
    unique.push({
      kind: "deadline",
      action: actionFor("deadline", lines.join(" "), entry.title),
      display: "具体的な締切を確認してください",
      date: null,
      startAt: null,
      endAt: null,
      precision: "unknown",
      confirmed: false,
      reasons: ["保存済み本文から具体的な日付を取得できません"],
      evidence: lines.find((line) => deadlineWords.test(line)).slice(0, 240),
    });
  return unique;
}
export function timingPriority(timings, pending, now = Date.now()) {
  if (pending) return { rank: 0, label: "登録結果未確認", at: null };
  const today = new Date(now + japanOffsetMs).toISOString().slice(0, 10);
  const candidates = timings.map((timing) => {
    if (!timing.confirmed)
      return { rank: 4, label: "日時の確認が必要", at: null };
    const at = timing.startAt ?? Date.parse(timing.date + "T00:00:00+09:00");
    if (timing.kind === "deadline") {
      if (
        timing.date < today ||
        (timing.startAt !== null && timing.startAt < now)
      )
        return { rank: 1, label: "期限超過・対応状況を確認", at };
      if (timing.date === today) return { rank: 2, label: "今日が締切", at };
    } else if ((timing.endAt ?? at) < now)
      return { rank: 4, label: "過ぎた日程・対応状況を確認", at: null };
    if (at <= now + soonMs)
      return {
        rank: 3,
        label: timing.kind === "deadline" ? "3日以内の締切" : "直近の予定",
        at,
      };
    return {
      rank: 5,
      label: timing.kind === "deadline" ? "今後の締切" : "今後の予定",
      at,
    };
  });
  return (
    candidates.sort(
      (a, b) => a.rank - b.rank || (a.at ?? Infinity) - (b.at ?? Infinity),
    )[0] || { rank: 6, label: "期限の記載を確認", at: null }
  );
}
