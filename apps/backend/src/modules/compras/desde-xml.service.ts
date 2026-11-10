import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  ComprasReglaError,
  guardarDocumentoXml,
  leerClienteDto,
  listarCompras,
  reevaluarComprobante,
  type Alcance,
  type ContappDb,
  type Tx,
} from "@contapp/db";
import { claveComprobante, compararIdentidad, type DetalleXml } from "@contapp/domain";
import {
  agregarCompraSchema,
  destinoDesdeXmlSchema,
  vistaPreviaDesdeXmlSchema,
  type FilaCompraVista,
  type VistaPreviaDesdeXml,
} from "@contapp/shared";
import type { StorageProvider } from "@contapp/storage";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { contextoDe } from "../clientes/contexto.js";
import { STORAGE } from "../storage/storage.module.js";
import { periodoDe, exigirCliente } from "./apoyo.js";
import { altaCompra, montosDeAgregada, respuestaDe } from "./acciones.service.js";
import { aItems } from "./detalle.js";
import { datosDeXml, montosParaDestino, type DatosDesdeXml } from "./desde-xml.js";
import { XmlError } from "./errores-xml.js";
import { aErrorHttp, entornoDeReglas, evaluarPorPeriodo, exigir, exigirEscritura } from "./escritura.js";
import { bytesDeCuerpo, leerXml, rutaNueva, sha256De } from "./xml-entrada.js";

/** Páginas del listado que se recorren al buscar la compra existente (el tope por página de 014). */
const PAGINA = 5000;

/** El receptor del XML debe ser el cliente (D-3). Lo demás de la identidad es del propio XML: no hay compra con la que compararlo. */
function exigirReceptor(xml: DetalleXml, rucCliente: string): void {
  const r = compararIdentidad(xml, {
    rucCliente,
    compra: {
      docTipo: "6",
      docNumero: xml.identidad.emisor.ruc,
      tipoDoc: xml.identidad.tipo,
      serie: xml.identidad.serie,
      numero: xml.identidad.numero,
    },
  });
  if (!r.ok) throw new XmlError("xml_ajeno", r.campos);
}

/**
 * La compra viva (excluida o no) del periodo con esa clave, o `null`. Se busca entre las del mismo proveedor (prefijo de RUC) y se
 * compara la clave exacta: así vale aunque el número esté guardado con ceros a la izquierda.
 */
async function buscarExistente(tx: Tx, clienteId: string, periodo: string, d: DatosDesdeXml): Promise<string | null> {
  const clave = claveComprobante({ tipo: d.tipo, serie: d.serie, numero: d.numero }, d.proveedor);
  for (const vista of [undefined, "excluidas"] as const) {
    let cursor: Awaited<ReturnType<typeof listarCompras>>["siguiente"] = null;
    do {
      const pagina = await listarCompras(tx, clienteId, periodo, {
        limite: PAGINA,
        q: d.proveedor.numero,
        ...(vista === undefined ? {} : { vista }),
        ...(cursor === null ? {} : { cursor }),
      });
      const hallada = pagina.filas.find((f) => f.compra.clave === clave);
      if (hallada !== undefined) return hallada.compra.id;
      cursor = pagina.siguiente;
    } while (cursor !== null);
  }
  return null;
}

/**
 * Agregar una compra desde un XML (spec 016, HU-18, D-8, P-9). `vistaPrevia` parsea y devuelve los campos sin escribir nada ni
 * tocar el storage; `agregar` crea la compra con `agregarCompra` de 014 y guarda el XML (`origen = subido`) en una sola
 * transacción (409 `xml_existente` si el comprobante ya tiene un XML real o subido, P-6) y re-evalúa las demás compras del
 * comprobante. El destino y, en USD, el tipo de cambio los pone el usuario en la query: nunca salen del XML.
 */
@Injectable()
export class DesdeXmlComprasService {
  private readonly log = new Logger(DesdeXmlComprasService.name);

  constructor(
    @Inject(DB) private readonly db: Pick<ContappDb, "withTenant">,
    @Inject(STORAGE) private readonly storage: StorageProvider,
  ) {}

