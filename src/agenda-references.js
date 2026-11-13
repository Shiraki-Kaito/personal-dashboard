import { agendaAccounts } from "./agenda-google.js";
import { digest } from "./agenda-rules.js";
import { InputError } from "./sync.js";

const maximumReferenceOperations = 5000;
const referencePlanLifetimeMs = 10 * 60 * 1000;

async function referenceSnapshot(storage, targetId, suppliedEntries) {
  const accounts = await agendaAccounts(storage);
  if (!accounts.some(account => account.id === targetId))
    throw new InputError("保存済みアカウントを選択してください");
  const operations = suppliedEntries || [...await storage.list({
    prefix: "agenda:operation:", limit: maximumReferenceOperations + 1,
  })];
  if (operations.length > maximumReferenceOperations)
    throw new InputError("参照記録の調査上限を超えました。整理せず停止しました");
  const sources = new Map(), references = [];
  for (const [key, operation] of operations) {
    if (key.startsWith("agenda:operation:" + targetId + ":") || operation.targetAccountId !== targetId) continue;
    const source = accounts.find(account => key.startsWith("agenda:operation:" + account.id + ":"));
    if (source && !sources.has(source.id)) sources.set(source.id, {
      account: source,
      label: (await storage.get("agenda:label:" + source.id)) || "",
      pending: (await storage.get("agenda:pending:" + source.id)) || [],
      history: (await storage.get("agenda:manualHistory:" + source.id)) || [],
    });
    const sourceState = source ? sources.get(source.id) : null;
    const messageId = source ? key.slice(("agenda:operation:" + source.id + ":").length) : null;
    references.push({ key, operation, sourceState, messageId });
  }
  return references;
}
async function checksumFor(references, nonce) {
  // 同じ登録元の索引を記録数だけ複製しない。照合量を保存件数に比例させる。
  const sources = new Map();
  for (const reference of references)
    if (reference.sourceState) sources.set(reference.sourceState.account.id, reference.sourceState);
  return digest({
    references: references.map(({ key, operation, messageId }) => ({ key, operation, messageId })),
    sources: [...sources], nonce,
  });
}
const eligible = reference => !!reference.sourceState &&
  reference.operation.phase === "登録確認済み" &&
  !reference.sourceState.pending.includes(reference.messageId);

// 削除を妨げる他接続の記録を、選択に必要な情報だけで提示する。
export async function prepareReferenceCleanup(storage, targetId, entries, now = Date.now()) {
  const references = await referenceSnapshot(storage, targetId, entries);
  const planKey = "agenda:referencePlan:" + targetId;
  let checksum = null;
  if (references.length) {
    const nonce = crypto.randomUUID();
    checksum = await checksumFor(references, nonce);
    await storage.put(planKey, { nonce, checksum, expires: now + referencePlanLifetimeMs });
  } else await storage.delete(planKey);
  return {
    referenceChecksum: checksum,
    references: references.map(reference => ({
      id: reference.key.slice("agenda:operation:".length),
      sourceAccountId: reference.sourceState?.account.id || null,
      sourceEmail: reference.sourceState?.account.email || "登録元不明",
      sourceLabel: reference.sourceState?.label || "",
      messageId: reference.messageId,
      title: reference.operation.draft?.title || "予定名不明",
      start: reference.operation.draft?.start || null,
      end: reference.operation.draft?.end || null,
      phase: reference.operation.phase,
      lastSuccess: reference.operation.lastSuccess || null,
      eligible: eligible(reference),
    })),
  };
}

// 本人が選んだ確認済み記録とその索引だけを、原子的に整理する。
export async function cleanupAccountReferences(storage, input, now = Date.now()) {
  if (input.confirm !== true || !Array.isArray(input.selected) ||
      !input.selected.length || input.selected.length > maximumReferenceOperations ||
      input.selected.some(id => typeof id !== "string") || new Set(input.selected).size !== input.selected.length)
    throw new InputError("整理する確認済み記録を選び、内容を確認してください");
  return storage.transaction(async tx => {
    const references = await referenceSnapshot(tx, input.accountId);
    const planKey = "agenda:referencePlan:" + input.accountId;
    const plan = await tx.get(planKey);
    if (!plan || plan.expires <= now || input.checksum !== plan.checksum ||
        await checksumFor(references, plan.nonce) !== plan.checksum)
      throw new InputError("参照記録が変わったか確認期限切れです。削除内容を再確認してください");
    const byId = new Map(references.map(reference => [reference.key, reference]));
    const selected = input.selected.map(id => byId.get("agenda:operation:" + id));
    if (selected.some(reference => !reference || !eligible(reference)))
      throw new InputError("結果未確認の記録や別の削除対象の記録は整理できません。先に結果を照合してください");
    for (const reference of selected) {
      await tx.delete(reference.key);
      const sourceId = reference.sourceState.account.id;
      await tx.delete("agenda:preview:" + sourceId + ":" + reference.messageId);
      const historyKey = "agenda:manualHistory:" + sourceId;
      const history = (await tx.get(historyKey)) || [];
      if (history.includes(reference.messageId))
        await tx.put(historyKey, history.filter(id => id !== reference.messageId));
    }
    await tx.delete(planKey);
    await tx.delete("agenda:deletePlan:" + input.accountId);
    return { removed: selected.length };
  });
}
