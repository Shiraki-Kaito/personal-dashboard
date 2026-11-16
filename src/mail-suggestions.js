import {
  analyzeMailIntent,
  timingReferenceReason,
  submissionTopics,
} from "./mail-intent.js";
import {
  extractMailTiming,
  timingPriority,
  timingRevisionNotice,
} from "./mail-timing.js";
// 保存済みメールから関連候補と次の確認案を作る純粋関数。送信・登録・確認済み化は行わない。
const normalize = (value = "") =>
  value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
function organization(subject) {
  const brackets = subject.matchAll(/[【\[「]([^】\]」]{2,100})[】\]」]/g);
  for (const [, value] of brackets) {
    if (/株式会社|有限会社|大学|高等専門学校/.test(value)) return value.trim();
  }
  return null;
}
function subjectKey(title) {
  return normalize(title).replace(
    /^(?:(?:re|fw|fwd)\s*:\s*|[◆◇★☆]+|【(?:再送|リマインド|重要)】)+/g,
    "",
  );
}
function senderAddress(from = "") {
  return normalize(
    from.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ||
      "",
  );
}
export function mailSuggestion(entry, intent = analyzeMailIntent(entry)) {
  if (entry.kind === "pending")
    return {
      title: "予定の登録結果を確認しませんか？",
      reason:
        "登録結果が未確認です。重複を避けるため、再登録より先に結果を照合してください。",
      category: "結果未確認",
      checks: ["登録結果を照合し、重複登録を避ける"],
      hasReceiptStatement: false,
      evidence: "",
    };
  const checks = [];
  let title, reason, category;
  if (intent.receipt) {
    category = "受付の確認";
    title = "受付内容と、残っている手続きを確認しませんか？";
    reason =
      "保存された案内に受付・受領・完了の記載があります。同じ提出物の再提出は勧めません。他の宛先・別手続きまで完了したとは判断しません。";
    checks.push("この宛先で受け付けられた提出物と、受付の範囲を確認する");
    if (intent.remainingRequests.length) {
      category = "受付と追加依頼の確認";
      title = "受付済みの範囲と、追加・再提出の依頼を確認しませんか？";
      checks.push("最新の本文に明記された追加・再提出の対象だけを確認する");
    } else if (intent.schedule) {
      category = "受付後の日程確認";
      title = "受付済みの内容と、次の面接・予定の案内を確認しませんか？";
    } else if (intent.response) {
      category = "受付後の回答確認";
      title = "受付済みの内容と、残っている回答を確認しませんか？";
    }
  } else if (intent.remainingRequests.length) {
    category = "提出の確認";
    title = "提出が必要な書類と期限を確認しませんか？";
    reason =
      "提出依頼・提出期限の記載があります。提出状況と対象書類を最新の案内で照合してください。";
    checks.push("提出する書類・提出先・締切を元の案内で確認する");
  } else if (intent.submissionMention) {
    category = "提出状況の確認";
    title = "提出状況と、最新の案内を確認しませんか？";
    reason =
      "提出に関する記載はありますが、保存範囲だけでは新しい提出依頼と断定できません。";
    checks.push("提出済みか、追加の対応があるかを元の案内で確認する");
  } else if (intent.schedule) {
    category = "日程の確認";
    title = "日程を確認して、予定と照らし合わせませんか？";
    reason =
      "面接・会議などの日程に関する記載があります。日時が曖昧な場合も元メールから確認できます。";
  } else if (intent.response) {
    category = "回答の確認";
    title = "回答や確認が必要か、見ておきませんか？";
    reason =
      "返信・回答・確認を求める語句があります。対応が必要かを元メールで判断してください。";
  } else {
    category = "内容の確認";
    title = "この連絡で、次にすることを確認しませんか？";
    reason =
      "重要メールとして抽出されています。具体的な対応を断定できないため、元の案内を確認してください。";
  }
  if (intent.schedule)
    checks.push("日時を確かめ、接続したアカウントの予定と照合する");
  if (intent.response) checks.push("返信・回答が必要かを確認する");
  if (intent.limited)
    reason +=
      " 本文の一部だけの判定です。保存範囲外の追加依頼は原文で確認してください。";
  return {
    title,
    reason,
    category,
    checks,
    hasReceiptStatement: intent.receipt,
    hasSubmissionRequest: intent.remainingRequests.length > 0,
    evidence: intent.evidence,
  };
}
export function mailGroupingKey(entry) {
  const company = organization(entry.title);
  const sender = senderAddress(entry.from);
  const year = (entry.title.match(/20\d{2}(?:年度|年卒|卒)/) || [""])[0];
  return entry.kind === "pending"
    ? JSON.stringify(["pending", entry.accountId, entry.messageId])
    : company
      ? JSON.stringify(["organization", normalize(company), year])
      : JSON.stringify([
          "subject",
          subjectKey(entry.title),
          sender || entry.accountId,
        ]);
}
const receivedTime = (entry) =>
  Number.isFinite(Date.parse(entry.receivedAt))
    ? Date.parse(entry.receivedAt)
    : null;
