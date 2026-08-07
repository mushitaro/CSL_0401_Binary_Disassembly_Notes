import { useEffect, useMemo, useState } from "react";
import type { EdgeOrigin, Graph, GraphNode } from "./types";
import { type Direction, type Indexed, expand, index, searchNodes } from "./graph";
import { Detail, TreeView, useAgreement, nodeKindLabel } from "./components";
import { type Lang, pickLocalised, t } from "./i18n";

const LANG_KEY = "mss54.lang";
const ORIGIN_KEY = "mss54.origins";

function useStoredLang(): [Lang, (l: Lang) => void] {
  const [lang, setLang] = useState<Lang>(() => {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === "ja" || stored === "en") return stored;
    return navigator.language.startsWith("ja") ? "ja" : "en";
  });
  useEffect(() => {
    localStorage.setItem(LANG_KEY, lang);
    document.documentElement.lang = lang;
  }, [lang]);
  return [lang, setLang];
}

function About({ g, lang }: { g: Indexed; lang: Lang }) {
  const c = g.raw.meta.coverage;
  const rows: [string, string][] = [
    ["XDF parameters", String(c.params)],
    [
      "with a code reference",
      `${c.paramsWithCodeReference} (${c.paramsWithCodeReferencePct}%) — master ${c.paramsWithCodeReferencePerBank.master ?? 0}/${c.paramsPerBank.master ?? 0}, slave ${c.paramsWithCodeReferencePerBank.slave ?? 0}/${c.paramsPerBank.slave ?? 0}`,
    ],
    [
      "named in the Funktionsrahmen",
      `${c.paramsInFunktionsrahmen} (${c.paramsInFunktionsrahmenPct}%)`,
    ],
    ["Ghidra functions", `${c.functions} (${c.namedFunctions} human-named)`],
    ["RAM symbols", String(c.ramSymbols)],
    ["Funktionsrahmen pages indexed", String(c.frPages)],
    ["dense pages flagged as indexes", String(c.densePagesExcludedFromBlocks)],
    ["names only the documents know", String(c.namesOnlyInDocuments)],
    ["diagram signals matching a RAM symbol", String(c.signalsMatchingRamSymbols)],
    [
      "edges by origin",
      Object.entries(c.edgesByOrigin)
        .map(([k, v]) => `${k} ${v}`)
        .join(" · "),
    ],
  ];
  return (
    <div className="detail about">
      <h2>{t(lang, "about")}</h2>
      <p>{t(lang, "aboutIntro")}</p>
      <h3>{t(lang, "coverageTitle")}</h3>
      <dl className="facts">
        {rows.map(([k, v]) => (
          <div key={k} className="fact-row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <h3>⚠</h3>
      <p className="caveat">{t(lang, "aboutFrDirection")}</p>
      <p className="caveat">{t(lang, "aboutScan")}</p>
      <p className="caveat">{t(lang, "aboutTranslation")}</p>
      <h3>Sources</h3>
      <ul className="doclist">
        <li>
          XDF: {g.raw.meta.xdf} (v{g.raw.meta.xdfVersion})
        </li>
        {Object.entries(g.raw.meta.ghidra).map(([bank, m]) => (
          <li key={bank}>
            Ghidra {bank}: {m.program} · {m.languageID} · written by {m.createdWith}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function App() {
  const [graph, setGraph] = useState<Indexed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useStoredLang();
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [openCategory, setOpenCategory] = useState<number | null>(null);
  const [direction, setDirection] = useState<Direction>("downstream");
  const [depth, setDepth] = useState(3);
  const [showAbout, setShowAbout] = useState(false);
  const [showDense, setShowDense] = useState(false);
  const [origins, setOrigins] = useState<Set<EdgeOrigin>>(() => {
    const stored = localStorage.getItem(ORIGIN_KEY);
    if (stored) return new Set(JSON.parse(stored) as EdgeOrigin[]);
    return new Set<EdgeOrigin>(["xref", "fr"]);
  });

  useEffect(() => {
    localStorage.setItem(ORIGIN_KEY, JSON.stringify([...origins]));
  }, [origins]);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/graph.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`graph.json: HTTP ${r.status}`);
        return r.json() as Promise<Graph>;
      })
      .then((raw) => setGraph(index(raw)))
      .catch((e) => setError(String(e)));
  }, []);

  const results = useMemo(
    () => (graph ? searchNodes(graph, query) : []),
    [graph, query],
  );

  const node: GraphNode | null = graph && selected ? (graph.byId.get(selected) ?? null) : null;
  const rootAgreement = useAgreement(graph ?? ({} as Indexed), graph && selected ? selected : null);

  const tree = useMemo(() => {
    if (!graph || !selected) return null;
    return expand(graph, selected, {
      direction,
      origins,
      maxDepth: depth,
      maxChildren: 40,
      includeDensePages: showDense,
    });
  }, [graph, selected, direction, origins, depth, showDense]);

  if (error) return <div className="fatal">{error}</div>;
  if (!graph) return <div className="loading">…</div>;

  const toggleOrigin = (o: EdgeOrigin) => {
    setOrigins((prev) => {
      const next = new Set(prev);
      if (next.has(o)) next.delete(o);
      else next.add(o);
      return next;
    });
  };

  const select = (id: string) => {
    setSelected(id);
    setShowAbout(false);
  };

  return (
    <div className="app">
      <header>
        <h1>{t(lang, "appTitle")}</h1>
        <div className="header-actions">
          <button
            className={showAbout ? "active" : ""}
            onClick={() => setShowAbout((v) => !v)}
          >
            {t(lang, "about")}
          </button>
          <div className="lang-toggle">
            <button
              className={lang === "ja" ? "active" : ""}
              onClick={() => setLang("ja")}
            >
              日本語
            </button>
            <button
              className={lang === "en" ? "active" : ""}
              onClick={() => setLang("en")}
            >
              English
            </button>
          </div>
        </div>
      </header>

      <div className="body">
        <aside>
          <input
            className="search"
            placeholder={t(lang, "search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? (
            <>
              <h3>
                {t(lang, "results")} ({results.length})
              </h3>
              <ul className="list">
                {results.map((r) => (
                  <li key={r.id}>
                    <button
                      className={`node-name${r.id === selected ? " sel" : ""}`}
                      onClick={() => select(r.id)}
                    >
                      {r.name}
                    </button>
                    <span className="node-kind">{nodeKindLabel(lang, r)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <h3>{t(lang, "categories")}</h3>
              <ul className="list categories">
                {graph.raw.categories.map((c) => {
                  const members = graph.categoryMembers.get(c.id) ?? [];
                  if (members.length === 0) return null;
                  const open = openCategory === c.id;
                  return (
                    <li key={c.id}>
                      <button
                        className="category"
                        onClick={() => setOpenCategory(open ? null : c.id)}
                      >
                        <span className="twisty">{open ? "▾" : "▸"}</span>
                        {pickLocalised(lang, c)}
                        <span className="count">{members.length}</span>
                      </button>
                      {open && (
                        <ul className="list nested">
                          {members.map((m) => (
                            <li key={m.id}>
                              <button
                                className={`node-name${m.id === selected ? " sel" : ""}`}
                                onClick={() => select(m.id)}
                              >
                                {m.name}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </aside>

        <main>
          {showAbout ? (
            <About g={graph} lang={lang} />
          ) : node ? (
            <>
              <Detail node={node} g={graph} lang={lang} onSelect={select} />
              <section className="tree-panel">
                <h3>{t(lang, "relationTree")}</h3>
                <div className="controls">
                  <div className="seg">
                    <button
                      className={direction === "downstream" ? "active" : ""}
                      onClick={() => setDirection("downstream")}
                    >
                      {t(lang, "downstream")}
                    </button>
                    <button
                      className={direction === "upstream" ? "active" : ""}
                      onClick={() => setDirection("upstream")}
                    >
                      {t(lang, "upstream")}
                    </button>
                  </div>
                  <label>
                    {t(lang, "depth")}
                    <input
                      type="range"
                      min={1}
                      max={5}
                      value={depth}
                      onChange={(e) => setDepth(Number(e.target.value))}
                    />
                    <span className="depth-value">{depth}</span>
                  </label>
                  <fieldset className="origins">
                    <legend>{t(lang, "sources")}</legend>
                    {(["xref", "scan", "fr"] as EdgeOrigin[]).map((o) => (
                      <label key={o}>
                        <input
                          type="checkbox"
                          checked={origins.has(o)}
                          onChange={() => toggleOrigin(o)}
                        />
                        {t(
                          lang,
                          o === "xref"
                            ? "originXref"
                            : o === "scan"
                              ? "originScan"
                              : "originFr",
                        )}
                      </label>
                    ))}
                    <label>
                      <input
                        type="checkbox"
                        checked={showDense}
                        onChange={() => setShowDense((v) => !v)}
                      />
                      {t(lang, "showDense")}
                    </label>
                  </fieldset>
                </div>
                {tree && (
                  <TreeView
                    tree={tree}
                    g={graph}
                    lang={lang}
                    rootAgreement={rootAgreement}
                    onSelect={select}
                    direction={direction}
                  />
                )}
              </section>
            </>
          ) : (
            <p className="empty-note">{t(lang, "selectPrompt")}</p>
          )}
        </main>
      </div>
    </div>
  );
}
