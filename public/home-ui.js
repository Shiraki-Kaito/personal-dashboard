import { createCalendarCard } from "./calendar-cards.js";
import { openTimingEditor } from "./timing-editor.js?v=calendar1";
import { sessionFetch as fetch } from "./session-connection.js";
import { confirmDiscard } from "./confirm.js";
const el = (id) => document.getElementById(id);
const pollMs = 60000;
const visibleTimingCount = 3;
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
function renderDrive() {
  const signature = JSON.stringify([
    state.drive.files,
    state.drive.stale,
    state.drive.connected,
    state.drive.scanning,
  ]);
  if (signature !== driveSignature) {
    driveSignature = signature;
    const rows = state.drive.files.map((file) => {
      const row = element("article", "home-row"),
        open = element("button", "home-task-open");
      open.type = "button";
      open.onclick = () => emit("dashboard:open-drive-file", { id: file.id });
      open.append(
        element("strong", "home-item-title", file.name),
        element(
          "span",
          "home-item-meta",
          "最終更新者：" + (file.lastModifiedBy || "未取得・不明") + " · 更新 " + time(file.modifiedTime),
        ),
        element(
          "span",
          "home-item-meta",
          file.events.join("・") + " · 検知 " + time(file.detectedAt),
        ),
        element("span", "home-item-meta", file.folder),
      );
      const review = element("button", "button button-small", "確認済み");
      review.type = "button";
      review.dataset.homeReview = "true";
      review.setAttribute("aria-label", file.name + "を確認済みにする");
      review.onclick = () =>
        emit("dashboard:review-drive", {
          id: file.id,
          changeId: file.changeId,
        });
      row.append(open, review);
      return row;
    });
    if (!rows.length)
      rows.push(
        empty(
          "未確認の変更はありません",
          state.drive.stale || !state.drive.connected
            ? "取得状況に警告があります。最新の状態とは限りません。"
            : state.drive.scanning
              ? "次の一覧を取得しています。完了後に照合します。"
              : "新しい変更は毎時の取得後に表示します。過去の全件はDrive画面から確認できます。",
        ),
      );
    replaceList(el("homeDriveFiles"), rows);
  }
  for (const button of el("homeDriveFiles").querySelectorAll(
    "[data-home-review]",
  ))
    button.disabled = busy || driveBusy;
}
function openMail(entry) {
  emit("dashboard:open-agenda", {accountId:entry.accountId, messageId:entry.messageId});
}
function renderSuggestions(agenda) {
  const groups = agenda.groups || [];
  const signature = JSON.stringify([groups, agenda.complete]);
  if (signature === agendaSignature) return;
  agendaSignature = signature;
  const rows = groups.map(group => {
    const row = element("article", "suggestion-card");
    if (group.priority) {
      row.dataset.priority = String(group.priority.rank);
      row.append(element("p", "suggestion-priority", group.priority.label));
    }
    row.append(element("p", "suggestion-case", group.label));
    row.append(element("h3", "suggestion-title", group.suggestion.title));
    row.append(element("p", "suggestion-reason", group.suggestion.reason));
    for (const notice of group.timingNotices || []) row.append(element("p", "timing-caution", notice.accountName + "：" + notice.message));
    if (group.timings?.length) {
      const timings = element("div", "suggestion-timings");
      const more = element("details", "timing-more");
      more.append(element("summary", "", `ほかの記載日時を確認（${Math.max(0,group.timings.length-visibleTimingCount)}件）`));
      for (const [index,timing] of group.timings.entries()) {
        const item = element("article", "suggestion-timing");
        item.dataset.confirmed = String(timing.confirmed);
        item.append(element("strong", "", timing.action));
        const label = timing.kind === "deadline" ? "締切" : timing.kind === "event" ? "予定日時" : "記載日時";
        item.append(element("p", "suggestion-when", `${label}：${timing.display}${timing.confirmed ? "" : " · 要確認"}`));
        item.append(element("p", "home-item-meta", timing.accountName || "接続アカウント"));
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
      if (group.timings.length > visibleTimingCount) timings.append(more);
      row.append(timings);
    } else if (!group.pending) row.append(element("p", "home-item-meta", "最新の保存済み案内に、採用できる具体的な締切・日時はありません。"));
    if (group.suggestion.checks?.length) {
      const checks = element("ul", "suggestion-checks");
      for (const check of group.suggestion.checks) checks.append(element("li", "", check));
      row.append(checks);
    }
    row.append(element("p", "home-item-meta", `ルールによる提案 · 根拠：最新のメール ${time(group.latestAt)}`));
    if (group.accountCount > 1) row.append(element("p", "home-item-meta", `${group.accountCount}アカウントに届いた案内です。宛先ごとに対応状況を確認してください。`));
    const action = element("button", "button button-primary", group.pending ? "登録結果を確認する" : "最新の案内を確認する");
    action.type = "button";
    action.onclick = () => openMail(group.entries[0]);
    row.append(action);
    const details = element("details", "suggestion-sources");
    details.append(element("summary", "", `根拠・関連メール ${group.entries.length}通`));
    details.append(element("p", "home-item-meta", group.basis + "。同一案件とは限らず、一括で処理しません。"));
    for (const entry of group.entries) {
      const item = element("article", "suggestion-source"), open = element("button", "home-task-open");
      open.type = "button";
      open.append(element("strong", "home-item-title", entry.title));
      open.append(element("span", "home-item-meta", (entry.accountName || entry.email) + " · " + time(entry.receivedAt)));
      open.onclick = () => openMail(entry);
      item.append(open);
      if (entry.excerpt) item.append(element("p", "suggestion-excerpt", "本文の抜粋：" + entry.excerpt));
      details.append(item);
    }
    row.append(details);
    return row;
  });
  if (!rows.length) rows.push(empty("未処理の重要メールはありません", agenda.complete ? "取得済みの全メールは「メール・予定」で確認できます。" : "未取得・取得失敗の警告も確認してください。"));
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
    (state.agenda?.entries.length || 0);
  const agenda = state.agenda || {
    accounts: [],
    entries: [],
    candidates: 0,
    pending: 0,
  };
  el("homeAgendaCount").textContent = agenda.groups?.length ?? agenda.entries.length;
  el("homeAgendaStatus").textContent = !agenda.accounts.length
    ? "未接続"
    : `${agenda.groups?.length ?? agenda.entries.length}件の確認案・関連メール ${agenda.candidates}通・結果未確認 ${agenda.pending}` +
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
