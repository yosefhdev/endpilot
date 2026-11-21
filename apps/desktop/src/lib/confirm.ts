import { ask } from "@tauri-apps/plugin-dialog";

export const confirmDelete = (what: string) =>
  ask(`¿Eliminar ${what}? No se puede deshacer.`, {
    title: "Eliminar",
    kind: "warning",
    okLabel: "Eliminar",
    cancelLabel: "Cancelar",
  });
