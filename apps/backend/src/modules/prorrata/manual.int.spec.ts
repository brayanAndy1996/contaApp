/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 026 (T6, rojo): mes manual, su historial y su eliminación (RF-133, R-5, R-6, D-4, D-5, D-6, D-7; CA-4, CA-9, CA-10).
// Contrato (plan 026, «Contratos: HTTP» y «shared»; `guardarMesManualSchema` y `eliminarMesManualSchema` de `@contapp/shared`):
//  - `PUT /clientes/:clienteId/prorrata/meses/:periodo` (`prorrata.gestionar`) con `{gravadas, exportaciones, noGravadas, motivo, version}`
//    (`.strict()`; montos cadenas decimales con signo y hasta 2 decimales dentro de NUMERIC(14,2); `motivo` 1..500 sin controles ni bidi;
//    `version` entero >= 0 = última versión del mes, 0 si nunca tuvo manual, una versión «eliminado» también cuenta) -> 200 `{version}` (la
//    nueva = `version + 1`). Compare-and-set: otra versión -> 409 `mes_cambiado`; mes con declaración (PDT) -> 409 `mes_declarado` (se mira
//    ANTES que la versión: plan, `CA412` y luego `CA409`); cliente archivado -> 409 `cliente_archivado`. Un mes SIRE sí admite manual (R-2b).
//  - `POST /clientes/:clienteId/prorrata/meses/:periodo/eliminar` con `{motivo, version >= 1}` -> 200 `{version}` (inserta la versión
//    `eliminado`); sin manual vivo o versión distinta -> 409 `mes_cambiado`. El mes vuelve a SIRE (periodo cargado) o a «falta».
//  - `GET /clientes/:clienteId/prorrata/meses/:periodo/historial` (`prorrata.ver`) -> 200 `{declaraciones: [...], manual: [{version, accion,
//    montos | null, motivo, autor: {id, nombre}, en}]}` con TODAS las versiones y presentaciones del mes.
//  - Auditoría D-6 (actor usuario, cliente, `{clienteId, periodo, version}` y nada más): `prorrata.mes_manual_guardado` y
//    `prorrata.mes_manual_eliminado`. Montos y motivo quedan en las filas versionadas, NUNCA en la auditoría, los logs ni los errores (D-7).
//  - Todas: `Cache-Control: no-store`, errores `{codigo}`, cliente de otro estudio, no visible o inexistente = 404 igual.
// Rojo: las rutas aún no existen (T12): responden 404 de ruta inexistente. Las tablas y funciones son de T10.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { capturarLogs } from "../../../test/soporte.js";
import {
  abrirBancoProrrata,
  CANARIO,
  CANARIOS_TEXTO,
  cumple,
  declaracionesCA1,
  facturaVenta,
  M,
  NO_ENCONTRADO,
  rutaEliminar,
  rutaHistorial,
  rutaManual,
  rutaVista,
  type Actor,
  type BancoProrrata,
  type Estudio,
} from "../../../test/soporte-prorrata.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let v: BancoProrrata;
let E: Estudio;
let contador: Actor; // responsable del cliente: prorrata.gestionar
let lectura: Actor; // colaborador: solo prorrata.ver

beforeAll(async () => {
  v = await abrirBancoProrrata();
  E = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  lectura = await p.miembro(E.tenantId, "lectura");
});
afterAll(async () => {
  await v?.cerrar();
});

type Cliente = { id: string; ruc: string };
const nuevoCliente = (o: Parameters<typeof v.cliente>[1] = {}): Promise<Cliente> =>
  v.cliente(E, { responsable: contador.id, colaboradores: [lectura.id], ...o });
const u = (): string => E.titular.id;
const MONTOS = { gravadas: "1234.50", exportaciones: "0.00", noGravadas: "200.00" };
const cuerpo = (version: number, extra: Record<string, unknown> = {}) => ({ ...MONTOS, motivo: "Libro de ventas físico", version, ...extra });
const guardar = (a: Actor, c: { id: string }, periodo: string, body: unknown) => v.http(a, "PUT", rutaManual(c.id, periodo), body);
const eliminar = (a: Actor, c: { id: string }, periodo: string, body: unknown) => v.http(a, "POST", rutaEliminar(c.id, periodo), body);
const historial = (a: Actor, c: { id: string }, periodo: string) => v.http(a, "GET", rutaHistorial(c.id, periodo));
const vista = (a: Actor, c: { id: string }, periodo = M) => v.http(a, "GET", rutaVista(c.id, periodo));
const mesDe = (body: any, periodo: string): any => (body?.ventana ?? []).find((m: any) => m.periodo === periodo);
const P = "202601";

