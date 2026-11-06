// Ayudas de prueba de prevalidacion/ y formatos/ (spec 012, T4 y T5). Solo construyen entradas con
// la API pública de 010/011/012; no es producción. Las cifras de FIXTURE_* se copiaron a mano de
// fixtures/sire/20700000002-compras-202610.json (009); `fixture-012.spec.ts`, en sunat, comprueba
// que siguen siendo las del JSON real.
import type { CabeceraTxt, FilaReemplazo } from "../../src/index";
import type { MontosComprobante } from "../../src/index";
import { montosDe } from "./filas";
import type { Columnas } from "./filas";
import type { Moneda } from "../../src/index";

export { COMP, PROV, ctxBase, montosDe, xmlDe } from "./filas";
export type { Columnas } from "./filas";

/** Declarante del fixture (RUC sintético con dígito verificador válido) y periodo 2026-10. */
export const CABECERA: CabeceraTxt = {
  rucDeclarante: "20700000002",
  periodo: "202610",
  libro: "compras",
};

type Sobreescritura = Partial<Omit<FilaReemplazo, "montos">> & {
  moneda?: Moneda;
  montos?: MontosComprobante;
};

/**
 * Fila `original` PEN que cuadra (BI DG 100.00 + IGV DG 18.00 = 118.00), F001-123 del proveedor
 * 20100070970, emitida el 2026-10-05. `moneda: "USD"` pide además `tipoCambio`.
 */
export function filaReemplazo(
  columnas: Columnas = { biDg: "100.00", igvDg: "18.00" },
  over: Sobreescritura = {},
): FilaReemplazo {
  const { moneda = "PEN", montos, ...resto } = over;
  return {
    id: "f1",
    estado: "original",
    comprobante: { tipo: "01", serie: "F001", numero: "123" },
    proveedor: { tipo: "6", numero: "20100070970" },
    fechaEmision: "2026-10-05",
    montos: montos ?? montosDe(moneda, columnas),
    tipoCambio: null,
    origenUsd: null,
    ...resto,
  };
}

/** `n` filas válidas y distintas (F001-1 … F001-n), ids f0 … f{n-1}. */
export function filasValidas(n: number): FilaReemplazo[] {
  return Array.from({ length: n }, (_, i) =>
    filaReemplazo(undefined, {
      id: `f${i}`,
      comprobante: { tipo: "01", serie: "F001", numero: String(i + 1) },
    }),
  );
}

/** Texto latin1 de unos bytes (cada byte es un carácter). Sin `TextDecoder`. */
export function latin1(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/** Bytes latin1 de un texto cuyos caracteres son todos <= U+00FF. */
export function bytesLatin1(texto: string): number[] {
  return Array.from(texto, (c) => c.charCodeAt(0));
}

/** Líneas de un TXT con fin de línea CRLF también en la última (sin la cadena vacía final). */
export function lineasCrlf(bytes: Uint8Array): string[] {
  const t = latin1(bytes);
  if (!t.endsWith("\r\n")) throw new Error("el TXT no termina en CRLF");
  return t.slice(0, -2).split("\r\n");
}

// ---------------------------------------------------------------- fixture 009 (compras 202610)
const MONEDA_PEN = "PEN" as const;

/** F001-1040 · Cervecería San Juan: BI DG 770.00 con IGV 0.00 (R-ISC). */
export const filaSanJuan = (over: Sobreescritura = {}): FilaReemplazo =>
  filaReemplazo({ biDg: "770.00", igvDg: "0.00" }, {
    id: "F001-1040",
    comprobante: { tipo: "01", serie: "F001", numero: "1040" },
    proveedor: { tipo: "6", numero: "20700000011" },
    fechaEmision: "2026-10-02",
    ...over,
  });

/** F001-2056 · mixta: BI DG 21.48 con IGV DG 1.61, total 23.09 (R-MIX). */
export const filaMixta = (over: Sobreescritura = {}): FilaReemplazo =>
  filaReemplazo({ biDg: "21.48", igvDg: "1.61" }, {
    id: "F001-2056",
    comprobante: { tipo: "01", serie: "F001", numero: "2056" },
    proveedor: { tipo: "6", numero: "20700000045" },
    fechaEmision: "2026-10-05",
    ...over,
  });

/** F001-3064 · BI DG 100.00, IGV DG 18.00, ICBPER 1.50, total 119.50. */
export const filaIcbper = (over: Sobreescritura = {}): FilaReemplazo =>
  filaReemplazo({ biDg: "100.00", igvDg: "18.00", icbper: "1.50" }, {
    id: "F001-3064",
    comprobante: { tipo: "01", serie: "F001", numero: "3064" },
    proveedor: { tipo: "6", numero: "20700000053" },
    fechaEmision: "2026-10-08",
    ...over,
  });

/** F001-4062 · USD, TC 3.300: BI DG 0.15, IGV DG 0.03, total 0.18. */
export const filaUsd = (over: Sobreescritura = {}): FilaReemplazo =>
  filaReemplazo({ biDg: "0.15", igvDg: "0.03" }, {
    id: "F001-4062",
    comprobante: { tipo: "01", serie: "F001", numero: "4062" },
    proveedor: { tipo: "6", numero: "20700000061" },
    fechaEmision: "2026-10-12",
    moneda: "USD",
    tipoCambio: "3.300",
    ...over,
  });

/** F001-5070 · BI DG 150.00, IGV DG 27.00, total 177.00. */
export const filaSimple = (over: Sobreescritura = {}): FilaReemplazo =>
  filaReemplazo({ biDg: "150.00", igvDg: "27.00" }, {
    id: "F001-5070",
    comprobante: { tipo: "01", serie: "F001", numero: "5070" },
    proveedor: { tipo: "6", numero: "20700000070" },
    fechaEmision: "2026-10-14",
    ...over,
  });

/** La propuesta del fixture sin corregir, en el orden del JSON. */
export const filasFixture = (): FilaReemplazo[] => [
  filaSanJuan(),
  filaMixta(),
  filaIcbper(),
  filaUsd(),
  filaSimple(),
];

/** El fixture tras aplicar las sugerencias de 011: mixta 8.97 + 12.51 y San Juan con ISC 770.00. */
export const filasFixtureCorregidas = (): FilaReemplazo[] => [
  filaSanJuan({
    estado: "modificada",
    montos: montosDe(MONEDA_PEN, { isc: "770.00" }),
  }),
  filaMixta({
    estado: "modificada",
    montos: montosDe(MONEDA_PEN, { biDg: "8.97", igvDg: "1.61", noGravado: "12.51" }),
  }),
  filaIcbper(),
  filaUsd(),
  filaSimple(),
];
