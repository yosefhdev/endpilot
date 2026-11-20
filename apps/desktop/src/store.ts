import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { paramsFromUrl, urlWithParams } from "./lib/url";
import type {
  BodyMode,
  FormField,
  HttpError,
  HttpRequest,
  HttpResponse,
  KeyValue,
  RawLanguage,
  RequestBody,
} from "./types";

/** What the editor holds. Every body mode keeps its data so switching modes loses nothing. */
export interface RequestDraft {
  method: string;
  url: string;
  params: KeyValue[];
  headers: KeyValue[];
  bodyMode: BodyMode;
  raw: { content: string; language: RawLanguage };
  urlencoded: KeyValue[];
  formdata: FormField[];
}

export interface Tab {
  id: string;
  draft: RequestDraft;
  response?: HttpResponse;
  error?: HttpError;
  /** Set while a request is in flight. */
  requestId?: string;
}

function emptyTab(): Tab {
  return {
    id: crypto.randomUUID(),
    draft: {
      method: "GET",
      url: "",
      params: [],
      headers: [],
      bodyMode: "none",
      raw: { content: "", language: "json" },
      urlencoded: [],
      formdata: [],
    },
  };
}

export function toHttpRequest(d: RequestDraft): HttpRequest {
  const body: RequestBody =
    d.bodyMode === "raw"
      ? { mode: "raw", ...d.raw }
      : d.bodyMode === "urlencoded"
        ? { mode: "urlencoded", fields: d.urlencoded }
        : d.bodyMode === "formdata"
          ? { mode: "formdata", fields: d.formdata }
          : { mode: "none" };
  return {
    method: d.method,
    url: d.url,
    headers: d.headers,
    body,
    timeoutMs: null,
    followRedirects: true,
  };
}

function asHttpError(e: unknown): HttpError {
  if (e && typeof e === "object" && "kind" in e && "message" in e) return e as HttpError;
  return { kind: "other", message: String(e) };
}

interface State {
  tabs: Tab[];
  activeId: string;
  newTab: () => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  updateDraft: (id: string, patch: Partial<RequestDraft>) => void;
  setUrl: (id: string, url: string) => void;
  setParams: (id: string, params: KeyValue[]) => void;
  send: (id: string) => Promise<void>;
  cancel: (id: string) => void;
}

const first = emptyTab();

export const useStore = create<State>((set, get) => {
  const patchTab = (id: string, fn: (t: Tab) => Tab) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? fn(t) : t)) }));
  const patchDraft = (id: string, patch: Partial<RequestDraft>) =>
    patchTab(id, (t) => ({ ...t, draft: { ...t.draft, ...patch } }));

  return {
    tabs: [first],
    activeId: first.id,

    newTab: () => {
      const tab = emptyTab();
      set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
    },

    closeTab: (id) => {
      const { tabs, activeId, cancel } = get();
      cancel(id);
      const index = tabs.findIndex((t) => t.id === id);
      const rest = tabs.filter((t) => t.id !== id);
      if (rest.length === 0) {
        const tab = emptyTab();
        set({ tabs: [tab], activeId: tab.id });
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

    send: async (id) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab || tab.requestId) return;
      const requestId = crypto.randomUUID();
      patchTab(id, (t) => ({ ...t, requestId, error: undefined }));
      // Only apply the result if this tab still waits for this request (it may be closed or re-sent).
      const settle = (fn: (t: Tab) => Tab) =>
        patchTab(id, (t) => (t.requestId === requestId ? { ...fn(t), requestId: undefined } : t));
      try {
        const response = await invoke<HttpResponse>("send_request", {
          id: requestId,
          request: toHttpRequest(tab.draft),
        });
        settle((t) => ({ ...t, response, error: undefined }));
      } catch (e) {
        settle((t) => ({ ...t, error: asHttpError(e) }));
      }
    },

    cancel: (id) => {
      const requestId = get().tabs.find((t) => t.id === id)?.requestId;
      if (requestId) void invoke("cancel_request", { id: requestId });
    },
  };
});

export const useActiveTab = () => useStore((s) => s.tabs.find((t) => t.id === s.activeId)!);
