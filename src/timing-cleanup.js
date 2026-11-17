import { digest } from "./agenda-rules.js";
import { normalizeTimingRecords, maximumTimingRecords } from "./timing-confirmations.js";
import { timingOperationId } from "./timing-calendar.js";
import { InputError } from "./sync.js";

const maximumRelatedRecords = 5000;
const planLifetimeMs = 10 * 60 * 1000;
const recordsKey = id => "agenda:timingConfirmations:" + id;
const planKey = id => "agenda:timingCleanupPlan:" + id;

async function snapshot(storage, accountId) {
  const accounts = (await storage.get("agenda:accounts")) || [];
  const account = accounts.find(account => account.id === accountId);
  if (!account) throw new InputError("保存済みアカウントを選択してください");
  const records = normalizeTimingRecords((await storage.get(recordsKey(accountId))) || {});
  const operations = [...await storage.list({prefix:"agenda:operation:",limit:maximumRelatedRecords+1})];
  const previews = [...await storage.list({prefix:"agenda:preview:",limit:maximumRelatedRecords+1})];
  if (operations.length > maximumRelatedRecords || previews.length > maximumRelatedRecords)
    throw new InputError("関連記録の調査上限を超えています。一部だけの調査では整理しません");
  const messages = (await storage.get("agenda:cache:" + accountId))?.messages || [];
  const pending = (await storage.get("agenda:pending:" + accountId)) || [];
  const history = (await storage.get("agenda:manualHistory:" + accountId)) || [];
  const job = await storage.get("agenda:mailJob");
  const collectionRevision = (await storage.get("agenda:timingCollection:" + accountId)) || null;
  return { accountId, records, operations, previews, messageIds:messages.map(message=>message.id).sort(), pending, history, job:job || null, collectionRevision };
}

async function rowsFor(state) {
  const listed = new Set(state.messageIds);
  const rows = [];
  for (const [id, record] of Object.entries(state.records)) {
    const [messageId, timingId] = id.split(":");
    const operationId = await timingOperationId({messageId,timingId});
    const sameTiming = ([key, value], namespace) =>
      key === namespace + state.accountId + ":" + operationId ||
      key === namespace + state.accountId + ":" + messageId ||
      (value.timingRef?.messageId === messageId && value.timingRef?.timingId === timingId);
    const relatedOperations = state.operations.filter(entry=>sameTiming(entry,"agenda:operation:"));
    const relatedPreviews = state.previews.filter(entry=>sameTiming(entry,"agenda:preview:"));
    const reasons = [];
    if (listed.has(messageId)) reasons.push("元メールが保存済み一覧にあります");
    if (relatedOperations.length) reasons.push("予定登録の関連記録があります（確認済みを含めて保護）");
    if (relatedPreviews.length) reasons.push("登録前の照合プレビューがあります（期限切れも保護）");
    if (state.pending.includes(operationId) || state.pending.includes(messageId)) reasons.push("登録結果の未確認索引があります");
    if (state.history.includes(operationId) || state.history.includes(messageId)) reasons.push("登録履歴の索引があります");
    if (state.job?.accountIds?.includes(state.accountId)) reasons.push("メールの取得中です。完了後に再確認してください");
    rows.push({id,messageId,value:record.value,updatedAt:record.updatedAt,eligible:!reasons.length,reasons});
  }
  return rows;
}

// 削除候補・保護理由と、現在の保存状態に結び付く短時間の確認値を作る。
export async function prepareTimingCleanup(storage, input, now = Date.now()) {
  return storage.transaction(async tx => {
    const state = await snapshot(tx, input.accountId);
    const rows = await rowsFor(state);
    const nonce = crypto.randomUUID();
    const checksum = await digest({state,nonce});
    await tx.put(planKey(input.accountId), {nonce,checksum,expires:now+planLifetimeMs});
    return { accountId:input.accountId, checksum, expiresAt:now+planLifetimeMs, rows,
      count:rows.length, eligibleCount:rows.filter(row=>row.eligible).length, maximumRecords:maximumTimingRecords };
  });
}

// 確認した一覧外記録だけを原子的に削除し、関連する記録は変更しない。
export async function cleanupTimings(storage, input, now = Date.now()) {
  if (input.confirm !== true || !Array.isArray(input.selected) || !input.selected.length ||
      input.selected.length > maximumTimingRecords || input.selected.some(id=>typeof id!=="string") ||
      new Set(input.selected).size !== input.selected.length)
    throw new InputError("整理する一覧外の確定日時を選び、確認画面の内容を確認してください");
  return storage.transaction(async tx => {
    const state = await snapshot(tx,input.accountId);
    const plan = await tx.get(planKey(input.accountId));
    if (!plan || plan.expires <= now || input.checksum !== plan.checksum ||
        await digest({state,nonce:plan.nonce}) !== plan.checksum)
      throw new InputError("記録・関連情報が変わったか、確認期限が切れました。再取得して確認してください");
    const rows = new Map((await rowsFor(state)).map(row=>[row.id,row]));
    if (input.selected.some(id=>!rows.get(id)?.eligible))
      throw new InputError("一覧内のメール・予定登録や関連記録がある確定日時は整理できません");
    const selected = new Set(input.selected);
    const retained = Object.fromEntries(Object.entries(state.records).filter(([id])=>!selected.has(id)));
    await tx.put(recordsKey(input.accountId), retained);
    // 個別記録を消して空きを作っても、整理前の「未保存」フォームを復活させない。
    const collectionRevision = crypto.randomUUID();
    await tx.put("agenda:timingCollection:" + input.accountId, collectionRevision);
    await tx.delete(planKey(input.accountId));
    return {accountId:input.accountId,removed:input.selected,remaining:Object.keys(retained).length,collectionRevision};
  });
}
