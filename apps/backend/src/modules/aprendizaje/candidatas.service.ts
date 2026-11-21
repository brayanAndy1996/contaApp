import { Inject, Injectable } from "@nestjs/common";
import {
  activarCandidatas,
  descartarCandidatas,
  leerRegla,
  listarCandidatas,
  reemplazarCandidata,
  type Alcance,
  type ContappDb,
} from "@contapp/db";
import {
  activarCandidatasSchema,
  descartarCandidatasSchema,
  filtrosCandidatasSchema,
  reemplazarCandidataSchema,
  respuestaActivarSchema,
  respuestaDescartarSchema,
  type CandidataVista,
  type ReglaVista,
  type RespuestaActivar,
  type RespuestaDescartar,
} from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { conReintentoUnico } from "../buzon/apoyo.js";
import { contextoDe } from "../clientes/contexto.js";
import { autoresDe } from "../compras/autor.js";
import { ReglasError } from "../reglas/errores.js";
import { aReglaVista } from "../reglas/vistas.js";
import { aCandidataVista, aErrorHttp, codificarCursor, decodificarCursor, exigirCliente, idDe } from "./apoyo.js";

/**
 * Candidatas del historial: listar, activar, reemplazar y descartar (spec 025, D-4 a D-7, D-10, D-11; U-8; CA-3, CA-4). Toda consulta
 * va dentro de `withTenant`. Las escrituras pasan solo por las funciones acotadas de 0062 (`packages/db`): activar no registra
 * confirmación para 033 (D-7) y nunca sobrescribe una regla viva (D-6). Cliente o candidata ajenos o inexistentes: el mismo 404.
 * Los interbloqueos (`40P01`, `40001`) se reintentan una vez y luego dan 503.
 */
@Injectable()
export class CandidatasService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  /** Una página de un grupo de la última importación completada; sin `grupo`, las propuestas. `siguiente` es un cursor opaco. */
  async listar(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    query: unknown,
  ): Promise<{ candidatas: CandidataVista[]; siguiente: string | null }> {
    const v = filtrosCandidatasSchema.safeParse(query);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    const posicion = v.data.cursor === undefined ? null : decodificarCursor(v.data.cursor);
    const pagina = await this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      return listarCandidatas(tx, { clienteId, grupo: v.data.grupo ?? "propuestas", posicion, limite: v.data.limite });
    });
    return {
      candidatas: pagina.candidatas.map(aCandidataVista),
      siguiente: pagina.siguiente === null ? null : codificarCursor(pagina.siguiente),
    };
  }

  /**
   * Activa por ids (con el destino elegido o el propuesto) o «todas» las de la última importación completada. Un id ajeno o
   * inexistente da 404 a todo el lote; `todas` con otra importación, 400 (no es la última). Las omitidas salen con su motivo.
   */
  async activar(sesion: SesionResuelta, alcance: Alcance, clienteId: string, cuerpo: unknown): Promise<RespuestaActivar> {
    const v = activarCandidatasSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    const ctx = contextoDe(sesion);
    const entrada =
      "items" in v.data
        ? {
            clienteId,
            items: v.data.items.map((i) => (i.destino === undefined ? { id: i.id } : { id: i.id, destino: i.destino })),
          }
        : { clienteId, todas: v.data.importacionId };
    try {
      const r = await conReintentoUnico(() =>
        this.db.withTenant(ctx, async (tx) => {
          await exigirCliente(tx, clienteId, alcance, true);
          return activarCandidatas(tx, entrada);
        }),
      );
      return respuestaActivarSchema.parse(r);
    } catch (e) {
      throw aErrorHttp(e);
    }
  }

  /**
   * Reemplaza la regla viva del proveedor por el destino de la candidata, solo con conflicto «distinto». `versionRegla` es la de la
   * REGLA: otra da 409 `regla_cambiada` sin cambios, igual que una candidata que ya no tiene conflicto.
   */
  async reemplazar(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    candidataCruda: string,
    cuerpo: unknown,
  ): Promise<{ regla: ReglaVista }> {
    const v = reemplazarCandidataSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    const candidataId = idDe(candidataCruda);
    const ctx = contextoDe(sesion);
    try {
      return await conReintentoUnico(() =>
        this.db.withTenant(ctx, async (tx) => {
          await exigirCliente(tx, clienteId, alcance, true);
          const r = await reemplazarCandidata(tx, {
            clienteId,
            candidataId,
            ...(v.data.destino === undefined ? {} : { destino: v.data.destino }),
            versionRegla: v.data.versionRegla,
          });
          if (r === "regla_cambiada") throw new ReglasError("regla_cambiada");
          const regla = await leerRegla(tx, clienteId, r.reglaId);
          if (regla === null) throw new AccesoError("no_encontrado");
          return { regla: aReglaVista(regla, await autoresDe(tx, [regla.creadaPor])) };
        }),
      );
    } catch (e) {
      throw aErrorHttp(e, true);
    }
  }

  /** Descarta las pendientes (no crea reglas); las que ya no lo están vuelven como omitidas. Un id ajeno da 404 a todo el lote. */
  async descartar(sesion: SesionResuelta, alcance: Alcance, clienteId: string, cuerpo: unknown): Promise<RespuestaDescartar> {
    const v = descartarCandidatasSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    const ctx = contextoDe(sesion);
    try {
      const r = await conReintentoUnico(() =>
        this.db.withTenant(ctx, async (tx) => {
          await exigirCliente(tx, clienteId, alcance, true);
          return descartarCandidatas(tx, { clienteId, ids: v.data.ids });
        }),
      );
      return respuestaDescartarSchema.parse(r);
    } catch (e) {
      throw aErrorHttp(e);
    }
  }
}
