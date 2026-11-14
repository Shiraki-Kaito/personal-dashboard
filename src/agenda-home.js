import { agendaConnectionStatus } from "./agenda-google.js";
import { priorityWithRules, priorityRulesView } from "./mail-priority-rules.js";
import { displayAccounts } from "./agenda-labels.js";
import { groupMailSuggestions } from "./mail-suggestions.js";
const mailFreshMs = 60 * 60 * 1000;
// 保存済みのメール候補・確認記録・未確定操作を集約する。Googleへの通信は行わない。
export async function agendaHome(storage, now = Date.now()) {
  const accounts = [],
    entries = [],
    alerts = [];
  for (const account of await displayAccounts(storage)) {
    const connection = agendaConnectionStatus(
      account.disconnectedAt ? null : await storage.get("agenda:credential:" + account.id),
    );
    const cache = (await storage.get("agenda:cache:" + account.id)) || {};
    const reviews = (await storage.get("agenda:reviews:" + account.id)) || {};
    const pending = (await storage.get("agenda:pending:" + account.id)) || [];
    const messages = cache.messages || [];
    const { rules } = await priorityRulesView(storage, account.id);
    const stale =
      !Number.isFinite(Date.parse(cache.lastSuccess)) ||
      now - Date.parse(cache.lastSuccess) > mailFreshMs;
    const unclassified = messages.filter(
      (message) => typeof message.candidate?.isCandidate !== "boolean",
    ).length;
    accounts.push({
      ...account,
      ...connection,
      lastAttempt: cache.lastAttempt || null,
      lastSuccess: cache.lastSuccess || null,
      error: cache.error || null,
      stale,
      loaded: messages.length,
      hasMore: !!cache.nextPageToken || !!cache.limited,
      unclassified,
    });
    if (!account.disconnectedAt && (!connection.connected || cache.error || stale || unclassified))
      alerts.push({
        service: "agenda",
        message:
          account.email +
          "：" +
          (!connection.connected
            ? "メール・予定の再接続が必要"
            : cache.error ||
              (!cache.lastSuccess
                ? "メール未取得"
                : unclassified
                  ? "予定候補の判定を更新してください"
                  : "1時間以上前のメール情報です")),
      });
    for (const id of pending) {
      const operation = await storage.get(
        "agenda:operation:" + account.id + ":" + id,
      );
      if (operation)
        entries.push({
          kind: "pending",
          accountId: account.id,
          messageId: id,
          email: account.email,
          accountName: account.label
            ? account.label + " · " + account.email
            : account.email,
          title: operation.draft.title,
          reason: operation.error || operation.phase,
        });
    }
    if (account.disconnectedAt) continue;
    for (const message of messages) {
      if (
        !priorityWithRules(message, rules).important ||
        reviews[message.id] ||
        pending.includes(message.id)
      )
        continue;
      const operation = await storage.get(
        "agenda:operation:" + account.id + ":" + message.id,
      );
      if (operation?.phase === "登録確認済み") continue;
      entries.push({
        kind: "mail",
        accountId: account.id,
        messageId: message.id,
        email: account.email,
        accountName: account.label
          ? account.label + " · " + account.email
          : account.email,
        title: message.subject || "件名なし",
        from: message.from || "",
        excerpt: message.excerpt || "",
        reason:
          operation?.error ||
          priorityWithRules(message, rules).reason,
        receivedAt: message.receivedAt,
      });
    }
  }
  entries.sort(
    (a, b) =>
      (a.kind === "pending" ? 0 : 1) - (b.kind === "pending" ? 0 : 1) ||
      (b.receivedAt || "").localeCompare(a.receivedAt || ""),
  );
  return {
    accounts,
    entries: entries.map(({ excerpt, from, ...entry }) => entry),
    groups: groupMailSuggestions(entries),
    alerts,
    complete: accounts.every(
      (a) =>
        a.connected && !a.stale && !a.error && !a.hasMore && !a.unclassified,
    ),
    pending: entries.filter((e) => e.kind === "pending").length,
    candidates: entries.filter((e) => e.kind === "mail").length,
  };
}
