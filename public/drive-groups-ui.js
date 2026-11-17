import { confirmDiscard } from "./confirm.js";
const el = (id) => document.getElementById(id);
let current = null;
let saving = false;
let apiSave = null;
let openGroupFile = null, browseGroup = null;
let renderedSignature = "";
let visibilityBase = null,
  visibilityDirty = false,
  visibilitySignature = "",
  latestState = null,
  latestBusy = false,
  saveVisibility = null;
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
  const updates = el("groupEditorUpdates");
  updates.replaceChildren(element("p", group.path, "group-path"));
  if (!group.available || state.error) updates.append(element("p", "保存情報です。取得状況を確認してください。", "inline-notice"));
  updates.append(element("h3", "最近のファイル更新"));
  for (const file of group.recent || []) {
    const row = element("div", undefined, "group-recent");
    row.append(fileLink(file, openGroupFile), element("p", (file.lastModifiedBy || "更新者不明") + " · " + dateTime(file.modifiedTime), "group-meta"));
    updates.append(row);
  }
  const browse = element("button", "チームのファイル一覧を開く", "button");
  browse.type = "button";
  browse.onclick = async () => {
    await closeGroupEditor();
    if (el("groupEditor").open) return;
    document.dispatchEvent(new CustomEvent("dashboard:show-panel", {detail:{panel:"drive"}}));
    browseGroup(group.path);
  };
  updates.append(browse);
  el("groupEditor").showModal();
}
function renderVisibility(state, busy) {
  const display = state.groupDisplay;
  if (!display) return;
  const signature = JSON.stringify(display);
  if (signature !== visibilitySignature && !visibilityDirty) {
    visibilityBase = display;
    visibilitySignature = signature;
    el("driveVisibilityOptions").replaceChildren(
      ...display.groups.map((group) => {
        const label = element("label", undefined, "drive-visibility-option"),
          input = document.createElement("input");
        input.type = "checkbox";
        input.checked = group.visible;
        input.dataset.path = group.path;
        input.onchange = () => {
          visibilityDirty = true;
          el("driveVisibilityResult").textContent = "表示設定は未保存です。";
          renderVisibility(latestState, latestBusy);
        };
        label.append(input, element("span", group.name));
        return label;
      }),
    );
  }
  for (const control of el("driveVisibilityForm").elements)
    control.disabled = busy || !display.scope;
  el("driveVisibilitySave").disabled =
    busy || !display.scope || !visibilityDirty;
}
el("driveVisibilityDefault").onclick = () => {
  for (const input of el("driveVisibilityOptions").querySelectorAll("input"))
    input.checked = visibilityBase.groups.find(
      (group) => group.path === input.dataset.path,
    ).defaultVisible;
  visibilityDirty = true;
  el("driveVisibilityResult").textContent =
    "100〜400を基本の表示に戻しました。保存すると反映されます。";
  renderVisibility(latestState, latestBusy);
};
el("driveVisibilityForm").onsubmit = async (event) => {
  event.preventDefault();
  if (latestBusy || !visibilityBase || !visibilityDirty) return;
  const overrides = new Map(
    visibilityBase.overrides.map((item) => [item.path, item.visible]),
  );
  for (const input of el("driveVisibilityOptions").querySelectorAll("input")) {
    const group = visibilityBase.groups.find(
      (group) => group.path === input.dataset.path,
    );
    if (input.checked === group.defaultVisible) overrides.delete(group.path);
    else overrides.set(group.path, input.checked);
  }
  const input = {
    scope: visibilityBase.scope,
    expectedRevision: visibilityBase.revision,
    overrides: [...overrides]
      .map(([path, visible]) => ({ path, visible }))
      .sort((a, b) => a.path.localeCompare(b.path, "ja")),
  };
  try {
    const result = await saveVisibility(input);
    if (!result)
      throw Error(
        "取得中のため保存していません。取得が終わってから保存してください",
      );
    visibilityDirty = false;
    visibilitySignature = "";
    renderVisibility(latestState, latestBusy);
    el("driveVisibilityResult").textContent =
      "表示設定を保存・照合しました。元のDriveファイルは変更していません。";
  } catch (error) {
    el("driveVisibilityResult").textContent =
      error.message + " 選択は保持しています。";
  }
};
export function renderDriveGroups(
  state,
  openFile,
  save,
  busy,
  filterGroup,
  saveDisplay,
) {
  apiSave = save;
  openGroupFile = openFile;
  browseGroup = filterGroup;
  latestState = state;
  latestBusy = busy;
  saveVisibility = saveDisplay;
  renderVisibility(state, busy);
  const signature = JSON.stringify([
    state.groups,
    state.groupDisplay,
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
  const cards = (state.groups || [])
    .filter(
      (group) =>
        state.groupDisplay?.groups.find((item) => item.path === group.path)
          ?.visible ??
        /^(?:100|200|300|400)(?:[_\s-]|$)/.test(group.path.split(" / ").at(-1)),
    )
    .map((group) => {
      const card = element("article", undefined, "drive-group-card");
      card.dataset.groupColor = group.color;
      const block = element("button", undefined, "group-block");
      block.type = "button";
      block.disabled = busy;
      block.setAttribute("aria-label", group.name + "の進捗報告を作成");
      const top = element("div", undefined, "group-card-top");
      top.append(element("h3", group.name));
      block.append(top, element("p", group.recent?.[0]?.name || "資料から報告を作成", "group-next"));
      block.append(element("p", group.recent?.[0] ? (group.recent[0].lastModifiedBy || "更新者不明")+" · "+dateTime(group.recent[0].modifiedTime) : "元の資料を読み取り専用で参照", "group-meta"));
      block.onclick = () => document.dispatchEvent(new CustomEvent("dashboard:open-progress-report",{detail:{kind:"organizer",path:group.path}}));
      card.append(block);
      return card;
    });
  el("driveGroups").replaceChildren(...cards);
  if (!cards.length)
    el("driveGroups").append(
      element(
        "p",
        state.groups?.length
          ? "表示するグループがありません。「カードの表示設定」から選択できます。"
          : "Driveの取得が完了すると、保存場所別のグループを表示します。",
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
