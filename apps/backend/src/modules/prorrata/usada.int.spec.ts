/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 026 (T6, rojo): prorrata usada y alerta de diferencia (RF-135, R-8, U-9, U-10, D-6, D-7; CA-6, CA-9, CA-10).
// Contrato (plan 026, «Contratos: HTTP» y «shared»; `guardarProrrataUsadaSchema` de `@contapp/shared`):
//  - Prorrata usada de M = la del PDT VIGENTE de M (mayor número de orden) si la trae -> `{valor, origen: "declarada"}`; si no la trae, la
//    que ingresó el contador (la de mayor versión, ya no «null») -> `{valor, origen: "ingresada"}`; si no hay ninguna -> `null`.
//    Si una declaración posterior la trae, gana la declarada (la ingresada queda guardada pero la vista muestra la declarada).
//  - `diferencia` = `{diferencia: «NN.NN», alerta}` solo con coeficiente CALCULADO (aunque sea provisional) y prorrata usada;
//    `alerta` cuando `|calculada − usada| >= 0.01` puntos; si no, `null` (R-8). `versionUsada` = última versión de la ingresada del mes
//    (0 si nunca hubo; una versión con `porcentaje` nulo también cuenta).
//  - `PUT /clientes/:clienteId/prorrata/usada/:periodo` (`prorrata.gestionar`) con `{porcentaje: «NN.NN» | null, version >= 0}`
//    (`.strict()`; `null` = quitar la ingresada) -> 200 `{version}` (la nueva). 409 `prorrata_declarada` si el PDT vigente del periodo la
//    trae (se mira ANTES que la versión: plan, `CA413` y luego `CA409`), 409 `mes_cambiado` si la versión no es la vigente, 409
//    `cliente_archivado`. Audita `prorrata.usada_guardada` (actor usuario, `{clienteId, periodo, version}` y nada más: sin porcentaje).
// Rojo: las rutas aún no existen (T12): responden 404 de ruta inexistente. Las tablas y funciones son de T10.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { capturarLogs } from "../../../test/soporte.js";
import {
  abrirBancoProrrata,
  CA1,
  CANARIO,
  cumple,
  declaracionesCA1,
  M,
  rutaUsada,
  rutaVista,
  type Actor,
  type BancoProrrata,
  type DeclSpec,
  type Estudio,
} from "../../../test/soporte-prorrata.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let v: BancoProrrata;
let E: Estudio;
let contador: Actor;
let lectura: Actor;

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
const guardar = (a: Actor, c: { id: string }, periodo: string, body: unknown) => v.http(a, "PUT", rutaUsada(c.id, periodo), body);
const vista = (a: Actor, c: { id: string }, periodo = M) => v.http(a, "GET", rutaVista(c.id, periodo));
/** Los 12 PDT de CA-1 (coeficiente 83.89) con la prorrata usada que se diga en el de M. */
const conUsadaEnM = (prorrataUsada: string | null): DeclSpec[] => declaracionesCA1().map((d) => (d.periodo === M ? { ...d, prorrataUsada } : d));
const sembrar = (c: Cliente, ds: DeclSpec[]) => v.sembrarDeclaraciones(E.tenantId, c.id, ds, { periodoHasta: M });

function sinDatos(r: { text: string }, c: Cliente): void {
  expect(r.text).not.toContain(c.ruc);
  expect(r.text).not.toContain(CANARIO.porcentaje);
  expect(r.text).not.toMatch(/\d+\.\d{2}/);
}

// --- La prorrata usada del PDT y la alerta (CA-6) -----------------------------------------------------------------------------------------

