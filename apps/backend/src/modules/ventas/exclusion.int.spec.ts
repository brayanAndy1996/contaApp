/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 012b (T6, rojo): excluir y restaurar ventas del SIRE con error de fila (D12, P-8; CA-15, CA-16). Contrato (plan 012b,
// «Contratos: HTTP»; `excluirVentaSchema` y `restaurarVentaSchema` de shared):
//  - `POST …/ventas/:ventaId/excluir` { motivo } (`sire.clasificar`; con el periodo `revisado` además `sire.aprobar_generar`) -> 200
//    `VentaDto` con `exclusion { motivo, por, en }`. El motivo se recorta y queda de 1 a 200 caracteres sin controles; el cuerpo
//    es estricto. `POST …/ventas/:ventaId/restaurar` (cuerpo vacío estricto) -> 200 `VentaDto` con `exclusion: null`.
//  - Orden: 400 -> guards (permiso 403, cliente 404) -> 409 `cliente_archivado` -> bloqueo y estado (409 `periodo_generado`,
//    403 `periodo_revisado`) -> venta (404 `no_encontrado`: inexistente, mal formada, de otro estudio, cliente o periodo) -> regla
//    de D12 (409): `ya_excluida`, `no_excluible` (solo se excluye una venta de origen SIRE con al menos un error de su propia
//    fila), `no_excluida` al restaurar.
//  - Solo inserta en `venta_exclusion` (quién y cuándo) y cierra la vigente al restaurar (nada se borra; se puede volver a excluir).
//    La fila de `venta` no cambia. Dos exclusiones simultáneas de la misma venta dejan una sola vigente.
//  - La excluida: sale del previo (ya no trae sus errores), no entra al TXT, cuenta en `resumen.excluidas` y en el impacto en IGV
//    (la USD sin tipo de cambio, en `filasSinConvertir`), se lista en `excluidas[]` con comprobante y motivo, sigue contando como
//    presente en la correlatividad y no suma en el resumen de ventas (RF-056), que la cuenta en `excluidas`. La grilla la lista
//    con su `exclusion`. Excluir o restaurar cambia la huella del previo; restaurar la devuelve a la de antes.
// Rojo: las rutas de excluir y restaurar, las tablas y el módulo `archivos` aún no existen (T10, T12 y T13).
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBancoCompras, PERIODO, type Actor, type BancoCompras, type Estudio } from "../../../test/soporte-compras.js";
import { abrirArchivos, cumple, descuadrada, HEX64, rutaArchivos, usdSinTc, type SoporteArchivos } from "../../../test/soporte-archivos.js";
import { base, boletas290y292, centavos, fila, type FilaV } from "../../../test/soporte-ventas.js";
import { capturarLogs } from "../../../test/soporte.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let v: BancoCompras;
let A: SoporteArchivos;
let E: Estudio;
let F: Estudio;
let contador: Actor;
let asistente: Actor;
let lectura: Actor;
let asistenteAjeno: Actor;

beforeAll(async () => {
  v = await abrirBancoCompras();
  A = await abrirArchivos(v);
  E = await v.estudio();
  F = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
  lectura = await p.miembro(E.tenantId, "lectura");
  asistenteAjeno = await p.miembro(E.tenantId, "asistente");
});
afterAll(async () => {
  await A?.cerrar();
  await v?.cerrar();
});

type Cliente = { id: string; ruc: string };
const u = (): string => E.titular.id;
const MOTIVO = "Llegó descuadrada del SIRE: se corrige en facturación";
const COLUMNAS_DTO = [
  "baseGravada",
  "cuadra",
  "docContraparte",
  "exclusion",
  "exonerada",
  "fechaEmision",
  "icbper",
  "id",
  "igv",
  "inafecta",
  "isc",
  "moneda",
  "numero",
  "origen",
  "otros",
  "serie",
  "tipo",
  "tipoCambio",
  "tipoDocContraparte",
  "total",
];

