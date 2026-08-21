# アップロード済み E46 M3 データの解析 — SMG2 と DME チューニング手法

対象: Cloudflare D1 セッション `b81456ff…`（"Session #910"、
2026-08-21 05:23 UTC 同期、VIN `WBSBL91…`（車台番号は伏せ字）、AIF `78373…MJ`、SW `7837340`、
`DME_Read_1787289963471.bin`、64 KB、SHA-256 `8dc54b75…c45f`）。

---

## 0. 結論

**(1) このファイルは「標準 M3 の較正」ではありません。CSL 0401（プログラム 211）そのものです。**
車体は標準 M3 でも、DME に入っているバイトは CSL 変換ソフトです。2,529 パラメータ中
**2,482 が CSL リファレンスと完全一致**し、識別フィールド（`cfg_m/s.baureihe`,
`motortyp`, `getriebetyp`, `variante`, `K_VERS_PROGR`）は全 22 項目が一致します。
したがって「CSL ではなく標準 M3 を解析する」というご指示は、このファイルでは物理的に
実行できません。標準 M3 として解析するには、**CSL 変換前の DME を読んだ 64 KB** が要ります。

**(2) SMG2 の CSL 差分は「ゼロ」です。** SMG パラメータが占めるスレーブ空間
`0x2800–0x2F00`（1,792 バイト）を、XDF 定義の有無を問わず**全バイト**比較して、
**1 バイトも違いません**。SMG カテゴリ 207 パラメータ、および SMG 圏外にある SMG 関連
10 パラメータ（`kl_md_can_ed_smg_max`, `K_EVAN1_SMG_*`, `KL_TI_WE_*_H_SMG`）も全一致。
このチューナーは SMG に指一本触れていません。差分解析の対象がありません。

**(3) ただし収穫はあります。** このファイルは「CSL 変換に対して別のチューナーがかけた
チューン」で、CSL リファレンスとの **47 パラメータの差分**が、その手法をそのまま示して
います（§7）。そして SMG2 の制御そのものは、この DME のスレーブ CPU の中に**丸ごと**
入っており、機構は逆アセンブリから復元できています（§2–§5）。「SMG2 と DME チューニングの
アプローチを学ぶ」という目的は、こちらで達成できます。

---

## 1. アップロードされたファイルの正体

### 1.1 比較に使った 4 つのイメージ

| 略称 | 中身 | 由来 |
|---|---|---|
| `UPLOAD` | 今回のアップロード | D1 session #910、VIN `WBSBL91…` の車から DS2 で実車読み出し |
| `CSLcar` | お手元の車の現状 | D1 session #908 base、VIN `WBSBL92…`、AIF `78373…MJ` |
| `TERRA` | CSL 0401 リファレンス | 本リポジトリの `Full 211323000401PD31_TERRA.bin` を XDF 空間に畳んだもの |
| `CPv1` | Community Patch v1 | `mss54hp-csl-convert-tuner/public/mock/csl-0401-community-patch-v1.partial.bin` |

DS2 が読む 64 KB は **XDF のアドレス空間そのもの**です（オフセット = アドレス、
`0x8000` 未満がスレーブ、以上がマスター）。1 MB フル イメージのほうは bank ごとに規則が
変わる（master = `addr`、slave = `0x88000 + addr`）ので、`TERRA` はその規則で 64 KB に
畳んでから比較しています。畳み方が正しいことは、`graph.json` に保存済みの復号値
**3,183 項目のうち 3,181 が一致**（残り 2 は `<VAR type="link">` を使う式で、raw 比較に
フォールバックする既知の例外）で裏が取れています。

### 1.2 識別フィールド — 全一致

| 項目 | UPLOAD | CSLcar | TERRA |
|---|---|---|---|
| `K_VERS_PROGR_M/S`（プログラム番号） | 211 | 211 | 211 |
| `K_VERS_NAME_M/S` | 14 | 14 | 14 |
| `K_VERS_DATEN_M/S`（データ版） | **81** | **81** | 80 |
| `cfg_*.baureihe` / `motortyp` / `getriebetyp` / `variante` / `sg_typ` / `kr` / `canstand` / `diagnose` / `status` / `egas` / `betriebsmode` | 全 22 項目一致 | 〃 | 〃 |

プログラム番号もモータータイプもギアボックスタイプも同じ。違うのは**データ版だけ**で、
しかも UPLOAD と CSLcar が同じ 81、リファレンス側が 80 です。つまり
**この 2 台は同じ系譜の CSL 変換ファイルを積んでいて、リファレンスより 1 世代新しい**。

本リポジトリの [`docs/LOAD_PATH.md`](LOAD_PATH.md) が既に整理しているとおり、
**標準（非 CSL）M3 のソフトは 1801 系**、CSL が 0401 系です。同文書の末尾にも
「標準 M3（1801）固有の数値はこのリポジトリに含まれていない」と明記されています。
今回のアップロードもその状況を変えません — 中身は 0401 のままです。

### 1.3 差分の規模

| 比較 | 異なるバイト | 異なるパラメータ |
|---|---|---|
| UPLOAD vs TERRA | 1,974 / 65,536 (3.0 %) | **47** / 2,529 |
| UPLOAD vs CPv1 | 1,976 | 48 |
| UPLOAD vs CSLcar | 3,392 | 65 |
| CSLcar vs TERRA | 1,721 | 47 |
| TERRA vs CPv1 | **12** | **2**（`K_FGR_CONFIG`, `K_FR_T_ADAPT`） |

標準 M3 と CSL は、負荷検出（MAF ↔ アルファ N）、カム、回転リミッタ、スロットル、SMG まで
違う車です。それが 47 パラメータで済むはずがありません。47 は**チューンの差**の規模です。

### 1.4 決定的な証拠 — CSL 専用機能が「生きている」

- `kf_rf_soll (CSL Alpha-N)` — CSL のアルファ N 負荷モデル。480 セル中 **400 セルが
  TERRA と完全一致**（残り 80 セルが今回のチューナーの手直し）。標準 M3 のプログラムなら
  このアドレスにこの表は存在しません。
- `kf_egas_wdk_ask` — CSL カーボンエアボックスのスノーケルフラップ用 EGAS 表。存在し、
  322 セル中 310 セルが一致。
- `DTC_7C_CSL_FLAP_POT` — CSL フラップ・ポテンショメータの DTC 定義。**14 バイト全部が 0**。
  つまり「CSL ソフトは載っているが CSL のフラップ機構は載っていない」ので診断を殺してある。
  **これが CSL 変換車の指紋**です。CSLcar 側も同じ処理がしてあります。

> **評価**: この 3 点はどれも `code-confirmed` ではなく**イメージ上の実測**ですが、
> 「同一アドレスに同一の表が同一値で存在する」という事実そのものなので、解釈の余地は
> ありません。

---

## 2. SMG2 は DME のどこにあるか

### 2.1 SMG2 の制御ロジックは MSS54HP のスレーブ CPU に丸ごと入っている

逆アセンブリに **52 個の SMG 関数**が復元されています。CAN の受け渡しだけではありません。

