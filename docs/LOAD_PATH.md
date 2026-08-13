# 負荷検出とベースマップ：標準M3 と CSL / Load Detection and the Base Map: standard M3 vs CSL

[日本語](#日本語) · [English](#english)

---

## 日本語

### 要点

標準（非CSL）の E46 M3 に「ベースマップ（Alpha-N / VEテーブル）」が見当たらないのは、**無くても成立する構造だから**です。CSL の `kf_rf_soll` が担っている「スロットル開度と回転数から充填量を決める」役割を、標準 M3 では **HFM（熱線式エアマスメータ）による実測**が担っています。

| | 標準 M3（1801 系） | CSL（0401） |
|---|---|---|
| 相対充填量 `RF` の出所 | HFM 実測 → `RF = ml/(Vh·ρ₀·0.5·n)` | `kf_rf_soll(N, aq_rel_rf)` × `rf_korr` + `rf_p_saug_i` |
| VE 相当のテーブル | **無し**（実測が代替） | `kf_rf_soll` = XDF に "the main volumetric efficiency table" と明記 |
| スロットル目標 | `KF_EGAS_WDK(n, rf_soll)` → wdk | 同じ（フラップ開時は `kf_egas_wdk_ask`） |
| ベースマップ誤差の吸収 | 充填制御器（PI）＋ 適応学習（HFM 基準） | MAP 由来の積分項 `rf_p_saug_i` と `rf_diag` のみ |

```
■ 標準 M3（HFM 実測が主経路）
  PWG → トルクマネージャ → md_rf_soll ──×FR_REGLER──→ ML_SOLL → RF_SOLL_WDK
                                                          │
                                             KF_EGAS_WDK(n, rf) → wdk_soll → EDK
                                                          ↓（物理）
  HFM → ml → RF = ml/(Vh·ρ₀·0.5·n) ──┬──→ 燃料・点火・トルク
                                       └──→ Füllungsregler(PI) ──→ FR_REGLER（上に戻る）

■ CSL 0401（HFM 無し。ベースマップが主経路）
  WDK → aq_abs → aq_rel → aq_rel_rf → kf_rf_soll(n, ·) → ×rf_korr → +rf_p_saug_i → RF → 燃料・点火・トルク
```

---

### 1. 標準 M3：ベースマップではなく HFM で「測る」

Funktionsrahmen `1.03 EVT Moment Realization` §1.12「空気質量流量→相対充填量の変換」に式そのものがあります。

```
RF = ml / (K_RF_HUBVOLUMEN × K_RF_LUFTDICHTE × 0.5 × n)
```

排気量・基準空気密度・回転数（4サイクルなので 0.5）で正規化するだけで、**充填効率マップは一切介在しません**。VE は測定値の中に既に含まれている、という考え方です。

0401 のコードにも同じ実装が残っています（`app/public/data/decomp/master/01a6b8.txt` の `saug_calc`）:

```c
ml_hfm1 = ml_hfm1_calc(ml_roh1);
rf_hfm1 = ml_hfm1 * rf_ml_const / n_temp;   // rf_ml_const = f(K_RF_LUFTDICHTE, K_RF_HUBVOLUMEN)
```

- HFM 電圧 → 空気質量：`KL_HFM_ML_U`（`hfm_ml_u_calc`, `master/01aac8.txt`）
- 妥当性判定：`K_HFM_DIAG_ML_MIN` / `K_HFM_DIAG_ML_MAX` → `DTC_29_MAF_SIGNAL`（`master/01aada.txt`）
- 噴射側も `rf_ti_const = K_RF_HUBVOLUMEN × K_RF_LUFTDICHTE × K_HFM_TI_RATE × 60`（FR `4.05`）で空気質量から直接 `ti` に落ちるため、やはり VE マップは不要

### 2. スロットル側の「ベースマップ」= `KF_EGAS_WDK`（ただし逆向き）

CSL の Alpha-N が「スロットル開度 → 充填量」なのに対し、標準 M3 が持つのは**その逆写像**です。FR `3.01 EGAS` §3.2 に明記されています。

| マップ | 内容 |
|---|---|
| `KF_EGAS_WDK` | 「Umsetzung rf_soll auf wdk」＝ 目標充填率 → スロットル開度（X: n, Y: rf, Z: %） |
| `KF_EGAS_WDK_KH` | 触媒暖機用 |
| `KL_EGAS_WDK_ENTDROSSELT` | 非絞り域用 |

0401 でも同じ構造です（`master/0270b0.txt` の `egas_compute_throttle_target`）：
`MD_RF_SOLL → ML_SOLL → RF_SOLL_WDK → KF_EGAS_WDK(N, RF_SOLL_WDK) → egas_wdk`。

つまり標準 M3 の「ベースマップ」は**負荷を測る表ではなく、目標トルクをスロットル開度に翻訳する表**です。ここが精度の要にならないのは、次の閉ループがあるためです。

### 3. 誤差を吸収する閉ループ（VE テーブルが要らない理由）

- **FR `2.02 Füllungsregler`（充填制御器）**：PI 制御器。`fr_rf_delta = 10 × rf − md_rf_roh` で、HFM から求めた実充填 `rf` と目標の偏差を取り、`md_rf_soll` を乗算補正。**I 分は `B_HFM_ERROR` 発生時にゼロ**と明記。
- **FR `2.03 Adaption Füllungsregler`（適応）**：「スロットルバルブの組付け・製造ばらつき（車両ごとのリーク空気量）に起因する定常偏差を補償し、**計算された目標制御と HFM で実測した充填量との差**を `ml_soll` の補正で解消する」。学習条件にも `!B_HFM_FEHLER` が入る（→ `ML_ADAPT` / `FRA_ML_OFFSET`）。

**モデル（`KF_EGAS_WDK`）がずれても実測（HFM）が真値を返し、PI ＋ 適応学習が吸収する。** これが「VE テーブルを持たなくても成立する」設計の核心です。

0401 では同じ `fr_calc`（`master/0253de.txt`）が残っていますが、I 分の停止条件が HFM ではなく `rf_diag_ed_st` に置き換わっています。リポジトリ内の注釈にも「In 1801 the below condition references HFM」とあり、標準側との差分がそのまま記録されています。

### 4. 密度補正は負荷モデルではなく別系統

大気圧・吸気温の補正は FR `1.04 Dichtekorrektur (DKR)` の系統で処理されます（基準 960 mbar / 20 ℃）。0401 では `rf_pt_korr_calc`（`master/01a5d6.txt`）が

```
RF_PT_KORR = KL_RF_P_UMG_KORR(p_umg) × KL_RF_TAN_KORR(tan)
```

を計算します。実機バイナリの値は FR `1.04` §3.3 の初期データとよく一致します。

| `KL_RF_P_UMG_KORR` (mbar) | 599 | 749 | 800 | 851 | 899 | 962 | 1040 | 1100 |
|---|---|---|---|---|---|---|---|---|
| 0401 実値 | 0.617 | 0.781 | 0.828 | 0.883 | 0.938 | 1.000 | 1.078 | 1.141 |
| FR 1.04 初期値 | 0.62 | 0.78 | 0.83 | 0.88 | 0.94 | 1.00 | 1.08 | 1.14 |

一方、吸気温側は 0401 で**明確に寝かされて**います（純密度比なら -40 ℃ で 1.26、0401 は 1.13）。Alpha-N マップ側に吸気加熱の影響が織り込まれているためと考えられます（推定）。

| `KL_RF_TAN_KORR` (℃) | -40 | -20 | 0 | 20 | 40 | 60 | 80 | 100 |
|---|---|---|---|---|---|---|---|---|
| 0401 実値 | 1.130 | 1.040 | 1.018 | 1.000 | 0.987 | 0.979 | 0.965 | 0.951 |
| FR 1.04 初期値 | 1.26 | 1.16 | 1.07 | 1.00 | 0.94 | 0.88 | 0.82 | 0.73 |

### 5. 標準ソフトにも Alpha-N 相当の表はある — ただし「代替マップ」扱い

FR `4.05 Nachspritzer`（後噴射）にこう書かれています。

> **Ersatzkennfeld `KF_RF_N_AQ_REL`**（＝代替特性マップ）を回転数と相対開口断面積 `aq_rel` に対して引き、1セグメントあたりの相対充填変化を計算する
> `rf_delta = KF_RF_N_AQ_REL(n, aq_rel) − KF_RF_N_AQ_REL(n, aq_rel_old)`

XDF でも `KF_RF_N_AQ_REL`（X: n, Y: aq_rel [%], Function: DKBA）として 0401 内に存在し、スレーブの `dkba_post_injection`（`slave/017d5e.txt`）が使っています。用途は限定的です。

1. **過渡補正**（加速増量・後噴射。HFM のセグメント平均は急開時に遅れる）
2. **EGAS 安全コンセプトの妥当性監視**（`RF_SK_WDK1/2`。XDF の `k_rf_sk_wdk_cfg` は「0 = rf_soll から導出 / 1 = AQ_REL から導出」と切替可能）

つまり標準 M3 でも「スロットル開度 × 回転数 → 充填量」の表は積んでいますが、**定常負荷の主経路ではありません**。CSL はこの脇役を主役に昇格させたもの、と理解すると綺麗に繋がります。

### 6. CSL '0401' との対比（実機バイナリで確認）

`Full 211323000401PD31_TERRA.bin`（XDF のアドレスはこのファイル先頭からのオフセットで一致）から読み出した値です。

| 定数 | アドレス | 実値 | 意味 |
|---|---|---|---|
| `k_rf_cfg` | 0xE5E4 | **0x12** | RF は `rf_soll`（Alpha-N, TABG 補正付き）＋ `rf_p_saug_i` |
| `k_rf_hfm_cfg` | 0xD202 | **0** | HFM 経路オフ |
| `K_RF_HUBVOLUMEN` | 0xD21C | **3.201 dm³** | 正規化に使う行程容積 |
| `K_RF_LUFTDICHTE` | 0xD21E | **1.136 kg/m³** | 基準空気密度（960 mbar / 20 ℃ に相当） |

`rf_calc`（`master/0218d0.txt`）の分岐がそのまま `k_rf_cfg` の意味です。

```c
if ((k_rf_cfg & 1) == 0) {
  if ((k_rf_cfg & 4) == 0) {
    RF = rf_soll * rf_korr;                 // Alpha-N（TABG 補正）
    if ((k_rf_cfg & 0x10) != 0) RF += rf_p_saug_i >> 6;   // MAP 由来の積分補正
  } else {
    RF = rf_hfm1;                           // HFM 経路（0401 では未使用）
  }
}
```

XDF の `k_rf_hfm_cfg` の説明も傍証になります：「0401 で HFM を使うにはハードウェア変更が必要で、さらに後続の変更によりこの config を 1 にしても動作しない」。

---

### 7. データログ比較の設計（標準 M3 ↔ CSL）

#### 7.1 `RF` は共通指標として使えるか → 使える。ただし意味は非対称

**数値としては同じ土俵です。** 両 ECU とも上記 2 定数だけで正規化し、分解能も 1/1000（`fr_calc` の `RF*10 − MD_RF_ROH` が `md_rf_roh` の 1/10000 と整合、FR `2.02` の変数表どおり）。下流の消費者（`KF_TI_N_RF`, `KF_TIENDE_N_RF`, `KF_MD_*_N_RF`, 点火マップ）も共通なので、**`RF = 1.000` が両車で同じ物理量**（基準密度での充填率 100 %）を指します。

S54 の実値を入れた換算式：

```
ml [kg/h]            = 0.1091 × n[rpm] × RF      … 3000 rpm, RF=0.5 → 163.6 kg/h
1気筒あたり [mg/行程]  = 606 × RF
```

標準 M3 側は `ML`（kg/h、LSB = 0.25 kg/h）が直接ログできるので、この式で `RF ↔ kg/h` を相互変換して突き合わせられます。

> ⚠️ 1801 側の `K_RF_HUBVOLUMEN` / `K_RF_LUFTDICHTE` は必ず自分の partial から確認してください。ここが違うと全域に一定オフセットが乗ります。

**ただし意味が非対称です。** 1801 の `RF` は実測、0401 の `RF` は校正値の読み出しです。CSL の Alpha-N がズレていても `RF` は「正しい顔」をします。**`RF` 差 ＝ 校正差であって、実空気量差ではありません。** これを補うため、CSL 側では「真値寄り」のチャンネルを同時にログして妥当性ゲートに使います。

| チャンネル | 役割 |
|---|---|
| **`rf_p_saug_i`** | MAP 由来の積分補正。**CSL 自身が見積もったベースマップ誤差**そのもの。ゼロから離れる領域＝ベースマップがずれている領域 |
| ラムダ制御の積分／適応（`LAA_REGLER1/2` 等） | 燃料側の帳尻 |
| `rf_diag_*` | RF 妥当性診断のステータス |

この 3 つが中立な区間だけを採用すれば、`RF` 比較は信頼できます。

#### 7.2 部分負荷の 3D 比較：軸は (N, WDK)、重ねるときだけ `aq_rel`

両車で物理的に同義なのは **N と WDK** だけなので、素直な比較面は `Z = RF over (N, WDK)` です。

さらに強力なのが、**標準 M3 のログから Alpha-N 面を実測で作る**こと。ログの `RF` を (n, aq_rel) でビニングすれば CSL の `kf_rf_soll` と同じ形の面になり、セル単位で引き算できます。

`aq_rel` の作り方（0401 実装 `master/0220ac.txt` の `rf_sk_wdk_calc`、実値付き）：

```
aq_abs    = KL_AQ_ABS_WDK(WDK) + AQ_ABS_LLS
aq_rel    = (aq_abs − K_AQ_ABS_MIN) / (K_AQ_ABS_MAX − K_AQ_ABS_MIN) × 32768
aq_rel_rf = aq_rel × 32768 / aq_rel_rf_fakt(n)
kf_rf_soll の Y 軸 [%] = aq_rel_rf × 100 / 32768
```

0401 の実値：

- `K_AQ_ABS_MIN` = 0（0xE00E）、`K_AQ_ABS_MAX` = 11918（0xE010）
- `KL_AQ_ABS_WDK`：WDK [0.1 %] 0 / 5.5 / 13 / 23 / 38 / 52 / 69 / 100 % → 面積 0 / 45 / 257 / 782 / 2014 / 3898 / 6250 / 11781
- `kl_aq_rel_rf_fakt`：900 rpm = 0.70 → 1300 = 0.75 → 1600 = 0.85 → **2400 rpm 以上 = 1.00**

> ⚠️ `KL_AQ_ABS_WDK` / `K_AQ_ABS_MAX` / `kl_aq_rel_rf_fakt` は校正ごとに違います。**各 ECU は自分の値で変換**してください。面倒なら比較軸は生の WDK（0.1 % 単位）にして、CSL ベースマップを重ねるときだけ `aq_rel` に変換するのが安全です。

その他、部分負荷比較で必須の条件：

- **定常のみ**：CSL の `rf_soll` は `kf_rf_soll_tau_up` / `k_rf_soll_tau_down` の一次遅れ、標準側はセグメント平均＋`K_RF_DYN_*`。`|dWDK/dt|`・`|dN/dt|` でゲートする
- **大気条件**：両者とも `RF_PT_KORR` が絡むが入り方が違う。`p_umg` と `tan` も併せてログして層別する
- **層別必須フラグ**：ASK フラップ（開くと `kf_rf_soll_ask` が加算＝別の面になる）、KATH 触媒暖機（`kf_rf_soll_kath` / `KF_EGAS_WDK_KH`）、AVAN1 暖機係数、DISA 位置、VANOS 角、TEV デューティ

#### 7.3 WOT の比較

VL では WDK が飽和して (n, wdk) 面が退化するので、**n 軸の 1 次元曲線**に落とします。

- `RF vs n @VL` は取れますが、0401 側はベースマップ最上段の読み値なので「CSL の想定曲線」。**実測と言えるのは 1801 側だけ**です
- WOT で両者とも "実測・実出力" として公平に比べられるのは：
  - **ZW**（点火角。ノック引き込み）
  - **λ**（目標／実測。全負荷増量は `KF_MD_MAX_LA_VL`）
  - **VANOS 吸排気角**
  - **TI**（噴射時間。インジェクタ定数が同一なら燃料流量の代理）
  - **TABG**（排気温モデル）
  - **同一ギヤでの dN/dt** ← 唯一の "結果" 指標。実トルクの代理として一番説得力がある
- CSL はスノーケルフラップで WOT 域の吸気系そのものが変わるため、フラップ状態で必ず分ける

#### 7.4 VL / TL / LL 閾値による分割

運転状態は `zustand_motor_calc`（`master/02c1e2.txt`）が WDK の閾値で決めます。0401 実機値：

**`KF_BZ_WDK_VL`（@0xAC54, X = n, Y = tmot, Z = %）**

| tmot ＼ n | 1300 | 2000 | 3000 | 4000 |
|---|---|---|---|---|
| 0 / 20 / 40 / 60 ℃ | 35.0 % | 55.0 % | 63.0 % | 65.0 % |

（この校正では温度依存なし。4000 rpm 以上は 65 % で頭打ち）

| 境界 | 条件 | 0401 実値 |
|---|---|---|
| TL → VL | `WDK > KF_BZ_WDK_VL(n, tmot)` | 上表 |
| VL → TL | `WDK < 閾値 − K_BZ_WDK_VL_HYST` | ヒステリシス **6.0 %**（@0xAC06） |
| LL → TL | `WDK ≥ KL_BZ_WDK_LL(n)` | **1.2 %**（3500–6000 rpm, @0xAC3A） |
| TL → LL | `WDK < 閾値 − K_BZ_WDK_LL_HYST` | ヒステリシス **0.2 %**（@0xAC04） |

VL 入りは他条件でも阻止されます：`TI_ST_HELP & 0x10`、`MD_BEGR_AUSS_ST ≠ 0`、`VAN_ED_ST & 0xF0`。

運用指針：

1. 可能なら **ECU の Betriebszustand（VL/TL/LL ビット）そのものをログして分割**する。推定より確実で、ヒステリシスも自動的に正しくなる
2. 取れないなら **各 ECU 自身の `KF_BZ_WDK_VL` で再計算**する。1801 と 0401 でこのマップは別校正なので、共通の固定 WDK % で切ると片方だけ誤分類する
3. **閾値の差そのものも比較結果の一部**なので、レポートには両車の閾値曲線を併記する
4. VL 境界は λ が閉ループ ↔ 全負荷増量に切り替わる境界でもあり（DISA 切替も VL 条件、FR `2.04`）、跨いだ平均は意味を持たない。**ヒステリシス帯（閾値 −6 % 〜 閾値）はグレーゾーンとして除外**するのが安全

#### 7.5 推奨ログセット

| 用途 | チャンネル |
|---|---|
| 共通軸 | N, WDK（0.1 %） |
| 主指標 | RF（標準側は ML [kg/h] も） |
| 妥当性ゲート | `rf_p_saug_i`, ラムダ適応, `rf_diag` |
| 出力側 | ZW, λ, VANOS, TI, TABG, dN/dt |
| 層別 | VL/TL/LL, ASK フラップ, KATH, DISA, 暖機係数, `p_umg`, `tan` |

---

### 8. 資料を読むときの注意

- 同梱の Funktionsrahmen は **MSS54 の EVT（電磁バルブトレイン実験機）版が混在**しています。`1.0 Momentenmanagement` / `1.03` / `1.04` は「充填をスロットルではなく**バルブ制御縁**で作る」前提で書かれており（`1.0` §12「EVT エンジンでは充填はスロットル角ではなく制御縁で行う」）、量産 M3 のスロットル経路を読むには `3.01 EGAS` / `2.02` / `2.03` / `4.05` 側を見る必要があります。
- 番号に欠番があり、**負荷検出（Lasterfassung / Füllungserfassung）そのものの章（2.01 相当）がこのセットに含まれていません**。そのため本稿の HFM → `RF` 変換式は `1.03` §1.12 とバイナリのコードから確定させています。XDF 側の Function 名 `Lasterfassung` に `K_RF_HUBVOLUMEN` / `K_RF_LUFTDICHTE` / `K_HFM_DIAG_*` が並ぶことも一致します。
- 本稿の数値は**すべて 0401（CSL）のバイナリ／XDF から読んだもの**です。標準 M3（1801）固有の数値はこのリポジトリに含まれていないため、比較に使う際は各自の partial から読み出してください。

### 9. 出典

| 主張 | 出典 |
|---|---|
| `RF = ml/(Vh·ρ₀·0.5·n)` | FR `1.03 EVT Moment Realization` §1.12 |
| HFM 実測 → `rf_hfm1` の実装 | `app/public/data/decomp/master/01a6b8.txt`（`saug_calc`） |
| `KF_EGAS_WDK` = rf_soll → wdk | FR `3.01 EGAS` §3.2 ／ `master/0270b0.txt` |
| 充填制御器（PI）と HFM 依存 | FR `2.02 Füllungsregler` ／ `master/0253de.txt` |
| 適応学習が HFM 基準 | FR `2.03 Adaption Füllungsregler` §1 / §1.1 |
| 密度補正（960 mbar / 20 ℃） | FR `1.04 Dichtekorrektur` §1.4, §3.3 ／ `master/01a5d6.txt` |
| `KF_RF_N_AQ_REL` は「Ersatzkennfeld」 | FR `4.05 Nachspritzer` §1 ／ `slave/017d5e.txt` |
| `k_rf_cfg` の意味と分岐 | XDF `k_rf_cfg` ／ `master/0218d0.txt`（`rf_calc`） |
| 運転状態の閾値 | `master/02c1e2.txt`（`zustand_motor_calc`）／ XDF `KF_BZ_WDK_VL` ほか |
| 実機定数値 | `Full 211323000401PD31_TERRA.bin` ＋ `XDF/CSL_0401_Karter16_v3_6_publish.xdf` |

---

## English

### Summary

The reason there is no obvious "base map" (Alpha-N / VE table) in the standard, non-CSL E46 M3 is that **it does not need one**. The job that `kf_rf_soll` performs on the CSL — deriving cylinder filling from throttle angle and engine speed — is performed on the standard M3 by **direct measurement with the HFM (hot-film air mass meter)**.

| | Standard M3 (1801 family) | CSL (0401) |
|---|---|---|
| Source of relative filling `RF` | HFM measurement → `RF = ml/(Vh·ρ₀·0.5·n)` | `kf_rf_soll(N, aq_rel_rf)` × `rf_korr` + `rf_p_saug_i` |
| VE-equivalent table | **None** (measurement replaces it) | `kf_rf_soll`, described in the XDF as "the main volumetric efficiency table" |
| Throttle target | `KF_EGAS_WDK(n, rf_soll)` → wdk | Same (`kf_egas_wdk_ask` when the flap is open) |
| How base-map error is absorbed | Filling controller (PI) + adaptation, both referenced to the HFM | Only the MAP-derived integral `rf_p_saug_i` and `rf_diag` |

```
■ Standard M3 (measurement is the main path)
  PWG → torque manager → md_rf_soll ──×FR_REGLER──→ ML_SOLL → RF_SOLL_WDK
                                                          │
                                             KF_EGAS_WDK(n, rf) → wdk_soll → EDK
                                                          ↓ (physics)
  HFM → ml → RF = ml/(Vh·ρ₀·0.5·n) ──┬──→ fuel / ignition / torque
                                       └──→ filling controller (PI) ──→ FR_REGLER (back up)

■ CSL 0401 (no HFM; the base map is the main path)
  WDK → aq_abs → aq_rel → aq_rel_rf → kf_rf_soll(n, ·) → ×rf_korr → +rf_p_saug_i → RF → fuel / ignition / torque
```

---

### 1. Standard M3: the load is measured, not modelled

Funktionsrahmen `1.03 EVT Moment Realization` §1.12 ("Conversion of air mass flow into relative filling") gives the formula directly:

```
RF = ml / (K_RF_HUBVOLUMEN × K_RF_LUFTDICHTE × 0.5 × n)
```

Normalisation by displacement, reference air density and engine speed (0.5 for a four-stroke) — **no volumetric-efficiency map is involved at all**. Volumetric efficiency is already contained in the measurement.

The same implementation survives in the 0401 code (`app/public/data/decomp/master/01a6b8.txt`, `saug_calc`):

```c
ml_hfm1 = ml_hfm1_calc(ml_roh1);
rf_hfm1 = ml_hfm1 * rf_ml_const / n_temp;   // rf_ml_const = f(K_RF_LUFTDICHTE, K_RF_HUBVOLUMEN)
```

- HFM voltage → air mass: `KL_HFM_ML_U` (`hfm_ml_u_calc`, `master/01aac8.txt`)
- Plausibility: `K_HFM_DIAG_ML_MIN` / `K_HFM_DIAG_ML_MAX` → `DTC_29_MAF_SIGNAL` (`master/01aada.txt`)
- Fuelling also goes straight from air mass to `ti` via `rf_ti_const = K_RF_HUBVOLUMEN × K_RF_LUFTDICHTE × K_HFM_TI_RATE × 60` (FR `4.05`) — again, no VE map

### 2. The throttle-side "base map" is `KF_EGAS_WDK` — and it runs the other way

Where the CSL Alpha-N map goes "throttle → filling", the standard M3 carries **the inverse mapping**. FR `3.01 EGAS` §3.2 names it explicitly:

| Map | Purpose |
|---|---|
| `KF_EGAS_WDK` | "Umsetzung rf_soll auf wdk" = target filling → throttle angle (X: n, Y: rf, Z: %) |
| `KF_EGAS_WDK_KH` | Cat-heating variant |
| `KL_EGAS_WDK_ENTDROSSELT` | Unthrottled region |

0401 has the same structure (`master/0270b0.txt`, `egas_compute_throttle_target`):
`MD_RF_SOLL → ML_SOLL → RF_SOLL_WDK → KF_EGAS_WDK(N, RF_SOLL_WDK) → egas_wdk`.

So the standard M3's "base map" is **not a table for measuring load — it is a table for translating requested torque into a throttle angle**. Its accuracy is not critical because of the closed loop below.

### 3. The closed loop that absorbs the error (why no VE table is needed)

- **FR `2.02 Füllungsregler`**: a PI controller. `fr_rf_delta = 10 × rf − md_rf_roh` compares the HFM-derived actual filling against the target and trims `md_rf_soll` multiplicatively. The document states that **the I term is zeroed on `B_HFM_ERROR`**.
- **FR `2.03 Adaption Füllungsregler`**: "to compensate for the stationary deviations caused by assembly and production variation of the throttle bodies (different leakage air in different vehicles) … the deviation between the calculated target and **the actual filling measured using the HFM** should be determined and remedied by correcting the calculated `ml_soll`." The enabling conditions include `!B_HFM_FEHLER` (→ `ML_ADAPT` / `FRA_ML_OFFSET`).

**Even if the model (`KF_EGAS_WDK`) is wrong, the measurement (HFM) returns the truth and the PI plus adaptation absorb the difference.** That is the core of the "no VE table required" design.

0401 keeps the same `fr_calc` (`master/0253de.txt`), but the I-term inhibit condition is `rf_diag_ed_st` instead of the HFM error. The in-repo annotation records the delta directly: *"In 1801 the below condition references HFM"*.

### 4. Density correction is a separate path, not part of the load model

Ambient pressure and intake-air temperature are handled by the `1.04 Dichtekorrektur (DKR)` family (reference 960 mbar / 20 °C). In 0401, `rf_pt_korr_calc` (`master/01a5d6.txt`) computes:

```
RF_PT_KORR = KL_RF_P_UMG_KORR(p_umg) × KL_RF_TAN_KORR(tan)
```

The binary values match the initial data in FR `1.04` §3.3 closely:

| `KL_RF_P_UMG_KORR` (mbar) | 599 | 749 | 800 | 851 | 899 | 962 | 1040 | 1100 |
|---|---|---|---|---|---|---|---|---|
| 0401 actual | 0.617 | 0.781 | 0.828 | 0.883 | 0.938 | 1.000 | 1.078 | 1.141 |
| FR 1.04 initial | 0.62 | 0.78 | 0.83 | 0.88 | 0.94 | 1.00 | 1.08 | 1.14 |

The temperature side, by contrast, is noticeably **flattened** in 0401 (a pure density ratio would give 1.26 at −40 °C; 0401 uses 1.13), presumably because charge-heating effects are already baked into the Alpha-N map (inference):

| `KL_RF_TAN_KORR` (°C) | -40 | -20 | 0 | 20 | 40 | 60 | 80 | 100 |
|---|---|---|---|---|---|---|---|---|
| 0401 actual | 1.130 | 1.040 | 1.018 | 1.000 | 0.987 | 0.979 | 0.965 | 0.951 |
| FR 1.04 initial | 1.26 | 1.16 | 1.07 | 1.00 | 0.94 | 0.88 | 0.82 | 0.73 |

### 5. The standard software does contain an Alpha-N table — as a *substitute* map

FR `4.05 Nachspritzer` (after-spray) states:

> From the **substitute map (Ersatzkennfeld) `KF_RF_N_AQ_REL`** over speed and relative opening cross-section, a relative filling change over one segment is calculated:
> `rf_delta = KF_RF_N_AQ_REL(n, aq_rel) − KF_RF_N_AQ_REL(n, aq_rel_old)`

`KF_RF_N_AQ_REL` (X: n, Y: aq_rel [%], Function: DKBA) is present in 0401 too and is used by `dkba_post_injection` on the slave (`slave/017d5e.txt`). Its uses are narrow:

1. **Transient correction** (acceleration enrichment, after-spray — the segment-averaged HFM signal lags a fast throttle opening)
2. **EGAS safety-concept plausibility** (`RF_SK_WDK1/2`; the XDF describes `k_rf_sk_wdk_cfg` as "0 = derived from rf_soll / 1 = derived from AQ_REL")

So the standard M3 does carry a "throttle × rpm → filling" table — but **not as the steady-state load path**. The CSL promoted this supporting actor to the lead role.

### 6. Comparison with CSL '0401' (verified against the binary)

Read from `Full 211323000401PD31_TERRA.bin` (the XDF addresses line up with offsets from the start of this file):

| Constant | Address | Value | Meaning |
|---|---|---|---|
| `k_rf_cfg` | 0xE5E4 | **0x12** | `RF` = `rf_soll` (Alpha-N with TABG correction) + `rf_p_saug_i` |
| `k_rf_hfm_cfg` | 0xD202 | **0** | HFM path disabled |
| `K_RF_HUBVOLUMEN` | 0xD21C | **3.201 dm³** | Swept volume used for normalisation |
| `K_RF_LUFTDICHTE` | 0xD21E | **1.136 kg/m³** | Reference air density (≈ 960 mbar / 20 °C) |

The branch in `rf_calc` (`master/0218d0.txt`) *is* the meaning of `k_rf_cfg`:

```c
if ((k_rf_cfg & 1) == 0) {
  if ((k_rf_cfg & 4) == 0) {
    RF = rf_soll * rf_korr;                 // Alpha-N with TABG correction
    if ((k_rf_cfg & 0x10) != 0) RF += rf_p_saug_i >> 6;   // MAP-derived integral trim
  } else {
    RF = rf_hfm1;                           // HFM path (unused in 0401)
  }
}
```

The XDF note on `k_rf_hfm_cfg` corroborates this: enabling the HFM on 0401 would require hardware changes, and subsequent changes make the config non-operable anyway.

---

### 7. Designing a datalog comparison (standard M3 ↔ CSL)

#### 7.1 Is `RF` usable as a common metric? Yes — but its meaning is asymmetric

**Numerically the two are on the same footing.** Both ECUs normalise with the same two constants, and the resolution is 1/1000 in both (`fr_calc`'s `RF*10 − MD_RF_ROH` is consistent with `md_rf_roh` at 1/10000, matching the variable table in FR `2.02`). The downstream consumers (`KF_TI_N_RF`, `KF_TIENDE_N_RF`, `KF_MD_*_N_RF`, the ignition maps) are shared, so **`RF = 1.000` denotes the same physical quantity on both cars** (100 % filling at reference density).

With the S54 values substituted:

```
ml [kg/h]              = 0.1091 × n[rpm] × RF     … 3000 rpm, RF = 0.5 → 163.6 kg/h
per cylinder [mg/stroke] = 606 × RF
```

The standard M3 logs `ML` (kg/h, LSB = 0.25 kg/h) directly, so this converts `RF ↔ kg/h` in both directions for cross-checking.

> ⚠️ Read `K_RF_HUBVOLUMEN` / `K_RF_LUFTDICHTE` from your own 1801 partial. If they differ, a constant offset appears across the whole range.

**But the meaning is asymmetric.** On 1801 `RF` is a measurement; on 0401 it is a calibration read-out. If the CSL Alpha-N map is wrong, `RF` still looks correct. **A difference in `RF` is a difference in calibration, not in actual airflow.** To compensate, log the "closer to ground truth" channels on the CSL side and use them as validity gates:

| Channel | Role |
|---|---|
| **`rf_p_saug_i`** | MAP-derived integral trim — literally **the CSL's own estimate of its base-map error**. Regions where it walks away from zero are regions where the base map is off |
| Lambda integrator / adaptation (`LAA_REGLER1/2` etc.) | Where the fuelling error actually lands |
| `rf_diag_*` | RF plausibility diagnosis status |

Accept only the intervals where all three are neutral, and the `RF` comparison becomes trustworthy.

#### 7.2 Part-load 3D comparison: use (N, WDK); convert to `aq_rel` only when overlaying

The only channels that mean the same thing physically on both cars are **N and WDK**, so the natural comparison surface is `Z = RF over (N, WDK)`.

A stronger move is to **build the Alpha-N surface empirically from a standard-M3 log**: bin the logged `RF` over (n, aq_rel) and you get an object of exactly the same shape as the CSL's `kf_rf_soll`, which can then be subtracted cell by cell.

How `aq_rel` is built (0401 implementation, `master/0220ac.txt`, `rf_sk_wdk_calc`):

```
aq_abs    = KL_AQ_ABS_WDK(WDK) + AQ_ABS_LLS
aq_rel    = (aq_abs − K_AQ_ABS_MIN) / (K_AQ_ABS_MAX − K_AQ_ABS_MIN) × 32768
aq_rel_rf = aq_rel × 32768 / aq_rel_rf_fakt(n)
Y axis of kf_rf_soll [%] = aq_rel_rf × 100 / 32768
```

0401 values:

- `K_AQ_ABS_MIN` = 0 (0xE00E), `K_AQ_ABS_MAX` = 11918 (0xE010)
- `KL_AQ_ABS_WDK`: WDK 0 / 5.5 / 13 / 23 / 38 / 52 / 69 / 100 % → area 0 / 45 / 257 / 782 / 2014 / 3898 / 6250 / 11781
- `kl_aq_rel_rf_fakt`: 0.70 at 900 rpm → 0.75 at 1300 → 0.85 at 1600 → **1.00 from 2400 rpm up**

> ⚠️ `KL_AQ_ABS_WDK` / `K_AQ_ABS_MAX` / `kl_aq_rel_rf_fakt` differ per calibration. **Convert each ECU with its own values.** If that is inconvenient, keep raw WDK (0.1 % units) as the axis and convert to `aq_rel` only when overlaying the CSL base map.

Other conditions that matter at part load:

- **Steady state only**: the CSL's `rf_soll` is first-order filtered by `kf_rf_soll_tau_up` / `k_rf_soll_tau_down`; the standard path has segment averaging plus `K_RF_DYN_*`. Gate on `|dWDK/dt|` and `|dN/dt|`
- **Ambient conditions**: `RF_PT_KORR` is involved on both sides but enters differently — log `p_umg` and `tan` and stratify
- **Mandatory stratification flags**: ASK flap (opening it adds `kf_rf_soll_ask` — a different surface), cat heating KATH (`kf_rf_soll_kath` / `KF_EGAS_WDK_KH`), AVAN1 warm-up factor, DISA position, VANOS angles, purge-valve duty

#### 7.3 WOT comparison

At VL the throttle saturates and the (n, wdk) surface degenerates, so reduce to a **one-dimensional curve over n**.

- `RF vs n @VL` is available on both, but on 0401 it is the top row of the base map — the CSL's *assumed* curve. **Only the 1801 side is a measurement.**
- Channels that are genuinely comparable at WOT (measurement or real output on both):
  - **ZW** (ignition angle, including knock retard)
  - **λ** (target/actual; full-load enrichment via `KF_MD_MAX_LA_VL`)
  - **VANOS** intake/exhaust angles
  - **TI** (injection time — a proxy for fuel flow if the injector constants match)
  - **TABG** (exhaust temperature model)
  - **dN/dt in a fixed gear** — the only genuine *outcome* metric, and the most convincing torque proxy
- The CSL's intake system itself changes with the snorkel flap in the WOT region, so always split by flap state

#### 7.4 Splitting the comparison at the VL/TL/LL thresholds

The operating state is decided from throttle-angle thresholds in `zustand_motor_calc` (`master/02c1e2.txt`). 0401 actual values:

**`KF_BZ_WDK_VL` (@0xAC54, X = n, Y = tmot, Z = %)**

| tmot ＼ n | 1300 | 2000 | 3000 | 4000 |
|---|---|---|---|---|
| 0 / 20 / 40 / 60 °C | 35.0 % | 55.0 % | 63.0 % | 65.0 % |

(no temperature dependence in this calibration; flat at 65 % from 4000 rpm up)

| Transition | Condition | 0401 value |
|---|---|---|
| TL → VL | `WDK > KF_BZ_WDK_VL(n, tmot)` | table above |
| VL → TL | `WDK < threshold − K_BZ_WDK_VL_HYST` | hysteresis **6.0 %** (@0xAC06) |
| LL → TL | `WDK ≥ KL_BZ_WDK_LL(n)` | **1.2 %** (3500–6000 rpm, @0xAC3A) |
| TL → LL | `WDK < threshold − K_BZ_WDK_LL_HYST` | hysteresis **0.2 %** (@0xAC04) |

Entry into VL is also blocked by `TI_ST_HELP & 0x10`, `MD_BEGR_AUSS_ST ≠ 0` and `VAN_ED_ST & 0xF0`.

Practical guidance:

1. If possible, **log the ECU's own Betriebszustand (VL/TL/LL bits) and split on that** — more reliable than reconstruction, and the hysteresis comes out right automatically
2. Otherwise **recompute per ECU from its own `KF_BZ_WDK_VL`**. The map is calibrated differently in 1801 and 0401, so a single fixed WDK % threshold will misclassify one of the two
3. **The difference in the thresholds is itself part of the result** — put both threshold curves in the report
4. The VL boundary is also where lambda switches between closed loop and full-load enrichment (and where DISA switching is gated, FR `2.04`), so averaging across it is meaningless. **Excluding the hysteresis band (threshold −6 % to threshold) as a grey zone is the safe choice**

#### 7.5 Recommended log set

| Purpose | Channels |
|---|---|
| Common axes | N, WDK (0.1 %) |
| Primary metric | RF (plus ML [kg/h] on the standard car) |
| Validity gates | `rf_p_saug_i`, lambda adaptation, `rf_diag` |
| Output side | ZW, λ, VANOS, TI, TABG, dN/dt |
| Stratification | VL/TL/LL, ASK flap, KATH, DISA, warm-up factor, `p_umg`, `tan` |

---

### 8. Caveats when reading the source documents

- The bundled Funktionsrahmen set **mixes in the MSS54 EVT (electromagnetic valvetrain research) variant**. `1.0 Momentenmanagement`, `1.03` and `1.04` are written on the assumption that filling is produced by **valve control edges rather than the throttle** (`1.0` §12: "In the EVT engine, the filling is not achieved by the throttle valve angle, but by the control edges"). For the production M3's throttle path, read `3.01 EGAS`, `2.02`, `2.03` and `4.05` instead.
- There is a gap in the numbering: **the load-detection chapter itself (Lasterfassung / Füllungserfassung, i.e. the 2.01 slot) is not part of this set.** The HFM → `RF` conversion above is therefore established from `1.03` §1.12 plus the binary. It is consistent with the XDF, where `K_RF_HUBVOLUMEN`, `K_RF_LUFTDICHTE` and `K_HFM_DIAG_*` all sit under the `Lasterfassung` function group.
- **Every numeric value here was read from the 0401 (CSL) binary/XDF.** Values specific to the standard M3 (1801) are not present in this repository — read them from your own partial before using them in a comparison.

### 9. Sources

| Claim | Source |
|---|---|
| `RF = ml/(Vh·ρ₀·0.5·n)` | FR `1.03 EVT Moment Realization` §1.12 |
| HFM measurement → `rf_hfm1` implementation | `app/public/data/decomp/master/01a6b8.txt` (`saug_calc`) |
| `KF_EGAS_WDK` = rf_soll → wdk | FR `3.01 EGAS` §3.2 / `master/0270b0.txt` |
| Filling controller (PI) and its HFM dependency | FR `2.02 Füllungsregler` / `master/0253de.txt` |
| Adaptation referenced to the HFM | FR `2.03 Adaption Füllungsregler` §1, §1.1 |
| Density correction (960 mbar / 20 °C) | FR `1.04 Dichtekorrektur` §1.4, §3.3 / `master/01a5d6.txt` |
| `KF_RF_N_AQ_REL` is an "Ersatzkennfeld" | FR `4.05 Nachspritzer` §1 / `slave/017d5e.txt` |
| Meaning of `k_rf_cfg` and its branches | XDF `k_rf_cfg` / `master/0218d0.txt` (`rf_calc`) |
| Operating-state thresholds | `master/02c1e2.txt` (`zustand_motor_calc`) / XDF `KF_BZ_WDK_VL` et al. |
| Constant values | `Full 211323000401PD31_TERRA.bin` + `XDF/CSL_0401_Karter16_v3_6_publish.xdf` |
