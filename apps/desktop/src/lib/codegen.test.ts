/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { generateCode } from "./codegen";
import type { HttpRequest } from "../types";

const base: HttpRequest = {
  method: "POST",
  url: "https://api.x.com/users?a=1",
  headers: [
    { key: "Authorization", value: "Bearer t", enabled: true },
    { key: "X-Off", value: "1", enabled: false },
  ],
  body: { mode: "raw", language: "json", content: `{"name":"O'Brien"}` },
  timeoutMs: null,
  followRedirects: true,
};

describe("generateCode", () => {
  test("curl quotes safely and adds the raw Content-Type", () => {
    expect(generateCode(base, "curl")).toBe(
      [
        "curl 'https://api.x.com/users?a=1'",
        "-X 'POST'",
        "-H 'Authorization: Bearer t'",
        "-H 'Content-Type: application/json'",
        `--data-raw '{"name":"O'\\''Brien"}'`,
      ].join(" \\\n  "),
    );
  });

  test("curl form fields and files", () => {
    const code = generateCode(
      {
        ...base,
        headers: [],
        body: {
          mode: "formdata",
          fields: [
            { key: "name", value: "Ana", kind: "text", enabled: true },
            { key: "pic", value: "/tmp/a.png", kind: "file", enabled: true },
          ],
        },
      },
      "curl",
    );
    expect(code).toContain("-F 'name=Ana'");
    expect(code).toContain("-F 'pic=@/tmp/a.png'");
  });

  test("fetch and python skip disabled headers and escape strings", () => {
    const js = generateCode(base, "fetch");
    expect(js).toContain(`body: "{\\"name\\":\\"O'Brien\\"}",`);
    expect(js).not.toContain("X-Off");
    const py = generateCode(
      { ...base, method: "GET", headers: [], body: { mode: "none" } },
      "python",
    );
    expect(py).toBe(
      [
        "import requests",
        "",
        "response = requests.request(",
        '    "GET",',
        '    "https://api.x.com/users?a=1",',
        ")",
        "print(response.status_code)",
        "print(response.text)",
      ].join("\n"),
    );
  });
});
