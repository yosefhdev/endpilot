import { useEffect, useId, useRef, useState, type InputHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { useActiveTab, useStore, useVars, varScope, errorText } from "../store";
import { insertVar, resolveText, varQueryAt, varSegments } from "../lib/resolve";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
  /** Layout classes for the wrapper (the input fills it). */
  wrapperClassName?: string;
};

/**
 * Text input that highlights `{{variables}}`, suggests them after `{{`, and lets the user
 * edit a variable's value by clicking on it.
 */
export function VarInput({
  value,
  onChange,
  onKeyDown,
  onBlur,
  className = "",
  wrapperClassName = "w-full",
  ...rest
}: Props) {
  const vars = useVars();
  const ref = useRef<HTMLInputElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [menu, setMenu] = useState<{ start: number; query: string; rect: DOMRect } | null>(null);
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState<{
    name: string;
    rect: DOMRect;
    container: Element;
  } | null>(null);

  const options = menu
    ? [...vars.keys()].filter((k) => k.toLowerCase().includes(menu.query.toLowerCase())).slice(0, 8)
    : [];
  const open = options.length > 0;
  const segments = varSegments(value);
  // Never for passwords: the overlay would paint the hidden text.
  const highlight = rest.type !== "password" && segments.some((s) => s.name);

  // The overlay scrolls with the input so highlights stay under their text.
  const syncScroll = () => {
    if (backdrop.current && ref.current) backdrop.current.scrollLeft = ref.current.scrollLeft;
  };
  useEffect(syncScroll);

  const update = (el: HTMLInputElement) => {
    const q = varQueryAt(el.value, el.selectionStart ?? el.value.length);
    setMenu(q && { ...q, rect: el.getBoundingClientRect() });
    setIndex(0);
  };

  const pick = (name: string) => {
    const el = ref.current;
    if (!el || !menu) return;
    const next = insertVar(value, el.selectionStart ?? value.length, menu.start, name);
    onChange(next.text);
    setMenu(null);
    requestAnimationFrame(() => el.setSelectionRange(next.cursor, next.cursor));
  };

  /** Opens the editor if the click landed inside a `{{variable}}`. */
  const editAtCaret = (el: HTMLInputElement) => {
    const caret = el.selectionStart ?? -1;
    if (el.selectionEnd !== caret) return;
    const seg = segments.find((s) => s.name && caret > s.start && caret < s.start + s.text.length);
    const span = seg && backdrop.current?.querySelector(`[data-start="${seg.start}"]`);
    // Inside a modal <dialog>, render there: the top layer would cover anything in <body>.
    const container = el.closest("dialog") ?? document.body;
    setEditing(
      seg?.name && span ? { name: seg.name, rect: span.getBoundingClientRect(), container } : null,
    );
  };

  const resolved = value.includes("{{") ? resolveText(value, vars) : undefined;

  return (
    <div className={`relative min-w-0 ${wrapperClassName}`}>
      <input
        {...rest}
        ref={ref}
        value={value}
        spellCheck={false}
        title={resolved !== value ? resolved : undefined}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open ? `${listId}-${index}` : undefined}
        className={`${className} w-full ${highlight ? "text-transparent! caret-fg" : ""}`}
        onScroll={syncScroll}
        onSelect={syncScroll}
        onClick={(e) => editAtCaret(e.currentTarget)}
        onChange={(e) => {
          onChange(e.target.value);
          update(e.target);
          setEditing(null);
        }}
        onKeyDown={(e) => {
          if (open) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const dir = e.key === "ArrowDown" ? 1 : -1;
              setIndex((i) => (i + dir + options.length) % options.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              e.stopPropagation();
              pick(options[index]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setMenu(null);
              return;
            }
          }
          if (e.key === "Escape" && editing) setEditing(null);
          onKeyDown?.(e);
        }}
        onBlur={(e) => {
          setMenu(null);
          onBlur?.(e);
        }}
      />
      {highlight && (
        // Same classes as the input so text lines up; painted above it, ignoring the mouse.
        <div
          ref={backdrop}
          aria-hidden
          className={`${className} pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-pre border-transparent! bg-transparent!`}
        >
          {segments.map((s) =>
            s.name ? (
              <span
                key={s.start}
                data-start={s.start}
                className={`rounded-sm ${
                  vars.has(s.name) ? "bg-accent/15 text-accent" : "bg-danger/15 text-danger"
                }`}
              >
                {s.text}
              </span>
            ) : (
              <span key={s.start}>{s.text}</span>
            ),
          )}
        </div>
      )}
      {open && menu && (
        <ul
          id={listId}
          role="listbox"
          className="fixed z-50 max-h-60 min-w-48 overflow-auto rounded-md border border-line-strong bg-raised py-1 text-[13px] shadow-lg"
          style={{ left: menu.rect.left, top: menu.rect.bottom + 4 }}
        >
          {options.map((name, i) => (
            <li
              key={name}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === index}
              // mousedown, not click: the input would blur first and close the menu.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(name);
              }}
              className={`flex cursor-pointer justify-between gap-4 px-3 py-1.5 ${
                i === index ? "bg-accent/15 text-fg" : "text-muted"
              }`}
            >
              <span className="font-mono">{name}</span>
              <span className="max-w-48 truncate text-xs text-muted">{vars.get(name)}</span>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <VarPopover
          key={editing.name}
          name={editing.name}
          rect={editing.rect}
          container={editing.container}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function VarPopover({
  name,
  rect,
  container,
  onClose,
}: {
  name: string;
  rect: DOMRect;
  container: Element;
  onClose: () => void;
}) {
  const vars = useVars();
  const itemId = useActiveTab().itemId;
  // Read once: the popover is short-lived, and a selector returning a new object would loop.
  const [scope] = useState(() => varScope(useStore.getState(), itemId, name));
  const setVar = useStore((s) => s.setVar);
  const defined = vars.has(name);
  const [draft, setDraft] = useState(vars.get(name) ?? "");
  const [error, setError] = useState<string>();
  const box = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [onClose]);

  // Portal: inputs often sit inside a <form>, and nested forms are invalid.
  return createPortal(
    <form
      ref={box}
      role="dialog"
      aria-label={`Variable ${name}`}
      className="fixed z-50 w-80 rounded-md border border-line-strong bg-raised p-3 text-[13px] shadow-lg"
      style={{ left: Math.min(rect.left, window.innerWidth - 336), top: rect.bottom + 6 }}
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setVar(itemId, name, draft).then(onClose, (err) => setError(errorText(err)));
      }}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="truncate font-mono text-fg">{name}</span>
        <span className="shrink-0 text-xs text-muted">{scope.label}</span>
      </div>
      {!defined && (
        <p className="mb-2 text-xs text-danger">
          No está definida. Al guardar se crea en {scope.label}.
        </p>
      )}
      <label className="sr-only" htmlFor={`var-${name}`}>
        Valor
      </label>
      <input
        id={`var-${name}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        placeholder="Valor"
        className="h-8 w-full rounded border border-line-strong bg-surface px-2 font-mono text-[13px] focus:border-slate-500 focus:outline-none"
      />
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="h-7 rounded px-3 text-muted hover:bg-surface hover:text-fg"
        >
          Cancelar
        </button>
        <button
          type="submit"
          className="h-7 rounded bg-accent px-3 font-semibold text-on-accent hover:bg-accent-hover"
        >
          Guardar
        </button>
      </div>
    </form>,
    container,
  );
}
