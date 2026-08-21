CSL '0401' Binary Disassembly Notes
======
## Welcome
Welcome to this project which seeks to progress the understanding of the CSL '0401' program binary.

## Parameter Relation Tree Viewer / パラメータ関連ツリービューア

A browser viewer that joins the XDF, the Funktionsrahmen and the Ghidra project
into one searchable relation tree: pick a calibration parameter and see which
code reads it, what that code computes, and which factory document describes it.
No Ghidra or Java needed to use it.

XDF・Funktionsrahmen・Ghidra の3資料を突き合わせ、パラメータを起点に「これを変えると
何に効くか / これは何から決まるか」を辿れるビューアです。利用するだけなら Ghidra も
Java も不要です。

```bash
cd app && npm ci && npm run dev
```

See **[docs/PARAMETER_TREE.md](docs/PARAMETER_TREE.md)** (日本語 / English) for how the
sources are joined, what the coverage actually is, and how to regenerate the data.

## Load Detection and the Base Map / 負荷検出とベースマップ

Why the standard (non-CSL) M3 has no VE table, what plays that role instead, and how
to compare a standard M3 against a CSL from datalogs — including which channels are
genuinely comparable and where the full-load boundary has to split the data.

標準（非CSL）M3 に VE テーブルが無い理由、その役割を何が担っているか、そして両者を
データログで比較するときに何が共通指標になるか（全負荷閾値での分割を含む）。

See **[docs/LOAD_PATH.md](docs/LOAD_PATH.md)** (日本語 / English).

## SMG2 and DME Tuning Approach / SMG2 と DME チューニング手法

What the DME actually holds for SMG II — 52 recovered control functions on the slave CPU,
the KI index that turns Drivelogic into a shift-ramp time in milliseconds, the rev-match PID,
and the safety-concept constants that must not be moved. Built from a real DME read and
checked against the CSL reference byte for byte; includes one KI map the XDF does not define.

SMG II の制御が DME のどこにあるか（スレーブ CPU に復元済み関数 52 本）、Drivelogic が
ミリ秒の変速ランプ時間になるまでの「KI」経路、回転合わせの PID、そして触ってはいけない
安全コンセプト定数。実車から読んだ DME を CSL リファレンスと全バイト比較した結果と、
XDF に定義が無い KI マップ 1 面の発見を含みます。

See **[docs/e46m3_smg2_dme_tuning_approach.md](docs/e46m3_smg2_dme_tuning_approach.md)** (日本語).

## Comparing two calibrations / 較正どうしの比較

`tools/compare/xdf_diff.py` decodes all 2,529 XDF parameters out of two images and reports
what differs in engineering units. It takes either shape — the 64 KB partial a DS2 read
produces, or a 1 MB full flash — and folds them onto one view, so a car read and a reference
binary compare directly.

```bash
python3 tools/compare/xdf_diff.py A.bin B.bin --summary          # differing count per category
python3 tools/compare/xdf_diff.py A.bin B.bin --cat "^SMG$" --full
python3 tools/compare/xdf_diff.py --dump A.bin --name "^K_SMG"   # one image, no comparison
```

## How to Contribute
To contribute to this project please use the "Issues" feature to report discoveries of new information and bugs (issues identified with existing information). If you have general questions or would like to discuss particular items in general please use the "Discussions" feature.

At present the Ghidra project file is available for download. Any additions / changes you make to it will need to be reported back as a "Discovery" using the Issues feature. In the future this project will possibly use the Ghidra server functionality to make the master project file available to multiple contributors at once, but for now let's keep things simple.

The most important thing to be aware of when inspecting the project file is that 3 binaries are loaded to it:

Full 211323000401PD31_TERRA.bin  
Master  
Slave  

The first item is a load of the entire binary. The second and third are the Master and Slave components of the binary split out. The Master and Slave items are the ones that should be used for disassembly and discovery.

## Wiki
This project makes use of the wiki feature.  
  
[Identified Functions](https://github.com/karter16/CSL_0401_Binary_Disassembly_Notes/wiki/Functions)  
[Identified Variables](https://github.com/karter16/CSL_0401_Binary_Disassembly_Notes/wiki/Global-Variables)
[Identified Variables](https://github.com/karter16/CSL_0401_Binary_Disassembly_Notes/wiki/Global-Variables)  
[Unidentified Parameters/Curves/Maps](https://github.com/karter16/CSL_0401_Binary_Disassembly_Notes/wiki/Unidentified-Maps,-Curves-&-Parameters)  

## Disassembly Tools
This project uses [Ghidra](https://ghidra-sre.org) which is a very powerful open source Software Reverse Engineering (SRE) toolset developed by the NSA.
  
This project also relies on the [following files](https://github.com/NationalSecurityAgency/ghidra/commit/fafd1bb00aaca30ee546de0485896ba4de1bacab) which have been enhanced to add the appropriate CPU32 support (particularly the TBL lookup instructions).

Once Ghidra has been installed and the CPU32 support added the [project files](https://github.com/karter16/CSL_0401_Binary_Disassembly_Notes/blob/master/CSL_0401_Binary_Disassembly_2024_12_16.gar) can be opened.

## Reference Documents  
Below are details of the reference documents provided:

[CPU32RM.pdf](https://github.com/karter16/CSL_0401_Binary_Disassembly_Notes/blob/master/CPU32RM.pdf): This is the reference document for the CPU32 architecture that the MSS54HP processors are based on. Useful for referencing instructions, etc.
  
[MC68376.pdf](https://github.com/karter16/CSL_0401_Binary_Disassembly_Notes/blob/master/MC68376.pdf): This is the Motorola reference document for the MC68336/376 processors. As far as I can tell the MSS54HP uses the MC68336 or a very similar variant of it.
  
[Full 211323000401PD31_TERRA.bin](https://github.com/karter16/CSL_0401_Binary_Disassembly_Notes/blob/master/Full%20211323000401PD31_TERRA.bin): The full 0401 binary (with Terra's bootloader modifications) copied here for reference/posterity.
  
[MSS54 Funktionsrahmen (Original German)](https://github.com/karter16/CSL_0401_Binary_Disassembly_Notes/tree/master/MSS54%20Funktionsrahmen/Original%20(German)): The MSS54 funktionsrahmen documents for reference.  
[MSS54 Funktionsrahmen (Translated English)](https://github.com/karter16/CSL_0401_Binary_Disassembly_Notes/tree/master/MSS54%20Funktionsrahmen/Translated%20(English)): The MSS54 funktionsrahmen documents translated to English for reference.
