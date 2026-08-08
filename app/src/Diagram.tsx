import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import type { Indexed } from "./graph";
import { type DiagramNode, buildDiagram } from "./diagram";
import { owningBlock } from "./block-tree";
import { type FormattedLine, makeContext } from "./logic-format";
import { displayName } from "./names";
import { type Lang, t } from "./i18n";

/**
 * The block diagram.
 *
 * Every quantity is shaped by what it is, not just labelled: a 3-D map is a
 * box with a grid, a 2-D curve carries its curve, a constant is a small pill,
 * a signal is a plain tag. A tuner scanning the picture needs to see "that
 * input is a map I can edit" without reading the name first.
 *
 * Neighbouring blocks open where they stand. Following a chain by replacing
 * the whole view loses the reader's place, and the thing they clicked is the
 * one thing that then is not on screen.
 */

const KIND_LABEL = {
  map: "kindMap",
  curve: "kindCurve",
  constant: "kindConstant",
  signal: "kRam",
  block: "kFunc",
  unknown: "kUnknown",
} as const;

function KindGlyph({ kind }: { kind: DiagramNode["kind"] }) {
  switch (kind) {
    case "map":
      // A 3x3 grid: the map is a field of values over two axes.
      return (
        <g className="glyph">
          <rect x={0} y={0} width={12} height={12} rx={1} />
          <path d="M4 0V12M8 0V12M0 4H12M0 8H12" />
        </g>
      );
    case "curve":
      // One rising line: a curve is a value over a single axis.
      return (
        <g className="glyph">
          <rect x={0} y={0} width={12} height={12} rx={1} />
          <path d="M1.5 10.5C4 10.5 5 2.5 10.5 2.5" fill="none" />
        </g>
      );
    case "constant":
      return (
        <g className="glyph">
          <circle cx={6} cy={6} r={4} />
        </g>
      );
    case "block":
      return (
        <g className="glyph">
          <rect x={0} y={2} width={12} height={8} rx={1} />
        </g>
      );
    default:
      // A signal: a wire tag.
      return (
        <g className="glyph">
          <path d="M0 6H12M9 3l3 3-3 3" fill="none" />
        </g>
      );
  }
}

