import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ImportResult } from "../types";
import { ChevronDown, Code2, Send, Square } from "lucide-react";
import { errorText, useActiveTab, useStore } from "../store";
import { CodeDialog } from "./Dialogs";
import { methodColor } from "../lib/styles";
import { VarInput } from "./VarInput";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export function RequestBar() {
  const tab = useActiveTab();
  const { updateDraft, setUrl, send, cancel } = useStore();
  const [showCode, setShowCode] = useState(false);
  const sending = Boolean(tab.requestId);

  return (
    <>
      <form
        className="flex gap-2 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(tab.id);
        }}
      >
        <div className="flex min-w-0 flex-1 rounded-md border border-line-strong bg-surface focus-within:border-slate-500">
          {/* Own chevron: the native one ignores padding and sits against the border. */}
          <div className="relative w-28 shrink-0 border-r border-line-strong">
            <select
              value={tab.draft.method}
              onChange={(e) => updateDraft(tab.id, { method: e.target.value })}
              aria-label="Método HTTP"
              className={`h-full w-full appearance-none rounded-l-md bg-transparent pr-8 pl-3 font-mono text-[13px] font-semibold focus:outline-none ${methodColor(tab.draft.method)}`}
            >
              {METHODS.map((m) => (
                <option key={m} value={m} className={`bg-surface ${methodColor(m)}`}>
                  {m}
                </option>
              ))}
            </select>
            <ChevronDown
              aria-hidden
              className={`pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 ${methodColor(tab.draft.method)}`}
            />
          </div>
          <VarInput
            value={tab.draft.url}
            onChange={(url) => setUrl(tab.id, url)}
            onPaste={(e) => {
              // Pasting a cURL command imports it, like Postman.
              const text = e.clipboardData.getData("text").trim();
              if (!text.startsWith("curl ")) return;
              e.preventDefault();
              // Replaces this tab's request instead of opening a new tab.
              invoke<ImportResult>("import_text", { text })
                .then((r) => r.kind === "request" && updateDraft(tab.id, r.request))
                .catch((err) => console.error(errorText(err)));
            }}
            placeholder="https://api.ejemplo.com/recurso"
            wrapperClassName="flex-1"
            aria-label="URL"
            autoFocus
            className="h-9 min-w-0 flex-1 bg-transparent px-3 font-mono text-[13px] placeholder:text-slate-500 focus:outline-none"
          />
        </div>
        {sending ? (
          <button
            type="button"
            onClick={() => cancel(tab.id)}
            className="flex h-9 w-28 items-center justify-center gap-2 rounded-md border border-line-strong font-medium text-fg transition-colors duration-150 hover:border-danger hover:text-danger"
          >
            <Square className="size-3.5" aria-hidden />
            Cancelar
          </button>
        ) : (
          <button
            type="submit"
            title="Enviar (Ctrl+Enter)"
            className="flex h-9 w-28 items-center justify-center gap-2 rounded-md bg-accent font-semibold text-on-accent transition-colors duration-150 hover:bg-accent-hover"
          >
            <Send className="size-3.5" aria-hidden />
            Enviar
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowCode(true)}
          aria-label="Generar código"
          title="Generar código"
          className="flex size-9 items-center justify-center rounded-md border border-line-strong text-muted hover:border-slate-500 hover:text-fg"
        >
          <Code2 className="size-4" aria-hidden />
        </button>
      </form>
      {/* Outside the form: the dialog has its own form, and nested forms submit both. */}
      {showCode && <CodeDialog onClose={() => setShowCode(false)} />}
    </>
  );
}
