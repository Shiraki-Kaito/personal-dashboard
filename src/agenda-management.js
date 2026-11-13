import { agendaAccounts } from "./agenda-google.js";
import { digest } from "./agenda-rules.js";
import { InputError } from "./sync.js";

const nextAccountBatchDelayMs = 15000;

async function accountFor(storage, input) {
  const account = (await agendaAccounts(storage)).find(
    (account) => account.id === input.accountId,
  );
  if (!account) throw new InputError("保存済みアカウントを選択してください");
  return account;
}

// 資格情報だけを破棄し、正本や復旧に必要なアプリの記録には触れない。
export async function disconnectAccount(storage, input, now = Date.now()) {
  if (input.confirm !== true) throw new InputError("接続停止の確認が必要です");
  await storage.transaction(async (tx) => {
    const account = await accountFor(tx, input);
    const accounts = await agendaAccounts(tx);
    await tx.put(
      "agenda:accounts",
      accounts.map((saved) => saved.id === account.id
        ? { ...saved, disconnectedAt: saved.disconnectedAt || new Date(now).toISOString() }
        : saved),
    );
    await tx.delete("agenda:credential:" + account.id);
    // 既に開かれた認可画面の復帰で、停止が意図せず解除されるのを防ぐ。
    await tx.delete("agenda:flow");
    await removeAccountFromJob(tx, account.id, now);
    await removeAccountFromJob(tx, account.id, now, "agenda:calendarJob");
  });
}

// 再取得できるキャッシュだけを対象とし、確認・登録・結果不明の記録は保持する。
export async function clearAccountCache(storage, input) {
  if (input.confirm !== true) throw new InputError("キャッシュ整理の確認が必要です");
  await storage.transaction(async (tx) => {
    const account = await accountFor(tx, input);
    if (await tx.get("agenda:mailJob") || await tx.get("agenda:calendarJob"))
      throw new InputError("メール・予定取得中です。取得完了後に整理してください");
    for (const name of ["cache", "calendar", "history"])
      await tx.delete("agenda:" + name + ":" + account.id);
    const previews = await tx.list({ prefix: "agenda:preview:" + account.id + ":" });
    for (const key of previews.keys()) await tx.delete(key);
  });
}

async function removeAccountFromJob(storage, accountId, now, jobKey = "agenda:mailJob") {
  const job = await storage.get(jobKey);
  if (!job) return;
  const remaining = job.accountIds.slice(job.index).filter((id) => id !== accountId);
  if (!remaining.length) {
    await storage.delete(jobKey);
    return;
  }
  await storage.put(jobKey, {
    ...job,
    accountIds: remaining,
    index: 0,
    ...(job.accountIds[job.index] === accountId ? {
      ...(jobKey === "agenda:mailJob" ? { messages: [], cursor: null, cursors: [], pages: 0 } : {}),
      retries: 0,
      startedAt: new Date(now).toISOString(),
      nextAt: now + nextAccountBatchDelayMs,
    } : {}),
  });
}

const deletionPlanLifetimeMs = 10 * 60 * 1000;
const maximumDeletionOperations = 5000;
const accountValueNamespaces = [
  "credential", "label", "cache", "calendar", "history", "reviews", "pending", "manualHistory",
];

