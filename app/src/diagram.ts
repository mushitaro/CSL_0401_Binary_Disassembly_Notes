import type { GraphNode, Statement } from "./types";
import type { Indexed } from "./graph";
import { type FormatContext, type FormattedLine, formatStatement } from "./logic-format";
import { displayName } from "./names";

/**
 * Layout for the block diagram.
 *
 * The shape is the one the factory Strukturbilder use: quantities flow left to
 * right through boxes that compute something. Columns are assigned by role
 * rather than by a generic graph algorithm, because the roles are known and
 * fixed — a reader wants inputs on the left, the computation in the middle and
 * results on the right, every time, in the same place.
 *
 *   producers │ inputs │ BLOCK (formula) │ outputs │ consumers
 *
 * A block is rarely interesting alone: `tz_calc` reads N and RF, and the
 * question a tuner has next is always "and where does RF come from". So the
 * chain is followed outwards to a chosen depth. What makes that terminate is
 * that only *signals* have producers — a map, curve or constant is a leaf,
 * being a number in flash rather than something computed — so widening the
 * view adds blocks along the few RAM signals that carry state, not everything.
 *
 * Positions are computed here rather than by a layout library so the whole
 * viewer stays dependency-free and the result is deterministic: the same block
 * always draws the same way, which matters when two people compare screens.
 */

export type PortKind = "map" | "curve" | "constant" | "signal" | "block" | "unknown";

export interface DiagramNode {
  id: string;
  key: string;
  label: string;
  kind: PortKind;
  column: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Formula lines. Full on the focused block, a relevant extract on others. */
  lines?: FormattedLine[];
  /** Whether each line's plain-language gloss is drawn (focus only). */
  showGloss?: boolean;
  /** Node id to select when clicked, when the thing exists in the graph. */
  target?: string;
  units?: string;
  detail?: string;
  /** True for the node the user selected. */
  highlight?: boolean;
  /** A neighbouring block shown in brief; it can be opened in place. */
  collapsed?: boolean;
  /** Statements not shown on a collapsed neighbour, reported not dropped. */
  moreLines?: number;
  /** Distance from the focus in blocks: 0 is the focus itself. */
  depth?: number;
}

export interface DiagramEdge {
  from: string;
  to: string;
  d: string;
  kind: "read" | "write" | "call";
  /** Marks the wire as carrying one of several alternative tables. */
  alternative?: boolean;
  /** The wire came from measured cross-references, not from a formula. */
  inferred?: boolean;
}

export interface Diagram {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  width: number;
  height: number;
  focus: string;
  /** Statements ranked out of the focused box, reported not dropped. */
  hiddenLines: number;
  /** Inputs/outputs beyond the port cap, likewise reported. */
  hiddenPorts: number;
  /** Neighbouring blocks beyond the per-column cap. */
  hiddenBlocks: number;
  /** Plumbing lines folded out of the focused block. */
  hiddenNoise: number;
  /** Set when the focus is a parameter rather than a block. */
  paramFocus?: string;
}

export interface DiagramOptions {
  /** Formatting context; the layout must measure the text that is drawn. */
  ctx: FormatContext;
  maxPorts?: number;
  showAllLines?: boolean;
  /** Include the pointer/register plumbing lines. */
  showNoise?: boolean;
  /** How many blocks outwards to follow, in each direction. */
  depth?: number;
  /** Neighbour block keys the reader has opened. */
  expanded?: ReadonlySet<string>;
}

const CHAR_W = 6.9; // ui-monospace at 11.5px
const LINE_H = 17;
const PAD = 10;
const COL_GAP = 54;
const ROW_GAP = 12;
const PORT_H = 26;
const MIN_PORT_W = 120;
const MAX_PORT_W = 260;
const MAX_EXPR_CELLS = 78;
const MAX_LINES = 12;
const MAX_NEIGHBOUR_LINES = 2;
const MAX_BLOCKS_PER_COLUMN = 5;

/**
 * Width in monospace cells, not in code points.
 *
 * The glosses and state-bit readings are Japanese, and kana and kanji occupy
 * two cells each. Measuring them as one made every box with a translated line
 * in it about half the width its text needed, so the text ran out through the
 * border.
 */
