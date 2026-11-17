import { sessionFetch } from "./session-connection.js";
const el = id => document.getElementById(id);
const dialog = el("timingCleanupDialog");
const requestTimeoutMs = 30000;
let accountId = null, plan = null, busy = false, stage = "list";
const selectedIds = () => [...el("timingCleanupRows").querySelectorAll("input:checked")].map(input=>input.value);
function node(tag, text) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  return item;
}
function controls() {
  el("timingCleanupClose").disabled = el("timingCleanupReload").disabled = busy;
  el("timingCleanupPreview").disabled = busy || !plan || !selectedIds().length || stage !== "list";
  el("timingCleanupApply").disabled = busy || stage !== "confirm" || !el("timingCleanupAcknowledge").checked;
  el("timingCleanupBack").disabled = busy;
  el("timingCleanupAcknowledge").disabled = busy;
  for (const input of el("timingCleanupRows").querySelectorAll("input"))
    input.disabled = busy || stage !== "list" || input.dataset.protected === "true";
}
async function api(action, input = {}) {
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),requestTimeoutMs);
  try {
    const response = await sessionFetch("/api/agenda", {
      method:"POST",headers:{"Content-Type":"application/json"},signal:controller.signal,
      body:JSON.stringify({action,accountId,...input}),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "確定日時の整理に失敗しました");
    return result;
  } catch(error) {
    if (error.name === "AbortError") throw Error("通信の待機上限に達しました。実行結果は未確認です");
    throw error;
  } finally { clearTimeout(timer); }
}
function describe(row) {
  const item = node("article");
  item.className = "health-row";
  item.append(node("strong",row.value?.action || "確定解除済みの記録"));
  if (row.value) item.append(node("p", `${row.value.kind === "deadline" ? "締切" : "予定"} ${row.value.date} ${row.value.time || "時刻未設定"}` + (row.value.endTime ? `〜${row.value.endDate} ${row.value.endTime}` : "") + "（日本時間）"));
  item.append(node("p","元メールID："+row.messageId+" ／ 保存 "+new Date(row.updatedAt).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"})));
  return item;
}
function render() {
  el("timingCleanupRows").replaceChildren(...plan.rows.map(row=>{
    const item = describe(row), label = node("label"), checkbox = node("input");
    checkbox.type="checkbox";checkbox.value=row.id;checkbox.dataset.protected=String(!row.eligible);
    checkbox.setAttribute("aria-label",(row.value?.action || "確定解除済み")+"を整理対象に選択");
    checkbox.onchange=controls;
    label.append(checkbox,node("span",row.eligible?"一覧外・整理可能":"保護中"));
    item.prepend(label);
    if (row.reasons.length) item.append(node("p",row.reasons.join("・")));
    return item;
  }));
  if (!plan.rows.length) el("timingCleanupRows").append(node("p","保存済みの確定日時・解除記録はありません。"));
  el("timingCleanupConfirmation").hidden=true;
  el("timingCleanupAcknowledge").checked=false;
  stage="list";
}
async function load() {
  if (busy) return;
  busy=true;controls();
  el("timingCleanupStatus").textContent="最新の保存記録と関連情報を確認しています。整理は実行していません。";
  try {
    plan=await api("timingCleanupView");
    render();
    el("timingCleanupStatus").textContent=`保存枠 ${plan.count}/${plan.maximumRecords}件 ／ 整理可能 ${plan.eligibleCount}件 ／ 保護中 ${plan.count-plan.eligibleCount}件。確認は10分間有効です。`;
  } catch(error) {
    plan=null;stage="uncertain";
    el("timingCleanupStatus").textContent=error.message+"。表示中の記録は最新とは限りません。再取得してください。";
  } finally { busy=false;controls(); }
}
document.addEventListener("dashboard:manage-timings",event=>{
  if (busy) return;
  accountId=event.detail.accountId;plan=null;stage="list";
  el("timingCleanupAccount").textContent=event.detail.accountName;
  el("timingCleanupRows").replaceChildren();
  el("timingCleanupConfirmation").hidden=true;
  dialog.showModal();
  void load();
});
el("timingCleanupReload").onclick=load;
el("timingCleanupClose").onclick=()=>{if(!busy)dialog.close();};
dialog.addEventListener("cancel",event=>{if(busy)event.preventDefault();});
el("timingCleanupAcknowledge").onchange=controls;
el("timingCleanupPreview").onclick=()=>{
  if(busy || !plan || !selectedIds().length)return;
  const ids=new Set(selectedIds());
  el("timingCleanupSelected").replaceChildren(...plan.rows.filter(row=>ids.has(row.id)).map(describe));
  el("timingCleanupAcknowledge").checked=false;
  el("timingCleanupConfirmation").hidden=false;
  stage="confirm";controls();
  el("timingCleanupConfirmation").scrollIntoView({block:"nearest"});
};
el("timingCleanupBack").onclick=()=>{
  if(busy)return;
  stage="list";el("timingCleanupConfirmation").hidden=true;controls();
};
el("timingCleanupApply").onclick=async()=>{
  if(busy || stage!=="confirm" || !el("timingCleanupAcknowledge").checked)return;
  const selected=selectedIds();
  busy=true;controls();
  try{
    const result=await api("cleanupTimings",{selected,checksum:plan.checksum,confirm:true});
    const latest=await api("timingCleanupView");
    if(result.accountId!==accountId || selected.some(id=>latest.rows.some(row=>row.id===id)) ||
       result.removed.length!==selected.length || selected.some(id=>!result.removed.includes(id)))
      throw Error("整理結果を照合できません");
    plan=latest;render();
    el("timingCleanupStatus").textContent=`${selected.length}件の整理を保存・再取得で確認しました。保存枠 ${latest.count}/${latest.maximumRecords}件。メール・予定・関連記録は変更していません。`;
    document.dispatchEvent(new Event("dashboard:agenda-changed"));
  }catch(error){
    stage="uncertain";
    el("timingCleanupStatus").textContent=error.message+"。自動再送しません。「最新の記録と保護状態を再取得」で結果を確認してください。";
  }finally{busy=false;controls();}
};
