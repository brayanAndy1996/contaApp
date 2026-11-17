import { Inject, Injectable } from "@nestjs/common";
import {
  auditarBuzon,
  leerAdjuntoBuzon,
  leerEstadoBuzon,
  leerMensajeBuzon,
  listarMensajesBuzon,
  type Alcance,
  type ContappDb,
  type EstadoBuzon as EstadoBuzonFila,
  type MensajeBuzonFila as MensajeFila,
} from "@contapp/db";
import { sanearNombreAdjunto } from "@contapp/domain";
import {
  listarMensajesQuery,
  type AdjuntoVista,
  type DetalleMensaje,
  type EstadoBuzon,
  type MensajeBuzonFila,
  type PaginaMensajesBuzon,
} from "@contapp/shared";
import { ArchivoNoEncontradoError, leerVerificado, type StorageProvider } from "@contapp/storage";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { contextoDe } from "../clientes/contexto.js";
import { STORAGE } from "../storage/storage.module.js";
import {
  codificarCursor,
  decodificarCursor,
  ENFRIAMIENTO_MS,
  exigirCliente,
  idDe,
  LIMITE_POR_OMISION,
  rutaDelCliente,
} from "./apoyo.js";

/** Un adjunto listo para entregar: nombre saneado, MIME de la fila y los bytes guardados (verificados contra su SHA-256). */
export interface AdjuntoDescargable {
  nombre: string;
  mime: string | null;
  bytes: Uint8Array;
}

const aFila = (m: MensajeFila): MensajeBuzonFila => ({
  id: m.id,
  asunto: m.asunto,
  remitente: m.remitente,
  fecha: m.fecha.toISOString(),
  categoria: m.categoria as MensajeBuzonFila["categoria"],
  critico: m.critico,
  motivoCritico: m.motivoCritico as MensajeBuzonFila["motivoCritico"],
  leidoEnSunat: m.leidoEnSunat,
  contenidoObtenido: m.contenidoObtenido,
  adjuntosDeclarados: m.adjuntosDeclarados,
});

/** Estado de captura para la pantalla; sin fila de estado: todo en blanco. `revisarDesde` es el fin del enfriamiento de 10 min. */
function aEstado(e: EstadoBuzonFila | null, ahora: number): EstadoBuzon {
  if (e === null) return { ultimaCaptura: null, sincronizado: false, revisarDesde: null };
  const instantes = [e.ultimaSolicitudEn, e.ultimaCapturaEn].filter((f): f is Date => f !== null);
  const fin = instantes.length === 0 ? null : Math.max(...instantes.map((f) => f.getTime())) + ENFRIAMIENTO_MS;
  return {
    ultimaCaptura: e.ultimaCapturaEn === null ? null : e.ultimaCapturaEn.toISOString(),
    sincronizado: e.sincronizadoEn !== null,
    revisarDesde: fin !== null && fin > ahora ? new Date(fin).toISOString() : null,
  };
}

/**
 * Lectura del buzón (spec 023, D-8): lista, detalle con el texto plano y descarga de adjuntos. El alcance lo exige
 * `ClienteScopeGuard` y se repite dentro de la transacción; el cliente va en toda consulta, así que un mensaje o adjunto de otro
 * cliente (ids cruzados) es un 404 igual que uno inexistente. Los archivos salen del puerto de storage por la ruta de la fila,
 * solo si cuelga de `buzon/{estudio}/{cliente}/`. Nada de lo que se lee va a un log.
 */
@Injectable()
export class LecturaBuzonService {
  constructor(
    @Inject(DB) private readonly db: Pick<ContappDb, "withTenant">,
    @Inject(STORAGE) private readonly storage: StorageProvider,
  ) {}

