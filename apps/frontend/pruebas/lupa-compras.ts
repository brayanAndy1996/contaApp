import { detalleLupaSchema, type DetalleLupa, type FilaCompraVista } from "@contapp/shared";
import { BASE, uuidDe } from "./compras";

// Soporte de las pruebas de la lupa (spec 016, T15): el `DetalleLupa` de una compra de 015 (cabecera, ítems del XML,
// comparación, hallazgos, historial del proveedor y estado del XML) y las rutas de 016. Solo datos de prueba. Cada
// detalle se valida con `detalleLupaSchema`: si el contrato de `shared` cambia, las pruebas fallan aquí.

export const rutaDetalle = (id: string) => `GET ${BASE}/${id}/detalle`;
export const rutaObtenerXml = (id: string) => `POST ${BASE}/${id}/xml/obtener`;
export const rutaDescargarXml = (id: string) => `GET ${BASE}/${id}/xml`;

/** Glosa hostil dentro de un XML: debe verse como texto (CA-17). */
export const GLOSA_HOSTIL = "<script>alert(1)</script> Bolsa";

export function detalleLupaDe(
  fila: FilaCompraVista,
  parcial: Partial<DetalleLupa> = {},
): DetalleLupa {
  const m = fila.montos;
  return detalleLupaSchema.parse({
    cabecera: {
      ruc: fila.proveedor.numero,
      razonSocial: fila.proveedor.razonSocial,
      proveedorNuevo: fila.proveedorNuevo,
      tipo: fila.tipo,
      serie: fila.serie,
      numero: fila.numero,
      fecha: fila.fecha,
      moneda: fila.moneda,
      tipoCambio: fila.tipoCambio,
      origenSerie: "E",
    },
    items: [
      {
        descripcion: "Servicio de consultoría",
        cantidad: "1.0000000000",
        unidad: "ZZ",
        precioUnitario: "100.0000000000",
        valor: m.biDg,
        afectacion: "10",
        igv: m.igvDg,
        isc: "0.00",
        icbper: "0.00",
      },
      {
        descripcion: "Libros",
        cantidad: "2",
        unidad: "NIU",
        precioUnitario: "6.255",
        valor: "12.51",
        afectacion: "20",
        igv: "0.00",
        isc: "0.00",
        icbper: "0.00",
      },
    ],
    comparacion: [
      { columna: "bi", sire: m.biDg, xml: m.biDg, difiere: false },
      { columna: "igv", sire: m.igvDg, xml: m.igvDg, difiere: false },
      { columna: "noGravado", sire: m.noGravado, xml: m.noGravado, difiere: false },
      { columna: "isc", sire: m.isc, xml: m.isc, difiere: false },
      { columna: "icbper", sire: m.icbper, xml: m.icbper, difiere: false },
      { columna: "otrosTributos", sire: m.otrosTributos, xml: m.otrosTributos, difiere: false },
      { columna: "total", sire: m.total, xml: m.total, difiere: false },
    ],
    hallazgos: fila.hallazgos,
    historialProveedor: [
      {
        periodo: "202609",
        serie: "F001",
        numero: "900",
        biDg: "50.00",
        biDgng: "0.00",
        biDng: "0.00",
        excluida: false,
      },
    ],
    xml: { estado: "disponible", origen: "real" },
    ...parcial,
  });
}

/** F001-2056: SIRE 21.48 / 1.61 frente al XML 8.97 gravado + 12.51 no gravado (R-MIX). */
export function detalleMixto(fila: FilaCompraVista): DetalleLupa {
  const base = detalleLupaDe(fila);
  return detalleLupaDe(fila, {
    comparacion: base.comparacion.map((c) =>
      c.columna === "bi"
        ? { ...c, xml: "8.97", difiere: true, regla: "R-MIX" as const, explicacion: fila.hallazgos[0]?.explicacion }
        : c.columna === "noGravado"
          ? { ...c, xml: "12.51", difiere: true, regla: "R-MIX" as const, explicacion: fila.hallazgos[0]?.explicacion }
          : c,
    ),
  });
}

/** Detalle de una compra sin XML (nada que comparar). */
export function detalleSinXml(
  fila: FilaCompraVista,
  xml: DetalleLupa["xml"],
): DetalleLupa {
  const base = detalleLupaDe(fila);
  return detalleLupaDe(fila, {
    items: [],
    comparacion: base.comparacion.map((c) => ({ ...c, xml: null, difiere: false })),
    xml,
  });
}

export const AUTOR_XML = uuidDe(5, 1);
