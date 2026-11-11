const el = (id) => document.getElementById(id);
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
const pollMs = 60000,
  staleMs = 2 * pollMs;
let state = null,
  busy = false,
  dirty = false;
let projectId = null,
  itemId = null,
  catalogBusy = false;
function controls() {
  el("project").disabled = busy || catalogBusy;
  el("refreshList").disabled = busy || catalogBusy;
  for (const id of ["saveStatus", "saveDue", "due", "status"])
    el(id).disabled = busy || catalogBusy || !state?.remote || !!state.pending;
  for (const id of ["retry", "discard"])
    el(id).disabled = busy || catalogBusy || !state?.pending;
  el("refresh").disabled = busy || catalogBusy || !itemId;
}
function age() {
  el("age").textContent =
    state?.lastSuccess &&
    (state.error || Date.now() - Date.parse(state.lastSuccess) > staleMs)
      ? "保存済みの情報を表示しています。最新の状態を確認してください。"
      : "";
}
function render(s) {
  state = s;
  dirty = false;
  el("phase").textContent = s.phase;
  el("error").textContent =
    (s.error || "") +
    (s.retryAt
      ? " ／ 再取得可能 " + new Date(s.retryAt).toLocaleString("ja-JP")
      : "");
  const time = (v) => (v ? new Date(v).toLocaleString("ja-JP") : "なし");
  el("times").textContent =
    "最終試行 " +
    time(s.lastAttempt) +
    " ／ 最終取得成功 " +
    time(s.lastSuccess);
  el("source").href = s.projectUrl;
  el("count").textContent = s.remote
    ? "設定対象 1 件 ／ Project全体 " + s.remote.total + " 件"
    : "設定対象 1 件・取得前";
  el("title").textContent = s.remote?.title || "未取得";
  el("status").replaceChildren(
    new Option("未設定", ""),
    ...s.options.map((o) => new Option(o.name, o.id)),
  );
  el("status").value = s.remote?.status || "";
  el("due").value = s.remote?.due || "";
  el("changes").hidden = !s.pending;
  if (s.pending) {
    const { field, value, base } = s.pending;
    const display = (v) =>
      field === "status"
        ? s.options.find((o) => o.id === v)?.name || "未設定"
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
  age();
  controls();
}
async function call(action, body = {}) {
  if (busy || catalogBusy) return;
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
    render(result);
  } catch (e) {
    el("error").textContent = "通信・操作失敗（結果未確認） " + e.message;
    el("phase").textContent = "再取得が必要です";
  } finally {
    busy = false;
    controls();
  }
}
el("refresh").onclick = () => {
  if (!dirty || confirm("入力を破棄して再取得しますか？")) call("refresh");
};
for (const [id, field] of [
  ["saveStatus", "status"],
  ["saveDue", "due"],
]) {
  el(field).oninput = () => {
    dirty = true;
  };
  el(id).onclick = () =>
    call("edit", { field, value: el(field).value || null, base: state.remote });
}
el("retry").onclick = () => call("retry", { id: state.pending.id });
el("discard").onclick = () => {
  if (confirm("未同期の操作を破棄しますか？"))
    call("discard", { id: state.pending.id });
};
async function chooseTask(id) {
  if (
    busy ||
    catalogBusy ||
    (dirty && !confirm("入力を破棄してタスクを切り替えますか？"))
  )
    return;
  itemId = id;
  state = null;
  dirty = false;
  el("taskDetails").hidden = false;
  el("taskEditor").hidden = false;
  el("changes").hidden = true;
  controls();
  await call("state");
  await call("refresh");
}
async function loadCatalog(refresh) {
  if (catalogBusy || busy) return;
  catalogBusy = true;
  controls();
  el("project").disabled = true;
  el("refreshList").disabled = true;
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
    projectId = data.projectId;
    el("projectLink").href = data.projects.find((p) => p.id === projectId).url;
    el("project").replaceChildren(
      ...data.projects.map((p) => new Option(p.title, p.id)),
    );
    el("project").value = projectId;
    el("mode").textContent =
      data.projects.find((p) => p.id === projectId).mode === "production"
        ? "実運用データ"
        : "試験用データ";
    el("listStatus").textContent =
      (data.error || "") +
      " 最終取得成功 " +
      (data.lastSuccess
        ? new Date(data.lastSuccess).toLocaleString("ja-JP")
        : "未取得");
    el("listCount").textContent =
      data.total === null
        ? "一覧未取得"
        : "取得 " +
          data.items.length +
          " 件 ／ GitHub " +
          data.total +
          " 件（アーカイブを含む）";
    el("tasks").replaceChildren(
      ...data.items.map((item) => {
        const row = document.createElement("p"),
          button = document.createElement("button");
        button.textContent =
          item.title +
          (item.archived ? "（アーカイブ）" : "") +
          (item.pending ? "（未同期）" : "");
        button.disabled = !item.editable;
        button.onclick = () => chooseTask(item.id);
        row.append(button);
        return row;
      }),
    );
    if (data.total === 0)
      el("listStatus").textContent +=
        " ／ タスクはまだありません。Projectから追加できます。";
    el("source").href = data.projects.find((p) => p.id === projectId).url;
  } catch (error) {
    el("listStatus").textContent =
      "一覧取得失敗・保存済みの情報は古い可能性があります。" + error.message;
  } finally {
    catalogBusy = false;
    controls();
  }
}
el("refreshList").onclick = () => loadCatalog(true);
el("project").onchange = async () => {
  if (dirty && !confirm("入力を破棄してProjectを切り替えますか？")) {
    el("project").value = projectId;
    return;
  }
  projectId = el("project").value;
  itemId = null;
  state = null;
  dirty = false;
  el("tasks").replaceChildren();
  el("listStatus").textContent = "取得中";
  el("listCount").textContent = "";
  el("mode").textContent = "";
  el("projectLink").removeAttribute("href");
  el("taskDetails").hidden = true;
  el("taskEditor").hidden = true;
  el("changes").hidden = true;
  controls();
  await loadCatalog(true);
};
controls();
await loadCatalog(false);
await loadCatalog(true);
setInterval(() => {
  if (!dirty && !document.hidden) {
    if (itemId) call("refresh");
    else loadCatalog(true);
  }
}, pollMs);
setInterval(age, 5000);
