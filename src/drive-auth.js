import { DriveError, googleRequest, driveClient } from "./drive-http.js";
import { finishDriveRun } from "./drive-history.js";

export const driveScope =
  "https://www.googleapis.com/auth/drive.metadata.readonly";
export const sheetsReadScope = "https://www.googleapis.com/auth/spreadsheets.readonly";
export const minutesReadScope = "https://www.googleapis.com/auth/documents.readonly";
const testingAuthorizationLifetimeMs = 7 * 24 * 60 * 60 * 1000;
// 公開設定の変更と、既存トークンを発行した時点の設定を区別する。
export function googleAuthorizationStatus(env, credential) {
  const publishingStatus =
    env.GOOGLE_OAUTH_PUBLISHING_STATUS === "published"
      ? "published"
      : "testing";
  const grantedPublishingStatus = credential
    ? credential.grantedPublishingStatus || "testing"
    : null;
  return {
    accountVerified: !!credential?.accountFingerprint,
    publishingStatus,
    grantedPublishingStatus,
    requiresReauthorization:
      !!credential &&
      (!!credential.invalid ||
        (publishingStatus === "published" &&
          grantedPublishingStatus !== "published")),
    reviewAt:
      credential?.connectedAt && grantedPublishingStatus !== "published"
        ? new Date(
            credential.connectedAt + testingAuthorizationLifetimeMs,
          ).toISOString()
        : null,
    accessTokenExpiresAt: Number.isFinite(credential?.expires)
      ? new Date(credential.expires).toISOString()
      : null,
    refresh: {
      lastAttempt: credential?.lastRefreshAttemptAt || null,
      lastSuccess: credential?.lastRefreshedAt || null,
      count: credential?.refreshCount || 0,
      error: credential?.lastRefreshError || null,
    },
  };
}
export function googleConfigured(env) {
  return (
    /^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(
      env.GOOGLE_CLIENT_ID || "",
    ) && !!env.GOOGLE_CLIENT_SECRET
  );
}

async function accountFingerprint(token, send) {
  const about = await driveClient(token, send)("about", {
    fields: "user(permissionId)",
  });
  const id = about.user?.permissionId;
  if (typeof id !== "string" || !id.length || id.length > 256)
    throw new DriveError(
      "Googleアカウントを照合できません。既存の一覧を保持します",
      "account",
    );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("personal-dashboard-drive:" + id),
  );
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