| 関数 | 復元文数 | 役割（関数名と読むパラメータからの解釈） |
|---|---|---|
| `smg_state_supervisor` | 53 | 状態監督。SMG 全体の状態機械の上位 |
| `smg_shift_phase3_clutch_reengage_regulator` | 32 | 変速フェーズ 3 = クラッチ再締結の調節器 |
| `smg_engine_speed_controller_step` | 31 | **回転合わせ（ブリップ／同期）の PID** |
| `smg_shift_phase_fsm_update` | 26 | 変速フェーズの状態機械 |
| `smg_vehicle_dynamics_observer_update` | 24 | 車両運動オブザーバ（`KL_SMG_MOT_J_MOTOR` を読む） |
| `smg_dn_regulator_update` | 22 | 回転勾配の調節器 |
| `smg_driver_torque_ramp_update` | 20 | ドライバ要求トルクのランプ |
| `smg_eta_from_torque_limits_update` | 20 | トルク限界からの効率算出 |
| `smg_shift_phase1_clutch_profile_update` | 19 | 変速フェーズ 1 = クラッチ解放プロファイル |
| `smg_start_window_step` / `_service` / `_torque_ramp_update` | 19/14/10 | **発進（Anfahren）制御** |
| `smg_start_baseline_demand_update` | 19 | 発進時のベースライン要求 |
| `smg_build_clutch_ff_curve` | 15 | クラッチのフィードフォワード曲線生成 |
| `smg_racestart_target_update` | 8 | **ローンチコントロール（Race Start）の目標** |
| `smg_traction_aid_target_update` | 11 | Anfahrhilfe（トラクションエイド）の目標 |
| `smg_wheelbreak_recovery_controller` | 13 | Radabriss（車輪空転）からの復帰 |
| `smg_update_ki_regulation_params` | 4 | **KI → 変速時定数の引き当て** |
| `smg_ki_shift_icon_level` | 2 | **KI（変速アグレッシブネス指標）の決定** |
| `smg_update_program_level` | 1 | Drivelogic プログラム段の更新 |
| `smg_expected_N_from_V_and_gear` | **0** | 車速と段からの予想回転数 — 機構未復元 |
| `smg_shift_phase_dispatch_basic` / `_default` / `smg_shift_speed_reg_dispatcher` | **0** | フェーズ振り分け — 機構未復元 |

`smg_10ms` があるので、これは 10 ms タスクで回る本体制御です。

> **重要**: SMG II の油圧アクチュエータを直接叩くのは車載の SMG コントロールユニットですが、
> **「いつ・どれだけトルクを抜き、どこまで回転を合わせ、クラッチをどの速さで繋ぐか」という
> 戦略は DME 側にあります**。だから SMG2 の「変速の速さ・つながり方」は DME のチューニングで
> 動きます。ここが SMG2 チューニングの入口です。
>
> 逆に、SMG のシフトフォーク位置制御・油圧圧力制御そのものはこの 64 KB には入っていません。
> クラッチ「ミートポイント」の学習値など SMG ECU 側に持つ値は、ここからは触れません。

### 2.2 Funktionsrahmen が無い領域

工場 Funktionsrahmen 39 冊のうち、**SMG に該当する巻はありません**（`ls` で確認済み）。
したがって本章以降の SMG の記述は、すべて **逆アセンブリ由来（`code-confirmed`）か
`xref-only` か `inference`** であり、`funktionsrahmen-only` の裏取りができません。
各行に等級を明記します。

---

## 3. SMG2 の変速速度制御 — 「KI」から時定数へ

これが SMG2 チューニングの主レバーです。機構は完全に復元できています。

### 3.1 復元された式

```
ki_ab   = smg_ki_shift_icon_level(1)      ; トルクを抜く側の指標
ki_scha = smg_ki_shift_icon_level(2)      ; 変速そのものの指標
ki_auf  = smg_ki_shift_icon_level(3)      ; トルクを戻す側の指標

t_abregel  = kfu_bint(KF_SMG_T_ABREGEL,  ki_ab,  smg_can_istgang)   ; ms
t_aufregel = kfu_bint(KF_SMG_T_AUFREGEL, ki_auf, smg_can_istgang)   ; ms
                       ↑ どちらも 0 になったら 1 にクランプされる

smg_bw_null = kfu_bint(KF_SMG_BW_NULL, ki_ab, ki_scha)
```
（`smg_update_ki_regulation_params` / `smg_vehicle_dynamics_observer_update`、
いずれも **`code-confirmed`**）

`KF_SMG_T_ABREGEL` の軸名は XDF に `X: Kennu（Kennlinie＝指標）`, `Y: Istga（Istgang＝現在段）`、
Z の単位は `"ms"`。**KI 1〜12 と段 1〜5 で引く、ミリ秒の表**です。

### 3.2 実データ — 変速の「速さ」そのもの

`KF_SMG_T_ABREGEL`（トルクを抜くランプ時間, ms、行＝段 1..5、列＝KI 1..12）

```
段1  1210  880  690  540  460  390  330  280  240  240  240  100
段2  1090  790  620  470  390  330  280  240  240  240  240  100
段3  1010  720  560  410  330  280  240  230  220  210  200  150
段4   940  660  500  360  290  240  210  190  180  170  160  160
段5   870  600  450  320  260  220  200  190  180  180  180  180
```

`KF_SMG_T_AUFREGEL`（トルクを戻すランプ時間, ms）

```
段1  1100  900  750  650  550  450  350  260  200  140  110   50
段2  1050  850  700  600  500  450  350  240  160  100   90   80
段3  1050  800  650  550  470  450  330  240  200  140  110  100
段4  1000  750  600  550  470  450  330  240  180  160  130  120
段5  1000  750  600  550  470  450  330  240  180  160  150  140
```

**KI=1 で 1,210 ms、KI=12 で 100 ms。12 倍の幅があります。**
Drivelogic の S1 と S6 の体感差は、実質この 1 行です。

### 3.3 KI はどう決まるか

`smg_ki_shift_icon_level` は復元文が 2 つしかない（`stmts=2`）ので、**機構は `xref-only`**
です。しかし読んでいるものは Ghidra が確定しています:

- `DAT_00ffdb12_(SMGCAN_PROGRAMMINFO)` — CAN 経由の **Drivelogic プログラム情報**
- `ASC_SCHALTER` — DSC / スポーツスイッチ
- `ASC_AY` — 横加速度。`K_SMG_KI_NEU_AY_MAX`（3.5 m/s²）で頭打ち、
  `KL_SMG_KI_DAY_MAX`（x=[4, 4.1, 7] → y=[12, 11, 9]）で KI 上限がかかる
- `smg_can_gewuenschter_gang` — 要求段
- そして KI マップ 6 面（+ `_SCH_` 系 6 面）

つまり **「Drivelogic のプログラム段」＋「アクセル開度」＋「回転数」＋「横 G」から KI が決まり、
KI が上の ms 表を引く**、という二段構えです。横 G が入っているのが面白いところで、
**コーナリング中は同じアクセル開度でも変速が速くなります**。

KI マップは 6 面（Zug＝駆動側）+ 6 面（Schub＝惰行側）:

| | Komfort (`_K`) | Sport (`_S`) | 軸 |
|---|---|---|---|
| 抜き `AB` | `KF_SMG_KI_AB_K` 0x2B24 | `KF_SMG_KI_AB_S` 0x2B64 | X=FW %, Y=rpm |
| 変速 `SCHA` | `KF_SMG_KI_SCHA_K` 0x2BA4 | `KF_SMG_KI_SCHA_S` 0x2BE4 | X=FW %, Y=rpm |
| 戻し `AUF` | `KF_SMG_KI_AUF_K` 0x2C24 | **0x2C64（XDF 未定義、§6）** | X=FW %, Y=rpm |
| 抜き惰行 `AB_SCH` | `KF_SMG_KI_AB_SCH_K` 0x2CA4 | `KF_SMG_KI_AB_SCH_S` 0x2CC8 | X=減速側, Y=rpm |
| 変速惰行 `SCHA_SCH` | `KF_SMG_KI_SCHA_SCH_K` 0x2CEC | `KF_SMG_KI_SCHA_SCH_S` 0x2D10 | X=減速側, Y=rpm |
| 戻し惰行 `AUF_SCH` | `KF_SMG_KI_AUF_SCH_K` 0x2D34 | `KF_SMG_KI_AUF_SCH_S` 0x2D58 | X=減速側, Y=rpm |

