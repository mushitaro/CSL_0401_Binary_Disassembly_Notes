import type { GraphNode, Statement } from "./types";
import { displayName } from "./names";

/**
 * Turn a recovered formula into something a tuner can read.
 *
 * `parse_logic` recovers what the block computes, but it recovers it in the
 * decompiler's own dialect: `kfs_wint(KF_TZ_GRUND,N,RF)` is a C call whose
 * name encodes the table's storage format, `x >> 8` is a scaling step written
 * as a bit shift, and `DAT_00ffeb3e` is an address the decompiler failed to
 * name. None of that is wrong; it is just written for the wrong reader.
 *
 * Everything here is presentation. The original C is kept alongside and shown
 * on demand, because a rewrite that quietly disagreed with the decompiler
 * would be worse than no rewrite at all.
 */

export interface FormatContext {
  /** RAM symbol names by address, for resolving `DAT_...`. */
  ramByAddr: Map<number, string>;
  /** Node lookup by symbol name, for descriptions. */
  nodeByName: (name: string) => GraphNode | undefined;
  glossary: Record<string, string>;
  lang: "ja" | "en";
}

export interface FormattedLine {
  out: string;
  expr: string;
  /** `expr` clipped to the width the box was measured at; what is drawn. */
  shown?: string;
  guard?: string;
  /** Plain-language reading of the guard, when the terms are all known. */
  guardGloss?: string;
  /** Plain-language reading of the assignment, when the operands are known. */
  gloss?: string;
  /** The untouched `out = expr` as the decompiler produced it. */
  raw: string;
  /** Machine plumbing rather than calibration: folded away by default. */
  noise: boolean;
}

// --------------------------------------------------------------------------
// expression rewriting
// --------------------------------------------------------------------------

const LOOKUP_RE = /^(kf|kl)([su])([wb])int$/;

/** Split `a, b, c` at depth 0. Brace groups are alternatives, not nesting. */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out;
}

/** Find `name(...)` calls and hand the argument text to `rewrite`. */
function rewriteCalls(
  text: string,
  rewrite: (name: string, args: string[]) => string | null,
): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const m = /([A-Za-z_]\w*)\(/.exec(text.slice(i));
    if (!m) {
      out += text.slice(i);
      break;
    }
    const nameStart = i + m.index;
    const open = nameStart + m[1].length;
    let depth = 0;
    let close = -1;
    for (let j = open; j < text.length; j++) {
      if (text[j] === "(") depth++;
      else if (text[j] === ")") {
        depth--;
        if (depth === 0) {
          close = j;
          break;
        }
      }
    }
    if (close < 0) {
      out += text.slice(i);
      break;
    }
    const inner = rewriteCalls(text.slice(open + 1, close), rewrite);
    const replaced = rewrite(m[1], splitArgs(inner));
    out += text.slice(i, nameStart);
    out += replaced ?? `${m[1]}(${inner})`;
    i = close + 1;
  }
  return out;
}

/** `{A | B | C}` renders with a full-width bar so it reads as one token. */
function formatAlternatives(token: string): string {
  const m = token.match(/^\{(.+)\}$/s);
  if (!m) return token;
  return `{${m[1].split("|").map((s) => s.trim()).join(" ｜ ")}}`;
}

function shiftToScale(text: string): string {
  // `>> 8` is how the firmware divides by 256; the shift is an implementation
  // detail of a fixed-point scale factor, and reads as noise in a formula.
  return text
    .replace(/\s*>>\s*(\d+)/g, (_m, n) => ` ÷ ${2 ** Number(n)}`)
    .replace(/\s*<<\s*(\d+)/g, (_m, n) => ` × ${2 ** Number(n)}`);
}

function resolveData(text: string, ctx: FormatContext): string {
  return text.replace(/\b(?:DAT|UNK|PTR)_([0-9a-fA-F]{6,8})\b/g, (_m, hex) => {
    const addr = parseInt(hex, 16);
    const name = ctx.ramByAddr.get(addr);
    if (name) return displayName(name);
    return `RAM[0x${addr.toString(16).toUpperCase().padStart(6, "0")}]`;
  });
}

export function formatExpression(expr: string, ctx: FormatContext): string {
  let text = rewriteCalls(expr, (name, args) => {
    const lookup = LOOKUP_RE.exec(name.replace(/_/g, ""));
    if (lookup && args.length >= 2) {
      const table = formatAlternatives(args[0]);
      const axes = args.slice(1).join(", ");
      // A Kennfeld is indexed on two axes, a Kennlinie evaluated on one; the
      // bracket/paren distinction is the one the factory diagrams use.
      return lookup[1] === "kf" ? `${table}[${axes}]` : `${table}(${axes})`;
    }
    if (name === "tableLookup" && args.length === 2) {
      return `${formatAlternatives(args[0])}[${args[1]}]`;
    }
    const filter = /^(PT1|IIR)_Filter_\w+$/.exec(name);
    if (filter && args.length >= 2) {
      return `${filter[1]}(${args[0]}, τ=${args[1]})`;
    }
    return null;
  });
  text = shiftToScale(text);
  text = resolveData(text, ctx);
  text = text.replace(/\{[^{}]+\}/g, (m) => formatAlternatives(m));
  return text.replace(/\s+/g, " ").trim();
}

