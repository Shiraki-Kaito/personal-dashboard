import { confirmAction, confirmDiscard } from "./confirm.js";

const node = (tag, text, className) => {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
};
const section = node("section", undefined, "drive-members-section");
section.id = "driveMembersSection";
section.append(node("h3", "チームのメンバー"), node("p", "名前・役割・メールアドレスを登録。Driveの編集者と一致すると登録名で表示します。", "group-meta"));
const cards = node("div", undefined, "drive-groups");
const choose = node("select");
choose.setAttribute("aria-label", "メンバーを管理するチーム");
const manage = node("button", "選んだチームを管理", "button");
manage.type = "button";
const more = node("details");
more.append(node("summary", "その他のチームを選ぶ"), choose, manage);
const result = node("p"); result.setAttribute("role", "status");
section.append(cards, more, result);
document.getElementById("drivePanel").append(section);

const dialog = node("dialog", undefined, "progress-dialog");
dialog.setAttribute("aria-labelledby", "memberHeading");
dialog.innerHTML = `<div class="group-card-top"><h2 id="memberHeading">メンバーを編集</h2><button type="button" aria-label="メンバー編集を閉じる">×</button></div><p>このダッシュボード内の名簿です。Driveの共有権限や元資料は変更しません。1チーム40人まで、表示順は追加順です。</p><form><div class="member-editor-list"></div><button type="button" class="button" data-add>メンバーを追加</button><p role="status"></p><button type="submit" class="button button-primary">メンバーを保存</button></form>`;
document.body.append(dialog);
dialog.querySelector("p").append(" メールは任意です。Driveから取得できた編集者のメールと完全一致した場合だけ名前を表示します。同じメールに異なる名前がある場合やメール非公開の場合はGoogleの表示名を使います。メール情報が未取得の資料はDriveの更新後に反映されます。");
const form = dialog.querySelector("form"), rows = dialog.querySelector(".member-editor-list"), message = dialog.querySelector('[role="status"]');
let state, save, current, members = [], busy = false, saving = false;
const dirty = () => current && JSON.stringify(members) !== JSON.stringify(current.members || []);
async function close() {
  if (saving || dirty() && !await confirmDiscard("未保存のメンバー変更を破棄しますか？")) return;
  dialog.close(); current = null;
}
dialog.querySelector('[aria-label="メンバー編集を閉じる"]').onclick = close;
dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
function edit(group) {
  if (busy || saving || !group) return;
  current = { ...group, scope: state.folderId + ":" + state.includeSubfolders };
  members = structuredClone(group.members || []);
  dialog.querySelector("h2").textContent = group.name + "のメンバー";
  message.textContent = "保存するとチームカードに反映されます。";
  renderRows(); dialog.showModal();
}
function renderRows() {
  rows.replaceChildren();
  members.forEach((member, index) => {
    const row = node("fieldset", undefined, "member-editor-row");
    row.append(node("legend", "メンバー " + (index + 1)));
    for (const [key, label, max] of [["name", "名前", 80], ["role", "役割", 40], ["email", "メールアドレス", 254], ["note", "担当・メモ", 160]]) {
      const field = node("label", label), input = node("input");
      input.value = member[key] || ""; input.maxLength = max; input.required = key === "name";
      if (key === "email") { input.type = "email"; input.autocomplete = "off"; }
      input.setAttribute("aria-label", `メンバー${index + 1}の${label}`);
      input.oninput = () => { member[key] = input.value; message.textContent = "変更は未保存です。"; };
      field.append(input); row.append(field);
    }
    const remove = node("button", "削除", "text-button"); remove.type = "button";
    remove.onclick = async () => {
      if (saving || !await confirmAction(`${member.name || "未入力のメンバー"}をこのチームの名簿から外しますか？保存するまで確定しません。`, "名簿から外す")) return;
      members = members.filter(item => item.id !== member.id); renderRows(); message.textContent = "削除は未保存です。保存すると確定します。";
    };
    row.append(remove); rows.append(row);
  });
  if (!members.length) rows.append(node("p", "まだメンバーがいません。"));
  dialog.querySelector('[data-add]').disabled = members.length >= 40;
}
dialog.querySelector('[data-add]').onclick = () => {
  if (saving || members.length >= 40) return;
  members.push({id: crypto.randomUUID(), name: "", role: "メンバー", note: ""});
  renderRows(); rows.querySelector("fieldset:last-child input")?.focus(); message.textContent = "追加は未保存です。";
};
form.onsubmit = async event => {
  event.preventDefault(); if (saving || !current) return;
  const draft = { ...current, expectedRevision: current.revision, members: members.map(member => ({...member,...(member.email !== undefined ? {email:member.email.trim().toLowerCase()} : {})})) };
  saving = true;
  for (const control of dialog.querySelectorAll("input,button")) control.disabled = true;
  try {
    if (!await save(draft)) throw Error("取得中のため保存していません。取得後に再度保存してください。");
    dialog.close(); current = null; result.textContent = "メンバーを保存・照合しました。";
  } catch (error) {
    message.textContent = error.message + " 入力は保持しています。結果不明・競合時は閉じて再読込し、保存済みの内容を確認してください。";
  } finally {
    saving = false;
    for (const control of dialog.querySelectorAll("input,button")) control.disabled = false;
    dialog.querySelector('[data-add]').disabled = members.length >= 40;
  }
};
manage.onclick = () => edit(state?.groups.find(group => group.path === choose.value));
export function renderDriveMembers(next, apiSave, isBusy) {
  state = next; save = apiSave; busy = isBusy;
  const selected = choose.value;
  choose.replaceChildren(...(state.groups || []).map(group => new Option(group.name, group.path)));
  if ([...choose.options].some(option => option.value === selected)) choose.value = selected;
  manage.disabled = busy || !choose.options.length;
  cards.replaceChildren();
  for (const group of state.groups || []) {
    const visible = state.groupDisplay?.groups.find(item => item.path === group.path)?.visible;
    if (!visible && !group.members?.length) continue;
    const card = node("article", undefined, "drive-group-card member-team"); card.dataset.groupColor = group.color;
    card.append(node("h4", group.name));
    const list = node("ul", undefined, "member-list");
    for (const member of group.members || []) {
      const row = node("li"); row.append(node("strong", member.name), node("span", member.role));
      if (member.note) row.append(node("small", member.note)); list.append(row);
    }
    if (!list.children.length) card.append(node("p", "メンバー未登録", "group-meta"));
    else card.append(list);
    const button = node("button", "追加・編集", "button"); button.type = "button"; button.disabled = busy;
    button.setAttribute("aria-label", group.name + "のメンバーを追加・編集"); button.onclick = () => edit(group);
    card.append(button); cards.append(card);
  }
  if (!cards.children.length) cards.append(node("p", "Drive取得後、表示するチームを選んでメンバーを追加できます。"));
}
