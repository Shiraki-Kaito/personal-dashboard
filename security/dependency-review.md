# 使用版・公式情報の照合

確認日2026-11-26 JST。開始時と候補確定時のnpm auditは0件。全依存版・integrityはdependency-tree.json、レジストリ結果はnpm-audit.json。

| 対象 | 導入版/修正 | 告知・判断 |
|---|---|---|
| Node.js | 既存PC24.11.0 → このプロジェクト専用24.22.3 | CVE-2026-111497（Brotli、KEV掲載）、11月のCVE-2026-123863等の修正前。Worker本番はNodeサーバーではないが開発経路を修正版へ変更。OS全体のNodeは未変更 |
| Wrangler | 4.160.0 | GHSA-36p8-mvp6-cv38 / CVE-2026-0933は4.59.0以下、修正版4.59.1。導入版は範囲外、pages deployも使わない |
| Miniflare | 5.20261110.0-beta | GHSA-fwvg-2739-22v7の旧系統を確認。npm audit検出なし。ベータ版であり無条件に安全保証しない |
| WebView2 SDK | 1.0.4370.26 | NuGet公式の導入版確認、既存build.ps1のSHA256検証。実Runtimeは158.0.4370.33 |
| OS/.NET | Windows build10.0.26200、Framework64 csc | 既存OSのパッチ履歴・サポート条件全照合は未完了、WindowsProductName文字列のみで判定しない |
| 本番ランタイム | Cloudflare管理workerd、compatibility_date2026-11-10 | 自前Node/コンテナなし。アカウント公開設定の全面確認は未完了 |

公式出典:
- https://nodejs.org/en/blog/vulnerability/october-2026-security-releases/
- https://nodejs.org/en/blog/vulnerability/november-2026-security-releases/
- https://nodejs.org/dist/index.json
- https://github.com/cloudflare/workers-sdk/security/advisories/GHSA-36p8-mvp6-cv38
- https://github.com/cloudflare/workers-sdk/security/advisories/GHSA-fwvg-2739-22v7
- https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4370.26
- https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security
- https://learn.microsoft.com/en-us/deployedge/microsoft-edge-relnotes-security
- https://github.com/cisagov/kev-data （照合結果kev-review.json）
- https://developers.cloudflare.com/durable-objects/reference/data-security/ （DOの標準保存時暗号化。自前鍵の分離を確認済みとしない）

Node公式zip SHA256: E612AF99F626AB415EA225AF6BCE5C971FEB448CB5CAE250BB1C3FA50C5F7D9F
Gitleaks8.30.1公式zip SHA256: D29144DEFF3A68AA93CED33DDDF84B7FDC26070ADD4AA0F4513094C8332AFC4E
両方とも公式配布チェックサムと照合。バイナリは公開Gitへ入れない。

依存一覧・npm audit・KEVは検出手段であり、全CVEや到達経路の否定ではない。影響が未判断のHigh/Criticalや重要な外部設定が残ればリリースを止める。
