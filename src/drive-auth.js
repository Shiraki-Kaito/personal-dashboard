import { DriveError, googleRequest } from "./drive-http.js";

export const driveScope =
  "https://www.googleapis.com/auth/drive.metadata.readonly";
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
  };
}
export function googleConfigured(env) {
  return (
    /^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(
      env.GOOGLE_CLIENT_ID || "",
    ) && !!env.GOOGLE_CLIENT_SECRET
  );
}
const flowLifetimeMs = 10 * 60 * 1000;
const tokenSafetyMs = 60 * 1000;
function random() {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
async function challenge(verifier) {
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
async function exchange(parameters, send) {
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
  if (url.pathname === "/auth/google/start") {
    const state = random(),
      verifier = random();
    await storage.put("drive:flow", {
      state,
      verifier,
      sessionKey: session.key,
      publishingStatus: googleAuthorizationStatus(env, null).publishingStatus,
      expires: Date.now() + flowLifetimeMs,
    });
    const authorization = new URL(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    authorization.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: driveScope,
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
    // 接続し直すたびに新しいアカウントの一覧を基準から作り直す。
    await storage.transaction(async (tx) => {
      await tx.put("drive:credential", {
        token: grant.access_token,
        refresh: grant.refresh_token,
        expires: Date.now() + grant.expires_in * 1000,
        connectedAt: Date.now(),
        grantedPublishingStatus: flow.publishingStatus || "testing",
      });
      await tx.delete("drive:cache");
      await tx.delete("drive:job");
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
    credential.refresh = grant.refresh_token || credential.refresh;
    credential.expires = Date.now() + grant.expires_in * 1000;
    await storage.put("drive:credential", credential);
    return credential.token;
  } catch (error) {
    if (error instanceof DriveError && error.code === "authentication") {
      credential.invalid = true;
      await storage.put("drive:credential", credential);
    }
    throw error;
  }
}
