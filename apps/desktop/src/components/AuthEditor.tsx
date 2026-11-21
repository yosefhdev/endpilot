import type { ReactNode } from "react";
import type { Auth, AuthType } from "../types";
import { VarInput } from "./VarInput";

const TYPES: { id: AuthType; label: string }[] = [
  { id: "inherit", label: "Heredar del padre" },
  { id: "none", label: "Sin auth" },
  { id: "bearer", label: "Bearer token" },
  { id: "basic", label: "Basic auth" },
  { id: "apikey", label: "API key" },
];

const DEFAULTS: Record<AuthType, Auth> = {
  inherit: { type: "inherit" },
  none: { type: "none" },
  bearer: { type: "bearer", token: "" },
  basic: { type: "basic", username: "", password: "" },
  apikey: { type: "apikey", key: "", value: "", in: "header" },
};

const fieldClass =
  "h-8 w-full rounded border border-line-strong bg-surface px-2 font-mono text-[13px] focus:border-slate-500 focus:outline-none";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid grid-cols-[8rem_1fr] items-center gap-3 text-[13px]">
      <span className="text-muted">{label}</span>
      {children}
    </label>
  );
}

type Props = {
  auth: Auth;
  onChange: (auth: Auth) => void;
  /** What "inherit" resolves to; omit where there is no parent (a collection). */
  inherited?: { auth: Auth; from?: string };
};

const labelOf = (type: AuthType) => TYPES.find((t) => t.id === type)?.label;

export function AuthEditor({ auth: value, onChange, inherited }: Props) {
  // A collection has no parent: its "inherit" is just no auth.
  const auth: Auth = !inherited && value.type === "inherit" ? { type: "none" } : value;
  const types = inherited ? TYPES : TYPES.filter((t) => t.id !== "inherit");
  return (
    <div className="flex max-w-xl flex-col gap-3 py-1">
      <Field label="Tipo">
        <select
          value={auth.type}
          onChange={(e) => onChange(DEFAULTS[e.target.value as AuthType])}
          className="h-8 w-52 rounded border border-line-strong bg-surface px-2 text-[13px]"
        >
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </Field>
      {auth.type === "inherit" && inherited && (
        <p className="text-[13px] text-muted">
          {inherited.from ? (
            <>
              Usa la auth de <span className="text-fg">{inherited.from}</span>:{" "}
              <span className="text-fg">{labelOf(inherited.auth.type)}</span>.
            </>
          ) : (
            "Guarda el request en una colección para heredar su auth. Por ahora no envía ninguna."
          )}
        </p>
      )}
      {auth.type === "none" && <p className="text-[13px] text-muted">No envía autenticación.</p>}
      {auth.type === "bearer" && (
        <Field label="Token">
          <VarInput
            value={auth.token}
            onChange={(token) => onChange({ ...auth, token })}
            placeholder="{{token}}"
            className={fieldClass}
          />
        </Field>
      )}
      {auth.type === "basic" && (
        <>
          <Field label="Usuario">
            <VarInput
              value={auth.username}
              onChange={(username) => onChange({ ...auth, username })}
              className={fieldClass}
            />
          </Field>
          <Field label="Contraseña">
            <VarInput
              type="password"
              value={auth.password}
              onChange={(password) => onChange({ ...auth, password })}
              className={fieldClass}
            />
          </Field>
        </>
      )}
      {auth.type === "apikey" && (
        <>
          <Field label="Key">
            <VarInput
              value={auth.key}
              onChange={(key) => onChange({ ...auth, key })}
              placeholder="X-API-Key"
              className={fieldClass}
            />
          </Field>
          <Field label="Value">
            <VarInput
              value={auth.value}
              onChange={(value) => onChange({ ...auth, value })}
              className={fieldClass}
            />
          </Field>
          <Field label="Enviar en">
            <select
              value={auth.in}
              onChange={(e) => onChange({ ...auth, in: e.target.value as "header" | "query" })}
              className="h-8 w-52 rounded border border-line-strong bg-surface px-2 text-[13px]"
            >
              <option value="header">Header</option>
              <option value="query">Query params</option>
            </select>
          </Field>
        </>
      )}
      {auth.type !== "none" && auth.type !== "inherit" && (
        <p className="text-xs text-muted">
          Se agrega al enviar. Un header escrito a mano en Headers tiene prioridad.
        </p>
      )}
    </div>
  );
}
