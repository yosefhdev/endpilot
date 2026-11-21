import type { KeyValue, VarMap } from "../types";

/** Enabled rows as a map (what scripts see). Later rows win, like `buildVars`. */
export function toVarMap(rows: KeyValue[]): VarMap {
  const map: VarMap = {};
  for (const r of rows) if (r.enabled && r.key.trim()) map[r.key.trim()] = r.value;
  return map;
}

/**
 * Applies what a script did to a scope back onto its rows: changed values, new variables
 * appended, unset ones removed. Disabled rows are kept. `null` when nothing changed.
 */
export function applyVarMap(rows: KeyValue[], before: VarMap, after: VarMap): KeyValue[] | null {
  const changed = (k: string) => before[k] !== after[k];
  if (!Object.keys({ ...before, ...after }).some(changed)) return null;
  const next = rows
    .filter((r) => !(r.enabled && r.key.trim() in before && !(r.key.trim() in after)))
    .map((r) => (r.enabled && r.key.trim() in after ? { ...r, value: after[r.key.trim()] } : r));
  for (const [key, value] of Object.entries(after))
    if (!(key in before)) next.push({ key, value, enabled: true });
  return next;
}
