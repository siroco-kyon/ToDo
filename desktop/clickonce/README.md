# HAKOBI ClickOnce 起動アプリ

Electron の `payload/HAKOBI.exe` を起動する、小さな .NET 10 アプリです。起動した Electron が終了するまで残ります。旧インストーラー版や別の ClickOnce 版が同じ利用者で起動していたら、終了を案内します。

ClickOnce は、デスクトップまたはスタートメニューのショートカットから起動する際に更新を確認します。キャッシュ内の exe の直接実行では更新しません。`HAKOBI_CLICKONCE_LAUNCHER` は現在の配布内のパスで、更新後にも有効な固定パスではありません。

作成・署名・公開の手順は [試験配布ガイド](../../docs/CLICKONCE.md) を参照してください。配布元 URL は本体の署名対象マーカーにも保存し、別のチームサーバーに接続したときは誤った更新案内を出しません。

発行は Visual Studio の `MSBuild.exe` で行います（`dotnet publish` では ClickOnce の `UpdateManifest` が未対応です）。`Properties/PublishProfiles/ClickOnce.pubxml` に対して、次を発行スクリプトから渡します。

| MSBuild プロパティ | 内容 |
| --- | --- |
| `PayloadDirectory` | `HAKOBI.exe` を含む Electron の展開フォルダーの絶対パス |
| `ClickOnceInstallUrl` | 配布先の絶対 URL。末尾 `/` 必須 |
| `ClickOnceVersion` | `1.0.5.1` のような 4 要素の発行バージョン。更新時は必ず増やす |
| `ManifestCertificateThumbprint` | 秘密鍵を持つ、現在の利用者の証明書ストアの署名証明書 |
| `PublishDir` | ローカルの発行物出力先。末尾 `\` 必須 |

自己署名証明書でも試験できます。証明書・秘密鍵・パスワードはコミットしません。発行物の署名があっても、組織の ClickOnce 制限や発行元の信頼確認を通過する保証はありません。

コンパイルと起動ポリシーの検証:

```powershell
dotnet build desktop/clickonce/Hakobi.ClickOnce.csproj -c Release
dotnet run --project desktop/clickonce/tests/Launcher.Tests.csproj -c Release
```

本物のランチャーと代役の本体で、環境変数・安全な引数・二重起動・本体が終了するまで待つ動作を検証できます。HAKOBI を終了してから実行します。

```powershell
dotnet build desktop/clickonce/tests/fake-payload/FakePayload.csproj -c Release
dotnet run --project desktop/clickonce/tests/Launcher.Tests.csproj -c Release -- desktop/clickonce/bin/Release/net10.0-windows/win-x64 desktop/clickonce/tests/fake-payload/bin/Release/net10.0-windows
```

本体の全ファイルを Content として `payload/` に含めます。ファイルを変更したら署名済みマニフェストの再発行が必要です。`setup.exe` は出力せず、自己完結の .NET ランタイムを同梱します。
