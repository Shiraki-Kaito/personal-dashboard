import { overviewSummary } from "./overview-summary.js";
const el = id => document.getElementById(id);
const labels = {tasks:"要確認タスク",mail:"重要な案件",calendar:"これからの予定",drive:"チームの進捗"};
const sources = {};
let active = null;
function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}
function register(key, element, title, panel) {
  const anchor = document.createComment("overview:"+key);
  element.before(anchor);
  sources[key] = {element,anchor,title,panel};
}
register("tasks",document.querySelector(".home-tasks-card"),labels.tasks,"tasks");
register("mail",document.querySelector(".home-mail-card"),labels.mail,"agenda");
register("calendar",document.querySelector(".home-calendar-card"),labels.calendar,"agenda");
register("drive",document.querySelector(".home-drive-card"),labels.drive,"drive");
register("rawmail",document.querySelector(".agenda-column"),"取得済みメール",null);
register("calendarData",document.querySelectorAll(".agenda-column")[1],"予定の取得状況",null);
register("warnings",el("homeHealthDetails"),"取得状況の注意",null);

const dialog = node("dialog","overview-dialog");
dialog.id="overviewDialog";
dialog.setAttribute("aria-labelledby","overviewDialogTitle");
const frame = node("div","overview-frame"), header=node("header","overview-dialog-header");
const heading=node("h2",null);heading.id="overviewDialogTitle";
const close=node("button","icon-button","×");close.type="button";close.setAttribute("aria-label","概要の詳細を閉じる");
const actions=node("div","overview-dialog-actions");
const full=node("button","button button-small","専用画面を開く");full.type="button";
const compose=node("button","button button-small","予定を入力");compose.type="button";
const content=node("div","overview-dialog-content");content.id="overviewDialogContent";
header.append(heading,close);actions.append(full,compose);frame.append(header,actions,content);dialog.append(frame);document.body.append(dialog);
function restore() {
  if (!active) return;
  const source=sources[active];source.anchor.after(source.element);active=null;
}
dialog.addEventListener("close",restore);
close.onclick=()=>dialog.close();
export function openOverview(key) {
  if (!sources[key]) return;
  restore();
  active=key;
  const source=sources[key];
  heading.textContent=source.title+(key==="rawmail"?" · "+(el("agendaAccount").selectedOptions[0]?.textContent || ""):"");content.append(source.element);
  if(key==="mail")el("homeCaseOpen").click();
  if(key==="tasks")el("homePriorityTab").click();
  if(key==="warnings")source.element.open=true;
  full.hidden=key==="warnings" || key==="calendarData";
  full.textContent=key==="mail"?"取得済みメールを開く":key==="rawmail"?"アカウントを切り替える":"専用画面を開く";
  compose.hidden=key!=="calendar";
  if(!dialog.open)dialog.showModal();
}
full.onclick=()=>{
  if(active==="mail"){openOverview("rawmail");return;}
  if(active==="rawmail"){
    dialog.close();restore();el("agendaTools").open=true;
    document.dispatchEvent(new CustomEvent("dashboard:show-panel",{detail:{panel:"agenda",focusId:"agendaAccount"}}));return;
  }
  const panel=sources[active]?.panel;
  dialog.close();restore();
  if(panel)document.dispatchEvent(new CustomEvent("dashboard:show-panel",{detail:{panel}}));
};
compose.onclick=()=>{
  dialog.close();restore();
  document.dispatchEvent(new Event("dashboard:compose-appointment"));
};
document.addEventListener("dashboard:view",()=>{if(dialog.open){dialog.close();restore();}});

function tile(key, prefix) {
  const button=node("button","overview-tile");button.type="button";
  button.id=prefix+key;button.dataset.overview=key;
  const title=node("span","overview-tile-title",labels[key]);
  const count=node("span","overview-count","—");count.dataset.count=key;
  const lines=node("span","overview-lines");lines.dataset.lines=key;
  lines.append(node("span","overview-line","確認しています"));
  const hint=node("span","overview-hint","押して詳細を確認");hint.dataset.hint=key;
  title.append(count);button.append(title,lines,hint);
  button.onclick=()=>openOverview(key);
  return button;
}
const home=node("section","overview-grid");home.id="homeOverview";home.setAttribute("aria-label","ホームの概要");
for(const key of Object.keys(labels))home.append(tile(key,"overview-"));
document.querySelector(".dashboard-grid").before(home);
const warning=node("button","overview-warning","取得状況に注意");warning.type="button";warning.id="overviewWarning";warning.hidden=true;warning.onclick=()=>openOverview("warnings");
document.querySelector(".top-actions").prepend(warning);
const agenda=node("div","agenda-overview overview-grid");agenda.append(tile("mail","agenda-overview-"),tile("calendar","agenda-overview-"));
const agendaPanel=document.querySelector(".agenda-panel");
agendaPanel.querySelector(".panel-heading").after(agenda);
const tools=node("details","agenda-tools");tools.id="agendaTools";tools.append(node("summary",null,"アカウント・取得状況・設定"));
for(const item of [...agendaPanel.children]){
  if(item===agenda || item.classList.contains("panel-heading") || item.classList.contains("agenda-columns"))continue;
  tools.append(item);
}
agenda.after(tools);
const raw=node("button","button button-small","取得済みメールの一覧を開く");raw.type="button";raw.id="openRawMail";raw.onclick=()=>openOverview("rawmail");
tools.before(raw);
el("agendaConnect").textContent="アカウント管理";
document.querySelector('[data-panel="home"]').dataset.focus="overview-tasks";
document.addEventListener("dashboard:open-calendar-status",()=>openOverview("calendarData"));
document.addEventListener("dashboard:open-mail-list",()=>openOverview("rawmail"));
// 作業の入口を先に置き、報告作成は必要なときだけ展開する。
if(el("progressReportsSection"))el("progressReportsSection").after(el("driveGroups").closest("section"));
else el("weeklySection").before(el("driveGroups").closest("section"));
document.body.classList.add("compact-enabled");

export function updateOverview(state) {
  const summary=overviewSummary(state);
  for(const [key,value]of Object.entries(summary)){
    for(const element of document.querySelectorAll(`[data-count="${key}"]`))element.textContent=value.count;
    for(const element of document.querySelectorAll(`[data-lines="${key}"]`))
      element.replaceChildren(...value.lines.map((line,index)=>{const item=node("span","overview-line",line);if(key==="drive")item.dataset.groupColor=state.drive.groups.highlighted[index].color;return item;}));
    for(const element of document.querySelectorAll(`[data-hint="${key}"]`))element.textContent=value.hint;
  }
  warning.hidden=!state.alerts?.length;
  warning.textContent="取得状況に注意 "+(state.alerts?.length || 0);
}
