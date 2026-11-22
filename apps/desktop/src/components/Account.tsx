import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CircleAlert, LogOut, RefreshCw, UserRound, Users } from "lucide-react";
import { errorText, useStore } from "../store";
import { textClass } from "../lib/styles";
import type { Account, Workspace } from "../types";
import { Modal, TabStrip } from "./ui";

const SERVER_KEY = "account.lastServer";

function lastServer() {
  try {
    return localStorage.getItem(SERVER_KEY) ?? "http://localhost";
  } catch {
    return "http://localhost";
  }
}

const ROLE_LABEL: Record<Workspace["role"], string> = {
  owner: "Propietario",
  admin: "Admin",
  editor: "Editor",
  viewer: "Lector",
};

/** Footer of the sidebar: sign in, or who you are signed in as. */
export function AccountBar() {
  // undefined while loading from the keychain; null = signed out.
  const [account, setAccount] = useState<Account | null>();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    invoke<Account | null>("account_status")
      .then(setAccount)
      .catch(() => setAccount(null));
  }, []);

  if (account === undefined) return null;
  return (
    <div className="border-t border-line p-2">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-raised"
      >
        {account ? (
          <span
            aria-hidden
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent"
          >
            {account.user.name.slice(0, 1).toUpperCase()}
          </span>
        ) : (
          <UserRound
            className="size-7 shrink-0 rounded-full bg-raised p-1.5 text-muted"
            aria-hidden
          />
        )}
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] text-fg">
            {account ? account.user.name : "Iniciar sesión"}
          </span>
          <span className="truncate text-xs text-muted">
            {account ? new URL(account.serverUrl).host : "Trabajas solo en local"}
          </span>
        </span>
      </button>
      {open &&
        (account ? (
          <AccountDialog
            account={account}
            onSignedOut={() => setAccount(null)}
            onClose={() => setOpen(false)}
          />
        ) : (
          <SignInDialog
            onSignedIn={(a) => {
              setAccount(a);
              useStore.getState().notify("success", `Sesión iniciada como ${a.user.name}.`);
            }}
            onClose={() => setOpen(false)}
          />
        ))}
    </div>
  );
}

function SignInDialog({
  onSignedIn,
  onClose,
}: {
  onSignedIn: (a: Account) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [serverUrl, setServerUrl] = useState(lastServer);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const account =
        mode === "login"
          ? await invoke<Account>("account_login", { serverUrl, email, password })
          : await invoke<Account>("account_register", { serverUrl, name, email, password });
      try {
        localStorage.setItem(SERVER_KEY, account.serverUrl);
      } catch {
        // Only a convenience: the field just won't be prefilled next time.
      }
      onSignedIn(account);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Cuenta del servidor"
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      submitLabel={busy ? "Conectando…" : mode === "login" ? "Iniciar sesión" : "Crear cuenta"}
    >
      <div className="-mx-4 -mt-3 mb-3">
        <TabStrip
          label="Modo"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setError("");
          }}
          items={[
            { id: "login", label: "Iniciar sesión" },
            { id: "register", label: "Crear cuenta" },
          ]}
        />
      </div>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Servidor
          <input
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            required
            spellCheck={false}
            placeholder="https://endpilot.tu-empresa.com"
            className={textClass}
          />
        </label>
        {mode === "register" && (
          <label className="flex flex-col gap-1 text-xs text-muted">
            Nombre
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="name"
              className={textClass}
            />
          </label>
        )}
        <label className="flex flex-col gap-1 text-xs text-muted">
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            autoComplete="email"
            className={textClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Contraseña
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={mode === "register" ? 8 : undefined}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            className={textClass}
          />
          {mode === "register" && <span className="text-muted">Mínimo 8 caracteres.</span>}
        </label>
        {error && (
          <p role="alert" className="flex items-start gap-2 text-[13px] text-danger">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {error}
          </p>
        )}
        <p className="text-xs text-muted">
          Tus colecciones siguen guardadas en este equipo. La sincronización con el servidor llega
          en una próxima versión.
        </p>
      </div>
    </Modal>
  );
}

function AccountDialog({
  account,
  onSignedOut,
  onClose,
}: {
  account: Account;
  onSignedOut: () => void;
  onClose: () => void;
}) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>();
  const [error, setError] = useState("");
  const [signingOut, setSigningOut] = useState(false);

  const fetchWorkspaces = () =>
    invoke<Workspace[]>("list_workspaces")
      .then(setWorkspaces)
      .catch(async (e) => {
        setError(errorText(e));
        // The server may have ended the session; Rust then forgot it.
        if (!(await invoke<Account | null>("account_status"))) {
          onSignedOut();
          onClose();
          useStore.getState().notify("error", errorText(e));
        }
      });
  const reload = () => {
    setError("");
    setWorkspaces(undefined);
    fetchWorkspaces();
  };
  useEffect(() => {
    fetchWorkspaces();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the dialog opens
  }, []);

  const signOut = async () => {
    setSigningOut(true);
    await invoke("account_logout").catch(() => {});
    onSignedOut();
    onClose();
    useStore.getState().notify("success", "Sesión cerrada.");
  };

  return (
    <Modal title="Cuenta del servidor" onClose={onClose} onSubmit={onClose} submitLabel="Listo">
      <div className="mb-4 flex items-center gap-3">
        <span
          aria-hidden
          className="flex size-10 items-center justify-center rounded-full bg-accent/15 font-semibold text-accent"
        >
          {account.user.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-fg">{account.user.name}</p>
          <p className="truncate text-xs text-muted">
            {account.user.email} · {account.serverUrl}
          </p>
        </div>
        <button
          type="button"
          onClick={signOut}
          disabled={signingOut}
          className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-danger hover:bg-danger/10 disabled:opacity-50"
        >
          <LogOut className="size-3.5" aria-hidden />
          Cerrar sesión
        </button>
      </div>

      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-xs font-medium tracking-wide text-muted uppercase">Workspaces</h3>
        <button
          type="button"
          onClick={reload}
          aria-label="Recargar workspaces"
          title="Recargar"
          className="rounded p-1 text-muted hover:bg-raised hover:text-fg"
        >
          <RefreshCw className="size-3.5" aria-hidden />
        </button>
      </div>
      {error ? (
        <p role="alert" className="flex items-start gap-2 py-2 text-[13px] text-danger">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      ) : !workspaces ? (
        <p className="py-2 text-[13px] text-muted" aria-busy>
          Cargando…
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {workspaces.map((w) => (
            <li key={w.id} className="flex items-center gap-2 px-3 py-2 text-[13px]">
              {w.kind === "personal" ? (
                <UserRound className="size-4 text-muted" aria-hidden />
              ) : (
                <Users className="size-4 text-muted" aria-hidden />
              )}
              <span className="flex-1 truncate text-fg">{w.name}</span>
              <span className="text-xs text-muted">{ROLE_LABEL[w.role]}</span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
