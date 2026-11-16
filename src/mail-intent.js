// 保存済みの件名・本文抜粋だけから、提案に使う記載を判定する。実際の提出完了を認定しない。
const topicPatterns = [
  ["成績証明書", /成績証明/],
  ["卒業見込証明書", /卒業見込証明/],
  ["履歴書", /履歴書/],
  ["エントリーシート", /エントリーシート|\bES\b/i],
  ["顔写真", /顔写真|証明写真/],
  ["課題", /課題/],
  ["レポート", /レポート/],
];
export const submissionTopics = (text) =>
  topicPatterns
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
const receiptWords =
  /受領|受け付け|受付完了|登録完了|提出完了|提出済み|提出.{0,30}ありがとう/;
const negativeOrConditional =
  /場合|(?:提出済み|完了|受領).{0,20}(?:方|のみ|ボタン|クリック|選択|表示|手順|方法)|未提出|未受領|未完了|未受付|(?:提出|受領|受付).{0,16}(?:いません|いない|できません|できない|ておらず)|(?:完了|済み)(?:して)?いません|ですか|でしょうか|もし|仮に/;
const receiptDenied =
  /未(?:提出|受領|完了|受付)|(?:受領|受付|提出).{0,10}(?:していません|しておりません|されていません|されておりません|できていません|できておりません|できません|していない|しておらず)/;
const receiptFact =
  /(?:ご)?(?:提出|送付|アップロード)(?:を)?(?:いただき|頂き|くださり|下さり|いただいた).{0,24}(?:ありがとう|感謝)|(?:提出|送付|アップロード).{0,8}ありがとうございました|受領(?:いたしました|しました|しております|済み)|受け付け(?:ました|いたしました|ております)|受付(?:が|は)?完了(?:しました|いたしました|です)|提出(?:が|は)?完了(?:しました|いたしました|です)|提出済みです|(?:必要な)?書類.{0,24}(?:すべて|全て).{0,12}完了/;
const titleReceipt =
  /提出(?:いただき)?ありがとう|受領(?:のご連絡|のお知らせ|通知|完了)|受付完了|登録完了|提出完了|提出済み/;
const submissionRequest =
  /(?:ご)?提出(?:を)?(?:してください|お願い|依頼)|提出のお願い|提出をお願い|提出依頼|提出(?:期限|締切)|(?:アップロード|送付)(?:を)?(?:してください|お願い)|再提出|差し替え/;
const requestNegation =
  /(?:不要|必要ありません|必要はありません|必要はございません|しないで|しなくて|求めていません)/;
const freshRequest = /追加|改めて|再提出|差し替え|別途/;
const scheduleWords = /面接|面談|説明会|ミーティング|打ち合わせ|会議|授業|試験/;
const scheduleNext =
  /(?:面接|面談|説明会|会議|授業|試験).{0,16}(?:日程|日時|予定|案内|行います|実施|開催)|(?:面接|面談|説明会|会議|授業|試験).{0,30}\d{1,2}[月/.-]\d{1,2}|(?:日程|日時|次の選考).{0,24}(?:面接|面談|会議|説明会)|次の選考ステップ/;
const responseRequest =
  /(?:返信|回答|出欠).{0,20}(?:ください|お願い|必要|期限|締切)|要返信|ご返信ください/;