export function Diagram({
  g,
  rootId,
  selectedId,
  lang,
  trail,
  onSelect,
  onBack,
}: {
  g: Indexed;
  /** The block the picture is drawn around. */
  rootId: string;
  /** What the reader last picked; lit up in place rather than re-centred. */
  selectedId: string;
  lang: Lang;
  trail: string[];
  onSelect: (id: string) => void;
  onBack: (id: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [showNoise, setShowNoise] = useState(false);
  const [everything, setEverything] = useState(true);
  const [depth, setDepth] = useState(1);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const scroller = useRef<HTMLDivElement>(null);

  const ctx = useMemo(
    () => makeContext(g.raw.nodes, g.raw.nameIndex, g.byId, g.raw.glossary, lang),
    [g, lang],
  );
  const diagram = useMemo(() => {
    const opts = {
      ctx,
      maxPorts: 14,
      showAllLines: showAll,
      showNoise,
      showEverything: everything,
      depth,
      expanded,
      highlight: selectedId,
    };
    const first = buildDiagram(g, rootId, opts);
    // The picture only moves when what the reader picked is genuinely not in
    // it. Rebuilding on every selection was the old behaviour, and it answered
    // a question nobody had asked.
    if (first?.nodes.some((n) => n.target === selectedId)) return first;
    const picked = g.byId.get(selectedId);
    const owner = picked ? owningBlock(g, picked) : null;
    if (owner && owner.id !== rootId) return buildDiagram(g, owner.id, opts) ?? first;
    return first ?? (picked ? buildDiagram(g, selectedId, opts) : null);
  }, [g, rootId, selectedId, ctx, showAll, showNoise, everything, depth, expanded]);

  // With producers on the left the focused block is no longer at x=0, and a
  // wide chain would otherwise open scrolled to a neighbour rather than to the
  // block the reader asked for.
  useEffect(() => {
    const el = scroller.current;
    // Scroll to what the reader picked, falling back to the block the picture
    // is drawn around.
    const centre =
      diagram?.nodes.find((n) => n.target === selectedId) ??
      diagram?.nodes.find((n) => n.depth === 0);
    if (!el || !centre) return;
    el.scrollLeft = Math.max(0, centre.x + centre.w / 2 - el.clientWidth / 2);
  }, [diagram, selectedId]);

  if (!diagram) {
    return <p className="empty-note">{t(lang, "noDiagram")}</p>;
  }

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="diagram-wrap">
      {trail.length > 1 && (
        <nav className="breadcrumb" aria-label={t(lang, "blockDiagram")}>
          {trail.map((id, i) => {
            const node = g.byId.get(id);
            if (!node) return null;
            const last = i === trail.length - 1;
            return (
              <span key={id}>
                {i > 0 && <span className="crumb-sep">›</span>}
                {last ? (
                  <strong>{displayName(node.name, node.t)}</strong>
                ) : (
                  <button className="crumb" onClick={() => onBack(id)}>
                    {displayName(node.name, node.t)}
                  </button>
                )}
              </span>
            );
          })}
        </nav>
      )}

      {diagram.paramFocus && (
        <p className="note">
          <strong>{diagram.paramFocus}</strong> {t(lang, "diagramParamFocus")}
        </p>
      )}

      <div className="diagram-controls">
        <label>
          {t(lang, "diagramDepth")}
          <input
            type="range"
            min={1}
            max={3}
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value))}
          />
          <span className="depth-value">{depth}</span>
        </label>
        <button
          className={everything ? "active" : ""}
          onClick={() => setEverything((v) => !v)}
        >
          {everything ? t(lang, "showKeyOnly") : t(lang, "showEverything")}
        </button>
        {(showNoise || diagram.hiddenNoise > 0) && (
          <button onClick={() => setShowNoise((v) => !v)}>
            {showNoise
              ? t(lang, "hideNoise")
              : `${t(lang, "showNoise")} (+${diagram.hiddenNoise})`}
          </button>
        )}
      </div>

      <div className="diagram-scroll" ref={scroller}>
        <svg
          className="diagram"
          width={diagram.width}
          height={diagram.height}
          viewBox={`0 0 ${diagram.width} ${diagram.height}`}
          role="img"
          aria-label={t(lang, "blockDiagram")}
        >
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 8 8"
              refX={7}
              refY={4}
              markerWidth={7}
              markerHeight={7}
              orient="auto-start-reverse"
            >
              <path d="M0 0.5 L 8 4 L 0 7.5 z" className="arrowhead" />
            </marker>
          </defs>

          {diagram.edges.map((e, i) => (
            <path
              key={i}
              d={e.d}
              className={`wire wire-${e.kind}${e.alternative ? " wire-alt" : ""}${
                e.inferred ? " wire-inferred" : ""
              }`}
              markerEnd="url(#arrow)"
            />
          ))}

          {diagram.nodes.map((n) =>
            n.kind === "block" ? (
              <BlockBox key={n.id} n={n} lang={lang} onSelect={onSelect} onToggle={toggle} />
            ) : (
              <PortBox key={n.id} n={n} lang={lang} onSelect={onSelect} />
            ),
          )}
        </svg>
      </div>

      {(diagram.hiddenLines > 0 || diagram.hiddenPorts > 0 || diagram.hiddenBlocks > 0) && (
        <p className="note diagram-hidden">
          {diagram.hiddenLines > 0 && (
            <button onClick={() => setShowAll((v) => !v)}>
              {showAll
                ? t(lang, "showFewerLines")
                : `${t(lang, "showAllLines")} (+${diagram.hiddenLines})`}
            </button>
          )}
          {diagram.hiddenPorts > 0 && (
            <span>
              {t(lang, "portsHidden")}: {diagram.hiddenPorts}
            </span>
          )}
          {diagram.hiddenBlocks > 0 && (
            <span>
              {t(lang, "blocksHidden")}: {diagram.hiddenBlocks}
            </span>
          )}
        </p>
      )}
    </div>
  );
}

function PortBox({
  n,
  lang,
  onSelect,
}: {
  n: DiagramNode;
  lang: Lang;
  onSelect: (id: string) => void;
}) {
  const clickable = Boolean(n.target);
  return (
    <g
      className={`port port-${n.kind}${clickable ? " clickable" : ""}${n.highlight ? " highlight" : ""}`}
      transform={`translate(${n.x} ${n.y})`}
      onClick={clickable ? () => onSelect(n.target!) : undefined}
      tabIndex={clickable ? 0 : undefined}
      role={clickable ? "button" : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") onSelect(n.target!);
            }
          : undefined
      }
    >
      <title>{`${n.label} — ${t(lang, KIND_LABEL[n.kind])}`}</title>
      <rect width={n.w} height={n.h} rx={n.kind === "constant" ? n.h / 2 : 3} />
      <g transform={`translate(9 ${(n.h - 12) / 2})`}>
        <KindGlyph kind={n.kind} />
      </g>
      <text x={28} y={n.h / 2 + 4}>
        {n.label}
      </text>
    </g>
  );
}

