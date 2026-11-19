import { sessionFetch } from "./session-connection.js";
import { confirmAction, confirmDiscard } from "./confirm.js";
const el = (id) => document.getElementById(id);
const kinds = {
  personal: ["チーム定例", "自分の完了・Next Actions"],
  organizer: ["Organizer定例", "担当チーム全体・相談事項"],
  plenary: ["全体定例", "主な成果・予定を簡潔に"],
};
let view = null,
  record = null,
  busy = false,
  initialTexts = "",
  pending = null,
  restoreCandidate = null;
const node = (tag, text, className) => {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
};
const date = () =>
  new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const time = (value) =>
  value
    ? new Date(value).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
    : "未取得";
const reportSection = node("section", undefined, "progress-section");
reportSection.id = "progressReportsSection";
reportSection.append(node("h3", "定例の進捗報告"));
const cards = node("div", undefined, "report-type-grid");
for (const [kind, [name, description]] of Object.entries(kinds)) {
  const button = node("button", undefined, "report-type-card");
  button.type = "button";
  button.dataset.reportKind = kind;
  button.append(
    node("strong", name),
    node("span", description),
    node("small", "Driveから下書きを作る →"),
  );
  button.onclick = () => openReport(kind);
  cards.append(button);
}
reportSection.append(cards);
const groupSection = el("driveGroups").closest("section");
document.querySelector("#drivePanel>.panel-heading").after(reportSection);
reportSection.after(groupSection);
el("driveGroups").after(document.querySelector(".drive-visibility"));
el("weeklySection").hidden = true;
el("meetingSection").hidden = true;
const dialog = node("dialog", undefined, "progress-dialog");
dialog.id = "progressDialog";
dialog.dataset.preserveDraft = "";
dialog.setAttribute("aria-labelledby", "progressHeading");
dialog.innerHTML = `<div class="progress-header"><h2 id="progressHeading">進捗報告</h2><button type="button" id="progressClose" class="icon-button" aria-label="進捗報告を閉じる">×</button></div>
<div class="progress-controls"><label>定例<select id="progressKind"><option value="personal">チーム定例</option><option value="organizer">Organizer定例</option><option value="plenary">全体定例</option></select></label><label>報告対象日<input type="date" id="progressDate"></label><label>報告者<input id="progressReporter" maxlength="40" value="白木海斗"></label><details id="progressTeamPicker"><summary id="progressTeamLabel">対象チーム</summary><button type="button" id="progressAllTeams" class="text-button">全登録チームを選択</button><div id="progressTeams"></div></details></div>
<div class="progress-actions"><button type="button" id="progressGenerate" class="button button-primary">進捗報告を作成</button><label>生成履歴<select id="progressHistory"><option value="">履歴を選択</option></select></label><button type="button" id="progressReload" class="text-button">履歴・資料を再取得</button></div>
<p id="progressStatus" role="status"></p><details id="progressChecks" hidden><summary id="progressChecksHeading">確認事項</summary><div id="progressChecksBody"></div></details><div id="progressResults" class="progress-results"></div>
<div id="progressSaveControls" hidden><label><input type="checkbox" id="progressUsed">内容・根拠・不足情報を確認し、実際にこの定例で使用した版です</label><div class="progress-actions"><button type="button" id="progressSave" class="button">下書きを保存</button><button type="button" id="progressFinalize" class="button">使用済み確定版として保存</button></div></div>
<details id="progressSettings"><summary>参照資料・対象期間の設定</summary><p>本文は選択した資料だけを読みます。報告は下書きです。元の資料への転記や送信は行いません。</p><div class="progress-controls"><label>期間の開始（空欄なら前回の同じ定例から）<input type="date" id="progressStart"></label><label>期間の終了（空欄なら報告対象日）<input type="date" id="progressEnd"></label><label>議事録での本人表記・別名（カンマ区切り）<input id="progressAliases" maxlength="204"></label></div><p id="progressCoverage"></p><label>資料を検索<input type="search" id="progressSourceSearch" placeholder="議事録、レポート、管理シート…"></label><div id="progressSources" class="progress-source-list"></div><details><summary>フォルダ配下を追加して参照する</summary><p>含まれる全ファイルを対象にします。12件を超える場合は省略せず停止します。</p><div id="progressFolders" class="progress-source-list"></div></details><div id="progressAuthorization"><p>DocsとSheetsの本文の閲覧には追加認可が必要です。Googleの認可範囲は閲覧可能な全Googleドキュメント・スプレッドシートですが、このアプリが読むのは上で選択した資料だけです。読み取り専用で、編集権限は要求しません。認可メールは届きません。</p><label><input type="checkbox" id="progressConsent">読み取り権限と選択対象を確認しました</label><button type="button" id="progressConnect" class="button">Googleの認可画面を開く</button></div></details>`;
document.body.append(dialog);
// 作成に必要な条件だけを上に置き、履歴と参照設定は結果の下から開く。
const historySection = node("details");
historySection.id = "progressHistorySection";
historySection.append(node("summary", "保存した報告を開く"));
const historyActions = node("div", undefined, "progress-actions");
historyActions.append(
  el("progressHistory").closest("label"),
  el("progressReload"),
);
const exportButton = node("button", "報告履歴をバックアップ", "button");
exportButton.type = "button";
exportButton.id = "progressExport";
const exportScope = node("select");
exportScope.id = "progressExportScope";
exportScope.setAttribute("aria-label", "バックアップの対象");
for (const [value, label] of [["all", "全履歴"], ["current", "表示中の報告だけ"]]) {
  const option = node("option", label);
  option.value = value;
  exportScope.append(option);
}
historyActions.append(exportScope, exportButton);
const archiveButton = node("button", "表示中の報告をアーカイブ", "button");
archiveButton.type = "button";
archiveButton.id = "progressArchive";
historyActions.append(archiveButton);
const archivedLabel = node("label");
const archivedToggle = node("input");
archivedToggle.type = "checkbox";
archivedToggle.id = "progressShowArchived";
archivedLabel.append(archivedToggle, node("span", "アーカイブ済みも表示"));
historyActions.append(archivedLabel);
historySection.append(historyActions);
const restoreSection = node("details");
restoreSection.append(node("summary", "報告バックアップから復元"));
const restoreLabel = node("label", "バックアップファイル（最大16MiB）");
const restoreFile = node("input");
restoreFile.type = "file";
restoreFile.accept = ".json,application/json";
restoreFile.id = "progressRestoreFile";
restoreLabel.append(restoreFile);
const restoreButton = node("button", "内容を確認して復元", "button");
restoreButton.type = "button";
restoreButton.id = "progressRestore";
const restoreStatus = node("p");
restoreStatus.id = "progressRestoreStatus";
restoreStatus.setAttribute("role", "status");
restoreSection.append(restoreLabel, restoreStatus, restoreButton);
historySection.append(restoreSection);
historySection.append(
  node(
    "p",
    "保存済みの報告文・根拠を含むファイルです。共有先と保存場所に注意してください。未保存の編集は含みません。",
  ),
);
el("progressSettings").before(historySection);

