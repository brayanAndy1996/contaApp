// Unitarias del persistidor de compras (spec 014, T8; rojo hasta T13): normalización de lo recibido, clave, filas
// ilegibles sin eco y registro. Sin BD; la inserción, la descarga repetida y las reglas las cubre
// `persistidor-compras.int.spec.ts` con Postgres real.
//
// CONTRATO que fija (plan 014: «Contrato real de 013» puntos 4 y 7, «Clave», «campos comparables»), en
// `apps/worker/src/trabajos/persistidores/compras.ts`:
//   - `persistidorCompras: PersistidorLibro<CompraNueva>` (el tipo `CompraNueva` es de `packages/db`, T12), registrado en
//     `PERSISTIDORES.compras` con una línea en `index.ts`; el de ventas sigue registrado y compras no importa nada de ventas.
//   - `preparar(filas)` recibe `FilaPropuestaSire` (cadenas) y devuelve `FilaPreparada` por fila, en el mismo orden:
//       clave  = `tipo|SERIE|numero|tipoDoc|DOC` (`claveComprobante`: serie y DOC en mayúsculas ASCII, número sin ceros a la
//                izquierda; `tipoDoc` ausente = «6»); ninguna parte lleva `|`;
//       tipo/serie/numero = las del comprobante (serie en mayúsculas);
//       campos = cadenas con la escala de la columna: `fecha`, `moneda`, `tipoCambio`, el documento del proveedor, las 10
//                columnas de montos y `total` (montos con 2 decimales, tipo de cambio con 3); nunca la razón social.
//   - Una fila ilegible lanza `ErrorPropuesta("fila_invalida")` sin ningún contenido en el error: monto no numérico, con más
//     de 2 decimales o fuera de NUMERIC(14,2); moneda desconocida; tipo de cambio inválido; identidad inválida (tipo,
//     serie, número, documento, fecha) o con `|` en alguna de las partes de la clave.
//   - Una fila legible pero descuadrada (IGV 1.61 sobre 21.48) NO se rechaza: se guarda tal cual llegó (D-3).
//   - Una clave repetida dentro de la misma descarga NO es error de `preparar` (DU-17): decide después el procesador.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MockSireApiClient, type FilaPropuestaSire } from "@contapp/sunat";
import { describe, expect, it } from "vitest";
import { persistidorCompras } from "./compras.js";
import { ErrorPropuesta } from "./errores.js";
import { PERSISTIDORES } from "./index.js";
import { persistidorVentas } from "./ventas.js";

const fila = (extra: Partial<FilaPropuestaSire> = {}): FilaPropuestaSire => ({
  tipo: "01",
  serie: "F001",
  numero: "123",
  rucContraparte: "20100070970",
  razonSocialContraparte: "PROVEEDOR SINTETICO S.A.C.",
  fechaEmision: "2026-10-05",
  moneda: "PEN",
  biDg: "100.00",
  igvDg: "18.00",
  biDgng: "0.00",
  igvDgng: "0.00",
  biDng: "0.00",
  igvDng: "0.00",
  noGravado: "0.00",
  isc: "0.00",
  icbper: "0.00",
  otros: "0.00",
  total: "118.00",
  ...extra,
});

async function fixture(): Promise<FilaPropuestaSire[]> {
  const p = await new MockSireApiClient().descargarPropuesta(
    { token: "t", expiraEn: new Date(0) },
    { ruc: "20700000002", periodo: "202610", libro: "compras" },
  );
  if (p.libro !== "compras") throw new Error("se esperaba compras");
  return p.filas;
}

function falla(filas: unknown[]): unknown {
  try {
    persistidorCompras.preparar(filas);
  } catch (x) {
    return x;
  }
  return undefined;
}

