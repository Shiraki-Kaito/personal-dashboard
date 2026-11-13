import { confirmAction } from "./confirm.js";
const el = (id) => document.getElementById(id),
  time = (value) =>
    value
      ? new Date(value).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
      : "未取得";
let state = null,
  busy = false,
  current = null,
  preview = null;
let editingAccountId = null;
let deletionPlan = null, deletingAccountId = null;
let mailFilter = "important";
const accountName = (a) => (a.label ? a.label + " · " + a.email : a.email);
function controls() {
  for (const id of [
    "agendaAccount",
    "agendaConnect",
    "agendaRefresh",
    "agendaManual",
    "agendaMore",
    "agendaLabelSave",
    "agendaLabel",
    "agendaSync",
    "accountManagerAdd",
    "accountNameSave",
    "accountNameInput",
    "accountAddLabel",
    "accountAuthorize",
    "accountDeleteRecheck",
    "accountDeleteEmail",
    "accountDeleteAcknowledged",
    "calendarRefresh",
    "appointmentPreview",
    "appointmentReconcile",
    "appointmentReview",
  ])
    el(id).disabled = busy;
  for (const button of el("managedAccounts").querySelectorAll("button"))
    button.disabled = busy;
  el("accountDeleteSubmit").disabled = busy || !deletionPlan?.checksum ||
    !el("accountDeleteAcknowledged").checked ||
    el("accountDeleteEmail").value !== deletionPlan.account.email;
  el("agendaRefresh").disabled ||= !state?.accountId || state?.mailJob?.active || state?.accounts.find(a => a.id === state.accountId)?.disconnectedAt;
  el("agendaMore").disabled ||= state?.mailJob?.active || state?.accounts.find(a => a.id === state.accountId)?.disconnectedAt;
  el("agendaSync").disabled ||=
    !state?.accounts.length || state?.mailJob?.active;
  el("agendaLabelSave").disabled ||= !state?.accountId;
  el("agendaManual").disabled ||= !state?.accountId;
  el("calendarRefresh").disabled ||= !state?.accounts.length || state?.calendar?.job?.active;
  el("agendaMore").disabled ||= !state?.nextPageToken || state?.limited;
  el("appointmentRegister").disabled =
    busy ||
    !preview ||
    preview.matches.some((m) => m.duplicate) ||
    (preview.matches.length > 0 && !el("appointmentConflict").checked);
}
async function api(body = null, accountId = state?.accountId) {
  const response = await fetch(
    "/api/agenda" +
      (body
        ? ""
        : accountId
          ? "?accountId=" + encodeURIComponent(accountId)
          : ""),
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
  if (response.status === 401) {
    location.replace("/");
    throw Error("本人のログインが必要です");
  }
  const data = await response.json();
  if (!response.ok)
    throw Error(data.error || "メール・予定の処理に失敗しました");
  return data;
}
function option(value, text) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = text;
  return o;
}
function invalidate() {
  preview = null;
  el("appointmentResult").textContent =
    "内容変更後はもう一度照合してください。";
  el("appointmentMatches").replaceChildren();
  el("appointmentConflictLabel").hidden = true;
  el("appointmentConflict").checked = false;
  controls();
}
function openMessage(message) {
  current = message;
  preview = null;
  el("appointmentSource").textContent = message.subject + " ／ " + message.from;
  el("appointmentReasons").textContent =
    message.candidate.status +
    "：" +
    (message.candidate.reasons.join("・") ||
      "抽出結果と原文を確認してください");
  el("appointmentExcerpt").textContent = message.excerpt;
  el("appointmentMailLink").href = message.url;
  el("appointmentMailLink").hidden = !!message.manual;
  el("appointmentReview").hidden =
    !!message.manual || !state.messages.some((m) => m.id === message.id);
  el("appointmentReview").textContent = message.review
    ? "未処理に戻す"
    : "確認済み・対応不要にする";
  el("appointmentTarget").replaceChildren(
    ...state.accounts.map((a) => option(a.id, accountName(a) + " のメイン")),
  );
  el("appointmentTarget").value = state.accountId;
  for (const [id, key] of [
    ["appointmentTitle", "title"],
    ["appointmentStart", "start"],
    ["appointmentEnd", "end"],
    ["appointmentLocation", "location"],
  ])
    el(id).value = message.candidate[key] || "";
  invalidate();
  const op = message.operation;
  el("appointmentCalendarLink").hidden = !op?.calendarUrl;
  if (op?.calendarUrl) el("appointmentCalendarLink").href = op.calendarUrl;
  el("appointmentResult").textContent = op
    ? op.phase +
      " ／ " +
      (state.accounts.find((a) => a.id === op.targetAccountId)?.email ||
        "登録先の確認が必要") +
      " ／ " +
      op.draft.title +
      " ／ " +
      time(op.draft.start) +
      "〜" +
      time(op.draft.end) +
      (op.error ? "：" + op.error : "")
    : "登録はまだ行っていません。";
  el("appointmentReconcile").hidden = !op;
  el("appointmentForm").hidden = !!op;
  if (!el("appointmentDialog").open) el("appointmentDialog").showModal();
  controls();
}
function render() {
  if (!state) return;
  renderCalendar();
  renderAccountManager();
  el("agendaAccount").replaceChildren(
    ...state.accounts.map((a) =>
      option(a.id, accountName(a) + (a.connected ? "" : "（再接続が必要）")),
    ),
  );
  el("agendaAccount").value = state.accountId || "";
  el("agendaLabel").value =
    state.accounts.find((a) => a.id === state.accountId)?.label || "";
  el("mailScheduleStatus").textContent =
    `保存 ${state.accounts.length}/${state.accountLimit || 5}件・取得対象 ${state.accounts.filter(a => !a.disconnectedAt).length}件・毎時自動取得` +
    (state.mailJob?.active ? " ／ 取得中・前の完全な一覧を表示" : "") +
    (state.mailScheduler?.lastTriggeredAt
      ? " ／ 前回Cron " + time(state.mailScheduler.lastTriggeredAt)
      : " ／ Cron未記録");
  el("mailHistory").replaceChildren(
    ...(state.mailHistory || []).map((r) => {
      const p = document.createElement("p");
      p.textContent =
        `${time(r.startedAt)} → ${time(r.finishedAt)} ／ ${{ cron: "自動", manual: "手動1ページ", "manual-batch": "手動・全接続" }[r.source] || r.source} ／ ${r.outcome === "success" ? "成功" : "失敗"} ／ 読取 ${r.fetchedCount ?? r.count}件・保存 ${r.count}件・${r.pages}ページ` +
        (r.hasMore ? "・未取得あり" : "") +
        (r.errorCode ? " ／ " + r.errorCode : "");
      return p;
    }),
  );
  el("agendaConnect").hidden = !state.configured;
  const connection = state.accounts.find((a) => a.id === state.accountId);
  el("agendaConnectionStatus").textContent = connection
    ? `トークン更新：最終試行 ${time(connection.refresh?.lastAttempt)} ／ 最終成功 ${time(connection.refresh?.lastSuccess)} ／ 成功 ${connection.refresh?.count || 0}回 ／ 現在の期限 ${time(connection.accessTokenExpiresAt)}` +
      (connection.refresh?.error ? " ／ " + connection.refresh.error : "")
    : "";
  el("agendaManualHistory").replaceChildren(
    ...(state.manualRegistrations || []).map((operation) => {
      const button = document.createElement("button");
      button.className = "task-row";
      button.textContent = operation.draft.title + " ／ " + operation.phase;
      button.onclick = () =>
        openMessage({
          id: operation.messageId,
          manual: true,
          subject: operation.draft.title,
          from: "手入力",
          excerpt: "実メールの処理記録とは別の予定です。",
          candidate: {
            status: "手入力の登録記録",
            reasons: [],
            title: operation.draft.title,
          },
          operation,
        });
      return button;
    }),
  );
  el("agendaPending").replaceChildren(
    ...(state.pendingRegistrations || []).map((operation) => {
      const button = document.createElement("button");
      button.className = "task-row";
      button.textContent = operation.draft.title + " ／ " + operation.phase;
      button.onclick = () =>
        openMessage({
          id: operation.messageId,
          manual: operation.sourceType === "manual",
          subject: operation.draft.title,
          from: "登録結果の照合",
          excerpt:
            "元メールが取得一覧にない場合も、保存した操作から結果を照合できます。",
          url: "https://mail.google.com/",
          candidate: {
            status: "結果確認待ち",
            reasons: [],
            title: operation.draft.title,
          },
          operation,
        });
      return button;
    }),
  );
  el("agendaStatus").textContent = !state.accounts.length
    ? "未接続です。追加認可を行ったアカウントだけを取得します。"
    : `取得済み ${state.messages.length}件 ／ 最終試行 ${time(state.lastAttempt)} ／ 最終成功 ${time(state.lastSuccess)}` +
      (connection?.disconnectedAt ? " ／ 接続停止中・保存情報です" : "") +
      (state.mailJob?.active
        ? " ／ メールの自動・分割取得中（前回の成功分を表示）"
        : "") +
      (state.error ? " ／ 取得失敗・保存済みの一覧：" + state.error : "") +
      (state.lastSuccess && Date.now() - Date.parse(state.lastSuccess) > 3600000
        ? " ／ 1時間以上前の保存情報です"
        : "") +
      (!state.lastSuccess
        ? " ／ メール未取得です"
        : state.errorCode === "restored" && state.limited
          ? " ／ 未取得の続きがあります。先頭から再取得してください"
          : state.nextPageToken
            ? state.limited
              ? " ／ 上限に達しました。残りはGmailで確認してください"
              : " ／ 未取得の続きがあります"
            : " ／ この取得範囲の続きはありません");
  el("agendaMessages").replaceChildren(
    ...state.messages
      .filter(
        (message) =>
          mailFilter === "all" ||
          (mailFilter === "important"
            ? message.priority?.important
            : !message.priority?.important),
      )
      .map((message) => {
        const row = document.createElement("button");
        row.className = "task-row";
        row.type = "button";
        const title = document.createElement("strong"),
          meta = document.createElement("span");
        title.textContent = message.subject || "件名なし";
        title.title = message.priority?.reason || "判定待ち";
        meta.className = "task-meta";
        meta.textContent = `${message.review ? "確認済み・対応不要" : message.operation?.phase || (typeof message.candidate.isCandidate === "boolean" ? message.candidate.status : "候補判定の更新待ち")} · ${time(message.receivedAt)} · ${message.from}`;
        row.append(title, meta);
        row.onclick = () => openMessage(message);
        return row;
      }),
  );
  el("mailFilterStatus").textContent =
    `重要 ${state.messages.filter((m) => m.priority?.important).length}件 ／ その他 ${state.messages.filter((m) => !m.priority?.important).length}件（取得済み範囲）`;
  for (const [id, filter] of [
    ["mailImportant", "important"],
    ["mailOther", "other"],
    ["mailAll", "all"],
  ])
    el(id).setAttribute("aria-pressed", String(mailFilter === filter));
  if (!el("agendaMessages").children.length) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent =
      mailFilter === "important"
        ? "取得済み範囲に重要な就活・学校メールはありません。「すべて」も確認できます。"
        : "この分類に取得済みメールはありません";
    el("agendaMessages").append(p);
  }
  controls();
}
function renderCalendar() {
  const calendar = state.calendar;
  if (!calendar) return;
  const day = (value) =>
    new Date(value).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
  const calendarTime = (value) =>
    new Date(value).toLocaleString("ja-JP", {
      timeZone: "Asia/Tokyo",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  el("calendarStatus").textContent =
    `取得対象 ${day(calendar.range.start)}〜${day(Date.parse(calendar.range.end) - 1)} ／ 表示 ${calendar.events.length}件・毎時自動取得` +
    (calendar.job?.active ? " ／ 取得中（前の完全な一覧を表示）" : "") +
    (calendar.scheduler?.lastTriggeredAt ? " ／ 前回Cron " + time(calendar.scheduler.lastTriggeredAt) : " ／ Cron未記録") +
    (calendar.complete
      ? " ／ 全接続の取得完了"
      : " ／ 未取得・古さ・失敗を確認してください") +
    (calendar.accounts.some((a) => a.error)
      ? " ／ 取得失敗 " +
        calendar.accounts.filter((a) => a.error).length +
        "接続（取得状況を確認）"
      : "");
  el("calendarAccounts").replaceChildren(
    ...calendar.accounts.map((account) => {
      const p = document.createElement("p");
      p.textContent =
        `${accountName(account)}：${account.count}件 ／ 取得元 ${{cron:"自動", "manual-batch":"手動・全接続",manual:"手動"}[account.source] || "未記録"} ／ API取得 ${account.receivedCount ?? "未記録"}件・${account.pages ?? "未記録"}ページ ／ 試行 ${time(account.lastAttempt)} ／ 成功 ${time(account.lastSuccess)}` +
        (account.error ? " ／ 取得失敗：" + account.error : "") +
        (account.stale ? " ／ 保存済み情報は古いか未取得です" : "");
      if (account.rangeStart)
        p.textContent += ` ／ 保存範囲 ${day(account.rangeStart)}〜${day(Date.parse(account.rangeEnd) - 1)}`;
      return p;
    }),
  );
  el("calendarEvents").replaceChildren(
    ...calendar.events.map((event) => {
      const row = document.createElement("div"),
        title = document.createElement("strong"),
        info = document.createElement("span"),
        source = document.createElement("span");
      row.className = "task-row calendar-event";
      title.textContent = event.title;
      info.className = source.className = "task-meta";
      info.textContent = event.allDay
        ? `${event.start.date}〜${new Date(Date.parse(event.end.date) - 86400000).toISOString().slice(0, 10)}・終日（${event.timezone}）`
        : `${calendarTime(event.start.dateTime)}〜${calendarTime(event.end.dateTime)}`;
      source.textContent =
        accountName(event) +
        (event.location ? " ／ " + event.location : "") +
        (event.tentative ? " ／ 未確定" : "") +
        (event.transparent ? " ／ 空き時間として扱う" : "") +
        (event.stale || event.cachedWithError ? " ／ 保存済み・取得対象期間と異なる場合があります" : "");
      row.append(title, info, source);
      if (event.url) {
        const link = document.createElement("a");
        link.href = event.url;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = "Googleカレンダーで開く ↗";
        row.append(link);
      }
      return row;
    }),
  );
  if (!calendar.events.length) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = calendar.complete
      ? "取得した7日間に予定はありません"
      : "予定は未取得、または取得状況に警告があります";
    el("calendarEvents").append(p);
  }
}
async function run(body = null, accountId) {
  if (busy) return;
  busy = true;
  controls();
  try {
    state = await api(body, accountId);
    render();
    if (current && el("appointmentDialog").open) {
      if (current.manual) {
        const operation = state.manualRegistrations?.find(
          (op) => op.messageId === current.id,
        );
        if (operation) openMessage({ ...current, operation });
      }
      const updated = state.messages.find((m) => m.id === current.id);
      if (updated) openMessage(updated);
    }
  } catch (error) {
    el("agendaStatus").textContent =
      error.message + "。表示中の情報は最新とは限りません。";
    if (el("appointmentDialog").open)
      el("appointmentResult").textContent = error.message;
  } finally {
    busy = false;
    controls();
  }
}
function input() {
  return {
    accountId: state.accountId,
    manual: current.manual === true,
    messageId: current.id,
    targetAccountId: el("appointmentTarget").value,
    draft: {
      title: el("appointmentTitle").value,
      start: el("appointmentStart").value,
      end: el("appointmentEnd").value,
      location: el("appointmentLocation").value,
    },
  };
}
for (const [id, filter] of [
  ["mailImportant", "important"],
  ["mailOther", "other"],
  ["mailAll", "all"],
])
  el(id).onclick = () => {
    mailFilter = filter;
    render();
  };
el("agendaLabelSave").onclick = () =>
  run({
    action: "label",
    accountId: state.accountId,
    label: el("agendaLabel").value,
  });
el("agendaSync").onclick = () =>
  run({ action: "syncMail", accountId: state.accountId });
setInterval(() => {
  if (
    document.body.dataset.view === "agenda" &&
    !busy &&
    document.activeElement !== el("agendaLabel") &&
    !el("appointmentDialog").open &&
    !el("accountManager").open &&
    !el("accountNameDialog").open &&
    !el("accountAddDialog").open &&
    !el("accountDeleteDialog").open
  )
    run();
}, 30000);
el("agendaRefresh").onclick = () =>
  run({ action: "refresh", accountId: state.accountId });
el("calendarRefresh").onclick = () =>
  run({ action: "calendar", accountId: state.accountId });
el("agendaManual").onclick = () =>
  openMessage({
    id: "manual-" + crypto.randomUUID(),
    manual: true,
    subject: "手入力の予定",
    from: "メールからの登録ではありません",
    excerpt: "予定名・日時・場所・登録先を確認してから照合してください。",
    candidate: {
      title: "",
      start: "",
      end: "",
      location: "",
      status: "内容確認待ち",
      reasons: [],
    },
  });
el("agendaMore").onclick = () =>
  run({ action: "refresh", more: true, accountId: state.accountId });
el("agendaAccount").onchange = () => {
  current = null;
  run(null, el("agendaAccount").value);
};
el("homeOpenAgenda").onclick = () =>
  document.dispatchEvent(
    new CustomEvent("dashboard:show-panel", {
      detail: { panel: "agenda", focusId: "agendaHeading" },
    }),
  );
function renderAccountManager() {
  el("accountCapacity").textContent =
    `保存済み ${state.accounts.length}件（停止 ${state.accounts.filter(a => a.disconnectedAt).length}件）／ 上限 ${state.accountLimit || 5}件` +
    (state.accounts.length >= (state.accountLimit || 5)
      ? "。現在は既存接続の再認可のみ可能です。"
      : "。後からも追加できます。");
  el("managedAccounts").replaceChildren(
    ...state.accounts.map((account) => {
      const row = document.createElement("div"),
        description = document.createElement("div"),
        name = document.createElement("strong"),
        email = document.createElement("p"),
        status = document.createElement("span"),
        edit = document.createElement("button");
      row.className = "managed-account";
      name.textContent = account.label || "表示名未設定";
      email.textContent = account.email;
      status.textContent = account.disconnectedAt ? "接続停止中" : account.connected ? "接続済み" : "再接続が必要";
      edit.type = "button";
      edit.className = "button button-small";
      edit.textContent = "名前を変更";
      edit.disabled = busy;
      edit.onclick = () => {
        if (!busy) openAccountName(account);
      };
      description.append(name, status, email);
      const actions = document.createElement("div");
      actions.className = "managed-account-actions";
      actions.append(edit);
      for (const [action, label] of [["disconnect", "接続を停止"], ["clearCache", "キャッシュを整理"], ["deleteAccount", "このサイトから完全削除"]]) {
        if (action === "disconnect" && account.disconnectedAt) continue;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "button button-small";
        button.textContent = label;
        button.disabled = busy;
        button.onclick = () => manageAccount(account, action);
        actions.append(button);
      }
      row.append(description, actions);
      return row;
    }),
  );
  el("accountManagerAdd").disabled = busy || !state.configured;
}
async function manageAccount(account, action) {
  if (busy) return;
  if (action === "deleteAccount") {
    await openAccountDeletion(account);
    return;
  }
  busy = true;
  controls();
  const stopping = action === "disconnect";
  try {
    const approved = await confirmAction(
      accountName(account) + "\n\n" + (stopping
        ? "このサイトのメール・予定の接続資格情報を破棄し、手動・自動取得を停止します。表示名・保存情報・確認記録・予定登録記録は残ります。再開にはGoogleの再認可が必要です。停止中のアカウントとの予定照合はできず、新しい予定登録も停止します。Google側の認可取消ではありません。Drive接続は変更しません。"
        : "このサイトに保存したメール一覧・直近予定一覧・取得履歴を整理します。確認記録・表示名・予定登録記録・結果不明の操作・接続は残します。元のメールやGoogleカレンダーの予定は削除しません。必要なら先に設定画面からバックアップしてください。"),
      stopping ? "接続を停止する" : "キャッシュを整理する",
    );
    if (!approved) return;
    state = await api({ action, accountId: account.id, confirm: true });
    current = null;
    preview = null;
    render();
    el("accountManagerStatus").textContent = stopping
      ? accountName(account) + " の接続を停止しました。再開は「追加・再接続」から同じGoogleアカウントを認可してください。"
      : accountName(account) + " のキャッシュを整理しました。確認・登録記録は保持しています。";
    document.dispatchEvent(new CustomEvent("dashboard:agenda-changed"));
  } catch (error) {
    el("accountManagerStatus").textContent = error.message;
  } finally {
    busy = false;
    controls();
  }
}
async function openAccountDeletion(account) {
  if (busy) return;
  deletingAccountId = account.id;
  deletionPlan = null;
  el("accountDeleteTarget").textContent = accountName(account);
  el("accountDeleteCounts").textContent = "";
  el("accountDeleteEmail").value = "";
  el("accountDeleteAcknowledged").checked = false;
  el("accountDeleteStatus").textContent = "削除範囲と関連する予定登録を確認しています…";
  if (!el("accountDeleteDialog").open) el("accountDeleteDialog").showModal();
  busy = true;
  controls();
  try {
    deletionPlan = await api({ action: "previewDelete", accountId: account.id });
    const counts = deletionPlan.counts;
    el("accountDeleteCounts").textContent =
      `削除対象：メール ${counts.messages}件・直近予定 ${counts.calendarEvents}件・確認記録 ${counts.reviews}件・予定登録記録 ${counts.operations}件・取得履歴 ${counts.mailHistory}件`;
    el("accountDeleteStatus").textContent = deletionPlan.blockers.length
      ? deletionPlan.blockers.join(" ")
      : "削除内容の確認は10分間有効です。保存情報が変わった場合は再確認が必要です。";
  } catch (error) {
    el("accountDeleteStatus").textContent = error.message;
  } finally {
    busy = false;
    controls();
  }
}
el("accountDeleteForm").oninput = controls;
el("accountDeleteRecheck").onclick = () => {
  const account = state?.accounts.find(account => account.id === deletingAccountId);
  if (account) openAccountDeletion(account);
};
el("accountDeleteForm").onsubmit = async (event) => {
  event.preventDefault();
  if (busy || !deletionPlan?.checksum || !el("accountDeleteAcknowledged").checked ||
      el("accountDeleteEmail").value !== deletionPlan.account.email) return;
  busy = true;
  controls();
  try {
    const email = deletionPlan.account.email;
    state = await api({ action: "deleteAccount", accountId: deletionPlan.account.id,
      checksum: deletionPlan.checksum, email, confirm: true });
    deletionPlan = null;
    current = null;
    preview = null;
    render();
    el("accountDeleteDialog").close();
    el("accountManagerStatus").textContent = email + " をこのサイトから完全削除し、保存枠を1件空けました。Google上のメール・予定は変更していません。";
    document.dispatchEvent(new CustomEvent("dashboard:agenda-changed"));
  } catch (error) {
    deletionPlan = null;
    el("accountDeleteStatus").textContent = error.message + "。自動再送はしていません。一覧を再読み込みするか、削除内容を再確認してください。";
  } finally {
    busy = false;
    controls();
  }
};
function openAccountName(account) {
  editingAccountId = account.id;
  el("accountNameEmail").textContent = account.email;
  el("accountNameInput").value = account.label || "";
  el("accountNameStatus").textContent = "";
  if (!el("accountNameDialog").open) el("accountNameDialog").showModal();
  el("accountNameInput").focus();
}
el("agendaConnect").onclick = () => {
  if (busy || !state) return;
  renderAccountManager();
  el("accountManagerStatus").textContent = "";
  if (!el("accountManager").open) el("accountManager").showModal();
};
el("accountManagerAdd").onclick = () => {
  if (busy) return;
  el("accountAddLabel").value = "";
  el("accountAddStatus").textContent = "";
  if (!el("accountAddDialog").open) el("accountAddDialog").showModal();
  el("accountAddLabel").focus();
};
el("accountNameForm").onsubmit = async (event) => {
  event.preventDefault();
  if (busy || !editingAccountId) return;
  busy = true;
  controls();
  try {
    state = await api({
      action: "label",
      accountId: editingAccountId,
      label: el("accountNameInput").value,
    });
    render();
    el("accountNameDialog").close();
    el("accountManagerStatus").textContent = "表示名を保存しました。";
  } catch (error) {
    el("accountNameStatus").textContent = error.message;
  } finally {
    busy = false;
    controls();
    renderAccountManager();
  }
};
el("accountAddForm").onsubmit = async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  controls();
  try {
    const response = await fetch("/auth/agenda/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: el("accountAddLabel").value }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      throw Error(
        result.error ||
          "追加認可を開始できません。ログイン状態と表示名を確認してください",
      );
    location.assign(result.authorizationUrl);
  } catch (error) {
    el("accountAddStatus").textContent = error.message;
    busy = false;
    controls();
  }
};
el("appointmentForm").oninput = invalidate;
el("appointmentTarget").onchange = invalidate;
el("appointmentConflict").onchange = controls;
el("appointmentForm").onsubmit = async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  controls();
  try {
    preview = await api({ action: "preview", ...input() });
    el("appointmentResult").textContent =
      preview.calendar +
      " ／ " +
      (preview.matches.length
        ? "重複・時間競合を確認してください"
        : "照合範囲内の重複・時間競合はありません");
    el("appointmentMatches").replaceChildren(
      ...preview.matches.map((match) => {
        const li = document.createElement("li");
        li.textContent =
          (match.duplicate ? "重複：" : "時間競合：") +
          match.title +
          " ／ " +
          time(match.start) +
          "〜" +
          time(match.end) +
          " ／ " +
          state.accounts.find((a) => a.id === match.accountId)?.email;
        return li;
      }),
    );
    el("appointmentConflictLabel").hidden =
      !preview.matches.length || preview.matches.some((m) => m.duplicate);
  } catch (error) {
    preview = null;
    el("appointmentResult").textContent = error.message;
  } finally {
    busy = false;
    controls();
  }
};
el("appointmentRegister").onclick = async () => {
  if (busy || !preview) return;
  const data = {
    action: "register",
    ...input(),
    checksum: preview.checksum,
    confirmed: true,
    allowConflict: el("appointmentConflict").checked,
  };
  preview = null;
  await run(data);
};
el("appointmentReconcile").onclick = () =>
  run({
    action: "reconcile",
    accountId: state.accountId,
    messageId: current.id,
  });
