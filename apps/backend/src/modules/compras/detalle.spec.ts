// Spec 016 (T13): el DTO de la lupa sin BD. La integración con HTTP la cubren detalle.int.spec.ts y xml.int.spec.ts.
import { describe, expect, it } from "vitest";
import type { DetalleXmlLeido } from "@contapp/db";
import type { DetalleXml } from "@contapp/domain";
import { detalleLupaSchema, type HallazgoVista } from "@contapp/shared";
import { aDetalleLupa, aplicaXml, comparar, estadoXml } from "./detalle.js";

const CERO = { biDg: "0.00", igvDg: "0.00", biDgng: "0.00", igvDgng: "0.00", biDng: "0.00", igvDng: "0.00", noGravado: "0.00", isc: "0.00", icbper: "0.00", otrosTributos: "0.00", total: "0.00" };
const DETALLE_XML: DetalleXml = {
  raiz: "Invoice",
  identidad: {
    tipo: "01",
    serie: "F001",
    numero: "2056",
    emisor: { ruc: "20700000045", razonSocial: "PROVEEDOR" },
    receptor: { tipoDoc: "6", numero: "20100070970" },
  },
  fecha: "2026-10-05",
  moneda: "PEN",
  monedaUnica: true,
  totales: { gravado: "8.97", igv: "1.61", noGravado: "12.51", isc: "0.00", icbper: "0.00", otros: "0.00", total: "23.09" },
  items: [
    { descripcion: "Gravado", cantidad: "1", unidad: "NIU", precioUnitario: "8.97", valor: "8.97", afectacion: "gravado", igv: "1.61", isc: "0.00", icbper: "0.00" },
    { descripcion: "Gratis", cantidad: "1", unidad: "NIU", precioUnitario: "0", valor: "0.00", afectacion: "gratuito", igv: "0.00", isc: "0.00", icbper: "0.00" },
  ],
};
const MIX: HallazgoVista = {
  regla: "R-MIX",
  destino: "DG",
  explicacion: "Explicación de R-MIX",
  sugerencia: null,
  requiereConfirmacion: true,
  dato: "gravado",
  masiva: false,
};

const leido = (o: { xml?: Partial<NonNullable<DetalleXmlLeido["xml"]>> | null; compra?: Partial<DetalleXmlLeido["compra"]>; obtencion?: DetalleXmlLeido["obtencion"] } = {}): DetalleXmlLeido => ({
  compra: {
    id: "0190a000-0000-7000-8000-0000000000a1",
    clienteId: "c",
    periodo: "202610",
    propuestaId: null,
    origen: "sire",
    clave: "k",
    tipoDoc: "01",
    serie: "F001",
    numero: "2056",
    docTipo: "6",
    docNumero: "20700000045",
    razonSocial: "PROVEEDOR",
    fecha: "2026-10-05",
    moneda: "PEN",
    tipoCambio: null,
    version: 1,
    excluida: false,
    motivo: null,
    clasificada: false,
    montos: { ...CERO, biDg: "21.48", igvDg: "1.61", total: "23.09" },
    ...o.compra,
  },
  proveedorNuevo: false,
  versiones: [],
  hallazgos: [],
  identidad: { rucEmisor: "20700000045", tipo: "01", serie: "F001", numero: "2056" },
  xml:
    o.xml === null
      ? null
      : {
          id: "0190a000-0000-7000-8000-0000000000b1",
          n: 1,
          origen: "subido",
          detalle: DETALLE_XML,
          ruta: "xml/TENANT-SECRETO/CLIENTE/ARCHIVO.xml",
          sha256: "ab".repeat(32),
          tamano: 100,
          subidoPor: "0190a000-0000-7000-8000-0000000000c1",
          creadaEn: new Date("2026-11-01T10:00:00Z"),
          ...o.xml,
        },
  obtencion: o.obtencion ?? null,
});