function cells(text: string): number {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    n += wide ? 2 : 1;
  }
  return n;
}

/** Cut `text` to at most `limit` cells, marking the cut. */
function clipCells(text: string, limit: number): string {
  if (cells(text) <= limit) return text;
  let n = 0;
  let out = "";
  for (const ch of text) {
    const w = cells(ch);
    if (n + w > limit - 1) break;
    out += ch;
    n += w;
  }
  return out + "…";
}

function textWidth(text: string, charW = CHAR_W): number {
  return cells(text) * charW;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Split "{A | B | C}" into its alternatives; a plain name yields itself. */
export function alternatives(token: string): string[] {
  const m = token.match(/^\{(.+)\}$/);
  if (!m) return [token];
  return m[1].split("|").map((s) => s.trim());
}

export function classify(g: Indexed, name: string): { kind: PortKind; target?: string } {
  const id = g.raw.nameIndex[name] ?? g.raw.nameIndex[name.toLowerCase()];
  const node = id ? g.byId.get(id) : undefined;
  if (node?.t === "param") {
    return {
      kind: node.kind === "map" ? "map" : node.kind === "curve" ? "curve" : "constant",
      target: id,
    };
  }
  if (node?.t === "func") return { kind: "block", target: id };
  if (node?.t === "ram") return { kind: "signal", target: id };
  // Not in the graph: fall back to the naming scheme the factory uses.
  if (/^KF_/i.test(name)) return { kind: "map" };
  if (/^KL_/i.test(name)) return { kind: "curve" };
  if (/^K_/i.test(name)) return { kind: "constant" };
  if (/^[A-Z][A-Z0-9_]*$/.test(name)) return { kind: "signal" };
  return { kind: "unknown" };
}

/** Symbols that are literals, flags or decompiler noise rather than data. */
function isNoise(name: string): boolean {
  return (
    /^(0x[0-9a-fA-F]+|\d+)$/.test(name) ||
    /^(CONCAT\d+|SUB\d+|SCARRY\d+|ZEXT\d+|SEXT\d+|abs)$/.test(name) ||
    /^(DAT|UNK|PTR)_[0-9a-fA-F]{6,8}$/.test(name) ||
    /^param_\d+$/.test(name) ||
    name.length < 2
  );
}

/** The interpolation and filter helpers are the operation the block performs,
 *  already legible inside the formula.  Drawing them as inputs as well would
 *  put "kfs_wint" on the canvas three times and crowd out the actual data. */
export function isHelper(name: string): boolean {
  return (
    /^(kf|kl)[su]_[wb]int$/.test(name) ||
    /^(PT1|IIR)_Filter_\w+$/.test(name) ||
    /^mem(cpy|set|move)/.test(name) ||
    name === "tableLookup"
  );
}

/**
 * Clip a formula to the width the box is measured at.
 *
 * The box used to be sized on a clipped string but drawn with the full one, so
 * any formula past the limit ran out through the right-hand border. The clip
 * now happens once, here, and the untruncated text stays on the line for the
 * tooltip.
 */
function clipExpression(out: string, expr: string): string {
  return clipCells(expr, Math.max(10, MAX_EXPR_CELLS - cells(out) - 3));
}

function wrapExpression(out: string, expr: string): string {
  return `${out} = ${clipExpression(out, expr)}`;
}

/** Guards are drawn on their own line, so they get the whole width. */
function clipGuard(text: string): string {
  return clipCells(text, MAX_EXPR_CELLS);
}

/** The name a statement assigns to, without any index or member suffix. */
function outName(st: Statement): string {
  return st.out.replace(/[[\].>-].*$/, "");
}

// --------------------------------------------------------------------------
// who writes a signal, who reads it
// --------------------------------------------------------------------------

interface Chain {
  writers: Map<string, string[]>;
  readers: Map<string, string[]>;
}

const CHAIN_CACHE = new WeakMap<Indexed, Chain>();

/**
 * Index the signals that connect blocks to each other.
 *
 * The formulas are the better source — they say which quantity a block
 * actually assigns — so they are indexed first. Measured cross-references fill
 * in for the 110 blocks that have no recovered formula, which keeps the older
 * inferred wiring available without letting it outvote the formulas.
 */
function chainIndex(g: Indexed): Chain {
  const cached = CHAIN_CACHE.get(g);
  if (cached) return cached;

  const writers = new Map<string, string[]>();
  const readers = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, key: string, id: string) => {
    const list = m.get(key);
    if (!list) m.set(key, [id]);
    else if (!list.includes(id)) list.push(id);
  };

  for (const node of g.raw.nodes) {
    if (node.t !== "func") continue;
    if (node.stmts?.length) {
      for (const st of node.stmts) {
        const out = outName(st);
        if (!isNoise(out) && classify(g, out).kind === "signal") add(writers, out, node.id);
        for (const r of st.reads) {
          if (isNoise(r) || isHelper(r)) continue;
          if (classify(g, r).kind === "signal") add(readers, r, node.id);
        }
      }
      continue;
    }
    for (const e of g.out.get(node.id) ?? []) {
      if (e.o === "fr") continue;
      const other = g.byId.get(e.d);
      if (other?.t !== "ram") continue;
      add(e.k === "write" ? writers : readers, other.name, node.id);
    }
  }

  const chain: Chain = { writers, readers };
  CHAIN_CACHE.set(g, chain);
  return chain;
}

