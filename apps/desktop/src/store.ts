import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { invoke } from "@tauri-apps/api/core";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { paramsFromUrl, urlWithParams } from "./lib/url";
import { buildVars, toHttpRequest, type Vars } from "./lib/resolve";
import type {
  Collection,
  Environment,
  HistoryEntry,
  HttpError,
  HttpResponse,
  ImportResult,
  Item,
  ItemKind,
  KeyValue,
  RequestSpec,
  Snapshot,
} from "./types";

export function emptySpec(): RequestSpec {
  return {
    method: "GET",
    url: "",
    params: [],
    headers: [],
    bodyMode: "none",
    raw: { content: "", language: "json" },
    urlencoded: [],
    formdata: [],
    auth: { type: "none" },
  };
}

const EMPTY = JSON.stringify(emptySpec());

export interface Tab {
  id: string;
  draft: RequestSpec;
  /** Saved request this tab edits, if any. */
  itemId?: string;
  /** JSON of the draft as last saved/opened, to detect unsaved changes. */
  saved?: string;
  response?: HttpResponse;
  error?: HttpError;
  /** Set while a request is in flight. */
  requestId?: string;
}

export const isDirty = (t: Tab) => JSON.stringify(t.draft) !== (t.saved ?? EMPTY);

function newTab(draft = emptySpec(), itemId?: string): Tab {
  const json = JSON.stringify(draft);
  return { id: crypto.randomUUID(), draft, itemId, saved: itemId ? json : undefined };
}

function asHttpError(e: unknown): HttpError {
  if (e && typeof e === "object" && "kind" in e && "message" in e) return e as HttpError;
  return { kind: "other", message: String(e) };
}

/** Store errors come back as `{ message }`. */
export function errorText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String(e.message);
  return String(e);
}

interface State extends Snapshot {
  tabs: Tab[];
  activeId: string;
  history: HistoryEntry[];
  /** Tab whose "save as" dialog is open. */
  savingTabId?: string;
  loaded: boolean;

  load: () => Promise<void>;
  refresh: () => Promise<void>;

  // tabs
  newTab: () => void;
  closeTab: (id: string) => Promise<void>;
  setActive: (id: string) => void;
  updateDraft: (id: string, patch: Partial<RequestSpec>) => void;
  setUrl: (id: string, url: string) => void;
  setParams: (id: string, params: KeyValue[]) => void;
  openItem: (itemId: string) => void;
  openSpec: (spec: RequestSpec) => void;
  send: (id: string) => Promise<void>;
  cancel: (id: string) => void;
  save: (id: string) => Promise<void>;
  saveAs: (
    tabId: string,
    collectionId: string,
    parentId: string | null,
    name: string,
  ) => Promise<void>;
  setSavingTab: (id?: string) => void;
  varsFor: (tab: Tab) => Vars;

  // collections and items
  createCollection: (name: string) => Promise<Collection>;
  renameCollection: (id: string, name: string) => Promise<void>;
  setCollectionVariables: (id: string, variables: KeyValue[]) => Promise<void>;
  duplicateCollection: (id: string) => Promise<void>;
  deleteCollection: (id: string) => Promise<void>;
  createItem: (
    collectionId: string,
    parentId: string | null,
    kind: ItemKind,
    name: string,
  ) => Promise<Item>;
  renameItem: (id: string, name: string) => Promise<void>;
  moveItem: (
    id: string,
    collectionId: string,
    parentId: string | null,
    beforeId: string | null,
  ) => Promise<void>;
  duplicateItem: (id: string) => Promise<void>;
  deleteItem: (id: string) => Promise<void>;

  // environments
  createEnvironment: (name: string) => Promise<Environment>;
  updateEnvironment: (id: string, name: string, variables: KeyValue[]) => Promise<void>;
  deleteEnvironment: (id: string) => Promise<void>;
  setGlobals: (variables: KeyValue[]) => Promise<void>;
  setActiveEnvironment: (id: string | null) => Promise<void>;

  // history
  clearHistory: () => Promise<void>;

  // import / export
  importText: (text: string) => Promise<ImportResult>;
  /** Asks for a file; `null` if the user cancels. */
  importFile: () => Promise<ImportResult | null>;
  exportCollection: (id: string) => Promise<void>;
  exportEnvironment: (id: string) => Promise<void>;
}

/** Globals < collection of the saved request < active environment. */
function varsOf(s: Snapshot, itemId?: string): Vars {
  const collectionId = s.items.find((i) => i.id === itemId)?.collectionId;
  const collectionVars = s.collections.find((c) => c.id === collectionId)?.variables ?? [];
  const envVars = s.environments.find((e) => e.id === s.activeEnvironmentId)?.variables ?? [];
  return buildVars(s.globals, collectionVars, envVars);
}

