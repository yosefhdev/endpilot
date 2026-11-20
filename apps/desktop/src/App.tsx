import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export default function App() {
  const [version, setVersion] = useState<string>();

  useEffect(() => {
    invoke<string>("app_version").then(setVersion, () => setVersion(undefined));
  }, []);

  return (
    <main className="flex h-screen flex-col items-center justify-center gap-2 bg-zinc-950 text-zinc-100">
      <h1 className="text-2xl font-semibold tracking-tight">Endpilot</h1>
      <p className="text-sm text-zinc-400">{version ? `v${version}` : "Cargando…"}</p>
    </main>
  );
}
