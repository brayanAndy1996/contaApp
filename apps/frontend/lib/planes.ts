import type { UsoPlanDto } from "@contapp/shared";
import { api } from "./api";

// Plan del estudio en la UI (spec 006, D8, D14, CA-10). Solo lectura de GET /plan/uso y textos. Los límites
// y el uso los decide el backend; aquí no se calcula ningún cupo ni se muestra ningún precio.

export const MENSAJES_PLAN = {
  limiteRucs: "Llegaste al límite de RUCs de tu plan.",
  limiteUsuarios: "Llegaste al límite de usuarios de tu plan.",
  // D8: el Dueño aún no cambia de plan (RF-005 es R3), así que el aviso remite a ContApp.
  subirDePlan: "Contacta a ContApp para subir de plan.",
} as const;

/** Lo que devuelve `cargarUso`: el uso, el estudio sin plan (409 `sin_plan`, D14) o nada que mostrar. */
export type ResultadoUso =
  | { estado: "listo"; uso: UsoPlanDto }
  | { estado: "sin_plan" }
  | { estado: "sin_datos" };

const codigoDe = (datos: unknown): string | undefined =>
  (datos as { codigo?: string } | null | undefined)?.codigo;

/** `GET /plan/uso` del estudio activo. Sin permiso, con una falla o sin datos, `sin_datos`. */
export async function cargarUso(): Promise<ResultadoUso> {
  const r = await api<UsoPlanDto>("/plan/uso");
  if (r.ok && r.datos) return { estado: "listo", uso: r.datos };
  if (r.status === 409 && codigoDe(r.datos) === "sin_plan") {
    return { estado: "sin_plan" };
  }
  return { estado: "sin_datos" };
}
