import { priorityRulesView, priorityWithRules } from "./mail-priority-rules.js";

// Gmailの原文と本人の確定記録は変更せず、再取得できるメール本文の保存対象を絞る。
export async function retainImportantMailBodies(storage, accountId, messages) {
  const { rules } = await priorityRulesView(storage, accountId);
  const confirmations = await storage.get("agenda:timingConfirmations:" + accountId) || {};
  const protectedIds = new Set(Object.keys(confirmations).map(key => key.split(":")[0]));
  for (const id of await storage.get("agenda:pending:" + accountId) || []) protectedIds.add(id);
  const retained = [];
  for (const message of messages) {
    const important = priorityWithRules(message, rules).important;
    const protectedRecord = message.bodyCoverage === "unavailable" || protectedIds.has(message.id) || !!await storage.get("agenda:operation:" + accountId + ":" + message.id);
    if (important || protectedRecord) {
      retained.push({...message, bodyRetention: protectedRecord ? "protected" : "important"});
      continue;
    }
    // メタデータは「その他」から誤判定を見直すため残す。再取得で本文を復元できる。
    const { timingText, ...metadata } = message;
    retained.push({
      ...metadata,
      excerpt: "",
      candidate: {title:message.subject || "",start:"",end:"",location:"",reasons:["重要条件に未一致のため本文を保存していません。Gmailで確認するか優先設定を変更して再取得してください"],status:"確認待ち",isCandidate:false},
      bodyCoverage: "excluded",
      contentLimited: true,
      bodyRetention: "excluded",
    });
  }
  return retained;
}
