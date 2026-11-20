import { useMemo } from "react";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { xml } from "@codemirror/lang-xml";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import type { RawLanguage } from "../types";

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
}: {
  value: string;
  onChange?: (value: string) => void;
  language: RawLanguage;
  readOnly?: boolean;
  label: string;
}) {
  const extensions = useMemo(
    () => [
      theme,
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": label }),
      ...(language === "text" ? [] : [LANGUAGES[language]()]),
    ],
    [language, label],
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
