const el = (id) => document.getElementById(id);
const pollMs = 5 * 60 * 1000,
  staleMs = 10 * 60 * 1000;
let busy = false,
  state = null;
const time = (value) =>
  value ? new Date(value).toLocaleString("ja-JP") : "なし";
function render() {
  if (!state) return;
  const stale =
    state.lastSuccess &&
    (state.error || Date.now() - Date.parse(state.lastSuccess) > staleMs);
  el("driveStatus").textContent = !state.configured
    ? "Google OAuthの設定待ちです"
    : !state.connected
      ? "Google Driveは未接続です。本人のGoogle認可が必要です"
      : state.error
        ? "取得失敗 ／ " + state.error
        : !state.lastSuccess
          ? "Driveは接続済み・取得前"
          : stale
            ? "古い一覧を表示しています"
            : "取得成功";
  el("driveTimes").textContent =
    "最終試行 " +
    time(state.lastAttempt) +
    " ／ 最終成功 " +
    time(state.lastSuccess);
  el("driveScope").textContent = state.folderId
    ? (state.folderName || "設定したフォルダ") +
      " ／ " +
      (state.includeSubfolders ? "すべての通常サブフォルダを含む" : "直下のみ")
    : "対象フォルダは未設定です";
  el("driveNotice").textContent =
    (stale ? "保存済みの一覧です。最新の状態を確認してください。 " : "") +
    (state.initialHistoryIncomplete
      ? "接続前のフォルダ追加履歴は未確認です。 "
      : "") +
    "「追加を検知」は前回の一覧との差分を見つけた時刻です。ショートカット先のフォルダはたどりません。";
  el("driveConnect").hidden = !state.configured;
  el("driveRefresh").disabled =
    busy || !state.configured || !state.connected || state.retryAt > Date.now();
  if (state.retryAt > Date.now())
    el("driveTimes").textContent += " ／ 次回取得可能 " + time(state.retryAt);
  el("driveFolder").hidden = !state.folderId;
  if (state.folderId)
    el("driveFolder").href =
      "https://drive.google.com/drive/folders/" +
      encodeURIComponent(state.folderId);
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  const files = state.files.filter((file) => file.eventTime >= cutoff);
  el("driveCount").textContent = state.lastSuccess
    ? "過去12時間 " +
      files.length +
      " 件 ／ 確認したファイル " +
      state.inventoryCount +
      " 件・フォルダ " +
      state.folderCount +
      " 件"
    : "";
  el("driveFiles").replaceChildren(
    ...files.map((file) => {
      const row = document.createElement("article"),
        link = document.createElement("a"),
        detail = document.createElement("p");
      link.textContent = file.name;
      link.href =
        "https://drive.google.com/open?id=" + encodeURIComponent(file.id);
      link.target = "_blank";
      link.rel = "noreferrer";
      detail.textContent =
        file.events.join("・") +
        " ／ " +
        time(file.eventTime) +
        " ／ " +
        file.folder;
      row.append(link, detail);
      return row;
    }),
  );
  if (state.lastSuccess && !files.length) {
    const empty = document.createElement("p");
    empty.textContent =
      "取得した範囲では、過去12時間の作成・更新・追加検知はありません。";
    el("driveFiles").append(empty);
  }
}
async function load(refresh = false) {
  if (busy) return;
  busy = true;
  render();
  try {
    const response = await fetch(
      "/api/drive",
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
    if (!response.ok) throw Error("Driveの取得に失敗しました");
    state = await response.json();
  } catch {
    if (state) state.error = "アプリとの通信に失敗しました";
    else
      el("driveStatus").textContent =
        "接続状態を取得できません。ページを再読み込みしてください";
  } finally {
    busy = false;
    render();
  }
}
el("driveRefresh").onclick = () => load(true);
await load();
if (state?.connected) await load(true);
setInterval(() => {
  if (!document.hidden && state?.connected) load(true);
}, pollMs);
setInterval(render, 5000);
