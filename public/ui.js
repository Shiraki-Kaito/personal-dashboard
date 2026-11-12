import { confirmDiscard } from "./confirm.js";
import { TaskDrafts } from "./task-drafts.js";
const drafts = new TaskDrafts();
const el = (id) => document.getElementById(id);
const pollMs = 60000,
  staleMs = 2 * pollMs;
let state = null,
  catalogState = null,
  busy = false,
  catalogBusy = false,
  requestError = null,
  catalogError = null,
  dirty = false,
  projectId = null,
  itemId = null;
const time = (value) =>
  value ? new Date(value).toLocaleString("ja-JP") : "なし";
el("logout").onsubmit = async (event) => {
  event.preventDefault();
  const button = el("logout").querySelector("button");
  if (button.disabled) return;
  button.disabled = true;
  try {
    const response = await fetch("/auth/logout", { method: "POST" });
    if (!response.ok) throw Error("ログアウトに失敗しました");
    location.replace("/");
  } catch (error) {
    el("error").textContent = error.message;
    button.disabled = false;
  }
};
function controls() {
  const working = busy || catalogBusy;
  el("project").disabled = working;
  el("refreshList").disabled = working;
  for (const id of ["saveStatus", "saveDue", "due", "status"])
    el(id).disabled = working || !state?.remote || !!state.pending;
  el("saveStatus").disabled ||= !drafts.entries.has("status");
  el("saveDue").disabled ||= !drafts.entries.has("due");
  for (const id of ["retry", "discard"])
    el(id).disabled = working || !state?.pending;
  el("refresh").disabled = working || !itemId;
  document.dispatchEvent(
    new CustomEvent("dashboard:busy", {
      detail: { service: "github", busy: working },
    }),
  );
}
function age() {
  el("age").textContent =
    state?.lastSuccess &&
    (state.error || Date.now() - Date.parse(state.lastSuccess) > staleMs)
      ? "保存済みの情報"
      : "";
}
function connection() {
  const failed = !!(
    state?.error ||
    catalogState?.error ||
    requestError ||
    catalogError
  );
  el("githubDot").dataset.state = failed ? "error" : catalogState ? "ok" : "";
  el("githubConnection").textContent = failed
    ? "GitHub 取得失敗"
    : catalogState
      ? "GitHub 接続済み"
      : "GitHub 確認中";
}
function renderRows() {
  if (!catalogState) return;
  const query = el("taskSearch").value.trim().toLocaleLowerCase();
  const items = catalogState.items.filter((item) =>
    item.title.toLocaleLowerCase().includes(query),
  );
  const rows = items.map((item) => {
    const row = document.createElement("button"),
      check = document.createElement("span"),
      body = document.createElement("span"),
      title = document.createElement("span"),
      meta = document.createElement("span");
    row.className = "task-row" + (item.id === itemId ? " selected" : "");
    row.disabled = !item.editable;
    row.setAttribute("aria-pressed", String(item.id === itemId));
    check.className = "task-check";
    check.setAttribute("aria-hidden", "true");
    title.className = "task-title";
    title.textContent = item.title;
    title.title = item.title;
    meta.className = "task-meta";
    meta.textContent = item.archived
      ? "アーカイブ"
      : item.id === itemId && state?.remote
        ? (state.options.find((o) => o.id === state.remote.status)?.name ||
            "状態未設定") + (state.remote.due ? " · " + state.remote.due : "")
        : "GitHub Projects";
    body.append(title, meta);
    row.append(check, body);
    if (item.pending) {
      const tag = document.createElement("span");
      tag.className = "task-tag pending";
      tag.textContent = "未同期";
      row.append(tag);
    }
    row.onclick = () => chooseTask(item.id);
    return row;
  });
  el("tasks").replaceChildren(...rows);
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const message = document.createElement("p");
    message.textContent = query
      ? "一致するタスクがありません"
      : "タスクはまだありません";
    const hint = document.createElement("small");
    hint.textContent = query
      ? "検索語を変えてみてください"
      : "Projectを開いて追加できます";
    empty.append(message, hint);
    el("tasks").append(empty);
  }
}
function render(s) {
  state = s;
  dirty = drafts.dirty;
  el("phase").textContent = s.phase + (dirty ? " ／ 入力中・未反映" : "");
  el("error").textContent =
    (s.error || "") + (s.retryAt ? " ／ 再取得可能 " + time(s.retryAt) : "");
  el("times").textContent =
    "最終試行 " +
    time(s.lastAttempt) +
    " ／ 最終取得成功 " +
    time(s.lastSuccess);
  el("source").href = s.projectUrl;
  el("count").textContent = s.remote
    ? "選択したタスク1件 ／ Project全体 " + s.remote.total + "件"
    : "詳細は未取得です";
  el("title").textContent = s.remote?.title || "取得できませんでした";
  el("title").title = el("title").textContent;
  el("status").replaceChildren(
    new Option("未設定", ""),
    ...s.options.map((o) => new Option(o.name, o.id)),
  );
  const selectedStatus = drafts.value("status", s.remote);
  if (
    selectedStatus &&
    !s.options.some((option) => option.id === selectedStatus)
  ) {
    const missing = new Option(
      "選択肢が削除・変更されています",
      selectedStatus,
    );
    missing.disabled = true;
    el("status").append(missing);
  }
  el("status").value = drafts.value("status", s.remote) || "";
  el("due").value = drafts.value("due", s.remote) || "";
  el("changes").hidden = !s.pending;
  if (s.pending) {
    const { field, value, base } = s.pending;
    const display = (v) =>
      field === "status"
        ? s.options.find((o) => o.id === v)?.name ||
          (v ? "現在の選択肢にない状態" : "未設定")
        : v || "未設定";
    el("change").textContent =
      (field === "status" ? "状態" : "期限") +
      "　編集時 " +
      display(base[field]) +
      " → 希望 " +
      display(value) +
      " ／ GitHub " +
      display(s.remote?.[field]);
  }
  const item = catalogState?.items.find((item) => item.id === itemId);
  if (item) item.pending = !!s.pending;
  if (catalogState && document.body.dataset.view !== "home")
    el("metricPending").textContent =
      "未同期 " +
      catalogState.items.filter((item) => item.pending).length +
      "件";
  renderRows();
  age();
  connection();
  controls();
}
async function call(action, body = {}) {
  if (busy || catalogBusy || !itemId) return;
  const submitted =
    action === "edit"
      ? body
      : ["retry", "refresh"].includes(action)
        ? state?.pending
        : null;
  busy = true;
  controls();
  try {
    const response = await fetch(
      "/api/" +
        action +
        (action === "state"
          ? "?" + new URLSearchParams({ projectId, itemId })
          : ""),
      action === "state"
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, projectId, itemId }),
          },
    );
    if (response.status === 401) {
      location.replace("/");
      return;
    }
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "再取得してください");
    requestError = null;
    drafts.receive(result, submitted);
    render(result);
  } catch (error) {
    requestError = error.message;
    connection();
    el("error").textContent = "通信・操作失敗（結果未確認） " + error.message;
    el("phase").textContent = "再取得が必要です";
  } finally {
    busy = false;
    controls();
  }
}
el("refresh").onclick = async () => {
  if (
    !dirty ||
    (await confirmDiscard("入力中の変更を破棄し、GitHubから再取得します。"))
  ) {
    drafts.clear();
    call("refresh");
  }
};
for (const [id, field] of [
  ["saveStatus", "status"],
  ["saveDue", "due"],
]) {
  el(field).oninput = () => {
    drafts.edit(field, el(field).value || null, state.remote);
    dirty = drafts.dirty;
    el("phase").textContent = dirty ? "入力中・未反映" : state.phase;
    controls();
  };
  el(id).onclick = () => {
    const input = drafts.submission(field);
    if (input) call("edit", input);
  };
}
el("retry").onclick = () => call("retry", { id: state.pending.id });
el("discard").onclick = async () => {
  if (
    await confirmDiscard(
      "未同期のローカル変更を破棄し、GitHubの値を取得します。",
    )
  ) {
    drafts.clear();
    call("discard", { id: state.pending.id });
  }
};