async function conVentas(filas: FilaV[], o: Parameters<BancoCompras["cliente"]>[1] = {}): Promise<{ c: Cliente; ids: string[] }> {
  const c = await v.cliente(E, { responsable: contador.id, colaboradores: [asistente.id, lectura.id], ...o });
  const ids = await v.sembrarVentas(E.tenantId, c.id, filas, { usuarioId: u() });
  return { c, ids };
}
/** B001-290, B001-292 (falta la 291), D001-1 descuadrada (ids[2]) y U001-1 en USD sin tipo de cambio (ids[3]). */
const completo = (o: Parameters<BancoCompras["cliente"]>[1] = {}) =>
  conVentas([...boletas290y292(), descuadrada("D001", 1), usdSinTc("U001", 1)], o);

const excluir = (a: Actor, c: { id: string }, ventaId: string, cuerpo: unknown = { motivo: MOTIVO }, periodo = PERIODO) =>
  v.llamar(a, "POST", `${base(c.id, periodo)}/${ventaId}/excluir`, cuerpo);
const restaurar = (a: Actor, c: { id: string }, ventaId: string, cuerpo: unknown = {}, periodo = PERIODO) =>
  v.llamar(a, "POST", `${base(c.id, periodo)}/${ventaId}/restaurar`, cuerpo);
const previo = (a: Actor, c: { id: string }) => v.llamar(a, "GET", `${rutaArchivos(c.id, PERIODO, "ventas")}/previo`);
const previoOk = async (...args: Parameters<typeof previo>) => {
  const r = await previo(...args);
  expect(r.status, r.text).toBe(200);
  return r;
};
const resumenOk = async (...args: Parameters<typeof resumen>) => {
  const r = await resumen(...args);
  expect(r.status, r.text).toBe(200);
  return r;
};
const generar = (a: Actor, c: { id: string }, cuerpo: unknown) => v.llamar(a, "POST", rutaArchivos(c.id, PERIODO, "ventas"), cuerpo);
const resumen = (a: Actor, c: { id: string }) => v.llamar(a, "GET", `${base(c.id)}/resumen`);

// --- CA-15 · excluir ----------------------------------------------------------------------------------------------------------

