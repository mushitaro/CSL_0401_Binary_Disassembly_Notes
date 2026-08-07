import type { GraphNode } from "./types";
import type { Indexed } from "./graph";

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
  /** Formula lines, only on the focused block. */
  lines?: { guard?: string; out: string; expr: string }[];
  /** Node id to select when clicked, when the thing exists in the graph. */
  target?: string;
  units?: string;
  detail?: string;
  /** True for the node the user selected, when the diagram had to centre on a
   *  neighbouring block to have anything to draw. */
  highlight?: boolean;
}

export interface DiagramEdge {
  from: string;
  to: string;
  d: string;
  kind: "read" | "write" | "call";
  /** Marks the wire as carrying one of several alternative tables. */
  alternative?: boolean;
}

export interface Diagram {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  width: number;
  height: number;
  focus: string;
  /** Statements ranked out of the box, reported instead of dropped silently. */
  hiddenLines: number;
  /** Inputs/outputs beyond the port cap, likewise reported. */
  hiddenPorts: number;
  /** Name of the parameter the user selected, when the block is a stand-in. */
  via?: string;
}

const CHAR_W = 6.9; // ui-monospace at 11.5px
const LINE_H = 17;
const PAD = 10;
const COL_GAP = 78;
const ROW_GAP = 12;
const PORT_H = 26;
const MIN_PORT_W = 120;
const MAX_PORT_W = 260;
const MAX_EXPR_CHARS = 78;
const MAX_LINES = 12;

function textWidth(text: string, charW = CHAR_W): number {
  return text.length * charW;
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
  if (/^KF_/.test(name)) return { kind: "map" };
  if (/^KL_/.test(name)) return { kind: "curve" };
  if (/^K_/.test(name)) return { kind: "constant" };
  if (/^[A-Z][A-Z0-9_]*$/.test(name)) return { kind: "signal" };
  return { kind: "unknown" };
}

/** Symbols that are literals, flags or decompiler noise rather than data. */
function isNoise(name: string): boolean {
  return (
    /^(0x[0-9a-fA-F]+|\d+)$/.test(name) ||
    /^(CONCAT\d+|SUB\d+|SCARRY\d+|ZEXT\d+|SEXT\d+|abs)$/.test(name) ||
    name.length < 2
  );
}

/** The interpolation and filter helpers are the operation the block performs,
 *  already legible inside the formula.  Drawing them as inputs as well would
 *  put "kfs_wint" on the canvas three times and crowd out the actual data. */
function isHelper(name: string): boolean {
  return /^(kf|kl)[su]_[wb]int$/.test(name) ||
    /^(PT1|IIR)_Filter_\w+$/.test(name) ||
    name === "tableLookup";
}

function wrapExpression(out: string, expr: string): string {
  const line = `${out} = ${expr}`;
  return line.length > MAX_EXPR_CHARS ? line.slice(0, MAX_EXPR_CHARS - 1) + "…" : line;
}

