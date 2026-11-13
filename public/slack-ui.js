import { sessionFetch as fetch } from "./session-connection.js";
import { confirmAction } from "./confirm.js";
const el = (id) => document.getElementById(id);
const time = (value) =>
  value
    ? new Date(value).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
    : "未取得";
let state = null,
  busy = false;
async function api(body, teamId = state?.teamId) {
  if (body) body = { ...body, teamId };
  const response = await fetch(
    "/api/slack" +
      (!body && teamId ? "?teamId=" + encodeURIComponent(teamId) : ""),
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );

  const result = await response.json();
  if (!response.ok) throw Error(result.error || "Slackの処理に失敗しました");
  return result;
}
function controls() {
  for (const id of [
    "slackRefresh",
    "slackConnect",
    "slackStop",
    "slackAddChannel",
    "slackTeamInput",
    "slackPrivateInput",
    "slackChannelInput",
    "slackWorkspace",
    "slackClientId",
    "slackClientSecret",
    "slackAppConfirm",
    "slackAppSave",
  ])
    el(id).disabled = busy;
  el("slackAppSave").disabled ||= !el("slackAppConfirm").checked;
  el("slackConnect").disabled ||= !state?.configured;
  el("slackStop").disabled ||= !state?.connection?.connected;
  el("slackAddChannel").disabled ||=
    !state?.connection?.connected || state?.job.active;
  el("slackRefresh").disabled ||=
    !state?.connection?.connected || !state.channels.length || state.job.active;
  for (const button of el("slackChannels").querySelectorAll("button"))
    button.disabled = busy;
}
function render() {
  if (!state) return;
  el("slackWorkspace").replaceChildren(
    ...state.workspaces.map((workspace) => {
      const option = document.createElement("option");
      option.value = workspace.teamId;
      option.textContent =
        workspace.teamName + (workspace.connected ? "" : "（再接続が必要）");
      return option;
    }),
  );
  el("slackWorkspace").value = state.teamId || "";
  el("slackScopes").textContent =
    "保存 " +
    state.workspaces.length +
    "/" +
    state.maximumWorkspaces +
    "ワークスペース ／ 実際の認可権限：" +
    (state.scopes.join("・") || "未認可");
  el("homeSlackStatus").textContent =
    (state.workspaces.some((workspace) => workspace.connected)
      ? "Slack接続済み " +
        state.workspaces.filter((workspace) => workspace.connected).length +
        "ワークスペース"
      : "Slack未接続");
  el("slackStatus").textContent = !state.configured
    ? "専用Slackアプリの設定待ちです。必要な権限と対象を確認してから接続します。"
    : !state.connection?.connected
      ? "未接続・再認可が必要です。保存済み情報は残しています。"
      : state.connection.teamName +
        " ／ " +
        state.channels.length +
        "/" +
        state.maximumChannels +
        "チャンネル・毎時取得" +
        (state.job.active ? " ／ 取得中・前回の一覧を表示" : "") +
        (state.scheduler?.lastTriggeredAt
          ? " ／ 前回Cron " + time(state.scheduler.lastTriggeredAt)
          : " ／ Cron未記録");
  el("slackChannels").replaceChildren(
    ...state.channels.map((channel) => {
      const section = document.createElement("section"),
        heading = document.createElement("h3"),
        status = document.createElement("p");
      heading.textContent =
        "#" + channel.name + (channel.private ? "（非公開）" : "");
      status.textContent =
        `取得済み ${channel.messages.length}件 ／ 最終試行 ${time(channel.lastAttempt)} ／ 最終成功 ${time(channel.lastSuccess)}` +
        (channel.lastSuccess &&
        Date.now() - Date.parse(channel.lastSuccess) > 3600000
          ? " ／ 1時間以上前の保存情報"
          : "") +
        (channel.error ? " ／ 取得失敗：" + channel.error : "") +
        (channel.limited
          ? " ／ 上限・Slack側の履歴制限があり全件ではありません"
          : "") +
        (channel.oldest
          ? " ／ 対象 " +
            time(Number(channel.oldest) * 1000) +
            "〜" +
            time(Number(channel.latest) * 1000)
          : " ／ 未取得");
      section.append(heading, status);
      const shown = channel.messages.filter(
        (message) =>
          el("slackShowReviewed").checked ||
          channel.reviews[message.ts]?.revision !== message.revision,
      );
      for (const message of shown) {
        const row = document.createElement("article"),
          meta = document.createElement("small"),
          text = document.createElement("p"),
          link = document.createElement("a"),
          review = document.createElement("button");
        row.className = "slack-message";
        meta.textContent =
          time(Number(message.ts) * 1000) +
          " ／ " +
          (message.user || "Bot・システム") +
          " ／ 返信 " +
          message.replyCount +
          "件（本文未取得）";
        text.textContent =
          message.text || "本文なし・添付等は元のSlackで確認してください";
        if (message.truncated)
          text.textContent += "\n（本文は6000文字までの抜粋）";
        if (message.attachmentCount)
          text.textContent +=
            "\n添付等 " + message.attachmentCount + "件（本文未取得）";
        link.href = message.url;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = "Slackで開く ↗";
        const reviewed =
          channel.reviews[message.ts]?.revision === message.revision;
        review.type = "button";
        review.className = "button button-small";
        review.textContent = reviewed
          ? "未確認に戻す"
          : "アプリで確認済みにする";
        review.onclick = () =>
          run({
            action: "review",
            channelId: channel.id,
            ts: message.ts,
            revision: message.revision,
            reviewed: !reviewed,
          });
        row.append(meta, text, link, review);
        section.append(row);
      }
      if (!shown.length) {
        const empty = document.createElement("p");
        empty.textContent =
          "この取得範囲に未確認の投稿はありません。全件表示や取得状況も確認してください。";
        section.append(empty);
      }
      return section;
    }),
  );
  controls();
}
async function run(body, teamId) {
  if (busy) return;
  busy = true;
  controls();
  try {
    state = await api(body, teamId);
    render();
  } catch (error) {
    el("slackStatus").textContent =
      error.message + "。表示中の保存情報は最新とは限りません。";
  } finally {
    busy = false;
    controls();
  }
}
el("slackWorkspace").onchange = () => run(null, el("slackWorkspace").value);
el("slackAppConfirm").onchange = controls;
el("slackAppSave").onclick = async () => {
  if (busy || !el("slackAppConfirm").checked) return;
  const clientId = el("slackClientId").value.trim(),
    clientSecret = el("slackClientSecret").value.trim();
  el("slackClientSecret").value = "";
  el("slackAppConfirm").checked = false;
  await run({ action: "configure", clientId, clientSecret, confirm: true });
};
el("slackShowReviewed").onchange = render;
el("slackRefresh").onclick = () => run({ action: "refresh" });
el("slackAddChannel").onclick = () =>
  run({
    action: "addChannel",
    channelId: el("slackChannelInput").value.trim(),
  });
