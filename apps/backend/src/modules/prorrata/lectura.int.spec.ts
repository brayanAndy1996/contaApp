/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 026 (T6, rojo): lectura de la prorrata, el coeficiente y el IGV estimado (R-1 a R-8; CA-1, CA-3, CA-4, CA-5, CA-6, CA-8, CA-11).
// Contrato (plan 026, «Contratos: HTTP» y «shared»; `prorrataVistaSchema` de `@contapp/shared`, T2):
//  - `GET /clientes/:clienteId/prorrata?periodo=AAAAMM` (`prorrata.ver`) -> 200 `ProrrataVista` con `Cache-Control: no-store`:
//    `{periodo, ventana: MesVista[12], coeficiente, igvEstimado, diferencia, ultimaObtencion, prorrataUsada, versionUsada}`. La ventana
//    son los 12 meses que terminan en M, incluido M, del más antiguo al más reciente (R-1). Montos y porcentajes, cadenas decimales.
//    [T6] Sin `periodo` el backend usa el MES ANTERIOR en hora de Lima (como el selector de la pantalla y como 025); M posterior al mes en
//    curso (Lima) -> 400 `{codigo: "periodo_futuro"}`; periodo mal formado -> 400 `solicitud_invalida`.
//  - Mes: origen `declarado` (presentación vigente = mayor número de orden NUMÉRICO, original o rectificatoria) > `manual` > `sire`
//    (ventas de 013 con el periodo cargado; cargado sin filas = SIRE en 0) > `falta` (montos «0.00»). Avisos del mes `usd_sin_tipo_cambio`,
//    `sire_sin_exportaciones` y `manual_reemplazado`.
//  - Coeficiente (R-3, R-4, R-6): `calculado` | `faltan_meses` (faltantes en orden) | `no_determinable` (`total_cero` | `acumulado_invalido`),
//    porcentaje a 2 decimales mitad hacia arriba; `provisional` si algún mes es SIRE o manual; avisos `numerador_cero` y `exportaciones_en_sire`.
//  - IGV estimado (R-7): `igvVentas` y `creditoDg`/`igvDgng`/`igvDng` salen de las MISMAS filas de los resúmenes de 013 y 014;
//    `creditoDgng = redondearSunat(igvDgng × porcentaje/100)` con el porcentaje YA redondeado; `resultado = igvVentas − creditoDg −
//    creditoDgng`; situación `a_pagar` | `saldo_a_favor` | `cero`; sin coeficiente, sin ventas o sin compras cargadas de M -> `no_estimable`
//    con motivo `coeficiente` | `sin_ventas` | `sin_compras` (el coeficiente tiene precedencia).
//  - La lectura no escribe nada y se permite con el cliente archivado. Ni RUC ni datos de otro cliente en la respuesta.
// Rojo: el módulo `prorrata` aún no existe (T12): toda ruta responde 404 de ruta inexistente. Las tablas son de T10.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoProrrata,
  CA1,
  CLAVES_COEFICIENTE_CALCULADO,
  CLAVES_IGV_CALCULADO,
  CLAVES_MES,
  CLAVES_VISTA,
  conReloj,
  cumple,
  declaracionesCA1,
  facturaVenta,
  fila,
  M,
  montosCompra,
  NO_ENCONTRADO,
  rutaComprasPeriodo,
  rutaHistorial,
  rutasDeProrrata,
  rutaVentasPeriodo,
  rutaVista,
  RUTAS_026,
  ventaNoGravada,
  ventanaHasta,
  VENTANA_M,
  type Actor,
  type BancoProrrata,
  type DeclSpec,
  type Estudio,
} from "../../../test/soporte-prorrata.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let v: BancoProrrata;
let E: Estudio;
let contador: Actor; // responsable del cliente: prorrata.gestionar, alcance asignado
let asistente: Actor; // colaborador: solo prorrata.ver

beforeAll(async () => {
  v = await abrirBancoProrrata();
  E = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
});
afterAll(async () => {
  await v?.cerrar();
});

type Cliente = { id: string; ruc: string };
const nuevoCliente = (o: Parameters<typeof v.cliente>[1] = {}): Promise<Cliente> =>
  v.cliente(E, { responsable: contador.id, colaboradores: [asistente.id], ...o });
const u = (): string => E.titular.id;
const ver = (a: Actor, c: { id: string }, periodo?: string) => v.http(a, "GET", rutaVista(c.id, periodo));
const mesDe = (body: any, periodo: string): any => (body?.ventana ?? []).find((m: any) => m.periodo === periodo);
const sembrarCA1 = (c: Cliente, ds: DeclSpec[] = declaracionesCA1()) => v.sembrarDeclaraciones(E.tenantId, c.id, ds, { periodoHasta: M });
/** Los 11 primeros meses de la ventana declarados en cero y M con los montos dados (para cocientes exactos). */
const ventanaConM = (gravadasM: string, noGravadasM: string): DeclSpec[] =>
  VENTANA_M.map((periodo, i) => ({
    periodo,
    numeroOrden: String(100 + i),
    gravadas: periodo === M ? gravadasM : "0.00",
    noGravadas: periodo === M ? noGravadasM : "0.00",
  }));
/** Los 12 meses como manuales (versión 1) con los montos que da `f`: la forma más corta de armar un coeficiente. */
async function sembrarManuales(c: Cliente, f: (periodo: string, i: number) => { g: string; e?: string; n: string }): Promise<void> {
  for (const [i, periodo] of VENTANA_M.entries()) {
    const m = f(periodo, i);
    await v.sembrarManual(E.tenantId, c.id, { periodo, gravadas: m.g, exportaciones: m.e ?? "0.00", noGravadas: m.n, autor: u() });
  }
}

// --- Contrato de rutas ------------------------------------------------------------------------------------------------------

