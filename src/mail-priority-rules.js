import { InputError } from "./sync.js";
import { currentMailPriority } from "./agenda-priority.js";

const maximumEntries = 20;
const maximumKeywordLength = 100;
export const priorityRuleFields = [
  "prioritySenders",
  "excludedSenders",
  "priorityKeywords",
  "excludedKeywords",
];
export const emptyPriorityRules = () =>
  Object.fromEntries(priorityRuleFields.map((key) => [key, []]));
const emailPattern =
  /^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i;

// 保存・プレビュー・復元に共通の境界。未知のキーや正規表現を実行しない。
export function normalizePriorityRules(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !priorityRuleFields.includes(key))
  )
    throw new InputError("重要メール設定の形式が不正です");
  return Object.fromEntries(
    priorityRuleFields.map((key) => {
      const entries = input[key];
      if (!Array.isArray(entries) || entries.length > maximumEntries)
        throw new InputError("各設定は20件までの一覧で指定してください");
      const values = entries.map((entry) => {
        if (typeof entry !== "string" || /[\u0000-\u001f\u007f]/.test(entry))
          throw new InputError("設定に改行や制御文字を含めることはできません");
        const value = entry.normalize("NFKC").trim().toLowerCase();
        if (
          !value ||
          value.length > (key.endsWith("Senders") ? 254 : maximumKeywordLength)
        )
          throw new InputError(
            "空の設定、または長すぎる設定があります（語句は100文字まで）",
          );
        if (key.endsWith("Senders")) {
          const valid = value.startsWith("@")
            ? emailPattern.test("check" + value)
            : emailPattern.test(value);
          if (!valid || value.includes(".."))
            throw new InputError(
              "送信者はメールアドレスまたは @example.com の形式で入力してください",
            );
        }
        return value;
      });
      return [key, [...new Set(values)]];
    }),
  );
}
function senderAddress(from) {
  const value =
    typeof from === "string" ? from.normalize("NFKC").trim().toLowerCase() : "";
  const bracket = value.match(/^[^<>\r\n]*<([^<>]+)>$/);
  const address = bracket ? bracket[1].trim() : value;
  return emailPattern.test(address) ? address : null;
}
function matchesSender(address, entries) {
  if (!address) return false;
  const domain = address.slice(address.lastIndexOf("@"));
  return entries.some((entry) =>
    entry.startsWith("@") ? entry === domain : entry === address,
  );
}
// カスタム設定は保存済み件名・抜粋だけを使う。差出人の真正性は保証しない。
export function priorityWithRules(message, rules = emptyPriorityRules()) {
  const builtin = currentMailPriority(message);
  if (message.keepBody === true)
    return {...builtin,important:true,reason:"本人がこのメールを重要として本文保存"};
  // 本文整理後に除外語句だけ消えて重要扱いへ戻ることを防ぐ。設定変更は再取得時に適用する。
  if (message.bodyCoverage === "excluded")
    return { ...builtin, important: false, reason: "本文未保存（優先設定の反映にはメールを再取得）" };
  const sender = senderAddress(message.from);
  const context = (
    (message.subject || "") +
    "\n" +
    (message.excerpt || "").slice(0, 1600)
  )
    .normalize("NFKC")
    .toLowerCase();
  if (
    matchesSender(sender, rules.excludedSenders) ||
    rules.excludedKeywords.some((word) => context.includes(word))
  )
    return {
      ...builtin,
      important: false,
      reason: "本人の除外設定に一致（その他に表示）",
    };
  if (
    matchesSender(sender, rules.prioritySenders) ||
    rules.priorityKeywords.some((word) => context.includes(word))
  )
    return { ...builtin, important: true, reason: "本人の優先設定に一致" };
  return builtin;
}
export async function priorityRulesView(storage, accountId) {
  const saved = await storage.get("agenda:priorityRules:" + accountId);
  return saved || { revision: null, rules: emptyPriorityRules() };
}
async function requireAccount(storage, id) {
  if (
    !((await storage.get("agenda:accounts")) || []).some(
      (account) => account.id === id,
    )
  )
    throw new InputError("接続済みのアカウントを選択してください");
}
export async function previewPriorityRules(storage, input) {
  await requireAccount(storage, input.accountId);
  const rules = normalizePriorityRules(input.rules);
  const saved = await priorityRulesView(storage, input.accountId);
  const messages =
    (await storage.get("agenda:cache:" + input.accountId))?.messages || [];
  const changed = messages.flatMap((message) => {
    const before = priorityWithRules(message, saved.rules).important;
    const after = priorityWithRules(message, rules);
    return before === after.important
      ? []
      : [
          {
            subject: message.subject || "件名なし",
            important: after.important,
            reason: after.reason,
          },
        ];
  });
  return {
    total: messages.length,
    unavailableCount: messages.filter(message => message.bodyCoverage === "excluded").length,
    important: messages.filter(
      (message) => priorityWithRules(message, rules).important,
    ).length,
    changedCount: changed.length,
    changed: changed.slice(0, 10),
    revision: saved.revision,
  };
}
export async function savePriorityRules(storage, input) {
  const rules = normalizePriorityRules(input.rules);
  if (input.confirm !== true)
    throw new InputError("重要メール設定の保存を確認してください");
  await storage.transaction(async (tx) => {
    await requireAccount(tx, input.accountId);
    const saved = await priorityRulesView(tx, input.accountId);
    if (input.revision !== saved.revision)
      throw new InputError(
        "別の画面で設定が変更されています。再読込して確認してください",
      );
    await tx.put("agenda:priorityRules:" + input.accountId, {
      rules,
      revision: crypto.randomUUID(),
    });
  });
  return priorityRulesView(storage, input.accountId);
}