el("slackStop").onclick = async () => {
  if (busy) return;
  if (
    await confirmAction(
      "Slackの取得を停止し、アプリが保存する接続トークンを破棄します。チャンネル設定・保存済み投稿・確認記録は保持します。Slack側のアプリ削除や認可取消は行いません。",
      "Slack接続を停止する",
    )
  )
    await run({ action: "stop", confirm: true });
};
el("slackConnect").onclick = async () => {
  if (busy) return;
  busy = true;
  controls();
  try {
    const response = await fetch("/auth/slack/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        teamId: el("slackTeamInput").value.trim(),
        includePrivate: el("slackPrivateInput").checked,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "Slack認可を開始できません");
    location.assign(result.authorizationUrl);
  } catch (error) {
    el("slackStatus").textContent = error.message;
    busy = false;
    controls();
  }
};
setInterval(() => {
  if (
    document.body.dataset.view === "slack" &&
    !busy &&
    document.activeElement?.tagName !== "INPUT"
  )
    run();
}, 30000);
await run(
  null,
  new URLSearchParams(location.search).get("teamId") || undefined,
);
if (new URLSearchParams(location.search).get("view") === "slack") {
  document.dispatchEvent(
    new CustomEvent("dashboard:show-panel", {
      detail: { panel: "slack", focusId: "slackHeading" },
    }),
  );
  history.replaceState(null, "", location.pathname);
}
