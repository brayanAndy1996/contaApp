/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 021 (T5, rojo): reglas del motor por estudio por HTTP (RF-089, D-9, P-8, P-10; CA-8, CA-13).
// Contrato (plan 021, «Contratos: HTTP»; forma de `reglasMotorSchema`, `fijarReglaMotorSchema` y `fijarAporteSchema` de `@contapp/shared`):
//  - `GET /estudio/reglas-motor` (`reglas.ver`) -> 200 `{reglas: [{codigo, descripcion, activa}], aportarCatalogo}` con los seis códigos de
//    `CODIGOS_REGLA_MOTOR` en orden (R-ISC, R-MIX, R-RED, R-NEW, R-GP, R-HIS); sin fila guardada = encendida; la prevalidación de 012
//    no figura (P-8). Sin configuración guardada, `aportarCatalogo = true`.
//  - `PUT /estudio/reglas-motor/:codigo {activa}` y `PUT /estudio/reglas-motor/aporte {aportar}`: `reglas.gestionar` Y rol de alcance
//    global (dueño o administrador); sin ellos 403. Un código fuera del catálogo (la prevalidación, minúsculas…) es 404. La ruta
//    estática `aporte` va antes de `:codigo`. Cuerpo inválido: 400 `solicitud_invalida`.
//  - Auditoría (017): `estudio.regla_motor` (`datos = {codigo, activa}`) y `estudio.aporte_catalogo`, con el usuario.
//  - `Cache-Control: no-store`. El interruptor es del estudio: apagar una regla en un estudio no cambia a los demás.
// Rojo: las rutas aún no existen (T11): responden 404 de ruta inexistente.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBancoReglas, cumple, CODIGOS_MOTOR, RUTA_MOTOR, type Actor, type BancoReglas, type Estudio } from "../../../test/soporte-reglas.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let v: BancoReglas;
let E: Estudio;
let F: Estudio;
let admin: Actor; // alcance global
let contador: Actor; // reglas.gestionar, alcance asignado
let asistente: Actor;
let lectura: Actor;

beforeAll(async () => {
  v = await abrirBancoReglas();
  E = await v.estudio();
  F = await v.estudio();
  const p = v.b.c.p.b;
  admin = await p.miembro(E.tenantId, "admin");
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
  lectura = await p.miembro(E.tenantId, "lectura");
});
afterEach(async () => {
  // Cada prueba empieza con el estudio sin interruptores guardados (todo encendido, aporte encendido).
  for (const t of [E.tenantId, F.tenantId]) {
    await v.b.sql("delete from estudio_regla_motor where tenant_id = $1", [t]).catch(() => undefined);
    await v.b.sql("delete from estudio_reglas_config where tenant_id = $1", [t]).catch(() => undefined);
  }
});
afterAll(async () => {
  await v?.cerrar();
});

const leer = (a: Actor) => v.http(a, "GET", RUTA_MOTOR);
const fijar = (a: Actor, codigo: string, cuerpo: unknown) => v.http(a, "PUT", `${RUTA_MOTOR}/${encodeURIComponent(codigo)}`, cuerpo);
const aporte = (a: Actor, cuerpo: unknown) => v.http(a, "PUT", `${RUTA_MOTOR}/aporte`, cuerpo);
const estado = async (a: Actor): Promise<Record<string, boolean>> => {
  const r = await leer(a);
  expect(r.status, r.text).toBe(200);
  return Object.fromEntries((r.body.reglas as any[]).map((x) => [x.codigo, x.activa as boolean]));
};
const guardadas = async (tenantId: string): Promise<any[]> =>
  v.b.sql("select codigo, activa from estudio_regla_motor where tenant_id = $1 order by codigo", [tenantId]);

