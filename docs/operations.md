# 運用と検証

更新日：2026-11-17（日本時間）

## 設定と起動

- Worker：`personal-dashboard`。SQLite Durable Objectを使用し、Cronは毎時です。
- GitHub本人ログイン：専用OAuth Appの `GITHUB_CLIENT_ID`・`GITHUB_CLIENT_SECRET`。コールバックは本番URLの `/auth/callback`。
- Projectsの取得対象：既存の `PROJECT_CONFIG`。新しいID・フィールド・選択肢は元サービスと照合し、実運用と試験用を区別します。
- Google連携：専用OAuthクライアントの `GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET`。Driveとメール・予定の認可はサイトの専用導線から行います。
- ノート：サイト内で対象と専用トークンを設定。ローカルCLIトークンやProjectsの認可を流用しません。
- ローカル開発：`.dev.vars`へ開発用設定を入れ、独立したOAuthクライアントを利用します。ローカルも認可を迂回しません。

秘密値の登録は、値を引数やコマンド履歴に含めずWranglerの対話入力で行います。

```powershell
npx.cmd wrangler secret put GITHUB_CLIENT_ID
npx.cmd wrangler secret put GITHUB_CLIENT_SECRET
npx.cmd wrangler secret put GOOGLE_CLIENT_ID
npx.cmd wrangler secret put GOOGLE_CLIENT_SECRET
```

既存の別アプリのWorker・DB・Secrets・ドメインを変更しないでください。認証更新が必要な場合も本人の認証状態を安全に利用し、秘密値をログへ出さないでください。

## 同期・障害時

GitHub Projectsがタスクの正本です。保存前に再取得して競合判定し、書き込み後も再取得して反映を照合します。未同期操作は永続化され、再起動で消しません。応答だけ失われた可能性がある場合は、以前の書き込みの成否を照合するまで再送しません。

同じタスクへの操作はアプリ内で直列化します。ただしGitHub画面・別ツールとの間の原子性はなく、読み取りと更新の間の外部変更を完全には防げません。予定の重複照合も照合後の外部追加を完全には防げません。

Drive・メール・予定・設定済みノートの一覧を毎時取得します。ページ上限・取得失敗時は部分情報を完全取得扱いにせず、以前の一覧と最終成功時刻を保持します。ノート本文はCronでは取得しません。GitHubの待機期限と連続取得の制限を守り、手動更新の直後は定期取得を見送ります。トークン失効・権限不足は正常扱いにせず、再設定へ誘導します。

「接続と設定」の診断で最終試行・最終成功・未同期・結果未確認を確認できます。バックアップの復元時は対象と競合を確認し、秘密値の復元や無条件の既存上書きを行いません。ノートはバックアップ対象外です。

## 今回の検証

| 対象 | 方法 | 結果 |
| --- | --- | --- |
| 回帰テスト | 模擬APIとローカルWorker | 319件成功 |
| ノートの定期取得 | 模擬GitHub | 一覧更新、未設定時の無通信、本文を取得しないことを確認 |
| ノートの失効と復旧 | 模擬GitHub | 401時に一覧・成功時刻を保持、再起動後の再取得で復旧 |
| 重複取得・レート待機 | 模擬GitHub | 直前の取得・待機期限では再取得しない |
| 本人以外の認可 | 模擬OAuthとWorker | 別の本人ID、偽造Cookie、未認証の取得・更新を拒否 |
| 本番の未認証アクセス | 実HTTP | 主要8 API・ノートJS・ノート本文POSTがすべて401 |
| ノートの実接続 | 本番 | 専用トークンの本人登録待ち。取得成功と初回Cronは未確認 |
| 公開READMEの画面 | ローカルの架空データ | 実メール・実ノート・秘密値を使わず撮影 |

実APIの失効操作、試験予定の登録・削除などは今回の模擬検証とは別です。過去の確認を今回再実行した結果として扱っていません。障害注入・認可回避・データ投入の機能は本番へ配信しません。

## 費用

今回、有料契約・課金の有効化・新規リソースの作成は行いません。既存のWorker・永続化・Cronを使います。ノートの毎時更新によりGitHub RESTとCloudflareのリクエスト・保存処理が増えます。無料枠に収まるという実測保証や、他アプリを含むアカウント全体の請求額確認はしていません。

[Workers料金](https://developers.cloudflare.com/workers/platform/pricing/) · [Durable Objects料金](https://developers.cloudflare.com/durable-objects/platform/pricing/) · [GitHub REST制限](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

今回のデプロイ版：`0c943c07-60a7-40e9-8674-451c7276c7f1`。ソースのPublic設定は維持しています。旧READMEの詳細履歴はGit履歴で参照でき、ローカルにも退避しています。
