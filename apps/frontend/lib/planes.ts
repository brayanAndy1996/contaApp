import type { UsoPlanDto } from "@contapp/shared";
import { api } from "./api";

// Plan del estudio en la UI (spec 006, D8, CA-10). Solo lectura de GET /plan/uso y textos. Los límites
// y el uso los decide el backend; aquí no se calcula ningún cupo ni se muestra ningún precio.

export const MENSAJES_PLAN = {
  limiteRucs: "Llegaste al límite de RUCs de tu plan.",
  limiteUsuarios: "Llegaste al límite de usuarios de tu plan.",
  // D8: el Dueño aún no cambia de plan (RF-005 es R3), así que el aviso remite a ContApp.
  subirDePlan: "Contacta a ContApp para subir de plan.",
} as const;

/** `GET /plan/uso` del estudio activo; `null` si no hay plan (409), no hay permiso o la petición falla. */
export async function cargarUso(): Promise<UsoPlanDto | null> {
  const r = await api<UsoPlanDto>("/plan/uso");
  return r.ok && r.datos ? r.datos : null;
}
