import { Send, Square } from "lucide-react";
import { useActiveTab, useStore } from "../store";
import { methodColor } from "../lib/styles";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export function RequestBar() {
  const tab = useActiveTab();
  const { updateDraft, setUrl, send, cancel } = useStore();
  const sending = Boolean(tab.requestId);

  return (
    <form
      className="flex gap-2 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void send(tab.id);
      }}
    >
      <div className="flex min-w-0 flex-1 rounded-md border border-line-strong bg-surface focus-within:border-slate-500">
        <select
          value={tab.draft.method}
          onChange={(e) => updateDraft(tab.id, { method: e.target.value })}
          aria-label="Método HTTP"
          className={`w-28 shrink-0 rounded-l-md border-r border-line-strong bg-transparent px-3 font-mono text-[13px] font-semibold focus:outline-none ${methodColor(tab.draft.method)}`}
        >
          {METHODS.map((m) => (
            <option key={m} value={m} className="bg-surface text-fg">
              {m}
            </option>
          ))}
        </select>
        <input
          value={tab.draft.url}
          onChange={(e) => setUrl(tab.id, e.target.value)}
          placeholder="https://api.ejemplo.com/recurso"
          aria-label="URL"
          spellCheck={false}
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
    </form>
  );
}
