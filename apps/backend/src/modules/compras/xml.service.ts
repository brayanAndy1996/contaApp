import { Inject, Injectable } from "@nestjs/common";
import { fijarObtencion, leerDetalleXml, type Alcance, type ContappDb } from "@contapp/db";
import { ArchivoNoEncontradoError, type StorageProvider } from "@contapp/storage";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { contextoDe } from "../clientes/contexto.js";
import { STORAGE } from "../storage/storage.module.js";
import { Encolador } from "../trabajos/encolador.js";
import { exigirCliente, idDe, periodoDe } from "./apoyo.js";
import { aplicaXml } from "./detalle.js";
import { XmlError } from "./errores-xml.js";

/** El XML guardado de un comprobante, listo para descargar. */
export interface XmlDescargable {
  /** `{ruc}-{tipo}-{serie}-{numero}.xml`, armado con la identidad del comprobante (nunca con un nombre del usuario). */
  nombre: string;
  bytes: Uint8Array;
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
  constructor(
    @Inject(DB) private readonly db: Pick<ContappDb, "withTenant">,
    @Inject(Encolador) private readonly encolador: Encolador,
    @Inject(STORAGE) private readonly storage: StorageProvider,
  ) {}

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
    const { identidad, ruta } = await this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      const d = await leerDetalleXml(tx, clienteId, periodo, compraId);
      if (d === null || d.xml === null) throw new AccesoError("no_encontrado");
      return { identidad: d.identidad, ruta: d.xml.ruta };
    });
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
