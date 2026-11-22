/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 026 (T6, rojo): «Obtener declaraciones», encolar `sol.declaraciones.descargar` (D-3, D-5, D-7; CA-1, CA-7, CA-9, CA-10).
// Contrato (plan 026, «Contratos: HTTP» y «Cola»; `obtenerDeclaracionesSchema` de `@contapp/shared`):
//  - `POST /clientes/:clienteId/prorrata/declaraciones` (`prorrata.gestionar`) con `{periodo: AAAAMM}` (`.strict()`) -> 202 `{trabajoId}`
//    y nada más: fila `sol.declaraciones.descargar` (cola y canal `sol`, parámetros `{periodo}` y nada más, `creado_por` = quien pulsó,
//    RUC del cliente, en cola). [T6] prioridad `interactivo` (lo pidió una persona: como `sol.buzon.revisar` y la importación de 025).
//    El backend NO llama a SOL ni descifra la clave: solo encola. No audita al pedir (las cuatro acciones de 026 las escribe el
//    trabajo o los guardados) y no toca las cuatro tablas, ni ventas ni compras.
//  - Dedupe de 008 por cliente y periodo (`idempotente`): pedidos repetidos o simultáneos del mismo cliente y periodo comparten UN trabajo
//    y devuelven el mismo `trabajoId`. [T6] el repetido responde 200 o 202 (el plan solo fija 202); otro periodo es otro trabajo.
//  - 409 `cliente_archivado` > `credencial_no_configurada` > `credencial_invalida` (SOL), en ese orden de precedencia, sin encolar.
//    400 `periodo_futuro` (M posterior al mes en curso en Lima) o `solicitud_invalida` (cuerpo fuera del esquema). Cliente de otro estudio,
//    no visible o inexistente: 404 igual. Ni el RUC ni datos del cliente en ninguna respuesta de error, log ni auditoría (D-7).
// Rojo: las rutas aún no existen (T12): responden 404 de ruta inexistente.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { capturarLogs } from "../../../test/soporte.js";
import {
  abrirBancoProrrata,
  CANARIO,
  conReloj,
  M,
  NO_ENCONTRADO,
  PERMISO_DENEGADO,
  rutaObtener,
  TIPO_TRABAJO,
  type Actor,
  type BancoProrrata,
  type Estudio,
} from "../../../test/soporte-prorrata.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let v: BancoProrrata;
let E: Estudio;
let contador: Actor; // responsable del cliente: prorrata.gestionar
let asistente: Actor; // colaborador: solo prorrata.ver
let lectura: Actor; // colaborador: solo prorrata.ver
let contadorAjeno: Actor; // contador del estudio sin el cliente asignado: no lo ve

beforeAll(async () => {
  v = await abrirBancoProrrata();
  E = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
  lectura = await p.miembro(E.tenantId, "lectura");
  contadorAjeno = await p.miembro(E.tenantId, "contador");
});
afterAll(async () => {
  await v?.cerrar();
});
afterEach(() => {
  vi.useRealTimers();
});

type Cliente = { id: string; ruc: string };
const nuevoCliente = (o: Parameters<typeof v.cliente>[1] = {}): Promise<Cliente> =>
  v.cliente(E, { responsable: contador.id, colaboradores: [asistente.id, lectura.id], ...o });
const u = (): string => E.titular.id;
// Sin tercer argumento pide M; con `undefined` explícito NO envía cuerpo (un valor por omisión de parámetro lo taparía).
const obtener = (a: Actor, c: { id: string }, ...cuerpo: [unknown?]) =>
  v.http(a, "POST", rutaObtener(c.id), cuerpo.length === 0 ? { periodo: M } : cuerpo[0]);

/** Una respuesta de error no lleva datos del cliente ni de la prorrata (D-7). */
function sinDatos(r: { text: string }, c: Cliente): void {
  expect(r.text).not.toContain(c.ruc);
  expect(r.text).not.toContain(CANARIO.ruc);
  expect(r.text).not.toMatch(/\d+\.\d{2}/);
}

// --- Camino feliz -------------------------------------------------------------------------------------------------------------

