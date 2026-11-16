import { sessionFetch } from "./session-connection.js";
import { confirmDiscard } from "./confirm.js";
const el = (id) => document.getElementById(id);
const fields = {
  ownProgress: "meetingOwnProgress",
  ownNext: "meetingOwnNext",
  teamProgress: "meetingTeamProgress",
  teamNext: "meetingTeamNext",
  risks: "meetingRisks",
};
const reportFields = {
  personal: "meetingPersonalReport",
  organizer: "meetingOrganizerReport",
  plenary: "meetingPlenaryReport",
};
let state = null,
  revision = null,
  openedDate = "",
  initial = "",
  compositionSource = "",
  busy = false;
const base = () => ({
  meetingDate: openedDate,
  ...Object.fromEntries(
    Object.entries(fields).map(([key, id]) => [key, el(id).value.trim()]),
  ),
});
const reports = () =>
  Object.fromEntries(
    Object.entries(reportFields).map(([key, id]) => [key, el(id).value]),
  );
const snapshot = () => JSON.stringify({ base: base(), reports: reports() });
const dirty = () => !!initial && initial !== snapshot();
const status = (text) => (el("meetingStatus").textContent = text);
function controls() {
  for (const control of el("meetingSection").querySelectorAll(
    "button,input,textarea,select",
  ))
    control.disabled = busy || (!state && control.id !== "meetingReload");
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
  if (!response.ok) throw Error(result.error || "会議記録を取得できません");
  return result;
}
function fill(date) {
  el("meetingTeamSource").textContent = "取り込みは自分の記録を変更しません。保存済み設定と実際の成果を確認してください。";
  const record = state.records.find((item) => item.meetingDate === date);
  openedDate = date;
  el("meetingDate").value = date;
  revision = record?.revision || null;
  for (const [key, id] of Object.entries(fields))
    el(id).value = record?.[key] || "";
  for (const [key, id] of Object.entries(reportFields))
    el(id).value = record?.reports[key] || "";
  compositionSource = JSON.stringify(base());
  initial = snapshot();
  status(
    record
      ? "保存済み · " +
          new Date(record.updatedAt).toLocaleString("ja-JP", {
            timeZone: "Asia/Tokyo",
          })
      : "新しい会議の下書きです。まだ保存していません。",
  );
}
async function mayReplace() {
  return (
    !dirty() ||
    (await confirmDiscard(
      "入力中の会議記録・報告文を置き換えます。未保存の内容は失われます。保存してから切り替えることもできます。",
    ))
  );
}
async function load() {
  if (busy || !(await mayReplace())) return;
  busy = true;
  controls();
  try {
    state = await api();
    el("meetingHistory").replaceChildren(
      new Option("選択してください", ""),
      ...state.records.map(
        (record) => new Option(record.meetingDate, record.meetingDate),
      ),
    );
    fill(
      openedDate ||
        new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10),
    );
    status(
      el("meetingStatus").textContent +
        ` 保存 ${state.records.length}/${state.maximumRecords}会議。`,
    );
  } catch (error) {
    status(error.message + " 入力内容は保持しています。");
  } finally {
    busy = false;
    controls();
  }
}
el("meetingSection").addEventListener("toggle", () => {
  if (el("meetingSection").open && !state) load();
});
el("meetingReload").onclick = load;
el("meetingOpen").onclick = async () => {
  const date = el("meetingDate").value;
  if (!/^20\d\d-\d\d-\d\d$/.test(date)) {
    status("会議日を選択してください");
    return;
  }
  if (await mayReplace()) fill(date);
};
el("meetingHistory").onchange = async () => {
  const date = el("meetingHistory").value;
  if (date && (await mayReplace())) fill(date);
};
for (const id of [...Object.values(fields), ...Object.values(reportFields)])
  el(id).addEventListener("input", () =>
    status(
      "未保存の変更があります。元の記録を変えた場合は、報告文の下書きも作り直してください。",
    ),
  );
