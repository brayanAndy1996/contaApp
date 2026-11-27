import { Inject, Injectable } from "@nestjs/common";
import type { SesionCuenta } from "@contapp/shared";
import type { DbAuth, SesionResuelta } from "../auth.service.js";
import { DB } from "../inyeccion.js";
import { hashToken } from "../sesion/token.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Sesiones anteriores a 029 no tienen dispositivo guardado: se muestran como «Otro» (lista cerrada, U6). */
const DISPOSITIVO_DESCONOCIDO = "Otro";

/**
 * Sesiones de la cuenta (spec 029, CA-5, RF-014): listar las vigentes propias y revocar una o todas menos la actual. Todo por las funciones
 * `auth.sesiones_*` con el hash del token de la sesión que pregunta; nunca devuelve hashes ni tokens, y la IP ya viene truncada (U6).
 */
@Injectable()
export class SesionesService {
  constructor(@Inject(DB) private readonly db: DbAuth) {}

  /** GET /auth/sesiones. */
  async listar(s: SesionResuelta): Promise<SesionCuenta[]> {
    const filas = await this.db.withAuth((_a, c) => c.sesiones.listar(hashToken(s.token)));
    return filas.map((f) => ({
      id: f.id,
      creadaEn: f.creadaEn.toISOString(),
      ultimoUso: f.ultimoUso.toISOString(),
      dispositivo: f.dispositivo ?? DISPOSITIVO_DESCONOCIDO,
      ip: f.ipRed,
      actual: f.actual,
    }));
  }

  /** POST /auth/sesiones/:id/revocar: propia, ajena, inexistente, ya revocada o mal formada responden igual (204), sin eco. */
  async revocar(s: SesionResuelta, id: unknown): Promise<void> {
    if (typeof id !== "string" || !UUID.test(id)) return;
    await this.db.withAuth((_a, c) => c.sesiones.revocar(hashToken(s.token), id));
  }

  /** POST /auth/sesiones/revocar-otras: idempotente (204 aunque no haya otras). */
  async revocarOtras(s: SesionResuelta): Promise<void> {
    await this.db.withAuth((_a, c) => c.sesiones.revocarOtras(hashToken(s.token)));
  }
}
