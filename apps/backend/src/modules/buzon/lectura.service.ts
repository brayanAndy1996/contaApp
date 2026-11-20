import { Inject, Injectable } from "@nestjs/common";
import {
  auditarBuzon,
  detalleAtencion,
  leerAdjuntoBuzon,
  leerMensajeBuzon,
  type Alcance,
  type ContappDb,
  type MensajeBuzonFila as MensajeFila,
} from "@contapp/db";
import { sanearNombreAdjunto } from "@contapp/domain";
import type { AdjuntoVista, DetalleMensaje, MensajeBuzonFila } from "@contapp/shared";
import { ArchivoNoEncontradoError, leerVerificado, type StorageProvider } from "@contapp/storage";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { contextoDe } from "../clientes/contexto.js";
import { STORAGE } from "../storage/storage.module.js";
import { exigirCliente, idDe, rutaDelCliente } from "./apoyo.js";
import { aAtencionDetalle, aEventos } from "./mapeo.js";

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

/**
 * Lectura del buzón (spec 023, D-8): detalle con el texto plano, la atención y su historial (024), y descarga de adjuntos. El alcance lo exige
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
      const atencion = await detalleAtencion(tx, mensajeId);
      if (atencion === null) throw new AccesoError("no_encontrado");
      const adjuntos: AdjuntoVista[] = m.adjuntos.map((a) => ({
        id: a.id,
        nombre: sanearNombreAdjunto(a.nombre),
        mime: a.mime,
        tamano: a.tamano ?? 0,
        omitido: a.omitido,
      }));
      return { mensaje: aFila(m), contenido, adjuntos, atencion: aAtencionDetalle(atencion), historial: aEventos(atencion) };
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