// --------------------------------------------------------------------------
// ports
// --------------------------------------------------------------------------

interface Port {
  name: string;
  kind: PortKind;
  target?: string;
  alternative: boolean;
}

const PORT_ORDER: Record<PortKind, number> = {
  map: 0, curve: 1, constant: 2, signal: 3, block: 4, unknown: 5,
};

function sortPorts(a: Port, b: Port): number {
  return PORT_ORDER[a.kind] - PORT_ORDER[b.kind] || a.name.localeCompare(b.name);
}

function collectPorts(g: Indexed, node: GraphNode): { inputs: Port[]; outputs: Port[] } {
  const inputs = new Map<string, Port>();
  const outputs = new Map<string, Port>();

  for (const st of node.stmts ?? []) {
    const alt = new Set<string>();
    for (const m of st.expr.matchAll(/\{([^{}]+)\}/g)) {
      for (const piece of m[1].split("|")) alt.add(piece.trim());
    }
    for (const raw of st.reads) {
      if (isNoise(raw) || isHelper(raw)) continue;
      if (!inputs.has(raw)) {
        inputs.set(raw, { name: raw, ...classify(g, raw), alternative: alt.has(raw) });
      }
    }
    for (const call of st.calls) {
      if (isNoise(call) || isHelper(call)) continue;
      const c = classify(g, call);
      if (c.kind === "block" && !inputs.has(call)) {
        inputs.set(call, { name: call, ...c, alternative: false });
      }
    }
    const out = outName(st);
    if (!isNoise(out) && !outputs.has(out)) {
      outputs.set(out, { name: out, ...classify(g, out), alternative: false });
    }
  }

  // A block with no recovered formula still has measured references, so the
  // wiring is drawn from those instead of leaving an empty diagram.
  if (inputs.size === 0 && outputs.size === 0) {
    for (const e of g.out.get(node.id) ?? []) {
      if (e.o === "fr") continue;
      const other = g.byId.get(e.d);
      if (!other || other.t === "frpage") continue;
      const port: Port = {
        name: other.name,
        ...classify(g, other.name),
        alternative: e.o === "scan",
      };
      port.target = other.id;
      if (e.k === "write") outputs.set(other.name, port);
      else inputs.set(other.name, port);
    }
  }

  return {
    inputs: [...inputs.values()].sort(sortPorts),
    outputs: [...outputs.values()].sort(sortPorts),
  };
}

const GLYPH_GUTTER = 28; // glyph column before the label

function portNode(p: Port, layer: number, units?: string): DiagramNode {
  const label = displayName(p.name, p.kind === "block" ? "func" : undefined);
  // The label starts after the glyph, so the box has to clear the gutter too;
  // sizing on the text alone clipped names like KL_TZ_START_TMOT.
  const w = clamp(GLYPH_GUTTER + textWidth(label) + PAD, MIN_PORT_W, MAX_PORT_W);
  return {
    id: `L${layer}:${p.name}`,
    key: p.name,
    label,
    kind: p.kind,
    column: layer,
    x: 0,
    y: 0,
    w,
    h: PORT_H,
    target: p.target,
    units,
  };
}

