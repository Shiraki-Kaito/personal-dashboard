import { openSplitManager } from "./mail-split-manager.js";
import { openMailSplit } from "./mail-split-editor.js";
import { openMailCase } from "./mail-case-editor.js";
import { createCalendarCard } from "./calendar-cards.js";
import { openTimingEditor } from "./timing-editor.js?v=calendar1";
import { sessionFetch as fetch } from "./session-connection.js";
import { confirmDiscard } from "./confirm.js";
const el = (id) => document.getElementById(id);
const pollMs = 60000;
const visibleTimingCount = 3;
let caseFilter = "open";
let state = null,
  busy = false,
  reloadAfterBusy = false,
  driveBusy = false,
  category = "priority",
  taskSignature = "",
  driveSignature = "",
  agendaSignature = "",
  calendarSignature = "";
const time = (value) =>
  value ? new Date(value).toLocaleString("ja-JP", {timeZone:"Asia/Tokyo"}) : "未取得";
const emit = (name, detail) =>
  document.dispatchEvent(new CustomEvent(name, { detail }));
function showPanel(panel) {
  emit("dashboard:show-panel", { panel });
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function replaceList(container, rows) {
  const scroll = container.scrollTop;
  container.replaceChildren(...rows);
  container.scrollTop = scroll;
}
function empty(title, hint) {
  const node = element("div", "empty-state");
  node.append(element("p", "", title), element("small", "", hint));
  return node;
}
function sourceLink(url) {
  const link = element("a", "home-source-link", "↗");
  try {
    const target = new URL(url);
    if (target.protocol === "https:" && target.hostname === "github.com")
      link.href = target.href;
  } catch {
    return element("span", "home-source-link", "—");
  }
  link.target = "_blank";
  link.rel = "noreferrer";
  link.setAttribute("aria-label", "GitHubで確認");
  return link;
}
function renderTasks() {
  const tasks = state.tasks.filter((task) => task.category === category);
  document.querySelector(".home-tasks-card").dataset.empty = String(!tasks.length);
  const githubFresh = state.sources.length && state.sources.every(source => !source.stale);
  el("homeHeading").textContent = tasks.length ? "要確認タスク"
    : !githubFresh ? "タスクの取得状況を確認してください"
    : category === "priority" ? "要確認タスクはありません"
    : category === "done" ? "完了タスクはありません" : "その他のタスクはありません";
  const signature = JSON.stringify([
    category,
    state.complete,
    state.alerts,
    tasks.map(({ lastSuccess, ...task }) => task),
  ]);
  if (signature === taskSignature) return;
  taskSignature = signature;
  const rows = tasks.map((task) => {
    const row = element("article", "home-row"),
      button = element("button", "home-task-open");
    button.type = "button";
    button.disabled = !task.actionable;
    button.onclick = () =>
      emit("dashboard:open-task", {
        projectId: task.projectId,
        itemId: task.id,
      });
    button.append(element("strong", "home-item-title", task.title));
    const tags = element("span", "home-tags");
    for (const reason of task.reasons)
      tags.append(element("span", "home-reason", reason));
    if (task.stale)
      tags.append(element("span", "home-reason home-stale", "保存済み"));
    if (tags.childNodes.length) button.append(tags);
    button.append(
      element(
        "span",
        "home-item-meta",
        [
          task.projectTitle,
          task.archived ? "アーカイブ" : task.statusName,
          task.fieldsComplete
            ? task.due
              ? "期限 " + task.due
              : "期限なし"
            : "期限未取得",
        ]
          .filter(Boolean)
          .join(" · "),
      ),
    );
    row.append(button, sourceLink(task.url || task.projectUrl));
    if (task.outOfCatalog && task.pendingId) {
      const discard = element("button", "button button-small", "変更を破棄");
      discard.type = "button";
      discard.onclick = async () => {
        if (
          busy ||
          !(await confirmDiscard(
            "一覧にないタスクの未同期操作を破棄します。GitHubには書き込みません。",
          ))
        )
          return;
        discard.disabled = true;
        try {
          const response = await fetch("/api/abandon", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectId: task.projectId,
              itemId: task.id,
              id: task.pendingId,
            }),
          });
          if (!response.ok)
            throw Error("変更を破棄できません。最新の状態を確認してください。");
          await load(false);
        } catch (error) {
          emit("dashboard:home-error", error.message);
        } finally {
          discard.disabled = false;
        }
      };
      row.append(discard);
    }
    return row;
  });
  if (!rows.length)
    rows.push(
      empty(
        category === "priority"
          ? "要確認のタスクはありません"
          : category === "done"
            ? "完了タスクはありません"
            : "その他のタスクはありません",
        state.sources.length && state.sources.every(source => !source.stale)
          ? "全タスクは「その他」「完了」から確認できます。"
          : "取得が未完了または古い情報です。上の警告と取得時刻を確認してください。",
      ),
    );
  replaceList(el("homeTasks"), rows);
}
function driveFileRow(file, pending = true) {
  const row = element("article", "home-team-update");
  const open = element("button", "home-task-open");
  open.type = "button";
  open.onclick = () => emit("dashboard:open-drive-file", { id: file.id });
  const title = element("strong", "home-item-title", file.name);
  title.title = file.name;
  const modified = file.modifiedTime ? new Date(file.modifiedTime).toLocaleString("ja-JP", {timeZone:"Asia/Tokyo",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}) : "更新時刻不明";
  const actor = element("span", "home-item-meta", "最終更新者：" + (file.lastModifiedBy || "不明"));
  const updated = element("span", "home-item-meta", "更新 " + modified);
  updated.title = "更新 " + time(file.modifiedTime) + (pending ? " ／ 検知 " + time(file.detectedAt) : "");
  open.append(title,actor,updated);
  if (pending) open.append(element("span", "home-team-events", (file.events || []).join("・")));
  row.append(open);
  if (pending) {
    const review = element("button", "home-team-review", "確認済み");
    review.type = "button";
    review.dataset.homeReview = "true";
    review.setAttribute("aria-label", file.name + "を確認済みにする");
    review.onclick = () => emit("dashboard:review-drive", {id:file.id,changeId:file.changeId});
    row.append(review);
  }
  return row;
}
function openDriveGroup(path) {
  showPanel("drive");
  emit("dashboard:open-drive-group", {path});
}
function renderDrive() {
  const signature = JSON.stringify([state.drive.groups,state.drive.stale,state.drive.connected,state.drive.scanning]);
  if (signature !== driveSignature) {
    driveSignature = signature;
    const grid = element("div", "home-drive-teams");
    for (const group of state.drive.groups?.highlighted || []) {
      const card = element("section", "home-drive-team");
      card.dataset.groupColor = group.color;
      card.setAttribute("aria-label", group.name + "の更新");
      const header = element("div", "home-team-heading");
      header.append(element("h3", "", group.name),element("span", "home-team-count", "未確認 " + group.pendingCount));
      card.append(header);
      const progress = element("div", "home-team-progress");
      const status = element("span", "group-status", "進捗：" + group.status);
      status.dataset.status = group.status;
      const next = element("p", "home-team-next", group.nextAction || "次にすることは未設定です");
      next.title = group.nextAction || "";
      const due = element("p", "home-team-due", group.due ? "期限 " + group.due.replaceAll("-","/") + "（日本時間）" : "期限未設定");
      if (group.due && group.status !== "完了") {
        const today = new Date(Date.now()+9*3600000).toISOString().slice(0,10);
        if (group.due < today) { due.classList.add("group-overdue"); due.append(" · 期限超過"); }
        else if (group.due === today) due.append(" · 今日が期限");
      }
      if (group.updatedAt) progress.title = "設定保存 " + time(group.updatedAt);
      progress.append(status,next,due);
      card.append(progress);
      for (const file of group.updates) card.append(driveFileRow(file));
      if (!group.updates.length) {
        card.append(element("p", "home-team-empty", state.drive.stale || !state.drive.connected ? "保存情報です。最新の取得状況を確認してください。" : state.drive.scanning ? "取得中・前回の未確認なし" : "未確認の更新はありません"));
        if (group.latest) {
          card.append(element("p", "home-team-caption", "直近の更新（確認済みも含む）"),driveFileRow(group.latest,false));
        } else if (!group.available) card.append(element("p", "home-team-caption", "現在の取得範囲にファイルはありません"));
      }
      const more = element("button", "home-team-more", group.remaining ? "ほか" + group.remaining + "件・一覧を開く ↗" : "チームの一覧を開く ↗");
      more.type = "button"; more.onclick = () => openDriveGroup(group.path);
      const edit = element("button", "home-team-edit", "進捗を編集");
      edit.type="button"; edit.dataset.homeGroupEdit="true";
      edit.dataset.editable=String(!!group.path);
      edit.setAttribute("aria-label",group.name+"の進捗を編集");
      edit.onclick=()=>emit("dashboard:edit-drive-group",{path:group.path});
      card.append(more,edit); grid.append(card);
    }
    const other = element("details", "home-drive-other");
    other.append(element("summary", "", "その他のグループ（"+(state.drive.groups?.others.length || 0)+"）"));
    const links = element("div", "home-other-links");
    for (const group of state.drive.groups?.others || []) {
      const link = element("button", "home-other-group", group.name + " · 未確認 " + group.pendingCount);
      link.dataset.groupColor = group.color; link.type="button"; link.onclick=()=>openDriveGroup(group.path); links.append(link);
    }
    other.append(links);
    replaceList(el("homeDriveFiles"), [grid,other]);
  }
  for (const button of el("homeDriveFiles").querySelectorAll("[data-home-review]")) button.disabled = busy || driveBusy;
  for (const button of el("homeDriveFiles").querySelectorAll("[data-home-group-edit]")) button.disabled = busy || driveBusy || button.dataset.editable !== "true";
}
function openMail(entry) {
  emit("dashboard:open-agenda", {accountId:entry.accountId, messageId:entry.messageId});
}
function renderSuggestions(agenda) {
  const groups = agenda.groups || [];
  const signature = JSON.stringify([groups, agenda.caseHistory, agenda.splitRevision, caseFilter, agenda.complete]);
  if (signature === agendaSignature) return;
  agendaSignature = signature;
  const rows = groups.filter(group => group.pending || (group.caseState?.status || "open") === caseFilter).map(group => {
    const row = element("article", "suggestion-card");
    if (group.priority && (group.caseState?.status || "open") === "open") {
      row.dataset.priority = String(group.priority.rank);
      row.append(element("p", "suggestion-priority", group.priority.label));
    }
    if (group.caseState?.status === "done" || group.caseState?.status === "hold") row.append(element("p", "suggestion-priority", group.caseState.status === "done" ? "対応済み" : "保留"));
    row.append(element("p", "suggestion-case", group.label));
    row.append(element("h3", "suggestion-title", group.suggestion.title));
    row.append(element("p", "suggestion-reason", group.suggestion.reason));
    if(group.suggestion.evidence) row.append(element("p", "suggestion-evidence", "判断に使った記載："+group.suggestion.evidence));
    for(const notice of group.historyNotices || []) row.append(element("p", "timing-caution",notice));
    if((group.currentSources?.length || 0)>1) {
      const latest = element("details", "suggestion-current-sources");
      latest.append(element("summary", "", "宛先別の最新案内・判断根拠を確認"));
      for(const source of group.currentSources) {
        const item = element("article", "suggestion-source");
        item.append(element("strong", "",source.accountName || "接続アカウント"));
        item.append(element("p", "home-item-meta", source.recency+" · "+time(source.receivedAt)));
        item.append(element("p", "", source.title),element("p", "", source.suggestion.title));
        if(source.suggestion.evidence) item.append(element("p", "suggestion-excerpt", "判断に使った記載："+source.suggestion.evidence));
        const open=element("button", "text-button", "この宛先の案内を開く ↗");open.type="button";open.onclick=()=>openMail(source);item.append(open);latest.append(item);
      }
      row.append(latest);
    }
    const proposalTimings=group.proposalTimings || group.timings || [];
    if ((group.caseState?.status || "open") !== "open" && proposalTimings.some(timing => timing.followUp)) {
      row.append(element("p", "timing-caution", "受付後の日時候補があります。保存済みの対応状態を維持しています。元の案内を確認し、必要なら未対応へ戻して日時を確定してください。"));
    }
    for (const notice of group.timingNotices || []) row.append(element("p", "timing-caution", notice.accountName + "：" + notice.message));
    if ((group.caseState?.status || "open") === "open" && proposalTimings.length) {
      const timings = element("div", "suggestion-timings");
      const more = element("details", "timing-more");
      more.append(element("summary", "", `ほかの記載日時を確認（${Math.max(0,proposalTimings.length-visibleTimingCount)}件）`));
      for (const [index,timing] of proposalTimings.entries()) {
        const item = element("article", "suggestion-timing");
        item.dataset.confirmed = String(timing.confirmed);
        item.append(element("strong", "", timing.action));
        const label = timing.kind === "deadline" ? "締切" : timing.kind === "event" ? "予定日時" : "記載日時";
        item.append(element("p", "suggestion-when", `${label}：${timing.display}${timing.confirmed ? "" : " · 要確認"}`));
        item.append(element("p", "home-item-meta", timing.accountName || "接続アカウント"));
        if(timing.receiptNotice) item.append(element("p", "timing-caution",timing.receiptNotice));
        if(timing.changeNotice) item.append(element("p", "timing-caution",timing.changeNotice));
        if (timing.manual) item.append(element("p", "timing-confirmed", "本人確定 · 保存 " + time(timing.manual.confirmedAt)));
        if (timing.manual) {
          if (timing.calendarPhase) item.append(element("p", "home-item-meta", "カレンダー："+timing.calendarPhase));
          const calendar = element("button", "button button-small", timing.calendarPhase ? "登録結果を確認" : "予定の登録内容を確認");
          calendar.type = "button";
          calendar.onclick = ()=>emit("dashboard:calendar-from-timing", {accountId:timing.accountId,timingRef:{messageId:timing.messageId,timingId:timing.timingId,sourceRevision:timing.sourceRevision,revision:timing.revision}});
          item.append(calendar);
        }
        if (timing.reasons.length) item.append(element("p", "timing-caution", timing.reasons.join("・")));
        if (timing.sourceStale) item.append(element("p", "timing-caution", "保存済みメールです。取得状況と、案内が今も有効か確認してください。"));
        const evidence = element("details", "timing-evidence");
        evidence.append(element("summary", "", "日時の根拠を確認"));
        evidence.append(element("p", "suggestion-excerpt", timing.evidence));
        const open = element("button", "text-button", "この日時の元メールを開く ↗");
        open.type = "button";
        open.onclick = () => openMail(timing);
        evidence.append(open);
        item.append(evidence);
        if (timing.timingId) {
          const edit = element("button", "button button-small", timing.manual ? "確定日時を編集・解除" : "日時を修正・確定");
          edit.type = "button";
          edit.onclick = ()=>openTimingEditor(timing);
          item.append(edit);
        }
        (index < visibleTimingCount ? timings : more).append(item);
      }
      if (proposalTimings.length > visibleTimingCount) timings.append(more);
      row.append(timings);
    } else if (!group.pending && (group.caseState?.status || "open") === "open") row.append(element("p", "home-item-meta", "最新の保存済み案内に、採用できる具体的な締切・日時はありません。"));
    if(group.referenceTimings?.length) {
      const reference=element("details", "suggestion-reference-timings");
      reference.append(element("summary", "", `受付済み・変更前などの参考日時（${group.referenceTimings.length}件）`));
      for(const timing of group.referenceTimings) {
        const item=element("article", "suggestion-source");
        item.append(element("p", "",timing.display),element("p", "home-item-meta",timing.referenceReason));
        const open=element("button", "text-button", "参考日時の元メールを開く ↗");open.type="button";open.onclick=()=>openMail(timing);item.append(open);reference.append(item);
      }
      row.append(reference);
    }
    if ((group.caseState?.status || "open") === "open" && group.suggestion.checks?.length) {
      const checks = element("ul", "suggestion-checks");
      for (const check of group.suggestion.checks) checks.append(element("li", "", check));
      row.append(checks);
    }
    row.append(element("p", "home-item-meta", `ルールによる提案 · ${group.chronologyUncertain ? "最新候補（前後未確定）" : "最新の保存済み案内"} ${time(group.latestAt)}`));
    if (group.accountCount > 1) row.append(element("p", "home-item-meta", `${group.accountCount}アカウントに届いた案内です。宛先ごとに対応状況を確認してください。`));
    const action = element("button", "button button-primary", group.pending ? "登録結果を確認する" : group.chronologyUncertain ? "案内の候補を確認する" : "最新の案内を確認する");
    action.type = "button";
    action.onclick = () => openMail(group.entries[0]);
    row.append(action);
    if (group.caseState) {
      const record = group.caseState;
      if (record.notice) row.append(element("p", "timing-caution", record.notice));
      if (record.note) row.append(element("p", "case-note", "メモ：" + record.note));
      if (record.status === "hold") row.append(element("p", "home-item-meta", record.snoozeUntil ? "再表示 " + record.snoozeUntil.replaceAll("-", "/") + "（日本時間0時）" : "再表示日なし・保留一覧から戻せます"));
      if (record.updatedAt) row.append(element("p", "home-item-meta", "対応状況の保存 " + time(record.updatedAt)));
      const edit = element("button", "button button-small", "案件の対応状況を変更");
      edit.type = "button"; edit.onclick = () => openMailCase(group);
      row.append(edit);
      const split = element("button", "button button-small", "案件を分ける・メールを移す");
      split.type="button"; split.onclick=()=>openMailSplit(group,agenda); row.append(split);
      if(group.manualCaseId) {
        const manage = element("button", "button button-small", "案件名を変更・分類を管理");
        manage.type="button"; manage.onclick=()=>openSplitManager(agenda,group.manualCaseId); row.append(manage);
        const reset = element("button", "button button-small", "自動のまとめ方に戻す");
        reset.type="button"; reset.onclick=()=>openMailSplit(group,agenda,true); row.append(reset);
      }
    }
    const details = element("details", "suggestion-sources");
    details.append(element("summary", "", `根拠・関連メール ${group.entries.length}通`));
    details.append(element("p", "home-item-meta", group.pending ? "登録結果の未確認は独立した照合案として表示します。案件の状態変更では隠しません。" : group.basis + "。同一案件とは限りません。案件の状態保存は、このカードに含まれる関連メール全体が対象です。"));
    for (const entry of group.entries) {
      const item = element("article", "suggestion-source"), open = element("button", "home-task-open");
      open.type = "button";
      open.append(element("strong", "home-item-title", entry.title));
      open.append(element("span", "home-item-meta", (entry.accountName || entry.email || "接続アカウント") + " · " + time(entry.receivedAt) + " · " + (entry.recency || "関連案内")));
      open.onclick = () => openMail(entry);
      item.append(open);
      if (entry.excerpt) item.append(element("p", "suggestion-excerpt", "本文の抜粋：" + entry.excerpt));
      details.append(item);
    }
    row.append(details);
    return row;
  });
  for (const record of agenda.caseHistory || []) if (record.status === caseFilter) {
    const row = element("article", "suggestion-card case-archived");
    row.append(element("h3", "suggestion-case", record.label), element("p", "home-item-meta", "現在のホームにこの案件のメール一覧がありません。保存済みの対応記録です。"));
    if (record.note) row.append(element("p", "case-note", "メモ：" + record.note));
    if (record.snoozeUntil) row.append(element("p", "home-item-meta", "再表示日 " + record.snoozeUntil + "（日本時間0時）"));
    row.append(element("p", "home-item-meta", "保存 " + time(record.updatedAt)));
    const reopen = element("button", "button button-small", "保存記録を未対応に戻す");
    reopen.type = "button"; reopen.onclick = () => openMailCase(record, true); row.append(reopen); rows.push(row);
  }
  if (!rows.length) rows.push(empty(caseFilter === "open" ? "未対応の重要メール案件はありません" : caseFilter === "hold" ? "保留の案件はありません" : "対応済みの案件はありません", agenda.complete ? "取得済みの全メールは「メール・予定」で確認できます。" : "未取得・取得失敗の警告も確認してください。"));
  replaceList(el("homeAgendaEntries"), rows);
}
function renderCalendar() {
  const calendar = state.calendar;
  if (!calendar) return;
  const signature = JSON.stringify([calendar, Math.floor(Date.now() / pollMs)]);
  if (signature === calendarSignature) return;
  calendarSignature = signature;
  const now = Date.now();
  const upcoming = calendar.events.filter(event => Date.parse(event.end.dateTime || event.end.date + "T00:00:00+09:00") > now);
  el("homeCalendarStatus").textContent = (calendar.complete ? "取得した7日間・日本時間" : "保存済み・古さや取得失敗を確認してください") + ` · ${upcoming.length}件`;
  replaceList(el("homeCalendarEvents"), upcoming.length ? upcoming.map(createCalendarCard) : [empty("直近の予定はありません", calendar.complete ? "取得した7日間に、これからの予定はありません。" : "未取得または保存済み情報です。メール・予定で取得状況を確認してください。")]);
}
function render() {
  if (!state) return;
  for (const key of ["priority", "other", "done"]) {
    el("home" + key[0].toUpperCase() + key.slice(1) + "Count").textContent =
      state.counts[key];
  }
  el("homeDriveCount").textContent = state.counts.drive;
  el("navHomeCount").textContent =
    state.counts.priority +
    state.counts.drive +
    (state.agenda?.groups?.filter(group=>group.pending || group.caseState?.status === "open").length || 0) +
    (state.agenda?.caseHistory?.filter(record=>record.status === "open").length || 0);
  const agenda = state.agenda || {
    accounts: [],
    entries: [],
    candidates: 0,
    pending: 0,
  };
  el("homeManageSplits").disabled = !state.agenda;
  el("homeManageSplits").textContent = "分割案件を管理（"+(agenda.splitCases?.length || 0)+"）";
  const countCases = status => (agenda.groups || []).filter(group => group.pending ? status === "open" : (group.caseState?.status || "open") === status).length + (agenda.caseHistory || []).filter(record => record.status === status).length;
  el("homeAgendaCount").textContent = countCases("open");
  for (const [id, status, label] of [["homeCaseOpen","open","未対応"],["homeCaseHold","hold","保留"],["homeCaseDone","done","対応済み"]]) {
    el(id).textContent = label + " " + countCases(status);
    el(id).setAttribute("aria-pressed", String(caseFilter === status));
  }
  el("homeAgendaStatus").textContent = !agenda.accounts.length
    ? "未接続"
    : `未対応 ${countCases("open")}件・保留 ${countCases("hold")}件・対応済み ${countCases("done")}件・結果未確認 ${agenda.pending}（全タブに表示）` +
      (agenda.accounts.some((a) => a.hasMore) ? "・未取得の続きあり" : "");
  renderSuggestions(agenda);
  renderCalendar();
  el("homeHealthDetails").hidden = !state.alerts.length;
  el("homeHealthSummary").textContent = `接続・取得に警告があります（${state.alerts.length}件）`;
  el("homeAlerts").hidden = !state.alerts.length;
  el("homeAlerts").replaceChildren(
    ...state.alerts.map((alert) => element("p", "", alert.message)),
  );
  const lastSuccess = state.sources
    .map((source) => source.lastSuccess)
    .filter(Boolean)
    .sort()[0];
  el("homeGithubTime").textContent =
    (state.sources.some((source) => source.stale) ? "保存済み " : "取得 ") +
    time(lastSuccess);
  el("homeSourceCount").textContent =
    "実運用 " +
    state.sources.length +
    " Project・GitHub " +
    state.sources.reduce((sum, source) => sum + (source.total || 0), 0) +
    "件";
  el("homeDriveTime").title =
    "個人作業の未確認 " +
    (state.drive.personalCount || 0) +
    "件はDriveの個人作業で確認できます";
  el("homeDriveTime").textContent =
    (state.drive.stale ? "保存済み " : "取得 ") + time(state.drive.lastSuccess);
  if (document.body.dataset.view === "home") {
    el("metricTasksLabel").textContent = "実運用タスク";
    el("metricTasks").textContent =
      state.sources.length &&
      state.sources.every((source) => source.detailsReady)
        ? state.sources.reduce((sum, source) => sum + (source.total || 0), 0)
        : "—";
    el("metricPending").textContent =
      "未同期 " + state.tasks.filter((task) => task.pending).length + "件";
  }
  renderTasks();
  renderDrive();
}
async function load(refresh = false) {
  if (busy) return;
  busy = true;
  el("homeRefresh").disabled = true;
  emit("dashboard:busy", { service: "home", busy });
  render();
  try {
    const response = await fetch(
      "/api/home",
      refresh
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refresh: true }),
          }
        : {},
    );

    if (!response.ok) throw Error("ホームの取得に失敗しました");
    state = await response.json();
    el("homeNotice").hidden = true;
  } catch (error) {
    el("homeNotice").textContent =
      error.message + "。表示中の情報は最新とは限りません。";
    el("homeNotice").hidden = false;
  } finally {
    busy = false;
    el("homeRefresh").disabled = false;
    emit("dashboard:busy", { service: "home", busy });
    render();
    if (reloadAfterBusy) { reloadAfterBusy = false; void load(false); }
  }
}
for (const [id, value] of [
  ["homePriorityTab", "priority"],
  ["homeOtherTab", "other"],
  ["homeDoneTab", "done"],
])
  el(id).onclick = () => {
    category = value;
    for (const [tab, mode] of [
      ["homePriorityTab", "priority"],
      ["homeOtherTab", "other"],
      ["homeDoneTab", "done"],
    ]) {
      el(tab).classList.toggle("selected", mode === category);
      el(tab).setAttribute("aria-pressed", String(mode === category));
    }
    renderTasks();
  };
