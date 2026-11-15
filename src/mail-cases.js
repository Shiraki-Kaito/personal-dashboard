import { digest } from "./agenda-rules.js";
import { InputError } from "./sync.js";

const maximumRecords = 1000;
const maximumRecordBytes = 512 * 1024;
const statuses = new Set(["open", "done", "hold"]);
const hashPattern = /^[a-f0-9]{64}$/;
const revisionPattern = /^[a-f0-9-]{36}$/;
const text = (value, limit) =>
  typeof value === "string" &&
  value.length <= limit &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const japanDate = (now) =>
  new Date(now + 9 * 3600000).toISOString().slice(0, 10);
const validDate = (value) =>
  typeof value === "string" &&
  /^20\d{2}-\d\d-\d\d$/.test(value) &&
  Number.isFinite(Date.parse(value + "T00:00:00Z")) &&
  new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
const stateKey = (accountId) => "agenda:cases:" + accountId;

// アカウントごとの記録だけを保持する。他のアカウントの識別子やメール本文は保存しない。
export function normalizeCaseRecords(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length > maximumRecords
  )
    throw new InputError("案件記録は各アカウント1000件までです");
  const result = {};
  for (const [id, record] of Object.entries(input)) {
    if (
      !hashPattern.test(id) ||
      !record ||
      !hashPattern.test(record.sourceRevision) ||
      !revisionPattern.test(record.revision) ||
      !statuses.has(record.status) ||
      !text(record.label, 300) ||
      !record.label ||
      !text(record.note, 200) ||
      typeof record.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(record.updatedAt)) ||
      !(
        record.snoozeUntil === null ||
        (record.status === "hold" && validDate(record.snoozeUntil))
      )
    )
      throw new InputError("案件の保存内容が不正です");
    result[id] = {
      sourceRevision: record.sourceRevision,
      revision: record.revision,
      status: record.status,
      label: record.label,
      note: record.note,
      snoozeUntil: record.snoozeUntil,
      updatedAt: record.updatedAt,
    };
  }
  if (
    new TextEncoder().encode(JSON.stringify(result)).length > maximumRecordBytes
  )
    throw new InputError("案件記録の保存上限512KiBです。変更せず停止しました");
  return result;
}

async function accountStores(storage, accounts) {
  return new Map(
    await Promise.all(
      accounts.map(async (account) => [
        account.id,
        normalizeCaseRecords((await storage.get(stateKey(account.id))) || {}),
      ]),
    ),
  );
}
const memberIds = (group) =>
  [...new Set(group.entries.map((entry) => entry.accountId))].sort();
async function recordRevision(stores, accountIds, caseId) {
  return digest(
    accountIds.map((id) => [id, stores.get(id)?.[caseId]?.revision || null]),
  );
}
function effectiveStatus(record, now) {
  return record?.status === "hold" &&
    record.snoozeUntil &&
    record.snoozeUntil <= japanDate(now)
    ? "open"
    : record?.status || "open";
}

