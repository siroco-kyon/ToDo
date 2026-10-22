# HAKOBI ClickOnce 版の試験配布

HAKOBI の Electron 本体を、小さな .NET 起動アプリと一緒に ClickOnce で配布する試作です。通常の exe 版と別に発行できます。画面・タスク API・DB は共通で、利用者のデータや接続設定は従来の保存先を使います。

初回は Edge のリンクから ClickOnce を開きます。以後はスタートメニューやデスクトップの「HAKOBI（ClickOnce 試験版）」から起動する際に更新を確認します。exe の拡張子だけを変更する仕組みではありません。自己署名による試験は可能ですが、社内のポリシーや Windows のアプリ制御を通過する保証はありません。

## 発行する PC の準備

- Windows x64、Node.js、リポジトリの npm 依存関係
- .NET 10 SDK
- Visual Studio または Build Tools の MSBuild、ClickOnce 発行ツール
- Windows SDK の `mage.exe`（発行物の署名検証に使用）
- 現在の利用者の証明書ストア `CurrentUser\My` にある、秘密鍵を持ったコード署名証明書。試験用は下記のコマンドで作成できます。

利用者の PC に .NET 10 を別途入れる必要はありません。ランタイムを発行物に同梱します。Windows x64 専用です。

## ローカルで作成する

リポジトリ直下の PowerShell で実行します。

```powershell
powershell -NoProfile -File scripts/build-clickonce.ps1 `
  -InstallUrl http://127.0.0.1:4577/clickonce/ `
  -CreateTestCertificate
```

Electron のビルド、フォルダー形式のパッケージ生成、起動アプリのビルド、マニフェスト署名、ファイルのサイズ・ハッシュ・署名の検証を行います。サーバーへの公開は行いません。

出力は `release/clickonce/1.0.5.0/` です。既定の発行バージョンは `package.json` のバージョンに `.0` を付けたものです。同じバージョンを上書きしません。試作を作り直す場合は `-Version 1.0.5.1` のように増やしてください。

`-CreateTestCertificate` は `CurrentUser\My` に `HAKOBI ClickOnce test only` という名前の自己署名証明書を作成します。有効な同名証明書があれば再利用します。信頼されたルートや発行元には登録しません。秘密鍵をエクスポートせず、リポジトリや配布先にもコピーしません。

更新の試験では同じ証明書を使い続けます。既存の証明書を指定する場合:

```powershell
powershell -NoProfile -File scripts/build-clickonce.ps1 `
  -InstallUrl https://hakobi.example.local/clickonce/ `
  -CertificateThumbprint 証明書のサムプリント `
  -Version 1.0.5.1
```

配布 URL は署名済みマニフェストに記録されます。ローカル試験用の `127.0.0.1` はほかの PC から利用できません。社内 PC へ配るときは、実際にその PC から開ける URL で作り直してください。HTTPS は通信を保護しますが、発行元の信頼やアプリの評判とは別です。

PowerShell の npm ラッパーによって引数の扱いが異なる場合があるため、上記の直接実行を推奨します。npm の入口は `dist:clickonce` と `publish:clickonce` です。

## HAKOBI サーバーで公開する

新しい `server/` と `dist-web/` をサーバーに配置して再起動します。ClickOnce 配布フォルダーは `TODO_CLICKONCE_DIST`、既定はリポジトリ直下の `dist-clickonce/` です。通常の exe 配布先 `TODO_DESKTOP_DIST` とは別です。

作成済みの発行物を確認した後、明示的に公開します。

```powershell
powershell -NoProfile -File scripts/publish-clickonce.ps1 `
  -Source release/clickonce/1.0.5.0 `
  -InstallUrl http://127.0.0.1:4577/clickonce/
```

別の配布先へコピーする場合は `-Destination '\\サーバー\共有\clickonce'` を指定し、サーバーの `TODO_CLICKONCE_DIST` もその場所に合わせます。公開スクリプトは既定で `dist-clickonce/` に書き込みます。`server/.env` を自動では読みません。

