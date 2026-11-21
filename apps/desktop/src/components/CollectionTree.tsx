import { useState, type DragEvent } from "react";
import { ChevronRight, Folder, FolderOpen, Layers, Plus } from "lucide-react";
import { errorText, useStore } from "../store";
import { methodColor } from "../lib/styles";
import type { Collection, Item } from "../types";
import { confirmDelete } from "../lib/confirm";
import { VariablesDialog } from "./Dialogs";
import { MenuButton } from "./ui";

type Drop = { id: string; where: "before" | "after" | "inside" };

const report = (e: unknown) => console.error(errorText(e));

/** Inline name editor: Enter or blur saves, Escape cancels. */
function RenameInput({ value, onDone }: { value: string; onDone: (name?: string) => void }) {
  const [name, setName] = useState(value);
  return (
    <input
      value={name}
      autoFocus
      aria-label="Nombre"
      onFocus={(e) => e.target.select()}
      onChange={(e) => setName(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(name.trim() || undefined);
        if (e.key === "Escape") onDone();
      }}
      onBlur={() => onDone(name.trim() || undefined)}
      className="h-6 min-w-0 flex-1 rounded border border-accent bg-bg px-1 text-[13px] focus:outline-none"
    />
  );
}

export function CollectionTree() {
  const s = useStore();
  const activeItemId = useStore((st) => st.tabs.find((t) => t.id === st.activeId)?.itemId);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string>();
  const [varsOf, setVarsOf] = useState<Collection>();
  const [dragId, setDragId] = useState<string>();
  const [drop, setDrop] = useState<Drop>();

  const toggle = (id: string, open?: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });

  const children = (collectionId: string, parentId: string | null) =>
    s.items.filter((i) => i.collectionId === collectionId && i.parentId === parentId);

  const newCollection = async () => {
    const c = await s.createCollection("Nueva colección");
    toggle(c.id, true);
    setEditing(c.id);
  };

  const newItem = async (collectionId: string, parentId: string | null, kind: Item["kind"]) => {
    const item = await s.createItem(
      collectionId,
      parentId,
      kind,
      kind === "folder" ? "Nueva carpeta" : "Nuevo request",
    );
    toggle(parentId ?? collectionId, true);
    if (kind === "request") s.openItem(item.id);
    setEditing(item.id);
  };

  const rename = (id: string, isCollection: boolean) => (name?: string) => {
    setEditing(undefined);
    if (!name) return;
    (isCollection ? s.renameCollection(id, name) : s.renameItem(id, name)).catch(report);
  };

  // Drag & drop: top/bottom third of a row = before/after, middle of a folder = inside.
  const onDragOver = (e: DragEvent, target: Item) => {
    if (!dragId || dragId === target.id) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    const where =
      target.kind === "folder" && y > 0.25 && y < 0.75 ? "inside" : y < 0.5 ? "before" : "after";
    setDrop({ id: target.id, where });
  };

  const onDrop = (e: DragEvent, target: Item) => {
    e.preventDefault();
    const id = dragId;
    const d = drop;
    setDragId(undefined);
    setDrop(undefined);
    if (!id || !d || id === target.id) return;
    if (d.where === "inside") {
      toggle(target.id, true);
      return void s.moveItem(id, target.collectionId, target.id, null).catch(report);
    }
    const siblings = children(target.collectionId, target.parentId).filter((i) => i.id !== id);
    const at = siblings.findIndex((i) => i.id === target.id);
    const before = d.where === "before" ? target.id : (siblings[at + 1]?.id ?? null);
    s.moveItem(id, target.collectionId, target.parentId, before).catch(report);
  };

  const dropOnCollection = (e: DragEvent, c: Collection) => {
    e.preventDefault();
    const id = dragId;
    setDragId(undefined);
    setDrop(undefined);
    if (id) {
      toggle(c.id, true);
      s.moveItem(id, c.id, null, null).catch(report);
    }
  };

  const renderItem = (item: Item, depth: number) => {
    const open = expanded.has(item.id);
    const isFolder = item.kind === "folder";
    const marker = drop?.id === item.id ? drop.where : undefined;
    return (
      <li key={item.id} role="treeitem" aria-expanded={isFolder ? open : undefined}>
        <div
          draggable={editing !== item.id}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            setDragId(item.id);
          }}
          onDragEnd={() => {
            setDragId(undefined);
            setDrop(undefined);
          }}
          onDragOver={(e) => onDragOver(e, item)}
          onDragLeave={() => setDrop(undefined)}
          onDrop={(e) => onDrop(e, item)}
          onClick={() => (isFolder ? toggle(item.id) : s.openItem(item.id))}
          onDoubleClick={() => setEditing(item.id)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" && isFolder) toggle(item.id);
            if (e.key === "Enter" && !isFolder) s.openItem(item.id);
            if (e.key === "F2") setEditing(item.id);
          }}
          tabIndex={0}
          style={{ paddingLeft: depth * 12 + 8 }}
          className={`group relative flex h-7 cursor-pointer items-center gap-1.5 pr-1 text-[13px] hover:bg-raised/60 ${
            activeItemId === item.id ? "bg-raised text-fg" : "text-muted"
          } ${marker === "inside" ? "ring-1 ring-accent ring-inset" : ""} ${dragId === item.id ? "opacity-40" : ""}`}
        >
          {marker === "before" && <span className="absolute inset-x-0 top-0 h-0.5 bg-accent" />}
          {marker === "after" && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-accent" />}
          {isFolder ? (
            <>
              <ChevronRight
                className={`size-3.5 shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
                aria-hidden
              />
              {open ? (
                <FolderOpen className="size-3.5 shrink-0" aria-hidden />
              ) : (
                <Folder className="size-3.5 shrink-0" aria-hidden />
              )}
            </>
          ) : (
            <span
              className={`w-11 shrink-0 text-right font-mono text-[10px] font-semibold ${methodColor(item.request?.method ?? "GET")}`}
            >
              {item.request?.method}
            </span>
          )}
          {editing === item.id ? (
            <RenameInput value={item.name} onDone={rename(item.id, false)} />
          ) : (
            <span className="min-w-0 flex-1 truncate text-fg/90">{item.name}</span>
          )}
          <MenuButton
            label={`Acciones de ${item.name}`}
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
            items={[
              ...(isFolder
                ? [
                    {
                      label: "Nuevo request",
                      onSelect: () => newItem(item.collectionId, item.id, "request").catch(report),
                    },
                    {
                      label: "Nueva carpeta",
                      onSelect: () => newItem(item.collectionId, item.id, "folder").catch(report),
                    },
                  ]
                : []),
              { label: "Renombrar", onSelect: () => setEditing(item.id) },
              { label: "Duplicar", onSelect: () => s.duplicateItem(item.id).catch(report) },
              {
                label: "Eliminar",
                danger: true,
                onSelect: async () => {
                  const what = isFolder
                    ? `la carpeta "${item.name}" y su contenido`
                    : `"${item.name}"`;
                  if (await confirmDelete(what)) s.deleteItem(item.id).catch(report);
                },
              },
            ]}
          />
        </div>
        {isFolder && open && (
          <ul role="group">
            {children(item.collectionId, item.id).map((c) => renderItem(c, depth + 1))}
            {children(item.collectionId, item.id).length === 0 && (
              <li
                style={{ paddingLeft: (depth + 1) * 12 + 28 }}
                className="py-1 text-xs text-muted"
              >
                Carpeta vacía
              </li>
            )}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium tracking-wide text-muted uppercase">Colecciones</span>
        <button
          onClick={() => newCollection().catch(report)}
          aria-label="Nueva colección"
          title="Nueva colección"
          className="rounded p-1 text-muted hover:bg-raised hover:text-fg"
        >
          <Plus className="size-4" aria-hidden />
        </button>
      </div>
      {s.collections.length === 0 ? (
        <div className="flex flex-col items-center gap-3 px-4 py-8 text-center text-[13px] text-muted">
          <Layers className="size-6" aria-hidden />
          <p>Agrupa tus requests en colecciones para guardarlos.</p>
          <button
            onClick={() => newCollection().catch(report)}
            className="rounded-md border border-line-strong px-3 py-1.5 text-fg hover:border-accent"
          >
            Crear colección
          </button>
        </div>
      ) : (
        <ul role="tree" aria-label="Colecciones" className="min-h-0 flex-1 overflow-auto pb-4">
          {s.collections.map((c) => {
            const open = expanded.has(c.id);
            const rows = children(c.id, null);
            return (
              <li key={c.id} role="treeitem" aria-expanded={open}>
                <div
                  onClick={() => toggle(c.id)}
                  onDoubleClick={() => setEditing(c.id)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter") toggle(c.id);
                    if (e.key === "F2") setEditing(c.id);
                  }}
                  onDragOver={(e) => dragId && e.preventDefault()}
                  onDrop={(e) => dropOnCollection(e, c)}
                  tabIndex={0}
                  className="group flex h-7 cursor-pointer items-center gap-1.5 pr-1 pl-2 text-[13px] font-medium hover:bg-raised/60"
                >
                  <ChevronRight
                    className={`size-3.5 shrink-0 text-muted transition-transform duration-150 ${open ? "rotate-90" : ""}`}
                    aria-hidden
                  />
                  {editing === c.id ? (
                    <RenameInput value={c.name} onDone={rename(c.id, true)} />
                  ) : (
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  )}
                  <MenuButton
                    label={`Acciones de ${c.name}`}
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
                    items={[
                      {
                        label: "Nuevo request",
                        onSelect: () => newItem(c.id, null, "request").catch(report),
                      },
                      {
                        label: "Nueva carpeta",
                        onSelect: () => newItem(c.id, null, "folder").catch(report),
                      },
                      { label: "Variables", onSelect: () => setVarsOf(c) },
                      { label: "Renombrar", onSelect: () => setEditing(c.id) },
                      {
                        label: "Duplicar",
                        onSelect: () => s.duplicateCollection(c.id).catch(report),
                      },
                      {
                        label: "Eliminar",
                        danger: true,
                        onSelect: async () => {
                          if (await confirmDelete(`la colección "${c.name}" y todo su contenido`))
                            s.deleteCollection(c.id).catch(report);
                        },
                      },
                    ]}
                  />
                </div>
                {open && (
                  <ul role="group">
                    {rows.map((i) => renderItem(i, 1))}
                    {rows.length === 0 && (
                      <li className="py-1 pl-8 text-xs text-muted">
                        Colección vacía.{" "}
                        <button
                          onClick={() => newItem(c.id, null, "request").catch(report)}
                          className="text-accent hover:underline"
                        >
                          Agregar request
                        </button>
                      </li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {varsOf && (
        <VariablesDialog
          title={`Variables de "${varsOf.name}"`}
          variables={varsOf.variables}
          onSave={(_, variables) => s.setCollectionVariables(varsOf.id, variables)}
          onClose={() => setVarsOf(undefined)}
        />
      )}
    </div>
  );
}
