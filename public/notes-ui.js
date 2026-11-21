import { sessionFetch as fetch } from "./session-connection.js";
import { confirmAction } from "./confirm.js";
import { mountNoteDraft } from "./note-draft-ui.js?v=compare1";
const el = (id) => document.getElementById(id);
const setDraftSource = mountNoteDraft(el("noteBody").parentElement, api);
const time = (value) =>
  value ? new Date(value).toLocaleString("ja-JP", {timeZone:"Asia/Tokyo"}) : "未取得";
let bodySearch = null;
let linksView = null, linksBusy = false;
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
  el("notesSearch").disabled = busy;
  el("notesBodySearch").disabled = busy || !state?.configured || state.stale;
  el("notesBodyMore").disabled = busy || !!state?.stale;
  el("notesBodyClear").disabled = busy;
  for (const node of el("notesForm").elements) node.disabled = busy;
  el("notesSave").disabled ||= !el("notesConfirm").checked;
  el("notesToken").disabled ||= !el("notesPrivate").checked;
  el("notesStop").disabled ||= !state?.configured;
  el("notesRefresh").disabled = busy || !state?.configured;
  for (const node of el("notesList").querySelectorAll("button"))
    node.disabled = busy || !!state?.stale || node.dataset.readable === "false";
  renderTaskLinks();
}
function clearReader() {
  setDraftSource(null);
  readSequence++;
  selected = null;
  el("noteTitle").textContent = "ノートを選択";
  el("noteBody").textContent =
    "一覧から選ぶと、Markdown原文を読み取り専用で表示します。";
  el("noteSource").hidden = true;
  el("noteSource").removeAttribute("href");
  el("noteStatus").textContent = "";
  renderTaskLinks();
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
    setDraftSource({ ...note, path: file.path, scope: JSON.stringify([state.config.owner,state.config.repo,state.config.branch,state.config.folder]) });
    el("noteSource").href = url.href;
    el("noteSource").hidden = false;
    el("noteStatus").textContent =
      "コミット " + note.commit.slice(0, 8) + " の本文・読み取り専用";
    if (el("noteTaskLinks").open) await loadTaskLinks();
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
  const files = bodySearch ? bodySearch.matches : (state?.files || []).filter((file) =>
    file.path.toLocaleLowerCase().includes(query),
  );
  el("notesCount").textContent =
    bodySearch ? files.length + "件一致（本文）" : files.length + " / " + (state?.files.length || 0) + "件";
  el("notesBodyMore").hidden = !bodySearch || bodySearch.nextOffset === null;
  el("notesBodyClear").hidden = !bodySearch;
  el("notesBodyMore").textContent = bodySearch?.error ? "失敗した位置から再試行" : "続きの5件を検索";
  el("notesBodySearchStatus").textContent = bodySearch
    ? `本文検索済み ${bodySearch.scanned}/${bodySearch.total}件・サイズ上限で未検索 ${bodySearch.skipped}件` +
      (bodySearch.nextOffset === null ? " ／ 一覧の末尾まで確認" : " ／ 未検索の続きがあります") +
      (bodySearch.error ? " ／ " + bodySearch.error.message + (bodySearch.error.retryAt ? "・再試行可能 " + time(bodySearch.error.retryAt) : "") : "")
    : "本文検索は5件ずつ取得します。検索語は2〜100文字。";
  el("notesList").replaceChildren(
    ...files.map((file) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "notes-row";
      row.dataset.readable = String(file.readable);
      row.setAttribute("aria-pressed", String(selected === file.path));
      row.textContent =
        file.path + (file.readable ? "" : "（本文サイズ上限超過）");
      if (bodySearch) {
        const snippet = document.createElement("span");
        snippet.className = "task-meta";
        snippet.textContent = `本文 ${file.line}行目：${file.snippet}`;
        row.append(snippet);
      }
      row.disabled = busy || state.stale || !file.readable;
      row.onclick = () => openNote(file);
      return row;
    }),
  );
  if (!files.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = state?.configured
      ? (bodySearch ? "検索済みの本文には一致がありません。未検索の続き・取得状況も確認してください" : "一致するノートがありません")
      : "取得対象を設定すると、ノートがここに並びます";
    el("notesList").append(empty);
  }
}
function render() {
  el("notesWorkspace").hidden = !state.configured;
  el("notesSearchBar").hidden = !state.configured;
  el("homeNotesStatus").textContent =
    " ／ " +
    (state.configured
      ? "ノート " + state.files.length + "件" + (state.stale ? "・要更新" : "")
      : "ノート未設定");
  el("notesStatus").textContent = !state.configured
    ? "接続準備中です。下の設定で、対象リポジトリ専用の読み取りトークンを登録してください。"
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
      (state.retryAt ? " ／ 再試行可能 " + time(state.retryAt) : "") +
      (state.automatic ? " ／ 毎時取得の起動 " + time(state.automatic.lastTriggeredAt) + (state.automatic.result === "failed" ? "・取得失敗" : state.automatic.result === "skipped" ? "・待機条件により見送り" : "") : " ／ 毎時取得の初回待ち");
  renderList();
  controls();
}
async function run(action) {
  if (busy) return;
  busy = true;
  controls();
  clearReader();
  bodySearch = null;
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
el("notesSearch").oninput = () => { bodySearch = null; renderList(); controls(); };
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

// 画面を開き直したときも、Cron後の一覧と認証失効を再確認する。
document.addEventListener("dashboard:view", event => {
  if (event.detail !== "notes" || busy) return;
  void run(async () => {
    const view = await api();
    return view.configured && view.stale && (!view.retryAt || view.retryAt <= Date.now())
      ? api({ action: "refresh" }) : view;
  });
});


async function searchBody(more = false) {
  if (busy || state?.stale || !state?.configured) return;
  const query = el("notesSearch").value.trim();
  if (query.length < 2 || query.length > 100) {
    el("notesBodySearchStatus").textContent = "検索語は2〜100文字で入力してください";
    return;
  }
  if ((bodySearch?.error?.retryAt || 0) > Date.now()) {
    el("notesBodySearchStatus").textContent = "GitHubの待機期限です。" + time(bodySearch.error.retryAt) + "以降に再試行してください";
    return;
  }
  const previous = more ? bodySearch : null;
  if (more && (!previous || previous.nextOffset === null)) return;
  busy = true;
  controls();
  el("notesBodySearchStatus").textContent = "本文を検索中…（最大5件）";
  try {
    const result = await api({action:"search",query,revision:state.searchRevision,offset:previous?.nextOffset || 0});
    bodySearch = {...result,
      scanned:(previous?.scanned || 0) + result.scanned,
      skipped:(previous?.skipped || 0) + result.skipped,
      matches:[...(previous?.matches || []),...result.matches]};
    renderList();
  } catch (error) {
    el("notesBodySearchStatus").textContent = error.message + "（以前の検索結果があれば保持しています）";
  } finally {
    busy = false;
    controls();
  }
}
el("notesBodySearch").onclick = () => searchBody();
el("notesBodyMore").onclick = () => searchBody(true);
el("notesBodyClear").onclick = () => { bodySearch = null; renderList(); controls(); };

function renderTaskLinks() {
  el("noteLinksList").replaceChildren();
  el("noteLinkChoice").replaceChildren(new Option("タスクを選択", ""));
  for (const [index, task] of (linksView?.candidates || []).entries()) {
    const option = new Option(task.projectTitle + " ／ " + task.title + (task.stale ? "（古い一覧）" : ""), String(index));
    option.disabled = task.stale;
    el("noteLinkChoice").append(option);
  }
  for (const link of linksView?.records || []) {
    const row = document.createElement("p");
    row.textContent = link.path + " → " + link.title + (!link.available ? "（取得範囲外・参照不可）" : link.stale ? "（古い情報）" : "");
    const open = document.createElement("button");
    open.type = "button"; open.className = "text-button"; open.textContent = "タスクを開く";
    open.disabled = linksBusy || !link.available;
    open.onclick = () => document.dispatchEvent(new CustomEvent("dashboard:open-task", {detail:{projectId:link.projectId,itemId:link.itemId}}));
    const remove = document.createElement("button");
    remove.type = "button"; remove.className = "text-button"; remove.textContent = "関連を解除";
    remove.disabled = linksBusy;
    remove.onclick = async () => {
      if (await confirmAction("このサイトの関連だけを解除します。ノートとGitHubタスクは削除しません。", "解除する")) await saveTaskLink("linkRemove", link);
    };
    row.append(open, remove); el("noteLinksList").append(row);
  }
  el("noteLinkAdd").disabled = linksBusy || busy || !selected || !linksView || state?.stale || linksView.notesStale;
  el("noteLinkChoice").disabled = linksBusy;
  el("noteLinksReload").disabled = linksBusy;
}
async function loadTaskLinks() {
  if (linksBusy) return;
  linksBusy = true; renderTaskLinks();
  try {
    linksView = await api({action:"links"});
    el("noteLinksStatus").textContent = `${linksView.records.length}/${linksView.maximumLinks}件。` +
      (linksView.sources.some(source => source.stale) ? "タスク一覧が未取得または古い状態です。「タスク」で一覧を更新後、ここを読み直してください。" : "取得済みのタスク一覧を使用しています。") +
      (selected ? " 対象ノート：" + selected : " 追加するにはノート本文を開いてください。");
  } catch (error) { el("noteLinksStatus").textContent = error.message; }
  finally { linksBusy = false; renderTaskLinks(); }
}
async function saveTaskLink(action, link) {
  if (linksBusy || !linksView) return;
  linksBusy = true; renderTaskLinks();
  try {
    linksView = await api({action, link, revision:linksView.revision});
    el("noteLinksStatus").textContent = "関連を保存しました。";
  } catch (error) {
    el("noteLinksStatus").textContent = error.message + " 結果が不明な場合も、再送前に関連一覧を読み直してください。";
  } finally { linksBusy = false; renderTaskLinks(); }
}
el("noteTaskLinks").ontoggle = () => { if (el("noteTaskLinks").open) void loadTaskLinks(); };
el("noteLinksReload").onclick = loadTaskLinks;
el("noteLinkAdd").onclick = () => {
  const choice = el("noteLinkChoice").value;
  const task = choice === "" ? null : linksView?.candidates[Number(choice)];
  if (!selected || !task || task.stale) return;
  void saveTaskLink("linkAdd", {scope:linksView.scope,path:selected,projectId:task.projectId,itemId:task.itemId});
};