const status = (text) => (el("progressStatus").textContent = text);
const texts = () =>
  [...el("progressResults").querySelectorAll("textarea")].map(
    (area) => area.value,
  );
const edited = () => record && JSON.stringify(texts()) !== initialTexts;
function controls() {
  for (const item of dialog.querySelectorAll("button,input,select,textarea"))
    item.disabled = busy;
  el("progressFinalize").disabled =
    busy || !el("progressUsed").checked || record?.status === "final";
  el("progressSave").disabled = busy || !record || record.status === "final";
  el("progressConnect").disabled = busy || !el("progressConsent").checked;
  el("progressGenerate").disabled = busy || !view;
  el("progressRestore").disabled = busy || !restoreCandidate;
  el("progressArchive").disabled = busy || !record;
  el("progressArchive").textContent = record?.archivedAt
    ? "表示中の報告を通常一覧へ戻す"
    : "表示中の報告をアーカイブ";
  if (record?.status === "final")
    for (const area of el("progressResults").querySelectorAll("textarea"))
      area.readOnly = true;
}
async function api(input) {
  const response = await sessionFetch("/api/meetings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "報告を処理できませんでした");
  return result;
}
function teamLabel() {
  el("progressTeamLabel").textContent =
    "対象チーム：" +
    [...el("progressTeams").querySelectorAll("input:checked")]
      .map((input) => input.dataset.name)
      .join("・");
}
function historyOptions() {
  el("progressHistory").replaceChildren(
    new Option("履歴を選択", ""),
    ...[
      ...view.history,
      ...(el("progressShowArchived").checked ? view.archivedHistory || [] : []),
    ].map(
      (item) =>
        new Option(
          `${item.archivedAt ? "[アーカイブ] " : ""}${item.reportDate} ${kinds[item.kind][0]} · ${item.teams.join("・")} · ${item.status === "final" ? "使用済み確定版" : "下書き"}`,
          item.id,
        ),
    ),
  );
}
function formRequest() {
  return {
    scope: view.scope,
    kind: el("progressKind").value,
    reportDate: el("progressDate").value,
    reporter: el("progressReporter").value.trim(),
    startDate: el("progressStart").value || null,
    endDate: el("progressEnd").value || el("progressDate").value,
    aliases: el("progressAliases")
      .value.split(/[,、]/)
      .map((value) => value.trim())
      .filter(Boolean),
    teams: [...el("progressTeams").querySelectorAll("input:checked")].map(
      (input) => input.value,
    ),
    sources: [...el("progressSources").querySelectorAll("input:checked")].map(
      (input) => ({
        id: input.value,
        role: input.closest(".progress-source").querySelector("select").value,
      }),
    ),
    folders: [...el("progressFolders").querySelectorAll("input:checked")].map(
      (input) => input.value,
    ),
  };
}
async function loadForm() {
  view = await api({ action: "reportView" });
  historyOptions();
  const defaults = view.defaults;
  el("progressReporter").value = defaults.reporter || "白木海斗";
  el("progressAliases").value = (defaults.aliases || []).join(", ");
  el("progressDate").value = date();
  el("progressStart").value = "";
  el("progressEnd").value = "";
  el("progressTeams").replaceChildren(
    ...view.teams.map((team, index) => {
      const label = node("label"),
        input = node("input");
      input.type = "checkbox";
      input.value = team.path;
      input.dataset.name = team.name;
      input.checked = index === 0;
      input.onchange = teamLabel;
      label.append(input, node("span", team.name));
      return label;
    }),
  );
  teamLabel();
  el("progressSources").replaceChildren(
    ...view.sources.map((file) => {
      const row = node("div", undefined, "progress-source"),
        label = node("label"),
        input = node("input"),
        role = node("select");
      input.type = "checkbox";
      input.value = file.id;
      input.checked =
        defaults.sources?.some((source) => source.id === file.id) || false;
      row.dataset.search = (file.name + " " + file.folder).toLowerCase();
      label.append(
        input,
        node(
          "span",
          file.name +
            " · " +
            file.folder +
            (file.supported ? "" : "（本文未対応）"),
        ),
      );
      role.setAttribute("aria-label", file.name + "の資料区分");
      for (const [value, name] of [
        ...Object.entries(kinds).map(([key, [name]]) => [key, name]),
        ["work", "作業資料・レポート"],
      ])
        role.append(new Option(name, value));
      role.value =
        defaults.sources?.find((source) => source.id === file.id)?.role ||
        file.suggestedRole;
      row.append(label, role);
      return row;
    }),
  );
  el("progressFolders").replaceChildren(
    ...view.folders.map((folder) => {
      const label = node("label"),
        input = node("input");
      input.type = "checkbox";
      input.value = folder;
      label.append(input, node("span", folder));
      return label;
    }),
  );
  el("progressAuthorization").hidden =
    view.authorized.docs && view.authorized.sheets;
  el("progressCoverage").textContent =
    `Drive最終成功 ${time(view.lastDriveSuccess)}。一度に読む資料は最大${view.maximumSources}件。Docs：${view.authorized.docs ? "閲覧認可済み" : "未認可"} ／ Sheets：${view.authorized.sheets ? "閲覧認可済み" : "未認可"}。${view.driveWarning || ""}`;
}
async function openReport(kind = "personal", path) {
  if (busy) return;
  if (
    edited() &&
    !(await confirmDiscard("未保存の報告編集を破棄して設定を開き直しますか？"))
  )
    return;
  record = null;
  initialTexts = "";
  el("progressResults").replaceChildren();
  el("progressSaveControls").hidden = true;
  el("progressChecks").hidden = true;
  if (!dialog.open) dialog.showModal();
  busy = true;
  controls();
  try {
    await loadForm();
    el("progressKind").value = kind;
    if (path) {
      const selected = [...el("progressTeams").querySelectorAll("input")].find(
        (input) => input.value === path,
      );
      if (selected) {
        for (const input of el("progressTeams").querySelectorAll("input"))
          input.checked = input === selected;
        teamLabel();
        const relevant = view.sources
          .filter(
            (file) =>
              file.supported &&
              (file.folder === path || file.folder.startsWith(path + " / ")),
          )
          .slice(0, 5)
          .map((file) => file.id);
        for (const input of el("progressSources").querySelectorAll("input"))
          input.checked =
            relevant.includes(input.value) ||
            view.defaults.sources?.some(
              (source) =>
                source.id === input.value &&
                view.sources.find((file) => file.id === source.id)?.folder ===
                  path.split(" / ")[0],
            );
      }
    }
    status(
      "定例・対象を確認して作成してください。生成だけでは確定版になりません。",
    );
  } catch (error) {
    status(error.message);
  } finally {
    busy = false;
    controls();
  }
}
function sourceLink(record, id, tab) {
  const link = node("a", "資料を開く ↗");
  link.href = "https://drive.google.com/open?id=" + encodeURIComponent(id);
  if (
    tab &&
    record.sources.find((source) => source.id === id)?.mimeType ===
      "application/vnd.google-apps.document"
  )
    link.href =
      "https://docs.google.com/document/d/" +
      encodeURIComponent(id) +
      "/edit?tab=" +
      encodeURIComponent(tab);
  link.target = "_blank";
  link.rel = "noreferrer";
  return link;
}
function renderRecord(value) {
  record = value;
  el("progressResults").replaceChildren();
  for (const result of record.results) {
    const card = node("article", undefined, "progress-result"),
      heading = node("h3", result.team.name),
      area = node("textarea");
    area.value = result.text;
    area.maxLength = 6000;
    area.rows = Math.min(
      18,
      Math.max(6, result.text.split(/\r?\n/).length + 1),
    );
    area.setAttribute("aria-label", result.team.name + "の報告文");
    const copy = node("button", "コピー", "button");
    copy.type = "button";
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(area.value);
        status("報告をコピーしました。元資料への書き込みはしていません。");
      } catch {
        area.focus();
        area.select();
        status("選択した本文をCtrl+Cでコピーしてください。");
      }
    };
    card.append(
      heading,
      node(
        "small",
        `${kinds[record.request.kind][0]} · 報告対象日 ${record.request.reportDate} · 期間 ${result.period?.startDate || record.period.startDate}〜${result.period?.endDate || record.period.endDate} · ` +
          (record.status === "final" ? "使用済み確定版" : "下書き") +
          " · 比較元：" +
          result.baseline.kind +
          (result.baseline.date ? " " + result.baseline.date : "") +
          (record.edited ? " · 本人編集あり（根拠は生成時の内容）" : ""),
      ),
      area,
      copy,
    );
    const evidence = node("details");
    evidence.append(
      node("summary", `項目の根拠・前回との差分（${result.items.length}件）`),
    );
    for (const item of result.items) {
      const detail = node("details", undefined, "progress-evidence-item");
      detail.append(
        node("summary", item.text),
        node(
          "p",
          `判定：${{ done: "完了", next: "未完了の記載", consult: "相談・共有" }[item.kind]} ／ 段階：${item.stage} ／ 実施・記載日 ${item.date || "不明"} ／ 期限 ${item.due || "不明"} ／ 担当 ${item.owner || (item.personal ? record.request.reporter : "不明")}`,
        ),
        node(
          "p",
          item.change +
            " ／ " +
            item.countBasis +
            " ／ " +
            (item.dateBasis || "資料の明示日付"),
        ),
      );
      for (const reference of item.references || [item]) {
        const source = record.sources.find(
          (source) => source.id === reference.sourceId,
        );
        detail.append(
          node(
            "p",
            `${source?.name || "資料"} · ${source?.folder || ""} ／ 更新 ${time(source?.modifiedTime)} ／ ${reference.meetingDate || reference.heading || "日付不明"} ／ 見出し ${reference.path || reference.heading || "不明"} ／ 行・位置 ${reference.index}`,
          ),
          sourceLink(record, reference.sourceId, reference.tabId),
        );
      }
      evidence.append(detail);
    }
    evidence.append(
      node(
        "p",
        `前回との差分：新規完了 ${result.comparison?.newDone || 0}項目 ／ 継続Next Actions ${result.comparison?.continuedNext || 0}項目。前回だけにある記載は、完了と推測しません。`,
      ),
    );
    for (const old of result.comparison?.previousOnly || [])
      evidence.append(node("p", "前回だけにある記載（扱い未確認）：" + old));
    for (const [stage, count] of Object.entries(result.community))
      evidence.append(
        node(
          "p",
          `${stage}：期間内 ${count.period}団体 ／ 読み取り範囲の累計 ${count.cumulative}団体。${count.basis}`,
        ),
      );
    if (result.omitted)
      evidence.append(
        node(
          "p",
          `本文の分量調整で省略した項目があります。根拠全件を確認してください。`,
        ),
      );
    card.append(evidence);
    el("progressResults").append(card);
  }
  const checks = [
    ...new Map(
      [
        ...record.checks,
        ...record.results.flatMap((result) => result.checks),
      ].map((check) => [
        JSON.stringify([
          check.sourceId,
          check.message,
          check.text,
          check.heading,
        ]),
        check,
      ]),
    ).values(),
  ];
  el("progressChecks").hidden = !checks.length;
  el("progressChecksHeading").textContent =
    `確認事項・不足情報（${checks.length}件）`;
  el("progressChecksBody").replaceChildren(
    node(
      "p",
      `取得範囲：${record.sources.filter((source) => source.status === "read").length}/${record.sources.length}資料。期間 ${record.period.startDate}〜${record.period.endDate}`,
    ),
    ...checks.map((check) => {
      const row = node(
        "p",
        check.message +
          (check.text ? "：" + check.text : "") +
          (check.heading ? " ／ " + check.heading : ""),
      );
      if (check.sourceId) row.append(" ", sourceLink(record, check.sourceId));
      return row;
    }),
  );
  el("progressSaveControls").hidden = record.status === "final";
  el("progressUsed").checked = false;
  initialTexts = JSON.stringify(texts());
  status(
    `${record.status === "final" ? "使用済み確定版" : "下書き"} · 対象期間 ${record.period.startDate}〜${record.period.endDate} · 保存 ${time(record.updatedAt)}。元資料は変更していません。`,
  );
}
el("progressGenerate").onclick = async () => {
  if (busy || !view) return;
  if (
    edited() &&
    !(await confirmDiscard(
      "未保存の編集を保持したい場合は、先に下書きを保存してください。作り直しますか？",
    ))
  )
    return;
  const request = formRequest(),
    signature = JSON.stringify(request);
  if (!pending || pending.signature !== signature)
    pending = { id: crypto.randomUUID(), signature };
  busy = true;
  controls();
  status("選択した資料を読み取り、前回の確定版と比較しています…");
  try {
    renderRecord(
      await api({ action: "reportGenerate", id: pending.id, ...request }),
    );
    pending = null;
    try {
      view = await api({ action: "reportView" });
      historyOptions();
    } catch {
      status(
        "下書きの作成・保存は成功しました。履歴の更新だけ失敗しました。履歴を再取得してください。",
      );
    }
  } catch (error) {
    status(
      error.message +
        "。以前の下書き・入力は保持しています。結果不明の場合は、履歴を再取得して確認してください。",
    );
  } finally {
    busy = false;
    controls();
  }
};
async function save(final) {
  if (busy || !record) return;
  busy = true;
  controls();
  try {
    renderRecord(
      await api({
        action: "reportSave",
        scope: view.scope,
        id: record.id,
        expectedRevision: record.revision,
        status: final ? "final" : "draft",
        confirmUsed: el("progressUsed").checked,
        texts: texts(),
      }),
    );
    try {
      view = await api({ action: "reportView" });
      historyOptions();
    } catch {
      status(
        "報告の保存は成功しました。履歴の更新だけ失敗しました。再送せず、履歴を再取得してください。",
      );
    }
  } catch (error) {
    status(
      error.message +
        "。編集を保持しています。結果不明の操作は自動で再送しません。",
    );
  } finally {
    busy = false;
    controls();
  }
}
el("progressSave").onclick = () => save(false);
el("progressFinalize").onclick = () => save(true);
el("progressUsed").onchange = controls;
el("progressConsent").onchange = controls;
el("progressAllTeams").onclick = () => {
  for (const input of el("progressTeams").querySelectorAll("input"))
    input.checked = true;
  teamLabel();
};
el("progressSourceSearch").oninput = () => {
  const query = el("progressSourceSearch").value.toLowerCase();
  for (const row of el("progressSources").children)
    row.hidden = !row.dataset.search.includes(query);
};
el("progressHistory").onchange = async () => {
  const id = el("progressHistory").value;
  if (!id || busy) return;
  if (
    edited() &&
    !(await confirmDiscard("未保存の編集を破棄して履歴を開きますか？"))
  )
    return;
  busy = true;
  controls();
  try {
    renderRecord(await api({ action: "reportLoad", id }));
  } catch (error) {
    status(error.message);
  } finally {
    busy = false;
    controls();
  }
};
el("progressReload").onclick = async () => {
  if (busy) return;
  busy = true;
  controls();
  try {
    view = await api({ action: "reportView" });
    historyOptions();
    status(
      "履歴を再取得しました。資料と設定の選択を更新する場合は、一度閉じて開き直してください。編集は保持しています。",
    );
  } catch (error) {
    status(error.message);
  } finally {
    busy = false;
    controls();
  }
};
async function close() {
  if (busy) return;
  if (
    edited() &&
    !(await confirmDiscard("未保存の報告編集を破棄して閉じますか？"))
  )
    return;
  dialog.close();
  record = null;
  initialTexts = "";
}
el("progressClose").onclick = close;
dialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  void close();
});
el("progressConnect").onclick = async () => {
  if (busy || !el("progressConsent").checked) return;
  busy = true;
  controls();
  try {
    const response = await sessionFetch("/auth/google/progress-start", {
        method: "POST",
      }),
      result = await response.json();
    if (!response.ok || !result.authorizationUrl)
      throw Error(result.error || "認可を開始できません");
    window.location.assign(result.authorizationUrl);
  } catch (error) {
    status(error.message);
    busy = false;
    controls();
  }
};
document.addEventListener("dashboard:open-progress-report", (event) =>
  openReport(event.detail?.kind || "personal", event.detail?.path),
);
window.addEventListener("beforeunload", (event) => {
  if (edited()) {
    event.preventDefault();
    event.returnValue = "";
  }
});
controls();

