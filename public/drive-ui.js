import { renderDriveGroups, openDriveGroupEditor } from "./drive-groups-ui.js?v=blocks1";
import { sessionFetch as fetch } from "./session-connection.js";
import { confirmAction } from "./confirm.js";
const el = (id) => document.getElementById(id);
const statePollMs = 60000,
  progressPollMs = 2500,
  staleMs = 90 * 60 * 1000;
let busy = false,
  state = null,
  timer = null,
  tab = "changes",
  fileSignature = "",
  currentReview = null;
const time = (value) =>
  value ? new Date(value).toLocaleString("ja-JP") : "なし";
function shortTime(value) {
  const date = new Date(value),
    today = new Date();
  if (!Number.isFinite(+date)) return "—";
  return (
    (date.toDateString() === today.toDateString()
      ? "今日"
      : date.toLocaleDateString("ja-JP", {
          month: "numeric",
          day: "numeric",
        })) +
    " " +
    date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })
  );
}
function fileKind(mime) {
  if (/spreadsheet|excel|csv/.test(mime))
    return { type: "sheet", short: "XLS", name: "スプレッドシート" };
  if (/presentation|powerpoint/.test(mime))
    return { type: "slide", short: "PPT", name: "プレゼンテーション" };
  if (/image/.test(mime)) return { type: "image", short: "IMG", name: "画像" };
  if (/pdf/.test(mime)) return { type: "pdf", short: "PDF", name: "PDF" };
  if (/document|text/.test(mime))
    return { type: "doc", short: "DOC", name: "ドキュメント" };
  if (/shortcut/.test(mime))
    return { type: "link", short: "LINK", name: "ショートカット" };
  return { type: "file", short: "FILE", name: "ファイル" };
}
function openFile(file) {
  currentReview = file.review;
  el("fileReview").hidden = !currentReview;
  const kind = fileKind(file.mimeType);
  el("fileDialogType").textContent = kind.name;
  el("fileDialogName").textContent = file.name;
  el("fileDialogFolder").textContent = file.folder;
  el("fileDialogModified").textContent = time(file.modifiedTime) + " ／ 最終更新者：" + (file.lastModifiedBy || "未取得・不明");
  el("fileDialogCreated").textContent = time(file.createdTime);
  el("fileDialogChanges").textContent =
    (file.events?.join("・") || "") +
      (file.review
        ? " ／ 検知 " +
          time(file.review.detectedAt) +
          "（" +
          file.review.occurrences +
          "回）"
        : "") ||
    (state.changesKnown ? "未確認の変更なし" : "最初の全件照合を待っています");
  el("fileDialogLink").href =
    "https://drive.google.com/open?id=" + encodeURIComponent(file.id);
  el("fileDialog").showModal();
}
function renderFiles(force = false) {
  if (!state) return;
  const query = el("driveSearch").value.trim().toLocaleLowerCase();
  const changes = new Map(state.unreadChanges.map((file) => [file.id, file]));
  const source =
    tab === "changes"
      ? state.unreadChanges.filter((file) => !file.personal)
      : tab === "personal"
        ? state.unreadChanges.filter((file) => file.personal)
        : state.files;
  const groupPath = el("driveGroupFilter").value;
  const files = source.filter(file => !groupPath || file.folder.split(" / ").slice(0,2).join(" / ") === groupPath).filter((file) =>
    (file.name + " " + file.folder + " " + (file.lastModifiedBy || "")).toLocaleLowerCase().includes(query),
  );
  const signature = [
    state.lastSuccess,
    state.unreadChanges.map((file) => file.changeId).join(","),
    tab,
    groupPath,
    state.groups?.map(group=>group.path+group.color+group.name).join(","),
    query,
    files.length,
    state.configured,
    state.connected,
  ].join("|");
  if (!force && signature === fileSignature) return;
  fileSignature = signature;
  const rows = files.map((file) => {
    const row = document.createElement("button"),
      icon = document.createElement("span"),
      main = document.createElement("span"),
      name = document.createElement("span"),
      folder = document.createElement("span"),
      meta = document.createElement("span"),
      date = document.createElement("span");
    const kind = fileKind(file.mimeType),
      change = changes.get(file.id),
      events = change?.events || file.events;
    row.className = "file-row";
    const group = state.groups?.find(group=>group.path === file.folder.split(" / ").slice(0,2).join(" / "));
    if (!file.personal && group) { row.dataset.groupColor = group.color; row.title = group.name; }
    row.type = "button";
    row.onclick = () => openFile({ ...file, events, review: change || null });
    icon.className = "file-icon";
    icon.dataset.kind = kind.type;
    icon.textContent = kind.short;
    icon.setAttribute("aria-hidden", "true");
    main.className = "file-main";
    name.className = "file-name";
    name.textContent = file.name;
    name.title = file.name;
    folder.className = "file-folder";
    folder.textContent = "最終更新者：" + (file.lastModifiedBy || "未取得・不明") + " · " + file.folder;
    folder.title = file.folder;
    meta.className = "file-meta";
    date.textContent = shortTime(file.modifiedTime);
    date.title = time(file.modifiedTime);
    meta.append(date);
    if (events?.length) {
      const badge = document.createElement("span");
      badge.className = "change-badge";
      badge.textContent = events[0];
      badge.dataset.removed = String(events.includes("対象範囲外"));
      meta.append(document.createElement("br"), badge);
    }
    main.append(name, folder);
    row.append(icon, main, meta);
    return row;
  });
  el("driveFiles").replaceChildren(...rows);
  if (!rows.length) {
    const empty = document.createElement("div"),
      symbol = document.createElement("span"),
      title = document.createElement("p"),
      hint = document.createElement("small");
    empty.className = "empty-state";
    symbol.className = "empty-symbol";
    symbol.textContent = query ? "⌕" : "▧";
    symbol.setAttribute("aria-hidden", "true");
    title.textContent = query
      ? "一致するファイルがありません"
      : !state.connected
        ? "Google Driveを接続してください"
        : state.scanning
          ? "ファイルを取得しています"
          : tab === "changes"
            ? state.changesKnown
              ? "未確認の変更はありません"
              : "最初の全件照合を待っています"
            : state.lastSuccess
              ? "ファイルはまだありません"
              : "一覧の取得を待っています";
    hint.textContent = query
      ? "ファイル名・保存場所で検索できます"
      : !state.connected
        ? "「接続と設定」から本人認可を行えます"
        : state.scanning
          ? "完了すると全件を表示します"
          : tab === "changes"
            ? "更新順タブで全ファイルを確認できます"
            : "";
    empty.append(symbol, title, hint);
    el("driveFiles").append(empty);
  }
  document.dispatchEvent(
    new CustomEvent("dashboard:rows", { detail: { nodes: rows } }),
  );
}
function render() {
  if (!state) return;
  state.unreadChanges ??= state.changes || [];
  const automaticError =
    state.automatic?.error &&
    Date.parse(state.automatic.lastTriggeredAt) >
      (Date.parse(state.lastSuccess) || 0)
      ? state.automatic.error
      : null;
  const failure = state.error || automaticError;
  const needsReauthorization = !!state.authorization?.requiresReauthorization;
  el("driveAuthorizationMode").textContent =
    state.authorization?.publishingStatus === "published"
      ? "Google OAuthは本番公開済みです。" +
        (needsReauthorization
          ? "現在の接続は再認可が必要です。「Google Driveへ接続・再接続」から進めてください。"
          : "認可の取消や失効時は再接続が必要です。接続の無期限継続は保証しません。")
      : "Google OAuthはテストモードです。テスト時の認可は7日で失効するため再接続が必要です。";
  const stale =
    state.lastSuccess &&
    (failure || Date.now() - Date.parse(state.lastSuccess) > staleMs);
  let status = !state.configured
    ? state.configurationError || "OAuth設定待ち"
    : !state.connected
      ? "Googleへの再接続が必要です"
      : state.scanning
        ? "取得中 " +
          state.progress.foldersDone +
          "/" +
          state.progress.foldersFound +
          "フォルダ"
        : failure
          ? "取得失敗"
          : !state.lastSuccess
            ? "初回取得前"
            : stale
              ? "保存済みの一覧"
              : "取得 " + shortTime(state.lastSuccess);
  el("driveStatus").textContent = status;
  el("driveStatus").dataset.state =
    failure || !state.connected ? "error" : state.scanning ? "busy" : "";
  el("driveTimes").textContent =
    "最終試行 " +
    time(state.lastAttempt) +
    " ／ 最終成功 " +
    time(state.lastSuccess);
  el("driveSchedule").textContent =
    "次の自動取得 " +
    time(state.nextScheduledAt) +
    " ／ 前回のCron起動 " +
    time(state.automatic?.lastTriggeredAt);
  el("driveAuthorizationDue").textContent = state.authorizationReviewAt
    ? "再接続の目安 " +
      time(state.authorizationReviewAt) +
      "（失効や取消により早まる場合があります）"
    : "";
  el("driveTokenRefresh").textContent =
    "トークン自動更新 最終試行 " +
    time(state.authorization?.refresh?.lastAttempt) +
    " ／ 最終成功 " +
    time(state.authorization?.refresh?.lastSuccess) +
    " ／ 成功 " +
    (state.authorization?.refresh?.count || 0) +
    "回" +
    " ／ 現トークン期限 " +
    time(state.authorization?.accessTokenExpiresAt) +
    (state.authorization?.refresh?.error
      ? " ／ " + state.authorization.refresh.error
      : "");
  el("driveRecovery").textContent = state.recovery?.nextAt
    ? "一時障害の再取得予定 " + time(state.recovery.nextAt) + "（最大3回）"
    : state.scanning && state.recovery
      ? "障害後の一覧を再取得しています。"
      : state.recovery
        ? "再取得の上限に達しました。次の毎時取得で再開します。"
        : state.errorCode === "authentication"
          ? "Googleへの再接続が必要です。保存済みの一覧と未確認は保持しています。"
          : state.errorCode === "permission"
            ? "対象フォルダの閲覧権限とDrive APIの有効化を確認してください。"
            : "";
  el("driveAccountStatus").textContent = state.authorization?.accountVerified
    ? "再接続時のアカウント照合：準備済み。同じアカウントなら一覧と未確認を保持します。"
    : state.connected
      ? "再接続前のアカウント照合が未完了です。接続が有効な間にDriveを更新してください。"
      : "照合できる接続がありません。保存済みの情報があれば保持します。";
  const history = state.runHistory || [];
  el("driveHistorySummary").textContent =
    `直近${state.historyLimit || 72}回まで保存します。導入前の履歴と未到達のCronは含みません。` +
    (state.activeRun ? ` 取得中：${time(state.activeRun.startedAt)}` : "");
  el("driveHistory").replaceChildren(
    ...history.map((run) => {
      const item = document.createElement("li");
      const source =
        { cron: "毎時", manual: "手動", recovery: "復旧" }[run.source] ||
        "継続";
      item.textContent =
        `${time(run.startedAt)} → ${time(run.finishedAt)} ／ ${source} ／ ` +
        (run.outcome === "success"
          ? `成功・${run.fileCount}ファイル・${run.folderCount}フォルダ`
          : `失敗（${run.errorCode}）・件数は保存済み`);
      return item;
    }),
  );
  el("driveScope").textContent =
    (state.folderName || "対象未設定") +
    (state.includeSubfolders ? " · サブフォルダを含む" : "");
  const notice =
    failure ||
    (!state.configured
      ? state.configurationError || "Google OAuthの設定が必要です"
      : needsReauthorization
        ? "Google Driveの再認可が必要です。「接続と設定」から再接続してください。"
        : "");
  el("driveNotice").hidden = !notice;
  el("driveNotice").textContent = notice;
  el("driveRefresh").disabled =
    busy ||
    !state.configured ||
    !state.connected ||
    state.retryAt > Date.now() ||
    state.scanning;
  el("driveConnect").hidden = !state.configured;
  el("driveFolder").hidden = !state.folderId;
  if (state.folderId)
    el("driveFolder").href =
      "https://drive.google.com/drive/folders/" +
      encodeURIComponent(state.folderId);
  el("driveCount").textContent = state.lastSuccess
    ? state.inventoryCount + "ファイル"
    : "";
  el("metricFiles").textContent = state.inventoryCount ?? "—";
  el("navDriveCount").textContent = state.inventoryCount ?? "—";
  el("metricFolders").textContent =
    state.folderCount !== null ? state.folderCount + "フォルダ" : "初回取得前";
  el("metricChanges").textContent = state.changesKnown
    ? state.unreadChanges.filter((file) => !file.personal).length
    : "—";
  el("personalTabCount").textContent = state.unreadChanges.filter(
    (file) => file.personal,
  ).length;
  el("metricChangesNote").textContent = state.changesKnown
    ? "個人作業 " +
      state.unreadChanges.filter((file) => file.personal).length +
      "件は別枠"
    : "次の取得で照合";
  el("changeTabCount").textContent = state.changesKnown
    ? state.unreadChanges.filter((file) => !file.personal).length
    : "—";
  el("driveDot").dataset.state =
    !state.connected || failure || needsReauthorization
      ? "error"
      : state.lastSuccess
        ? "ok"
        : "";
  el("driveConnection").textContent = !state.connected
    ? "Drive 未接続"
    : failure
      ? "Drive 取得失敗"
      : needsReauthorization
        ? "Drive 再認可待ち"
        : "Drive 接続済み";
  el("driveReviewAll").hidden = !["changes", "personal"].includes(tab);
  el("driveReviewAll").disabled = busy || !visibleUnread().length;
  const selectedGroup = el("driveGroupFilter").value;
  const optionsSignature = JSON.stringify((state.groups || []).map(group=>[group.path,group.name]));
  if (el("driveGroupFilter").dataset.signature !== optionsSignature) {
    el("driveGroupFilter").replaceChildren(new Option("すべてのグループ", ""), ...(state.groups || []).map(group=>new Option(group.name,group.path)));
    if ((state.groups || []).some(group=>group.path===selectedGroup)) el("driveGroupFilter").value=selectedGroup;
    el("driveGroupFilter").dataset.signature = optionsSignature;
  }
  renderFiles();
  renderDriveGroups(state, file => openFile({ ...file, review:state.unreadChanges.find(change=>change.id===file.id) || null }), group => load(false,null,group), busy, path => { el("driveGroupFilter").value=path; el("driveAllTab").click(); el("driveFiles").focus(); },display=>load(false,null,null,display));
  document.dispatchEvent(
    new CustomEvent("dashboard:busy", { detail: { service: "drive", busy } }),
  );
}
function visibleUnread() {
  const query = el("driveSearch").value.trim().toLocaleLowerCase();
  return (state?.unreadChanges || []).filter(
    (file) =>
      (tab === "all" ||
        (tab === "personal" ? file.personal : !file.personal)) &&
      (!el("driveGroupFilter").value || file.folder.split(" / ").slice(0,2).join(" / ")===el("driveGroupFilter").value) &&
      (file.name + " " + file.folder).toLocaleLowerCase().includes(query),
  );
}
async function load(refresh = false, acknowledge = null, group = null, display = null) {
  let success = false;
  if (busy) return;
  clearTimeout(timer);
  busy = true;
  render();
  try {
    const response = await fetch(
      "/api/drive",
      refresh || acknowledge || group || display
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
              display ? {display} : group ? { group } : acknowledge ? { acknowledge } : { refresh: true, manual: true },
            ),
          }
        : {},
    );

    if (!response.ok) { const error = await response.json().catch(()=>({})); throw Error(error.error || "Driveの状態を取得できません"); }
    state = await response.json();
    if(display && (!state.groupDisplay || state.groupDisplay.revision===display.expectedRevision || JSON.stringify(state.groupDisplay.overrides)!==JSON.stringify(display.overrides)))throw Error("表示設定の保存結果を照合できません。再送せず再取得して確認してください");
    if (group) {
      const saved = state.groups.find(saved=>saved.path === group.path);
      if (!saved || saved.revision === group.expectedRevision || ["name","color","status","nextAction","due"].some(key=>saved[key] !== group[key]) || JSON.stringify(saved.importantFileIds || []) !== JSON.stringify(group.importantFileIds || []))
        throw Error("保存結果を照合できません。保存内容を再読込して確認してください");
      document.dispatchEvent(new CustomEvent("dashboard:drive-group-saved",{detail:{name:saved.name}}));
    }
    success = true;
    if (acknowledge)
      document.dispatchEvent(new Event("dashboard:drive-reviewed"));
    if (acknowledge)
      el("driveReviewStatus").textContent =
        state.acknowledged === acknowledge.length
          ? "確認済みにしました"
          : "新しい変更は未確認で残しました";
  } catch (error) {
    if (display) { el("driveVisibilityResult").textContent=error.message; }
    else if (group) { el("groupSaveResult").textContent = error.message; }
    else if (state) state.error = error.message;
    else el("driveStatus").textContent = error.message;
  } finally {
    busy = false;
    render();
    if (!document.hidden)
      timer = setTimeout(
        () => {
          if (!document.hidden) load();
        },
        state?.scanning ? progressPollMs : statePollMs,
      );
  }
  if (group && !success) throw Error(el("groupSaveResult").textContent);
  if (display && !success) throw Error(el("driveVisibilityResult").textContent);
  return success;
}
for (const [id, value] of [
  ["driveAllTab", "all"],
  ["driveChangesTab", "changes"],
  ["drivePersonalTab", "personal"],
]) {
  el(id).onclick = () => {
    tab = value;
    if (tab === "personal") el("driveGroupFilter").value="";
    for (const [button, mode] of [
      ["driveAllTab", "all"],
      ["driveChangesTab", "changes"],
      ["drivePersonalTab", "personal"],
    ]) {
      el(button).classList.toggle("selected", mode === tab);
      el(button).setAttribute("aria-pressed", String(mode === tab));
    }
    render();
    renderFiles(true);
  };
}
el("driveGroupFilter").onchange = () => { render(); renderFiles(true); };
el("driveSearch").oninput = () => {
  render();
  renderFiles(true);
};
el("driveRefresh").onclick = () => load(true);
el("driveReviewAll").onclick = () => {
  const entries = visibleUnread().map(({ id, changeId }) => ({ id, changeId }));
  if (entries.length) load(false, entries);
};
el("fileReview").onclick = async () => {
  if (!currentReview || busy) return;
  const { id, changeId } = currentReview;
  el("fileReview").disabled = true;
  try {
    if (await load(false, [{ id, changeId }])) el("fileDialog").close();
  } finally {
    el("fileReview").disabled = false;
  }
};
el("driveConnect").onsubmit = async (event) => {
  event.preventDefault();
  const button = el("driveConnect").querySelector("button");
  if (button.disabled || busy) return;
  if (
    state?.unreadChanges?.length &&
    !(await confirmAction(
      "Googleへの再認可に進みます。同じアカウントなら一覧と未確認を保持します。別アカウントや照合できない接続への切り替えは停止します。",
      "再認可へ進む",
    ))
  )
    return;
  button.disabled = true;
  try {
    const response = await fetch("/auth/google/start", {
      method: "POST",
      headers: { Accept: "application/json" },
    });

    if (!response.ok)
      throw Error(
        "Google接続を開始できません。設定とログイン状態を確認してください",
      );
    const target = new URL((await response.json()).authorizationUrl);
    if (target.origin !== "https://accounts.google.com")
      throw Error("認可先が不正です");
    location.assign(target.toString());
  } catch (error) {
    el("driveNotice").hidden = false;
    el("driveNotice").textContent = error.message;
    button.disabled = false;
  }
};
document.addEventListener("dashboard:refresh", () => load(true));
document.addEventListener("dashboard:review-drive", (event) =>
  load(false, [event.detail]),
);
document.addEventListener("dashboard:edit-drive-group", async event => {
  if (!(await load())) {
    document.dispatchEvent(new CustomEvent("dashboard:home-error",{detail:"グループの最新設定を取得できません。少し待ってから再度開いてください。"}));
    return;
  }
  const group = state.groups.find(group=>group.path === event.detail.path);
  if (!group) {
    document.dispatchEvent(new CustomEvent("dashboard:home-error",{detail:"グループの保存場所が変わりました。ホームを再読込してください。"}));
    return;
  }
  openDriveGroupEditor(group,state);
});
document.addEventListener("dashboard:open-drive-group", async event => {
  // 通信中でも既に取得したグループを開ける。未取得時だけ一覧を待つ。
  if (!state && !(await load())) return;
  const path = event.detail.path;
  el("driveGroupFilter").value = (state.groups || []).some(group=>group.path === path) ? path : "";
  el("driveSearch").value = "";
  el("driveAllTab").click();
  el("driveFiles").focus();
});
document.addEventListener("dashboard:open-drive-file", async (event) => {
  if (!(await load())) return;
  const review = state.unreadChanges.find(
    (file) => file.id === event.detail.id,
  );
  const file =
    review || state.files.find((file) => file.id === event.detail.id);
  if (file) openFile({ ...file, review, events: review?.events });
  else
    document.dispatchEvent(
      new CustomEvent("dashboard:home-error", {
        detail:
          "対象のファイルが一覧にありません。最新の取得状況を確認してください。",
      }),
    );
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) load();
});
await load();
setInterval(render, 5000);
