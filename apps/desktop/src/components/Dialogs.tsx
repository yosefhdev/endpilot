import { useState } from "react";
import { errorText, useStore } from "../store";
import type { KeyValue } from "../types";
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