/** Safe file name from a user-given name. */
const fileName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, "_").trim() || "export";

const first = newTab();

export const useStore = create<State>((set, get) => {
  const patchTab = (id: string, fn: (t: Tab) => Tab) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? fn(t) : t)) }));
  const patchDraft = (id: string, patch: Partial<RequestSpec>) =>
    patchTab(id, (t) => ({ ...t, draft: { ...t.draft, ...patch } }));
  /** Runs a store command, then reloads everything (data is small; keeps state simple and correct). */
  const mutate = async <T>(cmd: string, args: Record<string, unknown>): Promise<T> => {
    const out = await invoke<T>(cmd, args);
    await get().refresh();
    return out;
  };

  /** cURL opens in a tab; anything else was saved, so reload. */
  const applyImport = async (result: ImportResult) => {
    if (result.kind === "request") get().openSpec(result.request);
    else await get().refresh();
    return result;
  };

  return {
    tabs: [first],
    activeId: first.id,
    collections: [],
    items: [],
    environments: [],
    globals: [],
    activeEnvironmentId: null,
    history: [],
    loaded: false,

    load: async () => {
      const [snap, history] = await Promise.all([
        invoke<Snapshot>("snapshot"),
        invoke<HistoryEntry[]>("list_history"),
      ]);
      set({ ...snap, history, loaded: true });
    },

    refresh: async () => {
      const snap = await invoke<Snapshot>("snapshot");
      const alive = new Set(snap.items.map((i) => i.id));
      // Tabs whose request was deleted keep their content but become unsaved.
      set((s) => ({
        ...snap,
        tabs: s.tabs.map((t) =>
          t.itemId && !alive.has(t.itemId) ? { ...t, itemId: undefined, saved: undefined } : t,
        ),
      }));
    },

    newTab: () => {
      const tab = newTab();
      set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
    },

    closeTab: async (id) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab) return;
      if (
        isDirty(tab) &&
        !(await ask("Este request tiene cambios sin guardar. ¿Cerrarlo de todos modos?", {
          title: "Cambios sin guardar",
          kind: "warning",
          okLabel: "Cerrar sin guardar",
          cancelLabel: "Cancelar",
        }))
      )
        return;
      get().cancel(id);
      const { tabs, activeId } = get();
      const index = tabs.findIndex((t) => t.id === id);
      const rest = tabs.filter((t) => t.id !== id);
      if (rest.length === 0) {
        const fresh = newTab();
        set({ tabs: [fresh], activeId: fresh.id });
        return;
      }
      const nextActive = activeId === id ? rest[Math.min(index, rest.length - 1)].id : activeId;
      set({ tabs: rest, activeId: nextActive });
    },

    setActive: (id) => set({ activeId: id }),

    updateDraft: patchDraft,

    setUrl: (id, url) =>
      patchTab(id, (t) => ({
        ...t,
        draft: { ...t.draft, url, params: paramsFromUrl(url, t.draft.params) },
      })),

    setParams: (id, params) =>
      patchTab(id, (t) => ({
        ...t,
        draft: { ...t.draft, params, url: urlWithParams(t.draft.url, params) },
      })),

    openItem: (itemId) => {
      const { tabs, items, activeId } = get();
      const open = tabs.find((t) => t.itemId === itemId);
      if (open) return set({ activeId: open.id });
      const item = items.find((i) => i.id === itemId);
      if (!item?.request) return;
      const tab = newTab(structuredClone(item.request), itemId);
      // Reuse the active tab if it is blank, like Postman does.
      const active = tabs.find((t) => t.id === activeId);
      if (active && !active.itemId && !isDirty(active) && !active.response && !active.requestId)
        return set({ tabs: tabs.map((t) => (t.id === activeId ? tab : t)), activeId: tab.id });
      set({ tabs: [...tabs, tab], activeId: tab.id });
    },

    openSpec: (spec) => {
      const tab = newTab(structuredClone(spec));
      set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
    },

    varsFor: (tab) => varsOf(get(), tab.itemId),

    send: async (id) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab || tab.requestId) return;
      const requestId = crypto.randomUUID();
      patchTab(id, (t) => ({ ...t, requestId, error: undefined }));
      // Only apply the result if this tab still waits for this request (it may be closed or re-sent).
      const settle = (fn: (t: Tab) => Tab) =>
        patchTab(id, (t) => (t.requestId === requestId ? { ...fn(t), requestId: undefined } : t));
      const started = performance.now();
      let entry: Omit<HistoryEntry, "id" | "createdAt">;
      try {
        const response = await invoke<HttpResponse>("send_request", {
          id: requestId,
          request: toHttpRequest(tab.draft, get().varsFor(tab)),
        });
        settle((t) => ({ ...t, response, error: undefined }));
        entry = {
          request: tab.draft,
          status: response.status,
          durationMs: response.timings.totalMs,
          size: response.bodySize,
          error: null,
        };
      } catch (e) {
        const error = asHttpError(e);
        settle((t) => ({ ...t, error }));
        if (error.kind === "cancelled") return;
        entry = {
          request: tab.draft,
          status: null,
          durationMs: performance.now() - started,
          size: null,
          error: error.message,
        };
      }
      try {
        const saved = await invoke<HistoryEntry>("add_history", {
          entry: { ...entry, id: "", createdAt: 0 },
        });
        set((s) => ({ history: [saved, ...s.history].slice(0, 500) }));
      } catch (e) {
        console.error("No se pudo guardar el historial", e);
      }
    },

    cancel: (id) => {
      const requestId = get().tabs.find((t) => t.id === id)?.requestId;
      if (requestId) void invoke("cancel_request", { id: requestId });
    },

    save: async (id) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab) return;
      if (!tab.itemId) return set({ savingTabId: id });
      await invoke("update_item", { id: tab.itemId, request: tab.draft });
      patchTab(id, (t) => ({ ...t, saved: JSON.stringify(tab.draft) }));
      await get().refresh();
    },

    saveAs: async (tabId, collectionId, parentId, name) => {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab) return;
      const item = await invoke<Item>("create_item", {
        collectionId,
        parentId,
        kind: "request",
        name,
        request: tab.draft,
      });
      patchTab(tabId, (t) => ({ ...t, itemId: item.id, saved: JSON.stringify(tab.draft) }));
      set({ savingTabId: undefined });
      await get().refresh();
    },

    setSavingTab: (id) => set({ savingTabId: id }),

    createCollection: (name) => mutate("create_collection", { name }),
    renameCollection: (id, name) => mutate("update_collection", { id, name }),
    setCollectionVariables: (id, variables) => mutate("update_collection", { id, variables }),
    duplicateCollection: (id) => mutate("duplicate_collection", { id }),
    deleteCollection: (id) => mutate("delete_collection", { id }),
    createItem: (collectionId, parentId, kind, name) =>
      mutate("create_item", { collectionId, parentId, kind, name, request: null }),
    renameItem: (id, name) => mutate("update_item", { id, name }),
    moveItem: (id, collectionId, parentId, beforeId) =>
      mutate("move_item", { id, collectionId, parentId, beforeId }),
    duplicateItem: (id) => mutate("duplicate_item", { id }),
    deleteItem: (id) => mutate("delete_item", { id }),

    createEnvironment: (name) => mutate("create_environment", { name }),
    updateEnvironment: (id, name, variables) =>
      mutate("update_environment", { id, name, variables }),
    deleteEnvironment: (id) => mutate("delete_environment", { id }),
    setGlobals: (variables) => mutate("set_globals", { variables }),
    setActiveEnvironment: (id) => mutate("set_active_environment", { id }),

    clearHistory: async () => {
      await invoke("clear_history");
      set({ history: [] });
    },

    importText: async (text) => applyImport(await invoke<ImportResult>("import_text", { text })),
    importFile: async () => {
      const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Postman, OpenAPI", extensions: ["json", "yaml", "yml"] }],
      });
      if (typeof path !== "string") return null;
      return applyImport(await invoke<ImportResult>("import_file", { path }));
    },
    exportCollection: async (id) => {
      const name = get().collections.find((c) => c.id === id)?.name ?? "coleccion";
      const path = await save({
        defaultPath: `${fileName(name)}.postman_collection.json`,
        filters: [{ name: "Postman Collection v2.1", extensions: ["json"] }],
      });
      if (path) await invoke("export_collection", { id, path });
    },
    exportEnvironment: async (id) => {
      const name = get().environments.find((e) => e.id === id)?.name ?? "entorno";
      const path = await save({
        defaultPath: `${fileName(name)}.postman_environment.json`,
        filters: [{ name: "Postman Environment", extensions: ["json"] }],
      });
      if (path) await invoke("export_environment", { id, path });
    },
  };
});

export const useActiveTab = () => useStore((s) => s.tabs.find((t) => t.id === s.activeId)!);

/** Variables visible to the active tab (for autocomplete and previews). */
export const useVars = (): Vars => {
  const itemId = useActiveTab().itemId;
  const [globals, collections, items, environments, activeEnvironmentId] = useStore(
    useShallow((s) => [s.globals, s.collections, s.items, s.environments, s.activeEnvironmentId]),
  );
  return varsOf({ globals, collections, items, environments, activeEnvironmentId }, itemId);
};
