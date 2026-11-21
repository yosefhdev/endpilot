import { useMemo } from "react";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { xml } from "@codemirror/lang-xml";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { EditorState } from "@codemirror/state";
import type { CompletionSource } from "@codemirror/autocomplete";
import type { RawLanguage } from "../types";

const SEP = "\u0000";

/** Suggests `name}}` after `{{`, alongside the language's own completions. */
const varCompletions =
  (names: string[]): CompletionSource =>
  (ctx) => {
    const m = ctx.matchBefore(/\{\{\s*[^{}\s]*/);
    if (!m) return null;
    const from = m.from + m.text.search(/[^{\s]|$/);
    return {
      from,
      validFor: /^[^{}\s]*$/,
      options: names.map((n) => ({ label: n, apply: `${n}}}`, type: "variable" })),
    };
  };

const LANGUAGES = { json, xml, html, javascript } as const;

const theme = EditorView.theme(
  {
    "&": { backgroundColor: "transparent", height: "100%", fontSize: "13px" },
    ".cm-gutters": { backgroundColor: "transparent", borderRight: "1px solid var(--color-line)" },
    ".cm-content, .cm-gutter": { fontFamily: "var(--font-mono)" },
    "&.cm-focused": { outline: "none" },
  },
  { dark: true },
);

export function CodeEditor({
  value,
  onChange,
  language,
  readOnly = false,
  label,
  variables,
}: {
  value: string;
  onChange?: (value: string) => void;
  language: RawLanguage;
  readOnly?: boolean;
  label: string;
  /** Variable names to suggest after `{{`. */
  variables?: string[];
}) {
  // Join so a new-but-equal array does not rebuild the editor's extensions.
  const names = variables?.join(SEP) ?? "";
  const extensions = useMemo(
    () => [
      theme,
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": label }),
      ...(language === "text" ? [] : [LANGUAGES[language]()]),
      ...(names
        ? [EditorState.languageData.of(() => [{ autocomplete: varCompletions(names.split(SEP)) }])]
        : []),
    ],
    [language, label, names],
  );
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      readOnly={readOnly}
      editable={!readOnly}
      theme="dark"
      height="100%"
      className="h-full"
      extensions={extensions}
      basicSetup={{ highlightActiveLine: !readOnly, highlightActiveLineGutter: !readOnly }}
    />
  );
}
