import { digest } from "./agenda-rules.js";
import { InputError } from "./sync.js";
export const standardMailQuery = "newer_than:14d -in:trash -in:spam";
export const maximumLaneMessages = 100;
export const maximumMailMessages = 200;
const maximumEncodedQueryLength = 7000;
const searchFreshnessMs = 90 * 60 * 1000;
// Gmail検索は候補を増やすための広い検索で、アプリ内の部分文字列判定とは別の契約。
const searchSubjects = [
  "就活",
  "採用",
  "選考",
  "面接",
  "面談",
  "内定",
  "エントリー",
  "インターン",
  "適性検査",
  "応募",
  "説明会",
  "学校",
  "大学",
  "学生証",
  "学生課",
  "成績",
  "課題",
  "レポート",
  "試験",
  "履修",
  "授業",
  "講義",
  "教務",
  "学務",
  "休講",
  "補講",
  "奨学金",
  "研究室",
  "指導教員",
  "ゼミ",
  "学籍",
  "卒業研究",
  "学費",
];
export async function prioritySearchPlan(rules = {}) {
  const terms = [
    "is:important",
    "from:ac.jp",
    "from:edu",
    ...searchSubjects.map((word) => 'subject:"' + word + '"'),
  ];
  let omittedTerms = 0;
  const candidates = [
    ...(rules.prioritySenders || []).map((value) => ({
      value,
      term: 'from:"' + value.replace(/^@/, "") + '"',
    })),
    ...(rules.priorityKeywords || []).map((value) => ({
      value,
      term: '"' + value + '"',
    })),
  ];
  const queryFor = (list) => standardMailQuery + " {" + list.join(" ") + "}";
  for (const { value, term } of candidates) {
    // 検索演算子を入力値から実行しない。変換できない指定は明示し、元の判定設定は維持する。
    if (
      !/^[\p{L}\p{N} ._+@-]+$/u.test(value) ||
      new URLSearchParams({ q: queryFor([...terms, term]) }).toString().length >
        maximumEncodedQueryLength
    ) {
      omittedTerms++;
      continue;
    }
    terms.push(term);
  }
  const query = queryFor(terms);
  return {
    query,
    omittedTerms,
    queryHash: await digest({
      version: 1,
      query,
      senders: rules.prioritySenders || [],
      words: rules.priorityKeywords || [],
    }),
  };
}
export function standardMessages(cache) {
  if (!cache.standardIds) return cache.messages || [];
  const ids = new Set(cache.standardIds);
  return (cache.messages || []).filter((message) => ids.has(message.id));
}
export function priorityMessages(cache) {
  const ids = new Set(cache.priorityIds || []);
  return (cache.messages || []).filter((message) => ids.has(message.id));
}
export function mergeMailLanes(standard, priority) {
  const messages = new Map(priority.map((message) => [message.id, message]));
  for (const message of standard) messages.set(message.id, message);
  return [...messages.values()].sort(
    (a, b) =>
      b.receivedAt.localeCompare(a.receivedAt) || a.id.localeCompare(b.id),
  );
}
export function mailRetrievalView(cache, plan, now = Date.now()) {
  const standardCount = standardMessages(cache).length;
  const snapshot = cache.retrieval;
  const needed = !!cache.nextPageToken || !!cache.limited;
  const current =
    !!snapshot &&
    (!needed ||
      (snapshot.priority?.queryHash === plan.queryHash &&
        now - Date.parse(snapshot.completedAt) <= searchFreshnessMs));
  let notice = "";
  if (needed && !current)
    notice =
      "重要候補の補完が未取得、または検索条件が変わりました。「全接続のメールを取得」で更新してください";
  else if (needed && snapshot?.priority?.hasMore)
    notice =
      "重要候補の補完も100件上限に達しました。検索結果の続きはGmailで確認してください";
  if (plan.omittedTerms)
    notice +=
      (notice ? " ／ " : "") +
      "優先設定のうち" +
      plan.omittedTerms +
      "件は検索へ安全に変換できません。Gmailの原文検索でも確認してください";
  return {
    standardCount,
    priorityCount: priorityMessages(cache).length,
    extraCount: snapshot?.priority?.extraCount || 0,
    standardHasMore: needed,
    priorityHasMore: !!snapshot?.priority?.hasMore,
    current,
    notice,
    completedAt: snapshot?.completedAt || null,
    query: plan.query,
    omittedTerms: plan.omittedTerms,
  };
}
// バックアップ境界で、任意の識別子・検索状態や秘密値を取り込まない。
export function retrievalBackupFields(cache) {
  if (!cache.retrieval && !cache.standardIds && !cache.priorityIds) return {};
  const ids = new Set((cache.messages || []).map((message) => message.id));
  const validIds = (value) =>
    Array.isArray(value) &&
    value.length <= maximumLaneMessages &&
    new Set(value).size === value.length &&
    value.every((id) => typeof id === "string" && ids.has(id));
  const r = cache.retrieval;
  const validLane = (lane) =>
    lane &&
    Number.isInteger(lane.count) &&
    lane.count >= 0 &&
    lane.count <= 100 &&
    Number.isInteger(lane.pages) &&
    lane.pages >= 0 &&
    lane.pages <= 5 &&
    typeof lane.hasMore === "boolean";
  if (
    !validIds(cache.standardIds) ||
    !validIds(cache.priorityIds) ||
    new Set([...cache.standardIds, ...cache.priorityIds]).size !== ids.size ||
    !r ||
    r.version !== 1 ||
    !Number.isFinite(Date.parse(r.completedAt)) ||
    !validLane(r.standard) ||
    (r.priority !== null &&
      (!validLane(r.priority) ||
        !/^[a-f0-9]{64}$/.test(r.priority.queryHash) ||
        !Number.isInteger(r.priority.omittedTerms) ||
        r.priority.omittedTerms < 0 ||
        r.priority.omittedTerms > 40 ||
        !Number.isInteger(r.priority.extraCount) ||
        r.priority.extraCount < 0 ||
        r.priority.extraCount > 100))
  )
    throw new InputError("メールの取得範囲情報が不正です");
  if (
    r.standard.count !== cache.standardIds.length ||
    (r.priority?.count || 0) !== cache.priorityIds.length ||
    (r.priority?.extraCount || 0) !==
      cache.priorityIds.filter((id) => !cache.standardIds.includes(id)).length
  )
    throw new InputError("メールの取得件数が一致しません");
  const pick = (lane) => ({
    count: lane.count,
    pages: lane.pages,
    hasMore: lane.hasMore,
  });
  return {
    standardIds: [...cache.standardIds],
    priorityIds: [...cache.priorityIds],
    retrieval: {
      version: 1,
      completedAt: r.completedAt,
      standard: pick(r.standard),
      priority: r.priority
        ? {
            ...pick(r.priority),
            queryHash: r.priority.queryHash,
            omittedTerms: r.priority.omittedTerms,
            extraCount: r.priority.extraCount,
          }
        : null,
    },
  };
}