describe("CA-15 · excluir una venta del SIRE con error", () => {
  it("200 con el VentaDto y su exclusión {motivo recortado, por, en}; la fila de venta no cambia", async () => {
    const { c, ids } = await completo();
    const antes = await v.ventas(c.id);
    const r = await excluir(asistente, c, ids[2]!, { motivo: `  ${MOTIVO}  ` });
    expect(r.status, r.text).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(COLUMNAS_DTO);
    expect(r.body).toMatchObject({ id: ids[2], origen: "sire", serie: "D001", numero: "1", total: "119.00", cuadra: false });
    expect(r.body.exclusion).toEqual({ motivo: MOTIVO, por: asistente.id, en: expect.any(String) });
    expect(Number.isNaN(Date.parse(r.body.exclusion.en))).toBe(false);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(await v.ventas(c.id)).toEqual(antes); // venta es inmutable (013 D4)
    const filas = await A.exclusiones(c.id);
    expect(filas).toEqual([
      expect.objectContaining({ venta_id: ids[2], motivo: MOTIVO, excluida_por: asistente.id, restaurada_por: null, restaurada: false }),
    ]);
    // Excluir no cambia el estado del periodo. Como toda escritura de ventas (y como las de compras, 014), toma la fila de
    // `venta_periodo` (la crea `abierto` si falta) para que «revisar» espere a la escritura (ronda 1, H-012b-1): sin marca.
    expect(await A.periodoVentas(c.id)).toEqual({ estado: "abierto", marcado_por: null });
  });

  it("también excluye la USD sin tipo de cambio y quien tiene sire.aprobar_generar (contador, Dueño)", async () => {
    const { c, ids } = await completo();
    expect((await excluir(contador, c, ids[3]!)).status).toBe(200);
    expect((await excluir(E.titular, c, ids[2]!)).status).toBe(200);
    expect((await A.exclusiones(c.id)).map((x) => x.excluida_por).sort()).toEqual([contador.id, E.titular.id].sort());
  });

  it("CA-15: las dos excluidas dejan el previo apto, con excluidas = 2, el impacto de la descuadrada y la USD en filasSinConvertir", async () => {
    const { c, ids } = await completo();
    const antes = await previoOk(contador, c);
    expect(antes.body).toMatchObject({ apto: false, generable: false, motivo: "prevalidacion_fallida" });
    expect(antes.body.errores.map((e: any) => [e.filaId, e.codigo, e.excluible]).sort()).toEqual(
      [
        [ids[2], "CUADRE", true],
        [ids[3], "USD_SIN_TC", true],
      ].sort(),
    );
    expect((await excluir(contador, c, ids[2]!, { motivo: "Descuadrada en el SIRE" })).status).toBe(200);
    expect((await excluir(contador, c, ids[3]!, { motivo: "USD sin tipo de cambio en el SIRE" })).status).toBe(200);

    const r = await previoOk(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(cumple("previoArchivoSchema", r.body), r.text).toBe(true);
    expect(r.body).toMatchObject({ apto: true, generable: true, motivo: null, errores: [], erroresOmitidos: 0 });
    expect(r.body.resumen).toEqual({
      modificadas: 0,
      excluidas: 2,
      agregadas: 0,
      impactoIgv: { DG: null, DGNG: null, DNG: null, total: "-18.00" }, // el IGV de la descuadrada; la USD no se convierte
      filasSinConvertir: [ids[3]],
    });
    const lista = [...r.body.excluidas].sort((a: any, b: any) => a.comprobante.localeCompare(b.comprobante));
    expect(lista).toEqual([
      { filaId: ids[2], comprobante: "D001-1", motivo: "Descuadrada en el SIRE" },
      { filaId: ids[3], comprobante: "U001-1", motivo: "USD sin tipo de cambio en el SIRE" },
    ]);
    expect(r.body.excluidasOmitidas).toBe(0);
    // La boleta 291 sigue siendo un aviso, no un error.
    expect((r.body.avisos as any[]).some((a) => a.codigo === "SALTO_CORRELATIVIDAD" && a.explicacion.includes("B001-291"))).toBe(true);
  });

  it("solo una excluida: el previo conserva el otro error y sigue sin ser apto", async () => {
    const { c, ids } = await completo();
    expect((await excluir(contador, c, ids[2]!)).status).toBe(200);
    const r = await previoOk(contador, c);
    expect(r.body.apto).toBe(false);
    expect(r.body.errores.map((e: any) => e.codigo)).toEqual(["USD_SIN_TC"]);
    expect(r.body.resumen.excluidas).toBe(1);
    expect(r.body.excluidas).toEqual([{ filaId: ids[2], comprobante: "D001-1", motivo: MOTIVO }]);
  });

  it("con las excluidas el POST de generar se encola (202); la versión la crea el worker", async () => {
    const { c, ids } = await completo();
    await excluir(contador, c, ids[2]!);
    await excluir(contador, c, ids[3]!);
    const p = await previoOk(contador, c);
    const g = await generar(contador, c, { estadoVisto: "abierto", huella: p.body.huella });
    expect(g.status, g.text).toBe(202);
    expect((await A.trabajosArchivo(c.id)).map((t) => t.parametros.libro)).toEqual(["ventas"]);
  });

  it("si todas las filas del periodo están excluidas, el previo da SIN_FILAS", async () => {
    const { c, ids } = await conVentas([descuadrada("D001", 1)]);
    expect((await excluir(contador, c, ids[0]!)).status).toBe(200);
    const r = await previoOk(contador, c);
    expect(r.body.apto).toBe(false);
    expect(r.body.errores).toEqual([expect.objectContaining({ codigo: "SIN_FILAS", filaId: null })]);
    expect(r.body.resumen.excluidas).toBe(1);
  });

  it("RF-056: el resumen de ventas no suma la excluida y la cuenta en excluidas", async () => {
    const { c, ids } = await conVentas([...boletas290y292(), descuadrada("D001", 1)]);
    const antes = await resumenOk(contador, c);
    expect(antes.body.total).toMatchObject({ cantidad: 3, total: "296.00" });
    expect(antes.body.excluidas).toBe(0);
    expect((await excluir(contador, c, ids[2]!)).status).toBe(200);
    const r = await resumenOk(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(cumple("resumenVentasSchema", r.body), r.text).toBe(true);
    expect(r.body.excluidas).toBe(1);
    expect(r.body.total).toMatchObject({ cantidad: 2, total: "177.00", baseGravada: "150.00", igv: "27.00" });
    expect(r.body.porTipo).toEqual([expect.objectContaining({ tipo: "03", cantidad: 2, total: "177.00" })]);
    expect(centavos(antes.body.total.total) - centavos(r.body.total.total)).toBe(11900n);
  });

  it("la grilla la lista con su exclusión y las demás con exclusion = null; el total de filas las cuenta", async () => {
    const { c, ids } = await conVentas([...boletas290y292(), descuadrada("D001", 1)]);
    const r0 = await v.llamar(contador, "GET", `${base(c.id)}?tamano=todas`);
    expect(r0.body.filas.every((f: any) => f.exclusion === null)).toBe(true);
    await excluir(asistente, c, ids[2]!);
    const r = await v.llamar(contador, "GET", `${base(c.id)}?tamano=todas`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.total).toBe(3);
    const por = Object.fromEntries(r.body.filas.map((f: any) => [f.id, f]));
    expect(por[ids[2]!].exclusion).toEqual({ motivo: MOTIVO, por: asistente.id, en: expect.any(String) });
    expect(por[ids[0]!].exclusion).toBeNull();
    expect(por[ids[1]!].exclusion).toBeNull();
    for (const f of r.body.filas) expect(Object.keys(f).sort()).toEqual(COLUMNAS_DTO);
  });

  it("una excluida sigue contando como presente en la correlatividad (013 D7): sin faltantes y sin aviso de salto", async () => {
    const { c, ids } = await conVentas([fila("B001", 290), descuadrada("B001", 291), fila("B001", 292)]);
    expect((await excluir(contador, c, ids[1]!)).status).toBe(200);
    const corr = await v.llamar(contador, "GET", `${base(c.id)}/correlatividad`);
    const serie = (corr.body.series as any[]).find((s) => s.serie === "B001");
    expect(serie.faltantes).toEqual([]);
    expect(serie.estado).toBe("completa");
    const p = await previoOk(contador, c);
    expect((p.body.avisos as any[]).filter((a) => a.codigo === "SALTO_CORRELATIVIDAD")).toEqual([]);
    expect(p.body).toMatchObject({ apto: true });
  });

  it("un motivo con HTML, «|» y emoji se guarda y se devuelve verbatim (texto no confiable: se escapa al mostrar)", async () => {
    const { c, ids } = await conVentas([descuadrada("D001", 1)]);
    const motivo = "<script>alert(1)</script> | línea 😀";
    const r = await excluir(contador, c, ids[0]!, { motivo });
    expect(r.status, r.text).toBe(200);
    expect(r.body.exclusion.motivo).toBe(motivo);
    expect((await previoOk(contador, c)).body.excluidas[0].motivo).toBe(motivo);
  });

  it("el motivo no se registra en los logs", async () => {
    const { c, ids } = await completo();
    const canario = `CANARIO-MOTIVO-${randomBytes(6).toString("hex")}`;
    const { resultado, logs } = await capturarLogs(async () => {
      const e = await excluir(contador, c, ids[2]!, { motivo: canario });
      const p = await previoOk(contador, c);
      return { e, p };
    });
    expect(resultado.e.status, resultado.e.text).toBe(200);
    expect(resultado.p.status).toBe(200);
    expect(logs).not.toContain(canario);
  });
});

// --- Restaurar y huella --------------------------------------------------------------------------------------------------------

describe("CA-15 · restaurar la devuelve; el registro conserva quién excluyó y quién restauró", () => {
  it("200 con exclusion = null; el previo vuelve a dar su error y bloquea; el registro queda cerrado, no borrado", async () => {
    const { c, ids } = await conVentas([...boletas290y292(), descuadrada("D001", 1)]);
    expect((await excluir(asistente, c, ids[2]!)).status).toBe(200);
    expect((await previoOk(contador, c)).body.apto).toBe(true);
    const r = await restaurar(contador, c, ids[2]!);
    expect(r.status, r.text).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(COLUMNAS_DTO);
    expect(r.body).toMatchObject({ id: ids[2], total: "119.00" });
    expect(r.body.exclusion).toBeNull();
    const p = await previoOk(contador, c);
    expect(p.body).toMatchObject({ apto: false, generable: false, motivo: "prevalidacion_fallida", excluidas: [] });
    expect(p.body.errores).toEqual([expect.objectContaining({ filaId: ids[2], codigo: "CUADRE", excluible: true })]);
    expect(p.body.resumen.excluidas).toBe(0);
    expect(await A.exclusiones(c.id)).toEqual([
      expect.objectContaining({ venta_id: ids[2], excluida_por: asistente.id, restaurada_por: contador.id, restaurada: true }),
    ]);
    expect((await resumenOk(contador, c)).body).toMatchObject({ excluidas: 0, total: expect.objectContaining({ cantidad: 3 }) });
  });

  it("una venta restaurada se puede volver a excluir: dos registros, uno cerrado y uno vigente", async () => {
    const { c, ids } = await conVentas([descuadrada("D001", 1)]);
    await excluir(contador, c, ids[0]!, { motivo: "primera" });
    await restaurar(contador, c, ids[0]!);
    const r = await excluir(asistente, c, ids[0]!, { motivo: "segunda" });
    expect(r.status, r.text).toBe(200);
    expect(r.body.exclusion).toMatchObject({ motivo: "segunda", por: asistente.id });
    const filas = await A.exclusiones(c.id);
    expect(filas.map((f) => [f.motivo, f.restaurada])).toEqual([
      ["primera", true],
      ["segunda", false],
    ]);
  });

  it("P-2: excluir y restaurar cambian la huella del previo; restaurar la devuelve a la de antes", async () => {
    const { c, ids } = await conVentas([...boletas290y292(), descuadrada("D001", 1)]);
    const h0 = (await previoOk(contador, c)).body.huella as string;
    expect(h0).toMatch(HEX64);
    await excluir(contador, c, ids[2]!);
    const h1 = (await previoOk(contador, c)).body.huella as string;
    expect(h1).toMatch(HEX64);
    expect(h1).not.toBe(h0);
    await restaurar(contador, c, ids[2]!);
    expect((await previoOk(contador, c)).body.huella).toBe(h0);
  });

  it("CA-16: excluir entre el previo y el POST da 409 resumen_cambiado; con el previo nuevo, 202", async () => {
    const { c, ids } = await conVentas([...boletas290y292(), descuadrada("D001", 1)]);
    const viejo = (await previoOk(contador, c)).body.huella as string;
    expect((await excluir(contador, c, ids[2]!)).status).toBe(200);
    const r = await generar(contador, c, { estadoVisto: "abierto", huella: viejo });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "resumen_cambiado" });
    expect(await A.trabajosArchivo(c.id)).toEqual([]);
    const nuevo = (await previoOk(contador, c)).body;
    expect(nuevo.apto).toBe(true);
    expect((await generar(contador, c, { estadoVisto: "abierto", huella: nuevo.huella })).status).toBe(202);
  });

  it("CA-16: restaurar entre el previo y el POST también da 409 resumen_cambiado", async () => {
    const { c, ids } = await conVentas([...boletas290y292(), descuadrada("D001", 1)]);
    await excluir(contador, c, ids[2]!);
    const viejo = (await previoOk(contador, c)).body.huella as string;
    expect((await restaurar(contador, c, ids[2]!)).status).toBe(200);
    const r = await generar(contador, c, { estadoVisto: "abierto", huella: viejo });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "resumen_cambiado" });
    expect(await A.trabajosArchivo(c.id)).toEqual([]);
  });
});