function BlockBox({
  n,
  lang,
  onSelect,
  onToggle,
}: {
  n: DiagramNode;
  lang: Lang;
  onSelect: (id: string) => void;
  onToggle: (key: string) => void;
}) {
  const visible: FormattedLine[] = n.lines ?? [];

  let y = 30;
  return (
    <g
      className={`block${n.collapsed ? " block-collapsed" : ""}${n.highlight ? " highlight" : ""}`}
      transform={`translate(${n.x} ${n.y})`}
    >
      <rect width={n.w} height={n.h} rx={5} />
      <rect width={n.w} height={24} rx={5} className="block-head" />
      <text
        className="block-title clickable"
        x={10}
        y={17}
        onClick={() => n.target && onSelect(n.target)}
      >
        {n.label}
      </text>
      {n.depth !== 0 && (
        <g
          className="block-toggle clickable"
          transform={`translate(${n.w - 46} 5)`}
          onClick={() => onToggle(n.key)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") onToggle(n.key);
          }}
        >
          <title>{t(lang, n.collapsed ? "expandBlock" : "collapseBlock")}</title>
          <rect width={16} height={14} rx={3} />
          <text x={8} y={11} textAnchor="middle">
            {n.collapsed ? "+" : "−"}
          </text>
        </g>
      )}
      {n.detail && n.depth === 0 && (
        <text className="block-bank" x={n.w - 10} y={17} textAnchor="end">
          {t(lang, n.detail === "master" ? "master" : "slave")}
        </text>
      )}
      {visible.map((line, i) => {
        const rows: ReactElement[] = [];
        if (line.guard) {
          y += 17;
          rows.push(
            <text key={`g${i}`} className="guard" x={10} y={y}>
              {line.guardGloss ? line.guardGloss : `when ${line.guard}`}
            </text>,
          );
        }
        y += 17;
        rows.push(
          <Formula
            key={`f${i}`}
            x={10}
            y={y}
            out={line.out}
            expr={line.shown ?? line.expr}
            title={line.raw}
          />,
        );
        if (line.gloss && n.showGloss) {
          y += 15;
          rows.push(
            <text key={`m${i}`} className="gloss" x={22} y={y}>
              {line.gloss}
            </text>,
          );
        }
        return rows;
      })}
      {(n.moreLines ?? 0) > 0 && (
        <text className="block-more" x={10} y={n.h - 8}>
          {`+${n.moreLines} ${t(lang, "moreLines")}`}
        </text>
      )}
    </g>
  );
}

/** Render `out = expr`, colouring the map / curve / constant operands. */
function Formula({
  x,
  y,
  out,
  expr,
  title,
}: {
  x: number;
  y: number;
  out: string;
  expr: string;
  title?: string;
}) {
  // Tokenise so operand names can be tinted by what they are; everything else
  // stays as plain maths.
  const parts = expr.split(/(\{[^{}]*\}|[A-Za-z_][A-Za-z0-9_]*)/g).filter(Boolean);
  return (
    <text className="formula" x={x} y={y}>
      {/* The decompiler's own wording, for checking the rewrite above it. */}
      {title && <title>{title}</title>}
      <tspan className="op-out">{out}</tspan>
      <tspan className="op-eq"> = </tspan>
      {parts.map((p, i) => {
        if (p.startsWith("{")) {
          return (
            <tspan key={i} className="op-alt">
              {p}
            </tspan>
          );
        }
        const cls = /^KF_/i.test(p)
          ? "op-map"
          : /^KL_/i.test(p)
            ? "op-curve"
            : /^K_/i.test(p)
              ? "op-const"
              : /^(kf|kl)[su]_[wb]int$|Filter|tableLookup/.test(p)
                ? "op-helper"
                : /^[A-Z][A-Z0-9_]*$/.test(p)
                  ? "op-signal"
                  : undefined;
        return (
          <tspan key={i} className={cls}>
            {p}
          </tspan>
        );
      })}
    </text>
  );
}