describe("contrato de rutas de 026 (D-5, CA-8, CA-9)", () => {
  it("las seis rutas existen y declaran su permiso (leer: prorrata.ver; obtener, manual y usada: prorrata.gestionar)", () => {
    const rutas = rutasDeProrrata(v.b.c.p.b.h.app)
      .map((r) => `${r.metodo} ${r.ruta} ${r.permiso}`)
      .sort();
    expect(rutas).toEqual(RUTAS_026);
  });

  it("el backend no llama a SOL ni descifra: el módulo `prorrata` no depende de @contapp/sunat ni de @contapp/crypto (D-3, CA-7)", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    expect(existsSync(join(dir, "prorrata.module.ts")), "el módulo se llama prorrata (plan 026)").toBe(true);
    const fuentes = readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".spec.ts"));
    expect(fuentes.length, "el módulo `prorrata` debe tener fuentes (T12)").toBeGreaterThan(0);
    for (const n of fuentes) {
      const texto = readFileSync(join(dir, n), "utf8");
      expect(texto, n).not.toMatch(/@contapp\/sunat/);
      expect(texto, n).not.toMatch(/@contapp\/crypto/);
      expect(texto, n).not.toMatch(/descifr/i);
    }
    expect(readFileSync(join(dir, "../../../package.json"), "utf8")).not.toMatch(/@contapp\/sunat/);
  });
});

// --- R-1 · la ventana y CA-1 ---------------------------------------------------------------------------------------------------

describe("R-1 y CA-1 · la ventana de 12 meses que terminan en M, incluido M", () => {
  it("con 12 PDT declarados: 202511 a 202610, origen declarado, coeficiente 83.89 y vista con la forma exacta del contrato", async () => {
    const c = await nuevoCliente();
    await sembrarCA1(c);
    const r = await ver(contador, c, M);
    expect(r.status, r.text).toBe(200);
    expect(cumple("prorrataVistaSchema", r.body), r.text).toBe(true);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(Object.keys(r.body).sort()).toEqual(CLAVES_VISTA);
    expect(r.body.periodo).toBe(M);
    expect(r.body.ventana.map((m: any) => m.periodo)).toEqual([...VENTANA_M]);
    for (const m of r.body.ventana) {
      expect(Object.keys(m).sort(), m.periodo).toEqual(CLAVES_MES);
      expect(m).toMatchObject({ origen: "declarado", exportaciones: m.periodo === "202603" ? "50000.00" : "0.00", avisos: [], manual: null, versionManual: 0 });
      expect(m.gravadas).toBe("100000.00");
      expect(m.noGravadas).toBe("20000.00");
      expect(m.declaracion).toMatchObject({ tipo: "original", presentaciones: 1 });
    }
    // R-2: total = gravadas + exportaciones + noGravadas.
    expect(mesDe(r.body, "202603").total).toBe("170000.00");
    expect(mesDe(r.body, "202604").total).toBe("120000.00");
    expect(mesDe(r.body, "202511").declaracion).toEqual({ numeroOrden: "7000", fechaPresentacion: "2025-12-10", tipo: "original", presentaciones: 1 });
    expect(Object.keys(r.body.coeficiente).sort()).toEqual(CLAVES_COEFICIENTE_CALCULADO);
    expect(r.body.coeficiente).toEqual({ estado: "calculado", porcentaje: CA1.porcentaje, numerador: CA1.numerador, total: CA1.total, provisional: false, avisos: [] });
    expect(r.body.prorrataUsada).toBeNull();
    expect(r.body.diferencia).toBeNull();
    expect(r.body.versionUsada).toBe(0);
    expect(r.text).not.toContain(c.ruc); // D-7: ni el RUC del cliente
  });

  it("una segunda lectura da lo mismo y la lectura no escribe nada (sin filas nuevas, sin trabajos, sin auditoría)", async () => {
    const c = await nuevoCliente();
    await sembrarCA1(c);
    const antes = await v.fotoProrrata(E.tenantId, c.id);
    const a = await ver(contador, c, M);
    const b = await ver(contador, c, M);
    expect(a.status, a.text).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(await v.fotoProrrata(E.tenantId, c.id)).toEqual(antes);
  });

  it.each([
    ["202610", "202511"],
    ["202601", "202502"], // cruza el año hacia atrás
    ["202512", "202501"], // diciembre: el año calendario completo
    ["202501", "202402"], // enero: 11 meses del año anterior
    ["202603", "202504"],
  ])("M = %s: la ventana empieza en %s y termina en M, en orden", async (periodo, primero) => {
    const c = await nuevoCliente();
    const r = await ver(contador, c, periodo);
    expect(r.status, r.text).toBe(200);
    const esperado = ventanaHasta(periodo);
    expect(esperado[0]).toBe(primero);
    expect(r.body.ventana.map((m: any) => m.periodo)).toEqual(esperado);
    expect(r.body.periodo).toBe(periodo);
  });

  it("sin ningún dato: 12 meses «falta» con montos 0.00, coeficiente faltan_meses con los 12, IGV no estimable y nada más", async () => {
    const c = await nuevoCliente();
    const r = await ver(contador, c, M);
    expect(r.status, r.text).toBe(200);
    expect(cumple("prorrataVistaSchema", r.body), r.text).toBe(true);
    for (const m of r.body.ventana) {
      expect(m).toEqual({
        periodo: m.periodo,
        origen: "falta",
        gravadas: "0.00",
        exportaciones: "0.00",
        noGravadas: "0.00",
        total: "0.00",
        avisos: [],
        declaracion: null,
        manual: null,
        versionManual: 0,
        sireCargado: false,
      });
    }
    expect(r.body.coeficiente).toEqual({ estado: "faltan_meses", faltantes: [...VENTANA_M] });
    expect(r.body.igvEstimado).toEqual({ estado: "no_estimable", motivo: "coeficiente" });
    expect(r.body.diferencia).toBeNull();
    expect(r.body.ultimaObtencion).toBeNull();
    expect(r.body.prorrataUsada).toBeNull();
    expect(r.body.versionUsada).toBe(0);
  });

  it("la última obtención de M: su fecha y los periodos sin declaración; la de otro periodo_hasta no cuenta y gana la más reciente", async () => {
    const c = await nuevoCliente();
    await v.sembrarObtencion(E.tenantId, c.id, { periodoHasta: M, sinDeclaracion: ["202511", "202512"], obtenidaEn: "2026-11-10T15:00:00.000Z" });
    await v.sembrarObtencion(E.tenantId, c.id, { periodoHasta: M, sinDeclaracion: ["202511"], obtenidaEn: "2026-11-20T15:00:00.000Z" });
    await v.sembrarObtencion(E.tenantId, c.id, { periodoHasta: "202609", sinDeclaracion: ["202510"], obtenidaEn: "2026-11-21T15:00:00.000Z" });
    const r = await ver(contador, c, M);
    expect(r.status, r.text).toBe(200);
    expect(r.body.ultimaObtencion).toEqual({ obtenidaEn: "2026-11-20T15:00:00.000Z", periodosSinDeclaracion: ["202511"] });
    const r9 = await ver(contador, c, "202609");
    expect(r9.body.ultimaObtencion).toEqual({ obtenidaEn: "2026-11-21T15:00:00.000Z", periodosSinDeclaracion: ["202510"] });
    const sin = await ver(contador, c, "202608");
    expect(sin.body.ultimaObtencion).toBeNull();
  });
});

