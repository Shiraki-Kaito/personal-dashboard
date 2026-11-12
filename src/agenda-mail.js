import { agendaClient, AgendaError } from "./agenda-google.js";
import { extractAppointment, messageText } from "./agenda-rules.js";
import { mailPriority } from "./agenda-priority.js";
export async function readMailPage(
  env,
  storage,
  account,
  cursor,
  send = fetch,
) {
  const read = await agendaClient(env, storage, account, send);
  const page = await read("gmail", "messages", {
    q: "newer_than:14d -in:trash -in:spam",
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
    const header = (name) =>
      mail.payload.headers?.find((h) => h.name.toLowerCase() === name)?.value ||
      "";
    const subject = header("subject").slice(0, 300),
      text = messageText(mail.payload);
    messages.push({
      id: mail.id,
      subject,
      from: header("from").slice(0, 300),
      receivedAt: new Date(Number(mail.internalDate)).toISOString(),
      excerpt: text.slice(0, 1600),
      candidate: extractAppointment(subject, text),
      priority: mailPriority({ subject, from: header("from") }, text),
      url:
        "https://mail.google.com/mail/u/" +
        encodeURIComponent(account.email) +
        "/#all/" +
        mail.id,
    });
  }
  return {
    messages,
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