describe("aDetalleLupa", () => {
  it("caso feliz: cumple detalleLupaSchema y no deja salir la ruta de storage, el hash ni el tenant", () => {
    const dto = aDetalleLupa(leido(), []);
    expect(detalleLupaSchema.safeParse(dto).success).toBe(true);
    const texto = JSON.stringify(dto);
    for (const prohibido of ["TENANT-SECRETO", "ARCHIVO.xml", "ruta", "sha256", "abab", "tenant"]) expect(texto).not.toContain(prohibido);
    expect(Object.keys(dto.xml).sort()).toEqual(["estado", "origen", "subidoEn", "subidoPor"]);
  });

  it("aunque la lectura traiga claves de más, el esquema las descarta", () => {
    const dto = aDetalleLupa(leido(), []);
    const conBasura = { ...dto, tenantId: "t", xml: { ...dto.xml, ruta: "xml/t/c/a.xml", sha256: "ab" } };
    const r = detalleLupaSchema.parse(conBasura);
    expect(JSON.stringify(r)).not.toMatch(/tenantId|ruta|sha256/);
  });

  it("los ítems llevan el código de afectación del catálogo y, sin código claro, la palabra", () => {
    expect(aDetalleLupa(leido(), []).items.map((i) => i.afectacion)).toEqual(["10", "gratuito"]);
  });

  it("origenSerie: E, F o null", () => {
    const de = (serie: string) => aDetalleLupa(leido({ compra: { serie } }), []).cabecera.origenSerie;
    expect([de("E001"), de("f001"), de("B001")]).toEqual(["E", "F", null]);
  });
});

describe("comparar", () => {
  it("sin XML: 7 columnas en orden fijo, xml nulo y nada difiere", () => {
    const c = comparar({ ...CERO, biDg: "21.48" }, "PEN", null, []);
    expect(c.map((x) => x.columna)).toEqual(["bi", "igv", "noGravado", "isc", "icbper", "otrosTributos", "total"]);
    expect(c.every((x) => x.xml === null && !x.difiere)).toBe(true);
  });

  it("Σ BI suma las tres bases y la diferencia lleva la regla y la explicación del hallazgo que la cubre", () => {
    const c = comparar({ ...CERO, biDg: "10.00", biDgng: "11.48", igvDg: "1.61", total: "23.09" }, "PEN", DETALLE_XML, [MIX]);
    expect(c[0]).toEqual({ columna: "bi", sire: "21.48", xml: "8.97", difiere: true, regla: "R-MIX", explicacion: "Explicación de R-MIX" });
    expect(c[2]).toMatchObject({ columna: "noGravado", difiere: true, regla: "R-MIX" });
    expect(c[1]).toEqual({ columna: "igv", sire: "1.61", xml: "1.61", difiere: false });
  });

  it("una diferencia sin hallazgo que la cubra no lleva regla", () => {
    const c = comparar({ ...CERO, biDg: "21.48", igvDg: "1.61", total: "23.09" }, "PEN", DETALLE_XML, []);
    expect(c[0]).toEqual({ columna: "bi", sire: "21.48", xml: "8.97", difiere: true });
  });
});

describe("estadoXml", () => {
  it("sin XML: sin_solicitar, pendiente, no_disponible por resultado y no_aplica por la compra", () => {
    const ob = (estado: "pendiente" | "credencial") => ({ estado, intentos: 1, actualizadoEn: new Date() });
    expect(estadoXml(leido({ xml: null }))).toEqual({ estado: "sin_solicitar" });
    expect(estadoXml(leido({ xml: null, obtencion: ob("pendiente") }))).toEqual({ estado: "pendiente" });
    expect(estadoXml(leido({ xml: null, obtencion: ob("credencial") }))).toEqual({ estado: "no_disponible", codigo: "credencial" });
    expect(estadoXml(leido({ xml: null, compra: { tipoDoc: "14" } }))).toEqual({ estado: "no_disponible", codigo: "no_aplica" });
    expect(aplicaXml("01", "1")).toBe(false);
  });

  it("disponible simulado no dice quién lo subió; con otra moneda trae el aviso", () => {
    const s = estadoXml(leido({ xml: { origen: "simulado", subidoPor: null }, compra: { moneda: "USD", tipoCambio: "3.300" } }));
    expect(s).toEqual({ estado: "disponible", origen: "simulado", avisoMoneda: { monedaXml: "PEN", monedaFila: "USD" } });
  });
});