// --- Periodo por omisión y periodo futuro (hora de Lima, reloj fijo) ---------------------------------------------------------------

describe("periodo por omisión y periodo futuro (R-1, hora de Lima UTC−5)", () => {
  it.each([
    ["2026-03-15T17:00:00Z", "202602"], // mitad de mes: el anterior es febrero
    ["2026-04-01T04:59:00Z", "202602"], // 23:59 del 31 de marzo en Lima: aún es marzo
    ["2026-04-01T05:00:00Z", "202603"], // 00:00 del 1 de abril en Lima
    ["2026-01-01T04:59:00Z", "202511"], // 23:59 del 31 de diciembre en Lima: el anterior es noviembre
    ["2026-01-01T05:00:00Z", "202512"], // enero (Lima): cruza el año hacia atrás
  ])("sin periodo y con el reloj en %s (UTC): usa el mes anterior %s", async (ahora, esperado) => {
    const c = await nuevoCliente();
    const r = await conReloj(ahora, () => ver(contador, c));
    expect(r.status, r.text).toBe(200);
    expect(r.body.periodo).toBe(esperado);
    expect(r.body.ventana).toHaveLength(12);
    expect(r.body.ventana[11].periodo).toBe(esperado);
  });

  it.each([
    ["2026-03-15T17:00:00Z", "202603", 200], // el mes en curso se puede calcular
    ["2026-03-15T17:00:00Z", "202604", 400],
    ["2026-03-15T17:00:00Z", "202701", 400],
    ["2026-04-01T04:59:00Z", "202604", 400], // en Lima todavía es marzo
    ["2026-04-01T04:59:00Z", "202603", 200],
    ["2026-04-01T05:00:00Z", "202604", 200], // ya es abril en Lima
    ["2026-04-01T05:00:00Z", "202605", 400],
  ])("con el reloj en %s, M = %s -> %i", async (ahora, periodo, estado) => {
    const c = await nuevoCliente();
    const r = await conReloj(ahora, () => ver(contador, c, periodo));
    expect(r.status, r.text).toBe(estado);
    if (estado === 400) expect(r.body).toEqual({ codigo: "periodo_futuro" });
    else expect(r.body.periodo).toBe(periodo);
  });

  it.each(["202613", "202600", "2026-10", "20261", "2026100", "abcdef", "２０２６１０", "202610%20", " 202610"])(
    "periodo mal formado %j: 400 solicitud_invalida",
    async (periodo) => {
      const c = await nuevoCliente();
      const r = await v.http(contador, "GET", `/clientes/${c.id}/prorrata?periodo=${encodeURIComponent(periodo)}`);
      expect(r.status, r.text).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    },
  );
});

// --- R-5 · origen y precedencia (CA-3) ------------------------------------------------------------------------------------------

