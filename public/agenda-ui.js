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
function controls() {
  for (const id of [
    "agendaAccount",
    "agendaConnect",
    "agendaRefresh",
    "agendaManual",
    "agendaMore",
    "appointmentPreview",
    "appointmentReconcile",
  ])
    el(id).disabled = busy;
  el("agendaRefresh").disabled ||= !state?.accountId;
  el("agendaManual").disabled ||= !state?.accountId;
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
  el("appointmentTarget").replaceChildren(
    ...state.accounts.map((a) => option(a.id, a.email + " のメイン")),
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
  el("agendaAccount").replaceChildren(
    ...state.accounts.map((a) =>
      option(a.id, a.email + (a.connected ? "" : "（再接続が必要）")),
    ),
  );
  el("agendaAccount").value = state.accountId || "";
  el("agendaConnect").hidden = !state.configured;
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
      (state.error ? " ／ 取得失敗・保存済みの一覧：" + state.error : "") +
      (state.lastSuccess && Date.now() - Date.parse(state.lastSuccess) > 3600000
        ? " ／ 1時間以上前の保存情報です"
        : "") +
      (state.nextPageToken
        ? state.limited
          ? " ／ 上限に達しました。残りはGmailで確認してください"
          : " ／ 未取得の続きがあります"
        : " ／ この取得範囲の続きはありません");
  el("agendaMessages").replaceChildren(
    ...state.messages.map((message) => {
      const row = document.createElement("button");
      row.className = "task-row";
      row.type = "button";
      const title = document.createElement("strong"),
        meta = document.createElement("span");
      title.textContent = message.subject || "件名なし";
      meta.className = "task-meta";
      meta.textContent = `${message.operation?.phase || message.candidate.status} · ${time(message.receivedAt)} · ${message.from}`;
      row.append(title, meta);
      row.onclick = () => openMessage(message);
      return row;
    }),
  );
  controls();
}
async function run(body = null, accountId) {
  if (busy) return;
  busy = true;
  controls();
  try {
    state = await api(body, accountId);
    render();
    if (current) {
      if (current.manual) {
        const operation = state.manualRegistrations?.find(
          (op) => op.messageId === current.id,
        );
        if (operation) openMessage({ ...current, operation });
      }
      const updated = state.messages.find((m) => m.id === current.id);
      if (updated?.operation) openMessage(updated);
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
el("agendaRefresh").onclick = () =>
  run({ action: "refresh", accountId: state.accountId });
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
el("agendaConnect").onclick = async () => {
  if (
    busy ||
    !(await confirmAction(
      "Gmailのメール本文の読み取りと、本人所有カレンダーの予定操作を追加認可します。最大5アカウントのメインカレンダーを扱います。接続後も予定の登録には内容確認が必要です。",
      "Googleの認可画面へ",
    ))
  )
    return;
  busy = true;
  controls();
  try {
    const response = await fetch("/auth/agenda/start", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "追加認可を開始できません");
    location.assign(result.authorizationUrl);
  } catch (error) {
    el("agendaStatus").textContent = error.message;
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
document.addEventListener("dashboard:view", (event) => {
  if (event.detail === "agenda") render();
});
run();