// --- CA-16 · rechazos -------------------------------------------------------------------------------------------------------------

describe("CA-16 · 400 solicitud_invalida", () => {
  const MALOS: [string, unknown][] = [
    ["sin motivo", {}],
    ["motivo vacío", { motivo: "" }],
    ["solo espacios", { motivo: "   " }],
    ["201 caracteres", { motivo: "x".repeat(201) }],
    ["201 caracteres tras recortar", { motivo: ` ${"x".repeat(201)} ` }],
    ["motivo con NUL", { motivo: "malo\u0000malo" }],
    ["motivo con control", { motivo: "malo\u0007malo" }],
    ["motivo no cadena (número)", { motivo: 5 }],
    ["motivo no cadena (lista)", { motivo: ["x"] }],
    ["motivo null", { motivo: null }],
    ["clave extra ventaId", { motivo: "ok", ventaId: randomUUID() }],
    ["clave extra tenantId", { motivo: "ok", tenantId: randomUUID() }],
    ["clave extra usuarioId", { motivo: "ok", usuarioId: randomUUID() }],
    ["clave extra versionBase", { motivo: "ok", versionBase: 1 }],
  ];

  it.each(MALOS)("excluir %s: 400 y no se escribe nada", async (_nombre, cuerpo) => {
    const { c, ids } = await completo();
    const r = await excluir(contador, c, ids[2]!, cuerpo);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await A.exclusiones(c.id)).toEqual([]);
  });

  it("200 caracteres (y 200 tras recortar) sí pasan", async () => {
    const { c, ids } = await completo();
    const r = await excluir(contador, c, ids[2]!, { motivo: ` ${"x".repeat(200)} ` });
    expect(r.status, r.text).toBe(200);
    expect(r.body.exclusion.motivo).toBe("x".repeat(200));
  });

  it.each([{ motivo: "x" }, { ventaId: randomUUID() }, { versionBase: 1 }, { a: 1 }])("restaurar con el cuerpo %j: 400 y la exclusión sigue vigente", async (cuerpo) => {
    const { c, ids } = await completo();
    await excluir(contador, c, ids[2]!);
    const r = await restaurar(contador, c, ids[2]!, cuerpo);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await A.exclusiones(c.id)).toEqual([expect.objectContaining({ restaurada: false })]);
  });

  it("el 400 va antes que el 404 de la venta: motivo vacío sobre un id inexistente es 400", async () => {
    const { c } = await completo();
    const r = await excluir(contador, c, randomUUID(), { motivo: "" });
    expect(r.status, r.text).toBe(400);
  });
});