/**
 * Rank statements by how much they tell a tuner.
 *
 * A large block such as md_limiter_calc has 32 assignments but only one that
 * interpolates a table; the rest are status bits and clamps. Showing all 32
 * turns the box into a wall, and taking the first twelve would hide the single
 * line that names a curve. So the lines that touch calibration data come
 * first, and the remainder is reported as a count rather than dropped quietly.
 */
function rankStatement(st: Statement): number {
  if (st.interp.length) return 0;
  if (/\b(KF_|KL_|K_)[A-Z0-9_]+/i.test(st.expr)) return 1;
  if (/^0x[0-9a-f]+$|^-?\d+$/.test(st.expr.trim())) return 3; // a bare constant
  return 2;
}

/** The best few lines for the focused block: calibration first, source order. */
function focusLines(
  node: GraphNode,
  showAll: boolean,
  ctx: FormatContext,
  showNoise: boolean,
): { lines: FormattedLine[]; hidden: number; noise: number } {
  const all = (node.stmts ?? []).map((st, i) => ({ line: formatStatement(st, ctx), st, i }));
  const usable = showNoise ? all : all.filter((r) => !r.line.noise);
  const ordered = usable.sort(
    (a, b) => rankStatement(a.st) - rankStatement(b.st) || a.i - b.i,
  );
  const kept = showAll ? ordered : ordered.slice(0, MAX_LINES);
  return {
    lines: [...kept].sort((a, b) => a.i - b.i).map((r) => r.line),
    // What the "show the rest" button will actually reveal. Counting the
    // folded plumbing here too would promise lines that button does not show;
    // those have their own toggle and their own count.
    hidden: usable.length - kept.length,
    noise: all.length - usable.length,
  };
}

/**
 * The lines of a neighbour that concern the signal it shares with the focus.
 *
 * A neighbour is on screen to answer one question — "where does RF come from"
 * — so it shows the assignment to RF, not its other thirty statements. Opening
 * it swaps in the full set without moving anything else.
 */
function neighbourLines(
  node: GraphNode,
  signal: string,
  expanded: boolean,
  ctx: FormatContext,
  showNoise: boolean,
): { lines: FormattedLine[]; more: number } {
  const all = node.stmts ?? [];
  if (expanded) {
    const { lines, hidden, noise } = focusLines(node, false, ctx, showNoise);
    return { lines, more: hidden + noise };
  }
  const relevant = all.filter(
    (st) => outName(st) === signal || st.reads.includes(signal),
  );
  const kept = (relevant.length ? relevant : all).slice(0, MAX_NEIGHBOUR_LINES);
  return {
    lines: kept.map((st) => formatStatement(st, ctx)),
    more: all.length - kept.length,
  };
}

/** Height of one rendered line; the renderer steps by exactly these. */
export const LINE_STEP = LINE_H;
export const GLOSS_STEP = 15;
export const FOOTER_STEP = 15;

function lineHeight(l: FormattedLine, showGloss: boolean): number {
  return (
    (l.guard ? LINE_STEP : 0) + LINE_STEP + (showGloss && l.gloss ? GLOSS_STEP : 0)
  );
}

function blockSize(
  label: string,
  lines: FormattedLine[],
  showGloss: boolean,
  footer: boolean,
  maxWidth: number,
): { w: number; h: number } {
  const body = lines.reduce((a, l) => a + lineHeight(l, showGloss), 0);
  const widest = Math.max(
    textWidth(label, 7.6),
    ...lines.map((l) => textWidth(wrapExpression(l.out, l.expr))),
    ...lines.map((l) => (l.guard ? textWidth(`when ${l.guardGloss ?? l.guard}`) : 0)),
    ...lines.map((l) => (showGloss && l.gloss ? textWidth(l.gloss) + 12 : 0)),
    200,
  );
  // A block with nothing recovered is just its name; padding it to two rows of
  // empty space makes it look like something failed to load.
  const h = lines.length
    ? Math.max(PORT_H * 2, 34 + body + (footer ? FOOTER_STEP : 0) + PAD)
    : 30 + (footer ? FOOTER_STEP : 0);
  return { w: clamp(widest + PAD * 2, 220, maxWidth), h };
}

