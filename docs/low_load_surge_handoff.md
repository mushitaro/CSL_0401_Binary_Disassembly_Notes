# 引継ぎ — 微開（LLS）モードの実装

`docs/low_load_surge.md` の調査は終わっている。**これは次に手を動かす人のための作業指示書**で、
調査を読み直さなくても手順 1 に着手できるように書いてある。

| | |
|---|---|
| **対象** | `mss54hp-csl-convert-tuner` |
| **ブランチ** | `claude/low-rpm-steering-vibration-ku3f70`（両リポジトリとも） |
| **根拠** | `CSL_0401_Binary_Disassembly_Notes` `docs/low_load_surge.md` §9.8 – §9.11 |
| **今回やること** | §9.11 手順 **1 のみ** — 純関数と検証スクリプト。UI には触らない |

---

## 1. 一段落で — 何が起きていて、何を作るのか

E46 M3（CSL '0401'、CSL エアボックス無し）で、アクセルに足を乗せただけの**微開**で
**約 3 秒周期の大きなサージ（ぐわんぐわん）**が出る。速い方のガクガク（`kf_rf_soll_tau_up` で解決済み）とは別物。

微開ではスロットルは **0.0 % に固定**され（`egas_compute_throttle_target` が
`ML_SOLL_MAX_LLS` 未満の要求を全部アイドルバルブへ回す）、空気は全量バルブが運ぶ。
このとき生きている制御は `FR_REGLER`（純積分器）だけで、しかも `RF` は実測ではなく
**`kf_rf_soll` 自身の出力**（`k_rf_cfg` = 0x12）なので、**ループはモデルの中で閉じている**。

    FR → ML_SOLL_LLS → KF_LLS_TV → KL_AQ_ABS_LLS → kl_aq_rel_rf_fakt → kf_rf_soll → RF → FR

この一巡の傾きの積を**リング弾性 `e`** と呼ぶ。`e` が大きいほど交差周波数が上がり、
実測の一巡遅れ `Td` = 0.58 s に対して位相余裕が痩せ、0.3 Hz の外乱（舵を切る＝PAS 負荷）が増幅される。

**作るもの：`kf_rf_soll` を入力に `KF_LLS_TV` を逆引きし、`e` を 1 に均す純関数。**

---

## 2. 状態

| | |
|---|---|
| 調査ドキュメント | **完了・push 済み**（`059ac55`） |
| 実車での検証 | 手計算の表をユーザーが適用し「結構よくなりました」— **方向は確認済み** |
| 位相余裕 39.5° → 46.5° | **未検証**（2 本目のログ待ち） |
| TUNER 実装 | **未着手** ← ここから |

---

## 3. 番地（再導出しないこと）

すべて **master バンク**。64 KB 部分 BIN なので **XDF アドレス = ファイルオフセット**。
`public/data/calibration-graph.json` の node から取ったもので、**doc §9.9 の数値と一致を確認済み**。

| 記号 | 種別 | node | X 軸 | Y 軸 | Z |
|---|---|---|---|---|---|
| `kf_rf_soll` | map | `0xD2FE` | `0xD2FE` rpm ×20 | `0xD326` % `x*100/32768` ×24 | `0xD356` 24×20 |
| `KF_LLS_TV` | map | `0x9DE2` | `0x9DE2` rpm ×10 | `0x9DF6` kg/h `x/40` ×13 | `0x9E10` `x/50` 13×10 |
| `KL_AQ_ABS_LLS` | curve | `0xE014` | `0xE014` ×8 | `0xE024` ×8 | — |
| `kl_aq_rel_rf_fakt` | curve | `0xE058` | `0xE058` rpm ×12 | `0xE070` `X/32768` ×12 | — |
| `KL_FR_INEG` | curve | `0xDFDA` | `0xDFDA` `x/10000` ×8 | **`0xDFEA`** signed `x/(32768*16)` ×8 | — |
| `KL_FR_IPOS` | curve | `0xDFB8` | `0xDFB8` | `0xDFC8` | — |
| `K_AQ_ABS_MAX` | const | `0xE010` | — | — | 11918 qmm |
| `K_LLS_TV_MIN` | const | `0x9DAE` | — | — | 14 % |
| `K_LLS_TV_MAX` | const | `0x9DAC` | — | — | 97 % |