for (const id of [
  "progressKind",
  "progressDate",
  "progressReporter",
  "progressStart",
  "progressEnd",
  "progressAliases",
  "progressTeams",
  "progressSources",
  "progressFolders",
]) {
  el(id).addEventListener("change", () => {
    if (record)
      status(
        `条件を変更しました。表示中は${kinds[record.request.kind][0]}・${record.request.reportDate}の保存結果です。新しい条件で使う場合は作成し直してください。`,
      );
  });
}

el("progressExport").onclick = async () => {
  if (busy) return;
  const currentOnly = el("progressExportScope").value === "current";
  if (currentOnly && !record) {
    status("先にバックアップする報告を履歴から開いてください。");
    return;
  }
  busy = true;
  controls();
  let url;
  try {
    const backup = await api({ action: "reportExport", ...(currentOnly ? { id: record.id } : {}) });
    const blob = new Blob([JSON.stringify(backup)], {
      type: "application/json",
    });
    url = URL.createObjectURL(blob);
    const link = node("a");
    link.href = url;
    link.download = "personal-dashboard-reports-" + date() + ".json";
    document.body.append(link);
    link.click();
    link.remove();
    status(
      `保存済み報告${backup.records.length}件のダウンロードを開始しました。ブラウザーの保存結果を確認してください。`,
    );
  } catch (error) {
    status(error.message);
  } finally {
    if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
    busy = false;
    controls();
  }
};

