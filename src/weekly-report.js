import { InputError } from "./sync.js";
import { isPersonalWork } from "./drive-review.js";

const japanOffsetMs = 9 * 3600000;
const dayMs = 86400000;
const maximumParagraphs = 5000;
const maximumTextCharacters = 200000;
const maximumEvidence = 500;
const day = (value) =>
  typeof value === "string" &&
  /^20\d\d-\d\d-\d\d$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const normalize = (text) => text.normalize("NFKC").replace(/\s+/g, " ").trim();
export function weeklyPeriod(endDate) {
  if (!day(endDate)) throw new InputError("週報の終了日を確認してください");
  const end = Date.parse(endDate + "T00:00:00+09:00") + dayMs;
  return {
    start: end - 7 * dayMs,
    end,
    startDate: new Date(end - 7 * dayMs + japanOffsetMs)
      .toISOString()
      .slice(0, 10),
    endDate,
  };
}
// Docsの日付チップとリスト階層を保持する。平文化で日付・担当者の境界を失わない。
export function minutesParagraphs(document) {
  const result = [];
  let characters = 0;
  function content(items, tabId, tabTitle, depth = 0) {
    if (depth > 12) throw new InputError("議事録の構造が深すぎます");
    for (const item of items || []) {
      if (item.paragraph) {
        const p = item.paragraph;
        const dates = (p.elements || [])
          .map((e) => e.dateElement?.dateElementProperties?.timestamp)
          .filter(Boolean);
        const text = (p.elements || [])
          .map(
            (e) =>
              e.textRun?.content ||
              e.dateElement?.dateElementProperties?.displayText ||
              e.person?.personProperties?.name ||
              "",
          )
          .join("")
          .trim();
        characters += text.length;
        if (
          result.length >= maximumParagraphs ||
          characters > maximumTextCharacters
        )
          throw new InputError(
            "議事録が解析上限を超えています。部分解析で週報を作らず停止しました",
          );
        result.push({
          text,
          dates,
          tabId,
          tabTitle,
          index: item.startIndex || 0,
          level: p.bullet ? p.bullet.nestingLevel || 0 : null,
          tableCell: depth > 0,
          heading: p.paragraphStyle?.namedStyleType || "NORMAL_TEXT",
        });
      }
      for (const row of item.table?.tableRows || [])
        for (const cell of row.tableCells || [])
          content(cell.content, tabId, tabTitle, depth + 1);
    }
  }
  function tabs(items, depth = 0) {
    if (depth > 12) throw new InputError("議事録のタブ階層が深すぎます");
    for (const tab of items || []) {
      const title = tab.tabProperties?.title || "";
      if (
        /^(old(?: notes)?|archive|template|過去|過去の議事録|テンプレート)$/i.test(
          normalize(title),
        )
      )
        continue;
      content(
        tab.documentTab?.body?.content,
        tab.tabProperties?.tabId || "",
        title,
      );
      tabs(tab.childTabs, depth + 1);
    }
  }
  if (document.tabs?.length) tabs(document.tabs);
  else content(document.body?.content, "", "本文");
  return result;
}
export function weeklyEvidence(
  cache,
  document,
  { endDate, ownerName, now = Date.now() },
) {
  const period = weeklyPeriod(endDate),
    alias = normalize(ownerName || "");
  if (!alias || alias.length > 40)
    throw new InputError("議事録での本人の表記を40文字以内で指定してください");
  const rows = minutesParagraphs(document),
    entries = [];
  let latestMeetingDate = null;
  let meetingDate = null,
    section = "",
    stack = [],
    tabId = null;
  for (const row of rows) {
    if (tabId !== row.tabId) {
      meetingDate = null;
      section = "";
      stack = [];
      tabId = row.tabId;
    }
    const match = normalize(row.text).match(
      /^(20\d\d)[年/.-](\d{1,2})[月/.-](\d{1,2})日?$/,
    );
    const instant = row.dates.length === 1 ? Date.parse(row.dates[0]) : NaN;
    const date = Number.isFinite(instant)
      ? new Date(instant + japanOffsetMs).toISOString().slice(0, 10)
      : match
        ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`
        : null;
    if (row.heading.startsWith("HEADING_") && (row.dates.length || match)) {
      meetingDate = day(date) ? date : null;
      if (
        meetingDate &&
        meetingDate >= period.startDate &&
        meetingDate <= period.endDate &&
        (!latestMeetingDate || meetingDate > latestMeetingDate)
      )
        latestMeetingDate = meetingDate;
      section = "";
      stack = [];
      continue;
    }
    if (
      !meetingDate ||
      meetingDate < period.startDate ||
      meetingDate > period.endDate
    )
      continue;
    const text = normalize(row.text);
    if (!text) continue;
    if (text === "Agenda") {
      section = "agenda";
      stack = [];
      continue;
    }
    if (text === "Contents") {
      section = "";
      stack = [];
      continue;
    }
    if (row.level === 0 && section !== "agenda") {
      section =
        text === "進捗報告"
          ? "progress"
          : text === "相談事項"
            ? "risks"
            : "other";
      stack = [text];
      continue;
    }
    if (section !== "progress" && section !== "risks") continue;
    if (row.level === null || row.level > 12) continue;
    stack.length = Math.min(stack.length, row.level);
    stack[row.level] = text;
    const ancestors = stack.slice(0, -1).filter(Boolean);
    const marker = [...ancestors]
      .reverse()
      .find((label) => /^(完了|進捗|進行中|Next\s*Actions?)$/i.test(label));
    const kind =
      section === "risks"
        ? "risks"
        : /^Next/i.test(marker || "")
          ? "next"
          : marker
            ? "progress"
            : null;
    if (!kind) continue;
    const personal = ancestors.some(
      (label) =>
        label === alias ||
        label.split(/[-:：/]/).some((part) => normalize(part) === alias),
    );
    entries.push({
      kind,
      stage: marker || "相談事項",
      text,
      personal,
      path: ancestors
        .slice(1)
        .filter((label) => !/^(完了|Next\s*Actions?)$/i.test(label))
        .join(" / "),
      meetingDate,
      tabId: row.tabId,
      index: row.index,
      sourceId: document.documentId,
    });
  }
  const files = (cache?.files || [])
    .filter(
      (file) =>
        !isPersonalWork(file) &&
        !/_L\.md$/i.test(file.name || "") &&
        Date.parse(file.modifiedTime) >= period.start &&
        Date.parse(file.modifiedTime) < period.end,
    )
    .sort((a, b) => Date.parse(b.modifiedTime) - Date.parse(a.modifiedTime))
    .map((file) => ({
      id: file.id,
      name: file.name,
      folder: file.folder,
      modifiedTime: file.modifiedTime,
      lastModifiedBy: file.lastModifiedBy || "不明",
    }));
  if (entries.length + files.length > maximumEvidence)
    throw new InputError(
      "週報の根拠が500件を超えています。省略して全件扱いにせず停止しました",
    );
  return {
    period,
    latestMeetingDate,
    entries,
    files,
    warnings: [
      ...(!entries.length
        ? [
            "対象期間の議事録から完了・Next Actionの記載を確認できませんでした。古い内容で補完していません。",
          ]
        : []),
      "Driveは最新の更新日時の記録です。すべての編集履歴・変更内容や作業完了を示すものではありません。",
      ...(cache?.error
        ? ["Driveの取得に失敗しており、保存済み一覧を使っています。"]
        : []),
      ...(!Number.isFinite(Date.parse(cache?.lastSuccess)) ||
      now - Date.parse(cache.lastSuccess) > 3600000
        ? [
            "Driveの取得が未完了、または一覧が1時間以上前です。更新資料の見落としがあり得ます。",
          ]
        : []),
    ],
    lastDriveSuccess: cache?.lastSuccess || null,
  };
}
function bullets(entries, limit) {
  const selected = entries.slice(0, limit);
  return (
    selected
      .map(
        (entry) =>
          `・${entry.path ? entry.path + "：" : ""}${entry.kind === "progress" ? "（" + entry.stage + "）" : ""}${entry.text}`,
      )
      .join("\n") +
      (entries.length > limit
        ? `\n…ほか${entries.length - limit}件（根拠一覧を参照）`
        : "") || "対象期間の記載を確認できませんでした。"
  );
}
export function composeWeeklyReports(evidence) {
  const selected = new Map();
  for (const entry of [...evidence.entries].sort((a, b) =>
    b.meetingDate.localeCompare(a.meetingDate),
  )) {
    if (
      entry.kind === "next" &&
      entry.meetingDate !== evidence.latestMeetingDate
    )
      continue;
    const key = JSON.stringify([entry.kind, entry.path, entry.text]);
    if (!selected.has(key)) selected.set(key, entry);
  }
  const team = [...selected.values()],
    personal = team.filter((entry) => entry.personal);
  const block = (rows, limit) =>
    [
      "【進捗：議事録の記載】",
      bullets(
        rows.filter((e) => e.kind === "progress"),
        limit,
      ),
      "",
      "【Next Action：議事録の記載】",
      bullets(
        rows.filter((e) => e.kind === "next"),
        limit,
      ),
    ].join("\n");
  const period = evidence.period.startDate + "〜" + evidence.period.endDate;
  const updates =
    evidence.files
      .slice(0, 6)
      .map((file) => `・${file.name}（更新者：${file.lastModifiedBy}）`)
      .join("\n") || "対象期間の更新は保存済み一覧にありません。";
  const reports = {
    personal: `集客広報チームMTG｜本人の週報下書き｜${period}\n\n${block(personal, 15)}`,
    organizer: `Organizer向け｜集客広報の週報下書き｜${period}\n\n${block(team, 25)}\n\n【Driveで更新を確認した資料】\n${updates}\n\n【相談事項】\n${bullets(
      team.filter((e) => e.kind === "risks"),
      5,
    )}`,
    plenary: `全体定例向け｜集客広報の週報下書き｜${period}\n\n${block(team, 5)}`,
  };
  if (Object.values(reports).some((text) => text.length > 6000))
    throw new InputError(
      "報告文が6000文字を超えます。根拠を切り捨てず停止しました",
    );
  return reports;
}