/** Una respuesta de error no lleva montos, motivo, RUC ni datos del cliente (D-7). */
function sinDatos(r: { text: string }, c: Cliente): void {
  for (const x of CANARIOS_TEXTO) expect(r.text).not.toContain(x);
  expect(r.text).not.toContain(c.ruc);
  expect(r.text).not.toMatch(/\d+\.\d{2}/);
}

// --- Guardar --------------------------------------------------------------------------------------------------------------------

describe("PUT …/prorrata/meses/:periodo · guardar el mes manual (CA-4)", () => {
  it("primera vez (version 0): 200 { version: 1 }, fila versionada con autor y motivo, y el mes sale «manual» con autor, motivo y fecha", async () => {
    const c = await nuevoCliente();
    const r = await guardar(contador, c, P, cuerpo(0));
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ version: 1 });
    expect(r.headers["cache-control"]).toMatch(/no-store/);

    const filas = await v.manualesBd(c.id, P);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      periodo: P,
      version: 1,
      accion: "guardado",
      gravadas: "1234.50",
      exportaciones: "0.00",
      no_gravadas: "200.00",
      motivo: "Libro de ventas físico",
      autor: contador.id,
    });

    const lectura1 = await vista(contador, c);
    expect(lectura1.status, lectura1.text).toBe(200);
    expect(cumple("prorrataVistaSchema", lectura1.body), lectura1.text).toBe(true);
    const mes = mesDe(lectura1.body, P);
    expect(mes).toMatchObject({ origen: "manual", gravadas: "1234.50", exportaciones: "0.00", noGravadas: "200.00", total: "1434.50", versionManual: 1, declaracion: null });
    expect(mes.manual).toMatchObject({ motivo: "Libro de ventas físico", autor: { id: contador.id, nombre: await v.nombreDe(contador.id) } });
    expect(Number.isNaN(Date.parse(mes.manual.guardadoEn))).toBe(false);
  });

  it("audita prorrata.mes_manual_guardado (actor usuario) con {clienteId, periodo, version} y nada más: sin montos ni motivo", async () => {
    const c = await nuevoCliente();
    expect((await guardar(contador, c, P, cuerpo(0, { motivo: CANARIO.motivo, gravadas: CANARIO.gravadas }))).status).toBe(200);
    const aud = (await v.auditoria026(E.tenantId)).filter((f) => f.cliente_id === c.id);
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({ accion: "prorrata.mes_manual_guardado", actor_tipo: "usuario", usuario_id: contador.id });
    expect(aud[0].datos).toEqual({ clienteId: c.id, periodo: P, version: 1 });
    expect(JSON.stringify(aud[0])).not.toContain(CANARIO.motivo);
    expect(JSON.stringify(aud[0])).not.toContain(CANARIO.gravadas);
  });

  it("segunda versión (version 1): 200 { version: 2 }; las dos filas quedan y la lectura muestra la última", async () => {
    const c = await nuevoCliente();
    expect((await guardar(contador, c, P, cuerpo(0))).body).toEqual({ version: 1 });
    const r = await guardar(contador, c, P, cuerpo(1, { gravadas: "500.00", motivo: "Corrección del libro" }));
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ version: 2 });
    expect((await v.manualesBd(c.id, P)).map((f) => [f.version, f.accion, f.gravadas, f.motivo])).toEqual([
      [1, "guardado", "1234.50", "Libro de ventas físico"],
      [2, "guardado", "500.00", "Corrección del libro"],
    ]);
    const mes = mesDe((await vista(contador, c)).body, P);
    expect(mes).toMatchObject({ gravadas: "500.00", versionManual: 2 });
    expect(mes.manual.motivo).toBe("Corrección del libro");
  });

  it("con montos en cero («sin operaciones») también se guarda y el mes se calcula como manual en 0.00 (R-6)", async () => {
    const c = await nuevoCliente();
    const r = await guardar(contador, c, P, { gravadas: "0.00", exportaciones: "0.00", noGravadas: "0.00", motivo: "Sin operaciones", version: 0 });
    expect(r.status, r.text).toBe(200);
    expect(mesDe((await vista(contador, c)).body, P)).toMatchObject({ origen: "manual", gravadas: "0.00", total: "0.00", versionManual: 1 });
  });

  it("acepta montos negativos (notas de crédito) y enteros o con un decimal; los guarda normalizados a 2 decimales", async () => {
    const c = await nuevoCliente();
    const r = await guardar(contador, c, P, { gravadas: "-500.00", exportaciones: "5", noGravadas: "123.4", motivo: "Ajuste", version: 0 });
    expect(r.status, r.text).toBe(200);
    expect(mesDe((await vista(contador, c)).body, P)).toMatchObject({ gravadas: "-500.00", exportaciones: "5.00", noGravadas: "123.40", total: "-371.60" });
  });

  it("el manual completa el coeficiente y lo deja «provisional» (CA-4): el mes que faltaba entra con sus montos", async () => {
    const c = await nuevoCliente();
    await v.sembrarDeclaraciones(E.tenantId, c.id, declaracionesCA1().filter((d) => d.periodo !== "202511"), { periodoHasta: M });
    const antes = await vista(contador, c);
    expect(antes.body.coeficiente).toEqual({ estado: "faltan_meses", faltantes: ["202511"] });
    expect((await guardar(contador, c, "202511", { gravadas: "100000.00", exportaciones: "0.00", noGravadas: "20000.00", motivo: "Libro", version: 0 })).status).toBe(200);
    const despues = await vista(contador, c);
    expect(despues.body.coeficiente).toMatchObject({ estado: "calculado", provisional: true, porcentaje: "83.89" }); // igual que 12 declarados (CA-1)
  });

  it("un mes con ventas del SIRE cargadas admite manual y el manual desplaza al SIRE (R-2b, R-5)", async () => {
    const c = await nuevoCliente();
    await v.sembrarVentasSire(E.tenantId, c.id, P, [facturaVenta("F001", 1, "10.00", "1.80")], u());
    expect(mesDe((await vista(contador, c)).body, P)).toMatchObject({ origen: "sire", gravadas: "10.00" });
    expect((await guardar(contador, c, P, cuerpo(0, { exportaciones: "5000.00" }))).status).toBe(200);
    expect(mesDe((await vista(contador, c)).body, P)).toMatchObject({ origen: "manual", gravadas: "1234.50", exportaciones: "5000.00", sireCargado: true });
  });

  it("solo toca prorrata_mes_manual: ni declaraciones, ni obtenciones, ni ventas, ni compras, ni trabajos", async () => {
    const c = await nuevoCliente();
    await v.sembrarDeclaraciones(E.tenantId, c.id, declaracionesCA1().filter((d) => d.periodo !== P), { periodoHasta: M });
    await v.sembrarVentasSire(E.tenantId, c.id, M, [facturaVenta("F001", 1, "10.00", "1.80")], u());
    const antes = (await v.fotoProrrata(E.tenantId, c.id)) as any;
    expect((await guardar(contador, c, P, cuerpo(0))).status).toBe(200);
    const despues = (await v.fotoProrrata(E.tenantId, c.id)) as any;
    expect({ ...despues, manuales: [], auditoria: 0 }).toEqual({ ...antes, manuales: [], auditoria: 0 });
    expect(despues.manuales).toHaveLength(1);
    expect(despues.auditoria).toBe(1);
  });
});