> **`KL_FR_INEG` の番地に注意。** カタログの node は `0xDFDA`（X 軸の先頭）だが、
> §9.9 §3 の `Ki` を読むのは **Y データの `0xDFEA`**。両者は 16 バイト離れている。
>
> **`KL_AQ_ABS_LLS` の X 軸のスケールに注意。** カタログの `math` は両軸とも `"X"` だが、
> **X 軸（デューティ %）は実際には生値 / 50**（`KF_LLS_TV` の Z 軸や `K_LLS_TV_MIN/MAX` と同じ）。
> **検算：`KL_AQ_ABS_LLS(49.0 %)` = 53.85。** 生値 / 100 と読むと軸が 4–50 % になり、
> §9.9-6 の手計算が再現しない。

**値はすべて XDF 表示値で扱う。生値は使わない。**

---

## 4. 既存コードで使えるもの — 作り直さないこと

| 要るもの | すでに在る | 場所 |
|---|---|---|
| 任意パラメータの復号 | `decodeParam(buffer, def)` | `src/lib/calibration/decode.ts` |
| カタログ（2529 param） | `public/data/calibration-graph.json` | `src/lib/calibration/catalog.ts` |
| `KF_LLS_TV` の読み出し | `readIdleTables(buffer)` → `IdleTables` | `src/lib/idle/idleTables.ts` |
| `KF_LLS_TV` の 2D 補間 | `interp2d(m, x, y)` / `llsTvAt(t, rpm, qsoll)` | 同上 |
| `KF_LLS_TV` の傾き | `llsTvSlopePctPerKgH(map, rpm, ml)` | `src/lib/idle/valveModel.ts` |
| `kf_rf_soll` の読み書き | `alphaNTable.ts` | `src/lib/ve-calculator/` |
| 検証スクリプトの型付き実行 | `node --experimental-strip-types --import ./scripts/ts-resolve.mjs` | `scripts/` |

**`KL_AQ_ABS_LLS` / `kl_aq_rel_rf_fakt` / `KL_FR_INEG` は、まだどこからも読まれていない。**
（`grep` で当たるのは DS2 のライブチャンネル `AQ_ABS_LLS` であって、マップではない。）
この 3 枚は**手書きのリーダを足さず `decodeParam` で取る**こと。`KF_LLS_TV` だけは
`readIdleTables` が既に `verify:valve-model` で固定されているのでそれを使う。

---

## 5. 手順 1 — 作るファイル

### `src/lib/lls/ringGain.ts`（純関数。サンプル不要、マップ → マップ）

doc §9.9 の写経。公開するのは次の 4 つで足りる：

```ts
// 一巡の合成関数  RF = G(ML)                                   ... §9.9-1
ringRf(tables, rpm, ml): number

// 弾性 e = dlnRF/dlnML   中心差分 h = 0.01·ml                   ... §9.9-2
ringElasticity(tables, rpm, ml): number

// 位相余裕  ωc = Ki·e·RF,  PM = 90° − ωc·Td·(180/π)            ... §9.9-4
phaseMargin(tables, rpm, ml, td): { omegaC, pmDeg, zeta, q }

// 逆引き  RF ∝ ML を課して KF_LLS_TV の行を書き直す            ... §9.9-5
solveLlsTv(tables, opts): { rpm, ml, before, after }[]
```

逆引きの規則（§9.9-5 / §9.9-7）：

- **アンカーは `ml` = 30 行**。据え置き、そこから `k = RF₃₀ / 30` を得る
- 各行 `RF_target = k · ml` → `kf_rf_soll⁻¹`（二分法）→ `q` → `A` → `KL_AQ_ABS_LLS⁻¹`（線形逆補間）
- `clamp(D, K_LLS_TV_MIN, K_LLS_TV_MAX)` = 14 – 97 %
- **書き換える行は 20 / 25 / 40 / 50。** 規則は「実測点が補間で読む区間の端点」で、
  それは 15/20/25/30/40/50 だが、**30 はアンカー、15 は逆引きが解けない**（§9.9-7a:
  全列が `K_LLS_TV_MIN` = 14 % に railed し、15–20 区間が −47° になる）
- `Ki` = **5.33 /s**（`KL_FR_INEG` の小誤差側。`RF` 誤差 0.015 の点）
- `Td` = **0.58 s**（Session 954 の `duty`×`rpm` 相互相関の第一ピーク。**measured、単点**）

### `scripts/verify-lls-ring.mjs` + `package.json` に `verify:lls-ring`

**この 3 つが通れば数値の正しさは確定する。**

