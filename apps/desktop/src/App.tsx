import { useEffect, useRef } from "react";
import { useStore } from "./store";
import { TabBar } from "./components/TabBar";
import { RequestBar } from "./components/RequestBar";
import { RequestEditor } from "./components/RequestEditor";
import { ResponseViewer } from "./components/ResponseViewer";
import { Sidebar } from "./components/Sidebar";
import { SaveDialog } from "./components/Dialogs";
import { Toast } from "./components/Toast";
import { Splitter } from "./components/Splitter";
import { useStoredSize } from "./lib/useStoredSize";

const SIDEBAR_WIDTH = 288;
const EDITOR_HEIGHT = 280;
/** Each pane keeps at least this much, so neither can be dragged away. */
const MIN_PANE = 96;

export default function App() {
  const savingTabId = useStore((s) => s.savingTabId);
  const [sidebarWidth, setSidebarWidth] = useStoredSize("layout.sidebarWidth", SIDEBAR_WIDTH);
  const [editorHeight, setEditorHeight] = useStoredSize("layout.editorHeight", EDITOR_HEIGHT);
  const panes = useRef<HTMLDivElement>(null);

  useEffect(() => {
    useStore
      .getState()
      .load()
      .catch((e) => console.error("No se pudo cargar la base local", e));
  }, []);

  useEffect(() => {
    // Capture phase so shortcuts win over CodeMirror's own Mod-Enter.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const { activeId, send, newTab, closeTab, save } = useStore.getState();
      const key = e.key.toLowerCase();
      if (key === "enter") void send(activeId);
      else if (key === "t") newTab();
      else if (key === "w") void closeTab(activeId);
      else if (key === "s") void save(activeId);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  return (
    <div className="flex h-full">
      <Sidebar width={sidebarWidth} />
      <Splitter
        orientation="vertical"
        label="Ancho de la barra lateral"
        size={sidebarWidth}
        onResize={setSidebarWidth}
        min={200}
        max={() => Math.min(560, window.innerWidth - 480)}
        defaultSize={SIDEBAR_WIDTH}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <TabBar />
        <main className="flex min-h-0 flex-1 flex-col">
          <RequestBar />
          <div ref={panes} className="flex min-h-0 flex-1 flex-col">
            {/* Shrinks with the window; the response takes what is left. */}
            <div style={{ flexBasis: editorHeight }} className="flex min-h-24 flex-col">
              <RequestEditor />
            </div>
            <Splitter
              orientation="horizontal"
              label="Alto del request y la respuesta"
              size={editorHeight}
              onResize={setEditorHeight}
              min={MIN_PANE}
              max={() => (panes.current?.clientHeight ?? 600) - MIN_PANE}
              defaultSize={EDITOR_HEIGHT}
            />
            <ResponseViewer />
          </div>
        </main>
      </div>
      {savingTabId && <SaveDialog key={savingTabId} tabId={savingTabId} />}
      <Toast />
    </div>
  );
}
