// Ayudas de prueba de 012b (T1): filas de ventas y compras leídas, solo con la API pública. No es producción.
// Las cifras de la boleta 291 y de las series salen de fixtures/sire/20700000002-ventas-202610.json (copia en ventas.ts).
import { Money } from "../../src/index";
import type {
  CabeceraTxt,
  ColumnaVenta,
  CompraLeidaPlana,
  FilaReemplazoVenta,
  Moneda,
  VentaLeidaPlana,
} from "../../src/index";
import { FIXTURE_VENTAS_202610 } from "./ventas";

export const CABECERA_VENTAS: CabeceraTxt = { rucDeclarante: "20700000002", periodo: "202610", libro: "ventas" };

type Parcial = Partial<Record<Exclude<ColumnaVenta, "total">, string>> & { total?: string };

/** Montos de una venta: `total` = Σ de las siete columnas salvo que se dé (así se arma una descuadrada). */
export function montosVenta(moneda: Moneda, m: Parcial = { baseGravada: "100.00", igv: "18.00" }): Record<ColumnaVenta, Money> {
  const v = (x: string | undefined): Money => Money.desde(x ?? "0.00", moneda);
  const comp = {
    baseGravada: v(m.baseGravada),
    igv: v(m.igv),
    exonerada: v(m.exonerada),
    inafecta: v(m.inafecta),
    isc: v(m.isc),
    icbper: v(m.icbper),
    otros: v(m.otros),
  };
  const total = m.total === undefined ? Money.suma(Object.values(comp), moneda) : v(m.total);
  return { ...comp, total };
}

type Sobre = Partial<Omit<FilaReemplazoVenta, "montos">> & { moneda?: Moneda; montos?: Parcial };

/** Boleta B001-290 de 100.00 + IGV 18.00 = 118.00 al consumidor final (sin tipo de documento, «-»). */
export function filaVenta(over: Sobre = {}): FilaReemplazoVenta {
  const { moneda = "PEN", montos, ...resto } = over;
  return {
    id: "03-B001-290",
    estado: "original",
    comprobante: { tipo: "03", serie: "B001", numero: "290" },
    contraparte: { numero: "-" },
    fechaEmision: "2026-10-03",
    montos: montosVenta(moneda, montos),
    tipoCambio: null,
    ...resto,
  };
}

/** Venta con id y número propios (`tipo`, `serie` y `numero` del comprobante; el id sale de ellos). */
export function ventaNum(tipo: string, serie: string, numero: string, over: Sobre = {}): FilaReemplazoVenta {
  return filaVenta({ id: `${tipo}-${serie}-${numero}`, comprobante: { tipo, serie, numero }, ...over });
}

/** Las 11 filas del fixture de ventas como `FilaReemplazoVenta` originales; fecha y contraparte genéricas. */
export function filasFixtureVentas(): FilaReemplazoVenta[] {
  return FIXTURE_VENTAS_202610.map((f) =>
    ventaNum(f.tipo, f.serie, f.numero, {
      moneda: f.moneda,
      tipoCambio: f.tipoCambio,
      montos: {
        baseGravada: f.baseGravada,
        igv: f.igv,
        exonerada: f.exonerada,
        inafecta: f.inafecta,
        isc: f.isc,
        icbper: f.icbper,
        otros: f.otros,
        total: f.total,
      },
    }),
  );
}

export const comoExcluida = (f: FilaReemplazoVenta): FilaReemplazoVenta => ({ ...f, estado: "excluida" });

/** Venta tal como la entrega `packages/db` (cadenas), cuadrada y del SIRE. */
export function ventaLeida(over: Partial<VentaLeidaPlana> = {}): VentaLeidaPlana {
  return {
    id: "v1",
    origen: "sire",
    tipo: "03",
    serie: "B001",
    numero: "290",
    fecha: "2026-10-03",
    tipoDocContraparte: "",
    docContraparte: "-",
    moneda: "PEN",
    tipoCambio: null,
    baseGravada: "100.00",
    igv: "18.00",
    exonerada: "0.00",
    inafecta: "0.00",
    isc: "0.00",
    icbper: "0.00",
    otros: "0.00",
    total: "118.00",
    excluida: false,
    ...over,
  };
}

/** Compra tal como la entrega `packages/db` (cadenas), F001-123 de 100.00 + IGV 18.00, versión 1 del SIRE. */
export function compraLeida(over: Partial<CompraLeidaPlana> = {}): CompraLeidaPlana {
  return {
    id: "c1",
    origen: "sire",
    tipoDoc: "01",
    serie: "F001",
    numero: "123",
    docTipo: "6",
    docNumero: "20100070970",
    razonSocial: "PROVEEDOR DE PRUEBA SAC",
    fecha: "2026-10-05",
    moneda: "PEN",
    tipoCambio: null,
    version: 1,
    excluida: false,
    montos: {
      biDg: "100.00",
      igvDg: "18.00",
      biDgng: "0.00",
      igvDgng: "0.00",
      biDng: "0.00",
      igvDng: "0.00",
      noGravado: "0.00",
      isc: "0.00",
      icbper: "0.00",
      otrosTributos: "0.00",
      total: "118.00",
    },
    ...over,
  };
}

/** Texto sin sustitutos sueltos. */
export const bienFormado = (s: string): boolean => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