describe("R-8 y CA-6 · prorrata usada declarada en el PDT de M y alerta de diferencia", () => {
  it.each([
    ["83.90", "0.01", true], // 0,01 de diferencia: alerta
    ["83.88", "0.01", true], // el valor absoluto: usada menor
    ["83.89", "0.00", false], // igual: sin alerta
    ["100.00", "16.11", true],
    ["0.00", "83.89", true], // 0.00 declarado no es «sin prorrata»
    ["80.00", "3.89", true],
  ])("PDT de M con prorrata %s y coeficiente 83.89: diferencia %s, alerta %s, origen declarada", async (usada, diferencia, alerta) => {
    const c = await nuevoCliente();
    await sembrar(c, conUsadaEnM(usada));
    const r = await vista(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(cumple("prorrataVistaSchema", r.body), r.text).toBe(true);
    expect(r.body.coeficiente).toMatchObject({ estado: "calculado", porcentaje: CA1.porcentaje });
    expect(r.body.prorrataUsada).toEqual({ valor: usada, origen: "declarada" });
    expect(r.body.diferencia).toEqual({ diferencia, alerta });
    expect(r.body.versionUsada).toBe(0);
  });

  it("sin prorrata usada (el PDT de M no la trae y nadie la ingresó): sin ella y sin alerta", async () => {
    const c = await nuevoCliente();
    await sembrar(c, conUsadaEnM(null));
    const r = await vista(contador, c);
    expect(r.body.prorrataUsada).toBeNull();
    expect(r.body.diferencia).toBeNull();
  });

  it("la prorrata usada de M es la del PDT VIGENTE: la rectificatoria sin prorrata (orden 11 > 10) deja a M sin ella", async () => {
    const c = await nuevoCliente();
    const ds = conUsadaEnM(null).filter((d) => d.periodo !== M);
    ds.push({ ...declaracionesCA1().find((d) => d.periodo === M)!, numeroOrden: "11", tipo: "rectificatoria", prorrataUsada: null });
    ds.push({ ...declaracionesCA1().find((d) => d.periodo === M)!, numeroOrden: "10", tipo: "original", prorrataUsada: "80.00" });
    await sembrar(c, ds);
    const r = await vista(contador, c);
    expect(r.body.prorrataUsada).toBeNull();
    expect(r.body.diferencia).toBeNull();
  });

  it("y si la vigente (rectificatoria) la trae y la original no, la usada es la de la rectificatoria", async () => {
    const c = await nuevoCliente();
    const ds = conUsadaEnM(null).filter((d) => d.periodo !== M);
    ds.push({ ...declaracionesCA1().find((d) => d.periodo === M)!, numeroOrden: "9", tipo: "original", prorrataUsada: null });
    ds.push({ ...declaracionesCA1().find((d) => d.periodo === M)!, numeroOrden: "10", tipo: "rectificatoria", prorrataUsada: "84.00" });
    await sembrar(c, ds);
    const r = await vista(contador, c);
    expect(r.body.prorrataUsada).toEqual({ valor: "84.00", origen: "declarada" });
    expect(r.body.diferencia).toEqual({ diferencia: "0.11", alerta: true });
  });

  it("con el coeficiente no calculado (faltan meses) la prorrata usada se muestra pero no hay alerta (R-8)", async () => {
    const c = await nuevoCliente();
    await sembrar(c, conUsadaEnM("80.00").filter((d) => d.periodo !== "202511"));
    const r = await vista(contador, c);
    expect(r.body.coeficiente).toEqual({ estado: "faltan_meses", faltantes: ["202511"] });
    expect(r.body.prorrataUsada).toEqual({ valor: "80.00", origen: "declarada" });
    expect(r.body.diferencia).toBeNull();
  });

  it("con el coeficiente «provisional» (un mes manual) también se compara", async () => {
    const c = await nuevoCliente();
    await sembrar(c, conUsadaEnM("80.00").filter((d) => d.periodo !== "202511"));
    await v.sembrarManual(E.tenantId, c.id, { periodo: "202511", gravadas: "100000.00", exportaciones: "0.00", noGravadas: "20000.00", autor: u() });
    const r = await vista(contador, c);
    expect(r.body.coeficiente).toMatchObject({ estado: "calculado", provisional: true, porcentaje: CA1.porcentaje });
    expect(r.body.diferencia).toEqual({ diferencia: "3.89", alerta: true });
  });

  it("la prorrata usada que se muestra es la de M: la de otro periodo (del PDT o ingresada) no cuenta", async () => {
    const c = await nuevoCliente();
    await sembrar(c, declaracionesCA1().map((d) => (d.periodo === "202609" ? { ...d, prorrataUsada: "10.00" } : d)));
    await v.sembrarUsada(E.tenantId, c.id, { periodo: "202609", porcentaje: "20.00", autor: u() });
    const r = await vista(contador, c);
    expect(r.body.prorrataUsada).toBeNull();
    expect(r.body.versionUsada).toBe(0);
  });
});

// --- La ingresada (U-9) ---------------------------------------------------------------------------------------------------------------------

describe("PUT …/prorrata/usada/:periodo · ingresar la prorrata usada cuando el PDT no la trae (U-9, CA-6)", () => {
  it("primera vez (version 0): 200 { version: 1 }, fila versionada con autor, origen «ingresada» y alerta si difiere en 0,01", async () => {
    const c = await nuevoCliente();
    await sembrar(c, conUsadaEnM(null));
    const r = await guardar(contador, c, M, { porcentaje: "83.90", version: 0 });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ version: 1 });
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(await v.usadasBd(c.id, M)).toMatchObject([{ periodo: M, version: 1, porcentaje: "83.90", autor: contador.id }]);

    const l = await vista(contador, c);
    expect(l.status, l.text).toBe(200);
    expect(cumple("prorrataVistaSchema", l.body), l.text).toBe(true);
    expect(l.body.prorrataUsada).toEqual({ valor: "83.90", origen: "ingresada" });
    expect(l.body.versionUsada).toBe(1);
    expect(l.body.diferencia).toEqual({ diferencia: "0.01", alerta: true });
  });

  it("igual a la calculada: se muestra con su origen y sin alerta", async () => {
    const c = await nuevoCliente();
    await sembrar(c, conUsadaEnM(null));
    expect((await guardar(contador, c, M, { porcentaje: "83.89", version: 0 })).status).toBe(200);
    const l = await vista(contador, c);
    expect(l.body.prorrataUsada).toEqual({ valor: "83.89", origen: "ingresada" });
    expect(l.body.diferencia).toEqual({ diferencia: "0.00", alerta: false });
  });

  it("audita prorrata.usada_guardada (actor usuario) con {clienteId, periodo, version} y nada más: sin el porcentaje", async () => {
    const c = await nuevoCliente();
    expect((await guardar(contador, c, M, { porcentaje: CANARIO.porcentaje, version: 0 })).status).toBe(200);
    const aud = (await v.auditoria026(E.tenantId)).filter((f) => f.cliente_id === c.id);
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({ accion: "prorrata.usada_guardada", actor_tipo: "usuario", usuario_id: contador.id });
    expect(aud[0].datos).toEqual({ clienteId: c.id, periodo: M, version: 1 });
    expect(JSON.stringify(aud[0])).not.toContain(CANARIO.porcentaje);
  });

  it("segunda versión (version 1): 200 { version: 2 }; manda la última", async () => {
    const c = await nuevoCliente();
    await sembrar(c, conUsadaEnM(null));
    await guardar(contador, c, M, { porcentaje: "70.00", version: 0 });
    const r = await guardar(contador, c, M, { porcentaje: "83.89", version: 1 });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ version: 2 });
    expect((await v.usadasBd(c.id, M)).map((f) => [f.version, f.porcentaje])).toEqual([
      [1, "70.00"],
      [2, "83.89"],
    ]);
    const l = await vista(contador, c);
    expect(l.body.prorrataUsada).toEqual({ valor: "83.89", origen: "ingresada" });
    expect(l.body.versionUsada).toBe(2);
  });

  it("porcentaje null quita la ingresada: 200 { version: 2 }, la vista queda sin prorrata usada ni alerta y la versión sigue contando", async () => {
    const c = await nuevoCliente();
    await sembrar(c, conUsadaEnM(null));
    await guardar(contador, c, M, { porcentaje: "70.00", version: 0 });
    const r = await guardar(contador, c, M, { porcentaje: null, version: 1 });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ version: 2 });
    const l = await vista(contador, c);
    expect(l.body.prorrataUsada).toBeNull();
    expect(l.body.diferencia).toBeNull();
    expect(l.body.versionUsada).toBe(2);
    expect((await guardar(contador, c, M, { porcentaje: "71.00", version: 0 })).status).toBe(409); // la 0 ya no es la vigente
    expect((await guardar(contador, c, M, { porcentaje: "71.00", version: 2 })).body).toEqual({ version: 3 });
  });

  it.each([
    ["0.00", "0.00"],
    ["100.00", "100.00"],
    ["83.9", "83.90"], // un decimal: la gramática lo admite; se guarda con 2
    ["100", "100.00"],
    ["5", "5.00"],
  ])("acepta el porcentaje %s y lo muestra como %s", async (entrada, mostrado) => {
    const c = await nuevoCliente();
    await sembrar(c, conUsadaEnM(null));
    const r = await guardar(contador, c, M, { porcentaje: entrada, version: 0 });
    expect(r.status, r.text).toBe(200);
    expect((await vista(contador, c)).body.prorrataUsada).toEqual({ valor: mostrado, origen: "ingresada" });
  });

  it("con la ventana incompleta también se puede ingresar: la prorrata usada no depende del coeficiente", async () => {
    const c = await nuevoCliente();
    const r = await guardar(contador, c, M, { porcentaje: "50.00", version: 0 });
    expect(r.status, r.text).toBe(200);
    const l = await vista(contador, c);
    expect(l.body.prorrataUsada).toEqual({ valor: "50.00", origen: "ingresada" });
    expect(l.body.diferencia).toBeNull();
  });

  it("solo toca prorrata_usada_manual: ni PDT, ni manuales, ni ventas, ni trabajos", async () => {
    const c = await nuevoCliente();
    await sembrar(c, conUsadaEnM(null));
    const antes = (await v.fotoProrrata(E.tenantId, c.id)) as any;
    expect((await guardar(contador, c, M, { porcentaje: "50.00", version: 0 })).status).toBe(200);
    const despues = (await v.fotoProrrata(E.tenantId, c.id)) as any;
    expect({ ...despues, usadas: [], auditoria: 0 }).toEqual({ ...antes, usadas: [], auditoria: 0 });
    expect(despues.usadas).toHaveLength(1);
  });
});

