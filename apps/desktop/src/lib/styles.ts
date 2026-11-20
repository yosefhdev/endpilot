export const METHOD_COLORS: Record<string, string> = {
  GET: "text-emerald-400",
  POST: "text-amber-400",
  PUT: "text-sky-400",
  PATCH: "text-violet-400",
  DELETE: "text-red-400",
  HEAD: "text-teal-400",
  OPTIONS: "text-pink-400",
};

export const methodColor = (m: string) => METHOD_COLORS[m.toUpperCase()] ?? "text-muted";

export const inputClass =
  "h-8 w-full rounded border border-transparent bg-transparent px-2 font-mono text-[13px] text-fg placeholder:text-slate-500 hover:border-line-strong focus:border-line-strong focus:bg-surface focus:outline-none";