describe("R-5, R-2b y CA-3 · origen por mes, rectificatorias y avisos", () => {
  it("la rectificatoria (mayor número de orden, comparado como NÚMERO: 10 > 9) queda vigente y la original no se borra", async () => {
    const c = await nuevoCliente();
    const ds = declaracionesCA1().filter((d) => d.periodo !== "202601");
    // Se siembra primero la de orden 10: gana por número de orden, no por orden de inserción ni de texto («9» > «10» como texto).
    ds.push({ periodo: "202601", numeroOrden: "10", tipo: "rectificatoria", fecha: "2026-03-20", gravadas: "90000.00", noGravadas: "25000.00" });
    ds.push({ periodo: "202601", numeroOrden: "9", tipo: "original", fecha: "2026-02-10", gravadas: "100000.00", noGravadas: "20000.00" });
    await sembrarCA1(c, ds);
    const r = await ver(contador, c, M);
    expect(r.status, r.text).toBe(200);
    const m = mesDe(r.body, "202601");
    expect(m).toMatchObject({ origen: "declarado", gravadas: "90000.00", noGravadas: "25000.00", total: "115000.00" });
    expect(m.declaracion).toEqual({ numeroOrden: "10", fechaPresentacion: "2026-03-20", tipo: "rectificatoria", presentaciones: 2 });
    // La original sigue guardada (el historial del mes la lista) y no cuenta en el coeficiente.
    expect(await v.declaracionesBd(c.id, "202601")).toHaveLength(2);
    expect(r.body.coeficiente.numerador).toBe("1240000.00"); // 1.250.000,00 − 10.000,00 de gravadas de la rectificatoria
    expect(r.body.coeficiente.total).toBe("1485000.00"); // 1.240.000,00 + (240.000,00 + 5.000,00) de no gravadas
    const h = await v.http(contador, "GET", rutaHistorial(c.id, "202601"));
    expect(h.status, h.text).toBe(200);
    expect(h.body.declaraciones.map((d: any) => d.numeroOrden).sort()).toEqual(["10", "9"]);
  });

  it("falta, manual, SIRE y declarado en una misma ventana: cada mes con su origen y, sin el mes que falta, no se calcula (R-6)", async () => {
    const c = await nuevoCliente();
    await v.sembrarManual(E.tenantId, c.id, { periodo: "202512", gravadas: "30000.00", noGravadas: "5000.00", motivo: "Libro físico", autor: contador.id });
    await v.sembrarVentasSire(E.tenantId, c.id, "202601", [facturaVenta("F001", 1, "60000.00", "10800.00"), ventaNoGravada("F001", 2, { exonerada: "4000.00" })], u());
    await sembrarCA1(c, declaracionesCA1().filter((d) => !["202511", "202512", "202601"].includes(d.periodo)));
    const r = await ver(contador, c, M);
    expect(r.status, r.text).toBe(200);
    expect(cumple("prorrataVistaSchema", r.body), r.text).toBe(true);
    expect(r.body.ventana.map((m: any) => m.origen)).toEqual(["falta", "manual", "sire", ...Array(9).fill("declarado")]);

    const manual = mesDe(r.body, "202512");
    expect(manual).toMatchObject({ gravadas: "30000.00", exportaciones: "0.00", noGravadas: "5000.00", total: "35000.00", versionManual: 1, declaracion: null });
    expect(manual.manual).toMatchObject({ motivo: "Libro físico", autor: { id: contador.id, nombre: await v.nombreDe(contador.id) } });
    expect(typeof manual.manual.guardadoEn).toBe("string");

    const sire = mesDe(r.body, "202601");
    expect(sire).toMatchObject({ gravadas: "60000.00", exportaciones: "0.00", noGravadas: "4000.00", total: "64000.00", sireCargado: true, declaracion: null, manual: null });
    expect(sire.avisos).toEqual(["sire_sin_exportaciones"]); // R-2b: el SIRE no separa exportaciones

    expect(r.body.coeficiente).toEqual({ estado: "faltan_meses", faltantes: ["202511"] });
    expect(r.body.igvEstimado).toEqual({ estado: "no_estimable", motivo: "coeficiente" });
  });

  it("completado el mes que faltaba (manual en 0): coeficiente 84.62 «provisional» con el aviso exportaciones_en_sire (R-2b, R-3)", async () => {
    const c = await nuevoCliente();
    await v.sembrarManual(E.tenantId, c.id, { periodo: "202511", gravadas: "0.00", exportaciones: "0.00", noGravadas: "0.00", motivo: "Sin operaciones", autor: u() });
    await v.sembrarManual(E.tenantId, c.id, { periodo: "202512", gravadas: "30000.00", noGravadas: "5000.00", autor: u() });
    await v.sembrarVentasSire(E.tenantId, c.id, "202601", [facturaVenta("F001", 1, "60000.00", "10800.00"), ventaNoGravada("F001", 2, { exonerada: "4000.00" })], u());
    await sembrarCA1(c, declaracionesCA1().filter((d) => !["202511", "202512", "202601"].includes(d.periodo)));
    const r = await ver(contador, c, M);
    expect(r.status, r.text).toBe(200);
    // Σ gravadas = 30.000 + 60.000 + 9 × 100.000 = 990.000; exportaciones 50.000 (202603) -> numerador 1.040.000,00.
    // Σ no gravadas = 5.000 + 4.000 + 9 × 20.000 = 189.000 -> total 1.229.000,00; 1.040.000 / 1.229.000 = 84,6216… -> 84.62.
    expect(r.body.coeficiente).toEqual({
      estado: "calculado",
      porcentaje: "84.62",
      numerador: "1040000.00",
      total: "1229000.00",
      provisional: true,
      avisos: ["exportaciones_en_sire"],
    });
    expect(mesDe(r.body, "202511")).toMatchObject({ origen: "manual", total: "0.00", versionManual: 1 }); // 0 = «sin operaciones»
  });

  it("sin mes SIRE el aviso exportaciones_en_sire no sale aunque un mes declarado tenga exportaciones; con un manual sí es provisional", async () => {
    const c = await nuevoCliente();
    await v.sembrarManual(E.tenantId, c.id, { periodo: "202512", gravadas: "100000.00", noGravadas: "20000.00", autor: u() });
    await sembrarCA1(c, declaracionesCA1().filter((d) => d.periodo !== "202512"));
    const r = await ver(contador, c, M);
    expect(r.body.coeficiente).toMatchObject({ estado: "calculado", provisional: true, avisos: [] });
  });

  it("un PDT que llega para un mes con manual gana, avisa manual_reemplazado y deja el manual en el historial (R-5)", async () => {
    const c = await nuevoCliente();
    await v.sembrarManual(E.tenantId, c.id, { periodo: "202604", gravadas: "1.00", noGravadas: "1.00", motivo: "Provisional", autor: contador.id });
    await sembrarCA1(c);
    const r = await ver(contador, c, M);
    expect(r.status, r.text).toBe(200);
    const m = mesDe(r.body, "202604");
    expect(m).toMatchObject({ origen: "declarado", gravadas: "100000.00", noGravadas: "20000.00" });
    expect(m.avisos).toContain("manual_reemplazado");
    expect(r.body.coeficiente).toMatchObject({ estado: "calculado", provisional: false, porcentaje: CA1.porcentaje });
    const h = await v.http(contador, "GET", rutaHistorial(c.id, "202604"));
    expect(h.status, h.text).toBe(200);
    expect(h.body.manual).toHaveLength(1);
    expect(h.body.manual[0]).toMatchObject({ version: 1, accion: "guardado", motivo: "Provisional" });
    expect(h.body.declaraciones).toHaveLength(1);
  });

  it("un manual eliminado deja el mes en SIRE (periodo cargado) o en «falta»: no cuenta (R-5)", async () => {
    const c = await nuevoCliente();
    await v.sembrarManual(E.tenantId, c.id, { periodo: "202511", version: 1, gravadas: "5.00", noGravadas: "5.00", autor: u() });
    await v.sembrarManual(E.tenantId, c.id, { periodo: "202511", version: 2, accion: "eliminado", motivo: "Se cargó el SIRE", autor: u() });
    await v.sembrarManual(E.tenantId, c.id, { periodo: "202512", version: 1, gravadas: "5.00", noGravadas: "5.00", autor: u() });
    await v.sembrarManual(E.tenantId, c.id, { periodo: "202512", version: 2, accion: "eliminado", motivo: "Se cargó el SIRE", autor: u() });
    await v.sembrarVentasVacias(E.tenantId, c.id, "202512", u());
    const r = await ver(contador, c, M);
    expect(r.status, r.text).toBe(200);
    expect(mesDe(r.body, "202511")).toMatchObject({ origen: "falta", gravadas: "0.00", manual: null, versionManual: 2 }); // la versión «eliminado» también cuenta
    expect(mesDe(r.body, "202512")).toMatchObject({ origen: "sire", gravadas: "0.00", manual: null, versionManual: 2, sireCargado: true });
  });

  it("SIRE (R-2): suma PEN, convierte cada USD fila a fila con redondearSunat, las notas de crédito restan, las agregadas cuentan y la USD sin tipo de cambio no suma (avisa)", async () => {
    const c = await nuevoCliente();
    const filas = [
      facturaVenta("F001", 1, "1000.00", "180.00"),
      ventaNoGravada("F001", 2, { exonerada: "200.00", inafecta: "50.00" }),
      facturaVenta("F001", 3, "100.00", "18.00", { moneda: "USD", tipoCambio: "3.700", exonerada: "10.00", total: "128.00" }),
      fila("F001", 4, { tipo: "07", baseGravada: "-100.00", igv: "-18.00", total: "-118.00" }), // nota de crédito: monto negativo, resta
      facturaVenta("F001", 5, "500.00", "90.00", { moneda: "USD", total: "590.00" }), // USD sin tipo de cambio: fuera, con aviso
    ];
    await v.sembrarVentasSire(E.tenantId, c.id, "202601", filas, u());
    await v.sembrarVentas(E.tenantId, c.id, [facturaVenta("F002", 1, "30.00", "5.40")], { usuarioId: u(), periodo: "202601", origen: "manual" });
    await sembrarCA1(c, declaracionesCA1().filter((d) => d.periodo !== "202601"));
    const r = await ver(contador, c, M);
    expect(r.status, r.text).toBe(200);
    const m = mesDe(r.body, "202601");
    // gravadas = 1000.00 + (100.00 × 3.700 = 370.00) − 100.00 + 30.00 = 1300.00; exportaciones 0.00 (R-2b);
    // no gravadas = 200.00 + 50.00 + (10.00 × 3.700 = 37.00) = 287.00; total = 1587.00.
    expect(m).toMatchObject({ origen: "sire", gravadas: "1300.00", exportaciones: "0.00", noGravadas: "287.00", total: "1587.00", sireCargado: true });
    expect([...m.avisos].sort()).toEqual(["sire_sin_exportaciones", "usd_sin_tipo_cambio"]);
    // Y es la misma cifra que el resumen de 013 para ese mes (mismas filas: igual `igv` y gravadas del resumen).
    const res = await v.http(contador, "GET", `${rutaVentasPeriodo(c.id, "202601")}/resumen`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.total.baseGravada).toBe("1300.00");
  });

  it("un mes con PDT y con ventas cargadas es «declarado» y marca sireCargado: el PDT manda sobre el SIRE (U-3)", async () => {
    const c = await nuevoCliente();
    await sembrarCA1(c);
    await v.sembrarVentasSire(E.tenantId, c.id, "202605", [facturaVenta("F001", 1, "1.00", "0.18")], u());
    const r = await ver(contador, c, M);
    expect(mesDe(r.body, "202605")).toMatchObject({ origen: "declarado", gravadas: "100000.00", sireCargado: true });
    expect(mesDe(r.body, "202606")).toMatchObject({ origen: "declarado", sireCargado: false });
    expect(r.body.coeficiente).toMatchObject({ provisional: false });
  });

  it("las declaraciones, manuales y ventas de OTRO cliente del mismo estudio no entran (aislamiento por cliente)", async () => {
    const c = await nuevoCliente();
    const otro = await nuevoCliente();
    await sembrarCA1(otro);
    await v.sembrarManual(E.tenantId, otro.id, { periodo: "202511", autor: u() });
    await v.sembrarVentasSire(E.tenantId, otro.id, "202512", [facturaVenta("F001", 1, "9.00", "1.62")], u());
    const r = await ver(contador, c, M);
    expect(r.status, r.text).toBe(200);
    expect(r.body.ventana.every((m: any) => m.origen === "falta")).toBe(true);
    expect(r.body.ultimaObtencion).toBeNull();
  });
});

