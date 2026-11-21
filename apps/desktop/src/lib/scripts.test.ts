/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { applyVarMap, toVarMap } from "./scripts";

const kv = (key: string, value: string, enabled = true) => ({ key, value, enabled });

describe("script variables", () => {
  const rows = [kv("a", "1"), kv("b", "2"), kv("off", "x", false)];

  test("toVarMap keeps enabled rows only", () => {
    expect(toVarMap(rows)).toEqual({ a: "1", b: "2" });
  });

  test("applyVarMap sets, appends and removes; keeps disabled rows", () => {
    const before = toVarMap(rows);
    expect(applyVarMap(rows, before, { a: "9", c: "3" })).toEqual([
      kv("a", "9"),
      kv("off", "x", false),
      kv("c", "3"),
    ]);
  });

  test("applyVarMap returns null when nothing changed", () => {
    expect(applyVarMap(rows, toVarMap(rows), { a: "1", b: "2" })).toBeNull();
  });
});
