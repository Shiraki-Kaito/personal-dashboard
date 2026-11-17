import { calendarEventText } from "./calendar-cards.js";

// 概要では件数と直近2件だけを示す。元の一覧・確認状態・並び順は変更しない。
export function overviewSummary(state, now = Date.now()) {
  const tasks = (state.tasks || []).filter(task => task.category === "priority");
  const groups = (state.agenda?.groups || []).filter(group => group.pending || (group.caseState?.status || "open") === "open");
  const history = (state.agenda?.caseHistory || []).filter(record=>record.status === "open");
  const events = (state.calendar?.events || []).filter(event =>
    Date.parse(event.end.dateTime || event.end.date + "T00:00:00+09:00") > now,
  );
  const teams = state.drive?.groups?.highlighted || [];
  return {
    tasks: { count:tasks.length, lines:tasks.slice(0,2).map(task=>task.title),
      hint:!state.sources?.length || state.sources.some(source=>source.stale) ? "保存情報・取得状況を確認" : tasks.length ? "状態・期限を確認" : "要確認のタスクはありません" },
    mail: { count:groups.length+history.length, lines:[...groups,...history].slice(0,2).map(group=>[group.label,group.suggestion?.title,(group.proposalTimings || group.timings || [])[0]?.display].filter(Boolean).join(" · ")),
      hint:!state.agenda?.accounts?.length ? "メールは未接続" : state.agenda?.pending ? "登録結果が未確認です" : (groups.length+history.length ? groups[0]?.priority?.label || "押して対応内容を確認" : "未対応の重要案件はありません") },
    calendar: { count:events.length, lines:events.slice(0,2).map(event=>event.title + " · " + calendarEventText(event)),
      hint:state.calendar?.complete ? "今日から7日間・日本時間" : "保存情報・取得状況を確認" },
    drive: { count:teams.length, lines:teams.slice(0,4).map(group=>group.name + " · 報告を作成"),
      hint:state.drive?.stale || !state.drive?.connected ? "保存情報・取得状況を確認" : "チーム別の進捗・更新" },
  };
}