// --- Conflictos -----------------------------------------------------------------------------------------------------------------------

describe("PUT …/prorrata/meses/:periodo · 409 sin cambios (CA-4, CA-9)", () => {
  const intacto = async (c: Cliente, antes: unknown): Promise<void> => {
    expect(await v.fotoProrrata(E.tenantId, c.id)).toEqual(antes);
  };

  it.each([
    ["la versión 0 cuando ya hay una versión 1", 0],
    ["una versión futura (5)", 5],
    ["una versión anterior (1) cuando ya hay una 2", 1],
  ])("con %s: 409 mes_cambiado y no se escribe ni se audita", async (_n, version) => {
    const c = await nuevoCliente();
    await v.sembrarManual(E.tenantId, c.id, { periodo: P, version: 1, autor: u() });
    if (version === 1) await v.sembrarManual(E.tenantId, c.id, { periodo: P, version: 2, autor: u() });
    const antes = await v.fotoProrrata(E.tenantId, c.id);
    const r = await guardar(contador, c, P, cuerpo(version, { motivo: CANARIO.motivo, gravadas: CANARIO.gravadas }));
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "mes_cambiado" });
    sinDatos(r, c);
    await intacto(c, antes);
  });

  it("una versión «eliminado» también cuenta: tras eliminar (v2) hay que guardar con version 2, no con 0 ni 1", async () => {
    const c = await nuevoCliente();
    await v.sembrarManual(E.tenantId, c.id, { periodo: P, version: 1, autor: u() });
    await v.sembrarManual(E.tenantId, c.id, { periodo: P, version: 2, accion: "eliminado", motivo: "Se cargó el SIRE", autor: u() });
    for (const version of [0, 1]) {
      const r = await guardar(contador, c, P, cuerpo(version));
      expect(r.status, r.text).toBe(409);
      expect(r.body).toEqual({ codigo: "mes_cambiado" });
    }
    const ok = await guardar(contador, c, P, cuerpo(2));
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body).toEqual({ version: 3 });
  });

  it.each([
    ["con la versión correcta (0)", 0],
    ["con una versión equivocada (9): el PDT se mira antes que la versión", 9],
  ])("un mes con PDT declarado %s: 409 mes_declarado y no se escribe", async (_n, version) => {
    const c = await nuevoCliente();
    await v.sembrarDeclaraciones(E.tenantId, c.id, [{ periodo: P, numeroOrden: "55" }], { periodoHasta: M });
    const antes = await v.fotoProrrata(E.tenantId, c.id);
    const r = await guardar(contador, c, P, cuerpo(version));
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "mes_declarado" });
    sinDatos(r, c);
    await intacto(c, antes);
  });

  it("una rectificatoria también cuenta como declaración: el mes sigue sin admitir manual", async () => {
    const c = await nuevoCliente();
    await v.sembrarDeclaraciones(E.tenantId, c.id, [
      { periodo: P, numeroOrden: "10", tipo: "original" },
      { periodo: P, numeroOrden: "11", tipo: "rectificatoria" },
    ]);
    const r = await guardar(contador, c, P, cuerpo(0));
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "mes_declarado" });
  });

  it("un manual anterior al PDT queda en el historial, pero el mes ya no admite guardar otro manual", async () => {
    const c = await nuevoCliente();
    await v.sembrarManual(E.tenantId, c.id, { periodo: P, version: 1, autor: u() });
    await v.sembrarDeclaraciones(E.tenantId, c.id, [{ periodo: P, numeroOrden: "77" }]);
    const r = await guardar(contador, c, P, cuerpo(1));
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "mes_declarado" });
    expect(await v.manualesBd(c.id, P)).toHaveLength(1);
  });

  it("cliente archivado: 409 cliente_archivado y no se escribe", async () => {
    const c = await nuevoCliente({ archivado: true });
    const antes = await v.fotoProrrata(E.tenantId, c.id);
    const r = await guardar(contador, c, P, cuerpo(0));
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
    sinDatos(r, c);
    await intacto(c, antes);
  });

  it("10 guardados simultáneos con la misma versión: uno gana (200 { version: 1 }) y nueve reciben 409 mes_cambiado; una sola fila", async () => {
    const c = await nuevoCliente();
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => guardar(contador, c, P, cuerpo(0, { gravadas: `${100 + i}.00` }))));
    expect(rs.filter((r) => r.status === 200), rs.map((r) => r.status).join()).toHaveLength(1);
    for (const r of rs.filter((x) => x.status !== 200)) {
      expect(r.status, r.text).toBe(409);
      expect(r.body).toEqual({ codigo: "mes_cambiado" });
    }
    expect(await v.manualesBd(c.id, P)).toHaveLength(1);
    expect((await v.auditoria026(E.tenantId)).filter((f) => f.cliente_id === c.id)).toHaveLength(1);
  });
});

