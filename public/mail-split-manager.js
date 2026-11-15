import { sessionFetch as fetch } from "./session-connection.js";
const el = (id) => document.getElementById(id);
const statusLabels = { open: "未対応", hold: "保留", done: "対応済み" };
const saveTimeoutMs = 30000;
let snapshot = null,
  busy = false,
  usable = false;
const selected = () =>
  snapshot?.splitCases.find(
    (item) => item.id === el("splitManagerSelect").value,
  );

function controls() {
  const item = selected();
  el("splitManagerRename").disabled =
    busy ||
    !usable ||
    !item ||
    !el("splitManagerConfirm").checked ||
    !el("splitManagerLabel").value.trim() ||
    el("splitManagerLabel").value.trim() === item.label;
  el("splitManagerReset").disabled =
    busy || !usable || !item || !el("splitManagerConfirm").checked;
  for (const id of [
    "splitManagerSelect",
    "splitManagerFilter",
    "splitManagerLabel",
    "splitManagerConfirm",
    "splitManagerReload",
    "splitManagerClose",
  ])
    el(id).disabled = busy;
  el("splitManagerLabel").disabled = busy || !item;
  el("splitManagerConfirm").disabled = busy || !item;
}
function selectionChanged() {
  const item = selected();
  el("splitManagerLabel").value = item?.label || "";
  el("splitManagerConfirm").checked = false;
  el("splitManagerInfo").textContent = item
    ? `保存分類 ${item.count}通 ／ 取得済み ${item.cachedCount}通 ／ ホーム表示 ${item.homeCount}通 ／ ${item.accountCount}アカウント ／ ${statusLabels[item.status] || "未対応"}` +
      (!item.cachedCount
        ? "。現在のメール取得一覧に、この案件のメールはありません。"
        : !item.homeCount
          ? "。現在のホームには表示されていません。"
          : "")
    : "該当する分割案件はありません。";
  controls();
}
function renderSelection(preferredId = el("splitManagerSelect").value) {
  const query = el("splitManagerFilter")
    .value.normalize("NFKC")
    .toLowerCase()
    .trim();
  const all = snapshot?.splitCases || [];
  const matches = all
    .filter((item) =>
      item.label.normalize("NFKC").toLowerCase().includes(query),
    )
    .sort(
      (a, b) =>
        a.label.localeCompare(b.label, "ja") || a.id.localeCompare(b.id),
    );
  el("splitManagerSelect").replaceChildren(
    ...matches.map((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = `${item.label}（保存 ${item.count}通・取得済み ${item.cachedCount}通）`;
      return option;
    }),
  );
  if (matches.some((item) => item.id === preferredId))
    el("splitManagerSelect").value = preferredId;
  el("splitManagerSummary").textContent =
    `保存した分割案件 ${all.length}件・表示 ${matches.length}件。ホーム表示の有無にかかわらず選べます。`;
  selectionChanged();
}
export function openSplitManager(agenda, preferredId = null) {
  if (busy) return;
  snapshot = agenda;
  usable = true;
  el("splitManagerFilter").value = "";
  renderSelection(preferredId);
  el("splitManagerStatus").textContent =
    "名前の変更は対応状態・メモ・再表示日を維持します。保存前です。";
  el("splitManager").showModal();
}
el("splitManagerSelect").onchange = selectionChanged;
el("splitManagerFilter").oninput = () => renderSelection();
el("splitManagerLabel").oninput = controls;
el("splitManagerConfirm").onchange = controls;
el("splitManagerClose").onclick = () => el("splitManager").close();
el("splitManager").addEventListener("cancel", (event) => {
  if (busy) event.preventDefault();
});
el("splitManagerReload").onclick = async () => {
  if (busy) return;
  busy = true;
  controls();
  try {
    const response = await fetch("/api/home", {
      signal: AbortSignal.timeout(saveTimeoutMs),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "最新の一覧を取得できません");
    snapshot = result.agenda;
    usable = true;
    renderSelection();
    el("splitManagerStatus").textContent =
      "最新の保存記録を取得しました。対象と変更内容をもう一度確認してください。";
  } catch (error) {
    usable = false;
    el("splitManagerStatus").textContent =
      error.message + "。保存済みの表示です。変更せず再取得してください。";
  } finally {
    busy = false;
    controls();
  }
};
async function save(operation) {
  const item = selected();
  if (busy || !usable || !item || !el("splitManagerConfirm").checked) return;
  const input = {
    action: "manageSplit",
    operation,
    targetId: item.id,
    expectedSplitRevision: snapshot.splitRevision,
    confirmed: true,
    label: el("splitManagerLabel").value,
  };
  busy = true;
  controls();
  el("splitManagerStatus").textContent = "保存しています…";
  try {
    const response = await fetch("/api/agenda", {
      method: "POST",
      signal: AbortSignal.timeout(saveTimeoutMs),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "保存結果を確認できません");
    const updated = result.splitCases.find((record) => record.id === item.id);
    if (
      result.splitRevision === input.expectedSplitRevision ||
      (operation === "rename"
        ? !updated ||
          updated.label !== input.label.trim() ||
          updated.count !== item.count
        : !!updated)
    )
      throw Error("保存後の状態が一致しません。最新情報を確認してください");
    snapshot = result;
    if (operation === "rename") el("splitManagerFilter").value = "";
    renderSelection(operation === "rename" ? item.id : null);
    el("splitManagerStatus").textContent =
      operation === "rename"
        ? "名前の保存を確認しました。対応状態・メモ・再表示日は維持しています。"
        : `${item.count}通の手動分類の解除を確認しました。元メール・予定は変更せず、対応記録は履歴に保持します。`;
    document.dispatchEvent(new CustomEvent("dashboard:agenda-changed"));
  } catch (error) {
    usable = false;
    el("splitManagerStatus").textContent =
      error.message +
      "。自動再送せず「最新情報を再取得」で保存状態を確認してください。";
  } finally {
    busy = false;
    controls();
  }
}
el("splitManagerForm").onsubmit = (event) => {
  event.preventDefault();
  if (!el("splitManagerRename").disabled) void save("rename");
};
el("splitManagerReset").onclick = () => save("reset");