// 同じカードに新しいメールや確定日時が加わったら、以前の対応済みを適用しない。
export async function mailCaseView(
  storage,
  accounts,
  groups,
  now = Date.now(),
) {
  const stores = await accountStores(storage, accounts);
  const currentIds = new Set();
  const decorated = await Promise.all(
    groups.map(async (group) => {
      if (group.pending) return { ...group, caseState: null };
      const id = await digest({ version: 1, key: group.caseKey });
      currentIds.add(id);
      const accountIds = memberIds(group);
      const sourceRevision = await digest({
        members: group.entries
          .map((entry) => [
            entry.accountId,
            entry.messageId,
            entry.title,
            entry.receivedAt,
            entry.caseSourceRevision || entry.excerpt,
          ])
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        timings: group.timings
          .map((timing) => [
            timing.accountId,
            timing.messageId,
            timing.timingId || null,
            timing.sourceRevision || null,
            timing.kind,
            timing.action,
            timing.date,
            timing.startAt,
            timing.endAt,
            timing.confirmed,
          ])
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      });
      const records = accountIds.map((accountId) => stores.get(accountId)[id]);
      const saved = records
        .filter(Boolean)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      const applies =
        !!saved &&
        records.every(
          (record) =>
            record &&
            record.revision === saved.revision &&
            record.sourceRevision === sourceRevision,
        );
      const expired = applies && effectiveStatus(saved, now) !== saved.status;
      return {
        ...group,
        caseState: {
          id,
          sourceRevision,
          revision: await recordRevision(stores, accountIds, id),
          status: applies ? effectiveStatus(saved, now) : "open",
          note: saved?.note || "",
          snoozeUntil: applies ? saved.snoozeUntil : null,
          updatedAt: saved?.updatedAt || null,
          notice:
            saved && !applies
              ? "関連メール・確定日時・接続範囲が変わったため、以前の状態を適用せず未対応に戻しました。"
              : expired
                ? "保留の再表示日になりました。対応内容を確認してください。"
                : "",
        },
      };
    }),
  );
  const archived = new Map();
  for (const [accountId, records] of stores)
    for (const [id, record] of Object.entries(records)) {
      if (currentIds.has(id)) continue;
      if (!archived.has(id)) archived.set(id, { id, record, accountIds: [] });
      const item = archived.get(id);
      item.accountIds.push(accountId);
      if (record.updatedAt > item.record.updatedAt) item.record = record;
    }
  const history = await Promise.all(
    [...archived.values()]
      .filter((item) => item.record.status !== "open")
      .map(async (item) => ({
        id: item.id,
        label: item.record.label,
        note: item.record.note,
        status: effectiveStatus(item.record, now),
        snoozeUntil: item.record.snoozeUntil,
        updatedAt: item.record.updatedAt,
        accountCount: item.accountIds.length,
        sourceRevision: null,
        revision: await recordRevision(stores, item.accountIds.sort(), item.id),
      })),
  );
  history.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { groups: decorated, caseHistory: history };
}

// 呼び出し元のトランザクション内で、取得し直したカードと保存版を照合して更新する。
export async function writeMailCase(
  storage,
  accounts,
  view,
  input,
  now = Date.now(),
) {
  if (
    !hashPattern.test(input.caseId) ||
    !hashPattern.test(input.expectedRevision) ||
    !statuses.has(input.status) ||
    input.confirmed !== true ||
    !text(input.note, 200) ||
    !(
      input.snoozeUntil === null ||
      (input.status === "hold" &&
        validDate(input.snoozeUntil) &&
        input.snoozeUntil > japanDate(now))
    )
  )
    throw new InputError(
      "案件の状態・メモ・再表示日と確認チェックを確認してください",
    );
  const group = view.groups.find(
    (group) => group.caseState?.id === input.caseId,
  );
  const archived = view.caseHistory.find(
    (record) => record.id === input.caseId,
  );
  const current = group?.caseState || archived;
  if (
    !current ||
    current.revision !== input.expectedRevision ||
    current.sourceRevision !== input.sourceRevision
  )
    throw new InputError(
      "案件の案内か保存状態が変わりました。再読込して確認してください",
    );
  if (!group && input.status !== "open")
    throw new InputError(
      "元メールが現在の一覧にありません。保存記録は未対応へ戻す操作だけができます",
    );
  const stores = await accountStores(storage, accounts);
  const accountIds = group
    ? memberIds(group)
    : [...stores]
        .filter(([, records]) => records[input.caseId])
        .map(([id]) => id);
  const revision = crypto.randomUUID();
  const updated = [];
  for (const accountId of accountIds) {
    const records = stores.get(accountId);
    const previous = records[input.caseId];
    const record = {
      sourceRevision: group ? current.sourceRevision : previous.sourceRevision,
      revision,
      status: input.status,
      label: (group?.label || previous.label).slice(0, 300),
      note: input.note.trim(),
      snoozeUntil: input.snoozeUntil,
      updatedAt: new Date(now).toISOString(),
    };
    updated.push([
      stateKey(accountId),
      normalizeCaseRecords({ ...records, [input.caseId]: record }),
    ]);
  }
  // 全宛先の容量・形式を先に検証し、片方だけ対応済みになる状態を作らない。
  for (const [key, records] of updated) await storage.put(key, records);
}
