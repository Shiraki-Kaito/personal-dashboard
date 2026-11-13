import { confirmDiscard } from "./confirm.js";
const el = (id) => document.getElementById(id);
const fields = [
  "prioritySenders",
  "excludedSenders",
  "priorityKeywords",
  "excludedKeywords",
];
const dialog = el("mailRulesDialog");
let accountId = null,
  revision = null,
  busy = false,
  dirty = false,
  previewKey = null;
const rules = () =>
  Object.fromEntries(
    fields.map((key) => [
      key,
      el(key)
        .value.split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean),
    ]),
  );
const signature = () => JSON.stringify([accountId, revision, rules()]);
function controls() {
  for (const field of fields) el(field).disabled = busy || !accountId;
  for (const id of [
    "mailRulesAccount",
    "mailRulesPreview",
    "mailRulesReload",
    "mailRulesClose",
  ])
    el(id).disabled = busy;
  el("mailRulesPreview").disabled ||= !accountId;
  el("mailRulesSave").disabled =
    busy ||
    !accountId ||
    previewKey !== signature() ||
    !el("mailRulesConfirm").checked;
  el("mailRulesConfirm").disabled = busy || !previewKey;
}
async function api(body, id = accountId) {
  const response = await fetch(
    "/api/agenda" + (!body && id ? "?accountId=" + encodeURIComponent(id) : ""),
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, accountId: id }),
        }
      : {},
  );
  const value = await response.json();
  if (!response.ok)
    throw Error(
      value.error || "設定を取得できません。本人ログインを確認してください",
    );
  return value;
}
async function load(id) {
  if (busy) return;
  busy = true;
  controls();
  try {
    const view = await api(null, id);
    accountId = view.accountId;
    el("mailRulesAccount").replaceChildren(
      ...view.accounts.map((account) => {
        const option = document.createElement("option");
        option.value = account.id;
        option.textContent =
          (account.label ? account.label + " · " : "") + account.email;
        return option;
      }),
    );
    el("mailRulesAccount").value = accountId || "";
    revision = view.priorityRules?.revision ?? null;
    for (const field of fields)
      el(field).value = (view.priorityRules?.rules[field] || []).join("\n");
    dirty = false;
    previewKey = null;
    el("mailRulesConfirm").checked = false;
    el("mailRulesResult").replaceChildren();
    el("mailRulesStatus").textContent = accountId
      ? "保存済みの設定です。空欄の項目は標準の判定を使います。"
      : "先にGoogleアカウントを接続してください。";
  } catch (error) {
    el("mailRulesStatus").textContent = error.message;
  } finally {
    busy = false;
    controls();
  }
}
el("mailRulesOpen").onclick = () => {
  if (busy) return;
  dialog.showModal();
  load(el("agendaAccount").value || null);
};
for (const field of fields)
  el(field).oninput = () => {
    dirty = true;
    previewKey = null;
    el("mailRulesConfirm").checked = false;
    el("mailRulesResult").replaceChildren();
    controls();
  };
el("mailRulesAccount").onchange = async () => {
  const selected = el("mailRulesAccount").value;
  el("mailRulesAccount").value = accountId || "";
  if (
    !dirty ||
    (await confirmDiscard(
      "入力中の重要メール設定を破棄して、別アカウントへ切り替えますか？",
    ))
  )
    load(selected);
};
el("mailRulesReload").onclick = async () => {
  if (
    !dirty ||
    (await confirmDiscard(
      "未保存の設定を破棄し、保存済みの設定を読み込みますか？",
    ))
  )
    load(accountId);
};
el("mailRulesPreview").onclick = async () => {
  if (busy || !accountId) return;
  previewKey = null;
  el("mailRulesConfirm").checked = false;
  busy = true;
  controls();
  try {
    const result = await api({
      action: "previewPriorityRules",
      rules: rules(),
    });
    if (result.revision !== revision)
      throw Error("他の画面で設定が変わりました。再読込してください。");
    el("mailRulesStatus").textContent =
      "取得済み " +
      result.total +
      "件中、重要 " +
      result.important +
      "件。分類が変わるメール " +
      result.changedCount +
      "件。先頭10件まで表示します。未取得のメールは含みません。";
    el("mailRulesResult").replaceChildren(
      ...result.changed.map((message) => {
        const row = document.createElement("li");
        row.textContent =
          (message.important ? "重要へ：" : "その他へ：") +
          message.subject +
          " ／ " +
          message.reason;
        return row;
      }),
    );
    previewKey = signature();
    el("mailRulesConfirm").checked = false;
  } catch (error) {
    previewKey = null;
    el("mailRulesStatus").textContent = error.message;
  } finally {
    busy = false;
    controls();
  }
};
el("mailRulesConfirm").onchange = controls;
el("mailRulesSave").onclick = async () => {
  if (busy || previewKey !== signature() || !el("mailRulesConfirm").checked)
    return;
  busy = true;
  controls();
  try {
    const view = await api({
      action: "savePriorityRules",
      rules: rules(),
      revision,
      confirm: true,
    });
    revision = view.priorityRules.revision;
    for (const field of fields)
      el(field).value = view.priorityRules.rules[field].join("\n");
    dirty = false;
    previewKey = null;
    el("mailRulesConfirm").checked = false;
    el("mailRulesStatus").textContent =
      "保存しました。ホームとメール一覧へ反映します。元メール・確認記録・予定は変更していません。";
    document.dispatchEvent(new CustomEvent("dashboard:agenda-changed"));
    document.dispatchEvent(new CustomEvent("dashboard:priority-rules-saved"));
  } catch (error) {
    previewKey = null;
    el("mailRulesStatus").textContent =
      error.message +
      "。結果が不明な場合は再読込して保存状態を確認してください。";
  } finally {
    busy = false;
    controls();
  }
};
async function close() {
  if (busy) return;
  if (
    !dirty ||
    (await confirmDiscard("未保存の重要メール設定を破棄して閉じますか？"))
  ) {
    dirty = false;
    dialog.close();
  }
}
el("mailRulesClose").onclick = close;
dialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  close();
});
window.addEventListener("beforeunload", (event) => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});

// 初期表示直後に、スクリプト準備前のボタンだけが押されることを防ぐ。
el("mailRulesOpen").disabled = false;