function blockNode(
  node: GraphNode,
  layer: number,
  lines: FormattedLine[],
  opts: { collapsed?: boolean; more?: number; depth: number },
): DiagramNode {
  const label = displayName(node.name, "func");
  const showGloss = opts.depth === 0;
  // A neighbour is context; letting one grow to the focus block's width makes
  // the column ragged and the wires long for no gain in what it tells you.
  const maxWidth = opts.depth === 0 ? 620 : 420;
  const shown = lines.map((l) => ({
    ...l,
    shown: clipExpression(l.out, l.expr),
    guard: l.guard ? clipGuard(l.guardGloss ?? l.guard) : undefined,
    guardGloss: l.guardGloss ? clipGuard(l.guardGloss) : undefined,
  }));
  const { w, h } = blockSize(label, shown, showGloss, (opts.more ?? 0) > 0, maxWidth);
  return {
    id: `L${layer}:${node.name}`,
    key: node.name,
    label,
    kind: "block",
    column: layer,
    x: 0,
    y: 0,
    w,
    h,
    lines: shown,
    target: node.id,
    detail: node.bank,
    collapsed: opts.collapsed,
    moreLines: opts.more,
    depth: opts.depth,
    showGloss,
  };
}

// --------------------------------------------------------------------------
// assembly
// --------------------------------------------------------------------------

interface Wire {
  from: string;
  to: string;
  kind: DiagramEdge["kind"];
  alternative?: boolean;
  inferred?: boolean;
}

