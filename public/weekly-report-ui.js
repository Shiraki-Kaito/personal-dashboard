import { sessionFetch } from "./session-connection.js";
import { confirmDiscard } from "./confirm.js";
const el = (id) => document.getElementById(id),
  reportIds = {
    personal: "weeklyPersonal",
    organizer: "weeklyOrganizer",
    plenary: "weeklyPlenary",
  };
let state = null,
  busy = false,
  initialReports = "";
const reports = () =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(reportIds).map(([key, id]) => [key, el(id).value]),
    ),
  );
const edited = () => !!initialReports && initialReports !== reports();
const status = (text) => (el("weeklyStatus").textContent = text);
function reportHeadings(endDate){
  if(!/^20\d\d-\d\d-\d\d$/.test(endDate))return;
  const date=new Date(endDate+"T12:00:00+09:00");if(!Number.isFinite(+date))return;
  const label=new Intl.DateTimeFormat("en-US",{month:"long",day:"numeric",timeZone:"Asia/Tokyo"}).format(date);
  for(const [id,name] of [["weeklyPersonalHeading","集客広報 MTG"],["weeklyOrganizerHeading","Organizer MTG"],["weeklyPlenaryHeading","全体定例 MTG"]])el(id).textContent=label+" · "+name;
}
function controls() {
  for (const node of el("weeklySection").querySelectorAll(
    "button,input,select,textarea",
  ))
    node.disabled = busy;
  el("weeklyConnect").disabled = busy || !el("weeklyConsent").checked;
  el("weeklyGenerate").disabled = busy || !state;
}
async function api(input) {
  const response = await sessionFetch(
    "/api/meetings",
    input
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }
      : {},
  );
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "週報を作成できませんでした");
  return result;
}
async function load() {
  if (busy) return;
  busy = true;
  controls();
  try {
    state = await api();
    const weekly = state.weekly;
    el("weeklyMinutes").replaceChildren(
      new Option("議事録を選択してください", ""),
      ...weekly.sources.map(
        (file) => new Option(file.name + " · " + file.folder, file.id),
      ),
    );
    el("weeklyMinutes").value =
      weekly.settings?.minutesId || weekly.defaultMinutesId;
    el("weeklyOwner").value = weekly.settings?.ownerName || "白木";
    if (!el("weeklyEndDate").value)
      el("weeklyEndDate").value = new Date(Date.now() + 9 * 3600000)
        .toISOString()
        .slice(0, 10);
    el("weeklyAuthorization").hidden = weekly.documentsAuthorized;
    if(!initialReports)reportHeadings(el("weeklyEndDate").value);
    status(
      weekly.documentsAuthorized
        ? "議事録の参照設定を確認しました。対象期間の下書きを作成できます。"
        : "議事録を読む追加認可が必要です。先に参照元と本人表記を設定してください。",
    );
  } catch (error) {
    status(error.message);
  } finally {
    busy = false;
    controls();
  }
}
function evidenceNodes(result) {
  const target = el("weeklyEvidence");
  target.replaceChildren();
  const heading = document.createElement("p");
  heading.textContent = `対象期間 ${result.evidence.period.startDate}〜${result.evidence.period.endDate} ／ 議事録 ${result.evidence.entries.length}項目・更新資料 ${result.evidence.files.length}件`;
  target.append(heading);
  for (const entry of result.evidence.entries) {
    const row = document.createElement("p"),
      link = document.createElement("a");
    row.textContent = `${entry.meetingDate} · ${entry.path} · ${entry.text} `;
    link.textContent = "議事録の根拠へ";
    link.href =
      "https://docs.google.com/document/d/" +
      result.source.id +
      "/edit?tab=" +
      encodeURIComponent(entry.tabId);
    link.target = "_blank";
    link.rel = "noreferrer";
    row.append(link);
    target.append(row);
  }
  for (const file of result.evidence.files) {
    const row = document.createElement("p"),
      link = document.createElement("a");
    row.textContent = `更新を確認：${file.name} ／ ${file.lastModifiedBy} ／ ${file.folder} `;
    link.textContent = "元資料へ";
    link.href =
      "https://drive.google.com/open?id=" + encodeURIComponent(file.id);
    link.target = "_blank";
    link.rel = "noreferrer";
    row.append(link);
    target.append(row);
  }
}
async function generate() {
  if (busy || !state) return;
  if (
    edited() &&
    !(await confirmDiscard(
      "編集した週報を新しい根拠から作り直します。必要な内容は先にコピーしてください。",
    ))
  )
    return;
  busy = true;
  controls();
  try {
    const weekly = state.weekly,
      minutesId = el("weeklyMinutes").value,
      ownerName = el("weeklyOwner").value.trim();
    if (!minutesId || !ownerName)
      throw Error("参照する議事録と本人表記を指定してください");
    let settings = weekly.settings;
    if (
      !settings ||
      settings.minutesId !== minutesId ||
      settings.ownerName !== ownerName
    ) {
      settings = await api({
        action: "configureWeekly",
        scope: state.scope,
        minutesId,
        ownerName,
        expectedRevision: settings?.revision || null,
      });
      weekly.settings = settings;
    }
    if (!weekly.documentsAuthorized) {
      status(
        "参照設定を保存しました。議事録を読む権限を追加認可してください。既存のDrive取得は引き続き利用できます。",
      );
      return;
    }
    status(
      "Driveの更新と議事録を読み取り、週報を作成しています。元文書には書き込みません。",
    );
    const result = await api({
      action: "weekly",
      settingsRevision: settings.revision,
      endDate: el("weeklyEndDate").value,
    });
    for (const [key, id] of Object.entries(reportIds))
      el(id).value = result.reports[key];
    initialReports = reports();
    reportHeadings(result.evidence.period.endDate);
    evidenceNodes(result);
    el("weeklyWarnings").textContent = result.evidence.warnings.join("\n");
    status(
      `週報の下書きを作成しました（${result.evidence.period.startDate}〜${result.evidence.period.endDate}）。確認・編集してコピーしてください。元文書は変更していません。`,
    );
  } catch (error) {
    status(error.message + " 以前の下書きがあれば保持しています。");
  } finally {
    busy = false;
    controls();
  }
}
el("weeklySection").addEventListener("toggle", async () => {
  if (el("weeklySection").open && !state) {
    await load();
    if (state?.weekly.settings && state.weekly.documentsAuthorized) generate();
  }
});
el("weeklyReload").onclick = load;
el("weeklyGenerate").onclick = generate;
el("weeklyConsent").onchange = controls;
el("weeklyConnect").onclick = async () => {
  if (busy || !el("weeklyConsent").checked) return;
  busy = true;
  controls();
  try {
    const response = await sessionFetch("/auth/google/report-start", {
        method: "POST",
      }),
      result = await response.json();
    if (!response.ok || !result.authorizationUrl)
      throw Error(result.error || "Google認可を開始できません");
    window.location.assign(result.authorizationUrl);
  } catch (error) {
    status(error.message);
    busy = false;
    controls();
  }
};
for (const id of ["weeklyEndDate", "weeklyMinutes", "weeklyOwner"])
  el(id).addEventListener("change", () =>
    status(
      "参照設定・期間が変更されています。表示中の下書きを使う前に再作成してください。",
    ),
  );
for (const button of document.querySelectorAll("[data-weekly-copy]"))
  button.onclick = async () => {
    const area = el(reportIds[button.dataset.weeklyCopy]);
    if (!area.value) {
      status("先に週報を作成してください");
      return;
    }
    try {
      await navigator.clipboard.writeText(area.value);
      status(
        "週報をコピーしました。貼り付け先で確認してから反映してください。",
      );
    } catch {
      area.select();
      status(
        "コピーできませんでした。選択した週報をCtrl+Cでコピーしてください。",
      );
    }
  };
window.addEventListener("beforeunload", (event) => {
  if (edited()) {
    event.preventDefault();
    event.returnValue = "";
  }
});
