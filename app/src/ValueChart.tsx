import { useState } from "react";
import type { GraphNode } from "./types";
import { type Lang, t } from "./i18n";

/**
 * The calibration data drawn rather than tabulated.
 *
 * A table answers "what is the number at 4400 rpm"; a picture answers "is this
 * curve smooth, and where does it fall off a cliff" — which is the question a
 * tuner actually opens a map to ask. Both are kept, on two tabs, because
 * neither replaces the other.
 *
 * Drawn as plain SVG from the same decoded values the table uses: no plotting
 * library, so the viewer stays dependency-free and one HTML file.
 */

const PAD_L = 46;
const PAD_R = 12;
const PAD_T = 10;
const PAD_B = 28;

/** The XDF writes "-" for "no unit"; as an axis label that reads as a minus. */
function unit(u: string | undefined, fallback: string): string {
  return !u || u === "-" ? fallback : u;
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(Math.abs(v) < 1 ? 2 : 1);
}

function extent(values: number[]): [number, number] {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return [0, 1];
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  return lo === hi ? [lo - 1, hi + 1] : [lo, hi];
}

/** Cool -> warm, matching the table's heat cells so the two tabs agree. */
function heat(v: number, lo: number, hi: number): string {
  if (!Number.isFinite(v) || hi === lo) return "var(--panel)";
  const r = (v - lo) / (hi - lo);
  return `hsl(${210 - 210 * r} 70% ${88 - r * 18}%)`;
}

function Axes({
  w,
  h,
  xLabel,
  yLabel,
  xs,
  yLo,
  yHi,
}: {
  w: number;
  h: number;
  xLabel: string;
  yLabel: string;
  xs: number[];
  yLo: number;
  yHi: number;
}) {
  const ticks = 4;
  return (
    <g className="chart-axes">
      <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={h - PAD_B} />
      <line x1={PAD_L} y1={h - PAD_B} x2={w - PAD_R} y2={h - PAD_B} />
      {Array.from({ length: ticks + 1 }, (_, i) => {
        const v = yLo + ((yHi - yLo) * i) / ticks;
        const y = h - PAD_B - ((h - PAD_B - PAD_T) * i) / ticks;
        return (
          <g key={i}>
            <line className="grid" x1={PAD_L} y1={y} x2={w - PAD_R} y2={y} />
            <text className="tick" x={PAD_L - 5} y={y + 3} textAnchor="end">
              {fmt(v)}
            </text>
          </g>
        );
      })}
      {xs.length > 0 && (
        <>
          <text className="tick" x={PAD_L} y={h - PAD_B + 14} textAnchor="start">
            {fmt(xs[0])}
          </text>
          <text className="tick" x={w - PAD_R} y={h - PAD_B + 14} textAnchor="end">
            {fmt(xs[xs.length - 1])}
          </text>
        </>
      )}
      <text className="axis-label" x={w - PAD_R} y={h - 3} textAnchor="end">
        {xLabel}
      </text>
      <text className="axis-label" x={2} y={PAD_T + 4}>
        {yLabel}
      </text>
    </g>
  );
}

function CurveChart({
  xs,
  ys,
  xLabel,
  yLabel,
  w,
  h,
}: {
  xs: number[];
  ys: number[];
  xLabel: string;
  yLabel: string;
  w: number;
  h: number;
}) {
  const [xLo, xHi] = extent(xs);
  const [yLo, yHi] = extent(ys);
  const px = (v: number) => PAD_L + ((v - xLo) / (xHi - xLo)) * (w - PAD_L - PAD_R);
  const py = (v: number) => h - PAD_B - ((v - yLo) / (yHi - yLo)) * (h - PAD_B - PAD_T);
  const d = xs
    .map((x, i) => `${i === 0 ? "M" : "L"} ${px(x).toFixed(1)} ${py(ys[i]).toFixed(1)}`)
    .join(" ");
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} width="100%" height={h}>
      <Axes w={w} h={h} xLabel={xLabel} yLabel={yLabel} xs={xs} yLo={yLo} yHi={yHi} />
      <path className="chart-line" d={d} />
      {xs.map((x, i) => (
        <circle key={i} className="chart-dot" cx={px(x)} cy={py(ys[i])} r={2.4}>
          <title>{`${fmt(x)} → ${fmt(ys[i])}`}</title>
        </circle>
      ))}
    </svg>
  );
}