async function chooseTask(id) {
  if (
    busy ||
    catalogBusy ||
    (dirty && !(await confirmDiscard("入力を破棄して別のタスクを表示します。")))
  )
    return;
  itemId = id;
  drafts.clear();
  state = null;
  dirty = false;
  el("taskEditor").hidden = false;
  el("taskDetails").hidden = false;
  el("changes").hidden = true;
  el("title").textContent = "取得中";
  renderRows();
  controls();
  await call("state");
  await call("refresh");
}
async function loadCatalog(refresh, autoSelect = true) {
  if (catalogBusy || busy) return;
  catalogBusy = true;
  controls();
  try {
    const response = await fetch("/api/catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, refresh }),
    });
    if (response.status === 401) {
      location.replace("/");
      return;
    }
    const data = await response.json();
    if (!response.ok) throw Error(data.error || "一覧取得失敗");
    catalogError = null;
    catalogState = data;
    projectId = data.projectId;
    const project = data.projects.find((p) => p.id === projectId);
    el("projectLink").href = project.url;
    el("source").href = project.url;
    el("project").replaceChildren(
      ...data.projects.map((p) => new Option(p.title, p.id)),
    );
    el("project").value = projectId;
    el("mode").textContent =
      project.mode === "production" ? "実運用" : "試験用";
    el("mode").dataset.test = String(project.mode !== "production");
    el("listStatus").textContent =
      data.error ||
      "最終取得 " +
        (data.lastSuccess
          ? new Date(data.lastSuccess).toLocaleTimeString("ja-JP", {
              hour: "2-digit",
              minute: "2-digit",
            })
          : "未取得");
    el("listStatus").dataset.state = data.error ? "error" : "";
    el("listCount").textContent =
      data.total === null
        ? "未取得"
        : data.items.length + " / " + data.total + "件";
    el("navTaskCount").textContent = data.total ?? "—";
    renderCatalogMetrics();
    renderRows();
    connection();
  } catch (error) {
    catalogError = error.message;
    connection();
    el("listStatus").textContent = "一覧取得失敗 " + error.message;
    el("listStatus").dataset.state = "error";
  } finally {
    catalogBusy = false;
    controls();
  }
  if (autoSelect && !itemId) {
    const first = catalogState?.items.find((item) => item.editable);
    if (first) await chooseTask(first.id);
  }
}
async function refreshCurrent() {
  if (busy || catalogBusy) return;
  if (
    dirty &&
    !(await confirmDiscard("入力中の変更を破棄して最新の一覧を取得します。"))
  )
    return;
  dirty = false;
  drafts.clear();
  await loadCatalog(true);
  if (itemId) await call("refresh");
}
el("refreshList").onclick = refreshCurrent;
el("taskSearch").oninput = renderRows;
el("project").onchange = async () => {
  if (
    dirty &&
    !(await confirmDiscard("入力を破棄してProjectを切り替えます。"))
  ) {
    el("project").value = projectId;
    return;
  }
  projectId = el("project").value;
  drafts.clear();
  itemId = null;
  state = null;
  catalogState = null;
  dirty = false;
  el("tasks").replaceChildren();
  el("listStatus").textContent = "一覧取得中";
  el("listCount").textContent = "";
  el("taskSearch").value = "";
  el("taskEditor").hidden = true;
  el("changes").hidden = true;
  controls();
  await loadCatalog(true);
};
document.addEventListener("dashboard:refresh", refreshCurrent);