el("homeRefresh").onclick = () => load(true);
el("homeOpenDrive").onclick = () => showPanel("drive");
el("homeOpenCalendar").onclick = () => showPanel("agenda");
document.addEventListener("dashboard:refresh", () => {
  if (document.body.dataset.view === "home") load(true);
});
document.addEventListener("dashboard:view", (event) => {
  if (event.detail === "home") load(true);
});
document.addEventListener("dashboard:drive-reviewed", () => load(false));
document.addEventListener("dashboard:drive-group-saved", event => {
  el("homeDriveGroupStatus").textContent=event.detail.name+"の進捗・設定の保存を確認しました";
  load(false);
});
document.addEventListener("dashboard:agenda-changed", () => {
  if (busy) reloadAfterBusy = true;
  else load(false);
});
document.addEventListener("dashboard:busy", (event) => {
  if (event.detail.service === "drive") {
    driveBusy = event.detail.busy;
    if (state) renderDrive();
  }
});
document.addEventListener("dashboard:home-error", (event) => {
  el("homeNotice").hidden = false;
  el("homeNotice").textContent = event.detail;
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && document.body.dataset.view === "home") load(true);
});
await load(true);
setInterval(() => {
  if (!document.hidden && document.body.dataset.view === "home") load(true);
}, pollMs);

for (const [id, status] of [["homeCaseOpen","open"],["homeCaseHold","hold"],["homeCaseDone","done"]]) el(id).onclick = () => { caseFilter = status; agendaSignature = ""; render(); };
document.addEventListener("dashboard:case-saved", event => { el("homeCaseStatus").textContent = ({open:"未対応",hold:"保留",done:"対応済み"})[event.detail] + "の保存を確認しました"; });

document.addEventListener("dashboard:split-saved",event=>{caseFilter="open"; agendaSignature=""; if(state) render(); el("homeCaseStatus").textContent=event.detail;});

el("homeManageSplits").onclick=()=>{if(state?.agenda)openSplitManager(state.agenda);};
