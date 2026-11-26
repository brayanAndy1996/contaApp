import { Inject, Injectable } from "@nestjs/common";
import { fijarPreferencias, leerPreferencias, type ContappDb } from "@contapp/db";
import { preferenciasCorreoSchema, type PreferenciasCorreoVista } from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { esReintentable, sqlstateDe } from "../buzon/apoyo.js";
import { contextoDe } from "../clientes/contexto.js";
import { CorreoError } from "./errores.js";
import { aVista } from "./vistas.js";

/** SQLSTATE de las funciones de 0074 -> error de la API (`42501` rol o sin membresía, `CA430` asignaciones, `22023` argumento). */
function traducir(e: unknown): unknown {
  switch (sqlstateDe(e)) {
    case "42501":
      return new AccesoError("permiso_denegado");
    case "CA430":
      return new CorreoError("todos_clientes_no_disponible");
    case "22023":
      return new AccesoError("solicitud_invalida");
    default:
      return e;
  }
}

/**
 * Preferencias de correo del usuario de la sesión (spec 028; R-10, R-15; CA-1, CA-10, CA-12). Todo en `withTenant`: el usuario y el estudio
 * salen de la sesión, nunca del cuerpo. Leer no escribe; guardar pasa por `correo_preferencias_fijar` (valida, audita y omite lo pendiente).
 * El backend no inserta envíos. Un interbloqueo o fallo de serialización se reintenta una vez y luego es 503.
 */
@Injectable()
export class PreferenciasService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  async leer(sesion: SesionResuelta): Promise<PreferenciasCorreoVista> {
    const contexto = contextoDe(sesion);
    try {
      return aVista(await this.db.withTenant(contexto, (tx) => leerPreferencias(tx)));
    } catch (e) {
      throw traducir(e);
    }
  }

  async guardar(sesion: SesionResuelta, cuerpo: unknown): Promise<PreferenciasCorreoVista> {
    const r = preferenciasCorreoSchema.safeParse(cuerpo);
    if (!r.success) throw new AccesoError("solicitud_invalida");
    const contexto = contextoDe(sesion);
    const intentar = async (): Promise<PreferenciasCorreoVista> =>
      aVista(await this.db.withTenant(contexto, (tx) => fijarPreferencias(tx, r.data)));
    try {
      try {
        return await intentar();
      } catch (e) {
        if (!esReintentable(e)) throw e;
      }
      return await intentar();
    } catch (e) {
      if (esReintentable(e)) throw new CorreoError("correo_ocupado");
      throw traducir(e);
    }
  }
}
