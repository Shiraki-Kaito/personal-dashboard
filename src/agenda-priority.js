export const mailPriorityVersion = 2;
// 表示上の優先判定であり、送信者の本人性や安全性を保証しない。
export function mailPriority(message, body = message.excerpt || "") {
  const subject = (message.subject || "").normalize("NFKC");
  const from = message.from || "";
  const context = subject + "\n" + body.slice(0, 2000).normalize("NFKC");
  const school =
    /@[^\s>]+\.(?:ac\.jp|edu)(?:[>\s]|$)/i.test(from) ||
    /学校|大学|学生証|学生課|成績|課題(?:の(?:提出|締切)|提出)|レポート(?:の)?(?:提出|締切)|試験|履修|授業|講義|教務|学務|休講|補講|奨学金|研究室|指導教員|ゼミ|学籍|卒業研究|学費/.test(
      subject,
    );
  const career =
    /就活|採用|選考|面接|面談|内定|エントリー|インターン|書類選考|適性検査|応募書類|応募受付|説明会/.test(
      subject,
    );
  const promotion =
    /メルマガ|ニュース|セール|キャンペーン|ランキング|おすすめ|新着求人|特集|スカウト|配信停止|セミナー|ガクチカ|対策|キャリアアドバイザー|実施中|受付中|募集中|求人情報|企業紹介|業界研究|就活準備|職種選び|企業選び|選択肢|まずはここ|面談.{0,8}ご案内/.test(
      subject,
    );
  // 一般募集の「締切」と、本人が進めた手続の連絡を分ける。
  // 本文の配信停止フッターだけを理由に、個別の提出依頼を除外しない。
  const transaction =
    /日程確定|日程調整|選考結果|選考通過|合否|内定通知|内定(?:承諾|手続)|予約(?:完了|確定|確認)|参加(?:確定|確認)|(?:ご提出|ご応募|エントリーシート|お申(?:し)?込(?:み)?).{0,20}(?:ありがとうございます|受領|受付完了|確認しました)|提出(?:依頼|のお願い)|ご提出のお願い/.test(
      subject,
    );
  const action =
    /締切|締め切り|提出|要返信|ご返信|要確認|重要|日程確定|日程調整|面接|面談|選考結果|選考通過|内定|適性検査|履修|休講|補講|課題|レポート|試験|授業|講義|研究室|ゼミ/.test(
      context,
    );
  const category = career ? "career" : school ? "school" : "other";
  const important =
    category !== "other" && (transaction || (action && !promotion));
  return {
    version: mailPriorityVersion,
    category,
    important,
    reason: important
      ? category === "school"
        ? "学校関係・対応事項の語句"
        : "就活関係・選考や対応事項の語句"
      : promotion
        ? "案内・宣伝の語句（その他に表示）"
        : category === "other"
          ? "就活・学校の重要条件に未一致"
          : "関係する案内（その他に表示）",
  };
}

// 全文で取得した現行判定を保持し、旧判定だけは取得済み抜粋で更新する。
// 確認記録や予定候補は変更せず、元メールの追加取得も行わない。
export function currentMailPriority(message) {
  if (message.priority?.version === mailPriorityVersion)
    return message.priority;
  const priority = mailPriority(message);
  return { ...priority, reason: priority.reason + "（保存済み抜粋で再判定）" };
}
