import type { Auth, HttpRequest, KeyValue, RequestBody, RequestSpec, Settings } from "../types";

export type Vars = Map<string, string>;

const VAR = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Later scopes win: globals < collection < environment (same order as Postman). */
export function buildVars(...scopes: KeyValue[][]): Vars {
  const vars: Vars = new Map();
  for (const scope of scopes)
    for (const v of scope) if (v.enabled && v.key.trim()) vars.set(v.key.trim(), v.value);
  return vars;
}

/** Replaces known `{{name}}`; unknown ones stay as typed so the user sees them in the request. */
export function resolveText(text: string, vars: Vars): string {
  return text.replace(VAR, (whole, name: string) => vars.get(name) ?? whole);
}

export type Segment = { text: string; start: number; name?: string };

/** Splits text into plain runs and `{{name}}` runs, keeping offsets (for highlighting). */
export function varSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(VAR)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), start: last });
    out.push({ text: m[0], start: m.index, name: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), start: last });
  return out;
}

export function unresolvedVars(text: string, vars: Vars): string[] {
  return [...text.matchAll(VAR)].map((m) => m[1]).filter((name) => !vars.has(name));
}

/** If the cursor sits right after an unclosed `{{name`, returns where `{{` starts and the typed name. */
export function varQueryAt(text: string, cursor: number): { start: number; query: string } | null {
  const m = /\{\{\s*([^{}\s]*)$/.exec(text.slice(0, cursor));
  return m ? { start: m.index, query: m[1] } : null;
}

/** Inserts `{{name}}` replacing the unclosed `{{query` and any `}}` already after the cursor. */
export function insertVar(text: string, cursor: number, start: number, name: string) {
  const rest = text.slice(cursor).replace(/^[^{}\s]*\}\}/, "");
  const before = `${text.slice(0, start)}{{${name}}}`;
  return { text: before + rest, cursor: before.length };
}

/** A collection or folder above a request, with what it passes down. */
export interface Ancestor {
  kind: "collection" | "folder";
  name: string;
  settings: Settings;
}

/**
 * The auth a request sends: its own, or the nearest ancestor's that is not "inherit"
 * (`ancestors` go from the collection down). Inherit all the way up means no auth.
 */
export function effectiveAuth(auth: Auth, ancestors: Ancestor[]): { auth: Auth; from?: string } {
  if (auth.type !== "inherit") return { auth };
  for (const a of [...ancestors].reverse())
    if (a.settings.auth.type !== "inherit") return { auth: a.settings.auth, from: describe(a) };
  return { auth: { type: "none" }, from: ancestors[0] && describe(ancestors[0]) };
}

const describe = (a: Ancestor) =>
  `${a.kind === "collection" ? "la colección" : "la carpeta"} "${a.name}"`;

function utf8Base64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

const resolveRows = <T extends KeyValue>(rows: T[], vars: Vars): T[] =>
  rows
    .filter((r) => r.enabled)
    .map((r) => ({ ...r, key: resolveText(r.key, vars), value: resolveText(r.value, vars) }));

/**
 * Turns the saved request into what the engine sends: variables resolved, auth applied.
 * `inherited` is used when the request's auth is "inherit" (see `effectiveAuth`).
 */
export function toHttpRequest(
  spec: RequestSpec,
  vars: Vars,
  inherited: Auth = { type: "none" },
): HttpRequest {
  let url = resolveText(spec.url, vars);
  const headers = resolveRows(spec.headers, vars);
  const hasHeader = (name: string) =>
    headers.some((h) => h.key.toLowerCase() === name.toLowerCase());

  const auth = spec.auth.type === "inherit" ? inherited : spec.auth;
  if (auth.type === "bearer" && !hasHeader("authorization")) {
    headers.push({
      key: "Authorization",
      value: `Bearer ${resolveText(auth.token, vars)}`,
      enabled: true,
    });
  } else if (auth.type === "basic" && !hasHeader("authorization")) {
    const credentials = `${resolveText(auth.username, vars)}:${resolveText(auth.password, vars)}`;
    headers.push({
      key: "Authorization",
      value: `Basic ${utf8Base64(credentials)}`,
      enabled: true,
    });
  } else if (auth.type === "apikey" && auth.key.trim()) {
    const key = resolveText(auth.key, vars);
    const value = resolveText(auth.value, vars);
    if (auth.in === "query") {
      const [base, hash = ""] = url.split(/(?=#)/);
      url = `${base}${base.includes("?") ? "&" : "?"}${key}=${value}${hash}`;
    } else if (!hasHeader(key)) {
      headers.push({ key, value, enabled: true });
    }
  }

  const body: RequestBody =
    spec.bodyMode === "raw"
      ? { mode: "raw", language: spec.raw.language, content: resolveText(spec.raw.content, vars) }
      : spec.bodyMode === "urlencoded"
        ? { mode: "urlencoded", fields: resolveRows(spec.urlencoded, vars) }
        : spec.bodyMode === "formdata"
          ? { mode: "formdata", fields: resolveRows(spec.formdata, vars) }
          : { mode: "none" };

  return { method: spec.method, url, headers, body, timeoutMs: null, followRedirects: true };
}
