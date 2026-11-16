import { standardMailQuery } from "./mail-retrieval.js";
import { agendaClient, AgendaError } from "./agenda-google.js";
import { extractAppointment, decodeMessageContent } from "./agenda-rules.js";
import { mailPriority } from "./agenda-priority.js";
import { maximumTimingTextCharacters, maximumPageTimingBytes, limitTimingText } from "./mail-body-coverage.js";
export async function readMailPage(
  env,
  storage,
  account,
  cursor,
  send = fetch,
  query = standardMailQuery,
) {
  const read = await agendaClient(env, storage, account, send);
  const page = await read("gmail", "messages", {
    q: query,
    maxResults: "20",
    ...(cursor ? { pageToken: cursor } : {}),
  });
  if (
    page.messages !== undefined &&
    (!Array.isArray(page.messages) || page.messages.length > 20)
  )
    throw new AgendaError("メール一覧の応答が不正です", "incomplete");
  const messages = [];
  for (const entry of page.messages || []) {
    if (!/^[a-f0-9]{1,64}$/.test(entry.id))
      throw new AgendaError("メールIDが不正です", "incomplete");
    const mail = await read("gmail", "messages/" + entry.id, {
      format: "full",
      fields:
        "id,threadId,internalDate,snippet,payload(mimeType,filename,headers,body,parts)",
    });
    if (mail.id !== entry.id || !mail.payload)
      throw new AgendaError("メール本文の取得が未完了です", "incomplete");
    let content;
    try {
      content = decodeMessageContent(mail.payload);
    } catch {
      throw new AgendaError(
        "メール本文の形式を解釈できません。保存済み一覧を保持しました",
        "incomplete",
      );
    }
    if (
      !/^\d+$/.test(String(mail.internalDate)) ||
      !Number.isFinite(+new Date(Number(mail.internalDate)))
    )
      throw new AgendaError(
        "メールの受信日時が不正です。保存済み一覧を保持しました",
        "incomplete",
      );
    if (
      mail.payload.headers !== undefined &&
      (!Array.isArray(mail.payload.headers) ||
        mail.payload.headers.some(
          (header) =>
            typeof header?.name !== "string" ||
            typeof header?.value !== "string",
        ))
    )
      throw new AgendaError(
        "メールの見出し形式が不正です。保存済み一覧を保持しました",
        "incomplete",
      );
    const header = (name) =>
      mail.payload.headers?.find((h) => h.name.toLowerCase() === name)?.value ||
      "";
    const subject = header("subject").slice(0, 300),
      text =
        content.text || (typeof mail.snippet === "string" ? mail.snippet : "");
    const bodyCoverage = !content.text ? "unavailable"
      : content.limited || text.length > maximumTimingTextCharacters ? "partial" : "complete";
    const contentLimited = bodyCoverage !== "complete" || text.length > 1600;
    const candidate = extractAppointment(subject, text);
    if (contentLimited && candidate.isCandidate) {
      candidate.reasons.push(
        "本文の一部だけを解析しています。Gmailの原文で日時を確認してください",
      );
      candidate.status = "確認待ち";
    }
    messages.push({
      id: mail.id,
      subject,
      from: header("from").slice(0, 300),
      receivedAt: new Date(Number(mail.internalDate)).toISOString(),
      excerpt: text.slice(0, 1600),
      candidate,
      contentLimited,
      bodyCoverage,
      ...(content.text && text.length > 1600
        ? { timingText: text.slice(0, maximumTimingTextCharacters) } : {}),
      priority: mailPriority({ subject, from: header("from") }, text),
      url:
        "https://mail.google.com/mail/u/" +
        encodeURIComponent(account.email) +
        "/#all/" +
        mail.id,
    });
  }
  return {
    messages: limitTimingText(messages, maximumPageTimingBytes),
    nextPageToken: page.nextPageToken || null,
    estimate: Number.isFinite(page.resultSizeEstimate)
      ? page.resultSizeEstimate
      : null,
  };
}
export async function recordMailRun(storage, accountId, record) {
  const key = "agenda:history:" + accountId;
  await storage.put(
    key,
    [record, ...((await storage.get(key)) || [])].slice(0, 72),
  );
}
