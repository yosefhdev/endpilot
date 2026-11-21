import { useState } from "react";
import { errorText, useActiveTab, useStore, useVars } from "../store";
import { CODE_LANGUAGES, generateCode, type CodeLanguage } from "../lib/codegen";
import { toHttpRequest } from "../lib/resolve";
import type { ImportResult, KeyValue } from "../types";
import { CodeEditor } from "./CodeEditor";
import { KeyValueTable } from "./KeyValueTable";
import { Modal } from "./ui";

const textClass =
  "h-8 w-full rounded border border-line-strong bg-bg px-2 text-[13px] focus:border-slate-500 focus:outline-none";

/** Edits a variable list (and optionally a name): environments, globals, collection variables. */
export function VariablesDialog({
  title,
  name: initialName,
  variables: initial,
  onSave,
  onClose,
}: {
  title: string;
  /** Pass to show a name field. */
  name?: string;
  variables: KeyValue[];
  onSave: (name: string, variables: KeyValue[]) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName ?? "");
  const [variables, setVariables] = useState(initial);
  const [error, setError] = useState<string>();
  return (
    <Modal
      title={title}
      wide
      onClose={onClose}
      onSubmit={async () => {
        if (initialName !== undefined && !name.trim()) return setError("El nombre es obligatorio.");
        try {
          await onSave(
            name.trim(),
            variables.filter((v) => v.key.trim() || v.value),
          );
          onClose();
        } catch (e) {
          setError(errorText(e));
        }
      }}
    >
      {initialName !== undefined && (
        <label className="mb-3 flex flex-col gap-1 text-xs text-muted">
          Nombre
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            className={textClass}
          />
        </label>
      )}
      <KeyValueTable
        label="Variables"
        keyPlaceholder="Variable"
        rows={variables}
        onChange={setVariables}
      />
      <p className="mt-2 text-xs text-muted">
        Úsalas como <code className="font-mono text-fg">{"{{nombre}}"}</code> en URL, headers, body
        y auth.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}

/** "Save as": pick a name and a collection or folder for an unsaved tab. */
export function SaveDialog({ tabId }: { tabId: string }) {
  const { collections, items, saveAs, setSavingTab, createCollection } = useStore();
  const tab = useStore((s) => s.tabs.find((t) => t.id === tabId));
  const [name, setName] = useState(
    () => tab?.draft.url.replace(/^https?:\/\//, "").split("?")[0] || "Nuevo request",
  );
  const [target, setTarget] = useState(collections[0]?.id ?? "");
  const [error, setError] = useState<string>();
  const close = () => setSavingTab(undefined);

  // Collections and their folders, indented, as one flat list of destinations.
  const options: { value: string; label: string }[] = [];
  const addFolders = (collectionId: string, parentId: string | null, depth: number) => {
    for (const f of items.filter(
      (i) => i.kind === "folder" && i.collectionId === collectionId && i.parentId === parentId,
    )) {
      options.push({ value: `${collectionId}/${f.id}`, label: `${"   ".repeat(depth)}${f.name}` });
      addFolders(collectionId, f.id, depth + 1);
    }
  };
  for (const c of collections) {
    options.push({ value: c.id, label: c.name });
    addFolders(c.id, null, 1);
  }

  return (
    <Modal
      title="Guardar request"
      onClose={close}
      onSubmit={async () => {
        if (!name.trim()) return setError("El nombre es obligatorio.");
        try {
          const [collectionId, parentId] = target.split("/");
          const into = collectionId || (await createCollection("Mi colección")).id;
          await saveAs(tabId, into, parentId ?? null, name.trim());
        } catch (e) {
          setError(errorText(e));
        }
      }}
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Nombre
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            onFocus={(e) => e.target.select()}
            className={textClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Guardar en
          {options.length ? (
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className={`${textClass} whitespace-pre`}
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-[13px] text-fg">
              Una colección nueva, &quot;Mi colección&quot;.
            </span>
          )}
        </label>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function importedText(r: ImportResult) {
  if (r.kind === "collection") return `Colección "${r.collection.name}" importada.`;
  if (r.kind === "environment") return `Entorno "${r.environment.name}" importado.`;
  if (r.kind === "globals") return `${r.count} variables globales importadas.`;
  return "";
}

/** Import from a file or pasted text: Postman collection/environment/globals, OpenAPI 3 or cURL. */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const { importText, importFile } = useStore();
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = async (task: () => Promise<ImportResult | null>) => {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      const result = await task();
      // A cURL opens in a tab behind the dialog: close it. Saved imports stay to allow more.
      if (result?.kind === "request") onClose();
      else if (result) {
        setDone(importedText(result));
        setText("");
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Importar"
      wide
      submitLabel={busy ? "Importando…" : "Importar texto"}
      onClose={onClose}
      onSubmit={() => {
        if (!text.trim()) return setError("Pega el contenido a importar o elige un archivo.");
        void run(() => importText(text));
      }}
    >
      <div className="flex flex-col gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(importFile)}
          className="flex h-20 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-line-strong text-[13px] text-muted hover:border-accent hover:text-fg disabled:opacity-50"
        >
          <span className="font-medium text-fg">Elegir archivo…</span>
          Colección o entorno de Postman (v2.0/v2.1), OpenAPI 3 (JSON o YAML)
        </button>
        <label className="flex flex-col gap-1 text-xs text-muted">
          O pega el contenido, o un comando cURL
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            rows={8}
            placeholder="curl https://api.ejemplo.com -H 'Accept: application/json'"
            className="resize-y rounded border border-line-strong bg-bg p-2 font-mono text-xs text-fg focus:border-slate-500 focus:outline-none"
          />
        </label>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        <p role="status" className="text-xs text-accent">
          {done}
        </p>
      </div>
    </Modal>
  );
}

/** Code for the active request with variables and auth already applied. */
export function CodeDialog({ onClose }: { onClose: () => void }) {
  const tab = useActiveTab();
  const vars = useVars();
  const [language, setLanguage] = useState<CodeLanguage>("curl");
  const [copied, setCopied] = useState(false);
  const code = generateCode(toHttpRequest(tab.draft, vars), language);

  return (
    <Modal
      title="Generar código"
      wide
      submitLabel={copied ? "Copiado" : "Copiar"}
      onClose={onClose}
      onSubmit={async () => {
        await navigator.clipboard.writeText(code);
        setCopied(true);
      }}
    >
      <div className="flex flex-col gap-2">
        <select
          value={language}
          onChange={(e) => {
            setLanguage(e.target.value as CodeLanguage);
            setCopied(false);
          }}
          aria-label="Lenguaje"
          className={`${textClass} w-56`}
        >
          {CODE_LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        <div className="h-72 overflow-hidden rounded border border-line">
          <CodeEditor
            label="Código generado"
            value={code}
            language={language === "fetch" ? "javascript" : "text"}
            readOnly
          />
        </div>
        <p className="text-xs text-muted">
          Incluye las variables del entorno activo ya resueltas, también tokens y contraseñas.
        </p>
      </div>
    </Modal>
  );
}
