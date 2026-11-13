export class SlackError extends Error {
  constructor(message, code = "remote", retryAt = null) {
    super(message);
    this.code = code;
    this.retryAt = retryAt;
  }
}
const maximumResponseBytes = 2 * 1024 * 1024;
async function jsonBody(response) {
  if (!response.body) throw new SlackError("Slackの応答が空です", "incomplete");
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximumResponseBytes)
        throw new SlackError("Slack応答が取得上限を超えました", "limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SlackError("Slackの応答形式が不正です", "incomplete");
  }
}
export async function slackRequest(method, parameters, token, send = fetch) {
  const url = new URL("https://slack.com/api/" + method);
  let response;
  try {
    response = await send(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: new URLSearchParams(parameters).toString(),
    });
  } catch {
    throw new SlackError("Slackとの通信失敗・タイムアウトです", "network");
  }
  if (response.status === 429) {
    const seconds = Number(response.headers.get("retry-after"));
    throw new SlackError(
      "Slackの利用制限です。待機後に再取得します",
      "rate",
      Date.now() +
        Math.max(60000, (Number.isFinite(seconds) ? seconds : 60) * 1000),
    );
  }
  if (response.status >= 500)
    throw new SlackError("Slack側で一時的な障害が発生しています", "remote");
  if (!response.ok)
    throw new SlackError(
      "Slackの認証・API設定を確認してください",
      response.status === 401 ? "authentication" : "permission",
    );
  const result = await jsonBody(response);
  if (result.ok === true) return result;
  if (
    [
      "invalid_auth",
      "token_revoked",
      "token_expired",
      "account_inactive",
      "not_authed",
    ].includes(result.error)
  )
    throw new SlackError("Slackの再接続が必要です", "authentication");
  if (
    [
      "missing_scope",
      "not_in_channel",
      "no_permission",
      "restricted_action",
    ].includes(result.error)
  )
    throw new SlackError(
      "Slackの権限と対象チャンネルへのBot参加を確認してください",
      "permission",
    );
  if (["channel_not_found", "is_archived"].includes(result.error))
    throw new SlackError("チャンネルがないかアクセスできません", "missing");
  if (result.error === "ratelimited")
    throw new SlackError("Slackの利用制限です", "rate", Date.now() + 60000);
  throw new SlackError("Slack APIの処理に失敗しました", "remote");
}