// --------------------------------------------------------------------------
// guards
// --------------------------------------------------------------------------

/**
 * Engine-state words are bit fields whose bits have German names, so
 * `(ZUSTAND_MOTOR & LL) == 0` means "not at idle". Left as a mask test it is
 * the single most common guard in the firmware and reads as nothing at all.
 */
const STATE_WORDS = new Set(["ZUSTAND_MOTOR", "ZUSTAND_MOTOR2", "START_ST", "TPU_ST_M"]);

/**
 * The engine-state bits, in the factory's German with a reading.
 *
 * Only the bits whose meaning is settled are listed. `stateBitGloss` gives up
 * unless every bit in the mask is known, so a guard mentioning an unlisted bit
 * keeps its mask form instead of being half-translated into a guess.
 */
const STATE_BITS: Record<string, { ja: string; en: string }> = {
  LL: { ja: "アイドル(Leerlauf)", en: "idle (Leerlauf)" },
  VL: { ja: "全負荷(Vollast)", en: "full load (Vollast)" },
  TL: { ja: "部分負荷(Teillast)", en: "part load (Teillast)" },
  S: { ja: "減速燃料カット(Schub)", en: "overrun (Schub)" },
  Start: { ja: "始動中(Start)", en: "cranking (Start)" },
  Nachlauf: { ja: "停止後の後処理(Nachlauf)", en: "after-run (Nachlauf)" },
  "KI.15 aus": { ja: "イグニッションOFF(Klemme 15 aus)", en: "ignition off (Klemme 15 aus)" },
  "Kl15 aus": { ja: "イグニッションOFF(Klemme 15 aus)", en: "ignition off (Klemme 15 aus)" },
};

function stateBitGloss(bits: string[], negated: boolean, ctx: FormatContext): string | undefined {
  const names = bits.map((b) => STATE_BITS[b]?.[ctx.lang]).filter(Boolean) as string[];
  if (!names.length || names.length !== bits.length) return undefined;
  const list = names.join(ctx.lang === "ja" ? "・" : " / ");
  if (ctx.lang === "ja") return negated ? `${list} のとき` : `${list} でないとき`;
  return negated ? `while ${list}` : `while not ${list}`;
}

export function formatGuard(
  guard: string,
  ctx: FormatContext,
): { text: string; gloss?: string } {
  const text = formatExpression(guard, ctx);
  // (WORD & (A|B|C)) == 0  -> none of those states;  != 0 -> any of them.
  const m = /^\(?\s*([A-Z][A-Z0-9_]*)\s*&\s*\(?([^()]+?)\)?\s*\)?\s*(==|!=)\s*0\s*$/.exec(
    guard.trim(),
  );
  if (m && STATE_WORDS.has(m[1])) {
    const bits = m[2].split("|").map((s) => s.trim()).filter(Boolean);
    const gloss = stateBitGloss(bits, m[3] === "!=", ctx);
    if (gloss) return { text, gloss };
  }
  return { text };
}

// --------------------------------------------------------------------------
// what the line means
// --------------------------------------------------------------------------

/**
 * True for the stamp the XDF editor writes into a description it did not have.
 *
 * 1,986 of the 2,272 descriptions in the XDF are this block rather than prose —
 * a tool version, a file layout and a match ratio. Read as a description it is
 * worse than an empty field, because it looks like an answer.
 */
export function isToolMetadata(desc: string): boolean {
  return /\bHW:\d|MatchRatio|BlockFound|Created by find routine|File Orientation/.test(desc);
}

/** A description worth showing a reader, or nothing. */
export function meaningfulDescription(
  node: GraphNode | undefined,
  lang: "ja" | "en",
): string | undefined {
  const desc = lang === "ja" ? (node?.desc?.ja ?? node?.desc?.en) : node?.desc?.en;
  if (!desc || isToolMetadata(desc)) return undefined;
  return desc;
}

function describe(name: string, ctx: FormatContext): string | undefined {
  const desc = meaningfulDescription(ctx.nodeByName(name), ctx.lang);
  if (!desc) return undefined;
  // Descriptions run to a paragraph; the gloss is one line, so take the head.
  const head = desc.split(/[.。\n]/)[0].trim();
  return head.length > 40 ? undefined : head || undefined;
}