`_K`=Komfort（D モード）／`_S`=Sport の対応は `inference` ですが、値が裏付けます:
`KF_SMG_KI_AB_K` の Z は最大 5、`KF_SMG_KI_AB_S` は最大 12。同じ軸で S 側が一貫して
大きい＝速い、という一方向の差です。

### 3.4 Drivelogic プログラム段そのものを縛る 3 つ

| パラメータ | 値 | 意味（`inference`／単位は XDF 由来） |
|---|---|---|
| `K_SMG_PROG_MIN_ZR` | 6（単位 `".Prog"`） | プログラム段の下限 |
| `KL_SMG_PROG_MAX_TOEL` | 油温 0/20/40/60 ℃ → 4/6/7/8 | **油温が低いと上位プログラムを使わせない** |
| `KL_SMG_PROG_MIN_BERG` | 勾配 0.4/0.6/0.8/2 → 1/3/4/7 | 登坂では下位プログラムを禁止 |

「冷えているうちは S6 が本気を出さない」という体感は、`KL_SMG_PROG_MAX_TOEL` です。

---

## 4. SMG2 の回転合わせ（ブリップ / 同期）制御

`smg_engine_speed_controller_step`（`stmts=31`、**`code-confirmed`**）から復元:

```
; 目標回転の両側クランプ
n_ziel = max(n_ziel, LLR_N_SOLL)                              ; アイドル目標より下げない
n_ziel = min(n_ziel, N_BEGRENZER - K_SMG_???_DAT_0008a852)    ; リミッタ手前で頭打ち
xValue = n_ziel / 40                                          ; rpm 軸の引き当てインデックス

; ゲイン選択
P = (fahrzustand == Anfahrhilfe) ? (KATH_ZUSTAND ? K_SMG_MOT_N_REG_P_KH : K_SMG_MOT_N_REG_P_AH)
                                 : klu_bint(KL_SMG_MOT_N_REG_P_U | KL_SMG_MOT_N_REG_P_D, xValue)
D = (fahrzustand == Anfahrhilfe) ? 0
                                 : klu_bint(KL_SMG_MOT_N_REG_D_U | KL_SMG_MOT_N_REG_D_D, xValue)

; PID
I += {K_SMG_MOT_N_REG_I_AH | _I_KH | _I} * (n_ziel - N)
I  = clamp(I, -100000, +100000)
D  = (D_MIN <= |Δ| <= D_MAX) ? D * ((n_ziel - N) - Δ_prev) * 100 : 0
P  = P * (n_ziel - N) * 10
```

要点:

- **目標回転はリミッタ手前で必ず頭打ち**（`K_SMG_???_DAT_0008a852`、0x2852、raw = 25）。
  ダウンシフトのブリップがレブに当たらない仕組みはここです。**マージンの物理単位は未確定**:
  XDF はこの無名定数にスケーリング `X`（等倍）を当てていますが、これは「find routine」の
  既定値で根拠がありません。同じ関数が `xValue = n_ziel / 0x28` と rpm を 40 で割って軸を
  引いていることから、この定数も n/40 単位＝1,000 rpm 相当の可能性がありますが、
  **確認できていません**（`inference`）。実測で詰めるなら、レブ手前でのダウンシフト時に
  `n40` がどこで止まるかを見るのが早いです。
- **D 項には窓がある**: `K_SMG_MOT_N_REG_D_MIN` = 90 rpm / `_D_MAX` = 350 rpm。
  偏差がこの窓の外だと D は 0。小さすぎるとノイズ、大きすぎると暴れるため。
- **P と D は回転数依存の曲線**で、しかも**アップ側 `_U` とダウン側 `_D` が別**。
  `KL_SMG_MOT_N_REG_D_U` は 2,000 rpm 以上で 0（アップシフトでは D を使わない）、
  `KL_SMG_MOT_N_REG_D_D` は 2,000 rpm で 1.2 とピークを持つ。
  **ダウンシフトのブリップだけ微分制御が効いている**、という設計です。
- Anfahrhilfe（トラクションエイド）時は曲線を使わず単一定数 `K_SMG_MOT_N_REG_P_AH`（0.04）
  に落ち、触媒暖機中は `_P_KH`（0.08）に切り替わる。

トルク側の枠:

| パラメータ | 値 | 意味 |
|---|---|---|
| `K_SMG_MOT_N_REG_M_MAX` | 30 Nm | 回転制御が使ってよいトルクの上限 |
| `K_SMG_MOT_N_REG_T_MAX` | 400 ms | 回転制御を続けてよい最大時間 |
| `K_SMG_MOT_RAB_M_MIN / _M_MAX` | −20 / 100 Nm | Radabriss 復帰時のトルク枠 |
| `KL_SMG_MOT_DN_SOLL` | 0/120/300/600/1200/3000 → 200/400/1020/2920/8000/12000 | 目標回転勾配（rpm/s） |

**ブリップが「浅い / 遅い」と感じるときに触るのは `KL_SMG_MOT_DN_SOLL` と
`KL_SMG_MOT_N_REG_P_D`、上限に当たっているなら `K_SMG_MOT_N_REG_M_MAX`** です。

---

## 5. SMG2 の主要パラメータ表

現在値はすべて UPLOAD の実測値で、**CSL リファレンスと完全に同一**です（§0-(2)）。

