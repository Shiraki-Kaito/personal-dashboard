import { normalizePriorityRules } from "./mail-priority-rules.js";
import { mailPriorityVersion } from "./agenda-priority.js";
import { InputError } from "./sync.js";
import { digest } from "./agenda-rules.js";
import { displayAccounts, validAccountLabel } from "./agenda-labels.js";

const maximumAccounts = 5,
  maximumOperations = 1000;
const mailId = /^[a-f0-9]{1,64}$/;
const manualId =
  /^manual-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const text = (value, limit) =>
  typeof value === "string" && value.length <= limit;
const date = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const pick = (value, keys) =>
  Object.fromEntries(
    keys.filter((k) => value?.[k] !== undefined).map((k) => [k, value[k]]),
  );
const cacheKeys = ["lastAttempt", "lastSuccess", "limited"];
const messageKeys = ["id", "subject", "from", "receivedAt", "excerpt"];
const operationKeys = [
  "eventId",
  "targetAccountId",
  "draft",
  "lastAttempt",
  "lastSuccess",
  "sourceType",
];
const namespaces = [
  "cache",
  "reviews",
  "pending",
  "manualHistory",
  "operation",
];

// 認証用キー・OAuth途中状態にはアクセスせず、アプリの保存情報だけを選ぶ。
export async function createAgendaBackup(storage) {
  const accounts = await displayAccounts(storage);
  const result = [];
  for (const account of accounts) {
    const cache = await storage.get("agenda:cache:" + account.id);
    const operations = await storage.list({
      prefix: "agenda:operation:" + account.id + ":",
    });
    if (operations.size > maximumOperations)
      throw new InputError(
        "予定の操作記録がバックアップ上限1000件を超えています",
      );
    result.push({
      account: pick(account, ["id", "email", "calendar", "label"]),
      priorityRules: (await storage.get("agenda:priorityRules:" + account.id))
        ?.rules,
      cache: cache
        ? {
            ...pick(cache, cacheKeys),
            hasMore: !!cache.nextPageToken || !!cache.limited,
            messages: cache.messages.map((message) => ({
              ...pick(message, messageKeys),
              ...(message.priority
                ? {
                    priority: pick(message.priority, [
                      "version",
                      "category",
                      "important",
                      "reason",
                    ]),
                  }
                : {}),
              // 抜粋から再抽出すると元の全文による判定を変えてしまうため保持する。
              candidate: pick(message.candidate, [
                "title",
                "start",
                "end",
                "location",
                "reasons",
                "status",
                "isCandidate",
              ]),
            })),
          }
        : null,
      reviews: Object.fromEntries(
        Object.entries(
          (await storage.get("agenda:reviews:" + account.id)) || {},
        ).map(([id, review]) => [id, pick(review, ["reviewedAt"])]),
      ),
      pending: (await storage.get("agenda:pending:" + account.id)) || [],
      manualHistory:
        (await storage.get("agenda:manualHistory:" + account.id)) || [],
      operations: [...operations].map(([key, value]) => ({
        messageId: key.slice(("agenda:operation:" + account.id + ":").length),
        ...pick(value, operationKeys),
        draft: pick(value.draft, ["title", "start", "end", "location"]),
      })),
    });
  }
  return result;
}
function requireValid(valid) {
  if (!valid)
    throw new InputError("メール・予定バックアップの形式・関連付けが不正です");
}
function validCandidate(value) {
  return (
    value &&
    text(value.title, 300) &&
    text(value.start, 16) &&
    text(value.end, 16) &&
    text(value.location, 300) &&
    text(value.status, 100) &&
    (value.isCandidate === undefined ||
      typeof value.isCandidate === "boolean") &&
    Array.isArray(value.reasons) &&
    value.reasons.length <= 20 &&
    value.reasons.every((v) => text(v, 300))
  );
}