interface Port {
  name: string;
  kind: PortKind;
  target?: string;
  alternative: boolean;
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
    const outName = st.out.replace(/[\[\].>-].*$/, "");
    if (!isNoise(outName) && !outputs.has(outName)) {
      outputs.set(outName, { name: outName, ...classify(g, outName), alternative: false });
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

  const order: Record<PortKind, number> = {
    map: 0, curve: 1, constant: 2, signal: 3, block: 4, unknown: 5,
  };
  const sort = (a: Port, b: Port) =>
    order[a.kind] - order[b.kind] || a.name.localeCompare(b.name);
  return {
    inputs: [...inputs.values()].sort(sort),
    outputs: [...outputs.values()].sort(sort),
  };
}

const GLYPH_GUTTER = 28; // glyph column before the label

function portNode(
  p: Port,
  column: number,
  index: number,
  units?: string,
): DiagramNode {
  // The label starts after the glyph, so the box has to clear the gutter too;
  // sizing on the text alone clipped names like KL_TZ_START_TMOT.
  const w = clamp(GLYPH_GUTTER + textWidth(p.name) + PAD, MIN_PORT_W, MAX_PORT_W);
  return {
    id: `${column}:${p.name}`,
    key: p.name,
    label: p.name,
    kind: p.kind,
    column,
    x: 0,
    y: index,
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
function rankStatement(st: { expr: string; interp: unknown[] }): number {
  if (st.interp.length) return 0;
  if (/\b(KF_|KL_|K_)[A-Z0-9_]+/.test(st.expr)) return 1;
  if (/^0x[0-9a-f]+$|^-?\d+$/.test(st.expr.trim())) return 3; // a bare constant
  return 2;
}

export function buildDiagram(
  g: Indexed,
  focusId: string,
  maxPorts = 14,
  showAllLines = false,
): Diagram | null {
  const focus = g.byId.get(focusId);
  if (!focus) return null;

  // A parameter is not a computation; the diagram centres on the block that
  // consumes it, since that is where its value actually does something.
  if (focus.t !== "func") {
    const consumers = new Set<string>();
    for (const e of g.in.get(focusId) ?? []) {
      if (e.o === "fr") continue;
      const n = g.byId.get(e.s);
      if (n?.t === "func") consumers.add(n.id);
    }
    for (const e of g.out.get(focusId) ?? []) {
      if (e.o === "fr") continue;
      const n = g.byId.get(e.d);
      if (n?.t === "func") consumers.add(n.id);
    }
    const withFormula = [...consumers].find((id) => g.byId.get(id)?.stmts?.length);
    const pick = withFormula ?? [...consumers][0];
    if (!pick) return null;
    const d = buildDiagram(g, pick, maxPorts, showAllLines);
    if (d) {
      d.via = focus.name;
      for (const n of d.nodes) {
        if (n.target === focusId || n.key === focus.name) n.highlight = true;
      }
    }
    return d;
  }

  const { inputs, outputs } = collectPorts(g, focus);
  const shownInputs = inputs.slice(0, maxPorts);
  const shownOutputs = outputs.slice(0, maxPorts);

  const allStatements = focus.stmts ?? [];
  const ordered = allStatements
    .map((st, i) => ({ st, i }))
    .sort((a, b) => rankStatement(a.st) - rankStatement(b.st) || a.i - b.i);
  const kept = showAllLines ? ordered : ordered.slice(0, MAX_LINES);
  const hidden = allStatements.length - kept.length;
  // Restore source order within the kept set: the formulas read as a sequence.
  const lines = kept
    .sort((a, b) => a.i - b.i)
    .map(({ st }) => ({
      guard: st.guards.length ? st.guards.join(" AND ") : undefined,
      out: st.out,
      expr: st.expr,
    }));

  // Block box: wide enough for its widest formula, tall enough for all of them.
  const bodyLines = lines.flatMap((l) => (l.guard ? 2 : 1));
  const bodyCount = bodyLines.reduce((a, b) => a + b, 0);
  const widest = Math.max(
    textWidth(focus.name, 7.6),
    ...lines.map((l) => textWidth(wrapExpression(l.out, l.expr))),
    ...lines.map((l) => textWidth(`${l.out} = `)),
    ...lines.map((l) => (l.guard ? textWidth(`when ${l.guard}`) : 0)),
    240,
  );
  const blockW = clamp(widest + PAD * 2, 260, 620);
  const blockH = Math.max(PORT_H * 2, 34 + bodyCount * LINE_H + PAD);

  const nodes: DiagramNode[] = [];
  const inputNodes = shownInputs.map((p, i) => portNode(p, 0, i));
  const outputNodes = shownOutputs.map((p, i) => portNode(p, 2, i));

  const colW = [
    Math.max(MIN_PORT_W, ...inputNodes.map((n) => n.w)),
    blockW,
    Math.max(MIN_PORT_W, ...outputNodes.map((n) => n.w)),
  ];
  const colX = [0, colW[0] + COL_GAP, colW[0] + COL_GAP + blockW + COL_GAP];

  const stackH = (n: number) => n * PORT_H + Math.max(0, n - 1) * ROW_GAP;
  const height = Math.max(stackH(inputNodes.length), blockH, stackH(outputNodes.length)) + PAD * 2;

  const place = (list: DiagramNode[], column: number) => {
    const total = stackH(list.length);
    const top = (height - total) / 2;
    list.forEach((n, i) => {
      n.x = colX[column] + (colW[column] - n.w) / 2;
      n.y = top + i * (PORT_H + ROW_GAP);
      nodes.push(n);
    });
  };
  place(inputNodes, 0);
  place(outputNodes, 2);

  const blockNode: DiagramNode = {
    id: `1:${focus.name}`,
    key: focus.name,
    label: focus.name,
    kind: "block",
    column: 1,
    x: colX[1],
    y: (height - blockH) / 2,
    w: blockW,
    h: blockH,
    lines,
    target: focus.id,
    detail: focus.bank,
  };
  nodes.push(blockNode);

  const edges: DiagramEdge[] = [];
  const wire = (a: DiagramNode, b: DiagramNode, kind: DiagramEdge["kind"], alt: boolean) => {
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const mid = x1 + (x2 - x1) / 2;
    // Orthogonal routing: out, across, in. Reads as a wiring diagram rather
    // than a spline, which is what the factory drawings do too.
    edges.push({
      from: a.id,
      to: b.id,
      kind,
      alternative: alt,
      d: `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`,
    });
  };

  inputNodes.forEach((n, i) =>
    wire(n, blockNode, shownInputs[i].kind === "block" ? "call" : "read", shownInputs[i].alternative),
  );
  outputNodes.forEach((n) => wire(blockNode, n, "write", false));

  return {
    nodes,
    edges,
    width: colX[2] + colW[2] + 2,
    height,
    focus: focus.id,
    hiddenLines: hidden,
    hiddenPorts:
      inputs.length - shownInputs.length + (outputs.length - shownOutputs.length),
  };
}
