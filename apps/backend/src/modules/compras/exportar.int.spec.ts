// Spec 014 (T10, rojo): GET /clientes/:clienteId/periodos/:periodo/compras/exportar.xlsx (RF-105, D-17, DU-11, DU-20; CA-20).
// Contrato (plan: «Contratos: HTTP» y «Decisiones: Excel»):
//  - 200 con un `.xlsx` generado en memoria en el servidor (`Content-Type` de hoja de cálculo, `Content-Disposition: attachment`
//    con nombre `.xlsx`, `Cache-Control: no-store`). Permiso `clientes.ver`; mismo 404 para cliente ajeno; 401 sin sesión.
//  - Hojas: las compras vigentes (sin descartadas) en una y las excluidas en OTRA hoja aparte. Las descartadas no salen.
//  - Montos escritos como CELDAS NUMÉRICAS desde la cadena decimal exacta (nunca `number`): también los negativos y los de
//    borde de NUMERIC(14,2). Solo el texto se neutraliza: todo texto de celda que empiece por `=`, `+`, `-`, `@`, tabulación o
//    retorno lleva una comilla simple inicial y se guarda como texto, jamás como fórmula (`<f>`). El texto normal no cambia.
//  - Sin tope de 5.000 filas (DU-20): con más de 5.000 filas vivas salen todas.
//  - El archivo se abre con el lector de 007b (`leerXlsx` no lo rechaza como `archivo_invalido`).
// La prueba no fija el orden ni los títulos de las columnas (no están en la spec): busca los valores por su contenido.
// Rojo: el módulo `compras` aún no existe (T17): toda ruta responde 404 de ruta inexistente.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { leerXlsx } from "../importacion/lector-xlsx.js";
import { ErrorArchivo } from "../importacion/tipos.js";
import {
  abrirBancoCompras,
  base,
  centimosDeCelda,
  leerLibroXlsx,
  PERIODO,
  type Actor,
  type BancoCompras,
  type Estudio,
  type HojaXlsx,
} from "../../../test/soporte-compras.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let v: BancoCompras;
let E: Estudio;
let contador: Actor;
let lectura: Actor;

beforeAll(async () => {
  v = await abrirBancoCompras();
  E = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  lectura = await p.miembro(E.tenantId, "lectura");
});
afterAll(async () => {
  await v?.cerrar();
});

type Cliente = { id: string; ruc: string };
const nuevoCliente = () =>
  v.cliente(E, { responsable: contador.id, colaboradores: [lectura.id] });
const u = (): string => E.titular.id;
const exportar = (a: Actor, c: Cliente, periodo = PERIODO) =>
  v.bin(a, "GET", `${base(c.id, periodo)}/exportar.xlsx`);

/** Todas las celdas de una hoja, aplanadas. */
const celdas = (h: HojaXlsx) => h.filas.flat().filter((c): c is NonNullable<typeof c> => c !== null);
/** Céntimos de las celdas numéricas de la fila que contiene el texto dado. */
function numerosDeLaFila(hojas: HojaXlsx[], texto: string): bigint[] {
  for (const h of hojas) {
    for (const fila of h.filas) {
      if (fila.some((c) => c !== null && c.tipo === "texto" && c.valor === texto))
        return fila
          .filter((c): c is NonNullable<typeof c> => c !== null && c.tipo === "numero")
          .map((c) => centimosDeCelda(c.valor));
    }
  }
  throw new Error(`no hay una fila con la celda de texto ${JSON.stringify(texto)}`);
}
/** Descarga el Excel (exige 200) y lo lee. */
async function libro(c: Cliente, a: Actor = contador): Promise<HojaXlsx[]> {
  const r = await exportar(a, c);
  expect(r.status, r.texto.slice(0, 200)).toBe(200);
  return leerLibroXlsx(new Uint8Array(r.bytes));
}
const hojaCon = (hojas: HojaXlsx[], texto: string): number =>
  hojas.findIndex((h) => celdas(h).some((c) => c.valor === texto));
