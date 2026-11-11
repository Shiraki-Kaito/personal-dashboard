# 個人ダッシュボード

本番は https://personal-dashboard.kait0.workers.dev 。ログイン後、試験用Project「ダッシュボード試作」の指定したドラフト1件の状態・期限を確認・変更できます。Project全体の件数も表示します。状態は既存の選択肢から選び、期限は空欄で解除できます。

## 起動と運用

本番はブラウザーで開きます。サーバーのローカル起動は不要です。Node.js 24を使う開発環境では、このフォルダで以下を実行します。

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run dev
```

ローカルの既定URLは `http://localhost:8787`。開発用にログインする場合は独立したOAuth Appでローカルのコールバックを登録し、下記の3設定をGit対象外の `.dev.vars` に用意します。ローカル起動も全APIに本人認可が必要です。通常の自動テストには資格情報が不要です。本番反映は `npm.cmd run deploy`。旧Python試作の起動は元のフォルダで `python app.py`、URLは `http://127.0.0.1:8765` です。

### 本番の初回設定

- Cloudflareの対象Workerは `personal-dashboard`。SQLite Durable Objectを1つ使用します。既存試作からProject、Item、Status、期限のIDと選択肢、Project URLのみを `PROJECT_CONFIG` に登録済みです。Optionsの変更時は実フィールドと再照合して更新してください。
- Shiraki-KaitoのGitHub Developer settingsで専用OAuth Appを登録します。Homepageは本番URL、Redirect URIは `https://personal-dashboard.kait0.workers.dev/auth/callback`。ワイルドカードとDevice Flowは無効、トークンの有効期限は有効にします。
- 次のコマンドで表示される入力欄に個別に入力します。秘密をコマンド引数、チャットやファイルへ書き込む必要はありません。

```powershell
npx.cmd wrangler secret put GITHUB_CLIENT_ID
npx.cmd wrangler secret put GITHUB_CLIENT_SECRET
```

- 本番の「GitHubでログイン」から `project` を認可します。固定したGitHubの本人node IDを照合してからセッションを発行します。アプリが要求するスコープは個人のProjectsに対する読み書きで、単一Projectに限定されるスコープではありません。サーバーが実際の更新先を既存の試験Project・Item・フィールドに固定します。
- OAuthのstateとPKCEを使用します。GitHubトークンはサーバー側に保存し、ブラウザーにはSecure・HttpOnlyのセッションCookieを発行します。全データAPIでセッションと本人IDを照合し、変更時はOriginも検証します。新規ログインは以前のセッションを置き換えます。セッションは最長12時間で、GitHubのトークン有効時間が短ければそれに合わせます。期限後は再ログインしてください。ログアウトで保存した認証を破棄し、完全に連携を解除する場合はGitHubのAuthorized OAuth Appsでも失効させます。

### 認証方式を選んだ理由

OAuth Appは本人ログインと個人Projectsの操作を一度の認可で結び付けられます。GitHub Appは短命トークンと細かい権限が利点ですが、インストール・鍵管理が加わり、個人所有Projectへの適用確認も別途必要です。専用classic PATの `project` 権限でも操作できますが、本人ログインを別に構成し、期限・ローテーションを管理する必要があります。現行のfine-grained PAT権限一覧にはOrganization Projectsが掲載され、User Projectsの項目はありません。PCのgh資格情報はローカル検証専用です。

## 構成と同期の契約

静的HTML・JavaScriptの表示、Workerの認可とルーティング、GitHub GraphQLアダプター、保存と照合を行う同期処理に分けました。SQLite-backed Durable Objectのストレージに取得結果と未同期操作を永続化し、同一オブジェクト内の要求を直列化します。設定対象1件に合わせ、D1・Cron・Reactの依存は追加していません。画面が表示中かつ未編集中は60秒ごとに取得し、2分超または取得失敗時はキャッシュを明示します。閉じている間の定期取得はありません。