// --- Cuerpo inválido ------------------------------------------------------------------------------------------------------------------

describe("PUT …/prorrata/meses/:periodo · cuerpo inválido (400 solicitud_invalida, sin efectos)", () => {
  const largo = "x".repeat(501);
  it.each([
    ["sin cuerpo", undefined],
    ["cuerpo vacío", {}],
    ["sin motivo", { ...MONTOS, version: 0 }],
    ["motivo vacío", cuerpo(0, { motivo: "" })],
    ["motivo de 501 caracteres", cuerpo(0, { motivo: largo })],
    ["motivo con carácter de control", cuerpo(0, { motivo: "uno\u0007dos" })],
    ["motivo con NUL", cuerpo(0, { motivo: "uno\u0000dos" })],
    ["motivo con marca bidi (RLO)", cuerpo(0, { motivo: "abc‮def" })],
    ["motivo con aislamiento bidi", cuerpo(0, { motivo: "abc⁦def" })],
    ["motivo numérico", cuerpo(0, { motivo: 1 })],
    ["sin version", { ...MONTOS, motivo: "x" }],
    ["version negativa", cuerpo(-1)],
    ["version decimal", cuerpo(1.5)],
    ["version como texto", cuerpo("0" as unknown as number)],
    ["version nula", cuerpo(null as unknown as number)],
    ["monto como número", cuerpo(0, { gravadas: 1234.5 })],
    ["monto con 3 decimales", cuerpo(0, { gravadas: "1.234" })],
    ["monto con notación científica", cuerpo(0, { gravadas: "1e3" })],
    ["monto con espacios", cuerpo(0, { noGravadas: " 10.00" })],
    ["monto con coma decimal", cuerpo(0, { exportaciones: "1,5" })],
    ["monto fuera de NUMERIC(14,2)", cuerpo(0, { gravadas: "1000000000000.00" })],
    ["monto fuera de NUMERIC(14,2) negativo", cuerpo(0, { gravadas: "-1000000000000.00" })],
    ["monto vacío", cuerpo(0, { gravadas: "" })],
    ["monto nulo", cuerpo(0, { gravadas: null })],
    ["falta un monto", { exportaciones: "0.00", noGravadas: "0.00", motivo: "x", version: 0 }],
    ["clave extra (cliente)", cuerpo(0, { clienteId: "x" })],
    ["clave extra (tenant)", cuerpo(0, { tenantId: "x" })],
    ["clave extra (porcentaje)", cuerpo(0, { porcentaje: "50.00" })],
    ["clave extra (origen)", cuerpo(0, { origen: "declarado" })],
  ])("%s", async (_n, body) => {
    const c = await nuevoCliente();
    const antes = await v.fotoProrrata(E.tenantId, c.id);
    const r = await guardar(contador, c, P, body);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await v.fotoProrrata(E.tenantId, c.id)).toEqual(antes);
  });

  it("un motivo de 500 caracteres exactos y uno con texto HTML se guardan como texto, sin interpretar", async () => {
    const c = await nuevoCliente();
    expect((await guardar(contador, c, "202602", cuerpo(0, { motivo: "y".repeat(500) }))).status).toBe(200);
    const html = '<img src=x onerror="alert(1)"> & "comillas" ñandú';
    expect((await guardar(contador, c, "202603", cuerpo(0, { motivo: html }))).status).toBe(200);
    const mes = mesDe((await vista(contador, c)).body, "202603");
    expect(mes.manual.motivo).toBe(html);
  });

  it.each(["202613", "202600", "2026-01", "abc", "20260", "２０２６０１"])("periodo de la ruta %j: 400 solicitud_invalida", async (periodo) => {
    const c = await nuevoCliente();
    const r = await guardar(contador, c, encodeURIComponent(periodo), cuerpo(0));
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await v.manualesBd(c.id)).toHaveLength(0);
  });
});