describe("GET /estudio/reglas-motor (RF-089, CA-8)", () => {
  it("200 con los seis códigos en orden, descripción simple, todas encendidas y el aporte encendido", async () => {
    const r = await leer(admin);
    expect(r.status, r.text).toBe(200);
    expect(cumple("reglasMotorSchema", r.body), r.text).toBe(true);
    expect(Object.keys(r.body).sort()).toEqual(["aportarCatalogo", "reglas"]);
    expect((r.body.reglas as any[]).map((x) => x.codigo)).toEqual([...CODIGOS_MOTOR]);
    for (const x of r.body.reglas as any[]) {
      expect(Object.keys(x).sort()).toEqual(["activa", "codigo", "descripcion"]);
      expect(x.activa, x.codigo).toBe(true);
      expect(typeof x.descripcion === "string" && x.descripcion.trim().length > 0, x.codigo).toBe(true);
    }
    expect(r.body.aportarCatalogo).toBe(true);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
  });

  it("P-8 · la prevalidación de 012 no figura", async () => {
    const r = await leer(admin);
    expect(r.status, r.text).toBe(200);
    expect(r.text).not.toMatch(/prevalidaci/i);
    expect(r.body.reglas).toHaveLength(6);
  });

  it.each([
    ["admin", () => admin],
    ["dueño", () => E.titular],
    ["contador", () => contador],
    ["asistente", () => asistente],
    ["lectura", () => lectura],
  ])("%s con reglas.ver la lee (200)", async (_n, quien) => {
    const r = await leer(quien());
    expect(r.status, r.text).toBe(200);
  });

  it("refleja lo guardado: una regla apagada y el aporte apagado", async () => {
    await v.fijarMotorBd(E.tenantId, "R-GP", false, admin.id);
    await v.fijarAporteBd(E.tenantId, false);
    const r = await leer(lectura);
    expect(r.status, r.text).toBe(200);
    expect(Object.entries(await estado(lectura)).filter(([, activa]) => !activa)).toEqual([["R-GP", false]]);
    expect(r.body.aportarCatalogo).toBe(false);
  });

  it("es del estudio: lo apagado en uno no se ve en otro", async () => {
    await v.fijarMotorBd(E.tenantId, "R-ISC", false, admin.id);
    expect((await estado(admin))["R-ISC"]).toBe(false);
    expect((await estado(F.titular))["R-ISC"]).toBe(true);
  });

  it("sin sesión: 401", async () => {
    const r = await v.sinSesion("GET", RUTA_MOTOR);
    expect(r.status, r.text).toBe(401);
  });
});

describe("PUT /estudio/reglas-motor/:codigo (CA-8)", () => {
  it.each([...CODIGOS_MOTOR])("el administrador apaga %s y la lista lo muestra; el resto sigue encendido", async (codigo) => {
    const r = await fijar(admin, codigo, { activa: false });
    expect(r.status, r.text).toBe(200);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    const e = await estado(lectura);
    expect(e[codigo]).toBe(false);
    expect(Object.entries(e).filter(([, activa]) => activa)).toHaveLength(5);
    expect(await guardadas(E.tenantId)).toEqual([{ codigo, activa: false }]);
  });

  it("el dueño apaga y vuelve a encender: queda registrado el último valor", async () => {
    expect((await fijar(E.titular, "R-MIX", { activa: false })).status).toBe(200);
    expect((await estado(admin))["R-MIX"]).toBe(false);
    expect((await fijar(E.titular, "R-MIX", { activa: true })).status).toBe(200);
    expect((await estado(admin))["R-MIX"]).toBe(true);
  });

  it("fijar dos veces el mismo valor es 200 (idempotente)", async () => {
    expect((await fijar(admin, "R-RED", { activa: false })).status).toBe(200);
    expect((await fijar(admin, "R-RED", { activa: false })).status).toBe(200);
    expect((await estado(admin))["R-RED"]).toBe(false);
  });

  it("D-9 · el interruptor es del estudio: no cambia a otro estudio", async () => {
    expect((await fijar(admin, "R-NEW", { activa: false })).status).toBe(200);
    expect((await estado(F.titular))["R-NEW"]).toBe(true);
    expect(await guardadas(F.tenantId)).toEqual([]);
  });

  it("auditoría: estudio.regla_motor con el usuario y {codigo, activa}", async () => {
    // Otras pruebas del archivo ya auditaron R-GP en este estudio: se exige exactamente una fila más.
    const delGp = async () => (await v.auditoriaDe(E.tenantId, "estudio.regla_motor")).filter((a) => a.datos.codigo === "R-GP");
    const antes = (await delGp()).length;
    expect((await fijar(admin, "R-GP", { activa: false })).status).toBe(200);
    const aud = await delGp();
    expect(aud).toHaveLength(antes + 1);
    const nueva = aud.at(-1);
    expect(nueva).toMatchObject({ actor_tipo: "usuario", usuario_id: admin.id });
    expect(nueva.datos).toEqual({ codigo: "R-GP", activa: false });
  });

  it.each([
    ["contador (reglas.gestionar sin alcance global)", () => contador],
    ["asistente", () => asistente],
    ["lectura", () => lectura],
  ])("D-9 · %s: 403 y no cambia nada", async (_n, quien) => {
    const r = await fijar(quien(), "R-GP", { activa: false });
    expect(r.status, r.text).toBe(403);
    expect(r.body).toEqual({ codigo: "permiso_denegado" });
    expect(await guardadas(E.tenantId)).toEqual([]);
    expect((await estado(admin))["R-GP"]).toBe(true);
  });

  it.each([
    ["la prevalidación", "prevalidacion"],
    ["la prevalidación en mayúsculas", "PREVALIDACION"],
    ["un código de otra spec", "R-XML"],
    ["el código en minúsculas", "r-his"],
    ["un código con espacio", "R-HIS "],
    ["un prefijo de código", "R-"],
  ])("P-8 · %s está fuera del catálogo: 404 y no se guarda nada", async (_n, codigo) => {
    const r = await fijar(admin, codigo, { activa: false });
    expect(r.status, r.text).toBe(404);
    expect(await guardadas(E.tenantId)).toEqual([]);
  });

  it.each([
    ["sin activa", {}],
    ["activa como cadena", { activa: "false" }],
    ["activa como número", { activa: 0 }],
    ["activa nula", { activa: null }],
    ["el cuerpo del aporte", { aportar: false }],
  ])("400 solicitud_invalida y no se guarda nada: %s", async (_n, cuerpo) => {
    const r = await fijar(admin, "R-ISC", cuerpo);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await guardadas(E.tenantId)).toEqual([]);
  });
});

