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
function suggestionSummary(entry) {
  if (entry.kind === "pending")
    return {
      title: "予定の登録結果を確認しませんか？",
      reason:
        "登録結果が未確認です。重複を避けるため、再登録より先に結果を照合してください。",
      category: "結果未確認",
    };
  const text = (entry.title + "\n" + (entry.excerpt || "")).normalize("NFKC");
  // 受付通知から再提出を勧めない。引用・署名の判定を避け、まず件名の明確な受領表現を見る。
  if (
    /提出ありがとう|提出いただきありがとう|受領|受付完了|登録完了|提出完了/.test(
      entry.title,
    )
  )
    return {
      title: "受付内容と、残っている手続きを確認しませんか？",
      reason:
        "受付・完了を示す件名です。他の宛先や手続きまで完了したとは判断していません。",
      category: "受付の確認",
    };
  if (
    /成績証明|履歴書|エントリーシート|提出書類|課題|レポート/.test(text) &&
    /提出|アップロード|送付|締切|期限/.test(text)
  )
    return {
      title: "提出が必要な書類と期限を確認しませんか？",
      reason:
        "書類・課題と提出に関する記載があります。最新の案内で対象書類と締切を確認してください。",
      category: "提出の確認",
    };
  if (/面接|面談|説明会|ミーティング|打ち合わせ|授業|試験/.test(text))
    return {
      title: "日程を確認して、予定と照らし合わせませんか？",
      reason:
        "面接・会議などの日程に関する記載があります。日時が曖昧な場合も元メールから確認できます。",
      category: "日程の確認",
    };
  if (/返信|回答|出欠|アンケート|承認|確認してください|ご確認/.test(text))
    return {
      title: "回答や確認が必要か、見ておきませんか？",
      reason:
        "返信・回答・確認を求める語句があります。対応が必要かを元メールで判断してください。",
      category: "回答の確認",
    };
  return {
    title: "この連絡で、次にすることを確認しませんか？",
    reason:
      "重要メールとして抽出されています。具体的な対応を断定できないため、元の案内を確認してください。",
    category: "内容の確認",
  };
}
export function mailSuggestion(entry) {
  const suggestion = suggestionSummary(entry);
  const text = (entry.title + "\n" + (entry.excerpt || "")).normalize("NFKC");
  const checks = [];
  if (suggestion.category === "結果未確認")
    checks.push("登録結果を照合し、重複登録を避ける");
  else if (suggestion.category === "受付の確認")
    checks.push("宛先ごとの受付内容と、残っている手続きを確認する");
  else {
    if (
      /成績証明|履歴書|エントリーシート|提出書類|課題|レポート/.test(text) &&
      /提出|アップロード|送付|締切|期限/.test(text)
    )
      checks.push("提出する書類・提出先・締切を元の案内で確認する");
    if (/面接|面談|説明会|ミーティング|打ち合わせ|授業|試験/.test(text))
      checks.push("日時を確かめ、接続したアカウントの予定と照合する");
    if (/返信|回答|出欠|アンケート/.test(text))
      checks.push("返信・回答が必要かを確認する");
  }
  return { ...suggestion, checks };
}
export function groupMailSuggestions(entries) {
  const groups = new Map();
  // 未確定操作を他メールへ吸収せず、必ず独立した復旧案として残す。
  for (const entry of entries) {
    const company = organization(entry.title);
    const sender = senderAddress(entry.from);
    const year = (entry.title.match(/20\d{2}(?:年度|年卒|卒)/) || [""])[0];
    const key =
      entry.kind === "pending"
        ? JSON.stringify(["pending", entry.accountId, entry.messageId])
        : company
          ? JSON.stringify(["organization", normalize(company), year])
          : JSON.stringify([
              "subject",
              subjectKey(entry.title),
              sender || entry.accountId,
            ]);
    if (!groups.has(key))
      groups.set(key, {
        label: company || entry.title,
        basis: company
          ? "件名に同じ組織名がある関連候補"
          : "同じ件名と送信者の関連候補",
        entries: [],
      });
    groups.get(key).entries.push(entry);
  }
  return [...groups.values()]
    .map((group) => {
      const sorted = [...group.entries].sort((a, b) =>
        (b.receivedAt || "").localeCompare(a.receivedAt || ""),
      );
      return {
        ...group,
        suggestion: mailSuggestion(sorted[0]),
        latestAt: sorted[0].receivedAt || null,
        pending: sorted[0].kind === "pending",
        // 宛先ごとの証跡・個別操作を維持する。古い案内を最新と同列に勧めない。
        entries: sorted.map(({ excerpt, from, ...entry }) => ({
          ...entry,
          excerpt: (excerpt || "").slice(0, 240),
        })),
        accountCount: new Set(sorted.map((entry) => entry.accountId)).size,
      };
    })
    .sort(
      (a, b) =>
        Number(b.pending) - Number(a.pending) ||
        (b.latestAt || "").localeCompare(a.latestAt || ""),
    );
}
