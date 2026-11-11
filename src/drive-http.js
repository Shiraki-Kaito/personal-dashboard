export class DriveError extends Error {
  constructor(message, code = "remote", retryAt = null) {
    super(message);
    this.code = code;
    this.retryAt = retryAt;
  }
}

export async function googleRequest(url, options = {}, send = fetch) {
  try {
    return await send(url, {
      ...options,
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    throw new DriveError(
      ["AbortError", "TimeoutError"].includes(error.name)
        ? "Googleへの接続がタイムアウトしました"
        : "Googleとの通信に失敗しました",
      "network",
    );
  }
}

const maxDriveRequests = 40;
export function driveClient(token, send = fetch) {
  let requests = 0;
  return async (path, parameters) => {
    const url = new URL("https://www.googleapis.com/drive/v3/" + path);
    url.search = new URLSearchParams(parameters);
    for (let attempt = 0; ; attempt++) {
      if (++requests > maxDriveRequests)
        throw new DriveError(
          "取得上限に達したため一覧は未完了です。前回の一覧を保持しています",
          "limit",
        );
      let response;
      try {
        response = await googleRequest(
          url,
          {
            headers: { Authorization: "Bearer " + token },
          },
          send,
        );
      } catch (error) {
        if (attempt > 0) throw error;
      }
      if (response) {
        const body = await response.json().catch(() => ({}));
        if (response.ok) {
          if (body.error) throw new DriveError("Google APIの応答が不正です");
          return body;
        }
        if (response.status === 401)
          throw new DriveError("Googleへの再接続が必要です", "authentication");
        const reasons = (body.error?.errors || []).map((e) => e.reason);
        if (
          response.status === 429 ||
          reasons.some((r) =>
            [
              "rateLimitExceeded",
              "userRateLimitExceeded",
              "dailyLimitExceeded",
            ].includes(r),
          )
        ) {
          const delay = Number(response.headers.get("retry-after"));
          throw new DriveError(
            "Drive APIの利用制限に達しました",
            "rate",
            Date.now() +
              Math.max(60000, (Number.isFinite(delay) ? delay : 60) * 1000),
          );
        }
        if (response.status === 403)
          throw new DriveError(
            "フォルダへの権限またはDrive APIの有効化を確認してください",
            "permission",
          );
        if (response.status === 404)
          throw new DriveError(
            "フォルダやファイルが見つからないか、アクセスできません",
            "missing",
          );
        if (response.status < 500 || attempt > 0)
          throw new DriveError("Drive APIの取得に失敗しました");
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 + Math.random() * 1000),
      );
    }
  };
}