// 同じOAuth確認済みアカウントを先に接続する。資格情報や接続状態は復元しない。
export async function agendaRestoreEntries(storage, backup) {
  requireValid(Array.isArray(backup) && backup.length <= maximumAccounts);
  const connected = (await storage.get("agenda:accounts")) || [];
  const entries = new Map(),
    conflicts = [],
    ids = new Set();
  for (const item of backup) {
    const account = item?.account;
    requireValid(
      account &&
        /^[a-f0-9]{64}$/.test(account.id) &&
        text(account.email, 254) &&
        account.email === account.email.toLowerCase() &&
        account.id === (await digest(account.email)) &&
        account.calendar === "primary" &&
        !ids.has(account.id),
    );
    ids.add(account.id);
    requireValid(
      account.label === undefined || validAccountLabel(account.label),
    );
    if (item.priorityRules !== undefined) {
      const rules = normalizePriorityRules(item.priorityRules);
      entries.set("agenda:priorityRules:" + account.id, {
        rules,
        revision: crypto.randomUUID(),
      });
    }
    if (account.label) {
      const key = "agenda:label:" + account.id,
        existing = await storage.get(key);
      if (existing === undefined || existing === "")
        entries.set(key, account.label);
      else if (existing !== account.label) conflicts.push(key);
    }
    if (
      !connected.some(
        (a) =>
          a.id === account.id &&
          a.email === account.email &&
          a.calendar === account.calendar,
      )
    )
      throw new InputError(
        "復元するメール・予定と同じGoogleアカウントを先に接続してください",
      );
    for (const name of namespaces) {
      const key = "agenda:" + name + ":" + account.id;
      if (name === "operation") {
        if ((await storage.list({ prefix: key + ":" })).size)
          conflicts.push(key);
      } else if ((await storage.get(key)) !== undefined) conflicts.push(key);
    }
    requireValid(
      Array.isArray(item.operations) &&
        item.operations.length <= maximumOperations &&
        item.reviews &&
        typeof item.reviews === "object" &&
        !Array.isArray(item.reviews) &&
        Object.keys(item.reviews).length <= 5000,
    );
    const operations = new Map();
    for (const operation of item.operations) {
      const id = operation?.messageId,
        draft = operation?.draft;
      requireValid(
        operation &&
          (mailId.test(id) || manualId.test(id)) &&
          !operations.has(id) &&
          operation.sourceType === (manualId.test(id) ? "manual" : "mail") &&
          backup.some((a) => a.account?.id === operation.targetAccountId) &&
          operation.eventId ===
            "pd" + (await digest({ source: account.id, message: id })) &&
          draft &&
          text(draft.title, 300) &&
          draft.title.trim() &&
          text(draft.location, 500) &&
          date(draft.start) &&
          date(draft.end) &&
          Date.parse(draft.end) > Date.parse(draft.start) &&
          Date.parse(draft.end) - Date.parse(draft.start) <= 7 * 86400000 &&
          (!operation.lastSuccess || date(operation.lastSuccess)) &&
          (!operation.lastAttempt || date(operation.lastAttempt)),
      );
      operations.set(id, operation);
      entries.set("agenda:operation:" + account.id + ":" + id, {
        ...pick(operation, operationKeys),
        draft: pick(draft, ["title", "start", "end", "location"]),
        phase: "バックアップから復元・再照合待ち",
        error: "Googleから登録結果を照合してください。予定は再送していません",
        calendarUrl: null,
      });
    }
    for (const [name, list] of [
      ["pending", item.pending],
      ["manualHistory", item.manualHistory],
    ]) {
      requireValid(
        Array.isArray(list) &&
          list.length <= (name === "pending" ? maximumOperations : 100) &&
          new Set(list).size === list.length &&
          list.every(
            (id) =>
              operations.has(id) &&
              (name !== "manualHistory" || manualId.test(id)),
          ),
      );
      entries.set("agenda:" + name + ":" + account.id, [...list]);
    }
    // 登録成功記録も古いバックアップでは変更・削除されている可能性がある。
    // 全記録を再照合対象にし、失われたメールの操作も一覧から到達できるようにする。
    entries.set("agenda:pending:" + account.id, [...operations.keys()]);
    const reviews = {};
    for (const [id, review] of Object.entries(item.reviews)) {
      requireValid(mailId.test(id) && date(review?.reviewedAt));
      reviews[id] = { reviewedAt: review.reviewedAt };
    }
    entries.set("agenda:reviews:" + account.id, reviews);
    if (item.cache !== null) {
      const cache = item.cache;
      requireValid(
        cache &&
          Array.isArray(cache.messages) &&
          cache.messages.length <= 100 &&
          typeof cache.hasMore === "boolean" &&
          (!cache.lastSuccess || date(cache.lastSuccess)) &&
          (!cache.lastAttempt || date(cache.lastAttempt)),
      );
      const seen = new Set();
      const messages = cache.messages.map((message) => {
        requireValid(
          message &&
            mailId.test(message.id) &&
            !seen.has(message.id) &&
            text(message.subject, 300) &&
            text(message.from, 300) &&
            text(message.excerpt, 1600) &&
            date(message.receivedAt) &&
            validCandidate(message.candidate),
        );
        requireValid(
          message.priority === undefined ||
            (["career", "school", "other"].includes(
              message.priority?.category,
            ) &&
              typeof message.priority.important === "boolean" &&
              (message.priority.version === undefined ||
                (Number.isInteger(message.priority.version) &&
                  message.priority.version > 0 &&
                  message.priority.version <= mailPriorityVersion)) &&
              text(message.priority.reason, 200)),
        );
        seen.add(message.id);
        return {
          ...pick(message, messageKeys),
          ...(message.priority
            ? {
                priority: pick(message.priority, [
                  "version",
                  "category",
                  "important",
                  "reason",
                ]),
              }
            : {}),
          candidate: pick(message.candidate, [
            "title",
            "start",
            "end",
            "location",
            "reasons",
            "status",
            "isCandidate",
          ]),
          url:
            "https://mail.google.com/mail/u/" +
            encodeURIComponent(account.email) +
            "/#all/" +
            message.id,
        };
      });
      entries.set("agenda:cache:" + account.id, {
        ...pick(cache, cacheKeys),
        messages,
        limited: cache.hasMore,
        nextPageToken: null,
        retryAt: null,
        error:
          "バックアップから復元・メール再取得待ち。続きは先頭から取得し直してください",
        errorCode: "restored",
      });
    }
  }
  return { entries, conflicts };
}