describe("PUT /estudio/reglas-motor/aporte (P-10, CA-6)", () => {
  it("el administrador apaga el aporte: 200, la lista lo muestra y ninguna regla cambia", async () => {
    const r = await aporte(admin, { aportar: false });
    expect(r.status, r.text).toBe(200);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    const l = await leer(lectura);
    expect(l.body.aportarCatalogo).toBe(false);
    expect(Object.values(await estado(lectura)).every(Boolean)).toBe(true);
    expect(await guardadas(E.tenantId)).toEqual([]);
  });

  it("el dueño lo vuelve a encender", async () => {
    expect((await aporte(admin, { aportar: false })).status).toBe(200);
    expect((await aporte(E.titular, { aportar: true })).status).toBe(200);
    expect((await leer(admin)).body.aportarCatalogo).toBe(true);
  });

  it("auditoría: estudio.aporte_catalogo con el usuario", async () => {
    // Otras pruebas del archivo ya auditaron el aporte en este estudio: se exige exactamente una fila más.
    const antes = (await v.auditoriaDe(E.tenantId, "estudio.aporte_catalogo")).length;
    expect((await aporte(admin, { aportar: false })).status).toBe(200);
    const aud = await v.auditoriaDe(E.tenantId, "estudio.aporte_catalogo");
    expect(aud).toHaveLength(antes + 1);
    expect(aud.at(-1)).toMatchObject({ actor_tipo: "usuario", usuario_id: admin.id });
  });

  it("es del estudio: no cambia el aporte de otro", async () => {
    expect((await aporte(admin, { aportar: false })).status).toBe(200);
    expect((await leer(F.titular)).body.aportarCatalogo).toBe(true);
  });

  it.each([
    ["contador", () => contador],
    ["asistente", () => asistente],
    ["lectura", () => lectura],
  ])("%s: 403 y el aporte sigue encendido", async (_n, quien) => {
    const r = await aporte(quien(), { aportar: false });
    expect(r.status, r.text).toBe(403);
    expect(r.body).toEqual({ codigo: "permiso_denegado" });
    expect((await leer(admin)).body.aportarCatalogo).toBe(true);
  });

  it.each([
    ["sin aportar", {}],
    ["aportar como cadena", { aportar: "false" }],
    ["aportar nulo", { aportar: null }],
    ["el cuerpo de un interruptor", { activa: false }],
  ])("400 solicitud_invalida (la ruta estática va antes de :codigo): %s", async (_n, cuerpo) => {
    const r = await aporte(admin, cuerpo);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect((await leer(admin)).body.aportarCatalogo).toBe(true);
  });
});
