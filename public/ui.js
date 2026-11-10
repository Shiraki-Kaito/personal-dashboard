const el = (id) => document.getElementById(id);
const pollMs = 60000,
  staleMs = 2 * pollMs;
let state = null,
  busy = false,
  dirty = false;
function controls() {
  for (const id of ["saveStatus", "saveDue", "due", "status"])
    el(id).disabled = busy || !state?.remote || !!state.pending;
  for (const id of ["retry", "discard"])
    el(id).disabled = busy || !state?.pending;
  el("refresh").disabled = busy;
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
  el("status").firstChild.disabled = true;
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
  if (busy) return;
  busy = true;
  controls();
  try {
    const response = await fetch(
      "/api/" + action,
      action === "state"
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
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
await call("state");
await call("refresh");
setInterval(() => {
  if (!dirty && !document.hidden) call("refresh");
}, pollMs);
setInterval(age, 5000);
