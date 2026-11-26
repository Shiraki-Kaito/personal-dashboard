# 正式一覧の出典
OWASP ASVS 5.0.0、公式タグの英語CSVを2026-11-26に取得。
https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/docs_en/OWASP_Application_Security_Verification_Standard_5.0.0_en.csv
原文の権利・ライセンスはOWASP ASVSプロジェクトに帰属し、公式配布条件に従う。
https://github.com/OWASP/ASVS/tree/v5.0.0
原文CSVのSHA256: 98c8fe911b9edb403af8ee05d3ce8201ecac2659e313b053890a62847cdcf680

L1/L2の全要件をasvs-l2-matrix.csvに収録。未検証を合格にせず、版付きIDと証拠を管理する。構成上非該当でも外部IdPのMFA等は別の対象項目として残す。これらはASVS L2準拠の証明ではない。

原文CSVは取得時ハッシュを維持してローカル参照し、リポジトリには含めない。派生一覧asvs-l2-matrix.csvはOWASP ASVS 5.0.0を基にL1/L2抽出・本アプリの判定列を追加したもの。同ファイルはCC BY-SA 4.0で提供する（他のコードのライセンスは変更しない）。原作者：OWASP ASVS contributors。無保証。https://creativecommons.org/licenses/by-sa/4.0/