| パラメータ定義名 | 種別 | XDFアドレス | ファイルオフセット | bank | 現在値 | 単位 | 役割 | 変更方向・量 | リスク | 根拠 |
|---|---|---|---|---|---|---|---|---|---|---|
| `KF_SMG_T_ABREGEL` | map | 0x2D7C | 0x8AD7C | slave | 1210…100 | ms | KI×段 → トルクを抜くランプ時間 | 速くしたい列（高 KI）を下げる。100 ms 未満は未検証領域 | 短すぎるとトルク段差がドライブトレインを叩く | code-confirmed |
| `KF_SMG_T_AUFREGEL` | map | 0x2DCC | 0x8ADCC | slave | 1100…50 | ms | KI×段 → トルクを戻すランプ時間 | 同上。抜きより戻しを速くすると突き上げる | 戻しが速すぎるとシフトショック | code-confirmed |
| `KF_SMG_KI_AB_K` | map | 0x2B24 | 0x8AB24 | slave | 1…5 | - | D モードの抜き側 KI（X=FW%, Y=rpm） | 全体に +1〜2 で D モードが機敏になる | 12 を超える値は表外 | xref-only |
| `KF_SMG_KI_AB_S` | map | 0x2B64 | 0x8AB64 | slave | 4…12 | - | S モードの抜き側 KI | 既に上限 12 に達しているセルあり | 同上 | xref-only |
| `KF_SMG_KI_SCHA_K` | map | 0x2BA4 | 0x8ABA4 | slave | 1…9 | - | D モードの変速 KI | — | — | xref-only |
| `KF_SMG_KI_SCHA_S` | map | 0x2BE4 | 0x8ABE4 | slave | 2…11 | - | S モードの変速 KI | — | — | xref-only |
| `KF_SMG_KI_AUF_K` | map | 0x2C24 | 0x8AC24 | slave | 1…5 | - | D モードの戻し側 KI | — | — | xref-only |
| `KF_SMG_KI_AB_SCH_K` | map | 0x2CA4 | 0x8ACA4 | slave | 3…8 | - | 惰行時の抜き側 KI（X は減速側） | — | — | xref-only |
| `KF_SMG_KI_AB_SCH_S` | map | 0x2CC8 | 0x8ACC8 | slave | 7…11 | - | 惰行時の抜き側 KI（S） | — | — | xref-only |
| `KF_SMG_KI_AUF_SCH_K` | map | 0x2D34 | 0x8AD34 | slave | 1…10 | - | 惰行時の戻し側 KI | — | — | xref-only |
| `KF_SMG_KI_AUF_SCH_S` | map | 0x2D58 | 0x8AD58 | slave | 3…11 | - | 惰行時の戻し側 KI（S） | — | — | xref-only |
| `K_SMG_KI_NEU_AY_MAX` | constant | 0x2822 | 0x8A822 | slave | 3.5 | m/(s*s) | 横 G が KI に効く上限 | 下げると早く「本気」になる。x/10 量子化 | サーキット以外で常時アグレッシブ化 | xref-only |
| `KL_SMG_KI_DAY_MAX` | curve | 0x2912 | 0x8A912 | slave | 12, 11, 9 | - | KI の上限（横 G 依存） | — | 上げても T 表の 12 列以上は無い | xref-only |
| `KL_SMG_MOT_DN_SOLL` | curve | 0x2AA8 | 0x8AAA8 | slave | 200…12000 | - | 目標回転勾配（同期の速さ） | ブリップが遅いならここを上げる | 上げすぎると行き過ぎ→再収束で遅くなる | xref-only |
| `KL_SMG_MOT_N_REG_P_D` | curve | 0x2A7E | 0x8AA7E | slave | 0.08…0.1 | - | ダウン側 P ゲイン（rpm 依存） | +10〜20 % 刻み | 発振 | code-confirmed |
| `KL_SMG_MOT_N_REG_P_U` | curve | 0x2A70 | 0x8AA70 | slave | 0.1…0.24 | - | アップ側 P ゲイン | 同上 | 発振 | code-confirmed |
| `KL_SMG_MOT_N_REG_D_D` | curve | 0x2A9A | 0x8AA9A | slave | 0.8…0 | - | ダウン側 D ゲイン | 2,000 rpm 付近がピーク | ノイズ増幅 | code-confirmed |
| `K_SMG_MOT_N_REG_D_MIN` | constant | 0x287C | 0x8A87C | slave | 90 | Upm | D 項が効き始める偏差 | — | 下げるとノイズを微分する | code-confirmed |
| `K_SMG_MOT_N_REG_D_MAX` | constant | 0x287E | 0x8A87E | slave | 350 | Upm | D 項が切れる偏差 | — | — | code-confirmed |
| `K_SMG_MOT_N_REG_M_MAX` | constant | 0x2880 | 0x8A880 | slave | 30 | Nm | 回転制御が使えるトルク上限 | ブリップが浅いならここ。x/10 刻み | 上げるとブリップが暴れる | xref-only |
| `K_SMG_MOT_N_REG_T_MAX` | constant | 0x2882 | 0x8A882 | slave | 400 | ms | 回転制御の最長時間 | x*10 量子化＝10 ms 刻み | — | xref-only |
| `K_SMG_MOT_N_REG_I` | constant | 0x2872 | 0x8A872 | slave | 0.003 | Nm/Upm | I ゲイン | x/1000 刻み | 積分暴走（±100000 でクランプ） | code-confirmed |
| `K_SMG_J_MOTOR` | constant | 0x280A | 0x8A80A | slave | 0.25 | Nms2 | SMG が使うエンジン慣性 | 軽量フライホイールなら下げる。x/128 刻み（0.0078 単位） | 消費側が `xref-only` なので効果は要実測 | xref-only |
| `KL_SMG_MOT_J_MOTOR` | curve | 0x2ACC | 0x8AACC | slave | 0.0078…0.5 | - | 回転数依存の慣性（オブザーバが読む） | 同上 | `smg_vehicle_dynamics_observer_update` が実際に読む | code-confirmed |
| `K_SMG_I_HA` | constant | 0x28CC | 0x8A8CC | slave | 3.63333 | - | ファイナル比 | 3.62 / 3.15 等に換えたら**必ず**合わせる。x/60 刻み | 段検出と目標回転が全部ずれる | xref-only |
| `K_SMG_R_RAD_DYN` | constant | 0x280C | 0x8A80C | slave | 307 | mm | 動的タイヤ半径 | 外径を変えたら合わせる。x/10 刻み | 車速・段検出がずれる | xref-only |
| `K_SMG_KUPP_M_NORM` | constant | 0x2834 | 0x8A834 | slave | 700 | Nm | クラッチ容量の基準トルク | 強化クラッチで上げる。**x*4 量子化＝4 Nm 刻み** | 過大にすると保護が効かない | xref-only |
| `KL_SMG_KUPP_M_AB_ZH` | curve | 0x2928 | 0x8A928 | slave | 150…0 | - | 駆動アップ時のクラッチ解放プロファイル | — | 変速のつながりが直接変わる | xref-only |
| `KL_SMG_MOT_M_AB_SR` | curve | 0x2A20 | 0x8AA20 | slave | 100…0 | - | 惰行ダウン時のトルク低減プロファイル | — | — | xref-only |
| `K_SMG_MOT_ANF_N_OFF` | constant | 0x2884 | 0x8A884 | slave | 1000 | Upm | 発進時の回転オフセット | **x*40 量子化**＝40 rpm 刻み | 発進回転が変わる | xref-only |
| `K_SMG_MOT_ANF_STG_X` | constant | 0x2888 | 0x8A888 | slave | 80 | Nm | 発進時のトルク段 | x/10 刻み | — | xref-only |
| `KL_SMG_MOT_ANF_M_RAM` | curve | 0x2B1C | 0x8AB1C | slave | 200/400/500 | - | 発進トルクのランプ | Race Start の「出方」 | クラッチ寿命 | xref-only |
| `K_SMG_N_ZIEL_ABWUERG` | constant | 0x2855 | 0x8A855 | slave | 1200 | Upm | エンスト回避の目標回転 | **x*40 量子化** | 下げるとエンストしやすい | xref-only |
| `K_SMG_DWF_N_MIN_RS` | constant | 0x28C0 | 0x8A8C0 | slave | 4300 | Upm | ダウンシフト警告の下限回転 | — | — | xref-only |
| `kl_md_can_ed_smg_max` | curve | 0xD004 | 0x0D004 | master | 100/200/300 | Nm | SMG が CAN で要求できるトルク介入の枠 | `md_can_ed_smg_max = MD_IND_SCHLEPP + MD_IND_VERBRAUCHER + klu_wint(この表, V)` | **枠を広げると変速中のトルク抜きが深くなる** | code-confirmed |

### 5.1 触ってはいけないもの — SMG 安全コンセプト

`K_SMG_SK_*` は Sicherheitskonzept（安全コンセプト）です。**変速フィールを良くする効果は
一切なく、壊れ方だけが変わります。**

