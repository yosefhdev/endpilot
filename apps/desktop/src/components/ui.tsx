import { useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
}

/** Underlined tab strip with arrow-key navigation. */
export function TabStrip<T extends string>({
  items,
  value,
  onChange,
  label,
  trailing,
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  trailing?: ReactNode;
}) {
  const move = (dir: 1 | -1) => {
    const i = items.findIndex((t) => t.id === value);
    onChange(items[(i + dir + items.length) % items.length].id);
  };
  return (
    <div className="flex items-center gap-1 border-b border-line px-3">
      <div
        role="tablist"
        aria-label={label}
        className="flex gap-1"
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") move(1);
          if (e.key === "ArrowLeft") move(-1);
        }}
      >
        {items.map((t) => {
          const selected = t.id === value;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(t.id)}
              className={`-mb-px border-b-2 px-2.5 py-2 text-[13px] transition-colors duration-150 ${
                selected ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {trailing && <div className="ml-auto flex items-center gap-2">{trailing}</div>}
    </div>
  );
}

export function Count({ n }: { n: number }) {
  if (n === 0) return null;
  return <span className="ml-1 text-xs text-accent tabular-nums">{n}</span>;
}

/** Modal on top of the native <dialog>: focus trap, Escape and backdrop come for free. */
export function Modal({
  title,
  onClose,
  onSubmit,
  submitLabel = "Guardar",
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  onSubmit: () => void;
  submitLabel?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <dialog
      ref={(el) => {
        if (el && !el.open) el.showModal();
      }}
      onClose={onClose}
      onCancel={onClose}
      className={`m-auto w-[calc(100%-2rem)] rounded-lg border border-line-strong bg-surface text-fg shadow-2xl backdrop:bg-black/60 ${
        wide ? "max-w-2xl" : "max-w-md"
      }`}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        className="flex max-h-[80vh] flex-col"
      >
        <h2 className="border-b border-line px-4 py-3 text-sm font-semibold">{title}</h2>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">{children}</div>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-md px-3 text-[13px] text-muted hover:bg-raised hover:text-fg"
          >
            Cancelar
          </button>
          <button
            type="submit"
            className="h-8 rounded-md bg-accent px-3 text-[13px] font-semibold text-on-accent hover:bg-accent-hover"
          >
            {submitLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

/** "…" button that opens a small action menu. */
export function MenuButton({
  items,
  label,
  className = "",
}: {
  items: MenuItem[];
  label: string;
  className?: string;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const close = () => setPos(null);
  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={Boolean(pos)}
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          setPos(pos ? null : { x: r.right, y: r.bottom + 4 });
        }}
        className={`rounded p-1 text-muted hover:bg-raised hover:text-fg ${className}`}
      >
        <MoreHorizontal className="size-3.5" aria-hidden />
      </button>
      {pos && (
        <div className="fixed inset-0 z-40" onClick={close} onContextMenu={close}>
          <div
            role="menu"
            ref={(el) => el?.querySelector<HTMLElement>("[role=menuitem]")?.focus()}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              e.preventDefault();
              const all = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
              const i = all.indexOf(document.activeElement as HTMLElement);
              all[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
            }}
            className="fixed min-w-44 -translate-x-full rounded-md border border-line-strong bg-raised py-1 text-[13px] shadow-lg"
            style={{ left: pos.x, top: pos.y }}
          >
            {items.map((item) => (
              <button
                key={item.label}
                role="menuitem"
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  close();
                  item.onSelect();
                }}
                className={`block w-full px-3 py-1.5 text-left hover:bg-line focus:bg-line focus:outline-none ${
                  item.danger ? "text-danger" : "text-fg"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
