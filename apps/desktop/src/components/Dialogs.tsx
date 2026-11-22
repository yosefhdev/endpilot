import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { blockedScriptCount, errorText, useActiveTab, useStore, useVars } from "../store";
import { CODE_LANGUAGES, generateCode, type CodeLanguage } from "../lib/codegen";
import type { Auth, ImportResult, KeyValue, Settings } from "../types";
import { AuthEditor } from "./AuthEditor";
import { CodeEditor } from "./CodeEditor";
import { KeyValueTable } from "./KeyValueTable";
import { ScriptsEditor } from "./ScriptsEditor";
import { Count, Modal, TabStrip } from "./ui";
import { textClass } from "../lib/styles";

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
  if (r.kind === "collection") {
    const blocked = blockedScriptCount(useStore.getState(), r.collection.id);
    const note = blocked
      ? " Trae scripts: no se ejecutan hasta que los revises y actives en sus ajustes."
      : "";
    return `Colección "${r.collection.name}" importada correctamente.${note}`;
  }
  if (r.kind === "environment") return `Entorno "${r.environment.name}" importado.`;
  if (r.kind === "globals") return `${r.count} variables globales importadas.`;
  return "";
}

/** Import from a file or pasted text: Postman collection/environment/globals, OpenAPI 3 or cURL. */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const { importText, importFile, notify } = useStore();
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  /** `pasted`: on error keep the dialog open so the pasted text is not lost. */
  const run = async (task: () => Promise<ImportResult | null>, pasted: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await task();
      if (!result) return; // file picker cancelled
      onClose();
      // A cURL opens in a new tab, which is feedback enough.
      if (result.kind !== "request") notify("success", importedText(result));
    } catch (e) {
      if (pasted) return setError(errorText(e));
      onClose();
      notify("error", `No se pudo importar el archivo. ${errorText(e)}`);
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
        void run(() => importText(text), true);
      }}
    >
      <div className="flex flex-col gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(importFile, false)}
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
      </div>
    </Modal>
  );
}

/** Code for the active request with variables and auth already applied. */
export function CodeDialog({ onClose }: { onClose: () => void }) {
  const tab = useActiveTab();
  useVars(); // re-render when variables change
  const httpRequestFor = useStore((s) => s.httpRequestFor);
  const [language, setLanguage] = useState<CodeLanguage>("curl");
  const [copied, setCopied] = useState(false);
  const code = generateCode(httpRequestFor(tab), language);

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

type SettingsSection = "variables" | "auth" | "scripts";

/**
 * Collection or folder settings: what its requests inherit (auth, scripts) and,
 * for a collection, its variables.
 */
export function SettingsDialog({
  title,
  settings: initial,
  variables: initialVariables,
  inherited,
  blockedCount = 0,
  onApproveAll,
  onSave,
  onClose,
}: {
  title: string;
  /** Collections only: imported script sets not reviewed yet, anywhere inside. */
  blockedCount?: number;
  onApproveAll?: () => Promise<void>;
  settings: Settings;
  /** Collections only. */
  variables?: KeyValue[];
  /** Folders only: what "inherit" resolves to. */
  inherited?: { auth: Auth; from?: string };
  onSave: (settings: Settings, variables?: KeyValue[]) => Promise<void>;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState(initial);
  const [variables, setVariables] = useState(initialVariables);
  const [section, setSection] = useState<SettingsSection>(variables ? "variables" : "auth");
  const [error, setError] = useState<string>();
  const scriptCount = [settings.scripts.preRequest, settings.scripts.postResponse].filter((c) =>
    c.trim(),
  ).length;

  return (
    <Modal
      title={title}
      large
      onClose={onClose}
      onSubmit={async () => {
        try {
          await onSave(
            settings,
            variables?.filter((v) => v.key.trim() || v.value),
          );
          onClose();
        } catch (e) {
          setError(errorText(e));
        }
      }}
    >
      <div className="flex h-full flex-col">
        {blockedCount > 0 && onApproveAll && (
          <div
            role="alert"
            className="mb-3 flex items-start gap-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[13px]"
          >
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
            <p className="flex-1">
              {blockedCount === 1 ? "Hay 1 grupo" : `Hay ${blockedCount} grupos`} de scripts
              importados sin revisar en esta colección; no se ejecutan. Revísalos en la pestaña
              Scripts de la colección, sus carpetas y requests antes de activarlos.
            </p>
            <button
              type="button"
              onClick={async () => {
                try {
                  await onApproveAll();
                  setSettings((s) => ({ ...s, scripts: { ...s.scripts, blocked: false } }));
                } catch (e) {
                  setError(errorText(e));
                }
              }}
              className="h-7 shrink-0 rounded border border-warn/60 px-3 text-xs font-medium text-warn hover:bg-warn/15"
            >
              Activar todos
            </button>
          </div>
        )}
        <TabStrip
          label="Secciones de ajustes"
          value={section}
          onChange={setSection}
          items={[
            ...(variables
              ? [
                  {
                    id: "variables" as const,
                    label: (
                      <>
                        Variables
                        <Count n={variables.filter((v) => v.enabled && v.key).length} />
                      </>
                    ),
                  },
                ]
              : []),
            { id: "auth", label: "Auth" },
            {
              id: "scripts",
              label: (
                <>
                  Scripts
                  <Count n={scriptCount} />
                </>
              ),
            },
          ]}
        />
        <div className="min-h-0 flex-1 overflow-auto pt-3">
          {section === "variables" && variables && (
            <>
              <KeyValueTable
                label="Variables de la colección"
                keyPlaceholder="Variable"
                rows={variables}
                onChange={setVariables}
              />
              <p className="mt-2 text-xs text-muted">
                Valen para todos los requests de la colección. Un entorno activo con la misma
                variable tiene prioridad.
              </p>
            </>
          )}
          {section === "auth" && (
            <>
              <AuthEditor
                auth={settings.auth}
                inherited={inherited}
                onChange={(auth) => setSettings({ ...settings, auth })}
              />
              <p className="mt-3 text-xs text-muted">
                Los requests con auth &quot;Heredar del padre&quot; usan esta.
              </p>
            </>
          )}
          {section === "scripts" && (
            <>
              <p className="mb-2 text-xs text-muted">
                Corren en cada request de dentro, antes que los del request (colección → carpeta →
                request).
              </p>
              <div className="h-[calc(100%-1.5rem)]">
                <ScriptsEditor
                  scripts={settings.scripts}
                  onChange={(scripts) => setSettings({ ...settings, scripts })}
                />
              </div>
            </>
          )}
        </div>
        {error && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