function currentSources(sorted) {
  const byAccount = new Map();
  for (const entry of sorted) {
    if (entry.kind === "pending") continue;
    if (!byAccount.has(entry.accountId)) byAccount.set(entry.accountId, []);
    byAccount.get(entry.accountId).push(entry);
  }
  const selected = [];
  const labels = new Map();
  let uncertain = false;
  for (const entries of byAccount.values()) {
    const known = entries.map(receivedTime).filter((value) => value !== null);
    const latest = known.length ? Math.max(...known) : null;
    const unknown = entries.some((entry) => receivedTime(entry) === null);
    const tied =
      entries.filter((entry) => receivedTime(entry) === latest).length > 1;
    if (unknown || tied) uncertain = true;
    for (const entry of entries) {
      const at = receivedTime(entry);
      const current = at === null || at === latest;
      if (current) selected.push(entry);
      labels.set(
        entry,
        at === null
          ? "受信日時不明・新旧未確定"
          : current
            ? unknown
              ? "最新候補・日時不明の案内あり"
              : tied
                ? "同時刻の最新候補・前後未確定"
                : "この宛先の最新案内"
            : "過去の関連案内",
      );
    }
  }
  return { selected, labels, uncertain };
}
const timingSource = (entry, timing) => ({
  ...timing,
  accountId: entry.accountId,
  messageId: entry.messageId,
  accountName: entry.accountName || entry.email,
  sourceTitle: entry.title,
  receivedAt: entry.receivedAt,
  sourceStale: !!entry.sourceStale,
});
export function groupMailSuggestions(entries, now = Date.now()) {
  const groups = new Map();
  // 未確定操作を他メールへ吸収せず、必ず独立した復旧案として残す。
  for (const entry of entries) {
    const company = organization(entry.title);
    const key =
      entry.kind !== "pending" && entry.manualCase
        ? JSON.stringify(["manual", entry.manualCase.id])
        : mailGroupingKey(entry);
    if (!groups.has(key))
      groups.set(key, {
        caseKey: key,
        manualCaseId:
          entry.kind !== "pending" ? entry.manualCase?.id || null : null,
        label:
          entry.kind !== "pending" && entry.manualCase
            ? entry.manualCase.label
            : company || entry.title,
        basis:
          entry.kind !== "pending" && entry.manualCase
            ? "本人が選んだメールによる手動の案件"
            : company
              ? "件名に同じ組織名がある関連候補"
              : "同じ件名と送信者の関連候補",
        entries: [],
      });
    groups.get(key).entries.push(entry);
  }
  return [...groups.values()]
    .map((group) => {
      const sorted = [...group.entries].sort(
        (a, b) =>
          (receivedTime(b) ?? -Infinity) - (receivedTime(a) ?? -Infinity) || 0,
      );
      const latestByAccount = new Map();
      for (const entry of sorted)
        if (!latestByAccount.has(entry.accountId))
          latestByAccount.set(entry.accountId, entry);
      const chronology = currentSources(sorted);
      const intents = new Map(
        sorted
          .filter((entry) => entry.kind !== "pending")
          .map((entry) => [entry, analyzeMailIntent(entry)]),
      );
      const timings = [...latestByAccount.values()].flatMap((entry) =>
        (entry.timings || extractMailTiming(entry)).map((timing) => ({
          ...timing,
          accountId: entry.accountId,
          messageId: entry.messageId,
          accountName: entry.accountName || entry.email,
          sourceTitle: entry.title,
          receivedAt: entry.receivedAt,
          sourceStale: !!entry.sourceStale,
        })),
      );
      const pending = sorted[0].kind === "pending";
      const kindOrder = { deadline: 0, event: 1, date: 2 };
      const compareTimings = (a, b) => {
        const first = timingPriority([a], false, now),
          second = timingPriority([b], false, now);
        return (
          first.rank - second.rank ||
          (first.at ?? Infinity) - (second.at ?? Infinity) ||
          kindOrder[a.kind] - kindOrder[b.kind]
        );
      };
      timings.sort(compareTimings);
      const sources = chronology.selected.map((entry) => ({
        entry,
        intent: intents.get(entry),
        suggestion: mailSuggestion(entry, intents.get(entry)),
      }));
      let suggestion = mailSuggestion(sorted[0], intents.get(sorted[0]));
      if (
        sources.length > 1 &&
        sources.some((source) => source.intent.receipt) &&
        sources.some(
          (source) =>
            !source.intent.receipt && source.intent.remainingRequests.length,
        )
      ) {
        const multipleAccounts =
          new Set(sources.map((source) => source.entry.accountId)).size > 1;
        suggestion = {
          title: multipleAccounts
            ? "宛先ごとの受付状況と、残る依頼を確認しませんか？"
            : "受付通知と提出依頼の前後を確認しませんか？",
          category: multipleAccounts ? "宛先別の確認" : "案内ごとの確認",
          reason: multipleAccounts
            ? "一部の宛先には受付通知がありますが、別の宛先の提出依頼まで完了したとは判断できません。"
            : "同時刻・日時不明の案内があるため、受付と依頼の前後を断定できません。",
          checks: [
            "宛先・提出物・手続きごとに、最新の依頼と受付の範囲を照合する",
          ],
          hasReceiptStatement: true,
          evidence: "",
        };
      }
      const proposalTimings = [],
        referenceTimings = [];
      for (const { entry, intent } of sources)
        for (const timing of entry.timings || extractMailTiming(entry)) {
          const source = timingSource(entry, timing);
          const change = timingRevisionNotice(timing);
          const referenceReason =
            !timing.manual && change?.state === "previous"
              ? change.message
              : timingReferenceReason(timing, intent);
          if (referenceReason)
            referenceTimings.push({ ...source, referenceReason });
          else
            proposalTimings.push({
              ...source,
              ...(change
                ? {
                    changeNotice: timing.manual
                      ? "本人確定日時を維持しています。元の案内に新旧の記載があります。必要なら本人が編集・解除してください。"
                      : change.message,
                    ...(!timing.manual
                      ? {
                          confirmed: false,
                          reasons: [...timing.reasons, "変更案内の最新日時を確認してください"],
                        }
                      : {}),
                  }
                : {}),
              ...(intent.receipt && timing.manual
                ? {
                    receiptNotice:
                      "本人確定日時を維持しています。最新の受付内容と照合し、不要になった場合は本人が解除してください。",
                  }
                : {}),
            });
        }
      proposalTimings.sort(compareTimings);
      const historyNotices = [];
      let uncertainOlderRequest = false;
      for (const entry of sorted) {
        if (entry.kind === "pending" || chronology.selected.includes(entry))
          continue;
        const intent = intents.get(entry);
        if (!intent.remainingRequests.length) continue;
        const newer = sources.filter(
          (source) =>
            source.entry.accountId === entry.accountId &&
            source.intent.receipt &&
            senderAddress(source.entry.from) &&
            senderAddress(source.entry.from) === senderAddress(entry.from),
        );
        if (!newer.length) continue;
        const topics = submissionTopics(entry.title + " " + intent.body);
        const covered = newer.some(
          (source) =>
            source.intent.comprehensive ||
            (topics.length > 0 &&
              topics.every((topic) =>
                source.intent.receiptTopics.includes(topic),
              )),
        );
        if (!covered) uncertainOlderRequest = true;
      }
      if (uncertainOlderRequest)
        historyNotices.push(
          "過去の関連案内には、最新の受付記載だけでは完了範囲を特定できない提出物があります。同じ手続きか、案件を分ける必要があるか確認してください。",
        );
      if (chronology.uncertain)
        historyNotices.push(
          "同時刻または受信日時不明の案内があり、前後関係を断定していません。候補を並べて確認してください。",
        );
      const priority = timingPriority(proposalTimings, pending, now);
      const hasPreviousTiming = referenceTimings.some(
        (timing) => timingRevisionNotice(timing)?.state === "previous",
      );
      if (!pending && !proposalTimings.length && hasPreviousTiming) {
        priority.rank = 4;
        priority.label = "変更後の日時を確認";
      }
      if (
        !proposalTimings.length &&
        sources.length &&
        sources.every((source) => source.intent.receipt) &&
        !hasPreviousTiming
      ) {
        priority.rank = 7;
        priority.label = "受付内容の確認";
        if (uncertainOlderRequest || chronology.uncertain) {
          priority.rank = 4;
          priority.label = "受付範囲・案内の確認が必要";
        }
      }
      return {
        ...group,
        suggestion,
        currentSources: sources.map(({ entry, suggestion }) => ({
          accountId: entry.accountId,
          messageId: entry.messageId,
          accountName: entry.accountName || entry.email,
          title: entry.title,
          receivedAt: entry.receivedAt,
          recency: chronology.labels.get(entry),
          suggestion,
        })),
        historyNotices,
        chronologyUncertain: chronology.uncertain,
        proposalTimings,
        referenceTimings,
        timingNotices: [...latestByAccount.values()]
          .filter((entry) => entry.timingNotice)
          .map((entry) => ({
            accountName: entry.accountName || entry.email,
            message: entry.timingNotice,
          })),
        timings,
        priority,
        latestAt: sorted[0].receivedAt || null,
        pending,
        // 宛先ごとの証跡・個別操作を維持する。古い案内を最新と同列に勧めない。
        entries: sorted.map((source) => {
          const { excerpt, from, timings, timingNotice, ...entry } = source;
          return {
            ...entry,
            recency: chronology.labels.get(source) || "登録結果の照合対象",
            excerpt: (excerpt || "").slice(0, 240),
          };
        }),
        accountCount: new Set(sorted.map((entry) => entry.accountId)).size,
      };
    })
    .sort(
      (a, b) =>
        a.priority.rank - b.priority.rank ||
        (a.priority.at ?? Infinity) - (b.priority.at ?? Infinity) ||
        (b.latestAt || "").localeCompare(a.latestAt || ""),
    );
}