export function currentMailText(excerpt = "") {
  const lines = [];
  for (const raw of excerpt.slice(0, 1600).normalize("NFKC").split(/\r?\n/)) {
    const line = raw.trim();
    if (
      /^-{2,}\s*(?:Original Message|Forwarded message|転送|元のメッセージ)|^On .+wrote:|^.*さんは書きました[:：]|^(?:From|Sent|差出人|送信日時)\s*[:：]|^--$/i.test(
        line,
      )
    )
      break;
    if (!/^>/.test(line)) lines.push(raw);
  }
  return lines.join("\n");
}
function clauses(text) {
  return text
    .replace(/(ました|です)(?:が|ので)[、,]?\s*/g, "$1。")
    .split(/[。!?！？]+|\n\s*\n/)
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// 受付を伝える文の日時を、後続の面接・回答の日時と混ぜない。
export function receiptFollowUpBody(entry) {
  return currentMailText(entry.excerpt || "")
    .split(/\r?\n/)
    .flatMap(clauses)
    .filter(
      (clause) =>
        !receiptFact.test(clause) &&
        !/^(?:受付|受領|提出|登録)(?:完了)?(?:日|日時|時刻)\s*[:：]/.test(
          clause,
        ),
    )
    .join("\n");
}

export function analyzeMailIntent(entry) {
  const title = (entry.title || "").normalize("NFKC");
  const body = currentMailText(entry.excerpt || "");
  const bodyClauses = clauses(body);
  const receipts = bodyClauses.filter(
    (clause) =>
      receiptFact.test(clause) &&
      !negativeOrConditional.test(clause) &&
      !receiptDenied.test(clause),
  );
  const bodyNegative = bodyClauses.some((clause) => receiptDenied.test(clause));
  if (
    titleReceipt.test(title) &&
    !negativeOrConditional.test(title) &&
    !receiptDenied.test(title) &&
    !/方法|手順|ボタン|テンプレート|見本|予定|見込み|完了.{0,8}(?:まで|ため|条件)/.test(
      title,
    ) &&
    (!bodyNegative || receipts.length)
  )
    receipts.push(title);
  const receipt = receipts.length > 0;
  const receiptTopics = [...new Set(receipts.flatMap(submissionTopics))];
  const comprehensive = receipts.some((clause) =>
    /(?:すべて|全て).{0,12}完了/.test(clause),
  );
  const requests = clauses(title + "\n\n" + body).filter(
    (clause) =>
      submissionRequest.test(clause) &&
      !requestNegation.test(clause) &&
      !receiptFact.test(clause),
  );
  const remainingRequests = requests.filter((clause) => {
    if (!receipt) return true;
    if (freshRequest.test(clause)) return true;
    // 受付済みと明確に異なる提出物の依頼は、完了扱いにしない。
    const topics = submissionTopics(clause);
    if (
      topics.length > 0 &&
      receiptTopics.length > 0 &&
      topics.some((topic) => !receiptTopics.includes(topic))
    )
      return true;
    return (
      receiptTopics.length === 0 &&
      bodyClauses.includes(clause) &&
      /提出(?:を)?(?:してください|お願い|依頼)|提出のお願い/.test(clause)
    );
  });
  const schedule = receipt
    ? scheduleNext.test(title + "\n" + body)
    : scheduleWords.test(title + "\n" + body);
  const response =
    bodyClauses.some(
      (clause) => responseRequest.test(clause) && !requestNegation.test(clause),
    ) ||
    (!receipt && /返信|回答|出欠|アンケート/.test(title + "\n" + body));
  const mention = receiptWords.test(title + "\n" + body);
  return {
    receipt,
    receiptTopics,
    comprehensive,
    remainingRequests: remainingRequests.map((clause) => ({
      text: clause.slice(0, 200),
      topics: submissionTopics(clause),
    })),
    schedule,
    response,
    receiptMention: mention,
    submissionMention:
      /提出|アップロード|送付|締切|期限/.test(title + "\n" + body) &&
      /成績証明|履歴書|エントリーシート|提出書類|書類|課題|レポート/.test(
        title + "\n" + body,
      ),
    evidence: (receipts[0] || remainingRequests[0] || "").slice(0, 180),
    body,
    limited: !!entry.contentLimited,
  };
}

// 抽出済み日時の保存ID・本人確定値は変えず、提案の優先度に使う日時だけを選ぶ。
export function timingReferenceReason(timing, intent) {
  if (!intent.receipt || timing.manual) return "";
  if (timing.kind === "event" && intent.schedule) return "";
  if (
    /返信|回答|出欠/.test(timing.action + " " + timing.evidence) &&
    intent.response
  )
    return "";
  if (timing.kind === "deadline" && intent.remainingRequests.length) {
    const topics = submissionTopics(timing.evidence || "");
    if (
      !topics.length ||
      intent.remainingRequests.some((request) =>
        request.topics.some((topic) => topics.includes(topic)),
      )
    )
      return "";
  }
  return "受付・完了の記載がある案内の参考日時です。再提出の期限として優先しません。";
}
