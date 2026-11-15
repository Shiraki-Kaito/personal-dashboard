import { sessionFetch as fetch } from "./session-connection.js";
const el = (id) => document.getElementById(id);
let selected = null;
let saving = false;
const saveTimeoutMs = 30000;

function controls() {
  el("caseSave").disabled = saving || !selected || !el("caseConfirm").checked;
  el("caseStatus").disabled = saving || selected?.archived;
  el("caseNote").disabled = saving;
  el("caseSnoozeUntil").disabled = saving || el("caseStatus").value !== "hold";
  el("caseHoldFields").hidden = el("caseStatus").value !== "hold";
  el("caseEditorClose").disabled = saving;
  el("caseReload").disabled = saving;
}
export function openMailCase(group, archived = false) {
  if (saving || group.pending) return;
  const record = archived ? group : group.caseState;
  selected = { ...record, archived };
  el("caseEditorHeading").textContent = archived
    ? "保存記録を未対応に戻す"
    : "案件の対応状況";
  el("caseEditorLabel").textContent = group.label;
  el("caseEditorScope").textContent = archived
    ? "元メールは現在のホーム取得範囲にありません。未対応へ戻すと保存記録の一覧から外れ、元メールが再び取得されたときに未対応で表示します。"
    : `関連メール ${group.entries.length}通・${group.accountCount}アカウントが対象です。` +
      group.basis +
      "のため、別案件が混ざっていないか確認してください。";
  el("caseStatus").value = archived ? "open" : record.status;
  el("caseNote").value = record.note;
  el("caseSnoozeUntil").value =
    record.status === "hold" ? record.snoozeUntil || "" : "";
  el("caseSnoozeUntil").min = new Date(Date.now() + 9 * 3600000 + 86400000)
    .toISOString()
    .slice(0, 10);
  el("caseConfirm").checked = false;
  el("caseEditorStatus").textContent =
    record.notice || "保存前です。Gmailの既読・元メール・予定は変更しません。";
  controls();
  el("caseEditor").showModal();
}
el("caseStatus").onchange = controls;
el("caseConfirm").onchange = controls;
el("caseEditorClose").onclick = () => el("caseEditor").close();
el("caseReload").onclick = () => {
  el("caseEditor").close();
  document.dispatchEvent(new CustomEvent("dashboard:agenda-changed"));
};
el("caseEditor").addEventListener("cancel", (event) => {
  if (saving) event.preventDefault();
});
el("caseEditorForm").onsubmit = async (event) => {
  event.preventDefault();
  if (!selected || saving || !el("caseConfirm").checked) return;
  const status = el("caseStatus").value;
  const input = {
    action: "saveCase",
    caseId: selected.id,
    expectedRevision: selected.revision,
    sourceRevision: selected.sourceRevision,
    status,
    note: el("caseNote").value,
    snoozeUntil: status === "hold" ? el("caseSnoozeUntil").value || null : null,
    confirmed: true,
  };
  saving = true;
  controls();
  el("caseEditorStatus").textContent = "保存しています…";
  try {
    const response = await fetch("/api/agenda", {
      method: "POST",
      signal: AbortSignal.timeout(saveTimeoutMs),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "保存結果を確認できません");
    const confirmed = result.groups.find(
      (group) => group.caseState?.id === selected.id,
    )?.caseState;
    // 取得範囲外の記録を戻した場合は、履歴から消えることを照合する。
    if (
      selected.archived
        ? result.caseHistory.some((record) => record.id === selected.id)
        : confirmed?.status !== status ||
          confirmed.revision === selected.revision
    )
      throw Error("保存後の状態が一致しません。最新情報を確認してください");
    el("caseEditor").close();
    document.dispatchEvent(new CustomEvent("dashboard:agenda-changed"));
    document.dispatchEvent(
      new CustomEvent("dashboard:case-saved", { detail: status }),
    );
  } catch (error) {
    // 応答喪失時は同じ保存要求を自動再送しない。再取得後の版で本人が判断する。
    el("caseEditorStatus").textContent =
      error.message +
      "。再送せず「最新情報を再取得」で保存状態を確認してください。";
    selected = null;
  } finally {
    saving = false;
    controls();
  }
};