el("meetingImport").onclick = async () => {
  if (
    (el(fields.teamProgress).value || el(fields.teamNext).value) &&
    !(await confirmDiscard(
      "チーム全体の進捗・Next Actionを、4チームの保存済み設定で置き換えます。自分の記録は維持します。",
    ))
  )
    return;
  const teams = state.teams;
  const progress = teams
    .map(
      (team) =>
        `${team.name}：${team.status}${team.updatedAt ? "（設定保存 " + new Date(team.updatedAt).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" }) + "）" : "（未記入）"}`,
    )
    .join("\n");
  const next = teams
    .map(
      (team) =>
        `${team.name}：${team.nextAction || "未記入"}${team.due ? " ／期限 " + team.due : " ／期限未設定"}`,
    )
    .join("\n");
  if (progress.length > 1000 || next.length > 1000) {
    status(
      "取り込み内容が1000文字を超えます。既存のチーム設定を参照し、要点を入力してください。入力は変更していません。",
    );
    return;
  }
  el(fields.teamProgress).value = progress;
  el(fields.teamNext).value = next;
  el("meetingTeamSource").textContent =
    "サイトに保存された4チームの設定を取り込みました。実際の成果と最新状況を確認して追記してください。";
  status("取り込みは未保存です。報告文を作成して確認してください。");
};
el("meetingCompose").onclick = async () => {
  if (
    Object.values(reports()).some(Boolean) &&
    !(await confirmDiscard(
      "3種類の報告文を現在の入力から作り直します。報告文の手動編集は置き換わります。",
    ))
  )
    return;
  busy = true;
  controls();
  try {
    const result = await api({ action: "compose", ...base() });
    for (const [key, id] of Object.entries(reportFields))
      el(id).value = result.reports[key];
    compositionSource = JSON.stringify(base());
    status(
      "3種類の下書きを作成しました。内容を編集・確認して保存してください。まだ未保存です。",
    );
  } catch (error) {
    status(error.message);
  } finally {
    busy = false;
    controls();
  }
};
el("meetingForm").onsubmit = async (event) => {
  event.preventDefault();
  if (busy) return;
  if (el("meetingDate").value !== openedDate) {
    status(
      "会議日を変更した場合は「この日付を開く・新規作成」を押してください。",
    );
    return;
  }
  if (
    Object.values(reports()).some(Boolean) &&
    compositionSource !== JSON.stringify(base())
  ) {
    status(
      "元の記録が変わっています。3種類の下書きを作り直してから、報告文を確認・保存してください。",
    );
    return;
  }
  busy = true;
  controls();
  const input = { ...base(), reports: reports() };
  try {
    const saved = await api({
      action: "save",
      ...input,
      scope: state.scope,
      expectedRevision: revision,
    });
    const verified = await api();
    const record = verified.records.find(
      (item) => item.meetingDate === openedDate,
    );
    if (
      !record ||
      record.revision !== saved.revision ||
      JSON.stringify({ ...base(), reports: reports() }) !==
        JSON.stringify({
          ...Object.fromEntries(
            ["meetingDate", ...Object.keys(fields)].map((key) => [
              key,
              record[key],
            ]),
          ),
          reports: record.reports,
        })
    )
      throw Error(
        "保存後の内容を照合できません。再送せず、保存内容を再取得してください",
      );
    state = verified;
    revision = record.revision;
    initial = snapshot();
    el("meetingHistory").replaceChildren(
      new Option("選択してください", ""),
      ...state.records.map(
        (item) => new Option(item.meetingDate, item.meetingDate),
      ),
    );
    status(
      "保存後の再取得・照合が完了しました。会議記録と3種類の報告文を保存しました。",
    );
  } catch (error) {
    status(
      error.message +
        " 入力は保持しています。結果不明の場合は再送前に保存内容を再取得してください。",
    );
  } finally {
    busy = false;
    controls();
  }
};
for (const button of document.querySelectorAll("[data-copy-report]"))
  button.onclick = async () => {
    const text = el(reportFields[button.dataset.copyReport]).value;
    if (!text) {
      status("先に報告文の下書きを作成してください");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      status(
        "コピーしました。" +
          (dirty()
            ? "未保存の編集を含みます。必要なら保存してください。"
            : "貼り付け先で内容を確認してください。"),
      );
    } catch {
      el(reportFields[button.dataset.copyReport]).select();
      status(
        "コピーできませんでした。選択した報告文をCtrl+Cでコピーしてください。",
      );
    }
  };
window.addEventListener("beforeunload", (event) => {
  if (dirty()) {
    event.preventDefault();
    event.returnValue = "";
  }
});
