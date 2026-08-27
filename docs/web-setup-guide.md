# Web 版（チーム向けサーバー版）の立ち上げガイド

ブラウザから複数人で使う「サーバー版」の起動手順をまとめた資料です。
コマンドを叩く**フォルダ**と**順番**を中心に、初めてでも迷わないように書いています。

---

## いちばん大事なこと：コマンドはすべて `D:\Github\ToDo` で叩く

> **すべてのコマンドは、リポジトリの一番上のフォルダ `D:\Github\ToDo` で実行します。**
> `server\` や `web\` の中に入る必要はありません。

`npm run dev:server` のようなコマンドが、裏側で自動的に `server\` フォルダの処理を呼び出します。
自分で `cd server` する必要はない、という点だけ覚えておけば大丈夫です。

### フォルダが合っているかの確認方法

PowerShell を開いたら、まず今いる場所を確認します。

```powershell
pwd
```

表示が次のようになっていれば OK です。

```
Path
----
D:\Github\ToDo
```

もし違う場所にいたら、次のコマンドで移動します。

```powershell
cd D:\Github\ToDo
```

> 💡 コツ: エクスプローラーで `D:\Github\ToDo` フォルダを開き、アドレスバーに `powershell` と打ち込んで Enter を押すと、そのフォルダで PowerShell が開きます。

---

## 0. 事前に必要なもの

| 必要なもの | 説明 |
| --- | --- |
| Node.js（v20 以上） | `node -v` で確認できます。入っていなければ [nodejs.org](https://nodejs.org/) から LTS 版を入れてください。 |
| このリポジトリ | `D:\Github\ToDo` に置いてある前提で説明します。 |

確認コマンド（`D:\Github\ToDo` で）:

```powershell
node -v
npm -v
```

---

## 1. 初回だけ：依存パッケージのインストール

最初の 1 回だけ実行します。2 回目以降は不要です（パッケージを増やしたときだけ再実行）。

```powershell
# フロント側（画面）の依存をインストール
npm install

