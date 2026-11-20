import type { KeyValue } from "../types";

/**
 * Two-way sync between the URL bar and the Params table, like Postman.
 * Values stay as typed (no encoding/decoding) so `{{vars}}` and pre-encoded text survive.
 */

function split(url: string) {
  const hashAt = url.indexOf("#");
  const hash = hashAt === -1 ? "" : url.slice(hashAt);
  const noHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const queryAt = noHash.indexOf("?");
  return {
    base: queryAt === -1 ? noHash : noHash.slice(0, queryAt),
    query: queryAt === -1 ? null : noHash.slice(queryAt + 1),
    hash,
  };
}

export function parseParams(url: string): KeyValue[] {
  const { query } = split(url);
  if (query === null || query === "") return [];
  return query.split("&").map((pair) => {
    const eq = pair.indexOf("=");
    return eq === -1
      ? { key: pair, value: "", enabled: true }
      : { key: pair.slice(0, eq), value: pair.slice(eq + 1), enabled: true };
  });
}

/** Params for a newly typed URL; disabled params are not in the URL, so carry them over. */
export function paramsFromUrl(url: string, previous: KeyValue[]): KeyValue[] {
  return [...parseParams(url), ...previous.filter((p) => !p.enabled)];
}

export function urlWithParams(url: string, params: KeyValue[]): string {
  const { base, hash } = split(url);
  const pairs = params
    .filter((p) => p.enabled && (p.key !== "" || p.value !== ""))
    .map((p) => (p.value === "" ? p.key : `${p.key}=${p.value}`));
  return pairs.length ? `${base}?${pairs.join("&")}${hash}` : `${base}${hash}`;
}
