import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  fijarObtencion,
  guardarDocumentoXml,
  leerClienteDto,
  leerDetalleXml,
  reevaluarComprobante,
  type Alcance,
  type ContappDb,
} from "@contapp/db";
import { compararIdentidad } from "@contapp/domain";
import type { DetalleLupa } from "@contapp/shared";
import { ArchivoNoEncontradoError, validarRuta, type StorageProvider } from "@contapp/storage";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { contextoDe } from "../clientes/contexto.js";
import { STORAGE } from "../storage/storage.module.js";
import { Encolador } from "../trabajos/encolador.js";
import { exigirCliente, idDe, periodoDe } from "./apoyo.js";
import { aplicaXml } from "./detalle.js";
import { DetalleComprasService } from "./detalle.service.js";
import { XmlError } from "./errores-xml.js";
import { aErrorHttp, evaluarPorPeriodo, exigir } from "./escritura.js";
import { bytesDeCuerpo, leerXml, rutaNueva, sha256De } from "./xml-entrada.js";

/** El XML guardado de un comprobante, listo para descargar. */
export interface XmlDescargable {
  /** `{ruc}-{tipo}-{serie}-{numero}.xml`, armado con la identidad del comprobante (nunca con un nombre del usuario). */
  nombre: string;
  bytes: Uint8Array;
}

/**
 * `true` si `ruta` cumple la gramática de storage y empieza por `xml/{tenant}/{cliente}/` (H-016-7). Toda lectura de storage del
 * backend pasa por aquí antes de `storage.leer`: la ruta sale de una fila y el CHECK de la BD solo valida su forma.
 */
export function rutaDelCliente(ruta: string, tenantId: string, clienteId: string): boolean {
  try {
    validarRuta(ruta);
  } catch {
    return false;
  }
  return ruta.startsWith(`xml/${tenantId.toLowerCase()}/${clienteId.toLowerCase()}/`);
}

/** Solo letras, dígitos, punto y guion en el nombre del adjunto: la identidad ya viene validada, esto es el cinturón. */
const nombreSeguro = (texto: string): string => texto.replace(/[^A-Za-z0-9._-]/g, "_");

/**
 * Descargar y pedir el XML de una compra (spec 016, D-7, D-8). Toda consulta va dentro de `withTenant`. El backend nunca llama a
 * SUNAT: `obtener` solo encola `xml.obtener` (sin credencial del cliente, P-7) y lo guarda el worker. Los errores salen como
 * códigos, sin ruta de storage, hash ni contenido (D-11).
 */
@Injectable()
export class XmlComprasService {
  private readonly log = new Logger(XmlComprasService.name);

  constructor(
    @Inject(DB) private readonly db: Pick<ContappDb, "withTenant">,
    @Inject(Encolador) private readonly encolador: Encolador,
    @Inject(STORAGE) private readonly storage: StorageProvider,
    @Inject(DetalleComprasService) private readonly detalle: DetalleComprasService,
  ) {}

  /**
   * HU-22: sube el XML del comprobante de una compra (cuerpo crudo, hasta 1 MiB). Se parsea con el parser del dominio ANTES de
   * tocar BD o storage; dentro de `withTenant` se comprueba la identidad (D-3: 422 `xml_ajeno` con los campos que difieren, sin
   * datos del XML) y P-6 (409 `xml_existente` con uno real o subido), se escribe el archivo, y en la MISMA transacción se inserta
   * `documento_xml` (que toma el advisory del comprobante) y se re-evalúan sin crear versión (D-5) todas las compras vivas del
   * comprobante, en cualquier periodo (H-016-11). Se permite en cualquier
   * estado del periodo (D-7). Responde con el detalle de la lupa ya completo.
   *
   * Coherencia storage/BD: el archivo se escribe primero y la fila después; si la transacción falla (o P-6 la rechaza dentro de la
   * carrera) se borra el archivo, y si el borrado falla queda un huérfano que ninguna fila referencia (no es visible para nadie y no
   * se loguea su ruta).
   */
  async subir(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
    compraCruda: string,
    cuerpo: unknown,
  ): Promise<DetalleLupa> {
    const periodo = periodoDe(periodoCrudo);
    const compraId = idDe(compraCruda).toLowerCase();
    const bytes = bytesDeCuerpo(cuerpo);
    const xml = leerXml(bytes);
    const ctx = contextoDe(sesion);
    const huella: { ruta: string | null; referenciado: boolean } = { ruta: null, referenciado: false };
    try {
      const respuesta = await this.db.withTenant(ctx, async (tx) => {
        await exigirCliente(tx, clienteId, alcance, true);
        const cliente = exigir(await leerClienteDto(tx, clienteId));
        const previo = exigir(await leerDetalleXml(tx, cliente.id, periodo, compraId));
        const identidad = compararIdentidad(xml, { rucCliente: cliente.ruc, compra: previo.compra });
        if (!identidad.ok) throw new XmlError("xml_ajeno", identidad.campos);
        // P-6 sin escribir nada; la decisión definitiva la toma `guardarDocumentoXml` bajo el advisory del comprobante.
        if (previo.xml !== null && previo.xml.origen !== "simulado") throw new XmlError("xml_existente");
        const ruta = rutaNueva(ctx.tenantId, cliente.id);
        await this.storage.guardar(ruta, bytes);
        huella.ruta = ruta;
        const guardado = await guardarDocumentoXml(tx, {
          ...previo.identidad,
          clienteId: cliente.id,
          origen: "subido",
          ruta,
          sha256: sha256De(bytes),
          tamano: bytes.length,
          detalle: xml,
          subidoPor: ctx.userId,
        });
        if (guardado === "existente_no_simulado") throw new XmlError("xml_existente");
        huella.referenciado = true;
        // H-016-11: el XML es del comprobante (D-4): se re-evalúan TODAS sus compras vivas del cliente, en cualquier periodo,
        // cada una con el entorno de su periodo. La de la URL tiene que seguir viva (si no, 404 y no queda nada).
        let reevaluadas;
        try {
          reevaluadas = await reevaluarComprobante(tx, cliente.id, previo.identidad, {
            evaluarDe: evaluarPorPeriodo(tx, cliente.id),
            bloqueo: "fila",
          });
        } catch (e) {
          throw aErrorHttp(e);
        }
        if (!reevaluadas.has(compraId)) throw new AccesoError("no_encontrado");
        return this.detalle.leer(tx, cliente.id, periodo, compraId);
      });
      return respuesta;
    } catch (e) {
      if (huella.ruta !== null) await this.limpiar(huella.ruta);
      throw e;
    }
  }