describe("CA-16 · 403 permiso y 404 alcance", () => {
  it("la lectura no excluye ni restaura (403 permiso_denegado) y nada cambia", async () => {
    const { c, ids } = await completo();
    await excluir(contador, c, ids[3]!);
    const antes = await A.exclusiones(c.id);
    for (const r of [await excluir(lectura, c, ids[2]!), await restaurar(lectura, c, ids[3]!)]) {
      expect(r.status, r.text).toBe(403);
      expect(r.body).toEqual({ codigo: "permiso_denegado" });
    }
    expect(await A.exclusiones(c.id)).toEqual(antes);
  });

  it("el asistente con sire.clasificar excluye y restaura (periodo abierto)", async () => {
    const { c, ids } = await completo();
    expect((await excluir(asistente, c, ids[2]!)).status).toBe(200);
    expect((await restaurar(asistente, c, ids[2]!)).status).toBe(200);
  });

  it("el asistente no asignado recibe el mismo 404 que un cliente inexistente", async () => {
    const { c, ids } = await completo({ colaboradores: [] });
    const r = await excluir(asistenteAjeno, c, ids[2]!);
    expect(r.status, r.text).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(r.body).toEqual((await excluir(asistenteAjeno, { id: randomUUID() }, ids[2]!)).body);
    expect((await restaurar(asistenteAjeno, c, ids[2]!)).status).toBe(404);
    expect(await A.exclusiones(c.id)).toEqual([]);
  });

  it("un ventaId inexistente o mal formado: 404 no_encontrado", async () => {
    const { c, ids } = await completo();
    expect((await excluir(contador, c, ids[2]!)).status).toBe(200); // control: la ruta existe
    for (const id of [randomUUID(), "abc", "..", "' or 1=1 --", "00000000-0000-0000-0000-000000000000"]) {
      for (const llamar of [excluir, restaurar]) {
        const r = await llamar(contador, c, id);
        expect(r.status, `${id}: ${r.text}`).toBe(404);
        expect(r.body).toEqual({ codigo: "no_encontrado" });
      }
    }
  });

  it("la venta de otro cliente del mismo estudio es 404 (también para el Dueño) y no deja exclusión", async () => {
    const a = await completo();
    const b = await completo();
    for (const actor of [E.titular, contador]) {
      const r = await excluir(actor, b.c, a.ids[2]!);
      expect(r.status, `${actor.rol}: ${r.text}`).toBe(404);
      expect(r.body).toEqual({ codigo: "no_encontrado" });
    }
    await excluir(contador, a.c, a.ids[2]!); // control: bajo su cliente sí
    expect((await restaurar(contador, b.c, a.ids[2]!)).status).toBe(404);
    expect(await A.exclusiones(b.c.id)).toEqual([]);
    expect(await A.exclusiones(a.c.id)).toEqual([expect.objectContaining({ restaurada: false })]);
  });

  it("la venta de otro periodo es 404: el id de 202610 bajo la ruta de 202609", async () => {
    const { c, ids } = await completo();
    const r = await excluir(contador, c, ids[2]!, { motivo: MOTIVO }, "202609");
    expect(r.status, r.text).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect((await restaurar(contador, c, ids[2]!, {}, "202609")).status).toBe(404);
    expect(await A.exclusiones(c.id)).toEqual([]);
  });

  it("otro estudio: la venta de E es 404 para el Dueño de F, con el cliente de E o con uno de F", async () => {
    const { c, ids } = await completo();
    const propio = await v.cliente(F);
    for (const cliente of [c, propio]) {
      const r = await excluir(F.titular, cliente, ids[2]!);
      expect(r.status, r.text).toBe(404);
      expect(r.body).toEqual({ codigo: "no_encontrado" });
    }
    expect(await A.exclusiones(c.id)).toEqual([]);
  });

  it("sin sesión: 401", async () => {
    const { c, ids } = await completo();
    expect((await v.sinSesion("POST", `${base(c.id)}/${ids[2]}/excluir`, { motivo: MOTIVO })).status).toBe(401);
    expect((await v.sinSesion("POST", `${base(c.id)}/${ids[2]}/restaurar`, {})).status).toBe(401);
    expect(await A.exclusiones(c.id)).toEqual([]);
  });
});