describe("POST …/prorrata/declaraciones · encola sin llamar a SOL (CA-1, CA-7)", () => {
  it("202 { trabajoId }: un trabajo sol.declaraciones.descargar en cola y canal sol con parámetros {periodo}, creado por quien pulsó", async () => {
    const c = await nuevoCliente();
    const r = await obtener(contador, c);
    expect(r.status, r.text).toBe(202);
    expect(Object.keys(r.body)).toEqual(["trabajoId"]);
    expect(typeof r.body.trabajoId).toBe("string");
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(r.ms).toBeLessThan(3000); // nada espera a SOL

    const trabajos = await v.trabajosDescarga(E.tenantId, c.id);
    expect(trabajos).toHaveLength(1);
    expect(trabajos[0]).toMatchObject({
      id: r.body.trabajoId,
      tenant_id: E.tenantId,
      cliente_id: c.id,
      tipo: TIPO_TRABAJO,
      cola: "sol",
      canal: "sol",
      prioridad: "interactivo",
      estado: "en_cola",
      creado_por: contador.id,
      ruc: c.ruc,
    });
    expect(trabajos[0].parametros).toEqual({ periodo: M }); // el cliente sale de la fila del trabajo; la ventana, del periodo
  });

  it("solo encola: no escribe en las cuatro tablas, ni en ventas ni compras, ni audita al pedir", async () => {
    const c = await nuevoCliente();
    await v.sembrarVentasSire(E.tenantId, c.id, M, [], u());
    const antes = await v.fotoProrrata(E.tenantId, c.id);
    const r = await obtener(contador, c);
    expect(r.status, r.text).toBe(202);
    const despues = (await v.fotoProrrata(E.tenantId, c.id)) as any;
    expect({ ...despues, trabajos: 0 }).toEqual({ ...(antes as any), trabajos: 0 });
    expect(despues.trabajos).toBe(1);
    expect(await v.auditoria026(E.tenantId)).not.toContainEqual(expect.objectContaining({ cliente_id: c.id }));
  });

  it.each(["202610", "202601", "202512"])("el periodo %s viaja tal cual en los parámetros del trabajo", async (periodo) => {
    const c = await nuevoCliente();
    const r = await obtener(contador, c, { periodo });
    expect(r.status, r.text).toBe(202);
    expect((await v.trabajosDescarga(E.tenantId, c.id))[0]?.parametros).toEqual({ periodo });
  });

  it("dos pedidos del mismo cliente y periodo comparten UN trabajo (dedupe de 008) y devuelven el mismo trabajoId", async () => {
    const c = await nuevoCliente();
    const a = await obtener(contador, c);
    const b = await obtener(contador, c);
    expect(a.status, a.text).toBe(202);
    expect([200, 202], b.text).toContain(b.status);
    expect(b.body.trabajoId).toBe(a.body.trabajoId);
    expect(await v.trabajosDescarga(E.tenantId, c.id)).toHaveLength(1);
  });

  it("otro periodo del mismo cliente es otro trabajo; el mismo periodo de OTRO cliente también", async () => {
    const c = await nuevoCliente();
    const d = await nuevoCliente();
    const a = await obtener(contador, c, { periodo: "202610" });
    const b = await obtener(contador, c, { periodo: "202609" });
    const x = await obtener(contador, d, { periodo: "202610" });
    for (const r of [a, b, x]) expect(r.status, r.text).toBe(202);
    expect(new Set([a.body.trabajoId, b.body.trabajoId, x.body.trabajoId]).size).toBe(3);
    expect(await v.trabajosDescarga(E.tenantId, c.id)).toHaveLength(2);
    expect(await v.trabajosDescarga(E.tenantId, d.id)).toHaveLength(1);
  });

  it("20 pedidos simultáneos del mismo cliente y periodo dejan UN trabajo y todos reciben su id", async () => {
    const c = await nuevoCliente();
    const rs = await Promise.all(Array.from({ length: 20 }, () => obtener(contador, c)));
    for (const r of rs) expect([200, 202], r.text).toContain(r.status);
    expect(new Set(rs.map((r) => r.body.trabajoId)).size).toBe(1);
    expect(await v.trabajosDescarga(E.tenantId, c.id)).toHaveLength(1);
  });

  it("con un trabajo del mismo periodo ya en ejecución, el pedido comparte ese trabajo (no encola otro)", async () => {
    const c = await nuevoCliente();
    const viva = await v.sembrarTrabajoDescarga(E.tenantId, c.id, M, "ejecutando", u());
    const r = await obtener(contador, c);
    expect([200, 202], r.text).toContain(r.status);
    expect(r.body.trabajoId).toBe(viva);
    expect(await v.trabajosDescarga(E.tenantId, c.id)).toHaveLength(1);
  });

  it("funciona igual en un estudio con el plan más pequeño y sin ninguna característica (U-13: todos los planes)", async () => {
    const plan = await v.b.c.p.plan({ features: {}, maxRucs: 1 });
    const F = await v.b.c.p.estudio(plan);
    const cont = await v.b.c.p.b.miembro(F.tenantId, "contador");
    const c = await v.cliente(F, { responsable: cont.id });
    const r = await obtener(cont, c);
    expect(r.status, r.text).toBe(202);
    expect(await v.trabajosDescarga(F.tenantId, c.id)).toHaveLength(1);
  });
});