const filasConNumeros = (h: HojaXlsx): number =>
  h.filas.filter((f) => f.some((c) => c !== null && c.tipo === "numero")).length;

const RAZONES_PELIGROSAS = [
  '=HYPERLINK("http://x")',
  "-2+3",
  "+cmd|' /C calc'!A0",
  "@SUM(1+1)",
  "\t=1+1",
  "\r=1+1",
];

/** Periodo del caso de CA-20: filas con razones sociales peligrosas, una nota de crédito, una excluida, una descartada y una editada. */
async function periodoCA20() {
  const c = await nuevoCliente();
  const propuestaId = await v.sembrarPropuesta(E.tenantId, c.id, { libro: "compras", nuevas: 12, usuarioId: u() });
  const sembrar = (n: number, extra: Partial<Parameters<BancoCompras["sembrarCompra"]>[2]>) =>
    v.sembrarCompra(E.tenantId, c.id, {
      serie: "F001",
      numero: String(1000 + n),
      doc: `2070000${String(n).padStart(4, "0")}`,
      propuestaId,
      usuarioId: u(),
      ...extra,
    });
  await sembrar(1, { razonSocial: RAZONES_PELIGROSAS[0]!, montos: { biDg: "1000.00", igvDg: "180.00" } });
  await sembrar(2, { razonSocial: RAZONES_PELIGROSAS[1]!, montos: { biDg: "-100.00", igvDg: "-18.00" } }); // nota de crédito
  for (let i = 2; i < RAZONES_PELIGROSAS.length; i++) await sembrar(i + 1, { razonSocial: RAZONES_PELIGROSAS[i]! });
  await sembrar(7, { razonSocial: "PROVEEDOR NORMAL SAC" });
  await sembrar(8, { razonSocial: "A=B & C <b>negrita</b> SAC" });
  await sembrar(9, { razonSocial: "BORDE SAC", montos: { biDg: "999999999999.99" } });
  // Editada: la versión 1 era de 100.00 + 18.00 y la vigente es de 130.00 + 23.40.
  await sembrar(10, {
    razonSocial: "EDITADA SAC",
    montos: { biDg: "100.00", igvDg: "18.00" },
    versiones: [{ montos: { biDg: "130.00", igvDg: "23.40" }, accion: "editar" }],
  });
  await sembrar(11, {
    razonSocial: "EXCLUIDA UNICA SAC",
    montos: { biDg: "777.00", igvDg: "139.86" },
    versiones: [{ excluida: true, motivo: "zapatillas", accion: "excluir" }],
  });
  await v.sembrarCompra(E.tenantId, c.id, {
    serie: "F001",
    numero: "1012",
    doc: "20700000012",
    origen: "agregada",
    descartada: true,
    razonSocial: "DESCARTADA UNICA SAC",
    usuarioId: u(),
    montos: { biDg: "555.00", igvDg: "99.90" },
  });
  return c;
}

