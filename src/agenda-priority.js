// 表示上の優先判定であり、送信者の本人性や安全性を保証しない。
export function mailPriority(message, body = message.excerpt || "") {
  const subject = (message.subject || "").normalize("NFKC");
  const from = message.from || "";
  const context = subject + "\n" + body.slice(0, 2000).normalize("NFKC");
  const school =
    /@[^\s>]+\.(?:ac\.jp|edu)(?:[>\s]|$)/i.test(from) ||
    /学校|大学|学生|成績|課題|試験|履修|授業|講義|教務|学務|休講|補講|奨学金|研究室|指導教員|ゼミ|学籍|卒業研究|学費|大学院/.test(
      subject,
    );
  const career =
    /就活|採用|選考|面接|面談|内定|エントリー|インターン|書類選考|適性検査|応募書類|応募受付|説明会/.test(
      subject,
    );
  const promotion =
    /メルマガ|ニュース|セール|キャンペーン|ランキング|おすすめ|新着求人|求人特集|スカウト|配信停止/.test(
      subject,
    );
  const action =
    /締切|締め切り|提出|要返信|ご返信|要確認|重要|日程確定|日程調整|面接|面談|選考結果|選考通過|内定|適性検査|履修|休講|補講|課題|レポート|試験|授業|講義|研究室|ゼミ/.test(
      context,
    );
  const category = career ? "career" : school ? "school" : "other";
  const important = category !== "other" && action && !promotion;
  return {
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