el("progressShowArchived").onchange = historyOptions;
el("progressArchive").onclick = async () => {
  if (busy || !record) return;
  if (edited()) {
    status("未保存の編集があります。先に下書きを保存してください。");
    return;
  }
  const archived = !record.archivedAt;
  const label = archived ? "アーカイブする" : "通常一覧へ戻す";
  if (
    !(await confirmAction(
      `${record.request.reportDate} ${kinds[record.request.kind][0]}・${record.results.map((result) => result.team.name).join("・")}を${label}操作です。本文・根拠・前回比較は保持されます。`,
      label,
    ))
  )
    return;
  busy = true;
  controls();
  let saved = false;
  try {
    renderRecord(
      await api({
        action: "reportArchive",
        id: record.id,
        scope: view.scope,
        expectedRevision: record.revision,
        archived,
      }),
    );
    saved = true;
    view = await api({ action: "reportView" });
    historyOptions();
    status(
      archived
        ? "アーカイブしました。下側の履歴でアーカイブ済みを表示すると戻せます。"
        : "通常の履歴一覧へ戻しました。",
    );
  } catch (error) {
    status(
      (saved
        ? "整理は保存済みですが、履歴の再取得に失敗しました。"
        : "結果不明の場合は履歴から再取得してください。") + error.message,
    );
  } finally {
    busy = false;
    controls();
  }
};