# サーバー側の依存をインストール（server\ は独立したパッケージなので別途必要）
npm --prefix server install
```

> `npm --prefix server install` は「`server\` フォルダに対して install を実行する」という意味です。
> 自分で `cd server` しなくても、このコマンド 1 つで済みます。

---

## 2. 開発モード（まず自分の PC で試す）

自分の PC だけで動作確認したいとき用です。**ターミナルを 2 つ**使います。

### ターミナル 1：サーバーを起動（ポート 4577）

```powershell
npm run dev:server
```

次のようなログが出れば起動成功です（初回はここに管理者パスワードも出ます → [4 章](#4-管理者アカウントと初回パスワード)）。

```
[server] listening on http://localhost:4577
```

開発モードで `dist-web\` がまだ無い場合は、続けて `web build not found ...` と出ることがあります。
これは「本番用のビルド済み画面が無い」という案内なので、次の `npm run dev:web` で確認する開発モードでは問題ありません。

このターミナルは**開いたままにします**（閉じるとサーバーが止まります）。

### ターミナル 2：Web フロントを起動（ポート 5273）

**別の** PowerShell をもう 1 つ開き、また `D:\Github\ToDo` にいることを確認してから:

```powershell
npm run dev:web
```

### ブラウザでアクセス

ブラウザで次を開きます。

```
http://localhost:5273
```

ログイン画面が出れば成功です。
（ポート 5273 のフロントが、API と WebSocket を裏でポート 4577 のサーバーへ中継します。だから両方起動が必要です。）

> 💡 サーバーのポートを変えて開発する場合は、サーバー側の `PORT` と、Web フロント側の `SERVER_PORT` を同じ値にします。
> 例: ターミナル 1 で `$env:PORT = "8080"; npm run dev:server`、ターミナル 2 で `$env:SERVER_PORT = "8080"; npm run dev:web`

> **止めるとき**: それぞれのターミナルで `Ctrl + C` を押します。

---

## 3. 本番モード（チームのみんなに公開する）

社内 LAN の他の人がブラウザで使えるようにする手順です。
開発モードと違い、**サーバー 1 つだけ**で画面も API も配信します（ポート 4577 のみ）。

### 手順 1：Web フロントをビルド

```powershell
npm run build:web
```

`dist-web\` フォルダに成果物が出力されます。

### 手順 2：サーバーを起動

```powershell
npm run start:server
```

`dist-web\` があれば、サーバーが同じポート（4577）で**画面も API も両方**配信します。
このターミナルは開いたままにします。

### 手順 3：自分の PC の IP アドレスを調べる

```powershell
ipconfig
```

`IPv4 アドレス` の値（例: `192.168.1.50`）を確認します。

### 手順 4：メンバーがアクセス

各メンバーは、同じ社内 LAN につないだ PC のブラウザで次を開きます。

```
http://192.168.1.50:4577
```

（`192.168.1.50` は手順 3 で調べたあなたの IP に置き換えます。）

> 🔥 **初回は Windows ファイアウォールの許可ダイアログ**が出ることがあります。
> 「プライベートネットワーク」にチェックを入れて「アクセスを許可する」を押してください。
> これを許可しないと、他の人からつながりません。

---

## 3.4 別のサーバー PC で動かすとき（何を持っていくか）

開発した PC とは別の「サーバー役の PC」で常駐させる場合の手順です。

### 持っていくもの

| 持っていくもの | 説明 |
| --- | --- |
| `server\` フォルダ一式 | ただし `server\node_modules\` と `server\data\` は**コピーしない**（node_modules はサーバー PC で作り直す。data は新規ならそもそも無い） |
| `dist-web\` フォルダ | **開発 PC で** `npm run build:web` してできたもの。サーバー PC でビルドし直す必要はありません |
| ルートの `package.json` | `npm run service:install` などの呼び出しに使います |
| `docs\` フォルダ | このガイド。なくても動きますが、あると便利 |

> 📌 リポジトリごと（`node_modules\` と `data\` を除いて）コピーするのが一番簡単です。
> Git が使えるなら `git clone` でも OK（`dist-web\` だけは別途コピーするか、後述の注意を読んでください）。

### サーバー PC での手順

1. **Node.js（v20 以上の LTS）をインストール**します。

2. コピーしたフォルダ（例: `C:\TodoServer`）で PowerShell を開き、**サーバーの依存だけ**インストールします。

   ```powershell
   npm --prefix server install
   ```

   > ⚠️ ルートの `npm install` は**実行しないでください**。デスクトップ版（Electron）の重い依存まで入ってしまいます。サーバー運用に必要なのは `server\` の依存だけです。
   > （`better-sqlite3` はネイティブモジュールのため、サーバー PC 上でのこのインストールが必須です。開発 PC の `node_modules` をコピーしても動きません。）

   > 💡 もしサーバー PC で `dist-web\` を自分でビルドしたい場合だけ、ルートの `npm install` → `npm run build:web` が必要になります。基本は開発 PC でビルドしてコピーする方が軽くて簡単です。

3. **設定ファイルを作ります。** `server\.env.example` を同じフォルダに `.env` という名前でコピーして編集します。

   ```powershell
   Copy-Item server\.env.example server\.env
   notepad server\.env
   ```

   最低限 `ADMIN_PASSWORD` を決めておくのがおすすめです（初回パスワードのログ探しが不要になります）。

4. あとは次の **3.5 章**のとおり、管理者 PowerShell で `npm run service:install` すれば完了です。

---

## 3.5 Windows サービスにして常駐させる（おすすめ）

3 章の方法はターミナルを閉じるとサーバーが止まります。
**Windows サービス**として登録すると、ターミナル不要・PC 再起動後も自動起動になります。

### 登録手順（初回のみ）

1. まだなら Web フロントをビルドしておきます。

   ```powershell
   npm run build:web
   ```

2. **PowerShell を「管理者として実行」で開きます**（スタートメニューで PowerShell を右クリック →「管理者として実行」）。サービスの登録には管理者権限が必要です。

3. `D:\Github\ToDo` に移動して登録コマンドを実行します。

   ```powershell
   cd D:\Github\ToDo
   npm run service:install
   ```

   「インストールしました。起動します...」と出れば完了です。
   サービス名は **TodoTeamServer** で、Windows の「サービス」一覧（`services.msc`）にも表示されます。

4. ブラウザで `http://localhost:4577` を開いて動作確認します。

