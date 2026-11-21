import type { HttpRequest, KeyValue, RequestBody, RequestSpec } from "../types";

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

function utf8Base64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

const resolveRows = <T extends KeyValue>(rows: T[], vars: Vars): T[] =>
  rows
    .filter((r) => r.enabled)
    .map((r) => ({ ...r, key: resolveText(r.key, vars), value: resolveText(r.value, vars) }));

/** Turns the saved request into what the engine sends: variables resolved, auth applied. */
export function toHttpRequest(spec: RequestSpec, vars: Vars): HttpRequest {
  let url = resolveText(spec.url, vars);
  const headers = resolveRows(spec.headers, vars);
  const hasHeader = (name: string) =>
    headers.some((h) => h.key.toLowerCase() === name.toLowerCase());

  const auth = spec.auth;
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