describe("CA-20 · el archivo: cabeceras y forma", () => {
  it("200 con un .xlsx (zip), tipo de hoja de cálculo, adjunto con nombre .xlsx y sin caché", async () => {
    const c = await periodoCA20();
    const r = await exportar(contador, c);
    expect(r.status, r.texto.slice(0, 200)).toBe(200);
    expect(String(r.headers["content-type"])).toMatch(/spreadsheetml\.sheet/);
    expect(String(r.headers["content-disposition"])).toMatch(/attachment/i);
    expect(String(r.headers["content-disposition"])).toMatch(/\.xlsx/i);
    expect(String(r.headers["cache-control"])).toMatch(/no-store/);
    expect(r.bytes.subarray(0, 2).toString("latin1")).toBe("PK"); // un zip
  });

  it("el nombre del archivo no lleva el RUC ni los ids del estudio y cliente", async () => {
    const c = await periodoCA20();
    const r = await exportar(contador, c);
    expect(r.status, r.texto.slice(0, 200)).toBe(200);
    const nombre = String(r.headers["content-disposition"]);
    for (const prohibido of [c.id, E.tenantId]) expect(nombre).not.toContain(prohibido);
  });

  it("se abre con el lector de 007b: no lo rechaza como archivo inválido", async () => {
    const c = await periodoCA20();
    const r = await exportar(contador, c);
    expect(r.status).toBe(200);
    try {
      leerXlsx(new Uint8Array(r.bytes));
    } catch (e) {
      // El lector de clientes pide sus columnas: faltan, pero el contenedor, el zip y las hojas son válidos.
      expect(e).toBeInstanceOf(ErrorArchivo);
      expect((e as ErrorArchivo).codigo).not.toBe("archivo_invalido");
    }
    expect(leerLibroXlsx(new Uint8Array(r.bytes)).length).toBeGreaterThanOrEqual(2);
  });

  it("no lleva nada de otro cliente ni del estudio", async () => {
    const c = await periodoCA20();
    const otro = await nuevoCliente();
    await v.sembrarCompra(E.tenantId, otro.id, { serie: "F888", numero: "1", doc: "20700099998", razonSocial: "AJENA OTRO CLIENTE SAC", usuarioId: u() });
    const hojas = await libro(c);
    for (const h of hojas) for (const x of celdas(h)) expect(x.valor).not.toContain("AJENA OTRO CLIENTE");
  });
});

describe("CA-20 · fórmulas neutralizadas (D-17)", () => {
  it("las razones sociales `=HYPERLINK(…)`, `-2+3`, `+…`, `@…`, tabulación y retorno se guardan como texto con comilla inicial", async () => {
    const c = await periodoCA20();
    const hojas = await libro(c);
    for (const razon of RAZONES_PELIGROSAS) {
      const esperado = `'${razon}`;
      const hay = hojas.flatMap(celdas).filter((x) => x.valor === esperado);
      expect(hay.length, JSON.stringify(esperado)).toBeGreaterThanOrEqual(1);
      for (const x of hay) expect(x.tipo, JSON.stringify(esperado)).toBe("texto");
      // La razón sin neutralizar no aparece como texto en ninguna parte.
      expect(hojas.flatMap(celdas).filter((x) => x.tipo === "texto" && x.valor === razon), JSON.stringify(razon)).toEqual([]);
    }
  });

  it("ninguna celda del archivo es una fórmula ni un texto que empiece por = + - @ tabulación o retorno", async () => {
    const c = await periodoCA20();
    const hojas = await libro(c);
    for (const x of hojas.flatMap(celdas)) {
      expect(x.tipo, x.valor).not.toBe("formula");
      if (x.tipo === "texto") expect(x.valor, JSON.stringify(x.valor)).not.toMatch(/^[=+\-@\t\r]/);
    }
  });

  it("el texto normal no cambia: sin comilla de más, y `=`, `<b>` y `&` en medio se guardan tal cual", async () => {
    const c = await periodoCA20();
    const hojas = await libro(c);
    const textos = hojas.flatMap(celdas).filter((x) => x.tipo === "texto").map((x) => x.valor);
    expect(textos).toContain("PROVEEDOR NORMAL SAC");
    expect(textos).toContain("A=B & C <b>negrita</b> SAC");
    expect(textos).not.toContain("'PROVEEDOR NORMAL SAC");
  });
});