  /** Borra un archivo que ninguna fila referencia (mejor esfuerzo). Nunca lleva la ruta ni la causa al log (D-11). */
  private async limpiar(ruta: string): Promise<void> {
    try {
      await this.storage.eliminar(ruta);
    } catch {
      this.log.warn("No se pudo borrar un archivo de XML sin fila en la BD");
    }
  }

  /** Los bytes tal cual se guardaron. 404 igual que una compra inexistente si la compra no es de este alcance o no tiene XML. */
  async descargar(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
    compraCruda: string,
  ): Promise<XmlDescargable> {
    const periodo = periodoDe(periodoCrudo);
    const compraId = idDe(compraCruda);
    const ctx = contextoDe(sesion);
    const { identidad, ruta } = await this.db.withTenant(ctx, async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      const d = await leerDetalleXml(tx, clienteId, periodo, compraId);
      if (d === null || d.xml === null) throw new AccesoError("no_encontrado");
      return { identidad: d.identidad, ruta: d.xml.ruta };
    });
    // H-016-7: solo se lee una ruta del estudio de la sesión y del cliente de la URL. Otra (fila corrupta o manipulada) es como
    // no tener XML: 404 sin servir bytes ni llevar la ruta a la respuesta o al log.
    if (!rutaDelCliente(ruta, ctx.tenantId, clienteId)) throw new AccesoError("no_encontrado");
    let bytes: Uint8Array;
    try {
      bytes = await this.storage.leer(ruta);
    } catch (e) {
      // El archivo ya no está (borrado a mano o huérfano de otra instalación): para quien pide es como si no hubiera XML.
      if (e instanceof ArchivoNoEncontradoError) throw new AccesoError("no_encontrado");
      throw e;
    }
    const nombre = [identidad.rucEmisor, identidad.tipo, identidad.serie, identidad.numero].map(nombreSeguro).join("-");
    return { nombre: `${nombre}.xml`, bytes };
  }

  /**
   * HU-21: pone el comprobante en `pendiente` y encola `xml.obtener` interactivo (lote de 1) en la misma transacción. Idempotente
   * por el dedupe de 008: pulsarlo otra vez devuelve el mismo trabajo. 409 `xml_existente` si ya hay un XML que no es simulado
   * (el real puede reemplazar al simulado, P-6) y 409 `cliente_archivado`; se permite en cualquier estado del periodo (D-7).
   */
  async obtener(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
    compraCruda: string,
  ): Promise<{ trabajoId: string }> {
    const periodo = periodoDe(periodoCrudo);
    const compraId = idDe(compraCruda).toLowerCase();
    const ctx = contextoDe(sesion);
    const r = await this.encolador.encolarCon(
      { tenantId: ctx.tenantId, userId: ctx.userId },
      {
        tipo: "xml.obtener",
        clienteId,
        parametros: { periodo, compraIds: [compraId] },
        prioridad: "interactivo",
        creadoPor: ctx.userId,
      },
      async (tx) => {
        await exigirCliente(tx, clienteId, alcance, true);
        const d = await leerDetalleXml(tx, clienteId, periodo, compraId);
        if (d === null) throw new AccesoError("no_encontrado");
        if (d.xml !== null && d.xml.origen !== "simulado") throw new XmlError("xml_existente");
        // Fuera de 01/03/07/08 o con proveedor sin RUC no hay XML que pedir: encolar sería trabajo perdido.
        if (!aplicaXml(d.compra.tipoDoc, d.compra.docTipo)) throw new AccesoError("solicitud_invalida");
        await fijarObtencion(tx, clienteId, d.identidad, "pendiente");
      },
    );
    return { trabajoId: r.trabajo.id };
  }
}
