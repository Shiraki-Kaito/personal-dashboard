# 運用手順（候補版・本番未適用）

責任者はアプリ所有者。作業者はコード・試験を記録し、アカウント本人確認・回復コードは扱わない。

## 管理者本人の設定が必要な箇所

1. GitHub: Settings → Password and authentication → Passkeys → Add a passkey。Windows Hello等の利用者検証を伴う方法で本人が登録し、別ブラウザーで実ログインを確認する。予備の認証手段・回復方法を安全に保管。名称だけでは完了としない。
   https://docs.github.com/en/authentication/authenticating-with-a-passkey/managing-your-passkeys
2. Cloudflare: My Profile → Authentication → Security Key Authentication。本人確認後にWindows Hello/セキュリティキーを登録。メール確認済みであること、予備手段とバックアップコードの保管を確認する。実値はチャット・Gitに残さない。
   https://developers.cloudflare.com/fundamentals/user-profiles/2fa/
3. 通知先を本人が指定してから、認証拒否急増・バックアップ失敗・費用警告を検証用イベントで実到達確認する。通知先なしでこちらからメールやSlackは送らない。有料契約はしない。

GitHub OAuthの本人APIは、ログインに使った要素/利用者検証をこのアプリへ証明しない。IdP側の回復方式も含む確認をP1として残す。別認証基盤を勝手に新設しない。

## 暫定制限と可用性

- API JSON: 10MiB、受信10秒。既存8MiBバックアップとJSONラップの余裕。OAuth追加接続の本文は16KiB。
- ログイン: Cloudflare付与の送信元単位5回/分、全体60回/分。sourceはSHA256化し、最大128区分。X-Forwarded-Forは信用しない。IPハッシュも匿名情報とは見なさず、期限1分・毎時掃除（停止時を除き最大約1時間残る）。
- 本人API: 120回/分。DOの共有状態・直列化で計数。429は60秒後に再試行。制限基盤失敗は503。適正負荷の実測は未完了のため値は暫定。
- セッション: 最大12時間、API無通信30分。画面の自動取得も通信として扱う。外部GitHubの本人/失効再確認は5分間隔、障害時は許可せず503。401はローカルセッションを削除、レート制限などの一時障害では保存を維持する。
- OAuth開始情報: サーバー期限10分、交換前に消費。一度に進行できるGitHubログインは1フロー。複数タブで開始した場合は最新のフローからやり直す。
- 監査: 本人のみ `GET /api/security`。種別・HTTPメソッド・結果・時刻だけ。本文/クエリ/Cookie/トークン/メール/生IPなし。最大100件・7日、毎時掃除。通常APIから削除不可。ただしクラウド管理者から独立した追記専用保管ではない。外部通知キュー・送信アダプターは実装済みだが送信元未設定。SEC-16の完了扱いにしない。

## 緊急時（今回の候補を反映後のみ有効）

1. まず操作を止め、対象・発見時刻・版・監査の情報を秘密値なしで保全する。
2. CloudflareのこのWorkerのSettings → Variables and Secretsで `SECURITY_LOCKDOWN=true` を設定して反映。全HTTPと新規Cron/Alarm処理を停止。進行済み外部要求を取り消す保証はない。他Workerは変更しない。
3. `SESSION_GENERATION` を新しい非秘密の世代文字列へ更新すると既存Cookieを拒否する。これは外部のrefresh token失効ではない。外部接続も止めるときはlockdownを併用する。
4. 漏えいした鍵だけをサービス側で本人が失効・再発行。Google/GitHubの接続を見直す。既存秘密値をログに出さない。
5. 原因修正・回帰検証・鍵の差し替え後、lockdownを解除して再ログイン。外部接続/全件取得/未同期/二重操作防止を確認。切戻しで古い脆弱版を復活させない。

これらはローカル試験済みの制御。実本番の停止・失効は今回実行していない。既存本番版には今回の設定は効かないため、その時点ではCloudflare側で対象Workerの公開経路を停止する具体手順を事前確認する必要がある。

## バックアップと復旧

JSONには個人情報がある。公開Git・共有Driveに保存しない。端末の暗号化とアクセス制御を確認した本人専用の保存先を使用する。保存先・保管期間は本人未確認で、暗号化バックアップを導入済みとはしない。暫定の目標案はRPO24時間/RTO4時間で、本人合意・実測とも未完了。

復元訓練は本番ではなく新しいMiniflare保存先で、架空タスク/名簿/報告/メールを保存→バックアップ→空保存先にプレビュー→チェックサム付き復元→元と照合→既存上書き拒否を確認する。対応テストはbackup/agenda-backup/note-drafts/progress-reports-persistence。実個人情報を試験ログに出さない。テスト通過を実災害時のRTO/RPO保証とはしない。

## 更新・CI

Windows PowerShellでプロジェクト内修正版を利用する:
```powershell
$env:PATH=(Join-Path (Get-Location) '.security-tools\node-v24.22.3-win-x64')+';'+$env:PATH
node --version
npm.cmd ci
npm.cmd audit --audit-level=low
npm.cmd test
npm.cmd run build
node scripts/security-static.mjs
python scripts/security-scan.py
```
NodeバイナリはGit管理外。公式distのSHA256を照合して導入した。OS全体の旧Nodeは変更していない。
CIはpush/PR/manual、書込み権限なし、SHA固定アクション、本番secretなし。定期更新確認は所有者が週1回およびリリース前に公式Node/Cloudflare/Microsoft/KEV/npm auditを確認し、lockfileと証拠を更新する。npm auditや限定SASTの成功だけで安全宣言しない。
ローカル開発は`.dev.vars`に `PUBLIC_ORIGIN="http://localhost:8787"` を明示。本番は固定workers.dev originが既定。Forwarded/Host由来の任意callbackを作らない。

## 公開Gitの実名残存

現行の画像・初期値・テストの実名は削除/架空化したが、過去のcommit/blobには残る。本人の氏名であり認証秘密ではないが、本番の名簿データとは別の公開情報になっている。履歴書換え・force push・他cloneへの影響とGitHub側キャッシュの削除要否を説明してから承認を得る。勝手に履歴を書き換えない。書換え後でも取得済みの第三者コピーを消せる保証はない。

## 2026-11-26追記

管理者認証は本人から設定完了の申告あり。監視・通知と手動暗号化バックアップの実装状況、手順、残る制約は[monitoring-backup.md](monitoring-backup.md)を参照。上記の運用目標と実到達・実災害訓練の未完了は継続する。
