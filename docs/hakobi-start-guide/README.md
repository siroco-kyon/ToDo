# HAKOBI はじめ方ガイド

紹介レポートを読んで使ってみたくなった人向けの、PCで読むHTMLの添付資料です。Windows（x64）で個人用を始め、管理者がデータをチームへ取り込み、社内LANで共同利用するまでを案内します。スマートフォン版は対象外です。

- [HTMLガイド](index.html)：画像・SVG・スタイル・操作を内蔵。単体でブラウザから開けます。
- [紹介資料と導入ガイドの配布セット](HAKOBI_紹介資料と導入ガイド.zip)：レポートPDF、HTML、SVG、GIF、起動・運用ガイド。
- [通信のSVG](team-traffic.svg)：トラフィック、到着先の発光、アイコンの小さな動きを6秒周期に統一。文字は静止。
- [同じ図のGIF](team-traffic.gif)：90フレーム、合計6000ms、無限ループ。
- [評価基準](review/criteria.md)、[初稿の評価](review/initial-review.md)、[初版の最終評価](review/final-review.md)、[機能ツアー追加後の評価](review/feature-tour-review.md)、[確認記録](review/validation.md)。

別エージェントによる同じ基準での評価は、初稿92点、初版96点、機能ツアー追加後96点／100点です。

導入手順の前に、ガント・依存関係・計画・カンバン・タイマー・記録・ToDoリスト・報告の8機能を紹介しています。機能ツアー追加時の画面例は12枚（11種類）。6枚は今回、架空データの一時DBで撮影した実画面です。使う場面と最初に試す操作を添え、クリックで拡大できます。

個人からチームへの取り込みは、一方向のコピーです。接続先の切り替えや、個人用DBとの継続的な同期とは区別して説明しています。HTMLの設定入力は、手順のパスとURLを変える機能です。PCの設定やサーバーへの接続・コマンド実行は行いません。

Windowsの「動きを減らす」設定が有効な場合、HTMLは静止した図から始まります。「アニメーションを再生する」で再生でき、再び止めることもできます。単体SVGも同設定に対応します。GIFはループ再生します。

2026年10月22日の紹介レポート改稿に合わせ、個人用の接続画面と個人用ガントを01へ反映しました。現在の画面例は13枚です。レポート側の同封HTMLも同じ内容で生成し、両配布ZIPにPDF・Word・HTMLをそろえています。[今回の出力確認](../hakobi-showcase/review/relaunch-validation.md)と[独立評価](../hakobi-showcase/review/relaunch-review.md)を参照してください。上記96点は機能ツアー追加時の評価記録です。

## 編集と再生成

本文・デザイン・動作の原稿は `guide.template.html`、通信図の原稿は `team-traffic.svg` です。画面例は `assets/` と既存の `docs/hakobi-showcase/assets/` の実画面を使います。新規画面の撮影元と切り出し座標は `assets/capture-info.json` に記録しています。PythonとPillow、ブラウザ検査にはリポジトリのElectronを使います。アプリの運用DBは開きません。

```powershell
# 機能紹介の画像を撮り直す場合
node docs/hakobi-start-guide/tools/capture_features.cjs
python docs/hakobi-start-guide/tools/crop_features.py

# HTMLと配布セットの生成
python docs/hakobi-start-guide/tools/build.py
node docs/hakobi-start-guide/tools/check.cjs --frames
python docs/hakobi-start-guide/tools/build_animation.py
python docs/hakobi-start-guide/tools/build.py
```

最後のビルドで、作成したGIFも配布セットへ同封します。`guide-text.txt` はHTMLから抽出した文章検査用の本文です。手作業で直さず、原稿HTMLから再生成します。コードの動作と文面は別に点検してください。

検査用の画像・フレーム・ブラウザの検査結果はGit管理外の `.build/` に出ます。通常PC、1024px幅、125%拡大、全節を開いた読了用画像を確認します。アニメーション検査はOSの「動きを減らす」を撮影時だけ無効化し、CSSとSMILを同じ時刻へ進めて撮影します。0秒と6秒の一致、途中との差、静止する文字の領域、GIFの総時間を検査します。

HTMLの説明は2026年10月21日時点です。新規Windowsへの開発ツール導入、実LANのファイアウォール変更、サービス登録、本番DBの取り込みや復元は環境に応じて別途確認してください。独立評価はAIによる読者役の評価であり、実利用者調査や導入効果の測定ではありません。
