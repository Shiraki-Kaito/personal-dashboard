import { agendaAccounts } from "./agenda-google.js";
import { InputError } from "./sync.js";

const nextMailBatchDelayMs = 15000;

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
    const job = await tx.get("agenda:mailJob");
    if (!job) return;
    const remaining = job.accountIds.slice(job.index).filter((id) => id !== account.id);
    if (!remaining.length) {
      await tx.delete("agenda:mailJob");
      return;
    }
    await tx.put("agenda:mailJob", {
      ...job,
      accountIds: remaining,
      index: 0,
      ...(job.accountIds[job.index] === account.id ? {
        messages: [],
        cursor: null,
        cursors: [],
        pages: 0,
        retries: 0,
        startedAt: new Date(now).toISOString(),
        nextAt: now + nextMailBatchDelayMs,
      } : {}),
    });
  });
}

// 再取得できるキャッシュだけを対象とし、確認・登録・結果不明の記録は保持する。
export async function clearAccountCache(storage, input) {
  if (input.confirm !== true) throw new InputError("キャッシュ整理の確認が必要です");
  await storage.transaction(async (tx) => {
    const account = await accountFor(tx, input);
    if (await tx.get("agenda:mailJob"))
      throw new InputError("メール取得中です。取得完了後に整理してください");
    for (const name of ["cache", "calendar", "history"])
      await tx.delete("agenda:" + name + ":" + account.id);
    const previews = await tx.list({ prefix: "agenda:preview:" + account.id + ":" });
    for (const key of previews.keys()) await tx.delete(key);
  });
}