el("progressRestoreFile").onchange = async () => {
  restoreCandidate = null;
  const file = el("progressRestoreFile").files[0];
  if (!file || busy) {
    controls();
    return;
  }
  busy = true;
  controls();
  try {
    if (file.size > 16 * 1024 * 1024)
      throw Error("ファイル上限16MiBを超えています");
    const backup = JSON.parse(await file.text());
    const plan = await api({ action: "reportRestorePreview", backup });
    el("progressRestoreStatus").textContent =
      `${plan.records}件（通常${plan.active}・アーカイブ${plan.archived}）。` +
      (plan.conflicts.length
        ? `既存報告との重複${plan.conflicts.length}件のため停止しています。`
        : plan.capacityExceeded
          ? "履歴の保存上限を超えています。"
          : "既存報告を上書きせず復元できます。");
    if (plan.records && !plan.conflicts.length && !plan.capacityExceeded)
      restoreCandidate = { backup, ...plan };
  } catch (error) {
    el("progressRestoreStatus").textContent = error.message;
  } finally {
    busy = false;
    controls();
  }
};
el("progressRestore").onclick = async () => {
  if (busy || !restoreCandidate) return;
  if (edited()) {
    status("未保存の編集があります。先に保存してください。");
    return;
  }
  const candidate = restoreCandidate;
  if (
    !(await confirmAction(
      `報告${candidate.records}件を復元します。下書き・確定版と根拠を保持し、元のGoogle資料は変更しません。`,
      "復元する",
    ))
  )
    return;
  busy = true;
  restoreCandidate = null;
  controls();
  let saved = false;
  try {
    const result = await api({
      action: "reportRestore",
      backup: candidate.backup,
      checksum: candidate.checksum,
      expectedRevision: candidate.expectedRevision,
      confirm: true,
    });
    saved = true;
    el("progressRestoreStatus").textContent =
      `${result.restored}件を復元しました。`;
    view = await api({ action: "reportView" });
    historyOptions();
  } catch (error) {
    el("progressRestoreStatus").textContent =
      (saved
        ? "復元は保存済みです。履歴を再取得してください。"
        : "結果不明の場合は履歴を再取得し、ファイルを選び直して照合してください。") +
      error.message;
  } finally {
    busy = false;
    controls();
  }
};