1. 編集時の状態・期限・更新時刻とキャッシュを比較し、未同期操作を先に保存します。
2. GitHubを再取得して本人・対象Project・試験ドラフト・アーカイブ状態を確認します。フィールド値のページを最後までたどり、ページ間のリビジョン変化やカーソル不整合は失敗にします。
3. 希望値に達していれば送信を省きます。基準値と違えば競合として保留します。一致した場合だけ指定の1フィールドを設定または解除し、GitHubから再取得して照合します。
4. 通信障害・応答喪失時は保留が残ります。「照合して再試行」は先に読み直します。「変更を破棄」は指定した保留IDだけを破棄し、GitHubの値を取得します。フィールド未設定と削除・アクセス不可を区別します。GitHubが存在を隠す場合、削除と非表示の判別はできません。
5. 一時的な読み取り障害は8秒のタイムアウト、600ミリ秒待機で最大1回再試行します。権限不足、認証エラー、レート制限、入力不正に対する同一要求内の再試行はありません。

実GitHubで更新・解除のGraphQL入力型を照合しました。どちらにも期待リビジョン・条件付き更新の指定はありません。読み取りと書き込みの間のGitHub画面や他ツールからの更新、同値への変更や元に戻る変更、書き込みの帰属までは保証できません。照合後もGitHub側の値は変わり得ます。試験後の復元にも同じ制約があります。

## 検証記録（2026年11月11日）

| 環境                                         | 結果                                                                                                                                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 旧Python試作、模擬API                        | 既存7件合格。Windowsのgh呼び出しにUTF-8指定あり。元の設定・状態を保持。                                                                                                                                    |
| 本体、模擬GitHub                             | 状態・期限、通信・権限・レート・タイムアウト相当、応答のみ喪失、照合・復旧、競合、古い操作の拒否を試験。                                                                                                   |
| ローカルWorkersランタイム、模擬OAuthとGitHub | 本人以外の拒否、本人認可、異なるOriginの拒否、並列編集・並列再試行、SQLiteを保持したランタイム再起動、ログアウトを試験。実際のプロセス再起動後に同じ保留IDを取得。                                         |
| 実GitHub＋ローカルの本体同期処理             | 指定Projectの件数1、ID・フィールドを照合。アプリから状態変更・期限設定と解除を独立再取得。GitHub側で期限変更後、古い基準の編集が競合で停止し、変更後の値を取り込み。開始時の状態・期限へ戻して再照合済み。 |
| Cloudflare本番                               | Workerをデプロイ。OAuth secret 2件を登録。Shiraki-Kaitoで本番ログインし、試験タスク1件を取得。ブラウザーから状態・期限を更新し「反映確認済み」を確認。開始時の値へ復元し、GitHub GraphQLでStatus=Todo・期限=2026-11-10を独立照合。未認証の5 APIは401。 |

実GitHub試験の再実行は `node test/live.mjs "<旧試作のconfig.json>" "<リポジトリ外の新規記録ファイル>"`。試験中はそのタスクを編集しないでください。開始時の値を先に記録し、直前に確認した値とリビジョンが変わると復元を停止します。結果不明時は記録とGitHub画面を突き合わせてください。障害注入はテストコードにのみ含まれます。

## 費用と対象外

有料契約・課金の有効化は行っていません。Workers Freeはリクエスト10万件/日。SQLite Durable ObjectsはFreeでも提供され、行読み取り500万/日、書き込み10万/日などの別枠があります。同じアカウントの他アプリとも利用枠を共有します。1タブで1時間表示すると通常の定期取得は約60回、編集・照合・障害時の再試行は別です。アカウントの契約額、累積使用量や月額実績は未確認です。GitHub GraphQLはポイント制で、他の利用や二次制限の影響も受けます。

メール、カレンダー、Slack、Drive、ノート、壁紙・iOSは未接続。ノートや `*_L.md` を読む処理はありません。Cloudflare本番ではアプリ→GitHubの試験・復元を確認済みです。GitHub画面からの更新→本番画面への反映と、実アカウントでの他人拒否は未確認です。

[Cloudflare Workers料金](https://developers.cloudflare.com/workers/platform/pricing/) ／ [Durable Objects料金](https://developers.cloudflare.com/durable-objects/platform/pricing/) ／ [GitHub Projects API](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects) ／ [OAuth認可](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) ／ [GraphQL制限](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)
