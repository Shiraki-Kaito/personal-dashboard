import {
  slackWorkspaceStore,
  slackWorkspaces,
  maximumSlackWorkspaces,
} from "./slack-store.js";
import { random } from "./drive-auth.js";
import { slackRequest, SlackError } from "./slack-http.js";
import { InputError } from "./sync.js";
export const publicSlackScopes = ["channels:read", "channels:history"];
export const privateSlackScopes = ["groups:read", "groups:history"];
export const validSlackTeam = (value) =>
  typeof value === "string" && /^T[A-Z0-9]{8,}$/.test(value);
export async function slackApplication(env, storage) {
  if (env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET)
    return {
      clientId: env.SLACK_CLIENT_ID,
      clientSecret: env.SLACK_CLIENT_SECRET,
    };
  return (await storage.get("slack:appCredential")) || null;
}
export const slackConfigured = async (env, storage) =>
  !!(await slackApplication(env, storage));
export async function configureSlackApplication(env, storage, input) {
  if (
    input.confirm !== true ||
    typeof input.clientId !== "string" ||
    !/^\d+\.\d+$/.test(input.clientId) ||
    typeof input.clientSecret !== "string" ||
    !/^[a-fA-F0-9]{32}$/.test(input.clientSecret)
  )
    throw new InputError(
      "専用アプリのClient IDとClient Secretを確認してください。秘密値は画面へ再表示しません",
    );
  if (env.SLACK_CLIENT_ID || env.SLACK_CLIENT_SECRET)
    throw new InputError(
      "環境のSecrets設定を使用しています。そちらから更新してください",
    );
  const current = await storage.get("slack:appCredential");
  if (
    (await slackWorkspaces(storage)).length &&
    current?.clientId !== input.clientId
  )
    throw new InputError(
      "接続済みワークスペースがあるため別のSlackアプリへ変更できません",
    );
  await storage.put("slack:appCredential", {
    clientId: input.clientId,
    clientSecret: input.clientSecret,
  });
  await storage.delete("slack:flow");
}
const flowLifetimeMs = 600000;
const approvedScopes = [...publicSlackScopes, ...privateSlackScopes];
function grantCredential(grant, previous = null) {
  if (
    typeof grant.access_token !== "string" ||
    !grant.access_token ||
    grant.token_type !== "bot"
  )
    throw new SlackError("専用Botの認可を確認できません", "authentication");
  if (
    grant.expires_in !== undefined &&
    (!Number.isFinite(grant.expires_in) ||
      grant.expires_in <= 0 ||
      typeof grant.refresh_token !== "string" ||
      !grant.refresh_token)
  )
    throw new SlackError("Slackの継続接続情報が不正です", "authentication");
  return {
    token: grant.access_token,
    refresh: grant.refresh_token || null,
    expires: grant.expires_in ? Date.now() + grant.expires_in * 1000 : null,
    scopes:
      typeof grant.scope === "string"
        ? grant.scope.split(",")
        : previous?.scopes || [],
    refreshCount: previous?.refreshCount || 0,
  };
}
export async function slackConnect(
  request,
  env,
  storage,
  session,
  send = fetch,
) {
  const application = await slackApplication(env, storage);
  if (!application)
    return Response.json(
      { error: "Slack専用アプリのClient ID・Secretを設定してください" },
      { status: 503 },
    );
  const url = new URL(request.url),
    redirectUri = url.origin + "/auth/slack/callback";
  if (url.pathname === "/auth/slack/start") {
    const input = await request.json().catch(() => null);
    if (
      !input ||
      (input.teamId !== undefined &&
        input.teamId !== "" &&
        !validSlackTeam(input.teamId)) ||
      typeof input.includePrivate !== "boolean"
    )
      throw new InputError(
        "対象のSlackワークスペースIDと非公開チャンネルの要否を指定してください",
      );
    const existing = await slackWorkspaces(storage);
    if (
      !existing.some((workspace) => workspace.teamId === input.teamId) &&
      existing.length >= maximumSlackWorkspaces
    )
      throw new InputError(
        "Slackは5ワークスペースまでです。再接続する場合は保存済みワークスペースIDを指定してください",
      );
    const scopes = [
      ...publicSlackScopes,
      ...(input.includePrivate ? privateSlackScopes : []),
    ];
    const state = random();
    await storage.put("slack:flow", {
      state,
      teamId: input.teamId || null,
      scopes,
      sessionKey: session.key,
      expires: Date.now() + flowLifetimeMs,
    });
    const auth = new URL("https://slack.com/oauth/v2/authorize");
    auth.search = new URLSearchParams({
      client_id: application.clientId,
      scope: scopes.join(","),
      ...(input.teamId ? { team: input.teamId } : {}),
      state,
      redirect_uri: redirectUri,
    });
    return Response.json({ authorizationUrl: auth.href });
  }
  const flow = await storage.get("slack:flow");
  if (
    !flow ||
    flow.expires <= Date.now() ||
    flow.sessionKey !== session.key ||
    flow.state !== url.searchParams.get("state")
  )
    throw new InputError(
      "Slack認可の有効期限・本人セッションを確認し、最初からやり直してください",
    );
  await storage.delete("slack:flow");
  try {
    if (url.searchParams.has("error") || !url.searchParams.get("code"))
      throw new SlackError(
        "Slackの認可は完了していません。既存接続を保持しました",
        "authentication",
      );
    const grant = await slackRequest(
      "oauth.v2.access",
      {
        client_id: application.clientId,
        client_secret: application.clientSecret,
        code: url.searchParams.get("code"),
        redirect_uri: redirectUri,
      },
      null,
      send,
    );
    if (
      !validSlackTeam(grant.team?.id) ||
      (flow.teamId && grant.team.id !== flow.teamId) ||
      grant.is_enterprise_install
    )
      throw new SlackError(
        "指定したワークスペースの認可と一致しません",
        "permission",
      );
    const credential = grantCredential(grant);
    if (
      !flow.scopes.every((scope) => credential.scopes.includes(scope)) ||
      credential.scopes.some((scope) => !approvedScopes.includes(scope))
    )
      throw new SlackError(
        "専用Botの読み取り権限が過不足になっています。Slackアプリ設定を確認してください",
        "permission",
      );
    const identity = await slackRequest(
      "auth.test",
      {},
      credential.token,
      send,
    );
    if (identity.team_id !== grant.team.id || !identity.bot_id)
      throw new SlackError(
        "接続先ワークスペースとBotを照合できません",
        "authentication",
      );
    await storage.transaction(async (tx) => {
      const existing = await slackWorkspaces(tx);
      if (
        !existing.some((workspace) => workspace.teamId === grant.team.id) &&
        existing.length >= maximumSlackWorkspaces
      )
        throw new SlackError("Slackの保存上限に達しました", "limit");
      const connection = {
        teamId: grant.team.id,
        teamName: String(grant.team.name || grant.team.id).slice(0, 100),
        botId: identity.bot_id,
        connectedAt: new Date().toISOString(),
      };
      const scoped = slackWorkspaceStore(tx, grant.team.id);
      await scoped.put("slack:credential", credential);
      await scoped.put("slack:connection", connection);
      await tx.put("slack:workspaces", [
        ...existing.filter((workspace) => workspace.teamId !== grant.team.id),
        connection,
      ]);
    });
    return Response.redirect(
      url.origin + "/?view=slack&teamId=" + encodeURIComponent(grant.team.id),
      303,
    );
  } catch (error) {
    if (!(error instanceof SlackError)) throw error;
    return new Response(
      '<!doctype html><html lang="ja"><meta charset="utf-8"><p>' +
        error.message +
        '</p><a href="/?view=slack">Slack設定へ戻る</a></html>',
      { status: 409, headers: { "Content-Type": "text/html;charset=utf-8" } },
    );
  }
}
export async function slackToken(env, storage, send = fetch) {
  const application = await slackApplication(env, storage);
  const credential = await storage.get("slack:credential");
  if (!credential || credential.invalid)
    throw new SlackError("Slackの接続・再認可が必要です", "authentication");
  if (!credential.expires || credential.expires > Date.now() + 60000)
    return credential.token;
  try {
    if (!application)
      throw new SlackError("Slack専用アプリの設定が必要です", "authentication");
    const grant = await slackRequest(
      "oauth.v2.access",
      {
        client_id: application.clientId,
        client_secret: application.clientSecret,
        grant_type: "refresh_token",
        refresh_token: credential.refresh,
      },
      null,
      send,
    );
    const updated = grantCredential(grant, credential);
    if (updated.scopes.some((scope) => !approvedScopes.includes(scope)))
      throw new SlackError("Slack権限を再確認してください", "permission");
    await storage.put("slack:credential", {
      ...updated,
      refreshCount: credential.refreshCount + 1,
      lastRefreshedAt: new Date().toISOString(),
    });
    return updated.token;
  } catch (error) {
    // 回転トークンの更新結果が不明な場合、同じ更新要求を無条件に再送しない。
    await storage.put("slack:credential", { ...credential, invalid: true });
    throw new SlackError(
      "Slackトークンの更新結果を確認できません。再接続してください",
      "authentication",
    );
  }
}