el("appointmentReview").onclick = () =>
  run({
    action: "review",
    accountId: state.accountId,
    messageId: current.id,
    reviewed: !current.review,
  });
document.addEventListener("dashboard:open-agenda", async (event) => {
  if (busy) return;
  const { accountId, messageId } = event.detail;
  document.dispatchEvent(
    new CustomEvent("dashboard:show-panel", { detail: { panel: "agenda" } }),
  );
  current = null;
  await run(null, accountId);
  const message = state?.messages.find((m) => m.id === messageId);
  if (message) openMessage(message);
  else {
    const operation = state?.pendingRegistrations.find(
      (op) => op.messageId === messageId,
    );
    if (operation)
      openMessage({
        id: messageId,
        manual: operation.sourceType === "manual",
        subject: operation.draft.title,
        from: "登録結果の照合",
        excerpt: "保存済み操作の結果を照合します。",
        url: "https://mail.google.com/",
        candidate: { status: operation.phase, reasons: [] },
        operation,
      });
  }
});
document.addEventListener("dashboard:view", (event) => {
  if (event.detail === "agenda") render();
});
async function initializeAgenda() {
  const parameters = new URLSearchParams(location.search),
    selected =
      parameters.get("view") === "agenda" ? parameters.get("accountId") : null;
  await run(null, selected || undefined);
  if (parameters.get("view") === "agenda" && state) {
    document.dispatchEvent(
      new CustomEvent("dashboard:show-panel", {
        detail: { panel: "agenda", focusId: "agendaHeading" },
      }),
    );
    const account = state.accounts.find((a) => a.id === selected);
    if (parameters.get("connected") === "1" && account?.connected) {
      el("accountConnectionNotice").hidden = false;
      el("accountConnectionNotice").textContent =
        accountName(account) +
        " を接続しました。メールを取得でき、名前はアカウント管理から変更できます。";
      el("accountManager").showModal();
      if (!account.label) openAccountName(account);
    } else if (parameters.get("manage") === "1") {
      el("accountManager").showModal();
    }
    history.replaceState(null, "", location.pathname);
  }
}
initializeAgenda();
