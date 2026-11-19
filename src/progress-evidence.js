import { InputError } from "./sync.js";
import { minutesParagraphs } from "./weekly-report.js";

export const meetingKinds = ["personal", "organizer", "plenary"];
export const validReportDate = (value) =>
  typeof value === "string" &&
  /^20\d\d-\d\d-\d\d$/.test(value) &&
  Number.isFinite(Date.parse(value + "T00:00:00Z")) &&
  new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
export const normalizedText = (value) =>
  String(value || "")
    .normalize("NFKC")
    .replace(/[\s・●○\-：:]+/g, " ")
    .trim();
const dateIn = (text) => {
  const match = String(text).match(
    /(20\d\d)[年/.-](\d{1,2})[月/.-](\d{1,2})日?/,
  );
  const value =
    match &&
    `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  return value && validReportDate(value) ? value : null;
};
const samePerson = (text, reporter) =>
  (Array.isArray(reporter) ? reporter : [reporter]).some(
    (name) =>
      normalizedText(text).replaceAll(" ", "") ===
      normalizedText(name).replaceAll(" ", ""),
  );
const markerKind = (text) =>
  /^(完了|完了タスク|Done|成果)$/i.test(text)
    ? "done"
    : /^(Next\s*Actions?|次にすること|未完了|TODO|今後の予定)$/i.test(text)
      ? "next"
      : /^(相談.*|共有.*|課題|判断事項|調整事項)$/.test(text)
        ? "consult"
        : null;
const unfinished =
  /未完了|未実施|未公開|未承認|確認待ち|承認待ち|検討中|作業中|予定|見込み|できていない/;
export function progressStage(text) {
  if (/草案|ドラフト/.test(text)) return "草案作成";
  if (/一部|部分/.test(text)) return "一部完了";
  if (/相互告知|相互広報|告知実施/.test(text)) return "相互告知などの実施";
  if (/連携確定|連携合意|連携承認/.test(text)) return "連携確定";
  if (/打ち合わせ.*(?:実施|完了)|打合せ.*(?:実施|完了)/.test(text))
    return "打ち合わせ実施";
  if (/打ち合わせ.*(?:予定|調整)|打合せ.*(?:予定|調整)/.test(text))
    return "打ち合わせ予定";
  if (/返信|交渉/.test(text)) return "返信・交渉";
  if (/初回連絡|初回.*送信|連絡済/.test(text)) return "初回連絡";
  if (/候補/.test(text)) return "候補整理";
  if (/公開/.test(text)) return "公開";
  if (/承認/.test(text)) return "承認";
  if (/依頼/.test(text)) return "依頼";
  if (/実施/.test(text)) return "実施";
  return "資料・作業";
}

// 日付・担当者・完了の明示がない記載を、更新日時から実績へ格上げしない。
export function documentFacts(document, source, reporter) {
  const facts = [],
    dates = [],
    checks = [];
  let meetingDate = null,
    stack = [],
    section = null,
    heading = "",
    tab = null;
  const rows = minutesParagraphs(document);
  for (const [rowIndex, row] of rows.entries()) {
    if (row.tabId !== tab) {
      tab = row.tabId;
      meetingDate = null;
      stack = [];
      section = null;
    }
    const text = row.text.trim();
    if (row.tableCell) {
      if (!checks.some((check) => check.code === "doc_table"))
        checks.push({
          code: "doc_table",
          sourceId: source.id,
          message:
            "Docsの表の列関係は未対応です。表内の値を完了タスクとして推測せず除外しました",
        });
      continue;
    }
    const chip =
      row.dates.length === 1 && Number.isFinite(Date.parse(row.dates[0]))
        ? new Date(Date.parse(row.dates[0]) + 9 * 3600000)
            .toISOString()
            .slice(0, 10)
        : null;
    const date = chip || dateIn(text) || dateIn(row.tabTitle);
    const dateHeading =
      (row.heading.startsWith("HEADING_") || row.level === null) &&
      (/定例|議事録|MTG|Meeting/i.test(text) ||
        /^20\d\d[年/.-]\d/.test(text) ||
        (!text && !!chip));
    if (date && dateHeading) {
      meetingDate = date;
      dates.push(date);
      stack = [];
      section = null;
      heading = text || row.tabTitle;
      continue;
    }
    if (!meetingDate && dateIn(row.tabTitle)) {
      meetingDate = dateIn(row.tabTitle);
      dates.push(meetingDate);
    }
    if (!text) continue;
    const marker = markerKind(text);
    if (marker && row.level === null) {
      section = marker;
      continue;
    }
    if (row.level !== null) {
      stack.length = Math.min(stack.length, row.level);
      stack[row.level] = text;
    }
    const parents =
      row.level === null ? [] : stack.slice(0, -1).filter(Boolean);
    const kind =
      [...parents].reverse().map(markerKind).find(Boolean) || section;
    if (
      marker ||
      /^(進捗報告|Contents|Agenda)$/i.test(text) ||
      samePerson(text, reporter) ||
      row.heading.startsWith("HEADING_") ||
      (row.level !== null &&
        rows[rowIndex + 1]?.tabId === row.tabId &&
        rows[rowIndex + 1]?.level > row.level)
    )
      continue;
    if (!kind) continue;
    const explicit = dateIn(text);
    const completionMatch = text.match(
      /(?:完了日|実施日|公開日|承認日)[：:\s]*(20\d\d[年/.-]\d{1,2}[月/.-]\d{1,2}日?)/,
    );
    const dueMatch =
      text.match(
        /(?:期限|締切|予定日)[：:\s]*(20\d\d[年/.-]\d{1,2}[月/.-]\d{1,2}日?)/,
      ) || text.match(/(20\d\d[年/.-]\d{1,2}[月/.-]\d{1,2}日?)\s*まで/);
    const eventDate = completionMatch
      ? dateIn(completionMatch[1])
      : meetingDate;
    const names = Array.isArray(reporter) ? reporter : [reporter];
    const personal =
      parents.some((label) => samePerson(label, reporter)) ||
      names.some(
        (name) => text.startsWith(name + "：") || text.startsWith(name + ":"),
      );
    const entry = {
      text,
      kind,
      personal,
      owner: personal
        ? Array.isArray(reporter)
          ? reporter[0]
          : reporter
        : null,
      date: eventDate,
      meetingDate,
      heading,
      path: parents.join(" / "),
      stage: progressStage(text),
      due: dueMatch ? dateIn(dueMatch[1]) : null,
      entity: null,
      sourceId: source.id,
      tabId: row.tabId,
      index: row.index,
      taskKey: normalizedText(
        text
          .replace(/(?:期限|締切|予定日)[：:\s]*20\d\d.*$/, "")
          .replace(
            /(?:未完了|完了|実施済|公開済|作業中|進行中|済み|済)[。.!！]*$/,
            "",
          ),
      ).toLowerCase(),
    };
    if (!eventDate) {
      checks.push({
        message: "実施日・議事録の日付を確認できない記載",
        sourceId: source.id,
        text,
      });
      continue;
    }
    if (kind === "done" && unfinished.test(text)) {
      checks.push({
        message: "完了欄と未完了・予定の記載が食い違います",
        sourceId: source.id,
        text,
      });
      continue;
    }
    entry.dateBasis = !!completionMatch
      ? "本文に明記された実施・完了日"
      : "議事録に報告された日。実施日は別途明示されていません";
    if (
      kind === "done" &&
      /先週|先月|昨年|前回|持ち越し|繰り越し|以前から/.test(text) &&
      eventDate === meetingDate
    ) {
      checks.push({
        message:
          "以前の実績を指す表現があります。実施日と新規性を確認してください",
        sourceId: source.id,
        text,
      });
      continue;
    }
    facts.push(entry);
  }
  if (!facts.length)
    checks.push({
      message:
        "対応する見出し・日付・担当者付きの完了／Next Actionsを抽出できませんでした",
      sourceId: source.id,
    });
  return { facts, dates: [...new Set(dates)].sort(), checks };
}

// シートは列名で意味を確認する。行番号や更新日時から担当・実施日・状態を推測しない。
export function spreadsheetFacts(sheets, source, reporter) {
  const facts = [],
    checks = [];
  const column = (header, pattern) =>
    header.findIndex((value) => pattern.test(value));
  for (const sheet of sheets) {
    const rows = sheet.values || [];
    const headerIndex = rows
      .slice(0, 10)
      .findIndex(
        (row) =>
          row.some((cell) =>
            /^(タスク|作業|内容|取り組み|団体名|コミュニティ名)$/.test(
              String(cell).trim(),
            ),
          ) &&
          row.some((cell) => /状態|ステータス|進捗|段階/.test(String(cell))),
      );
    if (headerIndex < 0) {
      checks.push({
        message: "列の意味を判定できないシートです",
        sourceId: source.id,
        heading: sheet.title,
      });
      continue;
    }
    const header = rows[headerIndex].map((value) => String(value).trim());
    const title = column(header, /^(タスク|作業|内容|取り組み)$/),
      entity = column(header, /^(団体名|コミュニティ名)$/),
      status = column(header, /状態|ステータス|進捗|段階/),
      owner = column(header, /^(担当|担当者|責任者)$/),
      completed = column(header, /^(完了日|実施日|公開日|承認日|段階実施日)$/),
      due = column(header, /期限|締切|予定日/),
      team = column(header, /^(チーム|担当チーム)$/);
    for (const [index, row] of rows.slice(headerIndex + 1).entries()) {
      if (!row.some(Boolean)) continue;
      const state = String(row[status] || "").trim(),
        organization = entity >= 0 ? String(row[entity] || "").trim() : null;
      const subject = String(
        title >= 0 ? row[title] || "" : organization || "",
      ).trim();
      if (!subject || !state) {
        checks.push({
          message:
            "作業・団体名または状態が空欄です。Next Actionsと推測していません",
          sourceId: source.id,
          heading: sheet.title,
          text: subject || "行 " + (index + headerIndex + 2),
        });
        continue;
      }
      if (/^(中止|取消|取り消し|対象外|辞退|見送り)$/.test(state)) {
        checks.push({
          message: "中止・対象外の記載です。完了やNext Actionsへ移していません",
          sourceId: source.id,
          heading: sheet.title,
          text: subject + "：" + state,
        });
        continue;
      }
      const text = [subject, state].filter(Boolean).join("：");
      if (!text) continue;
      const date = completed >= 0 ? dateIn(row[completed]) : null;
      const isDone =
        /^(完了|済|実施済|公開済|承認済|連携確定|初回連絡済|返信済|打ち合わせ実施済|相互告知済)$/.test(
          state,
        );
      const personal = owner >= 0 && samePerson(row[owner], reporter);
      if (isDone && !date) {
        checks.push({
          message: "完了・段階実施の日付が不明です",
          text,
          sourceId: source.id,
          heading: sheet.title,
        });
        continue;
      }
      facts.push({
        text,
        kind: isDone ? "done" : "next",
        personal,
        owner: owner >= 0 ? String(row[owner] || "") : null,
        date,
        meetingDate: null,
        heading: sheet.title,
        path: team >= 0 ? String(row[team] || "") : "",
        stage: progressStage(state + " " + text),
        due: due >= 0 ? dateIn(row[due]) : null,
        entity: organization,
        sourceId: source.id,
        tabId: String(sheet.id),
        index: index + headerIndex + 2,
        taskKey: organization
          ? normalizedText(organization) +
            ":" +
            (title >= 0 ? normalizedText(row[title]) : progressStage(state))
          : title >= 0
            ? normalizedText(row[title])
            : null,
      });
    }
  }
  return { facts, dates: [], checks };
}

export function defaultReportPeriod(date, kind, sources) {
  if (!validReportDate(date))
    throw new InputError("報告対象日を確認してください");
  const previous = sources
    .filter((source) => source.role === kind)
    .flatMap((source) => source.dates || [])
    .filter((day) => day < date)
    .sort()
    .at(-1);
  return {
    startDate:
      previous ||
      new Date(Date.parse(date + "T00:00:00Z") - 6 * 86400000)
        .toISOString()
        .slice(0, 10),
    endDate: date,
    provisional: !previous,
  };
}
const factKey = (fact) =>
  normalizedText(fact.text)
    .toLowerCase()
    .replace(/(?:しました|した|です|完了|済み|済)[。.!！]*$/g, "")
    .replace(/(?:完了|済み|済)$/g, "");
const teamName = (value) => normalizedText(value).replace(/^\d+[_\s-]*/, "");
const belongs = (source, fact, team) => {
  const headingMatches = fact.path
    .split(" / ")
    .some((part) => teamName(part) === teamName(team.name));
  if (
    ["organizer", "plenary"].includes(source.role) &&
    source.folder.split(" / ").length === 1
  )
    return headingMatches;
  return (
    source.folder === team.path ||
    source.folder.startsWith(team.path + " / ") ||
    headingMatches
  );
};

export function composeProgressReports({
  request,
  sources,
  teams,
  previous = [],
}) {
  const previousDates = previous
    .filter(
      (record) =>
        record.status === "final" &&
        record.request.kind === request.kind &&
        record.request.reportDate < request.reportDate &&
        (request.kind !== "personal" ||
          record.request.reporter === request.reporter) &&
        record.results.some((result) =>
          teams.some((team) => team.path === result.team.path),
        ),
    )
    .map((record) => record.request.reportDate);
  const period = request.startDate
    ? {
        startDate: request.startDate,
        endDate: request.endDate || request.reportDate,
        provisional: false,
      }
    : defaultReportPeriod(request.endDate || request.reportDate, request.kind, [
        ...sources,
        { role: request.kind, dates: previousDates },
      ]);
  if (
    !validReportDate(period.startDate) ||
    !validReportDate(period.endDate) ||
    period.startDate > period.endDate ||
    period.endDate > request.reportDate ||
    Date.parse(period.endDate) - Date.parse(period.startDate) > 366 * 86400000
  )
    throw new InputError("対象期間は報告日以前の366日以内で指定してください");
  const results = [];
  for (const team of teams) {
    const applicable = sources.filter(
      (source) =>
        source.facts.some((fact) => belongs(source, fact, team)) ||
        source.folder === team.path ||
        source.folder.startsWith(team.path + " / "),
    );
    const baseline = previous
      .filter(
        (record) =>
          record.status === "final" &&
          record.request.kind === request.kind &&
          record.request.reportDate < request.reportDate &&
          (request.kind !== "personal" ||
            record.request.reporter === request.reporter) &&
          record.results.some((result) => result.team.path === team.path),
      )
      .sort((a, b) =>
        b.request.reportDate.localeCompare(a.request.reportDate),
      )[0];
    const baselineResult = baseline?.results.find(
      (result) => result.team.path === team.path,
    );
    const teamPeriod = request.startDate
      ? period
      : defaultReportPeriod(
          request.endDate || request.reportDate,
          request.kind,
          [
            ...applicable,
            {
              role: request.kind,
              dates: baseline ? [baseline.request.reportDate] : [],
            },
          ],
        );
    const finalDone =
      baselineResult?.text
        ?.split(/(?:^|\n)完了\n/)[1]
        ?.split(/\nNext Actions/)[0] || "";
    const baselineKeys = new Set(
      (baselineResult?.items || [])
        .filter(
          (item) =>
            item.kind === "done" &&
            normalizedText(finalDone).includes(normalizedText(item.text)),
        )
        .map(factKey),
    );
    const checks = applicable.flatMap((source) =>
      (source.checks || []).map((check) => ({ ...check, sourceId: source.id })),
    );
    const ambiguous = sources
      .filter((source) => ["organizer", "plenary"].includes(source.role))
      .flatMap((source) =>
        source.facts.filter((fact) => !belongs(source, fact, team)),
      );
    if (ambiguous.length)
      checks.push({
        message: `共通議事録で${team.name}の担当範囲を確認できない${ambiguous.length}項目は除外しました`,
      });
    const allFacts = applicable.flatMap((source) =>
      source.facts
        .filter((fact) => belongs(source, fact, team))
        .map((fact) => ({
          ...fact,
          sourceRole: source.role,
          modifiedTime: source.modifiedTime,
        })),
    );
    const fallbackDate = applicable
      .filter((source) => source.role === request.kind)
      .flatMap((source) => source.dates || [])
      .filter((date) => date < request.reportDate)
      .sort()
      .at(-1);
    if (!baseline)
      for (const fact of allFacts.filter(
        (fact) =>
          fact.kind === "done" &&
          fact.date &&
          fact.date <= (fallbackDate || teamPeriod.startDate),
      ))
        baselineKeys.add(factKey(fact));
    if (!baseline && !fallbackDate)
      checks.push({
        message:
          "前回の同じ定例の確定版・議事録を確認できませんでした。新規性を確認してください",
      });
    const latestMeetings = new Map();
    for (const fact of allFacts)
      if (fact.meetingDate && fact.meetingDate <= request.reportDate)
        latestMeetings.set(
          fact.sourceId,
          [latestMeetings.get(fact.sourceId) || "", fact.meetingDate]
            .sort()
            .at(-1),
        );
    const selected = new Map();
    for (const fact of allFacts.sort((a, b) =>
      (b.date || "").localeCompare(a.date || ""),
    )) {
      if (request.kind === "personal" && !fact.personal) continue;
      if (fact.date && fact.date > request.reportDate) continue;
      if (
        fact.kind === "done" &&
        (!fact.date ||
          fact.date < teamPeriod.startDate ||
          fact.date > teamPeriod.endDate ||
          baselineKeys.has(factKey(fact)))
      )
        continue;
      if (
        fact.kind === "consult" &&
        fact.meetingDate &&
        fact.meetingDate !== latestMeetings.get(fact.sourceId)
      )
        continue;
      if (
        fact.kind === "next" &&
        fact.meetingDate &&
        fact.meetingDate !== latestMeetings.get(fact.sourceId)
      )
        continue;
      if (
        fact.kind === "consult" &&
        (!fact.date ||
          fact.date < teamPeriod.startDate ||
          fact.date > teamPeriod.endDate)
      )
        continue;
      const key = fact.kind + ":" + factKey(fact);
      if (selected.has(key)) {
        selected.get(key).references.push(fact);
        continue;
      }
      selected.set(key, {
        ...fact,
        references: [fact],
        change: baseline
          ? "前回確定版にない記載"
          : "前回議事録と期間を照合（確定版なし）",
        countBasis: /累計|合計|総数/.test(fact.text)
          ? "累計の記載（加算しない）"
          : fact.entity && fact.date
            ? "対象期間と段階実施日を照合"
            : "件数の期間区分は未確認・加算しない",
      });
    }
    const items = [...selected.values()];
    const conflictKeys = new Set();
    for (const item of items) {
      const contradiction =
        item.taskKey &&
        items.find(
          (other) =>
            other !== item &&
            other.taskKey === item.taskKey &&
            other.kind !== item.kind,
        );
      if (!contradiction) continue;
      if (item.date && contradiction.date && item.date !== contradiction.date) {
        if (item.date < contradiction.date) conflictKeys.add(item);
      } else {
        conflictKeys.add(item);
        checks.push({
          message:
            "同じ作業の状態が資料間で食い違います。完了状況を確認してください",
          sourceId: item.sourceId,
          text: item.text,
        });
      }
    }
    const accepted = items.filter((item) => !conflictKeys.has(item));
    for (const item of accepted)
      if (item.kind === "next" && item.due && item.due < request.reportDate)
        checks.push({
          message:
            "期限超過・完了状況の確認が必要です（未完了と断定していません）",
          sourceId: item.sourceId,
          text: item.text,
          due: item.due,
        });
    const title = request.kind === "personal" ? request.reporter : team.name;
    const limit = request.kind === "plenary" ? 4 : 6;
    const lines = (kind) =>
      accepted
        .filter(
          (item) =>
            item.kind === kind &&
            !(kind === "next" && item.due && item.due < request.reportDate),
        )
        .slice(0, limit)
        .map(
          (item) =>
            "・" +
            (item.stage === "草案作成" || item.stage === "一部完了"
              ? "【" + item.stage + "】"
              : "") +
            item.text +
            (item.due && dateIn(item.text) !== item.due
              ? "（期限 " + item.due + "）"
              : ""),
        )
        .join("\n");
    let text =
      title +
      "\n\n完了\n" +
      (lines("done") || "新規の完了実績は確認できませんでした") +
      "\n\nNext Actions\n" +
      (lines("next") || "確認できる新しいNext Actionsはありませんでした");
    if (lines("consult")) text += "\n\n相談・共有事項\n" + lines("consult");
    const community = {};
    for (const fact of allFacts.filter(
      (fact) =>
        fact.entity &&
        fact.date &&
        fact.date <= request.reportDate &&
        fact.kind === "done" &&
        (request.kind !== "personal" || fact.personal),
    )) {
      const group = (community[fact.stage] ||= {
        period: new Set(),
        cumulative: new Set(),
      });
      group.cumulative.add(normalizedText(fact.entity));
      if (
        fact.date >= teamPeriod.startDate &&
        fact.date <= teamPeriod.endDate &&
        !(baselineResult?.items || []).some(
          (old) =>
            old.entity &&
            normalizedText(old.entity) === normalizedText(fact.entity) &&
            old.stage === fact.stage,
        )
      )
        group.period.add(normalizedText(fact.entity));
    }
    if (text.length > 6000 || accepted.length > 300)
      throw new InputError(
        "報告と根拠の上限を超えています。資料・期間を絞ってください",
      );
    results.push({
      team,
      period: teamPeriod,
      text,
      items: accepted,
      checks,
      community: Object.fromEntries(
        Object.entries(community).map(([stage, counts]) => [
          stage,
          {
            period: counts.period.size,
            cumulative: counts.cumulative.size,
            basis:
              "読めた資料内・団体の重複を除いた段階別件数。団体間・段階間を合算しない",
          },
        ]),
      ),
      comparison: {
        newDone: accepted.filter((item) => item.kind === "done").length,
        continuedNext: accepted.filter(
          (item) =>
            item.kind === "next" &&
            (baselineResult?.items || []).some(
              (old) => factKey(old) === factKey(item),
            ),
        ).length,
        previousOnly: (baselineResult?.items || [])
          .filter(
            (old) => !accepted.some((item) => factKey(item) === factKey(old)),
          )
          .map((item) => item.text),
      },
      baseline: baseline
        ? { id: baseline.id, date: baseline.request.reportDate, kind: "確定版" }
        : {
            kind: fallbackDate
              ? "該当定例の議事録（読み取り範囲内）"
              : "前回比較元なし",
          },
      omitted: ["done", "next", "consult"].reduce(
        (sum, kind) =>
          sum +
          Math.max(
            0,
            accepted.filter(
              (item) =>
                item.kind === kind &&
                !(kind === "next" && item.due && item.due < request.reportDate),
            ).length - limit,
          ),
        0,
      ),
    });
  }
  return {
    period: {
      ...period,
      startDate:
        results.map((result) => result.period.startDate).sort()[0] ||
        period.startDate,
      provisional: results.some((result) => result.period.provisional),
    },
    results,
  };
}