// --- Eliminar -------------------------------------------------------------------------------------------------------------------------

describe("POST …/prorrata/meses/:periodo/eliminar · quitar el manual (CA-4)", () => {
  it("elimina: 200 { version: 2 }, fila «eliminado» con montos NULL y su motivo, auditoría y el mes vuelve a «falta»; el historial conserva todo", async () => {
    const c = await nuevoCliente();
    expect((await guardar(contador, c, P, cuerpo(0))).body).toEqual({ version: 1 });
    const r = await eliminar(contador, c, P, { motivo: "Ya se cargó el SIRE", version: 1 });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ version: 2 });
    expect(r.headers["cache-control"]).toMatch(/no-store/);

    const filas = await v.manualesBd(c.id, P);
    expect(filas.map((f) => [f.version, f.accion])).toEqual([
      [1, "guardado"],
      [2, "eliminado"],
    ]);
    expect(filas[1]).toMatchObject({ gravadas: null, exportaciones: null, no_gravadas: null, motivo: "Ya se cargó el SIRE", autor: contador.id });

    const aud = (await v.auditoria026(E.tenantId)).filter((f) => f.cliente_id === c.id && f.accion === "prorrata.mes_manual_eliminado");
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({ actor_tipo: "usuario", usuario_id: contador.id });
    expect(aud[0].datos).toEqual({ clienteId: c.id, periodo: P, version: 2 });

    const mes = mesDe((await vista(contador, c)).body, P);
    expect(mes).toMatchObject({ origen: "falta", gravadas: "0.00", total: "0.00", manual: null, versionManual: 2 });

    const h = await historial(contador, c, P);
    expect(h.status, h.text).toBe(200);
    expect(h.body.manual.map((x: any) => [x.version, x.accion]).sort()).toEqual([
      [1, "guardado"],
      [2, "eliminado"],
    ]);
  });

  it("con el periodo de ventas cargado, al eliminar el mes vuelve a SIRE (R-5)", async () => {
    const c = await nuevoCliente();
    await v.sembrarVentasSire(E.tenantId, c.id, P, [facturaVenta("F001", 1, "10.00", "1.80")], u());
    expect((await guardar(contador, c, P, cuerpo(0))).status).toBe(200);
    expect((await eliminar(contador, c, P, { motivo: "Volver al SIRE", version: 1 })).status).toBe(200);
    expect(mesDe((await vista(contador, c)).body, P)).toMatchObject({ origen: "sire", gravadas: "10.00", manual: null, versionManual: 2 });
  });

  it("tras eliminar se puede volver a guardar (versión 3) y el historial lista las tres versiones", async () => {
    const c = await nuevoCliente();
    await guardar(contador, c, P, cuerpo(0));
    await eliminar(contador, c, P, { motivo: "Quitar", version: 1 });
    const r = await guardar(contador, c, P, cuerpo(2, { gravadas: "77.00", motivo: "De nuevo" }));
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ version: 3 });
    expect(mesDe((await vista(contador, c)).body, P)).toMatchObject({ origen: "manual", gravadas: "77.00", versionManual: 3 });
    const h = await historial(contador, c, P);
    expect(h.body.manual.map((x: any) => x.version).sort()).toEqual([1, 2, 3]);
  });

  it.each([
    ["sin ningún manual (version 1)", async () => 1],
    ["una versión vieja (1) cuando ya hay una 2", async (c: Cliente) => {
      await v.sembrarManual(E.tenantId, c.id, { periodo: P, version: 1, autor: u() });
      await v.sembrarManual(E.tenantId, c.id, { periodo: P, version: 2, autor: u() });
      return 1;
    }],
    ["una versión que no existe aún (4)", async (c: Cliente) => {
      await v.sembrarManual(E.tenantId, c.id, { periodo: P, version: 1, autor: u() });
      return 4;
    }],
    ["el manual ya eliminado (versión 2 «eliminado»): no hay manual vivo", async (c: Cliente) => {
      await v.sembrarManual(E.tenantId, c.id, { periodo: P, version: 1, autor: u() });
      await v.sembrarManual(E.tenantId, c.id, { periodo: P, version: 2, accion: "eliminado", motivo: "Quitado", autor: u() });
      return 2;
    }],
  ])("%s: 409 mes_cambiado y no se escribe", async (_n, preparar) => {
    const c = await nuevoCliente();
    const version = await preparar(c);
    const antes = await v.fotoProrrata(E.tenantId, c.id);
    const r = await eliminar(contador, c, P, { motivo: CANARIO.motivo, version });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "mes_cambiado" });
    sinDatos(r, c);
    expect(await v.fotoProrrata(E.tenantId, c.id)).toEqual(antes);
  });

  it("cliente archivado: 409 cliente_archivado", async () => {
    const c = await nuevoCliente({ archivado: true });
    await v.sembrarManual(E.tenantId, c.id, { periodo: P, version: 1, autor: u() });
    const antes = await v.fotoProrrata(E.tenantId, c.id);
    const r = await eliminar(contador, c, P, { motivo: "Quitar", version: 1 });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
    expect(await v.fotoProrrata(E.tenantId, c.id)).toEqual(antes);
  });

  it.each([
    ["sin cuerpo", undefined],
    ["sin motivo", { version: 1 }],
    ["motivo vacío", { motivo: "", version: 1 }],
    ["motivo de 501 caracteres", { motivo: "x".repeat(501), version: 1 }],
    ["motivo con control", { motivo: "a\u0007b", version: 1 }],
    ["motivo con bidi", { motivo: "a‮b", version: 1 }],
    ["version 0 (nunca hubo manual que eliminar)", { motivo: "x", version: 0 }],
    ["version negativa", { motivo: "x", version: -1 }],
    ["version decimal", { motivo: "x", version: 1.5 }],
    ["version como texto", { motivo: "x", version: "1" }],
    ["sin version", { motivo: "x" }],
    ["clave extra (montos)", { motivo: "x", version: 1, gravadas: "1.00" }],
    ["clave extra (cliente)", { motivo: "x", version: 1, clienteId: "x" }],
  ])("cuerpo inválido, %s: 400 solicitud_invalida y no cambia nada", async (_n, body) => {
    const c = await nuevoCliente();
    await v.sembrarManual(E.tenantId, c.id, { periodo: P, version: 1, autor: u() });
    const antes = await v.fotoProrrata(E.tenantId, c.id);
    const r = await eliminar(contador, c, P, body);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await v.fotoProrrata(E.tenantId, c.id)).toEqual(antes);
  });

  it("10 eliminaciones simultáneas de la misma versión: una gana y nueve reciben 409 mes_cambiado", async () => {
    const c = await nuevoCliente();
    await v.sembrarManual(E.tenantId, c.id, { periodo: P, version: 1, autor: u() });
    const rs = await Promise.all(Array.from({ length: 10 }, () => eliminar(contador, c, P, { motivo: "Quitar", version: 1 })));
    expect(rs.filter((r) => r.status === 200), rs.map((r) => r.status).join()).toHaveLength(1);
    for (const r of rs.filter((x) => x.status !== 200)) expect(r.body).toEqual({ codigo: "mes_cambiado" });
    expect((await v.manualesBd(c.id, P)).filter((f) => f.accion === "eliminado")).toHaveLength(1);
  });
});