> 💡 ポートやパスワードなどの設定は **`server\.env` ファイル**に書くのがおすすめです（[3.4 章](#34-別のサーバー-pc-で動かすとき何を持っていくか)の手順 3）。
> `.env` はサーバー起動のたびに読み込まれるため、内容を変えたら `services.msc` から TodoTeamServer を**再起動するだけ**で反映されます（サービスの再登録は不要）。
>
> 環境変数（`$env:PORT = "8080"` など）でも指定できますが、その場合はインストール時点の値がサービスに焼き込まれ、変更には再登録が必要です。両方ある場合は環境変数が優先されます。

### 起動・停止・解除

| やりたいこと | 方法 |
| --- | --- |
| 状態確認・手動の開始/停止 | `services.msc` を開いて「TodoTeamServer」を操作（または管理者 PowerShell で `Start-Service TodoTeamServer` / `Stop-Service TodoTeamServer`） |
| サービス登録の解除 | 管理者 PowerShell で `npm run service:uninstall`（データベースは消えません） |
| ログの確認 | `server\service\daemon\` フォルダに出力されます（初回管理者パスワードのログもここ） |

> ⚠️ サービス運用で初回起動した場合、ランダム生成される管理者パスワードはターミナルではなく
> `server\service\daemon\` 内のログファイルに出力されます。控え忘れに注意してください。
> 確実なのは、登録前に `server\.env` で `ADMIN_PASSWORD=...` を決めておく方法です。

---

## 3.6 既に動いているサーバーを更新する

更新時に置き換える実行物は、基本的に次の2か所です。

| 置き換えるもの | 内容 |
| --- | --- |
| `server\src\` | API、DB処理、通知などのサーバープログラム |
| `dist-web\` | `npm run build:web` で生成したブラウザ画面。ハッシュ付きファイルがあるため、フォルダ単位で丸ごと置き換える |

次のものは運用データやサーバー固有設定なので、**上書き・削除しません**。

- `server\data\`（SQLiteデータベース）
- `server\.env`（ポート、データ保存先、初期管理者設定など）
- `server\node_modules\`（サーバーPCでインストールした依存）
- `server\service\daemon\`（サービスラッパーが生成した実行物）

今回の更新では通知設定とタスク購読用のテーブルを追加します。サービス起動時に `CREATE TABLE IF NOT EXISTS` で自動追加されるため、手動のマイグレーションコマンドは不要です。依存パッケージは変更していないため、サービスの再登録や `npm install` も不要です。

`TODO_WEB_DIST` を `.env` で変更している場合、以下の `dist-web\` はその指定先に読み替えてください。

### 方法A：サーバーPCでGit更新・ビルドする

ルートの依存パッケージがサーバーPCにも入っている場合の手順です。管理者PowerShellで実行します。

```powershell
cd D:\Github\ToDo
Stop-Service TodoTeamServer

# 停止中にDBディレクトリ全体をバックアップする（todo.db / WAL / SHMを含む）
$backupDir = "D:\TodoBackup\$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Path $backupDir -Force
Copy-Item server\data $backupDir -Recurse

git pull --ff-only origin main
npm run build:web

Start-Service TodoTeamServer
$port = 4577 # server\.env の PORT を変更している場合は合わせる
Invoke-RestMethod "http://localhost:$port/api/health"
```

最後のコマンドで正常なレスポンスが返れば、サーバー起動と起動時DB拡張は成功しています。ブラウザを `Ctrl + F5` で再読み込みし、ログイン、通知設定、タスク詳細の購読ボタンまで簡易確認してください。

> `TODO_DATA_DIR` を `.env` で変更している場合、バックアップ元は `server\data` ではなく指定した保存先ディレクトリに置き換えてください。必ずサービス停止後にフォルダ単位でコピーします。

依存パッケージが変更された更新では、ロックファイルに応じて追加で次を実行します。

```powershell
# server\package-lock.json が変わった場合
npm --prefix server ci

# ルート package-lock.json が変わり、サーバーPCでWeb画面をビルドする場合
npm ci
```

### 方法B：開発PCでビルドして成果物をコピーする

サーバーPCへルートのElectron／フロント依存を入れたくない場合はこちらが軽量です。

1. 開発PCのリポジトリで `npm run build:web` を実行する。
2. サーバーPCで `Stop-Service TodoTeamServer` を実行する。
3. 停止中にサーバーPCの `TODO_DATA_DIR`（既定 `server\data\`）をフォルダごとバックアップする。
4. 開発PCの `server\src\` で、サーバーPCの `server\src\` を置き換える。
5. 開発PCの `dist-web\` で、サーバーPCの実際の配信先（既定 `dist-web\`、`TODO_WEB_DIST` 設定時はその場所）を**フォルダごと**置き換える。
6. サーバーPCで `Start-Service TodoTeamServer` を実行する。
7. 実際の `PORT` に対する `/api/health` と、ブラウザの `Ctrl + F5` で確認する。

`dist-web\assets\` 内はファイル名がビルドごとに変わります。古いファイルを残した部分コピーではなく、必ず `dist-web\` 全体を置き換えてください。

### 問題が起きた場合の戻し方

サービスを停止し、更新前に退避した `server\src\` と実際のWeb配信先を戻してからサービスを開始します。今回のDB変更はテーブル追加のみなので、旧プログラムは追加テーブルを無視でき、通常はDBを戻す必要はありません。完全に更新前へ戻す場合やデータに問題がある場合は、サービス停止中に `TODO_DATA_DIR` をバックアップ一式から復元してください。

---

## 4. 管理者アカウントと初回パスワード

データベースにユーザーが 1 人もいないとき（＝いちばん最初の起動時）だけ、
**管理者アカウントが自動で 1 つ**作られます。

- ユーザー名: 既定は `admin`
- パスワード: 環境変数 `ADMIN_PASSWORD` を指定していなければ、**ランダム生成されて起動ログに 1 回だけ表示**されます。

初回起動時、サーバーのターミナルに次のように出ます。

```
[auth] 初期管理者アカウントを作成しました
[auth]   ユーザー名: admin
[auth]   初期パスワード: （ここにランダムなパスワード）
[auth]   ※このパスワードは今だけ表示されます。ログイン後に変更してください。
```

> ⚠️ **この初期パスワードは一度きりの表示です。** 必ずメモしてください。
> 万一控え忘れたら、[トラブル対応](#パスワードを忘れた--初期パスワードを控え忘れた)を参照。

### 自分でパスワードを決めたい場合

起動する**前に**、同じターミナルで環境変数をセットしてから起動します（PowerShell）。

```powershell
$env:ADMIN_PASSWORD = "好きなパスワード"
npm run start:server
```

この場合、ログにはパスワードは表示されず「環境変数で設定済み」と出ます。

---

## 5. メンバーを追加する

このアプリは**自己登録（サインアップ）はありません**。アカウントは管理者が発行します。

1. 管理者アカウントでログインする
2. 画面の**設定**を開く
3. 「**ユーザー管理**」（管理者にだけ表示されます）を開く
4. メンバーの追加・編集・権限変更・パスワード再設定ができます

---

## 6. データの保存先

- サーバー版のデータベースは `server\data\todo.db` に作られます。
- バックアップしたいときは、サーバーを止めてから `server\data\` フォルダごとコピーしてください。

> 📌 **デスクトップ版（Electron）とはデータが別物です。**
> デスクトップ版は `D:\Github\ToDo\data\todo.db`、サーバー版は `server\data\todo.db` を使います。
> 両者は同期しません。Web 版で入れたタスクはデスクトップ版には出てきません（逆も同様）。

### デスクトップ版の DB をサーバー版へ取り込む場合

デスクトップ版で使っていた `todo.db` は、管理者だけがサーバー版へ取り込めます。
取り込みは**一方向のコピー**です。取り込んだ後にデスクトップ版と自動同期されるわけではありません。

画面から取り込む場合:

1. 管理者アカウントで Web 版にログインする
2. **設定**を開く
3. **デスクトップDBを取り込む**を開く
4. デスクトップ版の `todo.db` を選び、取り込み先メンバーを選択する
5. まず **ドライラン（確認のみ）** で件数を確認し、問題なければ **取り込みを実行**する

コマンドで取り込む場合は、サーバーを止めてから実行します。

```powershell
# 件数だけ確認
npm run import:db -- --db "D:\Github\ToDo\data\todo.db" --user kenji --dry-run

# 実際に取り込む
npm run import:db -- --db "D:\Github\ToDo\data\todo.db" --user kenji
```

`--user` には、先に Web 版の「ユーザー管理」で作成したユーザー名を指定します。
取り込まれたタスク、サブタスク、作業ログ、予定は、そのメンバーのデータとして登録されます。

---

## 7. 設定を変えたいとき（.env ファイル / 環境変数）

既定のままで問題なければ読み飛ばして構いません。変えたいときは、次の 2 つの方法があります。

**方法 1（おすすめ）: `server\.env` ファイル**

`server\.env.example` を `server\.env` という名前でコピーして編集します。サーバー起動のたびに読み込まれるので、サービス運用でも再起動だけで反映されます。

```powershell
Copy-Item server\.env.example server\.env
notepad server\.env
```

**方法 2: 環境変数** — 起動前に `$env:変数名 = "値"` でセットします。`.env` と両方ある場合は環境変数が優先されます。

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `PORT` | `4577` | サーバーの待ち受けポート |
| `TODO_DATA_DIR` | `server\data` | データベースの保存先フォルダ |
| `TODO_WEB_DIST` | `dist-web` | 配信する Web ビルドの場所 |
| `ADMIN_USERNAME` | `admin` | 初回に作る管理者のユーザー名 |
| `ADMIN_PASSWORD` | （空） | 管理者の初期パスワード。未設定ならランダム生成 |
| `SESSION_TTL_DAYS` | `30` | ログインの有効日数 |

例（ポートを 8080 に変える）:

```powershell
$env:PORT = "8080"
npm run start:server
```

> 💡 開発モードで `npm run dev:web` も使う場合、Web フロントのプロキシ先は既定で `4577` です。
> サーバーを別ポートで起動するなら、`npm run dev:web` を叩く前に `$env:SERVER_PORT = "8080"` のように指定してください。

---

## 8. コマンド早見表（すべて `D:\Github\ToDo` で）

| やりたいこと | コマンド | 使うフォルダ |
| --- | --- | --- |
| 初回：フロント依存 | `npm install` | `D:\Github\ToDo` |
| 初回：サーバー依存 | `npm --prefix server install` | `D:\Github\ToDo` |
| 開発：サーバー起動 | `npm run dev:server` | `D:\Github\ToDo` |
| 開発：フロント起動 | `npm run dev:web` | `D:\Github\ToDo` |
| 本番：ビルド | `npm run build:web` | `D:\Github\ToDo` |
| 本番：サーバー起動 | `npm run start:server` | `D:\Github\ToDo` |
| 本番：サービス登録（管理者 PowerShell） | `npm run service:install` | `D:\Github\ToDo` |
| 本番：サービス解除（管理者 PowerShell） | `npm run service:uninstall` | `D:\Github\ToDo` |
| 管理者：デスクトップDB取り込み | `npm run import:db -- --db "<todo.dbのパス>" --user <Webのユーザー名>` | `D:\Github\ToDo` |

| モード | アクセス先 |
| --- | --- |
| 開発（自分の PC で確認） | `http://localhost:5273` |
| 本番（チームで利用） | `http://<サーバーのIP>:4577` |

---

## トラブル対応

### `EADDRINUSE: address already in use :::4577`（ポートが使用中）

すでにサーバーが別のターミナルで起動しています。古いほうを止めます。

```powershell
# 4577 を使っているプロセスを調べる
Get-NetTCPConnection -LocalPort 4577 | Select-Object -ExpandProperty OwningProcess

# 出てきた数字（PID）を止める
Stop-Process -Id <PID> -Force
```

5273 が埋まっている場合も、ポート番号を `5273` に変えて同じことをします。

### `Cannot find module ... src\index.ts` / コマンドが見つからない

たいていは**フォルダ違い**です。`pwd` で `D:\Github\ToDo` にいるか確認してください。
違っていたら `cd D:\Github\ToDo` で戻ります。

### 他の PC からつながらない（本番モード）

- サーバー側 PC で `npm run start:server` が動いたままか確認
- Windows ファイアウォールの許可ダイアログで「プライベートネットワーク」を許可したか確認
- アクセス先の IP が正しいか（`ipconfig` の IPv4 アドレス）を再確認
- 両方の PC が**同じ社内 LAN / Wi‑Fi** につながっているか確認

### パスワードを忘れた / 初期パスワードを控え忘れた

- 他の管理者がいれば、その人の「ユーザー管理」から再設定できます。
- 管理者が自分だけで控え忘れた場合は、サーバーを止めて `server\data\todo.db` を別の場所に退避（または削除）してから起動し直すと、ユーザー 0 人の状態になり管理者が再度自動作成されます（**既存データは消えるので注意**。退避したファイルは残しておけば後で戻せます）。

### `npm install` がエラーになる

`better-sqlite3` のネイティブビルドに失敗している可能性があります。
Node.js のバージョン（v20 以上）を確認し、もう一度 `npm install` を試してください。

---

## まとめ（最短手順）

**自分の PC で試すだけ:**

```powershell
# 初回だけ
npm install
npm --prefix server install

# 毎回（ターミナル 2 つ）
npm run dev:server   # ターミナル1
npm run dev:web      # ターミナル2
# → ブラウザで http://localhost:5273
```

**チームに公開する:**

```powershell
npm run build:web
npm run start:server
# → みんなは http://<あなたのIP>:4577
```

すべて `D:\Github\ToDo` で叩く。これだけ覚えておけば大丈夫です。