describe("CA-16 · 409 de la regla de D12 y de cliente y estado", () => {
  it("una venta sin error no es excluible: 409 no_excluible", async () => {
    const { c, ids } = await completo();
    const r = await excluir(contador, c, ids[0]!);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "no_excluible" });
    expect(await A.exclusiones(c.id)).toEqual([]);
  });

  it("una venta agregada a mano no es excluible, tenga error o no (se quita, 013 D23)", async () => {
    const { c } = await completo();
    const [limpia, conError] = await v.sembrarVentas(
      E.tenantId,
      c.id,
      [fila("M001", 1), fila("M002", 1, { igv: "17.00", total: "117.00" })],
      { usuarioId: u(), origen: "manual" },
    );
    for (const id of [limpia!, conError!]) {
      const r = await excluir(contador, c, id);
      expect(r.status, r.text).toBe(409);
      expect(r.body).toEqual({ codigo: "no_excluible" });
    }
    expect(await A.exclusiones(c.id)).toEqual([]);
  });

  it("excluir una ya excluida: 409 ya_excluida y sigue una sola vigente", async () => {
    const { c, ids } = await completo();
    expect((await excluir(contador, c, ids[2]!)).status).toBe(200);
    const r = await excluir(asistente, c, ids[2]!, { motivo: "otra vez" });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "ya_excluida" });
    expect(await A.exclusiones(c.id)).toHaveLength(1);
  });

  it("restaurar una no excluida (o ya restaurada): 409 no_excluida", async () => {
    const { c, ids } = await completo();
    const a = await restaurar(contador, c, ids[2]!);
    expect(a.status, a.text).toBe(409);
    expect(a.body).toEqual({ codigo: "no_excluida" });
    await excluir(contador, c, ids[2]!);
    expect((await restaurar(contador, c, ids[2]!)).status).toBe(200);
    const b = await restaurar(contador, c, ids[2]!);
    expect(b.status, b.text).toBe(409);
    expect(b.body).toEqual({ codigo: "no_excluida" });
    // También una venta sin error que nunca estuvo excluida.
    expect((await restaurar(contador, c, ids[0]!)).body).toEqual({ codigo: "no_excluida" });
  });

  it("cliente archivado: excluir y restaurar son 409 cliente_archivado y no cambian nada", async () => {
    const { c, ids } = await completo();
    await excluir(contador, c, ids[3]!);
    await v.b.sql("update cliente set archivado_at = now() where id = $1", [c.id]);
    const antes = await A.exclusiones(c.id);
    for (const r of [await excluir(contador, c, ids[2]!), await restaurar(contador, c, ids[3]!)]) {
      expect(r.status, r.text).toBe(409);
      expect(r.body).toEqual({ codigo: "cliente_archivado" });
    }
    expect(await A.exclusiones(c.id)).toEqual(antes);
  });

  it("orden: cliente archivado va antes que el 404 de la venta; el estado, antes que el 404 y que la regla de D12", async () => {
    const archivado = await completo({ archivado: true });
    expect((await excluir(contador, archivado.c, randomUUID())).body).toEqual({ codigo: "cliente_archivado" });

    const generado = await completo();
    await A.estadoVentas(E.tenantId, generado.c.id, PERIODO, "generado", contador.id);
    expect((await excluir(contador, generado.c, randomUUID())).body).toEqual({ codigo: "periodo_generado" });
    expect((await excluir(contador, generado.c, generado.ids[0]!)).body).toEqual({ codigo: "periodo_generado" }); // sin error: no_excluible no gana
    expect((await restaurar(contador, generado.c, generado.ids[0]!)).body).toEqual({ codigo: "periodo_generado" });

    const revisado = await completo();
    await A.estadoVentas(E.tenantId, revisado.c.id, PERIODO, "revisado", contador.id);
    const r = await excluir(asistente, revisado.c, randomUUID());
    expect(r.status, r.text).toBe(403);
    expect(r.body).toEqual({ codigo: "periodo_revisado" });
    expect((await excluir(contador, revisado.c, revisado.ids[2]!)).status).toBe(200); // con sire.aprobar_generar sí
    expect(await A.exclusiones(generado.c.id)).toEqual([]);
  });
});