| パラメータ定義名 | 種別 | XDFアドレス | ファイルオフセット | bank | 現在値 | 単位 | 役割 | 変更方向・量 | リスク | 根拠 |
|---|---|---|---|---|---|---|---|---|---|---|
| `K_SMG_SK_N_MAX_EKR` | constant | 0x28B3 | 0x8A8B3 | slave | 9600 | Upm | 過回転検出しきい値 | **変更しない** | 誤ダウンシフトでエンジンが飛ぶ | xref-only |
| `K_SMG_SK_MD_CHK_MAX` | constant | 0x28B6 | 0x8A8B6 | slave | 600 | Nms | トルク妥当性チェック上限 | **変更しない** | トルク暴走の最後の砦 | xref-only |
| `K_SMG_SK_RSCHLUPF_MAX` | constant | 0x28AC | 0x8A8AC | slave | 15.0391 | % | クラッチ滑り上限 | **変更しない** | クラッチ焼損 | xref-only |
| `K_SMG_SK_N_ZIEL_DELTA` | constant | 0x28AF | 0x8A8AF | slave | 400 | - | 目標回転の妥当性窓 | **変更しない** | — | xref-only |
| `K_SMG_SK_N_GETR_DELTA` | constant | 0x28AD | 0x8A8AD | slave | 400 | - | 変速機回転の妥当性窓 | **変更しない** | — | xref-only |

隣接アドレスにも注意が必要です。`K_SMG_SK_M_OFF_ST_1/2/3` は `0x28BC–0x28BE` の連続 3 バイト、
`K_SMG_I_GANG_1..6` は `0x28CD–0x28D2` の連続 6 バイトで、**1 バイトずれると別の段の
ギア比を書き換えます**。

### 5.2 不活性な 1 本

`q.py dead "^K.?_SMG"` の結果、SMG ブロックで殺されているものは**ほぼありません**
（enable=0 が 0 本、全ゼロ表が 0 本）。唯一 `KL_SMG_???_DAT0008a918`（0x291A）が
6 点すべて 14.0 の平坦な曲線です。

SMG 圏外では `KL_TI_WE_OFF_H_SMG`（0x018C、slave）が **6 点すべて 0** です。
`sa_we_segm` が読んでいます（`xref-only`）。対になる `KL_TI_WE_IGN_H_SMG`（0x01B4）は
0.5 → 0 の実データを持っているので、**アップシフト時のトルク抜きは燃料カットではなく
点火側で行っている**と読めます（`inference`）。

---

## 6. XDF に定義が無い SMG マップ — 新発見

**`0x2C64`（ファイル `0x8AC64`, slave）に、XDF が定義していない KI マップがあります。**

KI マップは `_K` → `_S` が `0x40` 刻みで並びます: `AB_K` 0x2B24 → `AB_S` 0x2B64、
`SCHA_K` 0x2BA4 → `SCHA_S` 0x2BE4。ところが `AUF_K` 0x2C24 の次、0x2C64 には XDF 定義が
なく、次の定義は 0x2CA4（`AB_SCH_K`）まで飛びます。

そこを `KF_SMG_KI_AUF_K` と同じレイアウト（X 8 B, Y 6 B, Z 48 B）で読むと:

```
X (FW %)  : 10  25  40  55  70  80  90  100      <- 単調増加、正しい軸
Y (rpm)   : 1000  2200  3400  4200  5200  6520   <- AUF_K と完全に同じ軸
Z:
  1000rpm    3   4   4   6   7   6   6   6
  2200rpm    5   7   7   8   9   8   7   7
  3400rpm    8   8  10  10  11  10  10  10
  4200rpm   10  10  10  11  11  11  10  10
  5200rpm   10  10  11  11  11  11  11  12
  6520rpm   10  10  11  11  11  11  12  12
```

Y 軸が `KF_SMG_KI_AUF_K` と 1 点の違いもなく一致し、Z が 3〜12（`AUF_K` は 1〜5）と一貫して
大きい。**これは `KF_SMG_KI_AUF_S`（Sport モードのトルク戻し KI）です**（`inference`。
ただしレイアウト・軸・値域の 3 つが揃っているので確度は高い）。

実務上の意味は小さくありません。**S モードで「変速後のトルク復帰が速い／突き上げる」を
調整するマップが、XDF に無いので TunerPro からは見えていません。** 直接バイト編集が要ります。
`smg_ki_shift_icon_level` の scan エッジに `KF_SMG_KI_AUF_K` はあっても `_S` が無いのは、
XDF に定義が無いためで、コード側が読んでいないという意味ではありません。

---

## 7. このチューンが実際に変えた 47 項目 — DME チューニングの手法

以下はすべて **UPLOAD と CSL リファレンス（TERRA）の差**です。`現在値` 列は
`CSLリファレンス値 → UPLOAD値` の形で書いています。`CPv1` を基準にしても
`K_FGR_CONFIG` と `K_FR_T_ADAPT` の 2 項目しか変わらないので、絵は同じです。

### 7.1 点火 — 「+1° を、トルクモデルとセットで動かす」

**このチューンで一番学ぶ価値があるのはここです。**

| パラメータ定義名 | 種別 | XDFアドレス | ファイルオフセット | bank | 現在値 | 単位 | 役割 | 変更方向・量 | リスク | 根拠 |
|---|---|---|---|---|---|---|---|---|---|---|
| `KF_TZ_GRUND (Map_Ignition_Ground)` | map | 0xAD1A | 0x0AD1A | master | 全216セル +1 | ø | 基本点火進角（X=rf, Y=n） | **216 セル全部に一律 +1.0°** | ノッキング | inference |
| `KF_TZ_VL (Map_Ignition_Full Load)` | map | 0xAF08 | 0x0AF08 | master | 54セル中24セル +1 | ø | 全負荷点火 | 高回転側 24 セルのみ +1.0° | 同上 | inference |
| `KF_MD_ZW_OPT` | map | 0x3A42 | 0x8BA42 | slave | 全216セル +1 | ø | **トルクモデルが使う「最適点火角」** | `KF_TZ_GRUND` と**同じ +1.0°** | ずらすとトルク推定が崩れる | inference |
| `KF_TZ_SZ (Map_Ignition_Dwell Time)` | map | 0xAFE6 | 0x0AFE6 | master | 5セル +0.5 | - | ドウェル時間 | 低回転側 5 セル +0.5 | コイル発熱 | inference |

`KF_MD_ZW_OPT` の軸は X=`rf`（相対充填 0.1〜1.1）、Y=`n`、Z 単位 `ø`。
**`KF_TZ_GRUND` と完全に同じ格子**です。ここが肝で:

> `KF_MD_ZW_OPT` は「この運転点での点火効率 100 % はこの角度」という**トルクモデルの基準**です。
> `KF_TZ_GRUND` だけを +1° すると、DME は「最適より 1° 進んでいる＝効率が落ちる」と解釈し、
> モーメントマネージャがスロットルで埋め合わせようとします。**両方を同じ量だけ動かすことで、
> 点火は進むがトルクモデルの効率計算は無傷**になります。

これは「点火マップだけ触る」チューンとの明確な差です。CSL 変換の DME チューニングで
真似すべき作法として、これが第一です。

### 7.2 ノック検出 — 進角と一緒に緩めてある

