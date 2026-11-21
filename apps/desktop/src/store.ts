import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { invoke } from "@tauri-apps/api/core";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { paramsFromUrl, urlWithParams } from "./lib/url";
import { applyVarMap, toVarMap } from "./lib/scripts";
import { buildVars, effectiveAuth, toHttpRequest, type Ancestor, type Vars } from "./lib/resolve";
import type {
  Collection,
  Environment,
  HistoryEntry,
  HttpError,
  HttpRequest,
  HttpResponse,
  ImportResult,
  Item,
  ItemKind,
  KeyValue,
  RequestSpec,
  ScriptInput,
  ScriptOutput,
  ScriptReport,
  ScriptVariables,
  Settings,
  Snapshot,
  VarMap,
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
    auth: { type: "inherit" },
    scripts: { preRequest: "", postResponse: "", blocked: false },
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
  /** Console, tests and errors of the last send's scripts. */
  scriptReport?: ScriptReport;
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
  toast?: { id: number; kind: "success" | "error"; text: string };
  notify: (kind: "success" | "error", text: string) => void;
  dismissToast: () => void;

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
  /** The request ready to send: variables resolved, inherited auth applied. */
  httpRequestFor: (tab: Tab) => HttpRequest;
  /** Saves `name = value` where the variable resolves from (or the best scope if undefined). */
  setVar: (itemId: string | undefined, name: string, value: string) => Promise<void>;

  // collections and items
  createCollection: (name: string) => Promise<Collection>;
  renameCollection: (id: string, name: string) => Promise<void>;
  setCollectionVariables: (id: string, variables: KeyValue[]) => Promise<void>;
  setCollectionSettings: (id: string, settings: Settings, variables?: KeyValue[]) => Promise<void>;
  setFolderSettings: (id: string, settings: Settings) => Promise<void>;
  /** Lets every imported script of the collection run (after the user reviewed them). */
  approveScripts: (collectionId: string) => Promise<void>;
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

export type VarScope =
  | { kind: "environment"; id: string; label: string }
  | { kind: "collection"; id: string; label: string }
  | { kind: "globals"; label: string };

const defines = (rows: KeyValue[], name: string) =>
  rows.some((v) => v.enabled && v.key.trim() === name);

/** Scope a variable resolves from; for an undefined one, where it would be added (same priority). */
export function varScope(s: Snapshot, itemId: string | undefined, name: string): VarScope {
  const env = s.environments.find((e) => e.id === s.activeEnvironmentId);
  const collectionId = s.items.find((i) => i.id === itemId)?.collectionId;
  const col = s.collections.find((c) => c.id === collectionId);
  const toEnv = env && { kind: "environment" as const, id: env.id, label: `Entorno: ${env.name}` };
  const toCol = col && { kind: "collection" as const, id: col.id, label: `Colección: ${col.name}` };
  const globals = { kind: "globals" as const, label: "Globales" };
  if (env && defines(env.variables, name)) return toEnv!;
  if (col && defines(col.variables, name)) return toCol!;
  if (defines(s.globals, name)) return globals;
  return toEnv ?? toCol ?? globals;
}

/** Sets the enabled `name` row, or appends one. */
const withVar = (rows: KeyValue[], name: string, value: string): KeyValue[] =>
  defines(rows, name)
    ? rows.map((v) => (v.enabled && v.key.trim() === name ? { ...v, value } : v))
    : [...rows, { key: name, value, enabled: true }];

/** Collection, then folders down to `parentId` (what a child inherits from). */
export function ancestorsOf(
  s: Pick<Snapshot, "collections" | "items">,
  collectionId: string | undefined,
  parentId: string | null | undefined,
): Ancestor[] {
  const collection = s.collections.find((c) => c.id === collectionId);
  if (!collection) return [];
  const folders: Ancestor[] = [];
  for (let id = parentId; id;) {
    const folder = s.items.find((i) => i.id === id);
    if (!folder) break;
    folders.unshift({
      kind: "folder",
      name: folder.name,
      settings: folder.settings ?? collection.settings,
    });
    id = folder.parentId;
  }
  return [{ kind: "collection", name: collection.name, settings: collection.settings }, ...folders];
}

/** Ancestors of a saved request; none for an unsaved tab. */
export function ancestorsOfItem(s: Pick<Snapshot, "collections" | "items">, itemId?: string) {
  const item = s.items.find((i) => i.id === itemId);
  return item ? ancestorsOf(s, item.collectionId, item.parentId) : [];
}

/** Scripts of a phase, collection first, then folders, then the request (Postman's order). */
function scriptChain(
  ancestors: Ancestor[],
  spec: RequestSpec,
  phase: "preRequest" | "postResponse",
) {
  const all = [
    ...ancestors.map((a) => ({
      source: `${a.kind === "collection" ? "Colección" : "Carpeta"} ${a.name}`,
      scripts: a.settings.scripts,
    })),
    { source: "Request", scripts: spec.scripts },
  ]
    .map((s) => ({ ...s, code: s.scripts[phase] }))
    .filter((s) => s.code.trim());
  return {
    run: all.filter((s) => !s.scripts.blocked).map(({ source, code }) => ({ source, code })),
    // Imported scripts the user has not reviewed: never run.
    skipped: all.filter((s) => s.scripts.blocked).map((s) => s.source),
  };
}

/** Variables as scripts see them, per scope. */
function scriptVars(s: Snapshot, itemId: string | undefined, local: VarMap = {}): ScriptVariables {
  const collectionId = s.items.find((i) => i.id === itemId)?.collectionId;
  const env = s.environments.find((e) => e.id === s.activeEnvironmentId);
  return {
    globals: toVarMap(s.globals),
    collection: toVarMap(s.collections.find((c) => c.id === collectionId)?.variables ?? []),
    environment: env ? toVarMap(env.variables) : null,
    local,
  };
}

/** Imported script sets of a collection the user has not reviewed (they do not run). */
export function blockedScriptCount(
  s: Pick<Snapshot, "collections" | "items">,
  collectionId: string,
) {
  const sets = [
    s.collections.find((c) => c.id === collectionId)?.settings.scripts,
    ...s.items
      .filter((i) => i.collectionId === collectionId)
      .map((i) => i.request?.scripts ?? i.settings?.scripts),
  ];
  return sets.filter((sc) => sc?.blocked && (sc.preRequest.trim() || sc.postResponse.trim()))
    .length;
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

  /** Writes back the variables a script changed (only the scopes that changed). */
  const saveScriptVars = async (
    itemId: string | undefined,
    before: ScriptVariables,
    after: ScriptVariables,
  ) => {
    const s = get();
    const env = s.environments.find((e) => e.id === s.activeEnvironmentId);
    const collectionId = s.items.find((i) => i.id === itemId)?.collectionId;
    const collection = s.collections.find((c) => c.id === collectionId);
    const envRows =
      env && before.environment && after.environment
        ? applyVarMap(env.variables, before.environment, after.environment)
        : null;
    const collectionRows = collection
      ? applyVarMap(collection.variables, before.collection, after.collection)
      : null;
    const globalRows = applyVarMap(s.globals, before.globals, after.globals);
    if (env && envRows)
      await invoke("update_environment", { id: env.id, name: env.name, variables: envRows });
    if (collection && collectionRows)
      await invoke("update_collection", { id: collection.id, variables: collectionRows });
    if (globalRows) await invoke("set_globals", { variables: globalRows });
    if (envRows || collectionRows || globalRows) await get().refresh();
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

    notify: (kind, text) => set({ toast: { id: Date.now(), kind, text } }),
    dismissToast: () => set({ toast: undefined }),

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

    httpRequestFor: (tab) => {
      const { auth } = effectiveAuth(tab.draft.auth, ancestorsOfItem(get(), tab.itemId));
      return toHttpRequest(tab.draft, get().varsFor(tab), auth);
    },

    setVar: async (itemId, name, value) => {
      const s = get();
      const scope = varScope(s, itemId, name);
      if (scope.kind === "environment") {
        const env = s.environments.find((e) => e.id === scope.id)!;
        await s.updateEnvironment(env.id, env.name, withVar(env.variables, name, value));
      } else if (scope.kind === "collection") {
        const col = s.collections.find((c) => c.id === scope.id)!;
        await s.setCollectionVariables(col.id, withVar(col.variables, name, value));
      } else {
        await s.setGlobals(withVar(s.globals, name, value));
      }
    },

    send: async (id) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab || tab.requestId) return;
      const requestId = crypto.randomUUID();
      patchTab(id, (t) => ({ ...t, requestId, error: undefined }));
      // Only apply the result if this tab still waits for this request (it may be closed or re-sent).
      const settle = (fn: (t: Tab) => Tab) =>
        patchTab(id, (t) => (t.requestId === requestId ? { ...fn(t), requestId: undefined } : t));
      const report: ScriptReport = { logs: [], tests: [], errors: [] };
      const ancestors = ancestorsOfItem(get(), tab.itemId);
      let draft = tab.draft;
      let local: VarMap = {};

      /** Runs a phase's scripts and saves the variables they changed. */
      const runPhase = async (
        phase: "preRequest" | "postResponse",
        response: ScriptInput["response"],
      ) => {
        const { run: scripts, skipped } = scriptChain(ancestors, draft, phase);
        if (skipped.length)
          report.logs.push({
            level: "warn",
            text: `No se ejecutaron scripts importados sin revisar (${skipped.join(", ")}). Revísalos y actívalos en su pestaña Scripts.`,
          });
        if (!scripts.length) return;
        const variables = scriptVars(get(), tab.itemId, local);
        const out = await invoke<ScriptOutput>("run_scripts", {
          input: {
            scripts,
            variables,
            request: { method: draft.method, url: draft.url, headers: draft.headers },
            response,
          } satisfies ScriptInput,
        });
        report.logs.push(...out.logs);
        report.tests.push(...out.tests);
        report.errors.push(...out.errors);
        local = out.variables.local;
        await saveScriptVars(tab.itemId, variables, out.variables);
        return out;
      };

      const started = performance.now();
      let entry: Omit<HistoryEntry, "id" | "createdAt">;
      try {
        const pre = await runPhase("preRequest", null);
        if (pre) {
          const { method, url, headers } = pre.request;
          draft = { ...draft, method, url, headers };
        }
        if (report.errors.length) {
          // Like Postman: a failing pre-request script does not send the request.
          settle((t) => ({
            ...t,
            response: undefined,
            scriptReport: report,
            error: {
              kind: "other",
              message: `Error en el script pre-request: ${report.errors[0]}`,
            },
          }));
          return;
        }
        const { auth } = effectiveAuth(draft.auth, ancestors);
        const vars = new Map([...get().varsFor(tab), ...Object.entries(local)]);
        const response = await invoke<HttpResponse>("send_request", {
          id: requestId,
          request: toHttpRequest(draft, vars, auth),
        });
        try {
          await runPhase("postResponse", {
            code: response.status,
            status: response.statusText,
            headers: response.headers,
            body: response.bodyIsBase64 ? "" : response.body,
            responseTime: response.timings.totalMs,
          });
        } catch (e) {
          report.errors.push(errorText(e));
        }
        settle((t) => ({ ...t, response, error: undefined, scriptReport: report }));
        entry = {
          request: tab.draft,
          status: response.status,
          durationMs: response.timings.totalMs,
          size: response.bodySize,
          error: null,
        };
      } catch (e) {
        const error = asHttpError(e);
        settle((t) => ({ ...t, error, scriptReport: report }));
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
    setCollectionSettings: (id, settings, variables) =>
      mutate("update_collection", { id, settings, variables }),
    setFolderSettings: (id, settings) => mutate("update_item", { id, settings }),
    approveScripts: async (collectionId) => {
      await mutate("approve_scripts", { collectionId });
      // Open tabs of that collection hold their own copy of the request.
      const { items } = get();
      set((s) => ({
        tabs: s.tabs.map((t) => {
          const item = items.find((i) => i.id === t.itemId);
          if (item?.collectionId !== collectionId || !item.request) return t;
          return {
            ...t,
            draft: { ...t.draft, scripts: { ...t.draft.scripts, blocked: false } },
            saved: JSON.stringify(item.request),
          };
        }),
      }));
    },
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