// 削除候補と参照を毎回調べ、確認画面と実行時で同じ内容か照合する。
async function deletionSnapshot(storage, input) {
  const account = await accountFor(storage, input);
  const entries = new Map();
  for (const namespace of accountValueNamespaces) {
    const key = "agenda:" + namespace + ":" + account.id;
    const value = await storage.get(key);
    if (value !== undefined) entries.set(key, value);
  }
  for (const namespace of ["operation", "preview"]) {
    for (const [key, value] of await storage.list({
      prefix: "agenda:" + namespace + ":" + account.id + ":",
      limit: maximumDeletionOperations + 1,
    })) entries.set(key, value);
  }
  const operations = await storage.list({
    prefix: "agenda:operation:", limit: maximumDeletionOperations + 1,
  });
  if (operations.size > maximumDeletionOperations || entries.size > maximumDeletionOperations)
    throw new InputError("削除前の調査上限を超えました。削除せず停止しました");
  const ownPrefix = "agenda:operation:" + account.id + ":";
  const ownOperations = [...operations].filter(([key]) => key.startsWith(ownPrefix));
  const foreignReferences = [...operations].filter(([key, operation]) =>
    !key.startsWith(ownPrefix) && operation.targetAccountId === account.id,
  );
  const unresolved = ownOperations.filter(([, operation]) => operation.phase !== "登録確認済み");
  const pending = entries.get("agenda:pending:" + account.id) || [];
  const blockers = [];
  if (unresolved.length || pending.length)
    blockers.push("結果未確認・再照合待ちの予定登録があります。先に登録結果を照合してください。");
  if (foreignReferences.length)
    blockers.push("他アカウントの予定登録記録が、このアカウントを登録先として参照しています。関連記録を保護するため削除できません。");
  return {
    account, entries, blockers,
    counts: {
      messages: entries.get("agenda:cache:" + account.id)?.messages?.length || 0,
      calendarEvents: entries.get("agenda:calendar:" + account.id)?.events?.length || 0,
      reviews: Object.keys(entries.get("agenda:reviews:" + account.id) || {}).length,
      operations: ownOperations.length,
      mailHistory: entries.get("agenda:history:" + account.id)?.length || 0,
      foreignReferences: foreignReferences.length,
      unresolved: unresolved.length,
    },
  };
}
async function deletionChecksum(snapshot, nonce) {
  // ハッシュ化はサーバー内だけで行い、資格情報や保存本文は確認APIへ返さない。
  return digest({ account: snapshot.account, entries: [...snapshot.entries], nonce });
}
export async function previewAccountDeletion(storage, input, now = Date.now()) {
  return storage.transaction(async (tx) => {
    const snapshot = await deletionSnapshot(tx, input);
    const key = "agenda:deletePlan:" + snapshot.account.id;
    const expires = now + deletionPlanLifetimeMs;
    let checksum = null;
    if (snapshot.blockers.length) await tx.delete(key);
    else {
      const nonce = crypto.randomUUID();
      checksum = await deletionChecksum(snapshot, nonce);
      await tx.put(key, { nonce, checksum, expires });
    }
    return {
      account: { id: snapshot.account.id, email: snapshot.account.email, label: snapshot.entries.get("agenda:label:" + snapshot.account.id) || "" },
      counts: snapshot.counts, blockers: snapshot.blockers, checksum, expires,
    };
  });
}
export async function deleteAccount(storage, input, now = Date.now()) {
  if (input.confirm !== true) throw new InputError("完全削除の確認が必要です");
  await storage.transaction(async (tx) => {
    const snapshot = await deletionSnapshot(tx, input);
    if (snapshot.blockers.length) throw new InputError(snapshot.blockers.join(" "));
    const account = snapshot.account;
    const planKey = "agenda:deletePlan:" + account.id;
    const plan = await tx.get(planKey);
    if (input.email !== account.email || !plan || plan.expires <= now ||
        input.checksum !== plan.checksum || await deletionChecksum(snapshot, plan.nonce) !== plan.checksum)
      throw new InputError("削除対象・確認内容が変わったか期限切れです。削除内容をもう一度確認してください");
    // 確認と削除を同じトランザクションで確定し、一部削除を残さない。
    for (const key of snapshot.entries.keys()) await tx.delete(key);
    await tx.put("agenda:accounts", (await agendaAccounts(tx)).filter(saved => saved.id !== account.id));
    await tx.delete(planKey);
    await tx.delete("agenda:flow");
    await removeAccountFromJob(tx, account.id, now);
    await removeAccountFromJob(tx, account.id, now, "agenda:calendarJob");
  });
}
