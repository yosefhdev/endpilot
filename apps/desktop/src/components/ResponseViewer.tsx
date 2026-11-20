import { useState } from "react";
import { Check, CircleAlert, Copy, Loader2 } from "lucide-react";
import { useActiveTab, useStore } from "../store";
import { formatBytes, formatMs, headerValue, prettyJson } from "../lib/format";
import type { HttpError, HttpErrorKind, HttpResponse, RawLanguage } from "../types";
import { CodeEditor } from "./CodeEditor";
import { Count, TabStrip } from "./ui";

type Section = "body" | "headers" | "cookies" | "timeline";

const ERROR_TEXT: Record<HttpErrorKind, { title: string; hint: string }> = {
  invalidUrl: {
    title: "URL inválida",
    hint: "Revisa que la URL esté completa, p. ej. https://api.ejemplo.com/ruta.",
  },
  invalidRequest: {
    title: "Request inválido",
    hint: "Revisa el método y los nombres o valores de los headers.",
  },
  dns: {
    title: "No se encontró el servidor",
    hint: "El dominio no se pudo resolver. Revisa que esté bien escrito y que tengas conexión.",
  },
  connection: {
    title: "No se pudo conectar",
    hint: "El servidor rechazó la conexión o no responde. ¿Está levantado y en ese puerto?",
  },
  tls: {
    title: "Error de TLS/SSL",
    hint: "El certificado no es válido o el servidor no habla HTTPS. Prueba con http:// si es local.",
  },
  timeout: {
    title: "Tiempo de espera agotado",
    hint: "El servidor tardó demasiado en responder. Vuelve a intentarlo.",
  },
  tooManyRedirects: { title: "Demasiadas redirecciones", hint: "El servidor redirige en bucle." },
  body: {
    title: "Error al leer la respuesta",
    hint: "La conexión se cortó mientras llegaba el body.",
  },
  file: { title: "No se pudo leer un archivo", hint: "Revisa los archivos elegidos en form-data." },
  cancelled: { title: "Request cancelado", hint: "Lo cancelaste antes de recibir respuesta." },
  other: { title: "Error inesperado", hint: "Revisa el detalle abajo." },
};

function statusTone(status: number) {
  if (status >= 500) return "bg-red-500/15 text-red-300";
  if (status >= 400) return "bg-amber-500/15 text-amber-300";
  if (status >= 300) return "bg-sky-500/15 text-sky-300";
  return "bg-emerald-500/15 text-emerald-300";
}

function languageFor(contentType: string): RawLanguage {
  if (/json/i.test(contentType)) return "json";
  if (/html/i.test(contentType)) return "html";
  if (/xml/i.test(contentType)) return "xml";
  if (/javascript/i.test(contentType)) return "javascript";
  return "text";
}

export function ResponseViewer() {
  const tab = useActiveTab();
  const cancel = useStore((s) => s.cancel);

  let content;
  if (tab.requestId) {
    content = (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-3 text-muted"
        role="status"
      >
        <Loader2 className="size-6 animate-spin" aria-hidden />
        <p>Enviando request…</p>
        <button
          onClick={() => cancel(tab.id)}
          className="rounded border border-line-strong px-3 py-1 text-[13px] text-fg hover:border-danger hover:text-danger"
        >
          Cancelar
        </button>
      </div>
    );
  } else if (tab.error) {
    content = <ErrorView error={tab.error} />;
  } else if (tab.response) {
    content = <ResponseView key={tab.id} response={tab.response} />;
  } else {
    content = (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center text-muted">
        <p className="text-fg">Aún no hay respuesta</p>
        <p className="text-[13px]">
          Escribe una URL y pulsa{" "}
          <kbd className="rounded bg-raised px-1.5 py-0.5 font-mono text-xs">Ctrl+Enter</kbd>
        </p>
      </div>
    );
  }

  return (
    <section
      aria-label="Respuesta"
      className="flex min-h-0 flex-1 flex-col border-t border-line-strong"
    >
      {content}
    </section>
  );
}

