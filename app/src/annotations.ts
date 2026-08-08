/**
 * Comments pinned to the screen.
 *
 * The loop this closes: a reader spots something wrong, and describing it in
 * prose ("the box on the left, third line") costs more than the observation is
 * worth and still arrives ambiguous. Here they click the thing and type.
 *
 * A pin remembers *what* it was put on, not just where. Coordinates drift the
 * moment the diagram is scrolled, the depth is changed or a window is moved,
 * and a pin that has drifted is worse than no pin because it now points at
 * something the comment was not about. So each pin carries an anchor — the
 * block, the formula, the window — and is re-found on that anchor at render
 * time, falling back to its stored point only when the anchor is gone.
 */

export interface Anchor {
  /** What kind of thing was clicked, for the exported line. */
  kind: "block" | "port" | "formula" | "guard" | "gloss" | "window" | "tree" | "sidebar" | "page";
  /** The identifying text: a block name, a formula, a window title. */
  label: string;
  /** The block a formula line belongs to, when the click was inside one. */
  within?: string;
}

export interface Pin {
  id: number;
  anchor: Anchor;
  text: string;
  /** Where the reader clicked, as a fallback and to order the list. */
  x: number;
  y: number;
  /** What was on screen at the time, so a comment can be read back in place. */
  context: string;
  createdAt: number;
}

const KEY = "mss54.pins";

export function loadPins(): Pin[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Pin[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function savePins(pins: Pin[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(pins));
  } catch {
    /* the comments simply do not survive a reload here */
  }
}

// --------------------------------------------------------------------------
// what was clicked
// --------------------------------------------------------------------------

/**
 * The text a reader actually sees in an element.
 *
 * `textContent` also returns the contents of any `<title>` child, and every
 * formula in the diagram carries one holding the decompiler's original C. Left
 * in, a comment on `TZ_GRUND = {3 maps}[N, RF]` would be labelled with the
 * rendered form and the raw form run together.
 */
function textOf(el: Element | null): string {
  if (!el) return "";
  const clone = el.cloneNode(true) as Element;
  for (const tip of clone.querySelectorAll("title")) tip.remove();
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** The block box an element sits inside, if any. */
function enclosingBlock(el: Element): string | undefined {
  const box = el.closest("svg.diagram .block");
  return box ? textOf(box.querySelector(".block-title")) : undefined;
}

/**
 * Describe the thing under the pointer.
 *
 * Ordered most specific first: a formula line inside a block is a better
 * anchor than the block, and the block is a better anchor than "the diagram".
 */
export function describeTarget(el: Element): Anchor {
  const formula = el.closest("svg.diagram .formula");
  if (formula) {
    return { kind: "formula", label: textOf(formula), within: enclosingBlock(formula) };
  }
  const guard = el.closest("svg.diagram .guard");
  if (guard) {
    return { kind: "guard", label: textOf(guard), within: enclosingBlock(guard) };
  }
  const gloss = el.closest("svg.diagram .gloss");
  if (gloss) {
    return { kind: "gloss", label: textOf(gloss), within: enclosingBlock(gloss) };
  }
  const block = el.closest("svg.diagram .block");
  if (block) {
    return { kind: "block", label: textOf(block.querySelector(".block-title")) };
  }
  const port = el.closest("svg.diagram .port");
  if (port) {
    return { kind: "port", label: textOf(port.querySelector("text")) };
  }
  const treeRow = el.closest(".tree-row");
  if (treeRow) {
    return { kind: "tree", label: textOf(treeRow.querySelector(".node-name")) };
  }
  const floating = el.closest(".floating");
  if (floating) {
    return { kind: "window", label: textOf(floating.querySelector(".floating-title")) };
  }
  if (el.closest("aside")) {
    const button = el.closest("button");
    return { kind: "sidebar", label: button ? textOf(button) : "サイドバー / sidebar" };
  }
  return { kind: "page", label: textOf(el.closest("section, header, main")).slice(0, 60) };
}

/**
 * Find the element a pin was placed on, so it follows its subject.
 *
 * Matched on the anchor's own text within the right kind of element. Two
 * identical formulas in one diagram would both match; the first is taken,
 * which is wrong only in a case where the two are interchangeable anyway.
 */
export function locate(anchor: Anchor): Element | null {
  const scan = (selector: string, label: string): Element | null => {
    for (const el of document.querySelectorAll(selector)) {
      if (textOf(el) === label) return el;
    }
    return null;
  };
  switch (anchor.kind) {
    case "formula":
      return scan("svg.diagram .formula", anchor.label);
    case "guard":
      return scan("svg.diagram .guard", anchor.label);
    case "gloss":
      return scan("svg.diagram .gloss", anchor.label);
    case "block":
      return scan("svg.diagram .block-title", anchor.label);
    case "port":
      return scan("svg.diagram .port text", anchor.label);
    case "tree":
      return scan(".tree-row .node-name", anchor.label);
    case "window":
      return scan(".floating-title", anchor.label);
    default:
      return null;
  }
}

// --------------------------------------------------------------------------
// handing the comments back
// --------------------------------------------------------------------------

const KIND_LABEL: Record<Anchor["kind"], { ja: string; en: string }> = {
  block: { ja: "ブロック", en: "block" },
  port: { ja: "入出力", en: "port" },
  formula: { ja: "式", en: "formula" },
  guard: { ja: "条件", en: "guard" },
  gloss: { ja: "意味行", en: "gloss" },
  window: { ja: "ウィンドウ", en: "window" },
  tree: { ja: "ツリー", en: "tree" },
  sidebar: { ja: "サイドバー", en: "sidebar" },
  page: { ja: "画面", en: "page" },
};

/**
 * The comments as text to paste back into the conversation.
 *
 * Written for a reader who cannot see the screen: every pin names its subject
 * and the view it was made in, so each one can be acted on without a
 * screenshot. Numbered, because the reply will refer to the numbers.
 */
export function formatPins(pins: Pin[], lang: "ja" | "en", context: string): string {
  if (!pins.length) return "";
  const head =
    lang === "ja"
      ? `# 画面コメント ${pins.length}件\n表示中: ${context}\n`
      : `# Screen comments (${pins.length})\nViewing: ${context}\n`;
  const body = pins
    .map((p, i) => {
      const kind = KIND_LABEL[p.anchor.kind][lang];
      const within = p.anchor.within ? ` @ ${p.anchor.within}` : "";
      const subject = p.anchor.label ? `${kind}${within}: ${p.anchor.label}` : kind;
      const where = p.context && p.context !== context ? `\n   (${p.context})` : "";
      return `\n${i + 1}. [${subject}]${where}\n   ${p.text}`;
    })
    .join("\n");
  return head + body + "\n";
}
