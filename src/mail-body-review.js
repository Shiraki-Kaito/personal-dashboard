import { digest } from "./agenda-rules.js";
import { agendaAccounts, agendaClient, AgendaError } from "./agenda-google.js";
import { readMailMessage } from "./agenda-mail.js";
import { retainImportantMailBodies } from "./mail-body-retention.js";
import { maximumCachedTimingBytes } from "./mail-body-coverage.js";
import { InputError } from "./sync.js";

const individualRefreshIntervalMs = 60000;
export function mailBodyRevision(message) {
  return digest({id:message.id,subject:message.subject,from:message.from,receivedAt:message.receivedAt,
    excerpt:message.excerpt,timingText:message.timingText || null,bodyCoverage:message.bodyCoverage || null,
    keepBody:message.keepBody === true,bodyRetrievedAt:message.bodyRetrievedAt || null});
}

// 一覧内の1通だけを読み直し、成功した本文と本人指定を同時に保存する。
export async function reviewMailBody(env, storage, input, send = fetch, now = Date.now()) {
  if (input.confirm !== true || typeof input.keepBody !== "boolean" || !/^[a-f0-9]{1,64}$/.test(input.messageId || ""))
    throw new InputError("対象メールと本文保存の指定を確認してください");
  const account = (await agendaAccounts(storage)).find(account => account.id === input.accountId && !account.disconnectedAt);
  if (!account) throw new InputError("接続中のアカウントを選択してください");
  if (await storage.get("agenda:mailJob")) throw new InputError("メールの自動取得中です。完了後にやり直してください");
  const key = "agenda:cache:" + account.id;
  const cache = await storage.get(key);
  const previous = cache?.messages?.find(message => message.id === input.messageId);
  if (!previous || input.revision !== await mailBodyRevision(previous))
    throw new InputError("対象メールが変更されています。一覧を再読込してください");
  if (input.keepBody && now - Date.parse(previous.bodyRetrievedAt) < individualRefreshIntervalMs)
    throw new InputError("このメールは直前に再取得しています。60秒後にやり直してください");
  const cacheRevision = await digest(cache);
  let replacement;
  if (input.keepBody) {
    const read = await agendaClient(env, storage, account, send);
    const fetched = await readMailMessage(read, account, previous.id);
    if (fetched.bodyCoverage === "unavailable")
      throw new AgendaError("本文を取得できませんでした。以前の保存内容と指定を保持しました。Gmailで原文を確認してください", "incomplete");
    replacement = {...fetched,keepBody:true,bodyRetention:"protected",bodyRetrievedAt:new Date(now).toISOString()};
  } else {
    [replacement] = await retainImportantMailBodies(storage, account.id, [{...previous,keepBody:false}]);
  }
  const messages = cache.messages.map(message => message.id === previous.id ? replacement : message);
  const bytes = messages.reduce((total,message) => total + new TextEncoder().encode(message.timingText || "").length, 0);
  if (bytes > maximumCachedTimingBytes)
    throw new InputError("追加本文の保存枠が不足しています。他の本文は削除していません。不要な本人指定を自動判定に戻すか、Gmailで確認してください");
  await storage.transaction(async tx => {
    if (await tx.get("agenda:mailJob") || await digest(await tx.get(key)) !== cacheRevision)
      throw new InputError("取得中に一覧が変わりました。再読込してやり直してください");
    // 1通の取得成功を、アカウント全体の最終成功時刻へ流用しない。
    await tx.put(key, {...cache,messages});
  });
}
