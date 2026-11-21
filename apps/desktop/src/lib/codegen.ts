import type { HttpRequest, KeyValue, RawLanguage } from "../types";

export type CodeLanguage = "curl" | "fetch" | "python";

export const CODE_LANGUAGES: { id: CodeLanguage; label: string }[] = [
  { id: "curl", label: "cURL" },
  { id: "fetch", label: "JavaScript (fetch)" },
  { id: "python", label: "Python (requests)" },
];

// Same defaults the engine (crates/http) applies to raw bodies.
const CONTENT_TYPES: Record<RawLanguage, string> = {
  text: "text/plain",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  javascript: "application/javascript",
};

/** Headers as sent: raw bodies get a Content-Type unless the user set one. */
function headersOf(req: HttpRequest): KeyValue[] {
  const headers = req.headers.filter((h) => h.enabled && h.key);
  const body = req.body;
  if (body.mode === "raw" && !headers.some((h) => h.key.toLowerCase() === "content-type"))
    headers.push({ key: "Content-Type", value: CONTENT_TYPES[body.language], enabled: true });
  return headers;
}

const fields = <T extends KeyValue>(rows: T[]) => rows.filter((r) => r.enabled && r.key);

/** POSIX single quotes: safe for any content. */
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** A JSON string literal is also a valid JS and Python string literal. */
const str = (s: string) => JSON.stringify(s);

function curl(req: HttpRequest): string {
  // --url: a URL starting with "-" would otherwise be read as an option.
  const parts = [`curl ${req.method === "HEAD" ? "-I " : ""}--url ${sh(req.url)}`];
  if (!["GET", "HEAD"].includes(req.method)) parts.push(`-X ${sh(req.method)}`);
  for (const h of headersOf(req)) parts.push(`-H ${sh(`${h.key}: ${h.value}`)}`);
  const body = req.body;
  if (body.mode === "raw") parts.push(`--data-raw ${sh(body.content)}`);
  if (body.mode === "urlencoded")
    for (const f of fields(body.fields))
      parts.push(`--data-urlencode ${sh(`${f.key}=${f.value}`)}`);
  if (body.mode === "formdata")
    for (const f of fields(body.fields))
      parts.push(`-F ${sh(`${f.key}=${f.kind === "file" ? "@" : ""}${f.value}`)}`);
  return parts.join(" \\\n  ");
}

function fetchJs(req: HttpRequest): string {
  const lines: string[] = [];
  const opts = [`  method: ${str(req.method)},`];
  const headers = headersOf(req);
  if (headers.length) {
    opts.push("  headers: {");
    for (const h of headers) opts.push(`    ${str(h.key)}: ${str(h.value)},`);
    opts.push("  },");
  }
  const body = req.body;
  if (body.mode === "raw") opts.push(`  body: ${str(body.content)},`);
  if (body.mode === "urlencoded") {
    const pairs = fields(body.fields).map((f) => `[${str(f.key)}, ${str(f.value)}]`);
    opts.push(`  body: new URLSearchParams([${pairs.join(", ")}]),`);
  }
  if (body.mode === "formdata") {
    const form = fields(body.fields);
    if (form.some((f) => f.kind === "file")) lines.push('import fs from "node:fs";', "");
    lines.push("const form = new FormData();");
    for (const f of form)
      lines.push(
        f.kind === "file"
          ? `form.append(${str(f.key)}, await fs.openAsBlob(${str(f.value)}));`
          : `form.append(${str(f.key)}, ${str(f.value)});`,
      );
    lines.push("");
    opts.push("  body: form,");
  }
  lines.push(`const response = await fetch(${str(req.url)}, {`, ...opts, "});");
  lines.push("console.log(response.status, await response.text());");
  return lines.join("\n");
}

function python(req: HttpRequest): string {
  const args = [`    ${str(req.method)},`, `    ${str(req.url)},`];
  const headers = headersOf(req);
  if (headers.length) {
    args.push("    headers={");
    for (const h of headers) args.push(`        ${str(h.key)}: ${str(h.value)},`);
    args.push("    },");
  }
  const body = req.body;
  const tuples = (rows: KeyValue[]) => rows.map((f) => `(${str(f.key)}, ${str(f.value)})`);
  if (body.mode === "raw") args.push(`    data=${str(body.content)}.encode("utf-8"),`);
  if (body.mode === "urlencoded")
    args.push(`    data=[${tuples(fields(body.fields)).join(", ")}],`);
  if (body.mode === "formdata") {
    const form = fields(body.fields);
    const text = form.filter((f) => f.kind === "text");
    const files = form.filter((f) => f.kind === "file");
    if (text.length) args.push(`    data=[${tuples(text).join(", ")}],`);
    if (files.length)
      args.push(
        `    files=[${files.map((f) => `(${str(f.key)}, open(${str(f.value)}, "rb"))`).join(", ")}],`,
      );
  }
  return [
    "import requests",
    "",
    "response = requests.request(",
    ...args,
    ")",
    "print(response.status_code)",
    "print(response.text)",
  ].join("\n");
}

export function generateCode(req: HttpRequest, language: CodeLanguage): string {
  if (language === "curl") return curl(req);
  if (language === "fetch") return fetchJs(req);
  return python(req);
}
