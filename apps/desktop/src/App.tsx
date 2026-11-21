import { useEffect } from "react";
import { useStore } from "./store";
import { TabBar } from "./components/TabBar";
import { RequestBar } from "./components/RequestBar";
import { RequestEditor } from "./components/RequestEditor";
import { ResponseViewer } from "./components/ResponseViewer";
import { Sidebar } from "./components/Sidebar";
import { SaveDialog } from "./components/Dialogs";

export default function App() {
  const savingTabId = useStore((s) => s.savingTabId);

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
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TabBar />
        <main className="flex min-h-0 flex-1 flex-col">
          <RequestBar />
          <div className="flex min-h-0 flex-1 flex-col">
            <RequestEditor />
            <ResponseViewer />
          </div>
        </main>
      </div>
      {savingTabId && <SaveDialog key={savingTabId} tabId={savingTabId} />}
    </div>
  );
}