describe("CA-16 · concurrencia", () => {
  it("cuatro exclusiones simultáneas de la misma venta: una sola gana (200) y las demás son 409 ya_excluida; una vigente", async () => {
    const { c, ids } = await completo();
    const rs = await Promise.all([contador, asistente, E.titular, contador].map((a, i) => excluir(a, c, ids[2]!, { motivo: `carrera ${i}` })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    for (const r of rs.filter((x) => x.status === 409)) expect(r.body).toEqual({ codigo: "ya_excluida" });
    const filas = await A.exclusiones(c.id);
    expect(filas).toHaveLength(1);
    expect(filas[0]!.restaurada).toBe(false);
    expect(rs.find((r) => r.status === 200)!.body.exclusion.motivo).toBe(filas[0]!.motivo);
  });

  it("dos restauraciones simultáneas: una gana (200) y la otra es 409 no_excluida; el registro se cierra una sola vez", async () => {
    const { c, ids } = await completo();
    await excluir(contador, c, ids[2]!);
    const rs = await Promise.all([restaurar(contador, c, ids[2]!), restaurar(asistente, c, ids[2]!)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(rs.find((r) => r.status === 409)!.body).toEqual({ codigo: "no_excluida" });
    expect(await A.exclusiones(c.id)).toEqual([expect.objectContaining({ restaurada: true })]);
  });

  it("excluir y restaurar a la vez dejan un estado coherente: o excluida, o restaurada, nunca dos vigentes", async () => {
    const { c, ids } = await completo();
    await excluir(contador, c, ids[2]!);
    const rs = await Promise.all([restaurar(contador, c, ids[2]!), excluir(asistente, c, ids[2]!, { motivo: "otra" })]);
    for (const r of rs) expect([200, 409]).toContain(r.status);
    const vigentes = (await A.exclusiones(c.id)).filter((f) => !f.restaurada);
    expect(vigentes.length).toBeLessThanOrEqual(1);
  });
});