// --- R-3 y R-4 · el coeficiente y sus casos límite (CA-2, CA-4) --------------------------------------------------------------------------

describe("R-3, R-4 y R-6 · coeficiente, redondeo y casos límite por HTTP", () => {
  it.each([
    ["…,5 exacto sube: 174.690,00 / 200.000,00 = 87,345 -> 87.35", "174690.00", "25310.00", "87.35"],
    ["…,4 abajo se queda: 174.688,00 / 200.000,00 = 87,344 -> 87.34", "174688.00", "25312.00", "87.34"],
    ["solo gravadas: 100.00", "50000.00", "0.00", "100.00"],
    ["un tercio: 1/3 = 33,333… -> 33.33", "100.00", "200.00", "33.33"],
    ["dos tercios: 2/3 = 66,666… -> 66.67", "200.00", "100.00", "66.67"],
  ])("%s", async (_n, gravadas, noGravadas, esperado) => {
    const c = await nuevoCliente();
    await sembrarCA1(c, ventanaConM(gravadas, noGravadas));
    const r = await ver(contador, c, M);
    expect(r.status, r.text).toBe(200);
    expect(r.body.coeficiente).toMatchObject({ estado: "calculado", porcentaje: esperado, provisional: false });
  });

  it("montos de 12 dígitos: sin pérdida (numerador y total exactos, porcentaje 99,999…99 -> 100.00)", async () => {
    const c = await nuevoCliente();
    await sembrarCA1(c, ventanaConM("999999999999.98", "0.01"));
    const r = await ver(contador, c, M);
    expect(r.status, r.text).toBe(200);
    expect(r.body.coeficiente).toMatchObject({ estado: "calculado", numerador: "999999999999.98", total: "999999999999.99", porcentaje: "100.00" });
  });

  it("solo exportaciones: 100.00 sin avisos (no hay mes SIRE)", async () => {
    const c = await nuevoCliente();
    await sembrarManuales(c, () => ({ g: "0.00", e: "1000.00", n: "0.00" }));
    const r = await ver(contador, c, M);
    expect(r.body.coeficiente).toEqual({ estado: "calculado", porcentaje: "100.00", numerador: "12000.00", total: "12000.00", provisional: true, avisos: [] });
  });

  it("numerador 0 con total > 0: 0.00 % es válido, con el aviso numerador_cero y crédito DGNG 0 (R-4)", async () => {
    const c = await nuevoCliente();
    await sembrarManuales(c, () => ({ g: "0.00", n: "100.00" }));
    const r = await ver(contador, c, M);
    expect(r.status, r.text).toBe(200);
    expect(r.body.coeficiente).toEqual({ estado: "calculado", porcentaje: "0.00", numerador: "0.00", total: "1200.00", provisional: true, avisos: ["numerador_cero"] });
  });

  it("total 0: no determinable (total_cero), sin IGV estimado ni diferencia, aunque haya prorrata usada", async () => {
    const c = await nuevoCliente();
    await sembrarManuales(c, () => ({ g: "0.00", n: "0.00" }));
    await v.sembrarUsada(E.tenantId, c.id, { periodo: M, porcentaje: "50.00", autor: u() });
    const r = await ver(contador, c, M);
    expect(r.status, r.text).toBe(200);
    expect(cumple("prorrataVistaSchema", r.body), r.text).toBe(true);
    expect(r.body.coeficiente).toEqual({ estado: "no_determinable", motivo: "total_cero" });
    expect(r.body.igvEstimado).toEqual({ estado: "no_estimable", motivo: "coeficiente" });
    expect(r.body.diferencia).toBeNull(); // sin coeficiente calculado no hay alerta (R-8)
    expect(r.body.prorrataUsada).toEqual({ valor: "50.00", origen: "ingresada" });
  });

  it.each([
    ["acumulado con numerador negativo (más notas de crédito que ventas)", { g: "-1000.00", n: "0.00" }],
    ["numerador mayor que el total (no gravadas acumuladas negativas)", { g: "1000.00", n: "-500.00" }],
    ["total negativo con numerador cero", { g: "0.00", n: "-100.00" }],
  ])("%s: no determinable (acumulado_invalido)", async (_n, montos) => {
    const c = await nuevoCliente();
    await sembrarManuales(c, () => montos);
    const r = await ver(contador, c, M);
    expect(r.status, r.text).toBe(200);
    expect(r.body.coeficiente).toEqual({ estado: "no_determinable", motivo: "acumulado_invalido" });
    expect(r.body.igvEstimado).toEqual({ estado: "no_estimable", motivo: "coeficiente" });
  });

  it("un mes con más notas de crédito que ventas se muestra tal cual (negativo) y el acumulado sigue siendo válido", async () => {
    const c = await nuevoCliente();
    await sembrarManuales(c, (p) => (p === "202603" ? { g: "-20000.00", n: "0.00" } : { g: "100000.00", n: "0.00" }));
    const r = await ver(contador, c, M);
    expect(r.status, r.text).toBe(200);
    expect(mesDe(r.body, "202603")).toMatchObject({ gravadas: "-20000.00", total: "-20000.00", origen: "manual" });
    expect(r.body.coeficiente).toMatchObject({ estado: "calculado", porcentaje: "100.00", numerador: "1080000.00", total: "1080000.00" });
  });

  it("varios meses sin origen: se listan en orden cronológico y no se calcula nada (R-6)", async () => {
    const c = await nuevoCliente();
    await sembrarCA1(c, declaracionesCA1().filter((d) => !["202603", "202511", "202609"].includes(d.periodo)));
    const r = await ver(contador, c, M);
    expect(r.status, r.text).toBe(200);
    expect(r.body.coeficiente).toEqual({ estado: "faltan_meses", faltantes: ["202511", "202603", "202609"] });
    expect(r.body.igvEstimado).toEqual({ estado: "no_estimable", motivo: "coeficiente" });
    expect(mesDe(r.body, "202603")).toMatchObject({ origen: "falta", total: "0.00", declaracion: null, manual: null });
  });
});

