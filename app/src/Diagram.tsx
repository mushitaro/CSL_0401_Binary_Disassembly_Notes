import { type ReactElement, useMemo, useState } from "react";
import type { Indexed } from "./graph";
import { type DiagramNode, alternatives, buildDiagram } from "./diagram";
import { type Lang, t } from "./i18n";

/**
 * The block diagram.
 *
 * Every quantity is shaped by what it is, not just labelled: a 3-D map is a
 * box with a grid, a 2-D curve carries its curve, a constant is a small pill,
 * a signal is a plain tag. A tuner scanning the picture needs to see "that
 * input is a map I can edit" without reading the name first.
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
  focusId,
  lang,
  onSelect,
}: {
  g: Indexed;
  focusId: string;
  lang: Lang;
  onSelect: (id: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const diagram = useMemo(
    () => buildDiagram(g, focusId, 14, showAll),
    [g, focusId, showAll],
  );

  if (!diagram) {
    return <p className="empty-note">{t(lang, "noDiagram")}</p>;
  }

  const focusNode = g.byId.get(diagram.focus);

  return (
    <div className="diagram-wrap">
      {diagram.via && (
        <p className="note">
          <strong>{diagram.via}</strong> {t(lang, "diagramVia")}{" "}
          <strong>{focusNode?.name}</strong>
        </p>
      )}
      <div className="diagram-scroll">
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
              className={`wire wire-${e.kind}${e.alternative ? " wire-alt" : ""}`}
              markerEnd="url(#arrow)"
            />
          ))}

          {diagram.nodes.map((n) =>
            n.kind === "block" ? (
              <BlockBox key={n.id} n={n} lang={lang} onSelect={onSelect} />
            ) : (
              <PortBox key={n.id} n={n} lang={lang} onSelect={onSelect} />
            ),
          )}
        </svg>
      </div>
      {(diagram.hiddenLines > 0 || diagram.hiddenPorts > 0) && (
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
}: {
  n: DiagramNode;
  lang: Lang;
  onSelect: (id: string) => void;
}) {
  let y = 30;
  return (
    <g className="block" transform={`translate(${n.x} ${n.y})`}>
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
      {n.detail && (
        <text className="block-bank" x={n.w - 10} y={17} textAnchor="end">
          {t(lang, n.detail === "master" ? "master" : "slave")}
        </text>
      )}
      {(n.lines ?? []).map((line, i) => {
        const rows: ReactElement[] = [];
        if (line.guard) {
          y += 17;
          rows.push(
            <text key={`g${i}`} className="guard" x={10} y={y}>
              {`when ${line.guard}`}
            </text>,
          );
        }
        y += 17;
        rows.push(
          <Formula key={`f${i}`} x={10} y={y} out={line.out} expr={line.expr} />,
        );
        return rows;
      })}
    </g>
  );
}

/** Render `out = expr`, colouring the map / curve / constant operands. */
function Formula({
  x,
  y,
  out,
  expr,
}: {
  x: number;
  y: number;
  out: string;
  expr: string;
}) {
  // Tokenise so operand names can be tinted by what they are; everything else
  // stays as plain maths.
  const parts = expr.split(/(\{[^{}]*\}|[A-Za-z_][A-Za-z0-9_]*)/g).filter(Boolean);
  return (
    <text className="formula" x={x} y={y}>
      <tspan className="op-out">{out}</tspan>
      <tspan className="op-eq"> = </tspan>
      {parts.map((p, i) => {
        if (p.startsWith("{")) {
          return (
            <tspan key={i} className="op-alt">
              {alternatives(p).join(" | ")}
            </tspan>
          );
        }
        const cls = /^KF_/.test(p)
          ? "op-map"
          : /^KL_/.test(p)
            ? "op-curve"
            : /^K_/.test(p)
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
