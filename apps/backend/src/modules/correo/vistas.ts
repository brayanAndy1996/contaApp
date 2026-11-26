import type { PreferenciasLeidas } from "@contapp/db";
import { preferenciasCorreoVistaSchema, type PreferenciasCorreoVista } from "@contapp/shared";

/** Vista de `GET|PUT /cuenta/correo`: exactamente las nueve claves; sin correo, estudio, ids ni motivo del fallo (R-8). */
export function aVista(p: PreferenciasLeidas): PreferenciasCorreoVista {
  return preferenciasCorreoVistaSchema.parse({
    buzonCritico: p.buzonCritico,
    credencialInvalida: p.credencialInvalida,
    planLimite: p.planLimite,
    resumen: p.resumen,
    todosClientes: p.todosClientes,
    todosDisponible: p.todosDisponible,
    todosIgnorado: p.todosIgnorado,
    invitacionResumen: p.invitacionResumen,
    ultimoEnvioFallido: p.ultimoEnvioFallido === null ? null : p.ultimoEnvioFallido.toISOString(),
  });
}
