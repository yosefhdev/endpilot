import type { ReactNode } from "react";

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