| パラメータ定義名 | 種別 | XDFアドレス | ファイルオフセット | bank | 現在値 | 単位 | 役割 | 変更方向・量 | リスク | 根拠 |
|---|---|---|---|---|---|---|---|---|---|---|
| `KF_KD_KFAKT_1` | map | 0xA2CE | 0x0A2CE | master | 48セル中36セル +0.126〜0.168 | - | 気筒 1 のノック判定係数 | 全体に約 +0.14 | 判定が鈍る | inference |
| `KF_KD_KFAKT_2` | map | 0xA356 | 0x0A356 | master | 同上 | - | 気筒 2 | 同上 | 同上 | inference |
| `KF_KD_KFAKT_3` | map | 0xA3DE | 0x0A3DE | master | 同上 | - | 気筒 3 | 同上 | 同上 | inference |
| `KF_KD_KFAKT_4` | map | 0xA466 | 0x0A466 | master | 同上 | - | 気筒 4 | 同上 | 同上 | inference |
| `KF_KD_KFAKT_5` | map | 0xA4EE | 0x0A4EE | master | 同上 | - | 気筒 5 | 同上 | 同上 | inference |
| `KF_KD_KFAKT_6` | map | 0xA576 | 0x0A576 | master | 同上 | - | 気筒 6 | 同上 | 同上 | inference |

6 気筒すべてに**ほぼ同量**（各気筒 36/48 セル、+0.10〜+0.17、平均 +0.13〜+0.15）を足しています。「+1° 入れたぶんノック検出が過敏になって
勝手に引かれる」のを避ける処置で、7.1 とセットの動きです。

**ただしこれはリスクを引き受ける方向の変更です。** ノック検出をわざと鈍くしているので、
低オクタン燃料・高吸気温では保護が遅れます。真似するなら燃料を固定できる前提が要ります。

### 7.3 VANOS — 軸ごと引き直してある

| パラメータ定義名 | 種別 | XDFアドレス | ファイルオフセット | bank | 現在値 | 単位 | 役割 | 変更方向・量 | リスク | 根拠 |
|---|---|---|---|---|---|---|---|---|---|---|
| `K_EVAN1_OFFSET` | constant | 0x1802 | 0x89802 | slave | 3 → −2 | øKW | 吸気 VANOS 位置オフセット | −5.0°（x/10 刻み、raw 30 → −20） | 実位置とのずれ | inference |
| `K_AVAN1_OFFSET` | constant | 0x1BB6 | 0x89BB6 | slave | −2 → 1 | øKW | 排気 VANOS 位置オフセット | +3.0° | 同上 | inference |
| `KF_EVAN1_SOLL (Map_ VANOS Intake_Target)` | map | 0x18D0 | 0x898D0 | slave | 256セル中186セル変更 | - | 吸気 VANOS 目標 | **X 軸(rpm)も 16 点中 16 点入れ替え** | — | inference |
| `KF_AVAN1_SOLL (Map_VANOS Exhaust_Target)` | map | 0x1BF6 | 0x89BF6 | slave | 256セル中210セル変更 | - | 排気 VANOS 目標 | X 軸も 15 点入れ替え（平均 −820 rpm） | — | inference |
| `KF_EVAN1_SOLL_KATH (Map_VANOS Intake_Target_Catalytic Heating)` | map | 0x1A12 | 0x89A12 | slave | 214セル変更 | - | 触媒暖機時の吸気 VANOS | — | 暖機排ガス | inference |
| `KF_AVAN1_SOLL_KATH (Map_VANOS Exhaust_Target_Catalytic Heating)` | map | 0x1D38 | 0x89D38 | slave | 180セル変更 | - | 触媒暖機時の排気 VANOS | — | 同上 | inference |
| `KF_EVAN1_SOLL_DMAX` | map | 0x1B54 | 0x89B54 | slave | 3セル +9 | - | 吸気 VANOS 最大変化率 | — | — | inference |

**X 軸（回転数のブレークポイント）まで入れ替えている**のが特徴で、これは値の微調整ではなく
**カムの作り直し**です。カム交換かヘッド加工が入っているか、少なくとも VANOS 戦略を
一から引き直しています。オフセット定数も両バンクとも動いているので、
**実測（VANOS 実位置と目標のずれ）を取り直したうえでの作業**と読めます。

**注意**: このグループを自車にコピーするのは危険です。オフセットは個体の VANOS ハードに
対する補正で、他車の値を持ってくる意味がありません。

### 7.4 負荷モデル・スロットル・ペダル

| パラメータ定義名 | 種別 | XDFアドレス | ファイルオフセット | bank | 現在値 | 単位 | 役割 | 変更方向・量 | リスク | 根拠 |
|---|---|---|---|---|---|---|---|---|---|---|
| `kf_rf_soll (CSL Alpha-N)` | map | 0xD2FE | 0x0D2FE | master | 480セル中80セル変更 | - | CSL アルファ N 負荷モデル | −0.026 〜 +0.112、平均 +0.010 | 空燃比が動く | inference |
| `KL_PWG_SOLL_KOMFORT` | curve | 0x8254 | 0x08254 | master | 10点中8点 +0.7〜+11.4 | - | **D モードのペダルマップ** | 中間開度を大きく持ち上げ、ほぼ直線化 | 街乗りで神経質になる | inference |
| `KF_EGAS_WDK` | map | 0x839E | 0x0839E | master | 322セル中8セル −5 | - | スロットル目標 | 8 セルのみ −5 | — | inference |
| `kf_egas_wdk_ask` | map | 0x8828 | 0x08828 | master | 322セル中12セル変更 | % | CSL フラップ時のスロットル目標 | −5 〜 +18 | — | inference |

`kf_rf_soll` は 480 セル中 **80 セルだけ**（17 %）。全面書き換えではなく、
**ログで合わなかった運転点だけを直している**、という作法です。ここも学ぶ価値があります。

`KL_PWG_SOLL_KOMFORT` は「D モードのペダルを Sport 寄りにする」定番の手です。
`KL_PWG_SOLL_SPORT` は触られていません。

### 7.5 アイドル

| パラメータ定義名 | 種別 | XDFアドレス | ファイルオフセット | bank | 現在値 | 単位 | 役割 | 変更方向・量 | リスク | 根拠 |
|---|---|---|---|---|---|---|---|---|---|---|
| `K_LFR_NSOLL_AC` | constant | 0x9A4A | 0x09A4A | master | 870 → 900 | Upm | A/C オン時の目標アイドル | +30 rpm | — | inference |
| `KL_LFR_NSOLL_GRUND` | curve | 0x9A64 | 0x09A64 | master | 4点中2点 +30 | - | 基本目標アイドル（水温依存） | 50 ℃ / 80 ℃ を 870 → 900 | — | inference |
| `KF_LLS_TV` | map | 0x9DE2 | 0x09DE2 | master | 130セル中50セル +1.0〜+2.3 | - | アイドルアクチュエータのデューティ | 平均 +1.4 % | — | inference |
| `KF_LLS_TV_KATH` | map | 0x9F16 | 0x09F16 | master | 130セル中50セル +1.0〜+2.0 | - | 触媒暖機時の同上 | 平均 +1.4 % | — | inference |
| `K_FR_T_ADAPT` | constant | 0xE002 | 0x0E002 | master | 4.06 → 1.5 | sec | 充填レギュレータの適応時定数 | −63 %。X/100 刻み | 適応が速い＝ノイズを拾う | inference |

**目標を +30 rpm 上げるのと同時に、開ループ側（`KF_LLS_TV`）も +1.4 % 持ち上げている**のが
作法です。目標だけ上げると閉ループが積分で埋めるので、アイドルが「探る」挙動になります。
前もって開ループを足しておけば、閉ループはほぼ 0 から始まります。

### 7.6 リミッタ・設定・診断

