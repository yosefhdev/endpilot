import { useState } from "react";
import { WandSparkles } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { ancestorsOfItem, useActiveTab, useStore, useVars } from "../store";
import { effectiveAuth } from "../lib/resolve";
import { ScriptsEditor } from "./ScriptsEditor";
import { AuthEditor } from "./AuthEditor";
import { prettyJson } from "../lib/format";
import type { BodyMode, RawLanguage } from "../types";
import { CodeEditor } from "./CodeEditor";
import { KeyValueTable } from "./KeyValueTable";
import { Count, TabStrip } from "./ui";

type Section = "params" | "auth" | "headers" | "body" | "scripts";

const BODY_MODES: { id: BodyMode; label: string }[] = [
  { id: "none", label: "none" },
  { id: "raw", label: "raw" },
  { id: "urlencoded", label: "x-www-form-urlencoded" },
  { id: "formdata", label: "form-data" },
];

const LANGUAGES: { id: RawLanguage; label: string }[] = [
  { id: "json", label: "JSON" },
  { id: "text", label: "Text" },
  { id: "xml", label: "XML" },
  { id: "html", label: "HTML" },
  { id: "javascript", label: "JavaScript" },
];

const activeCount = (rows: { key: string; enabled: boolean }[]) =>
  rows.filter((r) => r.enabled && r.key).length;

export function RequestEditor() {
  const tab = useActiveTab();
  const { updateDraft, setParams } = useStore();
  const [section, setSection] = useState<Section>("params");
  const vars = useVars();
  const d = tab.draft;
  const [collections, items] = useStore(useShallow((s) => [s.collections, s.items]));
  const inherited = effectiveAuth(
    { type: "inherit" },
    ancestorsOfItem({ collections, items }, tab.itemId),
  );

  return (
    <section aria-label="Request" className="flex min-h-0 flex-1 flex-col">
      <TabStrip
        label="Partes del request"
        value={section}
        onChange={setSection}
        items={[
          {
            id: "params",
            label: (
              <>
                Params
                <Count n={activeCount(d.params)} />
              </>
            ),
          },
          {
            id: "auth",
            label: (
              <>Auth{d.auth.type !== "none" && d.auth.type !== "inherit" && <Count n={1} />}</>
            ),
          },
          {
            id: "headers",
            label: (
              <>
                Headers
                <Count n={activeCount(d.headers)} />
              </>
            ),
          },
          { id: "body", label: <>Body{d.bodyMode !== "none" && <Count n={1} />}</> },
          {
            id: "scripts",
            label: (
              <>
                Scripts
                <Count
                  n={[d.scripts.preRequest, d.scripts.postResponse].filter((c) => c.trim()).length}
                />
              </>
            ),
          },
        ]}
      />
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {section === "params" && (
          <KeyValueTable
            label="Query params"
            rows={d.params}
            onChange={(params) => setParams(tab.id, params)}
          />
        )}
        {section === "auth" && (
          <AuthEditor
            auth={d.auth}
            inherited={inherited}
            onChange={(auth) => updateDraft(tab.id, { auth })}
          />
        )}
        {section === "scripts" && (
          <ScriptsEditor
            scripts={d.scripts}
            onChange={(scripts) => updateDraft(tab.id, { scripts })}
          />
        )}
        {section === "headers" && (
          <KeyValueTable
            label="Headers"
            keyPlaceholder="Header"
            rows={d.headers}
            onChange={(headers) => updateDraft(tab.id, { headers })}
          />
        )}
        {section === "body" && (
          <div className="flex h-full flex-col gap-2">
            <div className="flex flex-wrap items-center gap-4">
              <div role="radiogroup" aria-label="Tipo de body" className="flex flex-wrap gap-3">
                {BODY_MODES.map((m) => (
                  <label
                    key={m.id}
                    className="flex cursor-pointer items-center gap-1.5 text-[13px]"
                  >
                    <input
                      type="radio"
                      name="body-mode"
                      checked={d.bodyMode === m.id}
                      onChange={() => updateDraft(tab.id, { bodyMode: m.id })}
                      className="accent-accent"
                    />
                    <span className={d.bodyMode === m.id ? "text-fg" : "text-muted"}>
                      {m.label}
                    </span>
                  </label>
                ))}
              </div>
              {d.bodyMode === "raw" && (
                <div className="ml-auto flex items-center gap-2">
                  {d.raw.language === "json" && (
                    <button
                      onClick={() =>
                        updateDraft(tab.id, {
                          raw: { ...d.raw, content: prettyJson(d.raw.content) },
                        })
                      }
                      className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted hover:bg-raised hover:text-fg"
                    >
                      <WandSparkles className="size-3.5" aria-hidden />
                      Formatear
                    </button>
                  )}
                  <select
                    value={d.raw.language}
                    onChange={(e) =>
                      updateDraft(tab.id, {
                        raw: { ...d.raw, language: e.target.value as RawLanguage },
                      })
                    }
                    aria-label="Lenguaje del body"
                    className="h-7 rounded border border-line-strong bg-surface px-2 text-xs"
                  >
                    {LANGUAGES.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            {d.bodyMode === "none" && (
              <p className="py-6 text-center text-[13px] text-muted">Este request no tiene body.</p>
            )}
            {d.bodyMode === "raw" && (
              <div className="min-h-40 flex-1 overflow-hidden rounded border border-line">
                <CodeEditor
                  label="Body del request"
                  value={d.raw.content}
                  language={d.raw.language}
                  variables={[...vars.keys()]}
                  onChange={(content) => updateDraft(tab.id, { raw: { ...d.raw, content } })}
                />
              </div>
            )}
            {d.bodyMode === "urlencoded" && (
              <KeyValueTable
                label="Campos x-www-form-urlencoded"
                rows={d.urlencoded}
                onChange={(urlencoded) => updateDraft(tab.id, { urlencoded })}
              />
            )}
            {d.bodyMode === "formdata" && (
              <KeyValueTable
                label="Campos form-data"
                withKind
                rows={d.formdata}
                onChange={(formdata) => updateDraft(tab.id, { formdata })}
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}
