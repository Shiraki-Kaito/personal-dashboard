# Windowsの壁紙風表示

既存の本人限定サイトを表示するWindows x64用のWinForms・WebView2アプリです。背景表示はタスクバーを除いた領域に広がり、別アプリへ切り替えると背面へ回ります。最前面固定は行いません。

## 起動

ビルド済みの `bin/PersonalDashboard.exe` を開き、初回は「GitHubでログイン」から本人ログインします。上部の「背景表示」で切り替え、「通常表示」で元の大きさに戻ります。通知領域のアイコンからも通常表示・終了ができます。

PowerShellで、このリポジトリのフォルダから実行する場合：

```powershell
& .\windows\bin\PersonalDashboard.exe --background
```

二重起動は防止します。終了は上部の「終了」または通知領域から行ってください。自動起動は設定しません。

## ビルド・検証

Windows x64、.NET Framework 4.6.2以降、WebView2 Evergreen Runtimeが必要です。このPCにあるコンパイラーとRuntimeを使用しました。

```powershell
.\windows\build.ps1
& .\windows\bin\DesktopTests.exe
```

ビルドはMicrosoft公式NuGetから固定バージョンのWebView2 SDKを取得し、SHA-256を照合します。配布する場合は `bin` のEXE・DLLとWebView2のLICENSE・NOTICEを一緒にしてください。`DesktopTests.exe` は検証専用で配布不要です。現在のEXEはコード署名していません。

## 認証と外部リンク

本番の本人限定認証・API認可をそのまま利用します。認証の迂回やCLIトークンの転用はしません。通常ブラウザーとは別のプロファイルを `%LOCALAPPDATA%\PersonalDashboard\WebView2` に保存するため、初回ログインが必要です。このフォルダを共有・Gitへ追加しないでください。

内部のページ遷移は本番ホストとGitHubのHTTPSに限定します。利用者が開いたHTTPSの別窓リンクは既定ブラウザーへ渡します。Googleの追加認可やファイルのダウンロードは「ブラウザーで開く」から行ってください。内部のカメラ・マイク等の権限要求、ホストオブジェクト、Webメッセージ、開発者ツールは無効です。

## 確認結果（2026-11-21）

- ビルド成功、ネイティブ自動テスト20項目合格。背景・通常の両方で最前面属性なし、作業領域、別ウィンドウの背面配置、切替時のフォーカス維持、通常サイズ復元、終了、URL制限を確認。
- 実WebView2で本番ログイン画面の読み込み、背景表示、通常表示への復帰、終了を確認。
- 制限付き検証プロセスでDNSエラーと失敗表示を確認。ネットワーク制限外で同じ本番ページの表示成功を確認。
- 本人ログイン後のデータ表示・GitHub認証フロー、通知領域からの操作、実機の複数モニター接続変更は未確認。モニター変更時は通常表示へ戻して配置し直してください。

## 制約

Explorerの内部ウィンドウへ埋め込む方式ではありません。デスクトップアイコンの下には入りません。「デスクトップの表示」では最小化されます。操作するために選択すると前へ出ますが、別アプリへ切り替えると背面へ戻ります。OSの壁紙・文字サイズ・他アプリの設定は変更しません。

今回はローカルアプリだけの変更で、Cloudflareへの再デプロイは不要です。新たな有料サービスは追加していません。本番サービスの既存利用量は従来どおり発生します。

公式仕様：[SetWindowPos](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos)、[WebView2 Runtimeの配布](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution)、[WebView2のセキュリティ](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security)。
