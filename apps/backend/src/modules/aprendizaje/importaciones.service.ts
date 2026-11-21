import { Inject, Injectable } from "@nestjs/common";
import {
  fijarTrabajoImportacion,
  iniciarImportacion,
  leerEstadoCredenciales,
  ultimaImportacion,
  type Alcance,
  type ContappDb,
  type Tx,
} from "@contapp/db";
import { solicitarImportacionSchema, type ImportacionVista, type TipoCredencial } from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { BuzonError } from "../buzon/errores.js";
import { conReintentoUnico } from "../buzon/apoyo.js";
import { autoresDe } from "../compras/autor.js";
import { contextoDe } from "../clientes/contexto.js";
import { Encolador } from "../trabajos/encolador.js";
import { aErrorHttp, aImportacionVista, exigirCliente } from "./apoyo.js";
import { periodosAImportar } from "./periodos.js";

/** La importación lee el SIRE como la descarga de 014 (007b, D6): hacen falta la clave SOL y la credencial de la API. */
const CREDENCIALES_DESCARGA: readonly TipoCredencial[] = ["sol", "sire_api"];

/**
 * Importar el historial presentado y ver la última importación (spec 025, D-1, D-2, D-4, D-11; CA-1, CA-5, CA-6). Toda consulta va
 * dentro de `withTenant`. El backend NUNCA llama al SIRE ni lee compras: valida, crea la importación (`reglas_importacion_iniciar`,
 * que cierra antes una colgada y rechaza una segunda en curso), encola `reglas.historial.importar` con solo `{importacionId}` y fija
 * el trabajo en la fila, todo en una sola transacción. Los errores salen como códigos, sin RUC, razón social ni montos.
 */
@Injectable()
export class ImportacionesService {
  constructor(
    @Inject(DB) private readonly db: Pick<ContappDb, "withTenant">,
    @Inject(Encolador) private readonly encolador: Encolador,
  ) {}

  /** 202 `{ importacion, trabajoId }`: la importación queda `en_curso` y el worker la completa. */
  async importar(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    cuerpo: unknown,
  ): Promise<{ importacion: ImportacionVista; trabajoId: string }> {
    const v = solicitarImportacionSchema.safeParse(cuerpo ?? {});
    if (!v.success) throw new AccesoError("solicitud_invalida");
    const periodos = periodosAImportar(v.data.periodos, Date.now());
    const ctx = contextoDe(sesion);
    try {
      // UNA transacción (H-025-1-1): comprobaciones, importación en curso, trabajo y su id en la fila se confirman juntos o
      // ninguno. Si encolar falla (cola llena, parámetros) no queda una importación en curso sin trabajo que bloquee el siguiente
      // intento hasta el autocierre. Cliente archivado gana a las credenciales (409). El id de la importación lo da `iniciar`
      // dentro de `antes`, antes de que `encolar` lea los parámetros.
      const parametros = { importacionId: "" };
      const hecho: { importacion: ImportacionVista | null } = { importacion: null };
      const r = await conReintentoUnico(() => {
        hecho.importacion = null;
        return this.encolador.encolarCon(
          { tenantId: ctx.tenantId, userId: ctx.userId },
          { tipo: "reglas.historial.importar", clienteId, parametros, prioridad: "interactivo", creadoPor: ctx.userId },
          async (tx) => {
            await exigirCliente(tx, clienteId, alcance, true);
            await exigirCredencialesDeImportacion(tx, clienteId);
            parametros.importacionId = await iniciarImportacion(tx, { clienteId, periodos });
          },
          async (tx, encolado) => {
            await fijarTrabajoImportacion(tx, { importacionId: parametros.importacionId, trabajoId: encolado.trabajo.id });
            const fila = await ultimaImportacion(tx, clienteId);
            if (fila === null) throw new AccesoError("no_encontrado");
            hecho.importacion = aImportacionVista(fila, await autoresDe(tx, [fila.solicitadaPor.id]));
          },
        );
      });
      if (hecho.importacion === null) throw new AccesoError("no_encontrado");
      return { importacion: hecho.importacion, trabajoId: r.trabajo.id };
    } catch (e) {
      throw aErrorHttp(e);
    }
  }

  /** La importación más reciente del cliente, sea cual sea su estado, o `null`. */
  ultima(sesion: SesionResuelta, alcance: Alcance, clienteId: string): Promise<{ importacion: ImportacionVista | null }> {
    return this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      const fila = await ultimaImportacion(tx, clienteId);
      if (fila === null) return { importacion: null };
      return { importacion: aImportacionVista(fila, await autoresDe(tx, [fila.solicitadaPor.id])) };
    });
  }
}

/** Sin la clave SOL o sin la credencial de la API: 409 `credencial_no_configurada`; la de la API marcada inválida: 409 `credencial_invalida`. */
async function exigirCredencialesDeImportacion(tx: Tx, clienteId: string): Promise<void> {
  const estados = await leerEstadoCredenciales(tx, clienteId);
  const configuradas = new Set(estados.map((f) => f.tipo));
  if (!CREDENCIALES_DESCARGA.every((t) => configuradas.has(t))) throw new AccesoError("credencial_no_configurada");
  if (estados.find((f) => f.tipo === "sire_api")?.estado === "invalida") throw new BuzonError("credencial_invalida");
}