// --- R-7 · IGV estimado (CA-5) ----------------------------------------------------------------------------------------------------------

describe("R-7 y CA-5 · IGV estimado de M con las ventas de 013 y las compras clasificadas de 014", () => {
  /** Ventas de M (cliente con ventas gravadas y exoneradas, 01 §7 regla 4): factura 18.000,00 + boleta 900,00 − nota de crédito 180,00 = IGV 18.720,00; la venta exonerada no tiene IGV. */
  const ventasM = () => [
    facturaVenta("F001", 1, "100000.00", "18000.00"),
    fila("B001", 1, { baseGravada: "5000.00", igv: "900.00", total: "5900.00" }),
    fila("B001", 2, { tipo: "07", baseGravada: "-1000.00", igv: "-180.00", total: "-1180.00" }),
    ventaNoGravada("B002", 1, { exonerada: "2000.00" }),
  ];
  type CompraSpec = { destino: "DG" | "DGNG" | "DNG"; bi: string; igv: string; excluida?: boolean };
  async function sembrarComprasM(c: Cliente, compras: CompraSpec[]): Promise<string[]> {
    const propuestaId = await v.sembrarPropuesta(E.tenantId, c.id, { periodo: M, libro: "compras", nuevas: compras.length, usuarioId: u() });
    const ids: string[] = [];
    for (const [i, k] of compras.entries()) {
      ids.push(
        await v.sembrarCompra(E.tenantId, c.id, {
          periodo: M,
          serie: "F010",
          numero: String(i + 1),
          doc: `2070000${String(10 + i).padStart(4, "0")}`,
          propuestaId,
          usuarioId: u(),
          montos: montosCompra(k.destino, k.bi, k.igv),
          ...(k.excluida ? { versiones: [{ excluida: true, motivo: "Duplicada", accion: "excluir" }] } : {}),
        }),
      );
    }
    return ids;
  }
  const COMPRAS_M: CompraSpec[] = [
    { destino: "DG", bi: "16666.67", igv: "3000.00" },
    { destino: "DGNG", bi: "6858.72", igv: "1234.57" },
    { destino: "DNG", bi: "500.00", igv: "90.00" },
    { destino: "DG", bi: "2777.78", igv: "500.00", excluida: true }, // excluida: no suma (las mismas filas que el resumen de 014)
  ];

  it("a pagar: 18.720,00 − 3.000,00 − (1.234,57 × 83,89 % = 1.035,68) = 14.684,32; igvVentas y créditos = los resúmenes de 013 y 014", async () => {
    const c = await nuevoCliente();
    await sembrarCA1(c);
    await v.sembrarVentasSire(E.tenantId, c.id, M, ventasM(), u());
    await sembrarComprasM(c, COMPRAS_M);
    const r = await ver(contador, c, M);
    expect(r.status, r.text).toBe(200);
    expect(cumple("prorrataVistaSchema", r.body), r.text).toBe(true);
    expect(Object.keys(r.body.igvEstimado).sort()).toEqual(CLAVES_IGV_CALCULADO);
    // 1.234,57 × 0,8389 = 1.035,680773 -> 1.035,68 (con el porcentaje SIN redondear, 83,8926…, daría 1.035,71: no es la regla).
    expect(r.body.igvEstimado).toEqual({
      estado: "calculado",
      igvVentas: "18720.00",
      creditoDg: "3000.00",
      igvDgng: "1234.57",
      creditoDgng: "1035.68",
      igvDng: "90.00", // informativo: no da crédito ni resta
      resultado: "14684.32",
      situacion: "a_pagar",
      estadoPeriodoCompras: "abierto",
    });
    // CA-5: las mismas cifras que los resúmenes de 013 (ventas) y 014 (compras).
    const rv = await v.http(contador, "GET", `${rutaVentasPeriodo(c.id, M)}/resumen`);
    const rc = await v.http(contador, "GET", `${rutaComprasPeriodo(c.id, M)}/resumen`);
    expect(rv.status, rv.text).toBe(200);
    expect(rc.status, rc.text).toBe(200);
    expect(r.body.igvEstimado.igvVentas).toBe(rv.body.total.igv);
    expect(r.body.igvEstimado.creditoDg).toBe(rc.body.casilleros.vigente.igvDg);
    expect(r.body.igvEstimado.igvDgng).toBe(rc.body.casilleros.vigente.igvDgng);
    expect(r.body.igvEstimado.igvDng).toBe(rc.body.casilleros.vigente.igvDng);
  });

  it("saldo a favor: IGV de ventas 1.000,00 − crédito DG 3.000,00 = −2.000,00", async () => {
    const c = await nuevoCliente();
    await sembrarCA1(c);
    await v.sembrarVentasSire(E.tenantId, c.id, M, [facturaVenta("F001", 1, "5555.56", "1000.00")], u());
    await sembrarComprasM(c, [{ destino: "DG", bi: "16666.67", igv: "3000.00" }]);
    const r = await ver(contador, c, M);
    expect(r.status, r.text).toBe(200);
    expect(r.body.igvEstimado).toMatchObject({ estado: "calculado", creditoDgng: "0.00", resultado: "-2000.00", situacion: "saldo_a_favor" });
  });

  it("cero: IGV de ventas 1.800,00 − crédito DG 1.800,00 = 0.00", async () => {
    const c = await nuevoCliente();
    await sembrarCA1(c);
    await v.sembrarVentasSire(E.tenantId, c.id, M, [facturaVenta("F001", 1, "10000.00", "1800.00")], u());
    await sembrarComprasM(c, [{ destino: "DG", bi: "10000.00", igv: "1800.00" }]);
    const r = await ver(contador, c, M);
    expect(r.status, r.text).toBe(200);
    expect(r.body.igvEstimado).toMatchObject({ estado: "calculado", resultado: "0.00", situacion: "cero" });
  });

  it("solo compras DNG: no dan crédito (creditoDg y creditoDgng en 0.00) y el resultado es el IGV de ventas", async () => {
    const c = await nuevoCliente();
    await sembrarCA1(c);
    await v.sembrarVentasSire(E.tenantId, c.id, M, [facturaVenta("F001", 1, "10000.00", "1800.00")], u());
    await sembrarComprasM(c, [{ destino: "DNG", bi: "5000.00", igv: "900.00" }]);
    const r = await ver(contador, c, M);
    expect(r.body.igvEstimado).toEqual({
      estado: "calculado",
      igvVentas: "1800.00",
      creditoDg: "0.00",
      igvDgng: "0.00",
      creditoDgng: "0.00",
      igvDng: "900.00",
      resultado: "1800.00",
      situacion: "a_pagar",
      estadoPeriodoCompras: "abierto",
    });
  });

  it.each([
    ["1050.00", "880.85"], // 1.050,00 × 0,8389 = 880,845 exacto: sube (mitad hacia arriba)
    ["1044.91", "876.57"], // 1.044,91 × 0,8389 = 876,574999…: baja
  ])("redondeo del crédito DGNG en el tercer decimal: IGV DGNG %s × 83,89 %% = %s", async (igvDgng, esperado) => {
    const c = await nuevoCliente();
    await sembrarCA1(c);
    await v.sembrarVentasSire(E.tenantId, c.id, M, [facturaVenta("F001", 1, "10000.00", "1800.00")], u());
    await sembrarComprasM(c, [{ destino: "DGNG", bi: "5000.00", igv: igvDgng }]);
    const r = await ver(contador, c, M);
    expect(r.body.igvEstimado).toMatchObject({ estado: "calculado", igvDgng, creditoDgng: esperado });
  });

  it("reclasificar una compra de DG a DGNG cambia el resultado en la lectura siguiente (15.720,00 -> 16.203,30)", async () => {
    const c = await nuevoCliente();
    await sembrarCA1(c);
    await v.sembrarVentasSire(E.tenantId, c.id, M, ventasM(), u());
    const [id] = await sembrarComprasM(c, [{ destino: "DG", bi: "16666.67", igv: "3000.00" }]);
    const antes = await ver(contador, c, M);
    expect(antes.body.igvEstimado).toMatchObject({ creditoDg: "3000.00", igvDgng: "0.00", creditoDgng: "0.00", resultado: "15720.00" });
    const clasificar = await v.llamar(E.titular, "POST", `${rutaComprasPeriodo(c.id, M)}/${id}/clasificar`, { versionBase: 1, destino: "DGNG" });
    expect(clasificar.status, clasificar.text).toBe(200);
    const despues = await ver(contador, c, M);
    // 3.000,00 × 0,8389 = 2.516,70 de crédito DGNG; resultado = 18.720,00 − 0,00 − 2.516,70.
    expect(despues.body.igvEstimado).toMatchObject({ creditoDg: "0.00", igvDgng: "3000.00", creditoDgng: "2516.70", resultado: "16203.30", situacion: "a_pagar" });
  });

  it.each(["abierto", "revisado", "generado"] as const)("informa el estado del periodo de compras de M: %s", async (estado) => {
    const c = await nuevoCliente();
    await sembrarCA1(c);
    await v.sembrarVentasSire(E.tenantId, c.id, M, [facturaVenta("F001", 1, "100.00", "18.00")], u());
    await sembrarComprasM(c, [{ destino: "DG", bi: "100.00", igv: "18.00" }]);
    if (estado !== "abierto") await v.estadoPeriodo(E.tenantId, c.id, M, estado, u());
    const r = await ver(contador, c, M);
    expect(r.body.igvEstimado).toMatchObject({ estado: "calculado", estadoPeriodoCompras: estado });
  });

  it("un periodo de ventas cargado SIN filas cuenta como cargado: IGV de ventas 0.00 y se estima", async () => {
    const c = await nuevoCliente();
    await sembrarCA1(c);
    await v.sembrarVentasVacias(E.tenantId, c.id, M, u());
    await sembrarComprasM(c, [{ destino: "DG", bi: "100.00", igv: "18.00" }]);
    const r = await ver(contador, c, M);
    expect(r.body.igvEstimado).toMatchObject({ estado: "calculado", igvVentas: "0.00", creditoDg: "18.00", resultado: "-18.00", situacion: "saldo_a_favor" });
  });

  it("sin periodo de ventas de M cargado: no se estima y se dice que faltan las ventas", async () => {
    const c = await nuevoCliente();
    await sembrarCA1(c);
    await sembrarComprasM(c, [{ destino: "DG", bi: "100.00", igv: "18.00" }]);
    const r = await ver(contador, c, M);
    expect(r.status, r.text).toBe(200);
    expect(r.body.coeficiente).toMatchObject({ estado: "calculado" });
    expect(r.body.igvEstimado).toEqual({ estado: "no_estimable", motivo: "sin_ventas" });
  });

  it("sin periodo de compras de M cargado: no se estima y se dice que faltan las compras", async () => {
    const c = await nuevoCliente();
    await sembrarCA1(c);
    await v.sembrarVentasSire(E.tenantId, c.id, M, [facturaVenta("F001", 1, "100.00", "18.00")], u());
    const r = await ver(contador, c, M);
    expect(r.status, r.text).toBe(200);
    expect(r.body.igvEstimado).toEqual({ estado: "no_estimable", motivo: "sin_compras" });
  });

  it("sin ninguno de los dos periodos: no se estima y el motivo es uno de los dos faltantes", async () => {
    const c = await nuevoCliente();
    await sembrarCA1(c);
    const r = await ver(contador, c, M);
    expect(r.status, r.text).toBe(200);
    expect(["sin_ventas", "sin_compras"]).toContain(r.body.igvEstimado.motivo);
    expect(r.body.igvEstimado.estado).toBe("no_estimable");
  });

  it("sin coeficiente (faltan meses) el IGV no se estima aunque las ventas y las compras de M estén cargadas: motivo coeficiente", async () => {
    const c = await nuevoCliente();
    await sembrarCA1(c, declaracionesCA1().filter((d) => d.periodo !== "202511"));
    await v.sembrarVentasSire(E.tenantId, c.id, M, [facturaVenta("F001", 1, "100.00", "18.00")], u());
    await sembrarComprasM(c, [{ destino: "DG", bi: "100.00", igv: "18.00" }]);
    const r = await ver(contador, c, M);
    expect(r.body.coeficiente).toEqual({ estado: "faltan_meses", faltantes: ["202511"] });
    expect(r.body.igvEstimado).toEqual({ estado: "no_estimable", motivo: "coeficiente" });
  });

  it("el IGV estimado es el de M aunque M no sea el último mes con datos: las ventas y compras de OTROS periodos no entran", async () => {
    const c = await nuevoCliente();
    await sembrarCA1(c);
    await v.sembrarVentasSire(E.tenantId, c.id, M, [facturaVenta("F001", 1, "10000.00", "1800.00")], u());
    await v.sembrarVentasSire(E.tenantId, c.id, "202609", [facturaVenta("F001", 2, "99999.00", "17999.82")], u());
    await sembrarComprasM(c, [{ destino: "DG", bi: "1000.00", igv: "180.00" }]);
    await v.sembrarCompra(E.tenantId, c.id, { periodo: "202609", serie: "F099", numero: "1", usuarioId: u(), montos: montosCompra("DG", "5000.00", "900.00") });
    const r = await ver(contador, c, M);
    expect(r.body.igvEstimado).toMatchObject({ estado: "calculado", igvVentas: "1800.00", creditoDg: "180.00", resultado: "1620.00" });
  });
});

// --- Cliente archivado y datos ajenos ----------------------------------------------------------------------------------------------------

describe("lectura con el cliente archivado y con ids ajenos", () => {
  it("un cliente archivado se puede leer (200): archivar solo bloquea las escrituras (D-5)", async () => {
    const c = await nuevoCliente();
    await sembrarCA1(c);
    await v.archivar(c.id);
    const r = await ver(contador, c, M);
    expect(r.status, r.text).toBe(200);
    expect(r.body.coeficiente.porcentaje).toBe(CA1.porcentaje);
  });

  it("un cliente inexistente da 404 no_encontrado", async () => {
    const control = await ver(contador, await nuevoCliente(), M); // la ruta existe: el 404 de abajo no es «ruta inexistente»
    expect(control.status, control.text).toBe(200);
    const r = await v.http(contador, "GET", rutaVista("00000000-0000-4000-8000-000000000000", M));
    expect(r.status, r.text).toBe(404);
    expect(r.body).toEqual(NO_ENCONTRADO);
  });
});
