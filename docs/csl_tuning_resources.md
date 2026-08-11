# BMW E46 M3 ECU (MSS54 / MSS54HP) CSL Tuning & Development Resources

NAM3Forumに投稿されたBMW E46 M3（MSS54 / MSS54HP DME）におけるCSLコンバージョン、バイナリ解析、コミュニティパッチ（Community Patch）、および開発ツールに関するリソース分類リストです。

> **関連文書:** [軽量フライホイール装着車のドライバビリティ・チューニング](lightweight_flywheel_tuning.md)
> — 回転慣性を下げたときに崩れる制御ループを、XDF・Ghidra 逆アセンブル・Funktionsrahmen の
> 突き合わせからパラメータ定義名とアドレスのレベルで洗い出した解析。データログ戦略を含む。

---

## 1. CSL換装車向け ストリートチューニング＆ドライバビリティ向上
E46 M3へCSLエアボックスおよびMAPセンサー等を移植（CSL Conversion）した際の、実効的なストリートチューニング手法、ログ解析、ドライバビリティ改善に関する投稿群です。

* **[1-1] 空燃比補正とチューニング基本コンセプト**
  * **概要:** CSL仕様における燃油補正の基本理念と調整アプローチの説明
  * **URL:** https://nam3forum.com/forums/forum/special-interests/coding-tuning/242281-a-quick-and-easy-way-to-street-tune-your-csl-conversion-for-drivability?p=308010#post308010

* **[1-2] O2センサーフィードバックとMAP/Alpha-Nマップ調整**
  * **概要:** O2センサーによるフィードバックデータを用いた燃調テーブルの具体的な修正手順
  * **URL:** https://nam3forum.com/forums/forum/special-interests/coding-tuning/242281-a-quick-and-easy-way-to-street-tune-your-csl-conversion-for-drivability?p=308139#post308139

* **[1-3] アイドル時・スロットル微開度のレスポンス改善**
  * **概要:** 低回転・低負荷域における街乗り時の乗りやすさ（ドライバビリティ）向上手法
  * **URL:** https://nam3forum.com/forums/forum/special-interests/coding-tuning/242281-a-quick-and-easy-way-to-street-tune-your-csl-conversion-for-drivability?p=308182#post308182

* **[1-4] 吸気温（IAT）・MAPセンサー補正影響の検証**
  * **概要:** 吸気温度補正や圧力センサーの補正係数が制御に及ぼす影響の分析
  * **URL:** https://nam3forum.com/forums/forum/special-interests/coding-tuning/242281-a-quick-and-easy-way-to-street-tune-your-csl-conversion-for-drivability?p=314133#post314133

* **[1-5] ロギングデータに基づく燃料トリム（LTFT/STFT）評価**
  * **概要:** 走行ログから取得した長期・短期燃料補正値の解析とフィードバック手法
  * **URL:** https://nam3forum.com/forums/forum/special-interests/coding-tuning/242281-a-quick-and-easy-way-to-street-tune-your-csl-conversion-for-drivability?p=317769#post317769

* **[1-6] 特定回転数・負荷域での点火＆燃料マップ微調整**
  * **概要:** 常用域から高負荷域にかけての点火時期とMAP補正テーブルの調整例
  * **URL:** https://nam3forum.com/forums/forum/special-interests/coding-tuning/242281-a-quick-and-easy-way-to-street-tune-your-csl-conversion-for-drivability?p=317857#post317857

* **[1-7] ストリートテストに基づく推奨設定値とまとめ**
  * **概要:** 実走行テストの結果を踏まえた設定値の要約とQA
  * **URL:** https://nam3forum.com/forums/forum/special-interests/coding-tuning/242281-a-quick-and-easy-way-to-street-tune-your-csl-conversion-for-drivability?p=317859#post317859

---

## 2. CSL '0401' プログラムバイナリの逆アセンブル・解析
MSS54HP DME用の純正CSLファームウェア（Version 0401）に関する内部構造・メモリマップ・動作ロジックの解析ノートです。

* **[2-1] CSL 0401バイナリのメモリマップ解析**
  * **概要:** 0401プログラムバイナリの基本構造および各制御ブロックのアドレス特定
  * **URL:** https://nam3forum.com/forums/forum/special-interests/coding-tuning/287069-csl-0401-program-binary-disassembly-notes?p=316510#post316510

* **[2-2] 通信プロトコル・RAM変数のアドレス特定**
  * **概要:** DS2通信用フレームおよびCANバス通信にて使用される内部変数の解析
  * **URL:** https://nam3forum.com/forums/forum/special-interests/coding-tuning/287069-csl-0401-program-binary-disassembly-notes?p=317928#post317928

* **[2-3] エラーコード読取・ブートローダー依存不具合の解析**
  * **概要:** 標準M3ブートローダー環境下でCSLコードを作動させた際のエラーコード不読問題（`K_FSP_CONCEPT` / `K_FR_T_ADAPT`）の不具合原因の特定
  * **URL:** https://nam3forum.com/forums/forum/special-interests/coding-tuning/287069-csl-0401-program-binary-disassembly-notes?p=340337#post340337

---

## 3. コミュニティ作成 パッチバイナリ＆統合ROM（Community Patch）
コミュニティの知見を集約し、各種不具合修正や機能拡張を盛り込んだ統合プログラムバイナリ配布用スレッドです。

* **[3-1] MSS54HP CSL '0401' Community Patch Binaries**
  * **概要:** 
    * 標準M3ブートローダー（2300）およびCSLブートローダー（2500）の両対応バイナリ配布
    * CAN経由でのオルタネータ状態信号（`GEN_ST`）送信機能追加
    * エラーコード読取機能の正常化（`K_FR_T_ADAPT` を `0x100` へ変更）
    * 排ガス検査端末との接続性修正およびDS2シリアルデータ修正
  * **URL:** https://nam3forum.com/forums/forum/special-interests/coding-tuning/343444-mss54hp-csl-0401-community-patch-binaries

---

## 4. ビルドジャーナル＆各種開発ツール
主要開発メンバー（karter16氏）による車両ビルド記録と、書き込みツール・ログ取得ツール開発に関する報告です。

* **[4-1] Karter16's Silbergrau E46 M3 Journal（フラッシャーツール開発報告）**
  * **概要:** 車両のカスタム日記に加え、安定したECU書き込み（Flasher）およびDS2ログ解析ツールの開発進捗報告
  * **URL:** https://nam3forum.com/forums/forum/main-forum/member-build-journals/269-karter16-s-silbergrau-e46-m3-journal?p=353130#post353130