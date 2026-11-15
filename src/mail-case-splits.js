import { digest } from "./agenda-rules.js";
import { mailGroupingKey } from "./mail-suggestions.js";
import { mailCaseId, normalizeCaseRecords } from "./mail-cases.js";
import { InputError } from "./sync.js";

const maximumAssignments = 1000;
const maximumBytes = 512 * 1024;
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const labelValid = (value) =>
  typeof value === "string" &&
  !!value.trim() &&
  value.length <= 100 &&
  !/[\u0000-\u001f\u007f]/.test(value);
const keyFor = (accountId) => "agenda:caseSplits:" + accountId;
const manualKey = (id) => JSON.stringify(["manual", id]);

// 所有するメールIDと分類だけを保存し、本文・他アカウントの識別子を複製しない。
export function normalizeSplitStore(value) {
  if (
    !value ||
    !uuid.test(value.revision) ||
    !value.assignments ||
    typeof value.assignments !== "object" ||
    Array.isArray(value.assignments) ||
    Object.keys(value.assignments).length > maximumAssignments
  )
    throw new InputError("メールの手動分類は各アカウント1000通までです");
  const assignments = {};
  for (const [messageId, record] of Object.entries(value.assignments)) {
    if (
      !/^[a-f0-9]{1,64}$/.test(messageId) ||
      !record ||
      !uuid.test(record.caseId) ||
      !labelValid(record.label) ||
      !hash.test(record.originalCaseId)
    )
      throw new InputError("メールの手動分類が不正です");
    assignments[messageId] = {
      caseId: record.caseId,
      label: record.label.trim(),
      originalCaseId: record.originalCaseId,
    };
  }
  const result = { revision: value.revision, assignments };
  if (new TextEncoder().encode(JSON.stringify(result)).length > maximumBytes)
    throw new InputError(
      "メール分類の保存上限512KiBです。変更せず停止しました",
    );
  return result;
}
export function splitLabels(stores) {
  const cases = new Map();
  for (const store of stores)
    for (const record of Object.values(store.assignments)) {
      const previous = cases.get(record.caseId);
      if (previous && previous.label !== record.label)
        throw new InputError("同じ分割案件の名前が一致しません");
      if (!previous)
        cases.set(record.caseId, {
          id: record.caseId,
          label: record.label,
          origins: [],
          count: 0,
        });
      const item = cases.get(record.caseId);
      item.count++;
      if (!item.origins.includes(record.originalCaseId))
        item.origins.push(record.originalCaseId);
    }
  return [...cases.values()];
}
async function storesFor(storage, accounts) {
  return new Map(
    await Promise.all(
      accounts.map(async (account) => {
        const saved = await storage.get(keyFor(account.id));
        return [
          account.id,
          saved
            ? normalizeSplitStore(saved)
            : { revision: null, assignments: {} },
        ];
      }),
    ),
  );
}
export async function splitMailEntries(storage, accounts, entries) {
  const stores = await storesFor(storage, accounts);
  const cases = splitLabels(stores.values());
  const caseVersions = await Promise.all(
    accounts.map(async (account) => [
      account.id,
      Object.entries(
        normalizeCaseRecords(
          (await storage.get("agenda:cases:" + account.id)) || {},
        ),
      )
        .map(([id, record]) => [id, record.revision])
        .sort((a, b) => a[0].localeCompare(b[0])),
    ]),
  );
  // 移動先・戻り先も含め、選択中の案内や対応状態の変更を古いフォームで上書きしない。
  const revision = await digest({
    stores: [...stores]
      .map(([id, store]) => [id, store.revision])
      .sort((a, b) => a[0].localeCompare(b[0])),
    cases: caseVersions.sort((a, b) => a[0].localeCompare(b[0])),
    sources: entries
      .filter((entry) => entry.kind !== "pending")
      .map((entry) => [
        entry.accountId,
        entry.messageId,
        entry.caseSourceRevision,
        entry.timings?.map((timing) => [
          timing.timingId,
          timing.sourceRevision,
          timing.revision,
        ]),
      ])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  });
  const classified = await Promise.all(
    entries.map(async (entry) => {
      if (entry.kind === "pending") return entry;
      const assigned = stores.get(entry.accountId).assignments[entry.messageId];
      return {
        ...entry,
        automaticCaseId: await mailCaseId(mailGroupingKey(entry)),
        ...(assigned
          ? { manualCase: { id: assigned.caseId, label: assigned.label } }
          : {}),
      };
    }),
  );
  return { entries: classified, splitRevision: revision, splitCases: cases };
}