  async listar(sesion: SesionResuelta, alcance: Alcance, clienteId: string, queryCruda: unknown): Promise<PaginaMensajesBuzon> {
    const q = listarMensajesQuery.safeParse(queryCruda);
    if (!q.success) throw new AccesoError("solicitud_invalida");
    const antes = q.data.cursor === undefined ? undefined : decodificarCursor(q.data.cursor);
    const limite = q.data.limite ?? LIMITE_POR_OMISION;
    return this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      const estado = await leerEstadoBuzon(tx, clienteId);
      const filas = await listarMensajesBuzon(tx, clienteId, { antes, limite });
      const ultimo = filas.at(-1);
      // Página llena: hay `siguiente` solo si existe al menos un mensaje más allá del último.
      let siguiente: string | null = null;
      if (ultimo !== undefined && filas.length === limite) {
        const mas = await listarMensajesBuzon(tx, clienteId, { antes: { fecha: ultimo.fecha, id: ultimo.id }, limite: 1 });
        if (mas.length > 0) siguiente = codificarCursor(ultimo.fecha, ultimo.id);
      }
      return { estado: aEstado(estado, Date.now()), mensajes: filas.map(aFila), siguiente };
    });
  }

  /** El texto plano guardado (o `null` si aún no se abrió) y los adjuntos sin ruta ni hash. Audita `contenido_visto` si hay texto. */
  async detalle(sesion: SesionResuelta, alcance: Alcance, clienteId: string, mensajeCrudo: string): Promise<DetalleMensaje> {
    const mensajeId = idDe(mensajeCrudo).toLowerCase();
    const ctx = contextoDe(sesion);
    return this.db.withTenant(ctx, async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      const m = await leerMensajeBuzon(tx, clienteId, mensajeId);
      if (m === null) throw new AccesoError("no_encontrado");
      let contenido: string | null = null;
      if (m.contenidoRuta !== null) {
        contenido = await this.leerTexto(m.contenidoRuta, ctx.tenantId, clienteId);
        await auditarBuzon(tx, "buzon.contenido_visto", { clienteId, mensajeId });
      }
      const adjuntos: AdjuntoVista[] = m.adjuntos.map((a) => ({
        id: a.id,
        nombre: sanearNombreAdjunto(a.nombre),
        mime: a.mime,
        tamano: a.tamano ?? 0,
        omitido: a.omitido,
      }));
      return { mensaje: aFila(m), contenido, adjuntos };
    });
  }

  /**
   * Los bytes tal como se guardaron. 404 si el adjunto no es de este cliente y mensaje, fue omitido (no hay archivo) o su archivo no
   * está; un archivo cuyo SHA-256 no coincide con la fila es un 500 (`ArchivoAlteradoError`) y nunca se entrega. Audita cada descarga.
   */
  async descargar(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    mensajeCrudo: string,
    adjuntoCrudo: string,
  ): Promise<AdjuntoDescargable> {
    const mensajeId = idDe(mensajeCrudo).toLowerCase();
    const adjuntoId = idDe(adjuntoCrudo).toLowerCase();
    const ctx = contextoDe(sesion);
    return this.db.withTenant(ctx, async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      const a = await leerAdjuntoBuzon(tx, clienteId, mensajeId, adjuntoId);
      if (a === null || a.omitido !== null || a.ruta === null || a.sha256 === null) throw new AccesoError("no_encontrado");
      if (!rutaDelCliente(a.ruta, ctx.tenantId, clienteId)) throw new AccesoError("no_encontrado");
      let bytes: Uint8Array;
      try {
        bytes = await leerVerificado(this.storage, a.ruta, a.sha256);
      } catch (e) {
        // El archivo ya no está: para quien pide es como si no hubiera adjunto. Uno alterado se propaga (500) sin entregar bytes.
        if (e instanceof ArchivoNoEncontradoError) throw new AccesoError("no_encontrado");
        throw e;
      }
      await auditarBuzon(tx, "buzon.adjunto_descargado", { clienteId, mensajeId, adjuntoId });
      return { nombre: sanearNombreAdjunto(a.nombre), mime: a.mime, bytes };
    });
  }

  private async leerTexto(ruta: string, tenantId: string, clienteId: string): Promise<string> {
    if (!rutaDelCliente(ruta, tenantId, clienteId)) throw new AccesoError("no_encontrado");
    try {
      return new TextDecoder("utf-8").decode(await this.storage.leer(ruta));
    } catch (e) {
      if (e instanceof ArchivoNoEncontradoError) throw new AccesoError("no_encontrado");
      throw e;
    }
  }
}
