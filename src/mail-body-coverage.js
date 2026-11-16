// 抜粋の互換性を保ち、日時確認用の追加テキストだけを有界に保存する。
export const maximumTimingTextCharacters = 6000;
// 既存のページ処理・保存一覧に付加する本文量のアプリ側上限。サービスの上限ではない。
export const maximumPageTimingBytes = 32 * 1024;
export const maximumCachedTimingBytes = 256 * 1024;

export function limitTimingText(messages, budget = maximumCachedTimingBytes) {
  let remaining = budget;
  const accepted = new Set();
  // 容量が足りない場合は重要メールを優先し、一覧自体の並び・件数は変えない。
  const prioritized = [...messages].sort((a, b) =>
    Number(b.priority?.important === true) - Number(a.priority?.important === true),
  );
  for (const message of prioritized) {
    if (!message.timingText) continue;
    const bytes = new TextEncoder().encode(message.timingText).length;
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
    ["complete", "partial", "unavailable", "capacity"].includes(message.bodyCoverage)) &&
    (message.timingText === undefined ||
      (typeof message.timingText === "string" &&
        message.timingText.length <= maximumTimingTextCharacters &&
        message.timingText.startsWith(message.excerpt) &&
        ["complete", "partial"].includes(message.bodyCoverage)));
}

export function mailBodyNotice(message) {
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
