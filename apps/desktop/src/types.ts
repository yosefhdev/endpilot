// Mirrors crates/core/src/http.rs (serde camelCase). Keep both in sync.

export interface KeyValue {
  key: string;
  value: string;
  enabled: boolean;
}

export type RawLanguage = "text" | "json" | "xml" | "html" | "javascript";
export type FormFieldKind = "text" | "file";

export interface FormField extends KeyValue {
  kind: FormFieldKind;
}

export type RequestBody =
  | { mode: "none" }
  | { mode: "raw"; content: string; language: RawLanguage }
  | { mode: "urlencoded"; fields: KeyValue[] }
  | { mode: "formdata"; fields: FormField[] };

export type BodyMode = RequestBody["mode"];

export interface HttpRequest {
  method: string;
  url: string;
  headers: KeyValue[];
  body: RequestBody;
  timeoutMs: number | null;
  followRedirects: boolean;
}

export interface Cookie {
  name: string;
  value: string;
  domain: string | null;
  path: string | null;
  expiresAtMs: number | null;
  maxAgeSecs: number | null;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string | null;
}

export interface Timings {
  dnsMs: number | null;
  ttfbMs: number;
  downloadMs: number;
  totalMs: number;
}

export interface Redirect {
  status: number;
  from: string;
  to: string;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  url: string;
  headers: KeyValue[];
  cookies: Cookie[];
  body: string;
  bodyIsBase64: boolean;
  bodySize: number;
  headersSize: number;
  redirects: Redirect[];
  timings: Timings;
}

export type HttpErrorKind =
  | "invalidUrl"
  | "invalidRequest"
  | "dns"
  | "connection"
  | "tls"
  | "timeout"
  | "tooManyRedirects"
  | "body"
  | "file"
  | "cancelled"
  | "other";

export interface HttpError {
  kind: HttpErrorKind;
  message: string;
}