スクリプトは署名・ハッシュ・配布 URL・版を検証し、バージョン別の本体を先にコピーし、最後に `HAKOBI.application` を置き換えます。旧バージョンを削除しません。公開済みの版の上書きも禁止します。公開後のサーバー再起動は不要です。

- `/clickonce/`: ログイン不要の試験版インストールページ
- `/clickonce/HAKOBI.application`: ClickOnce の入口
- `/api/clickonce-release`: 公開中の ClickOnce 版の情報
- `/download`: ClickOnce 版を公開した場合だけ、通常の exe 版とは別の案内を表示

配信するのは入口の HTML・配布マニフェスト・公開情報、および `Application Files/` 内の `.manifest` と `.deploy` だけです。未公開や配布情報の不整合時は、入口を表示しません。通常の exe 版の API やダウンロード数の集計はそのままで、ClickOnce の取得回数はその集計に含みません。

IIS などで別配信する場合は、発行物一式を配置し、`.application` に `application/x-ms-application`、`.manifest` に `application/x-ms-manifest`、`.deploy` に `application/octet-stream` の MIME を設定します。生成ページは相対リンクなので別パスでも使えます。ただし HAKOBI の `/download` にある試験版案内は、同じ HAKOBI サーバーの `/clickonce/` 配信を対象としています。

## 初回導入・更新を確認する

1. 通常の exe 版が起動していれば、タスクトレイの「HAKOBIを終了」で完全に終了します。ウィンドウを閉じただけでは常駐が続く場合があります。
2. Edge で `/clickonce/` を開き、「インストール・更新する」を押します。発行元を確認し、会社で許可された範囲で ClickOnce の案内に従います。
3. スタートメニューまたはデスクトップの「HAKOBI（ClickOnce 試験版）」を開きます。ログイン・タスク・接続設定・右下タイマー・通知・個人用モードを確認します。
4. 同じ URL・同じ証明書で、4 要素の発行バージョンを増やして発行・公開します。
5. 試験版を完全に終了し、ClickOnce のショートカットから起動して、新版に切り替わることを確認します。

起動前に更新を確認し、公開された版を最低必要版に指定します。起動中のアプリを強制終了して置き換えることはありません。別の版が起動中なら、日本語で終了を案内します。ClickOnce の起動アプリは本体が終了するまで動作します。

ClickOnce の更新元は発行時の URL に固定され、チームの接続先を変更しても変わりません。アプリ内の新バージョン案内は、接続先と ClickOnce 配布元が同じ `/clickonce/` の場合だけ表示します。別サーバーや IIS から配布した場合も、ClickOnce のショートカットから起動すると発行時の配布元に更新を確認します。

タスクバーに固定した Electron 本体やキャッシュ内の exe を直接開くと、ClickOnce の更新確認を通りません。試験中の起動は ClickOnce が作ったデスクトップ／スタートメニューのショートカットを使ってください。通常の exe 版は別のアプリ登録として残り、自動でアンインストールしません。両版は同じデータを使うため、同時に使わず、移行判断の前に通常のバックアップを取ってください。

## 検証コマンド

```powershell
npm run test:clickonce
npm --prefix server run typecheck
npx tsc --noEmit -p web/tsconfig.json
npx tsc --noEmit -p tsconfig.node.json
```

実際の署名済み発行物を使う公開処理の検証（運用サーバーには書き込みません）:

```powershell
powershell -NoProfile -File tests/clickonce-publishing.ps1 `
  -Source release/clickonce/1.0.5.0 `
  -InstallUrl http://127.0.0.1:4577/clickonce/
node tests/clickonce-artifact.cjs release/clickonce/1.0.5.0
```

会社の PC による初回導入と、ClickOnce を経由した実更新の確認は別途必要です。作成・署名・配信のテストだけでは、その PC のポリシーで許可されることを確認したことにはなりません。
