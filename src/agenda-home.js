import { splitMailEntries, writeMailSplit, writeSplitManagement } from "./mail-case-splits.js";
import { mailCaseView, writeMailCase } from "./mail-cases.js";
import { digest } from "./agenda-rules.js";
import { prioritySearchPlan, mailRetrievalView } from "./mail-retrieval.js";
import { agendaConnectionStatus } from "./agenda-google.js";
import { priorityWithRules, priorityRulesView } from "./mail-priority-rules.js";
import { displayAccounts } from "./agenda-labels.js";
import { groupMailSuggestions } from "./mail-suggestions.js";
import { messageTimingView } from "./timing-confirmations.js";
import { timingOperationId } from "./timing-calendar.js";
import { mailBodyNotice } from "./mail-body-coverage.js";
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
    const timingRecords = (await storage.get("agenda:timingConfirmations:" + account.id)) || {};
    const { rules } = await priorityRulesView(storage, account.id);
    const retrievalView = mailRetrievalView(cache,await prioritySearchPlan(rules),now);
    const stale =
      !Number.isFinite(Date.parse(cache.lastSuccess)) ||
      now - Date.parse(cache.lastSuccess) > mailFreshMs;
    const contentLimitedCount = messages.filter(message => !!mailBodyNotice(message)).length;
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
      contentLimitedCount,
      retrievalView,
    });
    if (!account.disconnectedAt && (!connection.connected || cache.error || stale || unclassified || contentLimitedCount))
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
                  : contentLimitedCount
                    ? "本文の一部だけを解析したメールが"+contentLimitedCount+"件あります。原文を確認してください"
                    : "1時間以上前のメール情報です")),
      });
    if (!account.disconnectedAt && retrievalView.notice) alerts.push({service:"agenda",message:account.email+"："+retrievalView.notice});
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
      const timingView = await messageTimingView(message,timingRecords);
      for (const timing of timingView.timings) if (timing.manual) {
        const operationId = await timingOperationId({messageId:message.id,timingId:timing.timingId});
        const operation = await storage.get("agenda:operation:"+account.id+":"+operationId);
        if (operation) timing.calendarPhase = operation.phase;
      }
      entries.push({
        kind: "mail",
        contentLimited: !!message.contentLimited,
        caseSourceRevision: await digest({subject:message.subject,from:message.from,excerpt:message.excerpt}),
        accountId: account.id,
        messageId: message.id,
        email: account.email,
        accountName: account.label
          ? account.label + " · " + account.email
          : account.email,
        title: message.subject || "件名なし",
        from: message.from || "",
        excerpt: message.excerpt || "",
        timings: timingView.timings,
        timingNotice: timingView.notice,
        sourceStale: stale || !!cache.error || !connection.connected,
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
  const classified = await splitMailEntries(storage, accounts, entries);
  const caseView = await mailCaseView(storage, accounts, groupMailSuggestions(classified.entries, now), now);
  const activeStatuses = new Map(caseView.groups.filter(group=>group.manualCaseId).map(group=>[group.manualCaseId,group.caseState.status]));
  const archivedStatuses = new Map(caseView.caseHistory.map(record=>[record.id,record.status]));
  return {
    splitRevision: classified.splitRevision,
    splitCases: classified.splitCases.map(item=>({...item,status:activeStatuses.get(item.id) || archivedStatuses.get(item.recordId) || "open"})),
    accounts,
    entries: entries.map(({ excerpt, from, timings, timingNotice, ...entry }) => entry),
    ...caseView,
    alerts,
    complete: accounts.every(
      (a) =>
        a.connected && !a.stale && !a.error && !a.hasMore && !a.unclassified && !a.contentLimitedCount && !a.retrievalView.notice,
    ),
    pending: entries.filter((e) => e.kind === "pending").length,
    candidates: entries.filter((e) => e.kind === "mail").length,
  };
}

export async function saveAgendaCase(storage, input, now = Date.now()) {
  return storage.transaction(async tx => {
    const view = await agendaHome(tx, now);
    await writeMailCase(tx, view.accounts, view, input, now);
    return agendaHome(tx, now);
  });
}

export async function saveAgendaSplit(storage, input, now = Date.now()) {
  return storage.transaction(async tx => {
    const view = await agendaHome(tx, now);
    const splitResult = await writeMailSplit(tx, view, input, now);
    return {...await agendaHome(tx, now),splitResult};
  });
}

export async function manageAgendaSplit(storage,input,now=Date.now()) {
  return storage.transaction(async tx=>{
    const view=await agendaHome(tx,now);
    const splitManagementResult=await writeSplitManagement(tx,view,input,now);
    return {...await agendaHome(tx,now),splitManagementResult};
  });
}
