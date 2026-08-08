import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

/**
 * A panel that floats over the diagram.
 *
 * The diagram wants the whole page, and the table, the chart and the
 * description are all things you consult *while* looking at it — so they sit on
 * top of it and move out of the way, rather than pushing it down the page.
 *
 * These are drawn in-page rather than opened with window.open. The viewer is
 * built to run as one HTML file from `file://`, where a popup is usually
 * blocked outright and, when it is not, starts with an empty document that
 * would need the stylesheet and the React tree injected into it by hand.
 */

export interface WindowPos {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Drag {
  mode: "move" | "resize";
  startX: number;
  startY: number;
  origin: WindowPos;
}

const MIN_W = 260;
const MIN_H = 150;

export function FloatingWindow({
  title,
  pos,
  onChange,
  onClose,
  onFocus,
  z,
  children,
}: {
  title: ReactNode;
  pos: WindowPos;
  onChange: (p: WindowPos) => void;
  onClose: () => void;
  onFocus: () => void;
  z: number;
  children: ReactNode;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  // The handler needs the live position without being torn down and rebuilt on
  // every pixel of movement, which would drop events mid-drag.
  const latest = useRef(pos);
  latest.current = pos;

  const begin = (mode: Drag["mode"]) => (e: React.PointerEvent) => {
    e.preventDefault();
    onFocus();
    setDrag({ mode, startX: e.clientX, startY: e.clientY, origin: { ...latest.current } });
  };

  const stop = useCallback(() => setDrag(null), []);

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (drag.mode === "move") {
        onChange({
          ...drag.origin,
          // Keep a strip of the title bar reachable: a window dragged off the
          // top edge can never be grabbed again.
          x: Math.max(-drag.origin.w + 80, drag.origin.x + dx),
          y: Math.max(0, drag.origin.y + dy),
        });
      } else {
        onChange({
          ...drag.origin,
          w: Math.max(MIN_W, drag.origin.w + dx),
          h: Math.max(MIN_H, drag.origin.h + dy),
        });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [drag, onChange, stop]);

  return (
    <section
      className={`floating${drag ? " dragging" : ""}`}
      style={{ left: pos.x, top: pos.y, width: pos.w, height: pos.h, zIndex: z }}
      onPointerDown={onFocus}
      role="dialog"
      aria-label={typeof title === "string" ? title : undefined}
    >
      <header className="floating-bar" onPointerDown={begin("move")}>
        <span className="floating-title">{title}</span>
        <button className="floating-close" onClick={onClose} aria-label="close">
          ×
        </button>
      </header>
      <div className="floating-body">{children}</div>
      <div
        className="floating-grip"
        onPointerDown={begin("resize")}
        aria-hidden="true"
      />
    </section>
  );
}
