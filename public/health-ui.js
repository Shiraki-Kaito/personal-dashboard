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
};
const time = (value) =>
  value ? new Date(value).toLocaleString("ja-JP") : "記録なし";
let busy = false;
function text(tag, value) {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}
function openButton(panel) {
  const button = text("button", "対象の画面へ");
  button.type = "button";
  button.className = "button button-small";
  button.onclick = () => {
    el("settingsDialog").close();
    document.dispatchEvent(
      new CustomEvent("dashboard:show-panel", { detail: { panel } }),
    );
  };
  return button;
}
async function refreshHealth() {
  if (busy) return;
  busy = true;
  el("healthRefresh").disabled = true;
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
              (source.retryAt ? " ／ 再試行可能 " + time(source.retryAt) : ""),
          ),
          openButton(source.panel),
        );
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
          openButton(item.panel),
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
