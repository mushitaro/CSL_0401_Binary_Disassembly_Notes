import { useEffect, useMemo, useState } from "react";
import type { EdgeOrigin, GraphNode } from "./types";
import type { Indexed, TreeNode } from "./graph";
import { agreement } from "./graph";
import { displayName, displayNodeName, originalName } from "./names";
import { isToolMetadata } from "./logic-format";
import { type Lang, pickLocalised, t } from "./i18n";

/** The 47 MB of PDFs stay in the repository; link there rather than ship them. */
function docUrl(g: Indexed, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${g.raw.meta.docBase}/${encoded}`;
}

export function nodeKindLabel(lang: Lang, n: GraphNode): string {
  switch (n.t) {
    case "param":
      return t(
        lang,
        n.kind === "map" ? "kindMap" : n.kind === "curve" ? "kindCurve" : "kindConstant",
      );
    case "func":
      return t(lang, "kFunc");
    case "ram":
      return t(lang, "kRam");
    case "frpage":
      return t(lang, "kFrpage");
    default:
      return t(lang, "kUnknown");
  }
}

const EDGE_LABEL = {
  read: "eRead",
  write: "eWrite",
  call: "eCall",
  documented: "eDocumented",
  documents: "eDocuments",
} as const;

export function OriginBadge({ origin, lang }: { origin: EdgeOrigin; lang: Lang }) {
  const label =
    origin === "xref"
      ? t(lang, "originXref")
      : origin === "scan"
        ? t(lang, "originScan")
        : t(lang, "originFr");
  return (
    <span className={`origin origin-${origin}`} title={label}>
      {origin === "xref" ? "◆" : origin === "scan" ? "◇" : "§"}
    </span>
  );
}

/* ------------------------------------------------------------------ table */

function heatColour(v: number, min: number, max: number): string {
  if (!Number.isFinite(v) || max === min) return "transparent";
  const ratio = (v - min) / (max - min);
  // Cool -> warm, kept low-saturation so the numbers stay readable.
  const hue = 210 - 210 * ratio;
  return `hsl(${hue} 70% ${88 - ratio * 18}%)`;
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(Math.abs(v) < 1 ? 3 : 2);
}

export function ValueTable({ node, lang }: { node: GraphNode; lang: Lang }) {
  const axes = node.axes;
  if (!axes) {
    if (node.value === undefined) return null;
    return (
      <div className="scalar">
        <span className="scalar-value">{fmt(node.value)}</span>
        {node.units && node.units !== "-" && <span className="unit">{node.units}</span>}
        {node.raw !== undefined && (
          <span className="raw">
            {t(lang, "rawValue")} {node.raw}
          </span>
        )}
      </div>
    );
  }

  const z = axes.z;
  const x = axes.x;
  const y = axes.y;

  // 3-D map: z is a grid indexed by [y][x].
  if (z?.values && Array.isArray(z.values[0])) {
    const grid = z.values as number[][];
    const flat = grid.flat().filter(Number.isFinite);
    const min = Math.min(...flat);
    const max = Math.max(...flat);
    const xs = (x?.values as number[] | undefined) ?? [];
    const ys = (y?.values as number[] | undefined) ?? [];
    return (
      <div className="table-scroll">
        <table className="grid">
          <thead>
            <tr>
              <th className="corner">
                {y?.units ?? ""} \ {x?.units ?? ""}
              </th>
              {xs.map((xv, i) => (
                <th key={i}>{fmt(xv)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.map((row, r) => (
              <tr key={r}>
                <th>{fmt(ys[r] ?? r)}</th>
                {row.map((v, c) => (
                  <td key={c} className="heat" style={{ background: heatColour(v, min, max) }}>
                    {fmt(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="axis-note">
          z: {z.units ?? "-"} · {grid.length}×{grid[0]?.length ?? 0}
        </p>
      </div>
    );
  }

  // 2-D curve: x is the input, y the output.
  if (x?.values && y?.values) {
    const xs = x.values as number[];
    const ys = y.values as number[];
    const min = Math.min(...ys);
    const max = Math.max(...ys);
    return (
      <div className="table-scroll">
        <table className="grid">
          <tbody>
            <tr>
              <th>{x.units ?? "x"}</th>
              {xs.map((v, i) => (
                <td key={i}>{fmt(v)}</td>
              ))}
            </tr>
            <tr>
              <th>{y.units ?? "y"}</th>
              {ys.map((v, i) => (
                <td key={i} className="heat" style={{ background: heatColour(v, min, max) }}>
                  {fmt(v)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

  // Label-only axes (the DTC tables).
  const labelled = Object.values(axes).find((a) => a.labels?.length);
  if (labelled?.labels) {
    return (
      <div className="table-scroll">
        <table className="grid">
          <tbody>
            <tr>
              {labelled.labels.map((l, i) => (
                <th key={i}>{l || "—"}</th>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    );
  }
  return null;
}

/* ------------------------------------------------------------------- tree */

export interface TreeViewProps {
  tree: TreeNode;
  g: Indexed;
  lang: Lang;
  rootAgreement: Map<string, Set<EdgeOrigin>>;
  onSelect: (id: string) => void;
  direction?: "downstream" | "upstream";
}

function TreeRow({ tree, g, lang, rootAgreement, onSelect }: TreeViewProps) {
  const [open, setOpen] = useState(tree.depth < 2);
  const n = tree.node;
  const hasChildren = tree.children.length > 0;

  const origins = rootAgreement.get(n.id);
  const both = origins && origins.has("fr") && (origins.has("xref") || origins.has("scan"));
  const frOnly = origins && origins.has("fr") && origins.size === 1;

  return (
    <li className={`tree-row t-${n.t}`}>
      <div className="tree-line">
        <button
          className={`twisty${hasChildren ? "" : " empty"}`}
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "collapse" : "expand"}
          disabled={!hasChildren}
        >
          {hasChildren ? (open ? "▾" : "▸") : "·"}
        </button>
        {tree.edge && (
          <>
            <OriginBadge origin={tree.edge.o} lang={lang} />
            <span className="edge-kind">{t(lang, EDGE_LABEL[tree.edge.k])}</span>
          </>
        )}
        {tree.via && (
          <span className="edge-kind via">
            {t(lang, "viaSignal")} {displayName(tree.via)}
          </span>
        )}
        <button className="node-name" onClick={() => onSelect(n.id)}>
          {displayNodeName(n)}
        </button>
        <span className="node-kind">{nodeKindLabel(lang, n)}</span>
        {both && <span className="agree agree-both">{t(lang, "agreementBoth")}</span>}
        {frOnly && n.t === "param" && (
          <span className="agree agree-fr">{t(lang, "agreementFrOnly")}</span>
        )}
        {tree.repeated && <span className="repeated">({t(lang, "repeated")})</span>}
      </div>
      {open && hasChildren && (
        <ul>
          {tree.children.map((c, i) => (
            <TreeRow
              key={`${c.node.id}-${i}`}
              tree={c}
              g={g}
              lang={lang}
              rootAgreement={rootAgreement}
              onSelect={onSelect}
            />
          ))}
          {tree.truncated && (
            <li className="tree-row truncated">… {t(lang, "truncated")}</li>
          )}
        </ul>
      )}
    </li>
  );
}

export function TreeView(props: TreeViewProps) {
  if (props.tree.children.length === 0) {
    // Calibration data is never written by the code, so an empty upstream is
    // the expected answer rather than a missing one.
    const key =
      props.direction === "upstream" && props.tree.node.t === "param"
        ? "noUpstreamForParam"
        : "noRelations";

    return <p className="empty-note">{t(props.lang, key)}</p>;
  }
  return (
    <ul className="tree">
      {props.tree.children.map((c, i) => (
        <TreeRow key={`${c.node.id}-${i}`} {...props} tree={c} />
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------- code */

function DecompiledCode({ node, lang }: { node: GraphNode; lang: Lang }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const key = `${node.bank}/${node.addr!.toString(16).padStart(6, "0")}`;
  const path = `${import.meta.env.BASE_URL}data/decomp/${key}.txt`;

  useEffect(() => {
    if (!open || code !== null) return;
    // Same arrangement as the graph: the single-file build carries every
    // listing inline, the normal build fetches one on demand.
    const bundle = document.getElementById("decomp-data")?.textContent;
    if (bundle) {
      try {
        const map = JSON.parse(bundle) as Record<string, string>;
        if (map[key] !== undefined) {
          setCode(map[key]);
          return;
        }
      } catch {
        /* fall through to the network path */
      }
      setFailed(true);
      return;
    }
    let live = true;
    fetch(path)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => live && setCode(text))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [open, code, path, key]);

  return (
    <section>
      <h3>{t(lang, "decompiled")}</h3>
      <button onClick={() => setOpen((v) => !v)}>
        {t(lang, open ? "hideCode" : "showCode")}
      </button>
      {open && (
        <>
          <p className="note">{t(lang, "codeCaveat")}</p>
          {failed ? (
            <p className="warn">—</p>
          ) : (
            <pre className="code">{code ?? "…"}</pre>
          )}
        </>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------- detail */

/**
 * Address, processor, width, units and scaling on one line.
 *
 * These were a six-row definition list that pushed the actual content below
 * the fold. They are reference details you glance at, not read.
 */
export function MetaLine({ node, lang }: { node: GraphNode; lang: Lang }) {
  const parts = [
    node.addr !== undefined
      ? `0x${node.addr.toString(16).toUpperCase().padStart(4, "0")}`
      : null,
    node.bank ? t(lang, node.bank === "master" ? "master" : "slave") : null,
    node.bits ? `${node.bits} bit ${t(lang, node.signed ? "signed" : "unsigned")}` : null,
    node.units && node.units !== "-" ? node.units : null,
    node.math ?? null,
  ].filter(Boolean);
  if (!parts.length && !originalName(node)) return null;
  return (
    <p className="meta-line">
      {parts.map((part, i) => (
        <span key={i} className="meta-part">
          {part}
        </span>
      ))}
      {originalName(node) && (
        <span className="meta-part meta-original">
          {t(lang, "originalSpelling")}: <code>{originalName(node)}</code>
        </span>
      )}
    </p>
  );
}

/**
 * Everything about a node except its numbers.
 *
 * The values moved out to their own window: a map's grid and a map's
 * description are consulted at different moments, and stacking them meant
 * scrolling past 18 columns of numbers to reach a sentence.
 */
export function Description({
  node,
  g,
  lang,
  onSelect,
}: {
  node: GraphNode;
  g: Indexed;
  lang: Lang;
  onSelect: (id: string) => void;
}) {
  const docs = useMemo(() => {
    const pages: { section: string; page: number; id: string }[] = [];
    for (const e of g.out.get(node.id) ?? []) {
      if (e.o !== "fr") continue;
      const target = g.byId.get(e.d);
      if (target?.t === "frpage") {
        pages.push({ section: target.section!, page: target.page!, id: target.id });
      }
    }
    pages.sort((a, b) => a.section.localeCompare(b.section) || a.page - b.page);
    return pages;
  }, [g, node.id]);

  const cats = (node.cats ?? [])
    .map((c) => g.raw.categories.find((x) => x.id === c))
    .filter(Boolean);

  const docBySection = new Map(g.raw.frDocs.map((d) => [d.section, d]));

  return (
    <div className="detail">
      <MetaLine node={node} lang={lang} />

      {cats.length > 0 && (
        <p className="chips">
          {cats.map((c) => (
            <span key={c!.id} className="chip">
              {pickLocalised(lang, c!)}
            </span>
          ))}
        </p>
      )}

      {node.error && <p className="warn">⚠ {node.error}</p>}
      {node.plate && <pre className="plate">{node.plate}</pre>}

      {node.desc?.en && !isToolMetadata(node.desc.en) && (
        <section>
          <h3>{t(lang, "description")}</h3>
          {lang === "ja" && node.desc.ja ? (
            <>
              <p>{node.desc.ja}</p>
              {/* The English original is kept for checking a translation, but
                  it is a duplicate of the paragraph above it for most readers. */}
              <details className="original-toggle">
                <summary>English</summary>
                <p className="original">{node.desc.en}</p>
              </details>
            </>
          ) : (
            <>
              <p>{node.desc.en}</p>
              {lang === "ja" && (
                <p className="note">{t(lang, "descriptionEnOnly")}</p>
              )}
            </>
          )}
        </section>
      )}

      {/* A section whose only content is "there is nothing here" costs a
          heading, a paragraph and the space between them to say so. */}
      {docs.length > 0 && (
        <section>
          <h3>{t(lang, "documents")}</h3>
          <ul className="doclist">
            {docs.map((d) => {
              const meta = docBySection.get(d.section);
              return (
                <li key={d.id}>
                  <button className="node-name" onClick={() => onSelect(d.id)}>
                    {d.section} p.{d.page}
                  </button>
                  <span className="doc-title">{meta ? pickLocalised(lang, meta) : ""}</span>
                  {meta?.pathDe && (
                    <a href={docUrl(g, meta.pathDe)} target="_blank" rel="noreferrer">
                      {t(lang, "openGerman")}
                    </a>
                  )}
                  {meta?.pathEn && (
                    <a href={docUrl(g, meta.pathEn)} target="_blank" rel="noreferrer">
                      {t(lang, "openEnglish")}
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {node.t === "func" && node.hasCode && node.addr !== undefined && (
        <DecompiledCode node={node} lang={lang} />
      )}

      {node.t === "frpage" && node.excerpt && (
        <section>
          <h3>{t(lang, "description")}</h3>
          <p className="excerpt">{node.excerpt}</p>
        </section>
      )}
    </div>
  );
}

export function useAgreement(g: Indexed, id: string | null) {
  return useMemo(
    () => (id ? agreement(g, id) : new Map<string, Set<EdgeOrigin>>()),
    [g, id],
  );
}
