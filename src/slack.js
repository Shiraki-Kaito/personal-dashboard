import {
  slackWorkspaceStore,
  slackWorkspaces,
  maximumSlackWorkspaces,
} from "./slack-store.js";
import { slackToken, slackConfigured } from "./slack-auth.js";
import { slackRequest, SlackError } from "./slack-http.js";
import { InputError } from "./sync.js";
import { digest } from "./agenda-rules.js";

const maximumChannels = 5,
  pageSize = 15,
  maximumPages = 10;
const historyWindowMs = 7 * 86400000,
  batchDelayMs = 61000;
const retryDelaysMs = [60000, 300000];
const maximumCacheBytes = 1024 * 1024;
const validChannel = (value) =>
  typeof value === "string" && /^[CG][A-Z0-9]{8,}$/.test(value);
async function channels(storage) {
  return (await storage.get("slack:channels")) || [];
}
export async function slackView(env, storage) {
  const connection = await storage.get("slack:connection"),
    credential = await storage.get("slack:credential");
  return {
    configured: await slackConfigured(env, storage),
    connection: connection
      ? { ...connection, connected: !!credential && !credential.invalid }
      : null,
    scopes: credential?.scopes || [],
    maximumChannels,
    pageSize,
    maximumMessages: pageSize * maximumPages,
    historyDays: 7,
    job: (await storage.get("slack:job"))
      ? { active: true, nextAt: (await storage.get("slack:job")).nextAt }
      : { active: false },
    scheduler: (await storage.get("slack:scheduler")) || null,
    channels: await Promise.all(
      (await channels(storage)).map(async (channel) => ({
        ...channel,
        ...((await storage.get("slack:cache:" + channel.id)) || {
          messages: [],
          lastSuccess: null,
        }),
        reviews: (await storage.get("slack:reviews:" + channel.id)) || {},
      })),
    ),
  };
}
export async function addSlackChannel(env, storage, input, send = fetch) {
  if (!validChannel(input.channelId))
    throw new InputError("SlackのチャンネルIDを指定してください");
  const existing = await channels(storage);
  if (
    !existing.some((channel) => channel.id === input.channelId) &&
    existing.length >= maximumChannels
  )
    throw new InputError("初期版は5チャンネルまでです");
  if (await storage.get("slack:job"))
    throw new InputError(
      "Slack取得中です。完了後にチャンネルを追加してください",
    );
  const token = await slackToken(env, storage, send);
  const result = await slackRequest(
    "conversations.info",
    { channel: input.channelId },
    token,
    send,
  );
  const channel = result.channel;
  if (
    !channel ||
    channel.id !== input.channelId ||
    channel.is_im ||
    channel.is_mpim ||
    !channel.is_member
  )
    throw new SlackError(
      "指定チャンネルに専用Botを参加させてください。DMは初期対象外です",
      "permission",
    );
  const credential = await storage.get("slack:credential");
  if (channel.is_private && !credential.scopes.includes("groups:history"))
    throw new SlackError(
      "非公開チャンネルの読み取り権限を追加認可してください",
      "permission",
    );
  await storage.put("slack:channels", [
    ...existing.filter((c) => c.id !== channel.id),
    {
      id: channel.id,
      name: String(channel.name || channel.id).slice(0, 100),
      private: !!channel.is_private,
    },
  ]);
  return slackMessagesView(env, storage);
}
export async function queueSlackSync(
  storage,
  now = Date.now(),
  source = "cron",
) {
  if (source === "cron")
    await storage.put("slack:scheduler", {
      lastTriggeredAt: new Date(now).toISOString(),
    });
  const credential = await storage.get("slack:credential");
  if ((await storage.get("slack:job")) || !credential || credential.invalid)
    return;
  const selected = await channels(storage);
  if (!selected.length) return;
  await storage.put("slack:job", {
    channelIds: selected.map((c) => c.id),
    index: 0,
    source,
    oldest: String((now - historyWindowMs) / 1000),
    latest: String(now / 1000),
    nextAt: now + batchDelayMs,
    messages: [],
    cursor: null,
    cursors: [],
    pages: 0,
    retries: 0,
    limited: false,
  });
}
async function advance(storage, job, now) {
  if (job.index + 1 >= job.channelIds.length) {
    await storage.delete("slack:job");
    return;
  }
  await storage.put("slack:job", {
    ...job,
    index: job.index + 1,
    messages: [],
    cursor: null,
    cursors: [],
    pages: 0,
    retries: 0,
    limited: false,
    nextAt: now + batchDelayMs,
  });
}
function normalizeMessage(message, teamId, channelId) {
  if (
    !message ||
    !/^\d{10,}\.\d{6}$/.test(message.ts) ||
    message.type !== "message"
  )
    throw new SlackError("Slackのメッセージ形式が不正です", "incomplete");
  if (message.subtype === "message_deleted") return null;
  const raw = typeof message.text === "string" ? message.text : "";
  return {
    ts: message.ts,
    text: raw.slice(0, 6000),
    truncated: raw.length > 6000,
    user: typeof message.user === "string" ? message.user : null,
    bot: !!message.bot_id,
    replyCount: Number.isInteger(message.reply_count) ? message.reply_count : 0,
    threadTs: message.thread_ts || null,
    attachmentCount:
      (message.files?.length || 0) + (message.attachments?.length || 0),
    url:
      "https://app.slack.com/client/" +
      teamId +
      "/" +
      channelId +
      "/thread/" +
      channelId +
      "-" +
      message.ts,
  };
}
export async function runSlackBatch(
  env,
  storage,
  send = fetch,
  now = Date.now(),
) {
  const job = await storage.get("slack:job");
  if (!job || job.nextAt > now) return;
  const channel = (await channels(storage)).find(
    (c) => c.id === job.channelIds[job.index],
  );
  if (!channel || !(await storage.get("slack:credential")))
    return advance(storage, job, now);
  const key = "slack:cache:" + channel.id,
    cache = (await storage.get(key)) || { messages: [], lastSuccess: null };
  const attempt = { ...cache, lastAttempt: new Date(now).toISOString() };
  await storage.put(key, attempt);
  try {
    const token = await slackToken(env, storage, send),
      connection = await storage.get("slack:connection");
    const result = await slackRequest(
      "conversations.history",
      {
        channel: channel.id,
        limit: String(pageSize),
        oldest: job.oldest,
        latest: job.latest,
        ...(job.cursor ? { cursor: job.cursor } : {}),
      },
      token,
      send,
    );
    if (!Array.isArray(result.messages) || result.messages.length > pageSize)
      throw new SlackError("Slackの一覧応答が不正です", "incomplete");
    const cursor = result.response_metadata?.next_cursor?.trim() || null;
    if (
      (result.has_more && !cursor) ||
      (cursor && job.cursors.includes(cursor))
    )
      throw new SlackError(
        "Slackの続きが取得できないかページが循環しています",
        "incomplete",
      );
    const messages = [
      ...job.messages,
      ...result.messages
        .map((m) => normalizeMessage(m, connection.teamId, channel.id))
        .filter(Boolean),
    ];
    if (new Set(messages.map((m) => m.ts)).size !== messages.length)
      throw new SlackError(
        "取得中にSlack一覧が変化しました。先頭から再取得してください",
        "incomplete",
      );
    if (new TextEncoder().encode(JSON.stringify(messages)).length > maximumCacheBytes)
      throw new SlackError("Slack取得途中の保存上限1MiBを超えました。前回の一覧を保持します", "limit");
    const pages = job.pages + 1,
      limited = job.limited || !!result.is_limited;
    if (cursor && pages < maximumPages) {
      await storage.put("slack:job", {
        ...job,
        messages,
        pages,
        cursor,
        cursors: [...job.cursors, cursor],
        limited,
        retries: 0,
        nextAt: now + batchDelayMs,
      });
      return;
    }
    const completed = {
      messages,
      pages,
      source: job.source,
      oldest: job.oldest,
      latest: job.latest,
      limited: limited || !!cursor,
      hasMore: !!cursor,
      lastAttempt: attempt.lastAttempt,
      lastSuccess: new Date(Math.max(now, Date.now())).toISOString(),
      error: null,
      errorCode: null,
    };
    if (
      new TextEncoder().encode(JSON.stringify(completed)).length >
      maximumCacheBytes
    )
      throw new SlackError(
        "Slack保存上限1MiBを超えました。前回の一覧を保持します",
        "limit",
      );
    await storage.transaction(async (tx) => {
      await tx.put(key, completed);
      await advance(tx, job, now);
    });
  } catch (error) {
    const safe =
      error instanceof SlackError
        ? error
        : new SlackError(
            "Slackの取得に失敗しました。保存済み一覧を保持します",
            "incomplete",
          );
    const nextAt = Math.max(
      safe.retryAt || 0,
      now + (retryDelaysMs[job.retries] || batchDelayMs),
    );
    await storage.transaction(async (tx) => {
      await tx.put(key, {
        ...attempt,
        error: safe.message,
        errorCode: safe.code,
        retryAt: nextAt,
      });
      if (safe.code === "authentication") {
        const credential = await tx.get("slack:credential");
        if (credential)
          await tx.put("slack:credential", { ...credential, invalid: true });
      }
      if (
        ["network", "rate", "remote"].includes(safe.code) &&
        job.retries < retryDelaysMs.length
      )
        await tx.put("slack:job", { ...job, retries: job.retries + 1, nextAt });
      else await advance(tx, job, now);
    });
  }
}
export async function reviewSlackMessage(env, storage, input) {
  const cache = await storage.get("slack:cache:" + input.channelId),
    message = cache?.messages.find((m) => m.ts === input.ts);
  if (
    !message ||
    typeof input.reviewed !== "boolean" ||
    input.revision !== (await digest(message))
  )
    throw new InputError(
      "表示内容が変わったため、Slackの投稿を確認し直してください",
    );
  const key = "slack:reviews:" + input.channelId,
    reviews = (await storage.get(key)) || {};
  if (input.reviewed)
    reviews[message.ts] = {
      revision: input.revision,
      reviewedAt: new Date().toISOString(),
    };
  else delete reviews[message.ts];
  // 古い確認記録だけを整理し、取得の失敗では未確認投稿を消さない。
  for (const [ts, value] of Object.entries(reviews))
    if (Date.parse(value.reviewedAt) < Date.now() - 30 * 86400000)
      delete reviews[ts];
  if (Object.keys(reviews).length > 5000)
    throw new InputError("Slack確認記録の上限です。古い記録の期限後に再試行してください");
  await storage.put(key, reviews);
  return slackMessagesView(env, storage);
}
export async function stopSlack(env, storage, input) {
  if (input.confirm !== true)
    throw new InputError("Slack接続停止の確認が必要です");
  await storage.transaction(async (tx) => {
    await tx.delete("slack:credential");
    await tx.delete("slack:flow");
    await tx.delete("slack:job");
  });
  return slackMessagesView(env, storage);
}
export async function slackMessagesView(env, storage) {
  const view = await slackView(env, storage);
  for (const channel of view.channels)
    channel.messages = await Promise.all(
      channel.messages.map(async (message) => ({
        ...message,
        revision: await digest(message),
      })),
    );
  return view;
}

