import { useId, useRef, useState, type InputHTMLAttributes } from "react";
import { useVars } from "../store";
import { insertVar, resolveText, varQueryAt } from "../lib/resolve";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
};

/** Text input that suggests variables after `{{` and shows the resolved value on hover. */
export function VarInput({ value, onChange, onKeyDown, onBlur, ...rest }: Props) {
  const vars = useVars();
  const ref = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [menu, setMenu] = useState<{ start: number; query: string; rect: DOMRect } | null>(null);
  const [index, setIndex] = useState(0);

  const options = menu
    ? [...vars.keys()].filter((k) => k.toLowerCase().includes(menu.query.toLowerCase())).slice(0, 8)
    : [];
  const open = options.length > 0;

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

  const resolved = value.includes("{{") ? resolveText(value, vars) : undefined;

  return (
    <>
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
        onChange={(e) => {
          onChange(e.target.value);
          update(e.target);
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
          onKeyDown?.(e);
        }}
        onBlur={(e) => {
          setMenu(null);
          onBlur?.(e);
        }}
      />
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
    </>
  );
}