// --- Conflictos -----------------------------------------------------------------------------------------------------------------------------

describe("PUT …/prorrata/usada/:periodo · 409 sin cambios (CA-6, CA-9)", () => {
  const intacto = async (c: Cliente, antes: unknown): Promise<void> => {
    expect(await v.fotoProrrata(E.tenantId, c.id)).toEqual(antes);
  };

  it.each([
    ["con la versión correcta (0)", 0],
    ["con una versión equivocada (7): el PDT se mira antes que la versión", 7],
  ])("el PDT de M trae la prorrata %s: 409 prorrata_declarada y no se escribe", async (_n, version) => {
    const c = await nuevoCliente();
    await sembrar(c, conUsadaEnM("83.89"));
    const antes = await v.fotoProrrata(E.tenantId, c.id);
    const r = await guardar(contador, c, M, { porcentaje: CANARIO.porcentaje, version });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "prorrata_declarada" });
    sinDatos(r, c);
    await intacto(c, antes);
  });

  it("una declaración posterior que la trae gana: la vista muestra la declarada, la ingresada queda guardada y ya no se puede cambiar", async () => {
    const c = await nuevoCliente();
    await v.sembrarUsada(E.tenantId, c.id, { periodo: M, version: 1, porcentaje: "50.00", autor: u() });
    await sembrar(c, conUsadaEnM("83.88"));
    const l = await vista(contador, c);
    expect(l.body.prorrataUsada).toEqual({ valor: "83.88", origen: "declarada" });
    expect(l.body.versionUsada).toBe(1);
    expect(l.body.diferencia).toEqual({ diferencia: "0.01", alerta: true });
    const r = await guardar(contador, c, M, { porcentaje: "50.00", version: 1 });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "prorrata_declarada" });
    expect(await v.usadasBd(c.id, M)).toHaveLength(1);
  });

  it("un PDT de M SIN prorrata (null) sí admite ingresarla; también si una presentación anterior la traía pero la vigente no", async () => {
    const c = await nuevoCliente();
    const ds = conUsadaEnM(null).filter((d) => d.periodo !== M);
    ds.push({ ...declaracionesCA1().find((d) => d.periodo === M)!, numeroOrden: "10", prorrataUsada: "80.00" });
    ds.push({ ...declaracionesCA1().find((d) => d.periodo === M)!, numeroOrden: "11", tipo: "rectificatoria", prorrataUsada: null });
    await sembrar(c, ds);
    const r = await guardar(contador, c, M, { porcentaje: "83.89", version: 0 });
    expect(r.status, r.text).toBe(200);
    expect((await vista(contador, c)).body.prorrataUsada).toEqual({ valor: "83.89", origen: "ingresada" });
  });

  it.each([
    ["la versión 0 cuando ya hay una 1", 0],
    ["una versión futura (4)", 4],
  ])("con %s: 409 mes_cambiado y no se escribe", async (_n, version) => {
    const c = await nuevoCliente();
    await v.sembrarUsada(E.tenantId, c.id, { periodo: M, version: 1, porcentaje: "50.00", autor: u() });
    const antes = await v.fotoProrrata(E.tenantId, c.id);
    const r = await guardar(contador, c, M, { porcentaje: CANARIO.porcentaje, version });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "mes_cambiado" });
    sinDatos(r, c);
    await intacto(c, antes);
  });

  it("cliente archivado: 409 cliente_archivado y no se escribe", async () => {
    const c = await nuevoCliente({ archivado: true });
    const antes = await v.fotoProrrata(E.tenantId, c.id);
    const r = await guardar(contador, c, M, { porcentaje: "50.00", version: 0 });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
    await intacto(c, antes);
  });

  it("10 guardados simultáneos con la misma versión: uno gana (200 { version: 1 }) y nueve reciben 409 mes_cambiado", async () => {
    const c = await nuevoCliente();
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => guardar(contador, c, M, { porcentaje: `${50 + i}.00`, version: 0 })));
    expect(rs.filter((r) => r.status === 200), rs.map((r) => r.status).join()).toHaveLength(1);
    for (const r of rs.filter((x) => x.status !== 200)) {
      expect(r.status, r.text).toBe(409);
      expect(r.body).toEqual({ codigo: "mes_cambiado" });
    }
    expect(await v.usadasBd(c.id, M)).toHaveLength(1);
  });
});