export function buildDiagram(
  g: Indexed,
  focusId: string,
  opts: DiagramOptions,
): Diagram | null {
  const focus = g.byId.get(focusId);
  if (!focus) return null;
  const maxPorts = opts.maxPorts ?? 14;
  const depth = clamp(opts.depth ?? 1, 1, 3);
  const expanded = opts.expanded ?? new Set<string>();
  const ctx = opts.ctx;
  const showNoise = opts.showNoise ?? false;

  const layers = new Map<number, DiagramNode[]>();
  const wires: Wire[] = [];
  const push = (layer: number, node: DiagramNode) => {
    const list = layers.get(layer);
    if (list) list.push(node);
    else layers.set(layer, [node]);
    return node;
  };

  let hiddenPorts = 0;
  let hiddenBlocks = 0;
  let hiddenLines = 0;
  let hiddenNoise = 0;

  // A parameter is not a computation, so it anchors the left edge and the
  // blocks that use it fan out to the right. The previous behaviour was to
  // re-centre on one consumer, which showed the reader a block they had not
  // asked for and hid the others entirely.
  if (focus.t !== "func") {
    const consumers = new Set<string>();
    for (const e of g.in.get(focusId) ?? []) {
      if (e.o !== "fr" && g.byId.get(e.s)?.t === "func") consumers.add(e.s);
    }
    for (const e of g.out.get(focusId) ?? []) {
      if (e.o !== "fr" && g.byId.get(e.d)?.t === "func") consumers.add(e.d);
    }
    const users = [...consumers]
      .map((id) => g.byId.get(id)!)
      .sort((a, b) => (b.stmts?.length ?? 0) - (a.stmts?.length ?? 0));
    if (!users.length) return null;
    const shown = users.slice(0, MAX_BLOCKS_PER_COLUMN + 1);
    hiddenBlocks += users.length - shown.length;

    const anchor = push(
      -1,
      portNode(
        { name: focus.name, ...classify(g, focus.name), alternative: false },
        -1,
      ),
    );
    anchor.highlight = true;
    anchor.target = focus.id;

    for (const user of shown) {
      const isOpen = expanded.has(user.name);
      const { lines, more } = neighbourLines(user, focus.name, isOpen, ctx, showNoise);
      const bn = push(0, blockNode(user, 0, lines, { collapsed: !isOpen, more, depth: 1 }));
      wires.push({ from: anchor.id, to: bn.id, kind: "read" });

      const outs = collectPorts(g, user).outputs.filter((p) => p.kind === "signal");
      for (const o of outs.slice(0, 3)) {
        const existing = (layers.get(1) ?? []).find((n) => n.key === o.name);
        const on = existing ?? push(1, portNode(o, 1));
        wires.push({ from: bn.id, to: on.id, kind: "write" });
      }
    }
    return finish(g, layers, wires, {
      focus: focus.id,
      hiddenLines: 0,
      hiddenPorts,
      hiddenBlocks,
      hiddenNoise: 0,
      paramFocus: displayName(focus.name, focus.t),
    });
  }

  // ---- the focused block -------------------------------------------------
  const { inputs, outputs } = collectPorts(g, focus);
  const shownInputs = inputs.slice(0, maxPorts);
  const shownOutputs = outputs.slice(0, maxPorts);
  hiddenPorts += inputs.length - shownInputs.length + (outputs.length - shownOutputs.length);

  const { lines, hidden, noise } = focusLines(focus, opts.showAllLines ?? false, ctx, showNoise);
  hiddenLines = hidden;
  hiddenNoise = noise;
  const centre = push(0, blockNode(focus, 0, lines, { depth: 0 }));
  centre.highlight = true;

  // Called blocks belong on the upstream side: the focus depends on them.
  const inputPorts = shownInputs.filter((p) => p.kind !== "block");
  const calledBlocks = shownInputs.filter((p) => p.kind === "block");

  for (const p of inputPorts) {
    const n = push(-1, portNode(p, -1));
    wires.push({ from: n.id, to: centre.id, kind: "read", alternative: p.alternative });
  }
  for (const p of shownOutputs) {
    const n = push(1, portNode(p, 1));
    wires.push({ from: centre.id, to: n.id, kind: "write" });
  }

  const drawn = new Set<string>([focus.name]);

  /**
   * Follow the chain one block outwards from a column of signals.
   *
   * `sign` is -1 upstream and +1 downstream; everything else is symmetric, so
   * the two directions share this rather than being written twice and drifting.
   */
  const spread = (signalLayer: number, sign: -1 | 1, level: number) => {
    if (level > depth) return;
    const chain = chainIndex(g);
    const blockLayer = signalLayer + sign;
    const signalNodes = (layers.get(signalLayer) ?? []).filter((n) => n.kind === "signal");
    const candidates: { node: GraphNode; signal: string }[] = [];

    for (const sn of signalNodes) {
      const ids = (sign === -1 ? chain.writers : chain.readers).get(sn.key) ?? [];
      for (const id of ids) {
        const node = g.byId.get(id);
        if (!node || drawn.has(node.name)) continue;
        if (isHelper(node.name)) continue;
        candidates.push({ node, signal: sn.key });
      }
    }
    // Blocks that touch calibration data are the ones worth the space.
    candidates.sort((a, b) => score(b.node) - score(a.node));
    const shown = candidates.slice(0, MAX_BLOCKS_PER_COLUMN);
    hiddenBlocks += candidates.length - shown.length;

    for (const { node, signal } of shown) {
      drawn.add(node.name);
      const isOpen = expanded.has(node.name);
      const { lines: nl, more } = neighbourLines(node, signal, isOpen, ctx, showNoise);
      const bn = push(
        blockLayer,
        blockNode(node, blockLayer, nl, { collapsed: !isOpen, more, depth: level }),
      );
      const sn = (layers.get(signalLayer) ?? []).find((n) => n.key === signal)!;
      const inferred = !node.stmts?.length;
      if (sign === -1) wires.push({ from: bn.id, to: sn.id, kind: "write", inferred });
      else wires.push({ from: sn.id, to: bn.id, kind: "read", inferred });
    }

    if (level >= depth) return;
    // The next signal column out: what those blocks read (or write) in turn.
    const nextSignalLayer = blockLayer + sign;
    for (const bn of layers.get(blockLayer) ?? []) {
      const node = g.byId.get(bn.target!);
      if (!node) continue;
      const ports = collectPorts(g, node);
      const list = (sign === -1 ? ports.inputs : ports.outputs).filter(
        (p) => p.kind === "signal" && !drawn.has(p.name),
      );
      for (const p of list.slice(0, 3)) {
        const existing = (layers.get(nextSignalLayer) ?? []).find((n) => n.key === p.name);
        const pn = existing ?? push(nextSignalLayer, portNode(p, nextSignalLayer));
        if (sign === -1) wires.push({ from: pn.id, to: bn.id, kind: "read" });
        else wires.push({ from: bn.id, to: pn.id, kind: "write" });
      }
    }
    spread(nextSignalLayer, sign, level + 1);
  };

  // Callees sit in the first upstream block column, next to the signal writers.
  for (const p of calledBlocks) {
    const node = p.target ? g.byId.get(p.target) : undefined;
    if (!node) continue;
    drawn.add(node.name);
    const isOpen = expanded.has(node.name);
    const { lines: nl, more } = neighbourLines(node, "", isOpen, ctx, showNoise);
    const bn = push(-2, blockNode(node, -2, nl, { collapsed: !isOpen, more, depth: 1 }));
    wires.push({ from: bn.id, to: centre.id, kind: "call" });
  }

  spread(-1, -1, 1);
  spread(1, 1, 1);

  return finish(g, layers, wires, {
    focus: focus.id,
    hiddenLines,
    hiddenPorts,
    hiddenBlocks,
    hiddenNoise,
  });
}

