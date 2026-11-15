import { sessionFetch as fetch } from "./session-connection.js";
const el = (id) => document.getElementById(id);
const saveTimeoutMs = 30000;
let selected = null,
  saving = false;
function controls() {
  const reset = !!selected?.reset;
  const isNew = !reset && el("splitTarget").value === "";
  el("splitLabelField").hidden = !isNew;
  el("splitLabel").disabled = saving || !isNew;
  el("splitLabel").required = isNew;
  el("splitTarget").disabled = saving || reset;
  const choices = [...el("splitMessages").querySelectorAll("input")];
  for (const checkbox of choices) checkbox.disabled = saving || reset;
  const count = choices.filter((input) => input.checked).length;
  el("splitChoiceStatus").textContent = reset
    ? "保存済みのこの分割案件全体を対象にします。"
    : `選択 ${count}/${choices.length}通`;
  el("splitSave").disabled =
    saving || !selected || !el("splitConfirm").checked || (!reset && !count);
  el("splitEditorClose").disabled = saving;
  el("splitReload").disabled = saving;
}
export function openMailSplit(group, agenda, reset = false) {
  if (saving || !group.caseState) return;
  selected = { group, reset, splitRevision: agenda.splitRevision };
  el("splitEditorHeading").textContent = reset
    ? "自動のまとめ方へ戻す"
    : "メールを別案件に分ける";
  const savedCase = agenda.splitCases.find(
    (item) => item.id === group.manualCaseId,
  );
  el("splitEditorScope").textContent = reset
    ? `${group.label}：保存済み ${savedCase?.count || 0}通を戻します。現在のカード ${group.entries.length}通以外の分類も対象です。分割側の対応記録は履歴に保ち、戻り先は未対応になります。`
    : `${group.label}：分けるメールを宛先ごとに選んでください。分割先と残りの案件は未対応になります。元メール・既読・予定は変更しません。`;
  const target = el("splitTarget");
  target.replaceChildren();
  const first = document.createElement("option");
  first.value = "";
  first.textContent = "新しい案件を作る";
  target.append(first);
  for (const item of agenda.splitCases)
    if (
      item.id !== group.manualCaseId &&
      group.entries.every((entry) =>
        item.origins.includes(entry.automaticCaseId),
      )
    ) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label + "（既存の案件）";
      target.append(option);
    }
  el("splitTargetField").hidden = reset;
  el("splitLabel").value = "";
  el("splitMessages").replaceChildren(
    ...group.entries.map((entry) => {
      const label = document.createElement("label");
      label.className = "split-mail-choice";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = reset;
      checkbox.dataset.accountId = entry.accountId;
      checkbox.dataset.messageId = entry.messageId;
      checkbox.onchange = controls;
      const content = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = entry.title;
      const meta = document.createElement("small");
      meta.textContent =
        (entry.accountName || entry.email) +
        " · " +
        new Date(entry.receivedAt).toLocaleString("ja-JP", {
          timeZone: "Asia/Tokyo",
        });
      content.append(title, meta);
      label.append(checkbox, content);
      return label;
    }),
  );
  el("splitConfirm").checked = false;
  el("splitEditorStatus").textContent =
    "保存前です。新着メールは元の関連候補に残り、必要なものを後から既存案件へ移せます。";
  el("splitSave").textContent = reset
    ? "自動のまとめ方へ戻して保存"
    : "選んだメールを別案件へ保存";
  controls();
  el("splitEditor").showModal();
}
el("splitConfirm").onchange = controls;
el("splitTarget").onchange = controls;
el("splitEditorClose").onclick = () => el("splitEditor").close();
el("splitReload").onclick = () => {
  el("splitEditor").close();
  document.dispatchEvent(new CustomEvent("dashboard:agenda-changed"));
};
el("splitEditor").addEventListener("cancel", (event) => {
  if (saving) event.preventDefault();
});
el("splitEditorForm").onsubmit = async (event) => {
  event.preventDefault();
  if (saving || !selected || el("splitSave").disabled) return;
  const messages = [
    ...el("splitMessages").querySelectorAll("input:checked"),
  ].map((input) => ({
    accountId: input.dataset.accountId,
    messageId: input.dataset.messageId,
  }));
  const input = {
    action: "splitCase",
    caseId: selected.group.caseState.id,
    sourceRevision: selected.group.caseState.sourceRevision,
    expectedRevision: selected.group.caseState.revision,
    expectedSplitRevision: selected.splitRevision,
    confirmed: true,
    reset: selected.reset,
    targetId: el("splitTarget").value || null,
    label: el("splitLabel").value,
    messages,
  };
  saving = true;
  controls();
  el("splitEditorStatus").textContent = "分類を保存しています…";
  try {
    const response = await fetch("/api/agenda", {
      method: "POST",
      signal: AbortSignal.timeout(saveTimeoutMs),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "保存結果を確認できません");
    const change = result.splitResult;
    const target = result.groups.find(
      (group) => group.manualCaseId === change?.targetId,
    );
    if (
      !change ||
      result.splitRevision === input.expectedSplitRevision ||
      (input.reset
        ? result.splitCases.some((item) => item.id === change.targetId)
        : !messages.every((item) =>
            target?.entries.some(
              (entry) =>
                entry.accountId === item.accountId &&
                entry.messageId === item.messageId,
            ),
          ))
    )
      throw Error("保存後の分類が一致しません。最新情報を確認してください");
    el("splitEditor").close();
    document.dispatchEvent(new CustomEvent("dashboard:agenda-changed"));
    document.dispatchEvent(
      new CustomEvent("dashboard:split-saved", {
        detail: input.reset
          ? "自動のまとめ方への復帰を確認しました"
          : "選択したメールの別案件への保存を確認しました",
      }),
    );
  } catch (error) {
    el("splitEditorStatus").textContent =
      error.message +
      "。再送せず「最新情報を再取得」で分類を確認してください。";
    selected = null;
  } finally {
    saving = false;
    controls();
  }
};