| パラメータ定義名 | 種別 | XDFアドレス | ファイルオフセット | bank | 現在値 | 単位 | 役割 | 変更方向・量 | リスク | 根拠 |
|---|---|---|---|---|---|---|---|---|---|---|
| `KL_V_MAX_GANG` | curve | 0x92B0 | 0x092B0 | master | 285 → 338.125（全8段） | - | 段別最高速リミッタ | **速度リミッタ解除** | タイヤ速度定格 | inference |
| `K_FDYN_CONTROL (Sport Mode)` | constant | 0x8026 | 0x08026 | master | 3 → 4 | - | スポーツモード設定 | +1 | — | inference |
| `K_N_MAX_VFEHLER` | constant | 0x00A0 | 0x880A0 | slave | 6300 → 8000 | Upm | 速度信号異常時の回転制限 | +1700 rpm | 車速信号喪失時に保護が効かない | inference |
| `K_SLS_UB_MIN` | constant | 0xC104 | 0x0C104 | master | 9.5 → 18.5 | V | 二次空気の電圧下限 | **上限と同値にして二次空気を無効化** | 冷間排ガス | inference |
| `K_SLS_UB_MAX` | constant | 0xC105 | 0x0C105 | master | 17 → 18.5 | V | 二次空気の電圧上限 | 同上 | 同上 | inference |
| `K_TABG_CFG` | constant | 0xC556 | 0x0C556 | master | 0 → 1 | - | 排気温度モデルの設定 | **有効化** | — | inference |
| `K_TI_F_KATS_MAX` | constant | 0x0076 | 0x88076 | slave | 1.35 → 1.0 | - | 触媒保護時の最大増量係数 | −26 %。x/1024 刻み | 触媒温度 | inference |
| `K_VERS_DATEN_M` | constant | 0x8004 | 0x08004 | master | 80 → 81 | - | データ版番号（マスター） | +1 | — | inference |
| `K_VERS_DATEN_S` | constant | 0x0004 | 0x88004 | slave | 80 → 81 | - | データ版番号（スレーブ） | +1 | — | inference |
| `KL_TI_UB` | curve | 0x015C | 0x8815C | slave | 5点すべて −0.3〜−0.8 | - | 噴射時間の電圧補正 | 全点を大幅に短縮 | **別インジェクタ前提** | inference |

`K_SLS_UB_MIN` と `K_SLS_UB_MAX` を**同じ 18.5 V にする**のは、電圧窓を実現不能にして
二次空気システムを止める常套手段です。値そのものに意味はありません。

`KL_TI_UB` が 0.85/0.69/0.28/0.18/0.15 ms（リファレンスは 1.65/1.19/0.73/0.53/0.45 ms）まで
下がっているのは、**インジェクタが換わっている**ことを意味します。開弁遅れの短い品番です。
この 1 本だけを他車にコピーすると、確実に燃調を壊します。

### 7.7 DTC — 10 本の CTL バイトを 0 に

DTC 表は 14 バイト 1 行で、XDF のラベルによれば列は
`DTC | SIN | SOUT | IN INC | OUT INC | IN DEC | OUT DEC | – | – | – | – | – | CTL | TERM`。
**13 列目 `CTL` を 0 にすると、その故障は報告されなくなります。**

| DTC | XDFアドレス | CTL の変更 | 何を消しているか |
|---|---|---|---|
| `DTC_7C_CSL_FLAP_POT` | 0x6164 | 行 14 バイト全部を 0 | CSL スノーケルフラップ（ハードが無い） |
| `DTC_B2_CAT_PROTECT_BANK1` | 0x62A6 | 37 → 0 | 触媒コンバータ変換効率 1-3 気筒 |
| `DTC_B3_CAT_PROTECT_BANK2` | 0x62B4 | 37 → 0 | 同 4-6 気筒 |
| `DTC_57_O2_REAR_BANK1_SIGNAL` | 0x62FA | 1 → 0 | リア O2 信号 B1 |
| `DTC_58_O2_REAR_BANK2_SIGNAL` | 0x6308 | 1 → 0 | リア O2 信号 B2 |
| `DTC_5C_O2_REAR_BANK1_VOLTAGE` | 0x6378 | 1 → 0 | リア O2 電圧 B1 |
| `DTC_5D_O2_REAR_BANK2_VOLTAGE` | 0x6386 | 1 → 0 | リア O2 電圧 B2 |
| `DTC_27_O2_HEATER_REAR_BANK1` | 0x6332 | 3 → 0 | リア O2 ヒータ B1 |
| `DTC_28_O2_HEATER_REAR_BANK2` | 0x6340 | 3 → 0 | リア O2 ヒータ B2 |
| `DTC_8E_SUCTIONJET_PUMP_CHECK` | 0xF068 | 1 → 0 | サクションジェットポンプ |
| `DTC_69_TMOT_IMPLAUS` | 0xF084 | 37 → 0 | 水温センサ妥当性 |

リア O2 4 本 + 触媒 2 本 = **キャタレス／スポーツキャット前提**です。
`DTC_69_TMOT_IMPLAUS`（水温妥当性）を消しているのは範囲がやや広く、
**水温センサが本当に壊れたときも黙る**ことになります。ここは真似しないほうが賢明です。

---

## 8. お手元の車のチューンとの比較

同じ CSL 0401 データ版 81 を土台に、**2 人が別々にチューンしている**構図です。
Community Patch v1 を共通基準に取ると:

| | 項目数 |
|---|---|
| 両者が触った | 17（うち**値まで同一が 13**） |
| 同じレバー・別の値 | 4 |
| アップロード車だけ | 31 |
| お手元の車だけ | 30 |

### 8.1 値まで完全に同じ 13 項目 = 「CSL 変換の共通レシピ」

`DTC_7C_CSL_FLAP_POT` / `DTC_B2_CAT_PROTECT_BANK1` / `DTC_B3_CAT_PROTECT_BANK2` /
`KL_V_MAX_GANG` / `K_AVAN1_OFFSET` / `K_EVAN1_OFFSET` / `K_FDYN_CONTROL` / `K_FGR_CONFIG` /
`K_N_MAX_VFEHLER` / `K_SLS_UB_MAX` / `K_SLS_UB_MIN` / `K_VERS_DATEN_M` / `K_VERS_DATEN_S`

**別々のチューナーが同じ値に行き着いたのではなく、同じ配布ファイルを土台にしている**と
考えるのが自然です（データ版 81 が一致することも同じ方向を示します）。
つまりこの 13 項目は「CSL 変換ベースがもともとそうなっている」部分で、
**個々のチューナーの判断ではありません**。ここを「他人の答え」として参考にするのは誤りです。

### 8.2 同じレバーを別の値にしている 4 項目

`KF_EGAS_WDK` / `KF_LLS_TV` / `KF_LLS_TV_KATH` / `kf_rf_soll (CSL Alpha-N)`

**アイドル空気量と負荷モデルは、車ごとに合わせるもの**という当たり前の結論です。
ここは他車の値をコピーする対象ではありません。

### 8.3 向こうにあって、こちらに無い 31 項目

点火 +1°（`KF_TZ_GRUND` / `KF_MD_ZW_OPT` / `KF_TZ_VL` / `KF_TZ_SZ`）、
ノック係数 6 面、VANOS 7 面、ペダルマップ、リア O2・触媒・水温の DTC 8 本、
`KL_TI_UB`、`K_TABG_CFG`、`K_LFR_NSOLL_AC`、`K_FR_T_ADAPT`、`K_TI_F_KATS_MAX`。

**このうちお手元の車で意味があるのは、点火 4 面のセット（§7.1）だけです。**
VANOS と `KL_TI_UB` は向こうのハード前提、DTC は向こうの排気系前提、
ペダルマップは好みの問題です。

