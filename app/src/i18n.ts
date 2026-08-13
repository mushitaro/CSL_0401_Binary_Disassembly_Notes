export type Lang = "ja" | "en";

const STRINGS = {
  appTitle: {
    ja: "MSS54HP CSL '0401' DME ロジック図",
    en: "MSS54HP CSL '0401' DME Logic Diagram",
  },
  search: { ja: "検索（日本語・英語・ニーモニック）", en: "Search (name, mnemonic or description)" },
  categories: { ja: "カテゴリ", en: "Categories" },
  results: { ja: "検索結果", en: "Results" },
  about: { ja: "このデータについて", en: "About this data" },
  selectPrompt: {
    ja: "左からパラメータを選んでください。",
    en: "Pick a parameter on the left to begin.",
  },

  // detail
  address: { ja: "アドレス", en: "Address" },
  bank: { ja: "プロセッサ", en: "Processor" },
  master: { ja: "マスター", en: "Master" },
  slave: { ja: "スレーブ", en: "Slave" },
  units: { ja: "単位", en: "Units" },
  scaling: { ja: "スケーリング式", en: "Scaling" },
  width: { ja: "データ幅", en: "Width" },
  signed: { ja: "符号付き", en: "signed" },
  unsigned: { ja: "符号なし", en: "unsigned" },
  value: { ja: "値", en: "Value" },
  rawValue: { ja: "生値", en: "Raw" },
  description: { ja: "説明", en: "Description" },
  descriptionEnOnly: {
    ja: "（この説明はまだ和訳されていません。誤訳を避けるため機械翻訳では埋めていません）",
    en: "",
  },
  table: { ja: "データ", en: "Data" },
  documents: { ja: "純正機能仕様書", en: "Factory documentation" },
  openGerman: { ja: "独語原本", en: "German original" },
  openEnglish: { ja: "英訳（機械翻訳）", en: "English (machine translated)" },
  noDocs: {
    ja: "この項目に言及する Funktionsrahmen は見つかりませんでした。",
    en: "No Funktionsrahmen page mentions this.",
  },

  // diagram
  blockDiagram: { ja: "ロジック図", en: "Logic diagram" },
  diagramTab: { ja: "ロジック図", en: "Diagram" },
  treeTab: { ja: "関連ツリー", en: "Tree" },
  noDiagram: {
    ja: "この項目を計算に使っているブロックが見つかりませんでした。",
    en: "No block computing with this was found.",
  },
  diagramVia: { ja: "を使うブロック:", en: "is used by the block" },
  diagramParamFocus: {
    ja: "を読むブロックを右に並べています。",
    en: "the blocks that read it are shown to the right.",
  },
  legend: { ja: "凡例", en: "Legend" },
  diagramDepth: { ja: "前後の階層", en: "Levels shown" },
  expandBlock: { ja: "式を開く", en: "Open" },
  collapseBlock: { ja: "式を畳む", en: "Close" },
  blocksHidden: { ja: "表示しきれない隣接ブロック", en: "neighbouring blocks not shown" },
  moreLines: { ja: "他", en: "more" },
  showRawC: { ja: "逆コンパイル結果（C）を表示", en: "Show the decompiled C" },
  hideRawC: { ja: "C 表示をやめる", en: "Hide the decompiled C" },
  noiseLines: {
    ja: "ポインタ操作・レジスタ操作など、校正に関係しない行",
    en: "pointer and register plumbing, unrelated to calibration",
  },
  showNoise: { ja: "機械寄りの行も表示", en: "Show plumbing lines" },
  hideNoise: { ja: "機械寄りの行を畳む", en: "Hide plumbing lines" },
  legendNotation: {
    ja: "KF_X[A,B] = 2軸マップ補間、KL_X(A) = カーブ補間、÷256 等は元は右シフト。",
    en: "KF_X[A,B] interpolates a 2-axis map, KL_X(A) a curve; ÷256 was a right shift.",
  },
  legendInferred: {
    ja: "細い点線 = 式ではなく実測の相互参照から推定した接続",
    en: "thin dotted = wiring inferred from cross-references, not from a formula",
  },
  legendCase: {
    ja: "大文字 = データ（マップ・定数・信号）、小文字 = コード（関数）。",
    en: "CAPITALS are data (maps, constants, signals); lower case is code (functions).",
  },
  originalSpelling: { ja: "原綴", en: "As written" },

  // windows
  windows: { ja: "ウィンドウ", en: "Windows" },
  wTable: { ja: "パラメータ表", en: "Parameter data" },
  wDesc: { ja: "説明", en: "Description" },
  wTree: { ja: "ツリー", en: "Trees" },
  wDocs: { ja: "純正資料", en: "Documents" },
  tabTable: { ja: "テーブル", en: "Table" },
  tabChart: { ja: "グラフ", en: "Chart" },
  tabParamTree: { ja: "パラメータ", en: "Parameters" },
  tabSignalTree: { ja: "信号の流れ", en: "Signal flow" },
  tabCallTree: { ja: "呼び出し", en: "Calls" },
  chartRow: { ja: "断面", en: "Section" },
  noChart: { ja: "図にできる値がありません。", en: "Nothing here to plot." },
  showEverything: { ja: "関連と式を全部出す", en: "Show every relation and formula" },
  showKeyOnly: { ja: "要点だけ表示", en: "Show the key parts only" },
  selectForWindows: {
    ja: "パラメータかブロックを選ぶと、ここに内容が出ます。",
    en: "Pick a parameter or a block to fill this.",
  },
  viaSignal: { ja: "経由", en: "via" },
  noValuesForBlock: {
    ja: "ブロックには数表がありません。マップ・カーブ・定数を選ぶと出ます。",
    en: "A block has no table of its own. Pick a map, curve or constant.",
  },

  // comments
  commentModeOn: { ja: "コメントを付ける", en: "Comment on screen" },
  commentModeOff: { ja: "コメントを終える", en: "Stop commenting" },
  commentHint: {
    ja: "気になる所をクリックしてください。ブロック・式・入出力・ウィンドウのどれでも指せます。",
    en: "Click whatever looks wrong — a block, a formula, a port or a window.",
  },
  commentPlaceholder: {
    ja: "ここが読みにくい／この値がおかしい など（⌘/Ctrl+Enter で保存）",
    en: "What is wrong with it? (⌘/Ctrl+Enter to save)",
  },
  commentSave: { ja: "保存", en: "Save" },
  commentCancel: { ja: "やめる", en: "Cancel" },
  commentList: { ja: "コメント一覧", en: "Comments" },
  commentDelete: { ja: "削除", en: "Delete" },
  commentGoto: { ja: "この箇所へ移動", en: "Scroll to this" },
  commentClear: { ja: "全部消す", en: "Clear all" },
  commentClearConfirm: {
    ja: "コメントを全部消します。よろしいですか？",
    en: "Delete every comment. Are you sure?",
  },
  commentCopy: { ja: "コピーして貼り付け用に", en: "Copy for pasting back" },
  commentCopied: { ja: "コピーしました", en: "Copied" },
  commentExportHint: {
    ja: "これをコピーして会話に貼ってください。番号で返信します。コメントはこのブラウザにだけ保存され、どこにも送信されません。",
    en: "Copy this into the conversation; replies come back by number. Comments stay in this browser and are sent nowhere.",
  },
  showAllLines: { ja: "残りの式も表示", en: "Show the remaining lines" },
  showFewerLines: { ja: "主要な式だけ表示", en: "Show only the key lines" },
  portsHidden: { ja: "表示しきれない入出力", en: "inputs/outputs not shown" },
  linesRanked: {
    ja: "式はマップ・カーブ・定数を使う行を優先して表示しています。",
    en: "Lines touching a map, curve or constant are shown first.",
  },
  legendAlt: {
    ja: "破線 = 運転状態によって切り替わる入力（どれか1つが使われる）",
    en: "dashed = alternative input, one of them is used depending on state",
  },
  legendFormula: {
    ja: "ブロック内の式は Ghidra の逆コンパイル結果から復元したものです。中間変数は畳み込んであります。",
    en: "Formulas inside a block are recovered from the Ghidra decompiler, with temporaries folded away.",
  },

  // tree
  relationTree: { ja: "関連ツリー", en: "Relation tree" },
  downstream: { ja: "下流：これを変えると何に効くか", en: "Downstream: what this affects" },
  upstream: { ja: "上流：これは何から決まるか", en: "Upstream: what determines this" },
  depth: { ja: "深さ", en: "Depth" },
  sources: { ja: "出典", en: "Sources" },
  originXref: { ja: "バイナリ実測", en: "Binary (measured)" },
  originScan: { ja: "推定スキャン", en: "Operand scan (inferred)" },
  originFr: { ja: "純正仕様書", en: "Factory documents" },
  showDense: { ja: "索引ページも含める", en: "Include index pages" },
  repeated: { ja: "既出", en: "already shown" },
  truncated: { ja: "以降は省略", en: "more not shown" },
  noRelations: {
    ja: "選択した出典では関連が見つかりませんでした。出典フィルタを広げてみてください。",
    en: "No relations under the selected sources. Try enabling more sources.",
  },
  noUpstreamForParam: {
    ja: "このパラメータはフラッシュ上の設定値なので、コードが書き込む上流はありません。ここが入力そのものです。軸の値と、下流で読み出す関数をご覧ください。",
    en: "This is a calibration value in flash, so no code writes it - it is the input. Look at its axes and at what reads it downstream instead.",
  },
  agreementBoth: { ja: "仕様一致", en: "matches docs" },
  agreementFrOnly: { ja: "仕様のみ・未確認", en: "documented, unconfirmed" },

  decompiled: { ja: "逆コンパイル結果 (Ghidra)", en: "Decompiled C (Ghidra)" },
  showCode: { ja: "コードを表示", en: "Show code" },
  hideCode: { ja: "コードを隠す", en: "Hide code" },
  codeCaveat: {
    ja: "Ghidra の逆コンパイル出力そのままです。変数名や型は解析結果であり、元のソースではありません。",
    en: "Raw Ghidra decompiler output. Names and types are analysis results, not original source.",
  },

  // node kinds
  kParam: { ja: "パラメータ", en: "parameter" },
  kFunc: { ja: "関数", en: "function" },
  kRam: { ja: "RAM 変数", en: "RAM variable" },
  kFrpage: { ja: "仕様書ページ", en: "document page" },
  kUnknown: { ja: "仕様書のみに存在", en: "documents only" },
  kindConstant: { ja: "定数", en: "constant" },
  kindCurve: { ja: "カーブ (2D)", en: "curve (2-D)" },
  kindMap: { ja: "マップ (3D)", en: "map (3-D)" },

  // edge kinds
  eRead: { ja: "読み出し", en: "reads" },
  eWrite: { ja: "書き込み", en: "writes" },
  eCall: { ja: "呼び出し", en: "calls" },
  eDocumented: { ja: "記載あり", en: "documented on" },
  eDocuments: { ja: "同一ブロック", en: "same block" },

  // confidence
  confDocumented: { ja: "確定情報", en: "documented source" },
  confDerived: { ja: "逆アセンブル由来", en: "from disassembly" },

  // about
  coverageTitle: { ja: "被覆率", en: "Coverage" },
  aboutIntro: {
    ja: "このビューアは3つの独立した資料を突き合わせています。数字は実測値であり、網羅しているように見せる加工はしていません。",
    en: "This viewer joins three independent sources. The numbers below are measured, not rounded up to look complete.",
  },
  aboutFrDirection: {
    ja: "重要：仕様書由来の関連は「同じ機能ブロックのページに一緒に載っている」ことのみを意味し、どちらが入力かという向きは含みません。構造図の矢印は図形であってテキストではないため、向きは抽出できていません。上流／下流の向きは Ghidra の read/write からのみ導いています。",
    en: "Important: a documentation relation only means the two names appear on the same functional-block page. It carries no direction — the Strukturbild arrows are vector graphics, not text, so no direction was extracted. Upstream/downstream comes from Ghidra's read/write classification alone.",
  },
  aboutScan: {
    ja: "「推定スキャン」は、命令オペランドの値が既知のキャリブレーションアドレスと一致した箇所から合成したエッジです。推定であり、誤りを含みます。既定では表示しています が、断定には使わないでください。",
    en: "\"Operand scan\" edges are synthesised where an instruction operand equals a known calibration address. They are inferences and some are wrong.",
  },
  aboutTranslation: {
    ja: "英訳版 Funktionsrahmen は Google 機械翻訳です。ニーモニックの抽出には独語原本のみを使っています。",
    en: "The English Funktionsrahmen are Google machine translations; mnemonics were extracted from the German originals only.",
  },
} as const;

export type StringKey = keyof typeof STRINGS;

export function t(lang: Lang, key: StringKey): string {
  return STRINGS[key][lang];
}

export function pickLocalised(
  lang: Lang,
  value: { ja?: string | null; en?: string | null; de?: string | null } | undefined,
): string {
  if (!value) return "";
  if (lang === "ja" && value.ja) return value.ja;
  return value.en || value.de || value.ja || "";
}