export async function dashboardSlackView(env, storage, teamId) {
  const workspaces = await slackWorkspaces(storage);
  const selected = workspaces.find(
    (workspace) => workspace.teamId === (teamId || workspaces[0]?.teamId),
  );
  if (teamId && !selected)
    throw new InputError("Slackワークスペースが不正です");
  const view = selected
    ? await slackMessagesView(
        env,
        slackWorkspaceStore(storage, selected.teamId),
      )
    : {
        configured: await slackConfigured(env, storage),
        connection: null,
        scopes: [],
        channels: [],
        maximumChannels,
        pageSize,
        maximumMessages: pageSize * maximumPages,
        historyDays: 7,
        job: { active: false },
        scheduler: null,
      };
  return {
    ...view,
    teamId: selected?.teamId || null,
    maximumWorkspaces: maximumSlackWorkspaces,
    workspaces: await Promise.all(
      workspaces.map(async (workspace) => {
        const credential = await slackWorkspaceStore(
          storage,
          workspace.teamId,
        ).get("slack:credential");
        return { ...workspace, connected: !!credential && !credential.invalid };
      }),
    ),
  };
}
export async function queueAllSlackSync(storage, now = Date.now()) {
  for (const workspace of await slackWorkspaces(storage))
    await queueSlackSync(
      slackWorkspaceStore(storage, workspace.teamId),
      now,
      "cron",
    );
}
export async function runNextSlackBatch(
  env,
  storage,
  send = fetch,
  now = Date.now(),
) {
  for (const workspace of await slackWorkspaces(storage)) {
    const scoped = slackWorkspaceStore(storage, workspace.teamId),
      job = await scoped.get("slack:job");
    if (job && job.nextAt <= now) {
      await runSlackBatch(env, scoped, send, now);
      return;
    }
  }
}
export async function nextSlackAlarmAt(storage) {
  const times = [];
  for (const workspace of await slackWorkspaces(storage)) {
    const job = await slackWorkspaceStore(storage, workspace.teamId).get(
      "slack:job",
    );
    if (job) times.push(job.nextAt);
  }
  return times.filter(Number.isFinite).sort((a, b) => a - b)[0];
}
