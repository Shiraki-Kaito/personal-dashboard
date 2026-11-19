// 抜粋の互換性を保ち、日時確認用の追加テキストだけを有界に保存する。
export const maximumTimingTextCharacters = 6000;
// 既存のページ処理・保存一覧に付加する本文量のアプリ側上限。サービスの上限ではない。
export const maximumCachedTimingBytes = 256 * 1024;

export function limitTimingText(messages, budget = maximumCachedTimingBytes) {
  let remaining = budget;
  const accepted = new Set();
  // 容量が足りない場合は重要メールを優先し、一覧自体の並び・件数は変えない。
  const prioritized = [...messages].sort((a, b) =>
    Number(b.bodyRetention === "protected") - Number(a.bodyRetention === "protected") ||
    Number(b.bodyRetention === "important" || b.priority?.important === true) - Number(a.bodyRetention === "important" || a.priority?.important === true),
  );
  for (const message of prioritized) {
    if (!message.timingText) continue;
    const bytes = new TextEncoder().encode(message.timingText).length;
    if (message.bodyRetention === "protected" && bytes > remaining)
      throw new Error("保護対象の本文が保存上限を超えました。前回の一覧を保持します");
    if (bytes <= remaining) {
      remaining -= bytes;
      accepted.add(message);
    }
  }
  return messages.map((message) => {
    if (!message.timingText || accepted.has(message)) return message;
    const { timingText, ...retained } = message;
    return { ...retained, bodyCoverage: "capacity", contentLimited: true };
  });
}

export function validBodyCoverage(message) {
  return (message.bodyCoverage === undefined ||
    ["complete", "partial", "unavailable", "capacity", "excluded"].includes(message.bodyCoverage)) &&
    (message.keepBody === undefined || typeof message.keepBody === "boolean") &&
    (message.bodyRetrievedAt === undefined || (typeof message.bodyRetrievedAt === "string" && Number.isFinite(Date.parse(message.bodyRetrievedAt)))) &&
    (message.bodyCoverage !== "excluded" || message.keepBody !== true) &&
    (message.bodyRetention === undefined || ["important", "protected", "excluded"].includes(message.bodyRetention)) &&
    (message.bodyCoverage !== "excluded" || (message.excerpt === "" && message.timingText === undefined)) &&
    (message.timingText === undefined ||
      (typeof message.timingText === "string" &&
        message.timingText.length <= maximumTimingTextCharacters &&
        message.timingText.startsWith(message.excerpt) &&
        ["complete", "partial"].includes(message.bodyCoverage)));
}

export function mailBodyNotice(message) {
  if (message.bodyCoverage === "excluded")
    return "重要条件に未一致のため本文をアプリに保存していません。Gmailの原文は削除していません。必要なメールは「このメールを重要として本文を再取得」で個別に保存できます。";
  if (message.bodyCoverage === "unavailable")
    return (message.excerpt ? "本文を取得できず、Gmailの短い抜粋だけを使用しています。" : "本文・抜粋を取得できていません。") + "原文・添付・リンク先の日時は確認できていません。Gmailで確認してください。";
  if (message.bodyCoverage === "capacity")
    return "日時確認用の追加本文は保存容量の上限で保持できませんでした。先頭1,600文字より後の日時は確認できていません。Gmailで確認してください。";
  if (message.bodyCoverage === "partial")
    return "本文の一部だけを取得・解析しています。日時確認は最大6,000文字で、それより後・本文参照・添付・リンク先の日時は確認できていません。Gmailで確認してください。";
  if (message.timingText)
    return "本文表示・提案分類は先頭1,600文字、日時確認は最大6,000文字の追加範囲も使用します。原文のレイアウト・添付・リンク先は未確認です。";
  if (message.contentLimited || (!message.bodyCoverage && (message.excerpt || "").length >= 1600))
    return "保存済み本文は先頭1,600文字までで、原文全体を確認できていません。メールを再取得するか、Gmailで日時を確認してください。";
  return "";
}

// 接続の失敗と、保存・解析する本文の範囲を区別する。
export function mailBodySummary(messages) {
  const counts = { unavailable: 0, partial: 0, capacity: 0, legacy: 0, extended: 0, excluded: 0 };
  for (const message of messages) {
    if (["unavailable", "partial", "capacity", "excluded"].includes(message.bodyCoverage)) counts[message.bodyCoverage]++;
    else if (message.bodyCoverage === "complete" && message.timingText) counts.extended++;
    else if (mailBodyNotice(message)) counts.legacy++;
  }
  const parts = [];
  if (counts.partial) parts.push(`本文の取得・解析範囲が一部のメール ${counts.partial}件（最大6,000文字）`);
  if (counts.capacity) parts.push(`容量上限で追加本文を保持できないメール ${counts.capacity}件`);
  if (counts.legacy) parts.push(`保存済み抜粋だけで確認しているメール ${counts.legacy}件`);
  if (counts.extended) parts.push(`日時確認に追加本文を使用したメール ${counts.extended}件（本文表示・提案分類は先頭1,600文字）`);
  if (counts.excluded) parts.push(`重要条件に未一致のため本文を保存しないメール ${counts.excluded}件（件名・リンクは「その他」、Gmailの原文は保持）`);
  return { ...counts, notice: parts.length ? parts.join("。") + "。原文のレイアウト・添付・リンク先は未確認です。必要な日時はGmailの原文で確認してください。" : "" };
}
