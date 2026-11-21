import { useRef } from "react";

/**
 * Drag handle between two panes. "vertical" sits between columns (drags on x),
 * "horizontal" between rows (drags on y). Arrow keys move it, double click resets it.
 */
export function Splitter({
  orientation,
  label,
  size,
  onResize,
  min,
  max,
  defaultSize,
}: {
  orientation: "vertical" | "horizontal";
  label: string;
  size: number;
  onResize: (size: number) => void;
  min: number;
  /** Read at drag time: it often depends on the window size. */
  max: () => number;
  defaultSize: number;
}) {
  const drag = useRef<{ pos: number; size: number } | null>(null);
  const vertical = orientation === "vertical";
  const clamp = (n: number) => Math.max(min, Math.min(max(), n));
  const pos = (e: React.PointerEvent) => (vertical ? e.clientX : e.clientY);

  return (
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={Math.round(size)}
      aria-valuemin={min}
      tabIndex={0}
      title="Arrastra para cambiar el tamaño · doble clic para restablecer"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { pos: pos(e), size };
        // Keep the drag from selecting text across the panes.
        document.body.style.userSelect = "none";
        document.body.style.cursor = vertical ? "col-resize" : "row-resize";
      }}
      onPointerMove={(e) => {
        if (drag.current) onResize(clamp(drag.current.size + pos(e) - drag.current.pos));
      }}
      onPointerUp={() => {
        drag.current = null;
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
      }}
      onDoubleClick={() => onResize(clamp(defaultSize))}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        const keys = vertical ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
        const dir = keys.indexOf(e.key);
        if (dir < 0) return;
        e.preventDefault();
        onResize(clamp(size + (dir === 0 ? -step : step)));
      }}
      className={`group relative z-10 shrink-0 touch-none outline-none ${
        vertical ? "-mx-1 w-2 cursor-col-resize" : "-my-1 h-2 cursor-row-resize"
      }`}
    >
      {/* Thin visible line; the 8px element around it is the hit area. */}
      <span
        className={`absolute bg-transparent transition-colors duration-150 group-hover:bg-accent/60 group-focus-visible:bg-info group-active:bg-accent ${
          vertical
            ? "inset-y-0 left-1/2 w-0.5 -translate-x-1/2"
            : "inset-x-0 top-1/2 h-0.5 -translate-y-1/2"
        }`}
      />
    </div>
  );
}
