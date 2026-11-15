import { confirmDiscard } from "./confirm.js";
const el = (id) => document.getElementById(id);
let current = null;
let saving = false;
let apiSave = null;
let renderedSignature = "";
const dateTime = (value) =>
  value
    ? new Date(value).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
    : "未取得";
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function fileLink(file, openFile) {
  const button = element("button", file.name, "group-file");
  button.type = "button";
  button.disabled = !!file.unavailable;
  button.onclick = () => openFile(file);
  return button;
}
export function openDriveGroupEditor(group, state) {
  if (saving) return;
  current = { ...group, scope: state.folderId + ":" + state.includeSubfolders };
  el("groupEditorHeading").textContent = group.name + "の色と進捗";
  el("groupName").value = group.name;
  el("groupStatus").value = group.status;
  el("groupNext").value = group.nextAction;
  el("groupDue").value = group.due;
  el("groupColor").value = group.color;
  el("groupSaveResult").textContent =
    "進捗はサイト内の手動記録です。Driveのファイルは変更しません。";
  el("groupEditor").showModal();
}
export function renderDriveGroups(state, openFile, save, busy, filterGroup) {
  apiSave = save;
  const signature = JSON.stringify([
    state.groups,
    state.lastSuccess,
    state.error,
    state.scanning,
    busy,
  ]);
  if (signature === renderedSignature) return;
  renderedSignature = signature;
  el("driveGroupsTime").textContent =
    "Drive最終成功 " +
    dateTime(state.lastSuccess) +
    (state.error
      ? " · 取得失敗・保存情報です"
      : !state.lastSuccess ||
          Date.now() - Date.parse(state.lastSuccess) > 90 * 60000
        ? " · 古い情報または未取得"
        : "") +
    (state.scanning ? " · 取得中" : "");
  const cards = (state.groups || []).map((group) => {
    const card = element("article", undefined, "drive-group-card");
    card.dataset.groupColor = group.color;
    const top = element("div", undefined, "group-card-top");
    const heading = element("h3", group.name);
    const status = element("span", group.status, "group-status");
    status.dataset.status = group.status;
    top.append(heading, status);
    card.append(top);
    card.append(element("p", group.path, "group-path"));
    if (!group.available)
      card.append(
        element(
          "p",
          "保存場所は現在の取得範囲外です。手動記録を保持しています。",
          "inline-notice",
        ),
      );
    if (group.nextAction)
      card.append(element("p", group.nextAction, "group-next"));
    const due = element(
      "p",
      group.due ? "期限 " + group.due + "（日本時間）" : "期限未設定",
      "group-meta",
    );
    if (
      group.due &&
      group.status !== "完了" &&
      group.due < new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)
    )
      due.classList.add("group-overdue");
    if (group.due) card.append(due);
    if (group.updatedAt && group.status !== "未設定")
      card.append(
        element("p", "進捗記録 " + dateTime(group.updatedAt), "group-meta"),
      );
    const activity = element("details");
    activity.append(
      element("summary", "更新の様子 · 未確認 " + group.unread + "件"),
    );
    for (const file of group.recent) {
      const row = element("div", undefined, "group-recent");
      row.append(
        fileLink(file, openFile),
        element(
          "p",
          (file.lastModifiedBy || "更新者不明") +
            " · " +
            dateTime(file.modifiedTime),
          "group-meta",
        ),
      );
      activity.append(row);
    }
    card.append(activity);
    const browse = element(
      "button",
      "このグループのファイルを見る",
      "group-file",
    );
    browse.type = "button";
    browse.onclick = () => filterGroup(group.path);
    card.append(browse);
    const edit = element("button", "色・表示名・進捗を設定", "button");
    edit.type = "button";
    edit.disabled = busy;
    edit.onclick = () => openDriveGroupEditor(group, state);
    card.append(edit);
    return card;
  });
  el("driveGroups").replaceChildren(...cards);
  if (!cards.length)
    el("driveGroups").append(
      element(
        "p",
        "Driveの取得が完了すると、保存場所別のグループを表示します。",
      ),
    );
}
function groupDraft() {
  return {
    scope: current.scope,
    path: current.path,
    expectedRevision: current.revision,
    name: el("groupName").value.trim(),
    status: el("groupStatus").value,
    nextAction: el("groupNext").value.trim(),
    due: el("groupDue").value,
    color: el("groupColor").value,
  };
}
async function closeGroupEditor() {
  if (saving) return;
  const draft = current && groupDraft();
  const dirty =
    draft &&
    ["name", "status", "nextAction", "due", "color"].some(
      (key) => draft[key] !== current[key],
    );
  if (
    dirty &&
    !(await confirmDiscard("未保存のグループ設定を破棄して閉じますか？"))
  )
    return;
  el("groupEditor").close();
}
el("groupEditorClose").onclick = closeGroupEditor;
el("groupEditor").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeGroupEditor();
});
el("groupForm").onsubmit = async (event) => {
  event.preventDefault();
  if (saving || !current) return;
  saving = true;
  el("groupSave").disabled = true;
  const input = groupDraft();
  for (const control of el("groupForm").elements) control.disabled = true;
  el("groupEditorClose").disabled = true;
  try {
    const result = await apiSave(input);
    if (!result)
      throw Error("保存できませんでした。再読込して確認してください");
    el("groupEditor").close();
    el("driveGroupResult").textContent = "グループ設定の保存を確認しました";
  } catch (error) {
    el("groupSaveResult").textContent = error.message;
  } finally {
    saving = false;
    for (const control of el("groupForm").elements) control.disabled = false;
    el("groupEditorClose").disabled = false;
  }
};