describe("persistidorCompras.preparar: clave y comprobante", () => {
  it("el fixture de 009 (5 filas): clave `tipo|SERIE|numero|tipoDoc|DOC`, en el mismo orden", async () => {
    const r = persistidorCompras.preparar(await fixture());
    expect(r.map((f) => f.clave)).toEqual([
      "01|F001|1040|6|20700000011",
      "01|F001|2056|6|20700000045",
      "01|F001|3064|6|20700000053",
      "01|F001|4062|6|20700000061",
      "01|F001|5070|6|20700000070",
    ]);
    expect(r.map((f) => [f.tipo, f.serie, f.numero])).toEqual([
      ["01", "F001", "1040"],
      ["01", "F001", "2056"],
      ["01", "F001", "3064"],
      ["01", "F001", "4062"],
      ["01", "F001", "5070"],
    ]);
  });

  it("serie en minúsculas y ceros a la izquierda: la clave los normaliza y la serie sale en mayúsculas", () => {
    const [f] = persistidorCompras.preparar([
      fila({ serie: "f001", numero: "000123" }),
    ]);
    expect(f!.clave).toBe("01|F001|123|6|20100070970");
    expect(f!.serie).toBe("F001");
  });

  it("documento del proveedor: tipoDocContraparte ausente es «6» y el número va en mayúsculas ASCII", () => {
    const [ruc] = persistidorCompras.preparar([fila()]);
    const [otro] = persistidorCompras.preparar([
      fila({ tipoDocContraparte: "4", rucContraparte: "ab123456" }),
    ]);
    expect(ruc!.clave).toBe("01|F001|123|6|20100070970");
    expect(otro!.clave).toBe("01|F001|123|4|AB123456");
  });

  it("el tipo de comprobante y el documento del proveedor distinguen la clave (misma serie y número)", () => {
    const claves = persistidorCompras
      .preparar([
        fila(),
        fila({ tipo: "03" }),
        fila({ rucContraparte: "20100070971" }),
        fila({ tipoDocContraparte: "1", rucContraparte: "12345678" }),
      ])
      .map((f) => f.clave);
    expect(new Set(claves).size).toBe(4);
  });

  it("devuelve una fila por cada cruda y no rechaza una clave repetida (DU-17: decide el procesador)", () => {
    const r = persistidorCompras.preparar([
      fila(),
      fila({ numero: "00123" }),
      fila({ numero: "124" }),
    ]);
    expect(r).toHaveLength(3);
    expect(r[0]!.clave).toBe(r[1]!.clave);
    expect(r[2]!.clave).not.toBe(r[0]!.clave);
  });

  it("sin filas devuelve una lista vacía", () => {
    expect(persistidorCompras.preparar([])).toEqual([]);
  });
});

describe("persistidorCompras.preparar: campos comparables (cadenas con la escala de la columna)", () => {
  it("San Juan (F001-1040): BI 770.00 con IGV 0.00, tal como llegó", async () => {
    const [f] = persistidorCompras.preparar([(await fixture())[0]!]);
    expect(f!.campos).toMatchObject({
      fecha: "2026-10-02",
      moneda: "PEN",
      biDg: "770.00",
      igvDg: "0.00",
      isc: "0.00",
      total: "770.00",
    });
  });

  it("mixta 21.48 / 1.61 (F001-2056) legible pero descuadrada: se acepta y no se corrige", async () => {
    const [f] = persistidorCompras.preparar([(await fixture())[1]!]);
    expect(f!.campos).toMatchObject({
      biDg: "21.48",
      igvDg: "1.61",
      total: "23.09",
    });
  });

  it("redondeo USD (F001-4062): 0.15 + 0.03 = 0.18 con tipo de cambio 3.300", async () => {
    const [f] = persistidorCompras.preparar([(await fixture())[3]!]);
    expect(f!.campos).toMatchObject({
      moneda: "USD",
      tipoCambio: "3.300",
      biDg: "0.15",
      igvDg: "0.03",
      total: "0.18",
    });
  });

  it("los montos se normalizan a 2 decimales (100 -> 100.00, 18.0 -> 18.00, -50.5 -> -50.50) y admiten negativos", () => {
    const [f] = persistidorCompras.preparar([
      fila({
        biDg: "100",
        igvDg: "18.0",
        icbper: "0",
        total: "-50.5",
        isc: "-0.5",
      }),
    ]);
    expect(f!.campos).toMatchObject({
      biDg: "100.00",
      igvDg: "18.00",
      icbper: "0.00",
      isc: "-0.50",
      total: "-50.50",
    });
  });

  it("el límite de NUMERIC(14,2) cabe: 999999999999.99 y su negativo", () => {
    const [f] = persistidorCompras.preparar([
      fila({ biDg: "999999999999.99", total: "-999999999999.99" }),
    ]);
    expect(f!.campos).toMatchObject({
      biDg: "999999999999.99",
      total: "-999999999999.99",
    });
  });

  it("tipo de cambio USD: «3.3» queda «3.300» y «3.456» no cambia", () => {
    const [a, b] = persistidorCompras.preparar([
      fila({ moneda: "USD", tipoCambio: "3.3" }),
      fila({ moneda: "USD", tipoCambio: "3.456", numero: "124" }),
    ]);
    expect(a!.campos.tipoCambio).toBe("3.300");
    expect(b!.campos.tipoCambio).toBe("3.456");
  });

  it("cada columna de monto está en `campos` (la décima se llama `otros` en la propuesta o `otrosTributos` en la tabla)", () => {
    const [f] = persistidorCompras.preparar([fila({ otros: "2.5" })]);
    expect(Object.keys(f!.campos)).toEqual(
      expect.arrayContaining([
        "fecha",
        "moneda",
        "tipoCambio",
        "biDg",
        "igvDg",
        "biDgng",
        "igvDgng",
        "biDng",
        "igvDng",
        "noGravado",
        "isc",
        "icbper",
        "total",
      ]),
    );
    expect(f!.campos.otros ?? f!.campos.otrosTributos).toBe("2.50");
  });

  it("el documento del proveedor entra en `campos` y la razón social no", () => {
    const [f] = persistidorCompras.preparar([
      fila({ razonSocialContraparte: "RAZON SOCIAL UNICA XYZ" }),
    ]);
    expect(Object.values(f!.campos)).toContain("20100070970");
    expect(JSON.stringify(f!.campos)).not.toContain("RAZON SOCIAL UNICA XYZ");
    expect(Object.keys(f!.campos).join(",")).not.toMatch(/raz[oó]n/i);
  });

  it("todo `campos` son cadenas (ningún monto pasa por number)", async () => {
    for (const f of persistidorCompras.preparar(await fixture()))
      for (const v of Object.values(f.campos)) expect(typeof v).toBe("string");
  });

  it("la misma fila preparada dos veces da lo mismo (determinista)", async () => {
    const filas = await fixture();
    expect(persistidorCompras.preparar(filas)).toEqual(
      persistidorCompras.preparar(filas),
    );
  });
});