/**
 * A map as a heat field, with one row drawn as a curve underneath.
 *
 * The field shows the shape at a glance; the section is what you compare
 * against a log. Picking the row on the field keeps the two in step.
 */
function MapChart({
  grid,
  xs,
  ys,
  xLabel,
  yLabel,
  zLabel,
  w,
  lang,
}: {
  grid: number[][];
  xs: number[];
  ys: number[];
  xLabel: string;
  yLabel: string;
  zLabel: string;
  w: number;
  lang: Lang;
}) {
  const [row, setRow] = useState(0);
  const flat = grid.flat();
  const [lo, hi] = extent(flat);
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const fieldH = Math.min(260, Math.max(120, rows * 16));
  const cw = (w - PAD_L - PAD_R) / Math.max(1, cols);
  const ch = fieldH / Math.max(1, rows);
  const selected = grid[Math.min(row, rows - 1)] ?? [];

  return (
    <div className="chart-stack">
      <svg
        className="chart"
        viewBox={`0 0 ${w} ${fieldH + PAD_T + PAD_B}`}
        width="100%"
        height={fieldH + PAD_T + PAD_B}
      >
        {grid.map((r, ri) =>
          r.map((v, ci) => (
            <rect
              key={`${ri}-${ci}`}
              x={PAD_L + ci * cw}
              y={PAD_T + ri * ch}
              width={cw + 0.5}
              height={ch + 0.5}
              fill={heat(v, lo, hi)}
              className={ri === row ? "cell cell-sel" : "cell"}
              onClick={() => setRow(ri)}
            >
              <title>{`${yLabel} ${fmt(ys[ri] ?? ri)} · ${xLabel} ${fmt(xs[ci] ?? ci)} → ${fmt(v)}`}</title>
            </rect>
          )),
        )}
        <rect
          className="row-marker"
          x={PAD_L}
          y={PAD_T + row * ch}
          width={cols * cw}
          height={ch}
        />
        <text className="tick" x={PAD_L - 5} y={PAD_T + 9} textAnchor="end">
          {fmt(ys[0] ?? 0)}
        </text>
        <text className="tick" x={PAD_L - 5} y={PAD_T + fieldH} textAnchor="end">
          {fmt(ys[rows - 1] ?? 0)}
        </text>
        <text className="axis-label" x={2} y={PAD_T - 1}>
          {yLabel}
        </text>
        <text className="axis-label" x={w - PAD_R} y={fieldH + PAD_T + 14} textAnchor="end">
          {xLabel}
        </text>
      </svg>
      <p className="chart-note">
        {t(lang, "chartRow")}: {yLabel} = {fmt(ys[row] ?? row)}
      </p>
      <CurveChart
        xs={xs.length === selected.length ? xs : selected.map((_, i) => i)}
        ys={selected}
        xLabel={xLabel}
        yLabel={zLabel}
        w={w}
        h={150}
      />
    </div>
  );
}

export function ValueChart({
  node,
  lang,
  width,
}: {
  node: GraphNode;
  lang: Lang;
  width: number;
}) {
  const axes = node.axes;
  const w = Math.max(280, width);

  if (!axes) {
    if (node.value === undefined) return <p className="note">{t(lang, "noChart")}</p>;
    // A scalar has no shape to draw; the number is the whole story.
    return (
      <div className="scalar">
        <span className="scalar-value">{fmt(node.value)}</span>
        {node.units && node.units !== "-" && <span className="unit">{node.units}</span>}
      </div>
    );
  }

  const x = axes.x;
  const y = axes.y;
  const z = axes.z;

  if (z?.values && Array.isArray(z.values[0])) {
    const grid = (z.values as number[][]).filter((r) => Array.isArray(r));
    if (!grid.length) return <p className="note">{t(lang, "noChart")}</p>;
    return (
      <MapChart
        grid={grid}
        xs={(x?.values as number[] | undefined) ?? []}
        ys={(y?.values as number[] | undefined) ?? []}
        xLabel={unit(x?.units, "x")}
        yLabel={unit(y?.units, "y")}
        zLabel={unit(z.units, "z")}
        w={w}
        lang={lang}
      />
    );
  }

  if (x?.values && y?.values) {
    return (
      <CurveChart
        xs={x.values as number[]}
        ys={y.values as number[]}
        xLabel={unit(x.units, "x")}
        yLabel={unit(y.units, "y")}
        w={w}
        h={210}
      />
    );
  }

  return <p className="note">{t(lang, "noChart")}</p>;
}