  /** No escribe nada y no mira el estado del periodo (solo lee). Los montos van con la BI y el IGV en DG, como pre-llenado. */
  async vistaPrevia(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    periodoCrudo: string,
    cuerpo: unknown,
  ): Promise<VistaPreviaDesdeXml> {
    const periodo = periodoDe(periodoCrudo);
    const xml = leerXml(bytesDeCuerpo(cuerpo));
    const datos = datosDeXml(xml);
    const existente = await this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      const cliente = exigir(await leerClienteDto(tx, clienteId));
      exigirReceptor(xml, cliente.ruc);
      return buscarExistente(tx, cliente.id, periodo, datos);
    });
    const v = vistaPreviaDesdeXmlSchema.safeParse({
      tipo: datos.tipo,
      serie: datos.serie,
      numero: datos.numero,
      proveedor: datos.proveedor,
      fecha: datos.fecha,
      moneda: datos.moneda,
      montos: montosParaDestino(datos, "DG"),
      items: aItems(xml),
      existente: existente === null ? null : { id: existente },
      requiereTipoCambio: datos.moneda === "USD",
    });
    // Un comprobante cuyos datos no caben en una compra (p. ej. un número de más de 8 dígitos) no sirve para agregar.
    if (!v.success) throw new XmlError("xml_invalido");
    return v.data;
  }

  async agregar(
    sesion: SesionResuelta,
    alcance: Alcance,
    permisos: ReadonlySet<string>,
    clienteId: string,
    periodoCrudo: string,
    query: unknown,
    cuerpo: unknown,
  ): Promise<FilaCompraVista> {
    const periodo = periodoDe(periodoCrudo);
    // Destino y tipo de cambio de la query: 400 antes de mirar el XML. Un `tenantId` o `clienteId` de la query se descarta.
    const q = destinoDesdeXmlSchema.safeParse(query);
    if (!q.success) throw new AccesoError("solicitud_invalida");
    const bytes = bytesDeCuerpo(cuerpo);
    const xml = leerXml(bytes);
    const datos = datosDeXml(xml);
    // P-9: USD exige el tipo de cambio y PEN lo prohíbe; las reglas son las de `agregarCompraSchema`, las mismas de agregar a mano.
    const v = agregarCompraSchema.safeParse({
      tipo: datos.tipo,
      serie: datos.serie,
      numero: datos.numero,
      proveedor: datos.proveedor,
      fecha: datos.fecha,
      moneda: datos.moneda,
      tipoCambio: q.data.tipoCambio,
      montos: montosParaDestino(datos, q.data.destino),
    });
    if (!v.success) {
      if (v.error.issues.some((i) => i.path[0] !== "tipoCambio")) throw new XmlError("xml_invalido");
      throw new AccesoError("solicitud_invalida");
    }
    const compra = v.data;
    const montos = montosDeAgregada(compra);
    const ctx = contextoDe(sesion);
    const huella: { ruta: string | null } = { ruta: null };
    try {
      const fila = await this.db.withTenant(ctx, async (tx) => {
        // Sin bloqueos: cliente (404 / archivado) y estado del periodo (403 / 409) antes de escribir el archivo.
        await exigirEscritura(tx, alcance, permisos, clienteId, periodo, { crear: false, archivado: true });
        const cliente = exigir(await leerClienteDto(tx, clienteId));
        exigirReceptor(xml, cliente.ruc);
        const ruta = rutaNueva(ctx.tenantId, cliente.id);
        await this.storage.guardar(ruta, bytes);
        huella.ruta = ruta;
        // Orden de bloqueo del plan: el advisory del comprobante (lo toma guardar) antes que `compra_periodo`.
        const guardado = await guardarDocumentoXml(tx, {
          clienteId: cliente.id,
          rucEmisor: datos.proveedor.numero,
          tipo: datos.tipo,
          serie: datos.serie,
          numero: datos.numero,
          origen: "subido",
          ruta,
          sha256: sha256De(bytes),
          tamano: bytes.length,
          detalle: xml,
          subidoPor: ctx.userId,
        });
        // H-016-12 (P-6): con un XML real o subido ya guardado para el comprobante no se crea la compra (sus montos saldrían de
        // un XML que no es el vigente): 409 `xml_existente`, se revierte todo y se borra el archivo nuevo. Si la compra ya existe
        // en este periodo, manda el 409 `duplicado` de CA-13 (con su id), como sin XML.
        if (guardado === "existente_no_simulado") {
          const existente = await buscarExistente(tx, cliente.id, periodo, datos);
          if (existente !== null) throw aErrorHttp(new ComprasReglaError("duplicado", { ids: [existente] }));
          throw new XmlError("xml_existente");
        }
        await exigirEscritura(tx, alcance, permisos, clienteId, periodo, { crear: true, archivado: true });
        const entorno = await entornoDeReglas(tx, cliente.id, periodo);
        const id = await altaCompra(tx, ctx.userId, cliente.id, periodo, compra, montos, entorno);
        // H-016-11: el XML nuevo es el vigente del comprobante (D-4): se re-evalúan las demás compras vivas del mismo comprobante,
        // en cualquier periodo (la nueva ya se evaluó con él al crearse).
        await reevaluarComprobante(
          tx,
          cliente.id,
          { rucEmisor: datos.proveedor.numero, tipo: datos.tipo, serie: datos.serie, numero: datos.numero },
          { evaluarDe: evaluarPorPeriodo(tx, cliente.id), bloqueo: "fila", excluir: [id] },
        );
        return (await respuestaDe(tx, cliente.id, periodo, id)).fila;
      });
      return fila;
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
}