function ErrorView({ error }: { error: HttpError }) {
  const text = ERROR_TEXT[error.kind] ?? ERROR_TEXT.other;
  return (
    <div className="flex flex-1 items-start justify-center overflow-auto p-6" role="alert">
      <div className="w-full max-w-2xl rounded-md border border-red-500/30 bg-red-500/5 p-4">
        <div className="flex items-center gap-2 font-medium text-danger">
          <CircleAlert className="size-4" aria-hidden />
          {text.title}
        </div>
        <p className="mt-1 text-[13px] text-fg">{text.hint}</p>
        <pre className="mt-3 overflow-auto rounded bg-bg p-3 font-mono text-xs whitespace-pre-wrap text-muted">
          {error.message}
        </pre>
      </div>
    </div>
  );
}

function ResponseView({ response: r }: { response: HttpResponse }) {
  const [section, setSection] = useState<Section>("body");
  return (
    <>
      <TabStrip
        label="Partes de la respuesta"
        value={section}
        onChange={setSection}
        items={[
          { id: "body", label: "Body" },
          {
            id: "headers",
            label: (
              <>
                Headers
                <Count n={r.headers.length} />
              </>
            ),
          },
          {
            id: "cookies",
            label: (
              <>
                Cookies
                <Count n={r.cookies.length} />
              </>
            ),
          },
          { id: "timeline", label: "Timeline" },
        ]}
        trailing={
          <div className="flex items-center gap-3 text-xs tabular-nums">
            <span className={`rounded px-2 py-0.5 font-mono font-semibold ${statusTone(r.status)}`}>
              {r.status} {r.statusText}
            </span>
            <span className="text-muted">
              <span className="sr-only">Tiempo: </span>
              {formatMs(r.timings.totalMs)}
            </span>
            <span
              className="text-muted"
              title={`Body ${formatBytes(r.bodySize)} + headers ${formatBytes(r.headersSize)}`}
            >
              <span className="sr-only">Tamaño: </span>
              {formatBytes(r.bodySize + r.headersSize)}
            </span>
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {section === "body" && <BodyView response={r} />}
        {section === "headers" && (
          <Table
            label="Headers de la respuesta"
            head={["Header", "Valor"]}
            rows={r.headers.map((h) => [h.key, h.value])}
            empty="La respuesta no trae headers."
          />
        )}
        {section === "cookies" && (
          <Table
            label="Cookies"
            head={["Nombre", "Valor", "Dominio", "Path", "Expira", "Flags"]}
            rows={r.cookies.map((c) => [
              c.name,
              c.value,
              c.domain ?? "—",
              c.path ?? "—",
              c.maxAgeSecs != null
                ? `${c.maxAgeSecs} s`
                : c.expiresAtMs != null
                  ? new Date(c.expiresAtMs).toLocaleString()
                  : "Sesión",
              [
                c.httpOnly && "HttpOnly",
                c.secure && "Secure",
                c.sameSite && `SameSite=${c.sameSite}`,
              ]
                .filter(Boolean)
                .join(" · ") || "—",
            ])}
            empty="La respuesta no establece cookies."
          />
        )}
        {section === "timeline" && <TimelineView response={r} />}
      </div>
    </>
  );
}

function BodyView({ response: r }: { response: HttpResponse }) {
  const [pretty, setPretty] = useState(true);
  const [copied, setCopied] = useState(false);
  const contentType = headerValue(r.headers, "content-type");
  const language = languageFor(contentType);
  const text = pretty && language === "json" ? prettyJson(r.body) : r.body;

  if (r.bodyIsBase64) {
    return contentType.startsWith("image/") ? (
      <div className="flex justify-center p-4">
        <img
          src={`data:${contentType};base64,${r.body}`}
          alt="Imagen de la respuesta"
          className="max-w-full"
        />
      </div>
    ) : (
      <p className="p-6 text-center text-[13px] text-muted">
        Respuesta binaria ({contentType || "tipo desconocido"}, {formatBytes(r.bodySize)}).
      </p>
    );
  }
  if (r.body === "") {
    return <p className="p-6 text-center text-[13px] text-muted">La respuesta no tiene body.</p>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-3 py-1.5">
        {(["Pretty", "Raw"] as const).map((mode) => {
          const active = (mode === "Pretty") === pretty;
          return (
            <button
              key={mode}
              onClick={() => setPretty(mode === "Pretty")}
              aria-pressed={active}
              className={`rounded px-2 py-0.5 text-xs ${active ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}
            >
              {mode}
            </button>
          );
        })}
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="ml-auto flex items-center gap-1.5 rounded px-2 py-0.5 text-xs text-muted hover:bg-raised hover:text-fg"
        >
          {copied ? (
            <Check className="size-3.5 text-accent" aria-hidden />
          ) : (
            <Copy className="size-3.5" aria-hidden />
          )}
          {copied ? "Copiado" : "Copiar"}
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <CodeEditor
          label="Body de la respuesta"
          value={text}
          language={pretty ? language : "text"}
          readOnly
        />
      </div>
    </div>
  );
}

function Table({
  label,
  head,
  rows,
  empty,
}: {
  label: string;
  head: string[];
  rows: string[][];
  empty: string;
}) {
  if (rows.length === 0) return <p className="p-6 text-center text-[13px] text-muted">{empty}</p>;
  return (
    <table className="w-full border-collapse text-[13px]" aria-label={label}>
      <thead>
        <tr className="text-left text-xs text-muted">
          {head.map((h) => (
            <th key={h} className="px-3 py-1.5 font-medium">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((cells, i) => (
          <tr key={i} className="border-t border-line align-top">
            {cells.map((c, j) => (
              <td
                key={j}
                className={`px-3 py-1.5 font-mono break-all ${j === 0 ? "text-fg" : "text-muted"}`}
              >
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TimelineView({ response: r }: { response: HttpResponse }) {
  const t = r.timings;
  const dns = t.dnsMs ?? 0;
  const phases = [
    { label: "DNS", ms: t.dnsMs, color: "bg-violet-400" },
    { label: "Conexión + espera (TTFB)", ms: Math.max(t.ttfbMs - dns, 0), color: "bg-amber-400" },
    { label: "Descarga", ms: t.downloadMs, color: "bg-accent" },
  ];
  let offset = 0;
  return (
    <div className="flex flex-col gap-5 p-4 text-[13px]">
      <div className="flex flex-col gap-2" aria-label="Fases del request">
        {phases.map((p) => {
          const ms = p.ms ?? 0;
          const left = (offset / t.totalMs) * 100;
          offset += ms;
          return (
            <div key={p.label} className="grid grid-cols-[12rem_1fr_5rem] items-center gap-3">
              <span className="text-muted">{p.label}</span>
              <div className="relative h-2 rounded bg-raised">
                {p.ms != null && (
                  <div
                    className={`absolute h-2 rounded ${p.color}`}
                    style={{ left: `${left}%`, width: `${Math.max((ms / t.totalMs) * 100, 0.5)}%` }}
                  />
                )}
              </div>
              <span className="text-right font-mono text-xs tabular-nums">
                {p.ms == null ? "—" : formatMs(ms)}
              </span>
            </div>
          );
        })}
        <div className="grid grid-cols-[12rem_1fr_5rem] gap-3 border-t border-line pt-2 font-medium">
          <span>Total</span>
          <span />
          <span className="text-right font-mono text-xs tabular-nums">{formatMs(t.totalMs)}</span>
        </div>
      </div>

      <dl className="grid grid-cols-[12rem_1fr] gap-x-3 gap-y-1.5">
        <dt className="text-muted">URL final</dt>
        <dd className="font-mono break-all">{r.url}</dd>
        <dt className="text-muted">Versión HTTP</dt>
        <dd className="font-mono">{r.httpVersion}</dd>
      </dl>

      {r.redirects.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-medium text-muted">Redirecciones</h3>
          <ol className="flex flex-col gap-1.5">
            {r.redirects.map((rd, i) => (
              <li key={i} className="font-mono text-xs break-all">
                <span className="mr-2 rounded bg-sky-500/15 px-1.5 py-0.5 text-sky-300">
                  {rd.status}
                </span>
                {rd.from} <span className="text-muted">→</span> {rd.to}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