// --- Historial ------------------------------------------------------------------------------------------------------------------------

describe("GET …/prorrata/meses/:periodo/historial · todas las versiones y presentaciones (RF-133, CA-4)", () => {
  it("lista cada versión del manual con su autor, motivo, montos (null si eliminado) y fecha; sin presentaciones si no hay PDT", async () => {
    const c = await nuevoCliente();
    await guardar(contador, c, P, cuerpo(0));
    await guardar(contador, c, P, cuerpo(1, { gravadas: "10.00", motivo: "Segunda" }));
    await eliminar(contador, c, P, { motivo: "Tercera", version: 2 });
    const r = await historial(lectura, c, P); // lo puede leer quien solo tiene prorrata.ver
    expect(r.status, r.text).toBe(200);
    expect(cumple("historialMesVistaSchema", r.body), r.text).toBe(true);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(Object.keys(r.body).sort()).toEqual(["declaraciones", "manual"]);
    expect(r.body.declaraciones).toEqual([]);
    const porVersion = [...r.body.manual].sort((a: any, b: any) => a.version - b.version);
    expect(porVersion.map((x: any) => [x.version, x.accion, x.motivo])).toEqual([
      [1, "guardado", "Libro de ventas físico"],
      [2, "guardado", "Segunda"],
      [3, "eliminado", "Tercera"],
    ]);
    expect(porVersion[0].montos).toEqual({ gravadas: "1234.50", exportaciones: "0.00", noGravadas: "200.00" });
    expect(porVersion[1].montos).toEqual({ gravadas: "10.00", exportaciones: "0.00", noGravadas: "200.00" });
    expect(porVersion[2].montos).toBeNull();
    const nombre = await v.nombreDe(contador.id);
    for (const x of porVersion) {
      expect(x.autor).toEqual({ id: contador.id, nombre });
      expect(Number.isNaN(Date.parse(x.en))).toBe(false);
    }
  });

  it("lista todas las presentaciones del PDT del mes (original y rectificatoria) con sus montos, prorrata usada y fecha de obtención", async () => {
    const c = await nuevoCliente();
    await v.sembrarDeclaraciones(
      E.tenantId,
      c.id,
      [
        { periodo: P, numeroOrden: "9", tipo: "original", fecha: "2026-02-10", gravadas: "100.00", exportaciones: "1.00", noGravadas: "2.00", prorrataUsada: "80.00" },
        { periodo: P, numeroOrden: "10", tipo: "rectificatoria", fecha: "2026-03-20", gravadas: "90.00", exportaciones: "0.00", noGravadas: "3.00", prorrataUsada: null },
      ],
      { periodoHasta: M, obtenidaEn: "2026-11-20T15:00:00.000Z" },
    );
    const r = await historial(contador, c, P);
    expect(r.status, r.text).toBe(200);
    expect(cumple("historialMesVistaSchema", r.body), r.text).toBe(true);
    const ds = [...r.body.declaraciones].sort((a: any, b: any) => Number(a.numeroOrden) - Number(b.numeroOrden));
    expect(ds).toEqual([
      { numeroOrden: "9", fechaPresentacion: "2026-02-10", tipo: "original", gravadas: "100.00", exportaciones: "1.00", noGravadas: "2.00", prorrataUsada: "80.00", obtenidaEn: "2026-11-20T15:00:00.000Z" },
      { numeroOrden: "10", fechaPresentacion: "2026-03-20", tipo: "rectificatoria", gravadas: "90.00", exportaciones: "0.00", noGravadas: "3.00", prorrataUsada: null, obtenidaEn: "2026-11-20T15:00:00.000Z" },
    ]);
    expect(r.body.manual).toEqual([]);
  });

  it("no mezcla otros periodos ni otros clientes del mismo estudio", async () => {
    const c = await nuevoCliente();
    const otro = await nuevoCliente();
    await guardar(contador, c, "202602", cuerpo(0));
    await guardar(contador, otro, P, cuerpo(0, { motivo: "Del otro cliente" }));
    await v.sembrarDeclaraciones(E.tenantId, otro.id, [{ periodo: P, numeroOrden: "1" }]);
    const r = await historial(contador, c, P);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ declaraciones: [], manual: [] });
  });

  it("un mes sin nada: listas vacías (200)", async () => {
    const c = await nuevoCliente();
    const r = await historial(contador, c, P);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ declaraciones: [], manual: [] });
  });

  it("con el cliente archivado se puede leer", async () => {
    const c = await nuevoCliente({ archivado: true });
    await v.sembrarManual(E.tenantId, c.id, { periodo: P, version: 1, autor: u() });
    const r = await historial(contador, c, P);
    expect(r.status, r.text).toBe(200);
    expect(r.body.manual).toHaveLength(1);
  });

  it.each(["202613", "2026-01", "abc"])("periodo %j mal formado: 400 solicitud_invalida", async (periodo) => {
    const c = await nuevoCliente();
    const r = await v.http(contador, "GET", rutaHistorial(c.id, encodeURIComponent(periodo)));
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
  });

  it("un cliente inexistente da 404 no_encontrado", async () => {
    const control = await historial(contador, await nuevoCliente(), P); // la ruta existe: el 404 de abajo no es «ruta inexistente»
    expect(control.status, control.text).toBe(200);
    const r = await historial(contador, { id: "00000000-0000-4000-8000-000000000000" }, P);
    expect(r.status, r.text).toBe(404);
    expect(r.body).toEqual(NO_ENCONTRADO);
  });
});