/**
 * One line of plain language under the formula.
 *
 * Built only from descriptions that exist: a block whose operands are all
 * undocumented gets no gloss rather than an invented one. Guessing here would
 * be the worst kind of wrong, because a gloss is exactly what a reader who
 * cannot read the formula will trust.
 */
export function glossFor(st: Statement, ctx: FormatContext): string | undefined {
  const outDesc = describe(st.out, ctx);
  const parts: string[] = [];
  for (const it of st.interp) {
    const table = it.tables[0];
    if (!table) continue;
    const tableDesc = describe(table, ctx) ?? displayName(table);
    const axes = it.axes.map((a) => describe(a, ctx) ?? displayName(a));
    if (ctx.lang === "ja") {
      const by = axes.length ? `${axes.join("×")} で` : "";
      parts.push(`${tableDesc} を ${by}補間`);
    } else {
      const by = axes.length ? ` over ${axes.join(" × ")}` : "";
      parts.push(`interpolate ${tableDesc}${by}`);
    }
  }
  if (!parts.length && !outDesc) return undefined;
  const target = outDesc ?? displayName(st.out);
  if (!parts.length) return ctx.lang === "ja" ? `${target} を求める` : `compute ${target}`;
  return ctx.lang === "ja"
    ? `${target} ← ${parts.join("、")}`
    : `${target} ← ${parts.join(", ")}`;
}

// --------------------------------------------------------------------------
// noise
// --------------------------------------------------------------------------

/**
 * Statements that are the machine's business rather than the calibration's.
 *
 * A third of the recovered statements are pointer walks, peripheral register
 * pokes and decompiler temporaries. They are honest output and worth keeping,
 * but showing them by default buries the two lines in a block that actually
 * interpolate a map. They are folded, and the count is always shown.
 */
export function isNoise(st: Statement, ctx: FormatContext): boolean {
  if (st.interp.length) return false;
  const text = `${st.out} = ${st.expr}`;
  if (/\b(?:KF|KL|K)_[A-Z0-9_]+/.test(text)) return false;
  if (
    /\b(?:DAT|UNK|PTR)_[0-9a-fA-F]{6,8}\b/.test(text) ||
    /\bparam_\d+\b/.test(text) ||
    /\b[a-z]{1,3}Var\d+\b/.test(text) ||
    /\b\w+_\d+_\d+_\b/.test(text) ||
    /\*\s*\(/.test(text) ||
    /\b(?:SIM_|TPU_|QSM_|SIM\b)/.test(text)
  ) {
    return true;
  }
  // A bare constant is plumbing when it lands somewhere the graph has never
  // heard of (a decompiler local, a peripheral register), and real logic when
  // it lands on a known signal: `CFG_RAM_SG_TYP = 2` selects the control unit
  // variant, which is exactly the sort of line a tuner is looking for.
  if (/^\s*[\w.[\]]+\s*=\s*(?:0x[0-9a-fA-F]+|-?\d+)\s*$/.test(text)) {
    const target = st.out.replace(/[[\].>-].*$/, "");
    return !ctx.nodeByName(target);
  }
  return false;
}

export function formatStatement(st: Statement, ctx: FormatContext): FormattedLine {
  const guards = st.guards.map((g) => formatGuard(g, ctx));
  const glosses = guards.map((g) => g.gloss).filter(Boolean) as string[];
  return {
    // The assigned-to name needs the same address resolution as the operands;
    // it is the same kind of symbol, just on the other side of the "=".
    out: resolveData(displayName(st.out), ctx),
    expr: formatExpression(st.expr, ctx),
    guard: guards.length ? guards.map((g) => g.text).join(ctx.lang === "ja" ? " かつ " : " AND ") : undefined,
    guardGloss:
      glosses.length === guards.length && glosses.length
        ? glosses.join(ctx.lang === "ja" ? "、かつ " : ", and ")
        : undefined,
    gloss: glossFor(st, ctx),
    raw: `${st.out} = ${st.expr}`,
    noise: isNoise(st, ctx),
  };
}

/** Build the lookup context once per graph load. */
export function makeContext(
  nodes: GraphNode[],
  nameIndex: Record<string, string>,
  byId: Map<string, GraphNode>,
  glossary: Record<string, string>,
  lang: "ja" | "en",
): FormatContext {
  const ramByAddr = new Map<number, string>();
  for (const n of nodes) {
    if (n.t === "ram" && n.addr !== undefined && !ramByAddr.has(n.addr)) {
      ramByAddr.set(n.addr, n.name);
    }
  }
  return {
    ramByAddr,
    nodeByName: (name) => {
      const id = nameIndex[name] ?? nameIndex[name.toLowerCase()];
      return id ? byId.get(id) : undefined;
    },
    glossary,
    lang,
  };
}
