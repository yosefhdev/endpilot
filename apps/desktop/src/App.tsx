import { useEffect } from "react";
import { useStore } from "./store";
import { TabBar } from "./components/TabBar";
import { RequestBar } from "./components/RequestBar";
import { RequestEditor } from "./components/RequestEditor";
import { ResponseViewer } from "./components/ResponseViewer";

export default function App() {
  useEffect(() => {
    // Capture phase so shortcuts win over CodeMirror's own Mod-Enter.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const { activeId, send, newTab, closeTab } = useStore.getState();
      const key = e.key.toLowerCase();
      if (key === "enter") void send(activeId);
      else if (key === "t") newTab();
      else if (key === "w") closeTab(activeId);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  return (
    <div className="flex h-full flex-col">
      <TabBar />
      <main className="flex min-h-0 flex-1 flex-col">
        <RequestBar />
        <div className="flex min-h-0 flex-1 flex-col">
          <RequestEditor />
          <ResponseViewer />
        </div>
      </main>
    </div>
  );
}