// --- Secretos y trazas (CA-10) ----------------------------------------------------------------------------------------------------------

describe("mes manual · ni montos ni motivo en logs, errores ni auditoría (D-6, D-7, CA-10)", () => {
  it("guardar, repetir (409), eliminar y fallar con canarios: nada de los canarios en logs, respuestas de error ni auditoría", async () => {
    const c = await nuevoCliente();
    const canario = { gravadas: CANARIO.gravadas, exportaciones: CANARIO.exportaciones, noGravadas: CANARIO.noGravadas, motivo: CANARIO.motivo };
    const { resultado: respuestas, logs } = await capturarLogs(async () => {
      const ok = await guardar(contador, c, P, { ...canario, version: 0 });
      const cambiado = await guardar(contador, c, P, { ...canario, version: 0 });
      const invalido = await guardar(contador, c, P, { ...canario, version: 0, extra: CANARIO.motivo });
      const quitado = await eliminar(contador, c, P, { motivo: CANARIO.motivo, version: 1 });
      const otraVez = await eliminar(contador, c, P, { motivo: CANARIO.motivo, version: 1 });
      return { ok, cambiado, invalido, quitado, otraVez };
    });
    expect(respuestas.ok.status, respuestas.ok.text).toBe(200);
    expect(respuestas.cambiado.status, respuestas.cambiado.text).toBe(409);
    expect(respuestas.invalido.status, respuestas.invalido.text).toBe(400);
    expect(respuestas.quitado.status, respuestas.quitado.text).toBe(200);
    expect(respuestas.otraVez.status, respuestas.otraVez.text).toBe(409);
    for (const r of Object.values(respuestas)) {
      for (const x of CANARIOS_TEXTO) expect(r.text).not.toContain(x); // ni las respuestas de éxito (solo `{version}`)
      expect(r.text).not.toContain(c.ruc);
    }
    for (const x of [...CANARIOS_TEXTO, c.ruc]) {
      expect(logs).not.toContain(x);
      expect(await v.textoAuditoria(E.tenantId)).not.toContain(x);
    }
    // Los montos y el motivo SÍ viven en las filas versionadas (D-4): es lo que el historial muestra.
    expect((await v.manualesBd(c.id, P))[0]).toMatchObject({ motivo: CANARIO.motivo, gravadas: CANARIO.gravadas });
  });
});