// --- Cuerpo inválido ------------------------------------------------------------------------------------------------------------------------

describe("PUT …/prorrata/usada/:periodo · cuerpo inválido (400 solicitud_invalida, sin efectos)", () => {
  it.each([
    ["sin cuerpo", undefined],
    ["cuerpo vacío", {}],
    ["sin porcentaje (null no equivale a ausente)", { version: 0 }],
    ["porcentaje 100.01", { porcentaje: "100.01", version: 0 }],
    ["porcentaje 101", { porcentaje: "101", version: 0 }],
    ["porcentaje con 3 decimales", { porcentaje: "87.345", version: 0 }],
    ["porcentaje negativo", { porcentaje: "-1", version: 0 }],
    ["porcentaje -0", { porcentaje: "-0.00", version: 0 }],
    ["porcentaje con notación científica", { porcentaje: "1e2", version: 0 }],
    ["porcentaje vacío", { porcentaje: "", version: 0 }],
    ["porcentaje con espacio", { porcentaje: " 50.00", version: 0 }],
    ["porcentaje con coma decimal", { porcentaje: "50,00", version: 0 }],
    ["porcentaje con signo %", { porcentaje: "50.00%", version: 0 }],
    ["porcentaje como número", { porcentaje: 50.5, version: 0 }],
    ["sin version", { porcentaje: "50.00" }],
    ["version negativa", { porcentaje: "50.00", version: -1 }],
    ["version decimal", { porcentaje: "50.00", version: 0.5 }],
    ["version como texto", { porcentaje: "50.00", version: "0" }],
    ["clave extra (cliente)", { porcentaje: "50.00", version: 0, clienteId: "x" }],
    ["clave extra (origen)", { porcentaje: "50.00", version: 0, origen: "declarada" }],
    ["clave extra (motivo)", { porcentaje: "50.00", version: 0, motivo: "x" }],
  ])("%s", async (_n, body) => {
    const c = await nuevoCliente();
    const antes = await v.fotoProrrata(E.tenantId, c.id);
    const r = await guardar(contador, c, M, body);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await v.fotoProrrata(E.tenantId, c.id)).toEqual(antes);
  });

  it.each(["202613", "202600", "2026-10", "abc", "20261"])("periodo de la ruta %j: 400 solicitud_invalida", async (periodo) => {
    const c = await nuevoCliente();
    const r = await guardar(contador, c, encodeURIComponent(periodo), { porcentaje: "50.00", version: 0 });
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await v.usadasBd(c.id)).toHaveLength(0);
  });
});