// 旧接続の移行も有効な通常取得で行う。ID・メールアドレスやトークンを外へ返さない。
export async function ensureDriveAccount(storage, token, send = fetch) {
  const credential = await storage.get("drive:credential");
  if (!credential || credential.token !== token)
    throw new DriveError(
      "Google接続が変更されています。再取得してください",
      "account",
    );
  if (credential.accountFingerprint) return;
  const fingerprint = await accountFingerprint(token, send);
  const current = await storage.get("drive:credential");
  if (current?.token !== token)
    throw new DriveError(
      "Google接続が変更されています。再取得してください",
      "account",
    );
  await storage.put("drive:credential", {
    ...current,
    accountFingerprint: fingerprint,
  });
}
const flowLifetimeMs = 10 * 60 * 1000;
const tokenSafetyMs = 60 * 1000;
export function random() {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export async function challenge(verifier) {
  return btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier),
        ),
      ),
    ),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export async function exchange(parameters, send) {
  const response = await googleRequest(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(parameters),
    },
    send,
  );
  const result = await response.json().catch(() => ({}));
  if (
    !response.ok ||
    !result.access_token ||
    !Number.isFinite(result.expires_in) ||
    result.expires_in <= 0
  ) {
    throw new DriveError(
      result.error === "invalid_grant"
        ? "Googleへの再接続が必要です"
        : "Googleの認可処理に失敗しました",
      result.error === "invalid_grant" ? "authentication" : "oauth",
    );
  }
  return result;
}
export async function googleConnect(
  request,
  env,
  storage,
  session,
  send = fetch,
) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
    return new Response("Google OAuthの設定が必要です", { status: 503 });
  if (!googleConfigured(env))
    return new Response(
      "GOOGLE_CLIENT_IDには末尾が.apps.googleusercontent.comのClient IDを登録してください",
      { status: 503 },
    );
  const url = new URL(request.url);
  const redirectUri = url.origin + "/auth/google/callback";
  if (["/auth/google/start", "/auth/google/report-start", "/auth/google/progress-start"].includes(url.pathname)) {
    const sheetsRead=url.pathname==="/auth/google/progress-start";
    const minutesRead=sheetsRead || url.pathname==="/auth/google/report-start";
    const state = random(),
      verifier = random();
    await storage.put("drive:flow", {
      state,
      verifier,
      sessionKey: session.key,
      publishingStatus: googleAuthorizationStatus(env, null).publishingStatus,
      minutesRead,
      sheetsRead,
      expires: Date.now() + flowLifetimeMs,
    });
    const authorization = new URL(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    authorization.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: [driveScope,...(minutesRead?[minutesReadScope]:[]),...(sheetsRead?[sheetsReadScope]:[])].join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: await challenge(verifier),
      code_challenge_method: "S256",
    });
    // no-referrer下のフォームPOSTはOriginがnullになるため、同一サイトfetchで開始する。
    return Response.json({ authorizationUrl: authorization.toString() });
  }
  const flow = await storage.get("drive:flow");
  if (
    !flow ||
    flow.expires < Date.now() ||
    flow.sessionKey !== session.key ||
    url.searchParams.get("state") !== flow.state
  )
    return new Response("認可を最初からやり直してください", { status: 403 });
  await storage.delete("drive:flow");
  if (url.searchParams.has("error") || !url.searchParams.get("code"))
    return new Response(
      "Google認可を完了できませんでした。ホームから再接続してください",
      { status: 400 },
    );
  try {
    const grant = await exchange(
      {
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code: url.searchParams.get("code"),
        code_verifier: flow.verifier,
      },
      send,
    );
    if (!grant.scope?.split(" ").includes(driveScope) || !grant.refresh_token)
      throw new DriveError(
        "Driveメタデータの読み取りと継続接続の認可が必要です",
      );
    if(flow.minutesRead && !grant.scope.split(" ").includes(minutesReadScope)) throw new DriveError("議事録の本文読み取りが認可されていません。既存のDrive接続は変更していません","permission");
    if(flow.sheetsRead && !grant.scope.split(" ").includes(sheetsReadScope)) throw new DriveError("スプレッドシートの読み取りが認可されていません。既存の接続は変更していません","permission");
    const fingerprint = await accountFingerprint(grant.access_token, send);
    const previous = await storage.get("drive:credential");
    const cache = await storage.get("drive:cache");
    // 再認可で未確認を消さない。アカウント変更や未照合の既存データは自動で引き継がない。
    if (
      (previous?.accountFingerprint &&
        previous.accountFingerprint !== fingerprint) ||
      (cache && !previous?.accountFingerprint)
    )
      throw new DriveError(
        "接続アカウントが異なるか、既存接続を照合できません。接続と未確認は変更していません。以前と同じアカウントを選択してください",
        "account",
      );
    await storage.transaction(async (tx) => {
      await finishDriveRun(
        tx,
        { files: [], ...cache, errorCode: "reauthorized" },
        Date.now(),
      );
      await tx.put("drive:credential", {
        token: grant.access_token,
        refresh: grant.refresh_token,
        expires: Date.now() + grant.expires_in * 1000,
        connectedAt: Date.now(),
        grantedPublishingStatus: flow.publishingStatus || "testing",
        refreshCount: 0,
        accountFingerprint: fingerprint,
        scopes:grant.scope.split(" "),
      });
      if (cache)
        await tx.put("drive:cache", {
          ...cache,
          error:
            cache.errorCode === "rate"
              ? cache.error
              : "Google接続を再認可しました。保存済みの一覧を表示し、再取得を待っています",
          errorCode: cache.errorCode === "rate" ? "rate" : "reauthorized",
        });
      await tx.delete("drive:job");
      await tx.put("drive:recovery", {
        attempt: 0,
        nextAt: Math.max(Date.now() + 1000, cache?.retryAt || 0),
        errorCode: "reauthorized",
      });
    });
    return new Response(null, { status: 303, headers: { Location: "/" } });
  } catch (error) {
    if (!(error instanceof DriveError)) throw error;
    return new Response(error.message, { status: 503 });
  }
}
export async function driveToken(env, storage, send = fetch) {
  const credential = await storage.get("drive:credential");
  if (!credential || credential.invalid)
    throw new DriveError("Google Driveは未接続です", "authentication");
  if (credential.expires > Date.now() + tokenSafetyMs) return credential.token;
  credential.lastRefreshAttemptAt = new Date().toISOString();
  await storage.put("drive:credential", credential);
  try {
    const grant = await exchange(
      {
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: credential.refresh,
      },
      send,
    );
    credential.token = grant.access_token;
    if(typeof grant.scope==="string")credential.scopes=grant.scope.split(" ");
    credential.refresh = grant.refresh_token || credential.refresh;
    credential.expires = Date.now() + grant.expires_in * 1000;
    credential.lastRefreshedAt = new Date().toISOString();
    credential.refreshCount = (credential.refreshCount || 0) + 1;
    credential.lastRefreshError = null;
    await storage.put("drive:credential", credential);
    return credential.token;
  } catch (error) {
    credential.lastRefreshError =
      error instanceof DriveError
        ? error.message
        : "Googleトークンの自動更新に失敗しました";
    if (error instanceof DriveError && error.code === "authentication") {
      credential.invalid = true;
    }
    await storage.put("drive:credential", credential);
    throw error;
  }
}
