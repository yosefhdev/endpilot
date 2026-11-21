import { FileUp, Trash2 } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import type { FormField, KeyValue } from "../types";
import { inputClass } from "../lib/styles";
import { VarInput } from "./VarInput";

type Row = KeyValue & Partial<Pick<FormField, "kind">>;

/**
 * Editable key/value rows. A trailing blank row becomes a real row as soon as the user types in it.
 * With `withKind`, rows can switch between text and file (form-data).
 */
export function KeyValueTable<R extends Row>({
  rows,
  onChange,
  keyPlaceholder = "Key",
  label,
  withKind = false,
}: {
  rows: R[];
  onChange: (rows: R[]) => void;
  keyPlaceholder?: string;
  label: string;
  withKind?: boolean;
}) {
  const blank = { key: "", value: "", enabled: true, ...(withKind ? { kind: "text" } : {}) } as R;
  const update = (i: number, patch: Partial<R>) => {
    const next = [...rows];
    next[i] = { ...(next[i] ?? blank), ...patch };
    onChange(next);
  };
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i));
  const pickFile = async (i: number) => {
    const path = await open({ multiple: false, directory: false });
    if (typeof path === "string") update(i, { value: path } as Partial<R>);
  };

  return (
    <table className="w-full table-fixed border-collapse text-[13px]" aria-label={label}>
      <thead>
        <tr className="text-left text-xs text-muted">
          <th className="w-9 py-1.5 font-medium">
            <span className="sr-only">Activo</span>
          </th>
          <th className="py-1.5 pl-2 font-medium">Key</th>
          {withKind && <th className="w-24 py-1.5 pl-2 font-medium">Tipo</th>}
          <th className="py-1.5 pl-2 font-medium">Value</th>
          <th className="w-9" />
        </tr>
      </thead>
      <tbody>
        {[...rows, blank].map((row, i) => {
          const isBlank = i === rows.length;
          return (
            <tr key={i} className="group border-t border-line">
              <td className="text-center">
                {!isBlank && (
                  <input
                    type="checkbox"
                    checked={row.enabled}
                    onChange={(e) => update(i, { enabled: e.target.checked } as Partial<R>)}
                    aria-label={`Activar ${row.key || "fila"}`}
                    className="size-3.5 accent-accent"
                  />
                )}
              </td>
              <td>
                <VarInput
                  value={row.key}
                  onChange={(key) => update(i, { key } as Partial<R>)}
                  placeholder={keyPlaceholder}
                  aria-label="Key"
                  className={`${inputClass} ${row.enabled ? "" : "text-muted line-through"}`}
                />
              </td>
              {withKind && (
                <td className="pl-1">
                  <select
                    value={row.kind}
                    onChange={(e) =>
                      update(i, { kind: e.target.value, value: "" } as unknown as Partial<R>)
                    }
                    aria-label="Tipo de campo"
                    className="h-8 w-full rounded bg-transparent px-1 text-[13px] text-muted hover:text-fg focus:bg-surface"
                  >
                    <option value="text">Texto</option>
                    <option value="file">Archivo</option>
                  </select>
                </td>
              )}
              <td className="pl-1">
                {row.kind === "file" ? (
                  <button
                    onClick={() => pickFile(i)}
                    className="flex h-8 w-full items-center gap-2 truncate rounded px-2 text-left font-mono text-muted hover:bg-raised hover:text-fg"
                    title={row.value || undefined}
                  >
                    <FileUp className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{row.value || "Elegir archivo…"}</span>
                  </button>
                ) : (
                  <VarInput
                    value={row.value}
                    onChange={(value) => update(i, { value } as Partial<R>)}
                    placeholder="Value"
                    aria-label="Value"
                    className={`${inputClass} ${row.enabled ? "" : "text-muted"}`}
                  />
                )}
              </td>
              <td className="text-center">
                {!isBlank && (
                  <button
                    onClick={() => remove(i)}
                    aria-label={`Eliminar ${row.key || "fila"}`}
                    className="rounded p-1.5 text-muted opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
