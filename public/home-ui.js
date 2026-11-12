import { confirmDiscard } from "./confirm.js";
const el = (id) => document.getElementById(id);
const pollMs = 60000;
let state = null,
  busy = false,
  driveBusy = false,
  category = "priority",
  taskSignature = "",
  driveSignature = "";
const time = (value) =>
  value ? new Date(value).toLocaleString("ja-JP") : "未取得";
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
        state.complete
          ? "Driveの未確認も右の一覧で確認できます。全タスクは各分類とタスク画面に表示します。"
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
  el("homeAgendaCount").textContent = agenda.entries.length;
  el("homeAgendaStatus").textContent = !agenda.accounts.length
    ? "未接続"
    : `${agenda.accounts.length}アカウント・重要メール ${agenda.candidates}・結果不明 ${agenda.pending}` +
      (agenda.accounts.some((a) => a.hasMore) ? "・未取得の続きあり" : "");
  const agendaRows = agenda.entries.map((entry) => {
    const row = element("button", "home-task-open");
    row.type = "button";
    row.append(
      element("strong", "home-item-title", entry.title),
      element(
        "span",
        "home-item-meta",
        entry.reason + " · " + (entry.accountName || entry.email),
      ),
    );
    row.onclick = () =>
      emit("dashboard:open-agenda", {
        accountId: entry.accountId,
        messageId: entry.messageId,
      });
    return row;
  });
  if (!agendaRows.length)
    agendaRows.push(
      empty(
        "取得済みの範囲に未処理の重要メールはありません",
        agenda.accounts.length
          ? agenda.complete
            ? "全メールと確認済みの項目はメール画面で確認できます。"
            : "未取得・古さ・取得失敗の警告を確認してください。全メールはメール画面で確認できます。"
          : "メール・予定画面から接続できます。",
      ),
    );
  replaceList(el("homeAgendaEntries"), agendaRows);
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
    if (response.status === 401) {
      location.replace("/");
      return;
    }
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
document.addEventListener("dashboard:refresh", () => {
  if (document.body.dataset.view === "home") load(true);
});
document.addEventListener("dashboard:view", (event) => {
  if (event.detail === "home") load(true);
});
document.addEventListener("dashboard:drive-reviewed", () => load(false));
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
