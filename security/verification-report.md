# 検証記録（候補版）

2026-11-26 JST。基点837ba16、今回のsecurityブランチの差分が対象。本番最新はa0bb5ab8-f10f-47c2-93d3-c8881772a99dのまま。今回は本番変更なし。

- Node24.22.3（公式zip SHA256照合）、Windows PowerShell。
- `npm test`: 全416件成功。架空データ/模擬外部API＋Miniflare SQLiteで正常系・本人/別人/未認証・Origin・スコープ・同時実行・再起動/復元を確認。
- 追加：JSON実バイト上限/宣言値偽装/不正UTF8/配列/遅い受信、試行上限と回復/保存障害、送信元分離/Forwarded偽装、OAuth期限/state/単回使用、アイドル/絶対期限/失効世代、IdP失効/別人/障害/正常再照合、Host由来の異なるorigin拒否、lockdown時ログイン/API拒否、監査の件数/期間/秘密除外。
- `npm run build`: 成功。`node scripts/security-static.mjs`:104ファイル構文＋限定動的実行sink検査成功。専用TS型チェックはJSプロジェクトのためなし。全経路の汚染解析を完了したとはしない。
- `npm audit --json`: 開始時・確定時とも検出0。依存一覧と版/出典は別資料。
- `python scripts/security-scan.py`: 履歴＋現在の対象1082件、限定ルール検出0。Gitleaks8.30.1、全マスクでGit履歴を検査しexit0/検出0。秘密の実値を証拠へ含めない。
- 公開README画像4件を目視。報告画像に実名を検出して現行画像を削除。報告者初期値とテスト実名も架空化。以前のGit履歴は残る。認証秘密漏えいの検出とは区別。
- Windows: 現在のソースを別出力先へコンパイル成功。URL/境界等20項目成功後、`switching away keeps other application active`で失敗。既存Windowsのバイナリ・設定を変更せず、検査も無効化していない。Web検証の成功と混同しない。
- 認証付き動的試験はローカルMiniflareのHTTP試験。実サービスに対する攻撃/負荷試験なし。包括的な独立DAST/SASTは未完了。
- CI設定は公式actionsのSHA固定、contents:read、本番secretなし。リモート実行結果は追記するまで未確認。

## 完了区分

コード：上記の対策を実装。全体要件は未完了。
検証環境：Web416件・ビルド・限定静的/秘密検査成功。Windows失敗1件あり。
本番反映・本番確認：今回候補は未実施。依頼書のリリース停止条件（管理者MFA等）に従う。
ASVS：L1/L2全253行の正式IDと対象判定を収録、個別未検証を残す。L2準拠と表現しない。

## GitHub CIの実測結果

コードcommit 4e5849aを対象に、GitHub Actions run 45775557264は全段階success。npm ci、audit、416件テスト、build、限定静的検査、履歴秘密検査、Gitleaksが成功。
https://github.com/Shiraki-Kaito/personal-dashboard/actions/runs/45775557264

本番へのデプロイ・mainへのマージは実行していない。

## 優先対策の追加（2026-11-26）

監視・通知制御、端末内暗号化バックアップを追加。最終425件成功、build成功。詳細と未確認範囲は[monitoring-backup.md](monitoring-backup.md)。管理者認証は本人から設定完了申告あり。送信元ドメインがなく実通知は未送信。本番未反映を継続。
