import { useState } from "react";
import { Check, Globe, History, Plus, Trash2 } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { errorText, useStore } from "../store";
import { methodColor } from "../lib/styles";
import type { Environment, HistoryEntry } from "../types";
import { CollectionTree } from "./CollectionTree";
import { confirmDelete } from "../lib/confirm";
import { VariablesDialog } from "./Dialogs";
import { MenuButton, TabStrip } from "./ui";

type Panel = "collections" | "environments" | "history";

const report = (e: unknown) => console.error(errorText(e));

function EnvironmentsPanel() {
  const s = useStore();
  // "globals" edits the global variables; an Environment edits that one.
  const [editing, setEditing] = useState<Environment | "globals">();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium tracking-wide text-muted uppercase">Entornos</span>
        <button
          onClick={async () => setEditing(await s.createEnvironment("Nuevo entorno"))}
          aria-label="Nuevo entorno"
          title="Nuevo entorno"
          className="rounded p-1 text-muted hover:bg-raised hover:text-fg"
        >
          <Plus className="size-4" aria-hidden />
        </button>
      </div>
      <ul className="min-h-0 flex-1 overflow-auto pb-4 text-[13px]">
        <li>
          <button
            onClick={() => setEditing("globals")}
            className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-raised/60"
          >
            <Globe className="size-3.5 text-muted" aria-hidden />
            <span className="flex-1">Globales</span>
            <span className="text-xs text-muted tabular-nums">{s.globals.length}</span>
          </button>
        </li>
        {s.environments.map((env) => {
          const active = env.id === s.activeEnvironmentId;
          return (
            <li key={env.id} className="group flex items-center pr-1 hover:bg-raised/60">
              <button
                onClick={() => setEditing(env)}
                className="flex h-8 min-w-0 flex-1 items-center gap-2 pl-3 text-left"
              >
                <Check
                  className={`size-3.5 shrink-0 ${active ? "text-accent" : "invisible"}`}
                  aria-label={active ? "Activo" : undefined}
                />
                <span className="truncate">{env.name}</span>
              </button>
              <MenuButton
                label={`Acciones de ${env.name}`}
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
                items={[
                  {
                    label: active ? "Desactivar" : "Activar",
                    onSelect: () => s.setActiveEnvironment(active ? null : env.id).catch(report),
                  },
                  { label: "Editar", onSelect: () => setEditing(env) },
                  {
                    label: "Exportar (Postman)…",
                    onSelect: () => s.exportEnvironment(env.id).catch(report),
                  },
                  {
                    label: "Eliminar",
                    danger: true,
                    onSelect: async () => {
                      if (await confirmDelete(`el entorno "${env.name}"`))
                        s.deleteEnvironment(env.id).catch(report);
                    },
                  },
                ]}
              />
            </li>
          );
        })}
        {s.environments.length === 0 && (
          <li className="px-3 py-4 text-xs text-muted">
            Un entorno guarda variables como <code className="font-mono">{"{{baseUrl}}"}</code> para
            dev, staging o prod.
          </li>
        )}
      </ul>
      {editing === "globals" && (
        <VariablesDialog
          title="Variables globales"
          variables={s.globals}
          onSave={(_, variables) => s.setGlobals(variables)}
          onClose={() => setEditing(undefined)}
        />
      )}
      {editing && editing !== "globals" && (
        <VariablesDialog
          title="Editar entorno"
          name={editing.name}
          variables={editing.variables}
          onSave={(name, variables) => s.updateEnvironment(editing.id, name, variables)}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}

const dayLabel = (ms: number) => {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Hoy";
  if (d.toDateString() === yesterday.toDateString()) return "Ayer";
  return d.toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" });
};

function HistoryPanel() {
  const { history, openSpec, clearHistory } = useStore();
  const groups = new Map<string, HistoryEntry[]>();
  for (const h of history) {
    const day = dayLabel(h.createdAt);
    groups.set(day, [...(groups.get(day) ?? []), h]);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium tracking-wide text-muted uppercase">Historial</span>
        {history.length > 0 && (
          <button
            onClick={async () => {
              if (
                await ask("¿Borrar todo el historial?", {
                  title: "Historial",
                  kind: "warning",
                  okLabel: "Borrar",
                  cancelLabel: "Cancelar",
                })
              )
                clearHistory().catch(report);
            }}
            aria-label="Borrar historial"
            title="Borrar historial"
            className="rounded p-1 text-muted hover:bg-raised hover:text-danger"
          >
            <Trash2 className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
      {history.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-[13px] text-muted">
          <History className="size-6" aria-hidden />
          <p>Cada request que envíes aparecerá aquí.</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto pb-4">
          {[...groups].map(([day, entries]) => (
            <section key={day} aria-label={day}>
              <h3 className="sticky top-0 bg-surface px-3 py-1 text-xs text-muted first-letter:uppercase">
                {day}
              </h3>
              <ul>
                {entries.map((h) => (
                  <li key={h.id}>
                    <button
                      onClick={() => openSpec(h.request)}
                      title={h.error ?? h.request.url}
                      className="flex h-7 w-full items-center gap-2 px-3 text-left text-[13px] hover:bg-raised/60"
                    >
                      <span
                        className={`w-11 shrink-0 text-right font-mono text-[10px] font-semibold ${methodColor(h.request.method)}`}
                      >
                        {h.request.method}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg/90">
                        {h.request.url.replace(/^https?:\/\//, "") || "(sin URL)"}
                      </span>
                      <span
                        className={`shrink-0 font-mono text-[11px] tabular-nums ${
                          h.status == null
                            ? "text-danger"
                            : h.status < 300
                              ? "text-accent"
                              : h.status < 400
                                ? "text-info"
                                : "text-warn"
                        }`}
                      >
                        {h.status ?? "Error"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const [panel, setPanel] = useState<Panel>("collections");
  return (
    <aside
      aria-label="Barra lateral"
      className="flex w-72 shrink-0 flex-col border-r border-line bg-surface"
    >
      <TabStrip
        label="Secciones"
        value={panel}
        onChange={setPanel}
        items={[
          { id: "collections", label: "Colecciones" },
          { id: "environments", label: "Entornos" },
          { id: "history", label: "Historial" },
        ]}
      />
      {/* Kept mounted so the tree keeps its expanded folders when switching panels. */}
      <div hidden={panel !== "collections"} className="flex min-h-0 flex-1 flex-col">
        <CollectionTree />
      </div>
      {panel === "environments" && <EnvironmentsPanel />}
      {panel === "history" && <HistoryPanel />}
    </aside>
  );
}
