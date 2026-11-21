import { Loader2, Plus, X } from "lucide-react";
import { isDirty, useStore, type Tab } from "../store";
import { methodColor } from "../lib/styles";

function useTitle(tab: Tab) {
  const name = useStore((s) => s.items.find((i) => i.id === tab.itemId)?.name);
  return name ?? (tab.draft.url.replace(/^https?:\/\//, "") || "Nuevo request");
}

function TabTitle({ tab, active }: { tab: Tab; active: boolean }) {
  return <span className={`truncate ${active ? "text-fg" : "text-muted"}`}>{useTitle(tab)}</span>;
}

function EnvironmentSelect() {
  const { environments, activeEnvironmentId, setActiveEnvironment } = useStore();
  return (
    <select
      value={activeEnvironmentId ?? ""}
      onChange={(e) => void setActiveEnvironment(e.target.value || null)}
      aria-label="Entorno activo"
      className="mx-2 my-1 h-7 max-w-48 rounded border border-line-strong bg-bg px-2 text-xs"
    >
      <option value="">Sin entorno</option>
      {environments.map((env) => (
        <option key={env.id} value={env.id}>
          {env.name}
        </option>
      ))}
    </select>
  );
}

export function TabBar() {
  const { tabs, activeId, setActive, closeTab, newTab } = useStore();
  return (
    <div className="flex h-9 items-stretch border-b border-line bg-surface">
      <div role="tablist" aria-label="Requests abiertos" className="flex min-w-0 overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <div
              key={tab.id}
              className={`group flex max-w-56 min-w-32 items-center border-r border-line ${
                active ? "bg-bg" : "hover:bg-raised/50"
              }`}
            >
              <button
                role="tab"
                aria-selected={active}
                onClick={() => setActive(tab.id)}
                onAuxClick={(e) => e.button === 1 && closeTab(tab.id)}
                className="flex h-full min-w-0 flex-1 items-center gap-2 pl-3 text-left text-[13px]"
                title={tab.draft.url || undefined}
              >
                <span
                  className={`shrink-0 font-mono text-[11px] font-semibold ${methodColor(tab.draft.method)}`}
                >
                  {tab.draft.method}
                </span>
                <TabTitle tab={tab} active={active} />
                {isDirty(tab) && !tab.requestId && (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-warn"
                    aria-label="Cambios sin guardar"
                    title="Cambios sin guardar (Ctrl+S)"
                  />
                )}
                {tab.requestId && (
                  <Loader2
                    className="size-3 shrink-0 animate-spin text-muted"
                    aria-label="Enviando"
                  />
                )}
              </button>
              <button
                onClick={() => closeTab(tab.id)}
                aria-label="Cerrar pestaña"
                title="Cerrar (Ctrl+W)"
                className={`mx-1 rounded p-1 text-muted hover:bg-raised hover:text-fg ${
                  active ? "" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                }`}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
      <button
        onClick={newTab}
        aria-label="Nueva pestaña"
        title="Nueva pestaña (Ctrl+T)"
        className="flex w-9 shrink-0 items-center justify-center text-muted hover:bg-raised hover:text-fg"
      >
        <Plus className="size-4" aria-hidden />
      </button>
      <div className="ml-auto flex items-center border-l border-line">
        <EnvironmentSelect />
      </div>
    </div>
  );
}
