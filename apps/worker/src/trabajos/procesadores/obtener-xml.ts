// Procesador de `xml.obtener` (spec 016, D-3, D-4, D-7, D-11, P-4, P-6, P-7; CA-6, CA-10, CA-11). Obtiene el XML de un lote de
// compras (de 1 a 100) de un cliente y periodo por el puerto `XmlProvider`, lo valida con el parser único del dominio y lo guarda.
//  (1) Parámetros revalidados con el catálogo ANTES de tocar nada: `ErrorDatos` (no se reintenta) que no repite lo recibido.
//  (2) Un `withTenant` corto de LECTURA: cada compra del lote (viva, del cliente y periodo) con su versión 1 y si ya tiene XML.
//      Lo que no es del cliente/periodo/estudio, está descartado, no admite XML o ya lo tiene se cuenta como `omitido`.
//  (3) Por compra, SIN transacción abierta (008 D6): `XmlProvider.obtener` con la `referencia` de la versión 1 (solo la usa el
//      mock) -> `leerUbl` -> `compararIdentidad` (emisor, tipo, serie, número y receptor = RUC del cliente) -> bytes a storage.
//  (4) Un `withTenant` por compra: `guardarDocumentoXml` y, si el XML entra en las reglas (P-4: el simulado solo con
//      `XML_SIMULADO_EN_REGLAS`), `reevaluarComprobante` (evaluación nueva, sin versión, de todas las compras vivas del
//      comprobante en cualquier periodo; H-016-11). Un XML rechazado no escribe nada.
// Resultado EXCLUYENTE por compra: guardado | omitido | noEncontrado (`ErrorDatos`, o XML inválido o ajeno) | credencial
// (`ErrorCredencial`: no invalida la credencial del cliente, el tipo no la usa) | transitorio. Si quedó algún transitorio, lo ya
// guardado se conserva y al final se lanza `ErrorTransitorio` para que 008 reintente el lote (lo guardado se omite).
// Nada del XML, de los montos, glosas, razones sociales ni rutas llega a logs, errores ni al `resultado` (solo conteos, D-11).
import { createHash, randomUUID } from "node:crypto";
import {
  fijarObtencion,
  guardarDocumentoXml,
  leerDetalleCompra,
  leerProveedoresConocidos,
  leerXmlVigente,
  reevaluarComprobante,
  type CompraLeida,
  type ContappDb,
  type EstadoObtencionXml,
  type IdentidadXml,
  type MontosCompra,
} from "@contapp/db";
import { Money, compararIdentidad, leerUbl } from "@contapp/domain";
import { XML_OBTENER } from "@contapp/queue";
import { rutaXml, type StorageProvider } from "@contapp/storage";
import {
  ErrorDatos,
  ErrorTransitorio,
  clasificarError,
  type ReferenciaXml,
  type XmlProvider,
} from "@contapp/sunat";
import type { Procesador } from "../ejecutor.js";
import { crearEvaluarCompras } from "../persistidores/compras-evaluar.js";

export interface DepsObtenerXml {
  db: Pick<ContappDb, "withTenant">;
  xmlProvider: XmlProvider;
  storage: StorageProvider;
  /** `XML_SIMULADO_EN_REGLAS` (P-4): si el XML simulado entra en las reglas. Apagada por defecto. */
  xmlSimuladoEnReglas?: boolean;
}

/** Los seis contadores excluyentes del `resultado` (suman el tamaño del lote). */
export interface ResultadoObtenerXml {
  guardados: number;
  omitidos: number;
  noEncontrados: number;
  credencial: number;
  transitorios: number;
  invalidos: number;
}

/** Tipos de comprobante con XML y proveedor con RUC: fuera de eso el XML no aplica. */
const TIPOS_CON_XML: readonly string[] = ["01", "03", "07", "08"];
const TIPO_DOC_RUC = "6";

