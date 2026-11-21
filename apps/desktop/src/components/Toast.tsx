import { useEffect } from "react";
import { CircleAlert, CircleCheck, X } from "lucide-react";
import { useStore } from "../store";

/** The current notification, bottom right. Success hides after 4 s, errors after 8 s. */
export function Toast() {
  const toast = useStore((s) => s.toast);
  const dismiss = useStore((s) => s.dismissToast);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(dismiss, toast.kind === "error" ? 8000 : 4000);
    return () => clearTimeout(timer);
  }, [toast, dismiss]);

  // Live region stays mounted so screen readers announce new messages.
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-50">
      {toast && (
        <div
          key={toast.id}
          role={toast.kind === "error" ? "alert" : "status"}
          className={`pointer-events-auto flex max-w-sm animate-[toast-in_200ms_ease-out] items-start gap-2 rounded-md border bg-raised px-3 py-2.5 text-[13px] shadow-lg ${
            toast.kind === "error" ? "border-danger/40" : "border-accent/40"
          }`}
        >
          {toast.kind === "error" ? (
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
          ) : (
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
          )}
          <p className="flex-1 whitespace-pre-line text-fg">{toast.text}</p>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Cerrar aviso"
            className="-mr-1 rounded p-0.5 text-muted hover:bg-surface hover:text-fg"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}