| # | 再現するもの | 期待値 | 出典 |
|---|---|---|---|
| 1 | 手計算 1 セル | 950 rpm / 20 kg/h → **39.0 %**（現行 40.0 %） | §9.9-6 |
| 2 | 逆引き表 | §9.8 の表の **14 セル**（4 行 × 4 列のうち 800/50 と 1400/50 は変化なし） | §9.8 |
| 3 | 位相余裕（320 点） | 平均 **39.5° → 46.5°**、PM<30° が **25.3 % → 6.9 %** | §9.9-8 |
| 4 | 区間別 | **15–20 区間だけが 47.0° → 39.6° と悪化する** | §9.9-8a |

> **3 の母集団は 362 行ではなく `Road Speed` > 0 の 320 行**、`RF` は `kf_rf_soll` の
> 再評価ではなく**ログの `relative Fuellung`**。これを外すと現行側が 39.5° にならない。
>
> **4 は「直す」対象ではない。** 行 15 は逆引きが解けないので残る代償で、
> **数値が一致することを固定する**（消そうとすると全体が悪化する — §9.9-7a）。

**併せて固定すべき不変量**（回帰で落ちやすい所）：

- アンカー行（`ml` = 30）が**ビット単位で不変**であること
- 行 11 / 15 / 60 以上に**一切書かない**こと（15 は「読むが書かない」— §9.9-7a）
- `kf_rf_soll` を**読むだけで書かない**こと
- `KL_FR_INEG` を `0xDFEA` から読んでいること（`0xDFDA` だと X 軸を `Ki` と誤読する）

### 入力データ

| | |
|---|---|
| BIN（現行チューン） | `Tune_202609210645_DME_Read_1789709400476_PatchON_TEVOFF.bin` |
| BIN（TERRA 寄りに戻した物、`e` = 1.79 の比較対象） | `Tune_202609210744_..._PatchON_TEVOFF.bin` |
| ログ（86 s、8–11 km/h、362 行） | `Session_954_log.csv` |

`scripts/fixtures/` に置くか、既存の `analyze:*` と同じくパス引数で渡すか。
**`verify:*` は素のクローンで走る**のが house rule なので、**固定値は fixture に焼く**こと
（§3 の期待値は既にこのログ 1 本に依存している）。

---

## 6. その後（今回はやらない）

2. **モードの面** — `src/components/LlsPanel.tsx`、`src/lib/features.ts` に `lls: { stage: 'experimental', tabs: ['lls'] }`
3. **差の表示** — ハブに一行。`kf_rf_soll` を書いた直後に立ち、`KF_LLS_TV` を引き直せば消える

`KF_LLS_TV` の書き手は**微開モード 1 つに保つ**。現在 `src/lib/idle/tuner.ts` が書いているので、
モードを作る時点で**そちらからは外す**（`tsunagi-m-ux` §11「一つの仕事に一つの入口」）。

---

## 7. 未確定 — 断定しないこと

| 事項 | 状態 |
|---|---|
| 39.5° → 46.5° が実車で起きたか | **未測定。** 2 本目のログ（同じ左旋回）が要る |
| 15–20 kg/h 帯に残るサージ | **予測。** 補正後この区間が最悪部（39.6°）。次のログで最初に見る |
| `Td` = 0.58 s | measured だが**ログ 1 本の 1 動作点**。回転数と負荷で変わるはず |
| `rf_korr` = 1.0、`rf_p_saug_i` = 0 | **未測定。** 後者は加算なので比例目標を崩す（±2.5 %RF の権限） |
| `cfg_m.egas` = 0 @ 0x8012 | XDF の定義であって、コードから追った番地ではない |
| 弾性 = 1 という目標 | **authored。BMW の設計ではない**（TERRA は 1.79 で出荷されている） |

---

## 8. 次のログで足すチャンネル

直読で入れれば、モデルの中で閉じているループを外から確かめられる：

| 記号 | 番地 |
|---|---|
| `FR_REGLER` | `0x00FFE9F6` |
| `LLS_TV` | `0x00FFEF00` |
| `ML_SOLL` | `0x00FFD8FC` |
| `ML_SOLL_LLS` | `0x00FFD900` |

---

## 9. 家の規則

- `tsunagi-m-ux` — §1 存在ではなく比較から導く / §3 成果物の鎖 / §11 一つの仕事に一つの入口 / §15 出所表示 / §16 モードは常設
- `tsunagi-m-stack` — 検査コマンドと生成物の扱い
- 証拠の等級を必ず添える — code-confirmed / data-confirmed / computed / measured / inferred / authored
- **値は常に XDF 表示値。生値で会話しない。**
