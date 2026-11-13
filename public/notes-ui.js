import { sessionFetch as fetch } from "./session-connection.js";
import { confirmAction } from "./confirm.js";
const el = (id) => document.getElementById(id);
const time = (value) =>
  value ? new Date(value).toLocaleString("ja-JP") : "未取得";
let state = null,
  busy = false,
  selected = null,
  readSequence = 0;
async function api(body) {
  const response = await fetch(
    "/api/notes",
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "ノートを取得できませんでした");
  return result;
}
function controls() {
  for (const node of el("notesForm").elements) node.disabled = busy;
  el("notesSave").disabled ||= !el("notesConfirm").checked;
  el("notesToken").disabled ||= !el("notesPrivate").checked;
  el("notesStop").disabled ||= !state?.configured;
  el("notesRefresh").disabled = busy || !state?.configured;
  for (const node of el("notesList").querySelectorAll("button"))
    node.disabled = busy || !!state?.stale || node.dataset.readable === "false";
}
function clearReader() {
  readSequence++;
  selected = null;
  el("noteTitle").textContent = "ノートを選択";
  el("noteBody").textContent =
    "一覧から選ぶと、Markdown原文を読み取り専用で表示します。";
  el("noteSource").hidden = true;
  el("noteSource").removeAttribute("href");
  el("noteStatus").textContent = "";
}
async function openNote(file) {
  if (busy || state.stale) return;
  clearReader();
  selected = file.path;
  const sequence = readSequence;
  busy = true;
  controls();
  el("noteTitle").textContent = file.path;
  el("noteBody").textContent = "";
  el("noteStatus").textContent = "本文を取得中…";
  try {
    const note = await api({ action: "read", path: file.path, sha: file.sha });
    if (sequence !== readSequence) return;
    // GitHubの固定ホストURLも検査し、Markdown/HTMLをDOMとして解釈しない。
    const url = new URL(note.url);
    if (url.origin !== "https://github.com") throw Error("参照先が不正です");
    el("noteBody").textContent = note.text;
    el("noteSource").href = url.href;
    el("noteSource").hidden = false;
    el("noteStatus").textContent =
      "コミット " + note.commit.slice(0, 8) + " の本文・読み取り専用";
  } catch (error) {
    if (sequence === readSequence) el("noteStatus").textContent = error.message;
  } finally {
    busy = false;
    renderList();
    controls();
  }
}
function renderList() {
  const query = el("notesSearch").value.trim().toLocaleLowerCase();
  const files = (state?.files || []).filter((file) =>
    file.path.toLocaleLowerCase().includes(query),
  );
  el("notesCount").textContent =
    files.length + " / " + (state?.files.length || 0) + "件";
  el("notesList").replaceChildren(
    ...files.map((file) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "notes-row";
      row.dataset.readable = String(file.readable);
      row.setAttribute("aria-pressed", String(selected === file.path));
      row.textContent =
        file.path + (file.readable ? "" : "（本文サイズ上限超過）");
      row.disabled = busy || state.stale || !file.readable;
      row.onclick = () => openNote(file);
      return row;
    }),
  );
  if (!files.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = state?.configured
      ? "一致するノートがありません"
      : "取得対象を設定すると、ノートがここに並びます";
    el("notesList").append(empty);
  }
}
function render() {
  el("homeNotesStatus").textContent =
    " ／ " +
    (state.configured
      ? "ノート " + state.files.length + "件" + (state.stale ? "・要更新" : "")
      : "ノート未設定");
  el("notesStatus").textContent = !state.configured
    ? "取得対象は未設定です。設定欄でリポジトリとフォルダを指定してください。"
    : state.config.owner +
      "/" +
      state.config.repo +
      " ／ " +
      (state.config.folder || "ルート") +
      " ／ 最終試行 " +
      time(state.lastAttempt) +
      " ／ 最終成功 " +
      time(state.lastSuccess) +
      (state.stale ? " ／ 古い一覧・本文取得は更新後に可能" : "") +
      (state.error ? " ／ " + state.error : "") +
      (state.retryAt ? " ／ 再試行可能 " + time(state.retryAt) : "");
  renderList();
  controls();
}
async function run(action) {
  if (busy) return;
  busy = true;
  controls();
  clearReader();
  try {
    state = await action();
    render();
  } catch (error) {
    el("notesStatus").textContent = error.message;
  } finally {
    busy = false;
    controls();
  }
}
el("notesForm").onsubmit = async (event) => {
  event.preventDefault();
  if (!el("notesConfirm").checked || busy) return;
  const body = {
    action: "configure",
    confirm: true,
    repository: el("notesRepository").value,
    folder: el("notesFolder").value,
    branch: el("notesBranch").value,
    private: el("notesPrivate").checked,
    token: el("notesPrivate").checked ? el("notesToken").value : "",
  };
  // DOMに秘密値を残さず、送信後の応答へも含めない。
  el("notesToken").value = "";
  await run(() => api(body));
  el("notesConfirm").checked = false;
  controls();
};
el("notesConfirm").onchange = controls;
el("notesPrivate").onchange = controls;
el("notesSearch").oninput = renderList;
el("notesRefresh").onclick = () => run(() => api({ action: "refresh" }));
el("notesStop").onclick = async () => {
  if (
    busy ||
    !state?.configured ||
    !(await confirmAction(
      "ノートの接続設定・専用トークン・一覧をこのサイトから削除します。GitHub上のノートは変更しません。GitHub側のトークン無効化は別途必要です。",
      "接続を削除する",
    ))
  )
    return;
  await run(() => api({ action: "stop", confirm: true }));
};
run(async () => {
  const view = await api();
  if (view.config) {
    el("notesRepository").value =
      "https://github.com/" + view.config.owner + "/" + view.config.repo;
    el("notesFolder").value = view.config.folder;
    el("notesBranch").value = view.config.branch;
    el("notesPrivate").checked = view.config.private;
  } else el("notesSettings").open = true;
  return view;
});
