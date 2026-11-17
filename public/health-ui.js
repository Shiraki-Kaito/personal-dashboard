import { sessionFetch as fetch } from "./session-connection.js";
const el = (id) => document.getElementById(id);
const labels = {
  ok: "取得成功",
  error: "取得失敗",
  stale: "古い情報",
  never: "未取得",
  disconnected: "未接続・停止",
  running: "取得中",
  queued: "順番待ち",
  retrying: "再試行待ち",
  interrupted: "取得未完了",
  limited: "取得成功・確認範囲に制限",
};
const time = (value) =>
  value ? new Date(value).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "記録なし";
let busy = false;
function text(tag, value) {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}
function openButton(source) {
  const button = text("button", source.accountId ? source.recovery?.label || "対象アカウントを開く" : "対象の画面へ");
  button.type = "button";
  button.className = "button button-small";
  button.onclick = () => {
    el("settingsDialog").close();
    document.dispatchEvent(new CustomEvent(
      source.accountId ? "dashboard:open-connection" : "dashboard:show-panel",
      { detail: source.accountId
        ? { accountId: source.accountId, service: source.service, recoveryKind: source.recovery?.kind }
        : { panel: source.panel } },
    ));
  };
  if (source.service === "slack" && source.state === "disconnected") {
    button.disabled = true;
    button.textContent = "現行版では保留中";
  }
  return button;
}
function gmailLink(url, label) {
  try {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.hostname !== "mail.google.com") return null;
    const link = text("a", label);
    link.href = target.href;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.className = "button button-small";
    return link;
  } catch { return null; }
}
function appendCoverage(row, coverage) {
  if (!coverage) return;
  if (!coverage.hasSnapshot) {
    row.append(text("p", "確認範囲：取得成功の記録がありません。続きの有無・本文の確認状況は不明です。"));
    return;
  }
  row.append(text("p", "前回成功の保存範囲：" + time(coverage.snapshotAt) + "。現在も同じ内容・件数とは限りません。"));
  row.append(text("p", `取得範囲：通常 ${coverage.standardCount}件・重要候補 ${coverage.priorityCount}件（通常枠外 ${coverage.extraCount}件）。本文の確認範囲に制限 ${coverage.bodyLimitedCount}件。`));
  row.append(text("p", `通常の続き：${coverage.standardHasMore ? "未取得あり" : "取得済み範囲の末尾まで"} ／ 重要候補の続き：${!coverage.standardHasMore ? "通常範囲に続きなし・補完不要" : coverage.priorityHasMore ? "未取得あり" : coverage.supplementCurrent ? "補完済み・検索条件の範囲内" : "補完の再確認が必要"}`));
  if (coverage.notice) row.append(text("p", coverage.notice));
  if (coverage.standardHasMore) {
    const link = gmailLink(coverage.standardUrl, "Gmailで通常検索を開く（未取得分を含む）");
    if (link) row.append(link);
  }
  if (coverage.standardHasMore || coverage.priorityHasMore) {
    const link = gmailLink(coverage.priorityUrl, "Gmailで重要候補の検索を開く");
    if (link) row.append(link);
  }
}
async function refreshHealth() {
  if (busy) return;
  busy = true;
  el("healthRefresh").disabled = true;
  el("healthSources").setAttribute("aria-busy", "true");
  for (const button of document.querySelectorAll("#healthSources button,#healthPending button")) button.disabled = true;
  try {
    const response = await fetch("/api/health");
    if (!response.ok)
      throw Error(
        "接続状況を取得できません。本人のログイン状態を確認してください",
      );
    const result = await response.json();
    el("healthSummary").textContent =
      "要確認 " +
      result.attentionCount +
      "項目 ／ 保存状態の確認 " +
      time(result.checkedAt) +
      "。この操作は外部取得・再送を行いません。";
    el("healthSources").replaceChildren(
      ...result.sources.map((source) => {
        const row = document.createElement("article");
        row.className = "health-row";
        row.dataset.state = source.state;
        row.dataset.service = source.service;
        if (source.accountId) row.dataset.accountId = source.accountId;
        row.append(
          text(
            "h4",
            source.label +
              (source.test ? "（試験用）" : "") +
              " · " +
              labels[source.state],
          ),
          text(
            "p",
            "最終試行 " +
              time(source.lastAttempt) +
              " ／ 最終成功 " +
              time(source.lastSuccess) +
              (source.count === null ? "" : " ／ 保存 " + source.count + "件") +
              (source.cron ? " ／ Cron起動 " + time(source.cron) : ""),
          ),
          text(
            "p",
            source.guidance +
              (source.errorCode ? "（" + source.errorCode + "）" : "") +
              (source.retryAt && source.recovery?.kind === "wait" ? " ／ 再試行可能 " + time(source.retryAt) : ""),
          ),
          text("p", source.recovery?.message || source.guidance),
        );
        if (source.progress) row.append(text("p", `取得順 ${source.progress.position}/${source.progress.total} ／ ${source.progress.phase} ／ 完了ページ ${source.progress.pages}` + (source.progress.nextAt ? " ／ 次回処理 " + time(source.progress.nextAt) : "")));
        appendCoverage(row, source.coverage);
        row.append(openButton(source));
        return row;
      }),
    );
    el("healthPending").replaceChildren(
      ...result.pending.map((item) => {
        const row = document.createElement("article");
        row.className = "health-row";
        row.append(
          text(
            "h4",
            item.label +
              " · 未処理 " +
              item.count +
              "件" +
              (item.limited ? "以上・調査上限あり" : ""),
          ),
          text("p", item.guidance),
          openButton(item),
        );
        return row;
      }),
    );
    if (!result.pending.length)
      el("healthPending").append(
        text("p", "保存済みの未同期・結果未確認記録はありません。"),
      );
    el("healthJobs").textContent = result.jobs.length
      ? result.jobs
          .map(
            (job) =>
              job.label +
              "：次回処理 " +
              time(job.nextAt) +
              (job.delayed ? "（予定時刻から5分以上経過・要確認）" : ""),
          )
          .join(" ／ ")
      : "進行中の取得ジョブはありません。";
  } catch (error) {
    el("healthSummary").textContent =
      error.message + "。表示中の情報は最新とは限りません。";
  } finally {
    busy = false;
    el("healthRefresh").disabled = false;
    el("healthSources").setAttribute("aria-busy", "false");
    for (const button of document.querySelectorAll("#healthSources button,#healthPending button")) button.disabled = false;
  }
}
el("healthRefresh").onclick = refreshHealth;
// 設定を開いた時だけ読む。通常のホーム表示で診断用の通信を増やさない。
new MutationObserver(() => {
  if (el("settingsDialog").open) refreshHealth();
}).observe(el("settingsDialog"), {
  attributes: true,
  attributeFilter: ["open"],
});
