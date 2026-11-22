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

// Mirrors crates/core/src/model.rs.

export type Auth =
  | { type: "inherit" }
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "basic"; username: string; password: string }
  | { type: "apikey"; key: string; value: string; in: "header" | "query" };

export type AuthType = Auth["type"];

/** A request as edited and saved (unresolved: may contain `{{variables}}`). */
export interface RequestSpec {
  method: string;
  url: string;
  params: KeyValue[];
  headers: KeyValue[];
  bodyMode: BodyMode;
  raw: { content: string; language: RawLanguage };
  urlencoded: KeyValue[];
  formdata: FormField[];
  auth: Auth;
  scripts: Scripts;
}

/** JavaScript run before sending and after the response. */
export interface Scripts {
  preRequest: string;
  postResponse: string;
  /** Imported and not reviewed yet: not run until the user enables them. */
  blocked: boolean;
}

/** What collections and folders pass down to their requests. */
export interface Settings {
  auth: Auth;
  scripts: Scripts;
}

export interface Collection {
  id: string;
  name: string;
  variables: KeyValue[];
  /** Auth "inherit" at the collection means no auth. */
  settings: Settings;
  sort: number;
  updatedAt: number;
}

export type ItemKind = "folder" | "request";

export interface Item {
  id: string;
  collectionId: string;
  parentId: string | null;
  kind: ItemKind;
  name: string;
  sort: number;
  request: RequestSpec | null;
  /** Folders only. */
  settings: Settings | null;
  updatedAt: number;
}

export interface Environment {
  id: string;
  name: string;
  variables: KeyValue[];
  sort: number;
  updatedAt: number;
}

export interface HistoryEntry {
  id: string;
  createdAt: number;
  request: RequestSpec;
  status: number | null;
  durationMs: number | null;
  size: number | null;
  error: string | null;
}

export interface Snapshot {
  collections: Collection[];
  items: Item[];
  environments: Environment[];
  globals: KeyValue[];
  activeEnvironmentId: string | null;
}

export type ImportResult =
  | { kind: "collection"; collection: Collection }
  | { kind: "environment"; environment: Environment }
  | { kind: "globals"; count: number }
  | { kind: "request"; request: RequestSpec };

// Mirrors crates/script-sandbox.

export type VarMap = Record<string, string>;

export interface ScriptVariables {
  globals: VarMap;
  collection: VarMap;
  environment: VarMap | null;
  local: VarMap;
}

export interface ScriptRequest {
  method: string;
  url: string;
  headers: KeyValue[];
}

export interface ScriptInput {
  scripts: { source: string; code: string }[];
  variables: ScriptVariables;
  request: ScriptRequest;
  response: {
    code: number;
    status: string;
    headers: KeyValue[];
    body: string;
    responseTime: number;
  } | null;
}

export interface LogLine {
  level: "log" | "info" | "warn" | "error";
  text: string;
}

export interface TestResult {
  name: string;
  passed: boolean;
  error: string | null;
}

export interface ScriptOutput {
  variables: ScriptVariables;
  request: ScriptRequest;
  logs: LogLine[];
  tests: TestResult[];
  errors: string[];
}

/** Signed-in Endpilot server account (tokens stay in Rust and the OS keychain). */
export interface Account {
  serverUrl: string;
  user: { id: string; email: string; name: string };
}

export interface Workspace {
  id: string;
  name: string;
  kind: "personal" | "team";
  role: "owner" | "admin" | "editor" | "viewer";
  createdAt: string;
}

/** What the scripts of one send left: shown in the response panel. */
export interface ScriptReport {
  logs: LogLine[];
  tests: TestResult[];
  errors: string[];
}
