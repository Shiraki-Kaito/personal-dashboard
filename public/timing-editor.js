import { sessionFetch } from "./session-connection.js";
import { confirmDiscard } from "./confirm.js";

const el = (id) => document.getElementById(id);
const dialog = el("timingEditor");
const fields = {
  kind: "timingKind",
  action: "timingAction",
  date: "timingDate",
  time: "timingTime",
  endDate: "timingEndDate",
  endTime: "timingEndTime",
};
let current = null,
  initial = "",
  busy = false;
const value = () =>
  Object.fromEntries(
    Object.entries(fields).map(([key, id]) => [key, el(id).value]),
  );
const dirty = () => JSON.stringify(value()) !== initial;
function controls() {
  el("timingSave").disabled = busy || !el("timingConfirm").checked;
  el("timingReset").disabled =
    busy || !current?.manual || !el("timingConfirm").checked;
  el("timingReload").disabled = el("timingEditorClose").disabled = busy;
  for (const id of Object.values(fields)) el(id).disabled = busy;
  el("timingConfirm").disabled = busy;
  if (!busy) {
    const event = el("timingKind").value === "event";
    el("timingTime").required = event;
    el("timingEndDate").disabled = el("timingEndTime").disabled = !event;
  }
}
function fill(timing) {
  current = timing;
  for (const [key, id] of Object.entries(fields))
    el(id).value = timing.editValue[key];
  initial = JSON.stringify(value());
  el("timingConfirm").checked = false;
  el("timingEditorSource").textContent =
    (timing.sourceTitle || "元メール") + " · " + (timing.accountName || "");
  el("timingEditorEvidence").textContent = timing.original.evidence;
  el("timingEditorOriginal").textContent =
    "抽出された記載：" + timing.original.display;
  el("timingEditorStatus").textContent = timing.manual
    ? "保存済みの本人確定日時です。"
    : "未確定です。元メールを確認して年月日を入力してください。";
  controls();
}
export function openTimingEditor(timing) {
  fill(timing);
  dialog.showModal();
}
async function api(action, input) {
  const response = await sessionFetch("/api/agenda", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...input }),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "日時を保存できませんでした");
  return result;
}
async function close() {
  if (
    busy ||
    (dirty() &&
      !(await confirmDiscard(
        "入力中の日時を破棄して閉じます。保存済みの確定内容は保持されます。",
      )))
  )
    return;
  dialog.close();
}
el("timingEditorClose").onclick = close;
dialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  close();
});
el("timingConfirm").onchange = controls;
for (const id of Object.values(fields))
  el(id).addEventListener("input", () => {
    el("timingConfirm").checked = false;
    controls();
  });
el("timingKind").addEventListener("change", () => {
  if (el("timingKind").value !== "event") {
    el("timingEndDate").value = "";
    el("timingEndTime").value = "";
  }
  el("timingConfirm").checked = false;
  controls();
});
el("timingReload").onclick = async () => {
  if (
    busy ||
    (dirty() &&
      !(await confirmDiscard(
        "入力を破棄し、サーバーの最新の確定内容を読み込みます。",
      )))
  )
    return;
  busy = true;
  controls();
  try {
    const view = await api("timingView", {
      accountId: current.accountId,
      messageId: current.messageId,
    });
    const latest = view.timings.find(
      (timing) => timing.timingId === current.timingId,
    );
    if (!latest)
      throw Error(
        "元メールまたは抽出結果が変わりました。閉じてホームの最新案内から選び直してください",
      );
    fill({ ...current, ...latest });
    document.dispatchEvent(new Event("dashboard:agenda-changed"));
  } catch (error) {
    el("timingEditorStatus").textContent = error.message;
  } finally {
    busy = false;
    controls();
  }
};
async function save(reset) {
  if (
    busy ||
    !el("timingConfirm").checked ||
    (!reset && !el("timingEditorForm").reportValidity())
  )
    return;
  busy = true;
  controls();
  try {
    const view = await api("saveTiming", {
      accountId: current.accountId,
      messageId: current.messageId,
      timingId: current.timingId,
      sourceRevision: current.sourceRevision,
      expectedRevision: current.revision,
      confirm: true,
      reset,
      value: value(),
    });
    const saved = view.timings.find(
      (timing) => timing.timingId === current.timingId,
    );
    if (!saved || (reset ? !!saved.manual : !saved.manual))
      throw Error(
        "保存結果を確認できません。最新の保存内容を再読込してください",
      );
    fill({ ...current, ...saved });
    el("timingEditorStatus").textContent = reset
      ? "確定を解除しました。抽出された日時で優先順位を再計算しました。"
      : "保存を確認しました。本人確定日時で優先順位を更新しました。";
    document.dispatchEvent(new Event("dashboard:agenda-changed"));
  } catch (error) {
    el("timingEditorStatus").textContent =
      error.message +
      "。保存結果が不明な場合は自動再送せず「最新の保存内容を再読込」で確認してください。";
  } finally {
    busy = false;
    controls();
  }
}
el("timingEditorForm").onsubmit = (event) => {
  event.preventDefault();
  save(false);
};
el("timingReset").onclick = () => save(true);
