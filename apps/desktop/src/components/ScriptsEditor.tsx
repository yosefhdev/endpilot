import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { Scripts } from "../types";
import { CodeEditor } from "./CodeEditor";

type Phase = "preRequest" | "postResponse";

const PHASES: { id: Phase; label: string; hint: string }[] = [
  { id: "preRequest", label: "Pre-request", hint: "Corre antes de enviar." },
  { id: "postResponse", label: "Post-response", hint: "Corre al llegar la respuesta." },
];

const SNIPPETS: Record<Phase, { label: string; code: string }[]> = {
  preRequest: [
    { label: "Leer una variable", code: 'const base = pm.variables.get("baseUrl");' },
    { label: "Fijar variable de entorno", code: 'pm.environment.set("timestamp", Date.now());' },
    { label: "Escribir en consola", code: 'console.log("Enviando", pm.request.url);' },
  ],
  postResponse: [
    {
      label: "Guardar token de la respuesta",
      code: 'pm.environment.set("token", pm.response.json().token);',
    },
    {
      label: "Test: status 200",
      code: 'pm.test("Status 200", () => {\n  pm.response.to.have.status(200);\n});',
    },
    {
      label: "Test: campo en el JSON",
      code: 'pm.test("Trae id", () => {\n  pm.expect(pm.response.json().id).to.be.ok;\n});',
    },
  ],
};

export function ScriptsEditor({
  scripts,
  onChange,
}: {
  scripts: Scripts;
  onChange: (scripts: Scripts) => void;
}) {
  const [phase, setPhase] = useState<Phase>("preRequest");
  const code = scripts[phase];
  const set = (value: string) => onChange({ ...scripts, [phase]: value });
  const blocked =
    scripts.blocked && Boolean(scripts.preRequest.trim() || scripts.postResponse.trim());

  return (
    <div className="flex h-full min-h-48 flex-col gap-2">
      {blocked && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[13px]"
        >
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
          <p className="flex-1 text-fg">
            Estos scripts vienen de un archivo importado y no se ejecutan hasta que los actives.
            Revisa ambos (pre-request y post-response): un script puede leer tus variables y cambiar
            a dónde se envía el request.
          </p>
          <button
            type="button"
            onClick={() => onChange({ ...scripts, blocked: false })}
            className="h-7 shrink-0 rounded border border-warn/60 px-3 text-xs font-medium text-warn hover:bg-warn/15"
          >
            Los revisé, activar
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 gap-3">
        <div
          role="tablist"
          aria-label="Momento del script"
          className="flex w-36 shrink-0 flex-col gap-1"
        >
          {PHASES.map((p) => (
            <button
              key={p.id}
              role="tab"
              type="button"
              aria-selected={phase === p.id}
              onClick={() => setPhase(p.id)}
              className={`flex items-center justify-between rounded px-2 py-1.5 text-left text-[13px] ${
                phase === p.id ? "bg-raised text-fg" : "text-muted hover:text-fg"
              }`}
            >
              {p.label}
              {scripts[p.id].trim() && (
                <span className="size-1.5 rounded-full bg-accent" aria-label="con código" />
              )}
            </button>
          ))}
          <p className="mt-2 px-2 text-xs text-muted">Fragmentos</p>
          {SNIPPETS[phase].map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => set(code.trim() ? `${code.trimEnd()}\n${s.code}\n` : `${s.code}\n`)}
              className="rounded px-2 py-1 text-left text-xs text-info hover:bg-raised"
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-xs text-muted">
            {PHASES.find((p) => p.id === phase)!.hint} JavaScript con la API{" "}
            <code className="font-mono">pm.*</code>, sin acceso a archivos ni red.
          </p>
          <div className="min-h-40 flex-1 overflow-hidden rounded border border-line">
            <CodeEditor
              key={phase}
              label={`Script ${PHASES.find((p) => p.id === phase)!.label}`}
              value={code}
              language="javascript"
              onChange={set}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
