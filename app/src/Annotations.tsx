import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type Pin,
  describeTarget,
  formatPins,
  loadPins,
  locate,
  savePins,
} from "./annotation-store";
import { type Lang, t } from "./i18n";

/**
 * Comment mode: click the thing, say what is wrong with it.
 *
 * The pins live in this browser only — nothing is sent anywhere, and there is
 * no server to send it to. Handing them back is an explicit copy, so the text
 * that leaves is text the reader has seen.
 */

export function Annotations({
  lang,
  context,
  active,
  onToggle,
}: {
  lang: Lang;
  /** What is on screen right now, recorded with each new pin. */
  context: string;
  active: boolean;
  onToggle: (on: boolean) => void;
}) {
  const [pins, setPins] = useState<Pin[]>(() => loadPins());
  const [draft, setDraft] = useState<Pin | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [positions, setPositions] = useState<Record<number, { x: number; y: number }>>({});
  const exportRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => savePins(pins), [pins]);

  /**
   * Put every pin back on its subject.
   *
   * Re-run on scroll and resize as well as on change, because the diagram is a
   * scroll container: a pin left at its stored point would slide off the block
   * it belongs to the moment the reader panned.
   */
  const reposition = useCallback(() => {
    const next: Record<number, { x: number; y: number }> = {};
    for (const p of pins) {
      const el = locate(p.anchor);
      if (el) {
        const r = el.getBoundingClientRect();
        // An off-screen anchor has a zero box in some browsers; keep the pin
        // out of the corner rather than pretending it is at the origin.
        if (r.width || r.height) {
          next[p.id] = { x: r.left + r.width / 2, y: r.top };
          continue;
        }
      }
      next[p.id] = { x: p.x, y: p.y };
    }
    setPositions(next);
  }, [pins]);

  useLayoutEffect(() => {
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    const timer = window.setInterval(reposition, 700);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      window.clearInterval(timer);
    };
  }, [reposition]);

  // Clicking anywhere while armed drops a pin, so the capture phase is where
  // it has to happen: the diagram's own click handlers would otherwise select
  // a node and move the view out from under the comment.
  useEffect(() => {
    if (!active) return;
    const onClick = (e: MouseEvent) => {
      const el = e.target as Element | null;
      if (!el || el.closest(".annotation-ui")) return;
      e.preventDefault();
      e.stopPropagation();
      setDraft({
        id: Date.now(),
        anchor: describeTarget(el),
        text: "",
        x: e.clientX,
        y: e.clientY,
        context,
        createdAt: Date.now(),
      });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [active, context]);

  const commit = (text: string) => {
    if (draft && text.trim()) setPins((prev) => [...prev, { ...draft, text: text.trim() }]);
    setDraft(null);
  };

  const remove = (id: number) => setPins((prev) => prev.filter((p) => p.id !== id));

  const exported = formatPins(pins, lang, context);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(exported);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // The clipboard API is refused in some file:// contexts; selecting the
      // text is the fallback that always works.
      exportRef.current?.select();
    }
  };

  return (
    <>
      <div className="annotation-ui annotation-bar">
        <button className={active ? "active" : ""} onClick={() => onToggle(!active)}>
          {active ? t(lang, "commentModeOff") : t(lang, "commentModeOn")}
        </button>
        {pins.length > 0 && (
          <button onClick={() => setOpen((v) => !v)}>
            {t(lang, "commentList")} ({pins.length})
          </button>
        )}
      </div>

      {active && <div className="annotation-hint annotation-ui">{t(lang, "commentHint")}</div>}

      {pins.map((p, i) => {
        const at = positions[p.id] ?? { x: p.x, y: p.y };
        // A pin whose subject has scrolled out of view is not drawn: clamped to
        // the edge it would point at the wrong thing, and the list is how an
        // off-screen comment is reached.
        if (at.y < 40 || at.y > window.innerHeight || at.x < 0 || at.x > window.innerWidth) {
          return null;
        }
        return (
          <button
            key={p.id}
            className="annotation-pin annotation-ui"
            style={{ left: at.x, top: at.y }}
            title={p.text}
            onClick={() => setOpen(true)}
          >
            {i + 1}
          </button>
        );
      })}

      {draft && (
        <DraftBox
          lang={lang}
          x={draft.x}
          y={draft.y}
          subject={draft.anchor.label || draft.anchor.kind}
          onCancel={() => setDraft(null)}
          onSave={commit}
        />
      )}

      {open && (
        <div className="annotation-ui annotation-panel">
          <header>
            <strong>{t(lang, "commentList")}</strong>
            <button onClick={() => setOpen(false)} aria-label="close">
              ×
            </button>
          </header>
          <ol className="annotation-items">
            {pins.map((p) => (
              <li key={p.id}>
                {/* The subject is the way back to a comment whose pin is off
                    screen, so it scrolls its own anchor into view. */}
                <button
                  className="annotation-subject annotation-goto"
                  onClick={() => {
                    const el = locate(p.anchor);
                    el?.scrollIntoView({ block: "center", inline: "center" });
                    reposition();
                  }}
                  title={t(lang, "commentGoto")}
                >
                  {p.anchor.label || p.anchor.kind}
                </button>
                <span className="annotation-text">{p.text}</span>
                <button className="annotation-del" onClick={() => remove(p.id)}>
                  {t(lang, "commentDelete")}
                </button>
              </li>
            ))}
          </ol>
          <p className="note">{t(lang, "commentExportHint")}</p>
          <textarea ref={exportRef} className="annotation-export" readOnly value={exported} />
          <div className="annotation-actions">
            <button onClick={copy}>
              {copied ? t(lang, "commentCopied") : t(lang, "commentCopy")}
            </button>
            <button
              onClick={() => {
                if (confirm(t(lang, "commentClearConfirm"))) setPins([]);
              }}
            >
              {t(lang, "commentClear")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function DraftBox({
  lang,
  x,
  y,
  subject,
  onCancel,
  onSave,
}: {
  lang: Lang;
  x: number;
  y: number;
  subject: string;
  onCancel: () => void;
  onSave: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);

  // Keep the box on screen when the click was near an edge.
  const left = Math.min(x, window.innerWidth - 320);
  const top = Math.min(y + 10, window.innerHeight - 190);

  return (
    <div className="annotation-ui annotation-draft" style={{ left, top }}>
      <p className="annotation-subject">{subject}</p>
      <textarea
        ref={ref}
        value={text}
        placeholder={t(lang, "commentPlaceholder")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          // Enter alone should make a new line; a comment is often two.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSave(text);
        }}
      />
      <div className="annotation-actions">
        <button onClick={() => onSave(text)} disabled={!text.trim()}>
          {t(lang, "commentSave")}
        </button>
        <button onClick={onCancel}>{t(lang, "commentCancel")}</button>
      </div>
    </div>
  );
}