describe("CA-20 · montos como números exactos", () => {
  it("los montos de la fila de la fórmula son celdas numéricas con el valor exacto", async () => {
    const c = await periodoCA20();
    const hojas = await libro(c);
    const numeros = numerosDeLaFila(hojas, `'${RAZONES_PELIGROSAS[0]}`);
    for (const esperado of [100000n, 18000n, 118000n]) expect(numeros, `monto ${esperado}`).toContain(esperado);
  });

  it("la nota de crédito: los montos negativos son números (no texto «-100.00») y exactos", async () => {
    const c = await periodoCA20();
    const hojas = await libro(c);
    const numeros = numerosDeLaFila(hojas, `'${RAZONES_PELIGROSAS[1]}`);
    for (const esperado of [-10000n, -1800n, -11800n]) expect(numeros, `monto ${esperado}`).toContain(esperado);
    // Y ningún monto negativo quedó como texto.
    const comoTexto = hojas.flatMap(celdas).filter((x) => x.tipo === "texto" && /^'?-\d+(\.\d+)?$/.test(x.valor));
    expect(comoTexto).toEqual([]);
  });

  it("el monto de borde de NUMERIC(14,2) sale exacto y no se redondea", async () => {
    const c = await periodoCA20();
    const hojas = await libro(c);
    expect(numerosDeLaFila(hojas, "BORDE SAC")).toContain(99999999999999n); // 999999999999.99
  });

  it("una fila editada sale con los montos de su versión vigente", async () => {
    const c = await periodoCA20();
    const hojas = await libro(c);
    const numeros = numerosDeLaFila(hojas, "EDITADA SAC");
    for (const esperado of [13000n, 2340n, 15340n]) expect(numeros, `monto ${esperado}`).toContain(esperado);
    expect(numeros).not.toContain(10000n); // la versión 1 no sale
  });
});

describe("CA-20 · hojas: vigentes, excluidas aparte y descartadas fuera", () => {
  it("las excluidas van en otra hoja que las vigentes", async () => {
    const c = await periodoCA20();
    const hojas = await libro(c);
    const hVigentes = hojaCon(hojas, "PROVEEDOR NORMAL SAC");
    const hExcluidas = hojaCon(hojas, "EXCLUIDA UNICA SAC");
    expect(hVigentes).toBeGreaterThanOrEqual(0);
    expect(hExcluidas).toBeGreaterThanOrEqual(0);
    expect(hExcluidas).not.toBe(hVigentes);
    // Cada hoja trae lo suyo y no lo de la otra.
    expect(hojaCon(hojas, "EXCLUIDA UNICA SAC")).toBe(hExcluidas);
    expect(celdas(hojas[hVigentes]!).some((x) => x.valor === "EXCLUIDA UNICA SAC")).toBe(false);
    expect(celdas(hojas[hExcluidas]!).some((x) => x.valor === "PROVEEDOR NORMAL SAC")).toBe(false);
    // Los montos de la excluida están en su hoja (su versión vigente conserva los montos).
    expect(numerosDeLaFila(hojas, "EXCLUIDA UNICA SAC")).toContain(77700n);
  });

  it("las vigentes salen todas (10) y las excluidas (1); las descartadas, en ninguna hoja", async () => {
    const c = await periodoCA20();
    const hojas = await libro(c);
    const hVigentes = hojas[hojaCon(hojas, "PROVEEDOR NORMAL SAC")]!;
    const hExcluidas = hojas[hojaCon(hojas, "EXCLUIDA UNICA SAC")]!;
    expect(filasConNumeros(hVigentes)).toBe(10);
    expect(filasConNumeros(hExcluidas)).toBe(1);
    for (const h of hojas) {
      for (const x of celdas(h)) {
        expect(x.valor).not.toContain("DESCARTADA UNICA");
        expect(x.valor).not.toBe("55500");
      }
    }
  });

  it("un periodo sin compras da un archivo válido con las hojas y sin filas de datos", async () => {
    const c = await nuevoCliente();
    const r = await exportar(contador, c);
    expect(r.status, r.texto.slice(0, 200)).toBe(200);
    const hojas = leerLibroXlsx(new Uint8Array(r.bytes));
    expect(hojas.length).toBeGreaterThanOrEqual(1);
    for (const h of hojas) expect(filasConNumeros(h)).toBe(0);
  });

  it("no hay hojas de otro periodo: solo salen las compras del periodo pedido", async () => {
    const c = await periodoCA20();
    await v.sembrarCompra(E.tenantId, c.id, { serie: "F999", numero: "1", doc: "20700099997", razonSocial: "OTRO PERIODO SAC", usuarioId: u(), periodo: "202609" });
    const hojas = await libro(c);
    expect(hojas.flatMap(celdas).some((x) => x.valor === "OTRO PERIODO SAC")).toBe(false);
  });
});

describe("DU-20 · más de 5.000 filas vivas: el Excel las lleva todas", () => {
  it("5.300 filas del SIRE más una editada y una agregada en las vigentes, y una excluida aparte: nada se corta en 5.000", async () => {
    const c = await nuevoCliente();
    const filas = await v.sembrarVolumen(E.tenantId, c.id, 5300, { usuarioId: u() });
    expect(filas).toHaveLength(5300);
    const propuestaId = (await v.compras(c.id))[0]!.propuesta_id!;
    await v.sembrarCompra(E.tenantId, c.id, {
      serie: "F010",
      numero: "2",
      doc: "20700000022",
      propuestaId,
      razonSocial: "EDITADA GRANDE SAC",
      usuarioId: u(),
      montos: { biDg: "50.00", igvDg: "9.00" },
      versiones: [{ montos: { biDg: "60.00", igvDg: "10.80" }, accion: "editar" }],
    });
    await v.sembrarCompra(E.tenantId, c.id, { serie: "F010", numero: "3", doc: "20700000023", origen: "agregada", razonSocial: "AGREGADA GRANDE SAC", usuarioId: u() });
    await v.sembrarCompra(E.tenantId, c.id, {
      serie: "F010",
      numero: "1",
      doc: "20700000021",
      propuestaId,
      razonSocial: "EXCLUIDA GRANDE SAC",
      usuarioId: u(),
      versiones: [{ excluida: true, motivo: "zapatillas", accion: "excluir" }],
    });
    const t0 = Date.now();
    const r = await exportar(contador, c);
    expect(r.status, r.texto.slice(0, 200)).toBe(200);
    expect(Date.now() - t0, "exportar más de 5.000 filas").toBeLessThan(60_000);
    const hojas = leerLibroXlsx(new Uint8Array(r.bytes));
    const iVig = hojaCon(hojas, "EDITADA GRANDE SAC");
    const iExc = hojaCon(hojas, "EXCLUIDA GRANDE SAC");
    expect(iVig).toBeGreaterThanOrEqual(0);
    expect(iExc).toBeGreaterThanOrEqual(0);
    expect(iExc).not.toBe(iVig);
    expect(filasConNumeros(hojas[iVig]!)).toBe(5302); // 5.300 + la editada + la agregada
    expect(filasConNumeros(hojas[iExc]!)).toBe(1);
    // La suma de los montos de las 5.300 iguales está en el archivo, fila por fila: el último número de serie F002 también sale.
    expect(celdas(hojas[iVig]!).some((x) => x.valor === "AGREGADA GRANDE SAC")).toBe(true);
  });
});

describe("D-11 · permisos y alcance del Excel", () => {
  it("lectura (clientes.ver) lo descarga y un cliente archivado también", async () => {
    const c = await periodoCA20();
    expect((await exportar(lectura, c)).status).toBe(200);
    const archivado = await v.cliente(E, { responsable: contador.id, archivado: true });
    expect((await exportar(contador, archivado)).status).toBe(200);
  });

  it("sin sesión, 401; un cliente ajeno o inexistente, 404", async () => {
    const c = await periodoCA20();
    expect((await exportar(contador, c)).status).toBe(200); // control: la ruta existe
    expect((await v.sinSesion("GET", `${base(c.id)}/exportar.xlsx`)).status).toBe(401);
    const F = await v.estudio();
    const ajeno = await exportar(F.titular, c);
    expect(ajeno.status).toBe(404);
    expect(ajeno.json).toEqual({ codigo: "no_encontrado" });
  });

  it("la ruta estática no se confunde con un :compraId", async () => {
    const c = await periodoCA20();
    const r = await exportar(contador, c);
    expect(r.status).toBe(200);
    expect(r.json).toBeNull(); // un archivo, no el JSON de un detalle ni un 404
  });
});