async function reopenCases(storage, accounts, ids, now) {
  const revision = crypto.randomUUID();
  for (const account of accounts) {
    const key = "agenda:cases:" + account.id;
    const records = normalizeCaseRecords((await storage.get(key)) || {});
    let changed = false;
    for (const id of ids)
      if (records[id]) {
        records[id] = {
          ...records[id],
          status: "open",
          snoozeUntil: null,
          revision,
          updatedAt: new Date(now).toISOString(),
        };
        changed = true;
      }
    if (changed) await storage.put(key, normalizeCaseRecords(records));
  }
}

// 呼び出し元のSQLiteトランザクション内で案内・分類・対応記録を同時に照合する。
export async function writeMailSplit(storage, view, input, now = Date.now()) {
  const group = view.groups.find(
    (group) => group.caseState?.id === input.caseId,
  );
  if (
    input.confirmed !== true ||
    !group ||
    input.expectedSplitRevision !== view.splitRevision ||
    input.sourceRevision !== group.caseState.sourceRevision ||
    input.expectedRevision !== group.caseState.revision
  )
    throw new InputError(
      "案内・分類・対応状態が変わったか、確認が未完了です。再読込してください",
    );
  const stores = await storesFor(storage, view.accounts);
  const affected = new Set();
  const changedAccounts = new Set();
  let result;
  if (input.reset === true) {
    if (!group.manualCaseId)
      throw new InputError("手動で分けた案件を選択してください");
    let count = 0;
    for (const entry of group.entries) affected.add(entry.automaticCaseId);
    for (const [accountId, store] of stores)
      for (const [id, record] of Object.entries(store.assignments))
        if (record.caseId === group.manualCaseId) {
          changedAccounts.add(accountId);
          count++;
          affected.add(record.originalCaseId);
          delete store.assignments[id];
          store.revision = crypto.randomUUID();
        }
    result = { reset: true, count, targetId: group.manualCaseId };
    // 分割側の保存記録は履歴に保ち、戻り先の過去の対応済みを復活させない。
  } else {
    if (
      !Array.isArray(input.messages) ||
      !input.messages.length ||
      input.messages.length > maximumAssignments ||
      new Set(
        input.messages.map((item) =>
          JSON.stringify([item?.accountId, item?.messageId]),
        ),
      ).size !== input.messages.length
    )
      throw new InputError("分けるメールを重複なく選択してください");
    const chosen = input.messages.map((item) =>
      group.entries.find(
        (entry) =>
          entry.accountId === item?.accountId &&
          entry.messageId === item?.messageId,
      ),
    );
    if (chosen.some((entry) => !entry))
      throw new InputError("この案件に含まれるメールだけを選択してください");
    let target;
    if (input.targetId !== null) {
      target = view.splitCases.find((item) => item.id === input.targetId);
      if (
        !target ||
        target.id === group.manualCaseId ||
        chosen.some((entry) => !target.origins.includes(entry.automaticCaseId))
      )
        throw new InputError(
          "同じ元の関連候補から分けた別案件を選択してください",
        );
    } else {
      if (!labelValid(input.label))
        throw new InputError("新しい案件名を100文字以内で入力してください");
      target = { id: crypto.randomUUID(), label: input.label.trim() };
    }
    for (const entry of chosen) {
      changedAccounts.add(entry.accountId);
      const store = stores.get(entry.accountId);
      store.assignments[entry.messageId] = {
        caseId: target.id,
        label: target.label,
        originalCaseId: entry.automaticCaseId,
      };
      store.revision = crypto.randomUUID();
    }
    result = { reset: false, count: chosen.length, targetId: target.id };
    affected.add(group.caseState.id);
    affected.add(await mailCaseId(manualKey(target.id)));
  }
  const updated = [];
  for (const [accountId, store] of stores)
    if (changedAccounts.has(accountId))
      updated.push([keyFor(accountId), normalizeSplitStore(store)]);
  splitLabels(stores.values());
  for (const [key, store] of updated) await storage.put(key, store);
  await reopenCases(storage, view.accounts, affected, now);
  return result;
}
