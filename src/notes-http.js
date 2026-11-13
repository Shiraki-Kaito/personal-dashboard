// GitHub REST読み取りだけを担当する。入力URL・応答URLを通信先に使わない。
export class NotesError extends Error {
  constructor(message, code, retryAt = null) {
    super(message);
    this.code = code;
    this.retryAt = retryAt;
  }
}
const maximumResponseBytes = 2 * 1024 * 1024;
async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new NotesError("GitHubの応答が空です", "invalid_response");
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumResponseBytes)
        throw new NotesError(
          "取得上限2MiBを超えました。対象フォルダを絞ってください",
          "limit",
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new NotesError("GitHubの応答形式が不正です", "invalid_response");
  }
}
export function notesRequest(token, send = fetch) {
  return async (path) => {
    if (!path.startsWith("/repos/") && path !== "/user")
      throw new NotesError("通信先が不正です", "input");
    for (let attempt = 0; ; attempt++) {
      let failure;
      try {
        const response = await send("https://api.github.com" + path, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(8000),
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "personal-dashboard",
            "X-GitHub-Api-Version": "2026-03-10",
            ...(token ? { Authorization: "Bearer " + token } : {}),
          },
        });
        if (
          response.status === 429 ||
          (response.status === 403 &&
            (response.headers.has("retry-after") ||
              response.headers.get("x-ratelimit-remaining") === "0"))
        ) {
          const wait = Number(response.headers.get("retry-after")) * 1000;
          const reset =
            Number(response.headers.get("x-ratelimit-reset")) * 1000;
          throw new NotesError(
            "GitHubのレート制限です",
            "rate_limit",
            Math.max(Date.now() + (wait || 60000), reset || 0),
          );
        }
        if (response.status === 401)
          throw new NotesError(
            "ノート接続の認証が無効です。設定し直してください",
            "auth",
          );
        if (response.status === 403)
          throw new NotesError(
            "ノートの読み取り権限がありません",
            "permission",
          );
        if (response.status === 404)
          throw new NotesError(
            "対象が削除されたか、アクセスできません",
            "not_found",
          );
        if (response.ok) return await boundedJson(response);
        if (response.status < 500)
          throw new NotesError("GitHub APIの取得に失敗しました", "remote");
        failure = new NotesError("GitHubの一時障害です", "unavailable");
      } catch (error) {
        if (error instanceof NotesError) throw error;
        failure = new NotesError(
          ["AbortError", "TimeoutError"].includes(error.name)
            ? "ノート取得がタイムアウトしました"
            : "ノート取得の通信に失敗しました",
          ["AbortError", "TimeoutError"].includes(error.name)
            ? "timeout"
            : "network",
        );
      }
      if (attempt >= 1) throw failure;
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  };
}