// --- Permisos -----------------------------------------------------------------------------------------------------------------------------------

describe("PUT …/prorrata/usada/:periodo · quien solo puede ver no escribe (D-5, CA-9)", () => {
  it("lectura (solo prorrata.ver): 403 permiso_denegado y no se escribe; pero sí ve la prorrata usada", async () => {
    const c = await nuevoCliente();
    await sembrar(c, conUsadaEnM("80.00"));
    const antes = await v.fotoProrrata(E.tenantId, c.id);
    const r = await guardar(lectura, c, M, { porcentaje: "50.00", version: 0 });
    expect(r.status, r.text).toBe(403);
    expect(r.body).toEqual({ codigo: "permiso_denegado" });
    expect(await v.fotoProrrata(E.tenantId, c.id)).toEqual(antes);
    const l = await vista(lectura, c);
    expect(l.status, l.text).toBe(200);
    expect(l.body.prorrataUsada).toEqual({ valor: "80.00", origen: "declarada" });
  });
});

// --- Trazas ---------------------------------------------------------------------------------------------------------------------------------------

describe("prorrata usada · sin porcentaje, RUC ni claves en logs, errores ni auditoría (D-6, D-7, CA-10)", () => {
  it("guardar, repetir (409) y fallar con el canario: nada del canario en logs, errores ni auditoría", async () => {
    const c = await nuevoCliente();
    const { resultado, logs } = await capturarLogs(async () => ({
      ok: await guardar(contador, c, M, { porcentaje: CANARIO.porcentaje, version: 0 }),
      cambiado: await guardar(contador, c, M, { porcentaje: CANARIO.porcentaje, version: 0 }),
      invalido: await guardar(contador, c, M, { porcentaje: CANARIO.porcentaje, version: 0, extra: CANARIO.porcentaje }),
    }));
    expect(resultado.ok.status, resultado.ok.text).toBe(200);
    expect(resultado.cambiado.status, resultado.cambiado.text).toBe(409);
    expect(resultado.invalido.status, resultado.invalido.text).toBe(400);
    for (const r of Object.values(resultado)) {
      expect(r.text).not.toContain(CANARIO.porcentaje);
      expect(r.text).not.toContain(c.ruc);
    }
    expect(logs).not.toContain(CANARIO.porcentaje);
    expect(logs).not.toContain(c.ruc);
    expect(await v.textoAuditoria(E.tenantId)).not.toContain(CANARIO.porcentaje);
  });
});