// --- Periodo -----------------------------------------------------------------------------------------------------------------------

describe("POST …/prorrata/declaraciones · periodo y cuerpo inválidos (sin trabajo)", () => {
  it.each([
    ["202611", "2026-03-15T17:00:00Z"], // dentro del mes siguiente al reloj
    ["202604", "2026-03-15T17:00:00Z"],
    ["202701", "2026-03-15T17:00:00Z"],
    ["202604", "2026-04-01T04:59:00Z"], // en Lima todavía es marzo
  ])("M = %s con el reloj en %s (Lima): 400 periodo_futuro y no se encola", async (periodo, ahora) => {
    const c = await nuevoCliente();
    const r = await conReloj(ahora, () => obtener(contador, c, { periodo }));
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "periodo_futuro" });
    expect(await v.trabajosDescarga(E.tenantId, c.id)).toHaveLength(0);
  });

  it.each([
    ["202603", "2026-03-15T17:00:00Z"], // el mes en curso se puede pedir
    ["202604", "2026-04-01T05:00:00Z"], // ya es abril en Lima
  ])("M = %s con el reloj en %s (Lima): se acepta", async (periodo, ahora) => {
    const c = await nuevoCliente();
    const r = await conReloj(ahora, () => obtener(contador, c, { periodo }));
    expect(r.status, r.text).toBe(202);
  });

  it.each([
    ["sin cuerpo", undefined],
    ["cuerpo vacío", {}],
    ["periodo con guion", { periodo: "2026-10" }],
    ["mes 13", { periodo: "202613" }],
    ["mes 00", { periodo: "202600" }],
    ["periodo numérico", { periodo: 202610 }],
    ["periodo nulo", { periodo: null }],
    ["periodo con espacios", { periodo: " 202610 " }],
    ["clave extra (el cliente sale de la ruta)", { periodo: "202610", clienteId: "x" }],
    ["clave extra (tenant)", { periodo: "202610", tenantId: "x" }],
    ["clave extra (credencial)", { periodo: "202610", claveSol: "CANARIO-SOL-clave" }],
    ["arreglo de periodos", { periodo: ["202610"] }],
  ])("%s: 400 solicitud_invalida y no se encola", async (_n, cuerpo) => {
    const c = await nuevoCliente();
    const antes = await v.fotoProrrata(E.tenantId, c.id);
    const r = await obtener(contador, c, cuerpo);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(r.text).not.toContain("CANARIO-SOL-clave");
    expect(await v.fotoProrrata(E.tenantId, c.id)).toEqual(antes);
  });
});

// --- 409 --------------------------------------------------------------------------------------------------------------------------

describe("POST …/prorrata/declaraciones · 409 sin encolar (D-5, CA-9)", () => {
  const sinTrabajo = async (c: Cliente, antes: unknown): Promise<void> => {
    expect(await v.fotoProrrata(E.tenantId, c.id)).toEqual(antes);
  };

  it("cliente archivado: 409 cliente_archivado", async () => {
    const c = await nuevoCliente({ archivado: true });
    const antes = await v.fotoProrrata(E.tenantId, c.id);
    const r = await obtener(contador, c);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
    sinDatos(r, c);
    await sinTrabajo(c, antes);
  });

  it("sin clave SOL configurada: 409 credencial_no_configurada (el manual sigue disponible: no depende de SOL)", async () => {
    const c = await nuevoCliente({ sol: "no_configurada" });
    const antes = await v.fotoProrrata(E.tenantId, c.id);
    const r = await obtener(contador, c);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "credencial_no_configurada" });
    sinDatos(r, c);
    await sinTrabajo(c, antes);
  });

  it("clave SOL marcada inválida: 409 credencial_invalida", async () => {
    const c = await nuevoCliente({ sol: "invalida" });
    const antes = await v.fotoProrrata(E.tenantId, c.id);
    const r = await obtener(contador, c);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "credencial_invalida" });
    sinDatos(r, c);
    await sinTrabajo(c, antes);
  });

  it("la credencial de la API del SIRE no cuenta: solo importa la clave SOL (credencial `sol` del catálogo)", async () => {
    const c = await nuevoCliente({ sol: "verificada", sireApi: "no_configurada" });
    const r = await obtener(contador, c);
    expect(r.status, r.text).toBe(202);
  });

  it("precedencia: archivado gana a la credencial ausente o inválida", async () => {
    const c = await nuevoCliente({ archivado: true, sol: "no_configurada" });
    const r = await obtener(contador, c);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
    const d = await nuevoCliente({ archivado: true, sol: "invalida" });
    expect((await obtener(contador, d)).body).toEqual({ codigo: "cliente_archivado" });
  });
});