### 8.4 こちらにあって、向こうに無い 30 項目

`K_SMG_J_MOTOR`（0.25 → 0.203125）、`K_SMG_DWF_CFG_HS`（0 → 1）、`K_MD_J_MOTOR`、
`KL_MD_RES_LRW`、`KL_MD_LS_DMD`、`KL_MD_DASHPOT_DMD`、`KF_MD_WE`、`KL_DYN_TRIGGER_KR`、
`KL_EDK_VORST`、`KF_DKBA_*`、`k_rf_cfg`、`kf_rf_soll_ask`、`kf_rf_soll_kath`、
SMG 系 DTC 3 本ほか。

**ドライバビリティ（慣性・ダッシュポット・トルク復帰・EDK 先行）に寄った内容**で、
`docs/lightweight_flywheel_tuning.md` の系譜そのものです。
向こうは**出力とハード対応**、こちらは**ドライバビリティ**。狙いが違います。

> **SMG に関する唯一の差**は、お手元の車の `K_SMG_J_MOTOR` = 0.203125（リファレンス 0.25）と
> `K_SMG_DWF_CFG_HS` = 1（リファレンス 0）の 2 バイトだけです。
> つまり **SMG ブロックに手を入れているのは、この 2 台のうちお手元の車だけ**です。

---

## 9. 計測（DS2 ログ）計画 — SMG2 の変速を実際に見る

SMG2 の変速中に何が起きているかは、**ブロック 83（0x53, EGAS）1 本**でほぼ見えます。
1 ブロックに閉じるので、フレーム内で時間整合が取れます（ブロックをまたぐと非同期）。

| 症状 | 見るチャンネル | 判断 |
|---|---|---|
| 変速が遅い / もたつく | `md_ind_wunsch` → `md_ind_ne` の落ち込み幅と**立ち下がり時間** | 立ち下がりが `KF_SMG_T_ABREGEL` の該当セル（ms）と一致するか |
| 変速後に突き上げる | `md_ind_ne` の**立ち上がり時間** | `KF_SMG_T_AUFREGEL` の該当セル |
| どの KI が選ばれたか | 直接は見えない | `pwg_soll` と `n40` から KI マップを手引きし、上の時間と突き合わせる |
| ブリップが浅い | `n40`、`d_n40` | `KL_SMG_MOT_DN_SOLL`（目標勾配）に届いているか |
| 段の認識 | `gang`、`s_krafts` | ギア比定数（`K_SMG_I_GANG_*`）と車速の整合 |

**解像度の限界を先に言っておきます。**

- `d_n40` は **1 LSB = 40 rpm/s** で、±5,080 rpm/s で飽和します。
  変速中の回転勾配は「前後比較」には使えますが、しきい値の精密合わせには粗すぎます。
- DS2 は要求 / 応答の逐次通信で、100 ms オーダーの変速イベントに対して
  **サンプル数が足りません**。「1 回の変速の波形」を精密に描くのは無理で、
  **同じ変速を何十回も繰り返して統計で見る**のが現実的な使い方です。
- ブロック 4（Switch/Status）を足すと `zustand_motor` などの状態ビットは見えますが、
  ブロックが増えるぶんレートが落ち、83 との間にスキューが出ます。
  **変速のタイミングを測るなら 83 単独**にしてください。

---

## 10. 確認できなかったこと

1. **標準 M3 の較正そのもの（1801 系）。** 手元にありません。SMG2 の CSL 差分をご希望どおり
   出すには、**CSL 変換していない E46 M3 の DME を DS2 で読んだ 64 KB** が要ります。
   1801 系はパラメータの配置が 0401 と同じとは限らないので、CSL 用 XDF でそのまま読める
   保証はありません（`tools/compare/xdf_diff.py` はまず素直に当てて、軸が単調に出るかで
   当たりを確認するのに使えます）。
   それさえあれば比較は即座に出せます。まず見るべきは `KF_SMG_T_ABREGEL`（0x2D7C）、
   `KF_SMG_T_AUFREGEL`（0x2DCC）、KI マップ 12 面（0x2B24–0x2D7B）です。
   CSL の SMG2 が速いという通説が正しければ、**差はこの範囲に出ます**。
   本リポジトリに `tools/compare/xdf_diff.py` を追加したので、
   `python3 tools/compare/xdf_diff.py 標準M3.bin CSL.bin --cat "^SMG$" --full` で出ます。

2. **SMG コントロールユニット側。** この 64 KB は DME だけです。SMG II の油圧ユニット側
   ECU に何が入っているか、アップロード車でそれが書き換わっているかは、ここからは分かりません。
   「CSL 変換で SMG2 が速くなる」が DME 側だけで起きているのか、SMG ECU も要るのかは
   **未確定**です。

3. **KI の決定式そのもの。** `smg_ki_shift_icon_level` は `stmts=2`。読む入力は確定して
   いますが、Drivelogic 段・アクセル・回転・横 G をどう合成して 1〜12 を出すかは
   **復元できていません**（`xref-only`）。§3.3 は入力の列挙であって、式ではありません。

4. **変速フェーズの振り分け。** `smg_shift_phase_dispatch_basic` / `_default` /
   `smg_shift_speed_reg_dispatcher` / `smg_expected_N_from_V_and_gear` は 4 本とも
   `stmts=0`。フェーズ 1/2/3 の遷移条件は未復元です。

5. **`K_SMG_J_MOTOR` の効き方。** 唯一の消費者 `smg_shift_deltaN_request_update` は
   `stmts=3` ですが、この名前はどの文にも出てきません（`xref-only`）。
   「軽量フライホイールなら下げる」は方向としては合理的でも、
   **どれだけ効くかは実測でしか分かりません**。お手元の車が既に 0.203125 に下げてあるので、
   0.25 に戻したログと比べれば答えは出ます。

6. **7.x のチューン意図。** 何が変わったかは実測ですが、**なぜそうしたか**は本人にしか
   分かりません。§7 の「〜という作法」はすべて値の並びからの読み取り（`inference`）です。

7. **`0x2C64` の名前。** `KF_SMG_KI_AUF_S` であることはレイアウト・軸・値域から
   ほぼ確実ですが、XDF にも Ghidra シンボルにも名前がありません（`inference`）。

---

## 付録: 使ったコマンド

```bash
# D1 からセッションを取得。$PREVIEW_ORIGIN と $TOK はここには書かない:
# トークンはプレビュー ビルドの <meta name="sync-token"> にあり、オリジンと
# 組み合わせると誰でも同期済みセッションを引ける。
curl -H "Authorization: Bearer $TOK" \
  "$PREVIEW_ORIGIN/api/sessions?limit=200"
curl -H "Authorization: Bearer $TOK" \
  "$PREVIEW_ORIGIN/api/sessions/<id>"
# -> sessionGz / binariesGz は gzip+base64。binaries.base が 64 KB の DME 読み出し

# パラメータ単位の差分
python3 tools/compare/xdf_diff.py A.bin B.bin --summary
python3 tools/compare/xdf_diff.py A.bin B.bin --cat "^SMG$" --full
python3 tools/compare/xdf_diff.py --dump A.bin --name "^K.?_SMG" --full

# 機構の確認
python3 .claude/skills/mss54-param-research/scripts/q.py func "smg"
python3 .claude/skills/mss54-param-research/scripts/q.py show smg_engine_speed_controller_step
python3 .claude/skills/mss54-param-research/scripts/q.py consumers KF_SMG_T_ABREGEL
```