/** Declaración `encoding="ISO-8859-1"` al inicio del texto (sin BOM, como exige el decodificador del dominio). */
const DECLARA_LATIN1 = /^<\?xml\s[^>]*?\bencoding\s*=\s*["']iso-8859-1["']/i;
const FUERA_DE_LATIN1 = /[^\u0000-ÿ]/;
const LARGO_DECLARACION = 512;

/**
 * El texto del proveedor -> los bytes con su codificación original (se guardan y se les saca el hash tal cual): ISO-8859-1 si
 * así lo declara, UTF-8 en los demás casos. Un texto que declara ISO-8859-1 pero trae caracteres fuera de él no se puede
 * representar sin perderlos: `null` (XML inválido).
 */
function aBytes(xml: unknown): Uint8Array | null {
  if (typeof xml !== "string") return null;
  if (DECLARA_LATIN1.test(xml.slice(0, LARGO_DECLARACION))) {
    return FUERA_DE_LATIN1.test(xml) ? null : Buffer.from(xml, "latin1");
  }
  return Buffer.from(xml, "utf8");
}

/** La fila del SIRE (versión 1) con la que el mock fabrica un XML coherente; `undefined` si no se puede armar. */
function referenciaDe(
  c: CompraLeida,
  original: MontosCompra,
  rucCliente: string,
): ReferenciaXml | undefined {
  try {
    const m = c.moneda;
    const d = (v: string): Money => Money.desde(v, m);
    return {
      fechaEmision: c.fecha,
      moneda: m,
      ...(c.tipoCambio === null ? {} : { tipoCambio: c.tipoCambio }),
      baseGravada: Money.suma([d(original.biDg), d(original.biDgng), d(original.biDng)], m).toString(),
      igv: Money.suma([d(original.igvDg), d(original.igvDgng), d(original.igvDng)], m).toString(),
      noGravado: d(original.noGravado).toString(),
      isc: d(original.isc).toString(),
      icbper: d(original.icbper).toString(),
      otros: d(original.otrosTributos).toString(),
      total: d(original.total).toString(),
      rucReceptor: rucCliente,
    };
  } catch {
    return undefined;
  }
}

interface Pendiente {
  compra: CompraLeida;
  original: MontosCompra;
}

const identidadDe = (c: CompraLeida): IdentidadXml => ({
  rucEmisor: c.docNumero,
  tipo: c.tipoDoc,
  serie: c.serie,
  numero: c.numero,
});

/** Para volver atrás la transacción de una compra que ya no se puede re-evaluar (descartada mientras tanto). */
class CompraYaNoAplica extends Error {}

export function obtenerXml(d: DepsObtenerXml): Procesador {
  const enReglas = d.xmlSimuladoEnReglas === true;
  return async ({ trabajo: t }) => {
    const p = XML_OBTENER.parametros.safeParse(t.parametros);
    if (!p.success) throw new ErrorDatos(); // sin repetir lo recibido
    const { periodo, compraIds } = p.data;
    const estudio = { tenantId: t.tenantId };

    const resultado: ResultadoObtenerXml = {
      guardados: 0,
      omitidos: 0,
      noEncontrados: 0,
      credencial: 0,
      transitorios: 0,
      invalidos: 0,
    };

    // (2) Lectura: lo que se pedirá al proveedor.
    const pendientes: Pendiente[] = [];
    await d.db.withTenant(estudio, async (tx) => {
      for (const id of compraIds) {
        const detalle = await leerDetalleCompra(tx, t.clienteId, periodo, id);
        const c = detalle?.compra;
        const original = detalle?.versiones[0]?.montos;
        if (
          c === undefined ||
          original === undefined ||
          c.docTipo !== TIPO_DOC_RUC ||
          !TIPOS_CON_XML.includes(c.tipoDoc) ||
          (await leerXmlVigente(tx, t.clienteId, identidadDe(c))) !== null
        ) {
          resultado.omitidos += 1;
          continue;
        }
        pendientes.push({ compra: c, original });
      }
    });

    const anotar = (c: CompraLeida, estado: EstadoObtencionXml): Promise<void> =>
      d.db.withTenant(estudio, (tx) =>
        fijarObtencion(tx, t.clienteId, identidadDe(c), estado),
      );

    // (3) y (4) Una compra a la vez.
    for (const { compra: c, original } of pendientes) {
      // El proveedor se llama SIN transacción abierta (008 D6).
      const referencia = referenciaDe(c, original, t.ruc);
      let respuesta;
      try {
        respuesta = await d.xmlProvider.obtener({
          rucEmisor: c.docNumero,
          tipo: c.tipoDoc,
          serie: c.serie,
          numero: c.numero,
          ...(referencia === undefined ? {} : { referencia }),
        });
      } catch (e) {
        // Solo la clase cuenta; el error (y su causa) se descarta aquí.
        const { clase } = clasificarError(e);
        if (clase === "credencial") {
          resultado.credencial += 1;
          await anotar(c, "credencial");
        } else if (clase === "datos" || clase === "portal") {
          resultado.noEncontrados += 1;
          await anotar(c, "no_encontrado");
        } else {
          resultado.transitorios += 1;
          await anotar(c, "transitorio");
        }
        continue;
      }

      // XML ilegible, hostil o ajeno: no se guarda nada (ni en storage ni en BD).
      const bytes = aBytes(respuesta.xml);
      let detalleXml;
      try {
        if (bytes === null) throw new Error();
        detalleXml = leerUbl(bytes);
      } catch {
        resultado.invalidos += 1;
        await anotar(c, "no_encontrado");
        continue;
      }
      const identidad = compararIdentidad(detalleXml, {
        rucCliente: t.ruc,
        compra: {
          docTipo: c.docTipo,
          docNumero: c.docNumero,
          tipoDoc: c.tipoDoc,
          serie: c.serie,
          numero: c.numero,
        },
      });
      if (!identidad.ok) {
        resultado.invalidos += 1;
        await anotar(c, "no_encontrado");
        continue;
      }

      // Storage primero (fuera de la transacción); si la BD no lo guarda, se borra el archivo.
      const ruta = rutaXml(t.tenantId, t.clienteId, randomUUID());
      await d.storage.guardar(ruta, bytes as Uint8Array);
      try {
        const guardado = await d.db.withTenant(estudio, async (tx) => {
          const r = await guardarDocumentoXml(tx, {
            clienteId: t.clienteId,
            ...identidadDe(c),
            origen: respuesta.origen,
            ruta,
            sha256: createHash("sha256")
              .update(bytes as Uint8Array)
              .digest(),
            tamano: (bytes as Uint8Array).length,
            detalle: detalleXml,
          });
          if (r === "existente_no_simulado") return false;
          if (respuesta.origen !== "simulado" || enReglas) {
            // H-016-11: el XML es del comprobante (D-4): se re-evalúan TODAS sus compras vivas del cliente, en cualquier
            // periodo, cada una con el historial de proveedores de su periodo. Sin UPDATE sobre compra (0038): bloquea con la
            // función acotada. Si la del lote ya no está viva, no se guarda nada (como antes).
            const evaluarDe = async (p: string) =>
              crearEvaluarCompras(await leerProveedoresConocidos(tx, t.clienteId, p), {
                xmlSimuladoEnReglas: enReglas,
              });
            const reevaluadas = await reevaluarComprobante(tx, t.clienteId, identidadDe(c), {
              evaluarDe,
              bloqueo: "funcion",
            });
            if (!reevaluadas.has(c.id)) throw new CompraYaNoAplica();
          }
          return true;
        });
        if (guardado) {
          resultado.guardados += 1;
        } else {
          // Otro proceso guardó antes un XML que no se reemplaza: el nuestro sobra.
          resultado.omitidos += 1;
          await d.storage.eliminar(ruta).catch(() => undefined);
        }
      } catch (e) {
        await d.storage.eliminar(ruta).catch(() => undefined);
        if (e instanceof CompraYaNoAplica) {
          resultado.omitidos += 1;
          continue;
        }
        throw e;
      }
    }

    // Lo guardado se conserva; el reintento de 008 omite lo que ya está y repite solo lo transitorio.
    if (resultado.transitorios > 0) throw new ErrorTransitorio();
    return resultado;
  };
}