// --- Permisos y alcance --------------------------------------------------------------------------------------------------------------

describe("POST …/prorrata/declaraciones · permisos y alcance (D-5, CA-9)", () => {
  it.each([
    ["asistente (solo prorrata.ver)", () => asistente],
    ["lectura (solo prorrata.ver)", () => lectura],
  ])("%s: 403 permiso_denegado y no se encola", async (_n, quien) => {
    const c = await nuevoCliente();
    const antes = await v.fotoProrrata(E.tenantId, c.id);
    const r = await obtener(quien(), c);
    expect(r.status, r.text).toBe(403);
    expect(r.body).toEqual(PERMISO_DENEGADO);
    expect(await v.fotoProrrata(E.tenantId, c.id)).toEqual(antes);
  });

  it("el Dueño y el Administrador obtienen aunque no estén asignados (alcance global)", async () => {
    const c = await nuevoCliente();
    const admin = await v.b.c.p.b.miembro(E.tenantId, "admin");
    const r1 = await obtener(E.titular, c, { periodo: "202610" });
    const r2 = await obtener(admin, c, { periodo: "202609" });
    expect(r1.status, r1.text).toBe(202);
    expect(r2.status, r2.text).toBe(202);
    const trabajos = await v.trabajosDescarga(E.tenantId, c.id);
    expect(trabajos.map((t) => t.creado_por).sort()).toEqual([E.titular.id, admin.id].sort());
  });

  it("un Contador sin el cliente asignado recibe 404, igual que ante un cliente inexistente, y no se encola", async () => {
    const c = await nuevoCliente();
    // Control: la ruta existe y quien tiene el cliente asignado obtiene (si no, el 404 de abajo sería el de «ruta inexistente»).
    const control = await obtener(contador, await nuevoCliente());
    expect(control.status, control.text).toBe(202);
    const noExiste = await obtener(contador, { id: "00000000-0000-4000-8000-000000000000" });
    const r = await obtener(contadorAjeno, c);
    expect(r.status, r.text).toBe(404);
    expect(r.body).toEqual(NO_ENCONTRADO);
    expect(r.text).toBe(noExiste.text);
    expect(await v.trabajosDescarga(E.tenantId, c.id)).toHaveLength(0);
  });

  it("un Contador asignado como colaborador (no responsable) también obtiene", async () => {
    const c = await v.cliente(E, { colaboradores: [contador.id] });
    const r = await obtener(contador, c);
    expect(r.status, r.text).toBe(202);
  });

  it("un cliente de OTRO estudio: 404 igual que uno inexistente, sin trabajo en ninguno de los dos", async () => {
    const F = await v.estudio();
    const ajeno = await v.cliente(F, {});
    const control = await obtener(E.titular, await nuevoCliente()); // la ruta existe: el 404 de abajo no es «ruta inexistente»
    expect(control.status, control.text).toBe(202);
    const r = await obtener(E.titular, ajeno);
    expect(r.status, r.text).toBe(404);
    expect(r.body).toEqual(NO_ENCONTRADO);
    expect(await v.trabajosDescarga(F.tenantId, ajeno.id)).toHaveLength(0);
    expect(await v.trabajosDescarga(E.tenantId, ajeno.id)).toHaveLength(0);
  });

  it("sin sesión: 401 y no se encola", async () => {
    const c = await nuevoCliente();
    const r = await v.sinSesion("POST", rutaObtener(c.id), { periodo: M });
    expect([401, 403]).toContain(r.status);
    expect(await v.trabajosDescarga(E.tenantId, c.id)).toHaveLength(0);
  });
});

// --- Secretos y trazas (CA-10) ----------------------------------------------------------------------------------------------------------

describe("POST …/prorrata/declaraciones · ni clave ni RUC en logs, errores ni auditoría (D-7, CA-10)", () => {
  it("la respuesta, los logs y la auditoría no contienen el RUC del cliente ni claves (canario en el cuerpo)", async () => {
    const c = await nuevoCliente();
    const { resultado: r, logs } = await capturarLogs(() => obtener(contador, c, { periodo: M, claveSol: "CANARIO-SOL-clave" }));
    expect(r.status, r.text).toBe(400); // la clave en el cuerpo es una clave extra: el esquema es estricto
    expect(r.text).not.toContain("CANARIO-SOL-clave");
    expect(logs).not.toContain("CANARIO-SOL-clave");
    const ok = await capturarLogs(() => obtener(contador, c));
    expect(ok.resultado.status, ok.resultado.text).toBe(202);
    expect(ok.logs).not.toContain(c.ruc);
    expect(ok.resultado.text).not.toContain(c.ruc);
    expect(await v.textoAuditoria(E.tenantId)).not.toContain("CANARIO-SOL-clave");
  });
});
