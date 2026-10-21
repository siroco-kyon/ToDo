# HTMLガイドの確認記録

確認日：2026年10月21日。PCで読む添付資料として作成。利用者の追加指定により、スマートフォン版は作成・評価の対象外とした。

## 書き直した本文

[HTMLガイド](../index.html)が配布用の本文。[guide-text.txt](../guide-text.txt)は、そのHTMLから検査用に抽出した文章。ソースは[guide.template.html](../guide.template.html)。本文、画像、SVG、スタイル、操作用JavaScriptを内蔵している。

## 変えたところ

- 利用者と準備担当者を分け、個人用で試す、管理者が取り込む、チームで使う、ビルド・配置、運用の順に案内した。
- 初回レビュー後、最初のタスク追加と投稿、設定を開く場所、依存関係を追加する操作を具体化した。「説明」「メモ」「進捗ログ」の用途も区別した。
- Node.jsの選択項目と、同梱する起動・運用ガイドの正式名・原本へのリンクを補った。
- 操作対象と結果を近づけ、間を作るだけの読点を整理した。手順に必要な「ます」の連続は、語尾を散らす目的で変えなかった。
- 手動のデータ取り込みは静止SVG、チーム利用中の通信は6秒ループのSVGに分けた。トラフィック、発光、アイコンだけを動かし、文字は静止させた。

## 事実の確かめ

確認した主な値と主張は次の10項目。リポジトリの実装と資料は[照合資料](../guide-text.txt.material.txt)に保存した。

| 項目 | 根拠と扱い |
|---|---|
| 個人用とチームの保存先 | `docs/HAKOBI.md`、`src/main/config.ts`、`server/src/config.ts`。個人用にサーバーは不要、チームはサーバーDBを使用。 |
| 接続の切り替えと取り込み | `HakobiLauncher.tsx`、`DesktopImportModal.tsx`。切り替えだけで個人データを移す操作ではない。 |
| 管理者・取り込み先 | `DesktopImportModal.tsx`。ドライランと実行を区別。取り込み先メンバーを選ぶ。 |
| 担当・投稿者・同じID | `import-desktop-db.ts` の説明：`all desktop authors / reaction actors become the target web user.`、`already-imported rows are left untouched.`。同じIDの登録済みデータは更新しない。 |
| 取り込み対象外 | 同処理の `RunningState (a transient running timer) and Settings are skipped.` と、DBファイルだけをアップロードする画面。個人用の設定・実行中タイマー・アイコン画像の移行とは扱わない。 |
| ビルド時のNode.js | `@electron/rebuild` の `engines.node` は `>=22.12.0`。ガイドは保守中の22系を選ぶ案内。Node.js公式ダウンロードページとリリース予定も参照。 |
| コマンドと出力 | ルート・serverの `package.json` と `electron-builder.yml`。dist、build:web、start:server、publish:desktop、service:installを照合。 |
| 既定の接続先・管理者 | `server/src/config.ts`、`auth.ts`。4577、admin、初回のランダムパスワード。localhostと他PC向けIPv4を分けた。 |
| バックアップ | `config.ts`、`docs/HAKOBI.md`。既定は1日1つ・14日分、設定画面のダウンロード、停止中の復元。 |
| サービスとLAN | `server/service/install.cjs`、`config.cjs`、運用ガイド。既定名TodoTeamServer。手動起動との重複を避け、社内LANだけを案内。 |

検査が挙げた資料にない数値・名前53件は、英語の見出し、日付、章番号、作業フォルダの例、追加したHTML/GIFの名前やブラウザの操作名、Node.jsの選択表記など。プログラムの値・UI名・ユーザーが指定した6秒周期・作成したファイル・例示を区別して確認した。更新で架空の改善率や所要時間は追加していない。「手間を減らせます」は同じ仕事の記録から相談する使い道の説明であり、効果を実測したという主張ではない。

新規Windowsへの開発ツール導入、クリーン環境のnpm install、実際のインストーラー生成・インストール、物理的な別PCからのLAN接続、ファイアウォール変更、Windowsサービスの実登録、本番DBの取り込み・復元は今回実行していない。

## 独立評価と動作確認

- [初稿レビュー](initial-review.md)は92点。[最終レビュー](final-review.md)は96点（20・19・19・19・19）。同じ基準と配点を使用した。AIによる読者役評価であり、実利用者調査や効果測定ではない。
- 通常PCの全節を開いた20スクロール画像、1024px幅、125%ズーム表示を確認。ブラウザの読順切り替え、場面切り替え、画像拡大、パス・URLの生成、入力エラー、アニメーション停止・再生、チェック保存と再読込を検査。画像・内部リンク正常、コンソールエラーなし。[ブラウザ検査結果](browser-check.json)。
- 独立評価側でインポート回帰8件、サーバーの配置試験、サービス設定試験が成功。これを実環境の新規導入や実サービス登録の成功とは扱わない。
- 印刷用スタイルのPDF生成も確認（15ページ、検査用）。配布の主成果物はHTML。
- GIFは90フレーム、6000ms、loop=0（無限）。SVGの0秒と6秒は同じ画像で、途中は異なる。文字を置いた5領域のピクセルは全フレームで一致。[アニメーション検査結果](animation-check.json)。
- 配布ZIPは整合性正常。HTML・SVG・GIFの同封内容は単体の最終ファイルと一致する。

## 最終ファイルの照合

| 対象 | SHA-256 |
|---|---|
| index.html | `a1f7f8b26bed3fdbdf1935245298989048ce3948be64c47268f42f8d52525ca2` |
| guide-text.txt | `6ca72378ea220811dbb92568c081aa15cdedf8e4d96bf5ed7d95f164fcd0f08d` |
| team-traffic.svg | `85def352b0df8b908916549ee106aebad9cd08be91169cccd633720ac694ff98` |
| team-traffic.gif | `8cbaee3fbc9669dff64a1f5e5a9a0435dc7f4594c5aa629bbf717eb5fb6f4cd9` |

## 確認の記録

- 書き手・読み手・場面: 書き手: 決めていない／読み手: Web初心者（指定）、general（推定）／場面: manual（推定）
- 実行した検査: lint、資料との照合、最終稿の照合
- 実行しなかった検査: diff（新規作成のため比較する原文なし）
- 見直し候補: 最終稿14件（件数は点数ではなく、読みやすさの良し悪しを示さない）
- 説明・手順として自然な「ます」の連続と、資料の用語に沿う「版」は残した。
- yomiyasu-check: executed via=verify run=20261021T115055Z-84101ded attempt=3 final=sha256:6ca72378ea22 mode=compose doc_type=manual reader=general checks=lint,materials meaning_risk=53 replay=skipped

抽出テキストの末尾の余分な空行だけを正規化した後も再照合した。配布HTMLの文言とハッシュは変わっていない。HTMLの本文抽出結果を対象に検査し、抽出本文と配布HTMLのハッシュを上記に固定した。スクリプトの実行は、意味の保持や読みやすさの合格を自動的に示すものではない。