describe("persistidorCompras.preparar: una fila ilegible lanza fila_invalida", () => {
  const ILEGIBLES: Array<[string, Partial<FilaPropuestaSire>]> = [
    ["monto no numérico", { total: "abc" }],
    ["monto vacío", { igvDg: "" }],
    ["monto en notación científica", { biDg: "1e3" }],
    ["monto con tres decimales", { igvDg: "18.001" }],
    ["monto fuera de NUMERIC(14,2)", { total: "1000000000000.00" }],
    ["monto negativo fuera de NUMERIC(14,2)", { biDg: "-1000000000000.00" }],
    ["moneda desconocida", { moneda: "EUR" as never }],
    ["tipo de cambio no numérico", { moneda: "USD", tipoCambio: "abc" }],
    ["tipo de cambio negativo", { moneda: "USD", tipoCambio: "-3.300" }],
    ["tipo de cambio cero", { moneda: "USD", tipoCambio: "0" }],
    [
      "tipo de cambio con cuatro decimales",
      { moneda: "USD", tipoCambio: "3.3001" },
    ],
    ["tipo de comprobante de un solo dígito", { tipo: "1" }],
    ["serie de cinco caracteres", { serie: "F0001" }],
    ["serie vacía", { serie: "" }],
    ["número vacío", { numero: "" }],
    ["documento del proveedor vacío", { rucContraparte: "" }],
    ["fecha inexistente", { fechaEmision: "2026-02-30" }],
    ["fecha en otro formato", { fechaEmision: "05/10/2026" }],
    ["barra vertical en el tipo", { tipo: "0|" }],
    ["barra vertical en la serie", { serie: "F|01" }],
    ["barra vertical en el número", { numero: "12|3" }],
    [
      "barra vertical en el documento del proveedor",
      { rucContraparte: "2010|0070970" },
    ],
    ["barra vertical en el tipo de documento", { tipoDocContraparte: "6|" }],
  ];

  it.each(ILEGIBLES)("%s", (_motivo, mala) => {
    const e = falla([
      fila(),
      fila({ numero: "124", ...mala }),
      fila({ numero: "125" }),
    ]);
    expect(e).toBeInstanceOf(ErrorPropuesta);
    expect(e).toMatchObject({ detalle: "fila_invalida" });
  });

  it("una fila que no es un objeto de la propuesta (null, cadena, número) también es fila_invalida", () => {
    for (const mala of [null, "texto", 42, []]) {
      expect(falla([fila(), mala])).toMatchObject({ detalle: "fila_invalida" });
    }
  });

  it("falta un campo obligatorio: fila_invalida", () => {
    const sinTotal: Record<string, unknown> = { ...fila() };
    delete sinTotal.total;
    expect(falla([sinTotal])).toMatchObject({ detalle: "fila_invalida" });
  });

  it("el error no incluye el contenido de ninguna fila (ni el valor ni el nombre del campo)", () => {
    const e = falla([
      fila(),
      fila({
        numero: "124",
        total: "SECRETO-123",
        razonSocialContraparte: "RAZON-CANARIO",
      }),
    ]);
    expect(e).toBeInstanceOf(ErrorPropuesta);
    const texto =
      JSON.stringify(e) +
      String((e as Error).stack) +
      String((e as Error).message);
    expect(texto).not.toContain("SECRETO-123");
    expect(texto).not.toContain("RAZON-CANARIO");
    expect(texto).not.toContain("20100070970");
  });

  it("es todo o nada: una sola ilegible entre filas válidas lanza y no devuelve las demás", () => {
    expect(() =>
      persistidorCompras.preparar([
        fila(),
        fila({ numero: "124", total: "x" }),
      ]),
    ).toThrow(ErrorPropuesta);
  });
});

describe("registro de persistidores", () => {
  it("compras está registrado junto al de ventas (una línea en index.ts)", () => {
    expect(PERSISTIDORES.compras).toBe(persistidorCompras);
    expect(PERSISTIDORES.ventas).toBe(persistidorVentas);
  });

  it("el persistidor de compras no importa nada de ventas", () => {
    const fuente = readFileSync(join(__dirname, "compras.ts"), "utf8");
    const importaciones = fuente
      .split("\n")
      .filter((l) => /\bfrom\s+["']/.test(l));
    for (const l of importaciones) expect(l, l).not.toMatch(/ventas/i);
  });
});