function renderCatalogMetrics() {
  if (!catalogState || document.body.dataset.view === "home") return;
  el("metricTasksLabel").textContent = "GitHubタスク";
  el("metricTasks").textContent = catalogState.total ?? "—";
  el("metricPending").textContent =
    "未同期 " + catalogState.items.filter((item) => item.pending).length + "件";
}
document.addEventListener("dashboard:view", renderCatalogMetrics);
document.addEventListener("dashboard:open-task", async (event) => {
  if (busy || catalogBusy) return;
  if (
    dirty &&
    !(await confirmDiscard("入力中の変更を破棄し、ホームのタスクを開きます。"))
  )
    return;
  drafts.clear();
  dirty = false;
  const target = event.detail;
  document.dispatchEvent(
    new CustomEvent("dashboard:show-panel", { detail: { panel: "tasks" } }),
  );
  if (target.projectId !== projectId) {
    projectId = target.projectId;
    itemId = null;
    state = null;
    catalogState = null;
    el("taskEditor").hidden = true;
    el("taskSearch").value = "";
    await loadCatalog(false, false);
  }
  if (
    catalogState?.items.some(
      (item) => item.id === target.itemId && item.editable,
    )
  )
    await chooseTask(target.itemId);
  else {
    el("listStatus").textContent =
      "対象タスクを開けません。一覧を更新して元のProjectを確認してください。";
  }
});
window.addEventListener("beforeunload", (event) => {
  if (drafts.dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});
controls();
await loadCatalog(true);
setInterval(() => {
  if (
    !dirty &&
    !document.hidden &&
    document.body.dataset.view !== "home" &&
    !busy &&
    !catalogBusy
  ) {
    if (itemId) call("refresh");
    else loadCatalog(true);
  }
}, pollMs);
setInterval(age, 5000);
