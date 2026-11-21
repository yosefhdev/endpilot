/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import {
  buildVars,
  insertVar,
  resolveText,
  toHttpRequest,
  unresolvedVars,
  varQueryAt,
} from "./resolve";
import type { Auth, RequestSpec } from "../types";

const kv = (key: string, value: string, enabled = true) => ({ key, value, enabled });

const spec = (patch: Partial<RequestSpec> = {}): RequestSpec => ({
  method: "GET",
  url: "{{base}}/users",
  params: [],
  headers: [],
  bodyMode: "none",
  raw: { content: "", language: "json" },
  urlencoded: [],
  formdata: [],
  auth: { type: "none" },
  ...patch,
});

describe("variables", () => {
  const vars = buildVars(
    [kv("base", "http://global"), kv("g", "1")],
    [kv("base", "http://collection")],
    [kv("base", "http://env"), kv("off", "x", false), kv(" ", "blank")],
  );

  test("environment beats collection beats globals; disabled and blank skipped", () => {
    expect(vars.get("base")).toBe("http://env");
    expect(vars.get("g")).toBe("1");
    expect(vars.has("off")).toBe(false);
    expect(vars.size).toBe(2);
  });

  test("resolveText keeps unknown variables and tolerates spaces", () => {
    expect(resolveText("{{ base }}/a/{{missing}}?g={{g}}", vars)).toBe(
      "http://env/a/{{missing}}?g=1",
    );
    expect(unresolvedVars("{{base}} {{missing}} {{ other }}", vars)).toEqual(["missing", "other"]);
  });
});

describe("autocomplete helpers", () => {
  test("varQueryAt finds an unclosed {{ before the cursor", () => {
    expect(varQueryAt("{{ba", 4)).toEqual({ start: 0, query: "ba" });
    expect(varQueryAt("x/{{", 4)).toEqual({ start: 2, query: "" });
    expect(varQueryAt("{{base}}/a", 10)).toBeNull();
    expect(varQueryAt("{{ba se", 7)).toBeNull();
  });

  test("insertVar completes and swallows a trailing }}", () => {
    expect(insertVar("{{ba/x", 4, 0, "base")).toEqual({ text: "{{base}}/x", cursor: 8 });
    expect(insertVar("{{ba}}/x", 4, 0, "base")).toEqual({ text: "{{base}}/x", cursor: 8 });
  });
});

describe("toHttpRequest", () => {
  const vars = buildVars([kv("base", "http://x"), kv("token", "t0k"), kv("user", "ana")]);
  const auth = (a: Auth) => toHttpRequest(spec({ auth: a }), vars);

  test("resolves url, headers and raw body; drops disabled rows", () => {
    const req = toHttpRequest(
      spec({
        headers: [kv("X-Base", "{{base}}"), kv("X-Off", "1", false)],
        bodyMode: "raw",
        raw: { content: '{"u":"{{user}}"}', language: "json" },
      }),
      vars,
    );
    expect(req.url).toBe("http://x/users");
    expect(req.headers).toEqual([kv("X-Base", "http://x")]);
    expect(req.body).toEqual({ mode: "raw", language: "json", content: '{"u":"ana"}' });
  });

  test("bearer and basic add Authorization (UTF-8 safe)", () => {
    expect(auth({ type: "bearer", token: "{{token}}" }).headers).toEqual([
      kv("Authorization", "Bearer t0k"),
    ]);
    expect(auth({ type: "basic", username: "{{user}}", password: "contraseña" }).headers).toEqual([
      kv("Authorization", `Basic ${Buffer.from("ana:contraseña").toString("base64")}`),
    ]);
  });

  test("explicit Authorization header wins over auth", () => {
    const req = toHttpRequest(
      spec({ headers: [kv("authorization", "Custom x")], auth: { type: "bearer", token: "t" } }),
      vars,
    );
    expect(req.headers).toEqual([kv("authorization", "Custom x")]);
  });

  test("api key in header or query", () => {
    expect(
      auth({ type: "apikey", key: "X-Key", value: "{{token}}", in: "header" }).headers,
    ).toEqual([kv("X-Key", "t0k")]);
    expect(auth({ type: "apikey", key: "k", value: "v", in: "query" }).url).toBe(
      "http://x/users?k=v",
    );
    const withQuery = toHttpRequest(
      spec({
        url: "http://x/a?b=1#h",
        auth: { type: "apikey", key: "k", value: "v", in: "query" },
      }),
      vars,
    );
    expect(withQuery.url).toBe("http://x/a?b=1&k=v#h");
  });

  test("form bodies are resolved", () => {
    const req = toHttpRequest(
      spec({ bodyMode: "formdata", formdata: [{ ...kv("name", "{{user}}"), kind: "text" }] }),
      vars,
    );
    expect(req.body).toEqual({
      mode: "formdata",
      fields: [{ ...kv("name", "ana"), kind: "text" }],
    });
  });
});
