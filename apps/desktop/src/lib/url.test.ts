/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { paramsFromUrl, parseParams, urlWithParams } from "./url";

const kv = (key: string, value: string, enabled = true) => ({ key, value, enabled });

describe("parseParams", () => {
  test("splits on first = and keeps raw text", () => {
    expect(parseParams("https://x.io/a?q=a=b&flag&t={{token}}#top")).toEqual([
      kv("q", "a=b"),
      kv("flag", ""),
      kv("t", "{{token}}"),
    ]);
  });
  test("no query", () => {
    expect(parseParams("https://x.io/a")).toEqual([]);
    expect(parseParams("https://x.io/a?")).toEqual([]);
  });
});

describe("paramsFromUrl", () => {
  test("keeps disabled params from before", () => {
    expect(paramsFromUrl("x?a=1", [kv("a", "0"), kv("off", "1", false)])).toEqual([
      kv("a", "1"),
      kv("off", "1", false),
    ]);
  });
});

describe("urlWithParams", () => {
  test("rebuilds query, skips disabled and empty rows, keeps hash", () => {
    expect(
      urlWithParams("https://x.io/a?old=1#h", [
        kv("a", "1"),
        kv("b", ""),
        kv("c", "3", false),
        kv("", ""),
      ]),
    ).toEqual("https://x.io/a?a=1&b#h");
  });
  test("removes ? when no params left", () => {
    expect(urlWithParams("https://x.io/a?old=1", [])).toEqual("https://x.io/a");
  });
  test("round-trips", () => {
    const url = "https://x.io/a?q=a=b&flag&t={{token}}";
    expect(urlWithParams(url, parseParams(url))).toEqual(url);
  });
});
