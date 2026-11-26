# SEC対応表

2026-11-26。正式ASVS 5.0.0のL1/L2全253行は `asvs-l2-matrix.csv`。同ファイルの要調査を合格に読み替えない。今回のコード・試験は部分的な改善であり厳格版の全完了ではない。

| ID | 判定 / 優先度 | 状態・実装と証拠 | 残作業 |
|---|---|---|---|
| SEC-01 | 対象 P1 | .gitignore/Workers secrets、履歴と配布テキストの限定秘密検査0件。公開画像1件と初期値に実名を発見、現行を削除・架空名化 | Git履歴の実名・旧画像は残存。履歴修正には別承認。全形式の秘密を否定する検査ではない |
| SEC-02 | 対象 P1 | auth.js：PKCE/state、サーバー有効期限・単回使用、本人ID照合。送信元/全体の1分試行上限。auth/request-security/workerテスト | GitHub/Cloudflareのフィッシング耐性MFA・予備回復は本人回答で未設定/不明。外部IdPの方式強制は現OAuthで証明不可 |
| SEC-03 | 対象 P1 | 全API前段で本人認可、対象scope/id検証、Origin検証。worker/notes/backup/agenda等の既存異常系 | ASVS全経路の独立レビューは未完了。RLSはクライアントDB直結なしのため対象外 |
| SEC-04 | 対象 P1 | Secure/HttpOnly/SameSite=Lax、12時間最大・30分API無通信、失効世代、外部IdPを5分ごとに再照合。外部障害は拒否。authテスト | 本番の実ログイン・再認証確認未実施。アイドルは人の操作ではなくAPI通信を活動と定義。JWTは対象外 |
| SEC-05 | 対象 P1 | JSONをストリーム上限/10秒で制限、型・対象・文字数は各モジュールで検証、動的eval不使用。request-security/既存入力テスト | 限定SASTのみで全データフロー解析は未実施 |
| SEC-06 | 対象 P1 | 修正版Node24.22.3をプロジェクト内導入、npm audit0件、全依存一覧、固定SHAの最小権限CI、配布物/履歴の検査 | CIリモート実行結果は別途記録。OS累積更新・すべての推移依存の提供元告知の個別照合は未完了 |
| SEC-07 | 対象 P1 | DO標準暗号化、機微情報を含まない最大100件/7日の監査、既存バックアップの模擬SQLite復元テスト | 独立した暗号化バックアップと保管場所/期限の本人確認、測定付きRTO/RPO訓練未完了 |
| SEC-08 | 対象 P1 | no-store/CSP/CORP等維持、Origin制限、本文10MiB、接続設定16KiB、ログイン/本人API制限、固定origin検証。回帰試験 | 本番CDN/直通経路全確認、WAF通知・費用上限は未確認。大規模負荷試験なし |
| SEC-09 | 対象 P1 | JSONバックアップのサイズ・形式・scope・競合検証。ファイルを公開配信しない。backup関連テスト | 実行形式/アーカイブのアップロード・展開は存在しないため対象外 |
| SEC-10 | 対象 P1 | 外部通信はGoogle/GitHub/Slackの固定ホスト、redirect:manual、タイムアウト。notes/drive/agenda等テスト | 全受信応答のストリームサイズ制限は未統一。Webhook/決済は存在せず対象外 |
| SEC-11 | 対象 P1 | WebView2のホストオブジェクト/メッセージ/DevTools/保存/権限を制限、URL許可、パッケージhash固定。ネイティブ試験は一部失敗 | フォーカス試験失敗の再現切分け、署名配布は未実装。Electronは不使用。iOSネイティブ未実装 |
| SEC-12 | 対象外 | AIモデル・自律ツール実行なし、ルールによる抽出のみ。外部資料を命令として実行する経路なし | AI導入時に再判定 |
| SEC-13 | 対象 P1 | 必須認証設定なしは機能停止、認可障害は503、PUBLIC_ORIGIN検証、SECURITY_LOCKDOWNでHTTP/Cron/Alarm停止、SESSION_GENERATION更新で既存Cookie失効 | 本番停止は未実施。クラウド管理権限/管理者設定の確認が残る。コンテナ/root/RLSは不使用 |
| SEC-14 | 対象 P1 | DO直列処理・revision・結果不明時の再照合・復元transactionを既存テストで確認。予定は本人確認した内容でのみ登録 | 外部GitHub同時更新との原子性保証なし。課金/残高/在庫は不使用 |
| SEC-15 | 対象 P1 | 同一origin CSP・frame拒否・秘密JSも本人認可後。innerHTMLは固定テンプレート、実データはtextContent | nonce/hashの必要範囲と全HTML経路の確認が残る。公開GraphQLサーバー/WebSocketはなし |
| SEC-16 | 対象 P1 | ローカル監査・停止/失効・更新/復元手順を作成 | 外部への警告通知と実到達、独立監査保管、RTO/RPO測定は未完了。通知先は未確定 |

暫定値はsecurity/operations.md参照。P1と要調査があるため、今回候補は本番リリース不可。既存本番の停止は実行していない。