/** How much a neighbouring block is likely to be worth showing. */
function score(node: GraphNode): number {
  const stmts = node.stmts ?? [];
  let s = 0;
  for (const st of stmts) {
    if (st.interp.length) s += 10;
    else if (/\b(KF_|KL_|K_)[A-Z0-9_]+/i.test(st.expr)) s += 4;
  }
  if (node.named) s += 2;
  return s + Math.min(stmts.length, 5);
}

/** Place the columns, route the wires, and measure the canvas. */
function finish(
  _g: Indexed,
  layers: Map<number, DiagramNode[]>,
  wires: Wire[],
  meta: {
    focus: string;
    hiddenLines: number;
    hiddenPorts: number;
    hiddenBlocks: number;
    hiddenNoise: number;
    paramFocus?: string;
  },
): Diagram {
  const indices = [...layers.keys()].sort((a, b) => a - b);
  const colW = new Map<number, number>();
  for (const i of indices) {
    colW.set(i, Math.max(MIN_PORT_W, ...layers.get(i)!.map((n) => n.w)));
  }

  const stackH = (nodes: DiagramNode[]) =>
    nodes.reduce((a, n) => a + n.h, 0) + Math.max(0, nodes.length - 1) * ROW_GAP;
  const height = Math.max(...indices.map((i) => stackH(layers.get(i)!))) + PAD * 2;

  let x = 0;
  const colX = new Map<number, number>();
  for (const i of indices) {
    colX.set(i, x);
    x += colW.get(i)! + COL_GAP;
  }
  const width = x - COL_GAP + 2;

  const nodes: DiagramNode[] = [];
  for (const i of indices) {
    const list = layers.get(i)!;
    const width = colW.get(i)!;
    let y = (height - stackH(list)) / 2;
    for (const n of list) {
      // Boxes in a column differ in width, and centring them scattered the
      // points the wires attach to. Aligning each column towards the focus
      // puts every departure point on one vertical line, so the wires run
      // parallel instead of fanning.
      const offset = i < 0 ? width - n.w : i > 0 ? 0 : (width - n.w) / 2;
      n.x = colX.get(i)! + offset;
      n.y = y;
      y += n.h + ROW_GAP;
      nodes.push(n);
    }
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: DiagramEdge[] = [];
  for (const w of wires) {
    const a = byId.get(w.from);
    const b = byId.get(w.to);
    if (!a || !b) continue;
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const mid = x1 + (x2 - x1) / 2;
    // Orthogonal routing: out, across, in. Reads as a wiring diagram rather
    // than a spline, which is what the factory drawings do too.
    edges.push({
      from: w.from,
      to: w.to,
      kind: w.kind,
      alternative: w.alternative,
      inferred: w.inferred,
      d: `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`,
    });
  }

  return {
    nodes,
    edges,
    width,
    height,
    focus: meta.focus,
    hiddenLines: meta.hiddenLines,
    hiddenPorts: meta.hiddenPorts,
    hiddenBlocks: meta.hiddenBlocks,
    hiddenNoise: meta.hiddenNoise,
    paramFocus: meta.paramFocus,
  };
}
