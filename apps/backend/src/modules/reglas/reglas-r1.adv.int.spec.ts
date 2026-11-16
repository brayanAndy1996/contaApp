/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 021 · T16: ronda adversarial 1 sobre las rutas de reglas aprendidas (caja negra y luego blanca). Frentes: permisos y alcance
// con la sesión viva, cuerpos con identidades ajenas, contrato de «Recordar», canarios en errores y concurrencia contra una descarga.
// Una prueba marcada `it.fails` es un hallazgo H-021-1-n (convención de 022 T3): documenta el defecto sin romper la suite y pasa a
// `it` cuando se corrige. Las demás quedan como regresión.
import { createDb, type ContappDb } from "@contapp/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoReglas,
  PERIODO,
  rutaReglas,
  type Actor,
  type BancoReglas,
  type Estudio,
} from "../../../test/soporte-reglas.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let v: BancoReglas;
let E: Estudio;
let F: Estudio;
let contador: Actor; // responsable
let colaborador: Actor; // contador colaborador: tiene reglas.gestionar mientras esté asignado
let worker: ContappDb;

const PROV = "20700000011";
const RAZON = "CANARIO RAZON R1 SAC";

beforeAll(async () => {
  v = await abrirBancoReglas();
  E = await v.estudio();
  F = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  colaborador = await p.miembro(E.tenantId, "contador");
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (!url) throw new Error("falta MIGRATIONS_DATABASE_URL");
  worker = createDb({ rolApp: "contapp_worker", url, poolMax: 2 });
});
afterAll(async () => {
  await worker?.close();
  await v?.cerrar();
});

type Cliente = { id: string; ruc: string };
const nuevoCliente = (est: Estudio = E, o: Parameters<BancoReglas["cliente"]>[1] = {}): Promise<Cliente> =>
  v.cliente(est, est === E ? { responsable: contador.id, colaboradores: [colaborador.id], ...o } : o);
const compra = (c: Cliente, numero: string, o: { periodo?: string; doc?: string; estudio?: Estudio } = {}) =>
  v.sembrarCompra((o.estudio ?? E).tenantId, c.id, {
    serie: "F001",
    numero,
    doc: o.doc ?? PROV,
    razonSocial: RAZON,
    ...(o.periodo === undefined ? {} : { periodo: o.periodo }),
    usuarioId: (o.estudio ?? E).titular.id,
  });
const recordar = (a: Actor, c: { id: string }, compraIds: string[], destino: string, versionBase: number | null) =>
  v.http(a, "POST", `${rutaReglas(c.id)}/recordar`, { compraIds, destino, versionBase });
const editar = (a: Actor, c: { id: string }, reglaId: string, cuerpo: unknown) => v.http(a, "PATCH", `${rutaReglas(c.id)}/${reglaId}`, cuerpo);
const eliminar = (a: Actor, c: { id: string }, reglaId: string, versionBase: number) =>
  v.http(a, "DELETE", `${rutaReglas(c.id)}/${reglaId}?versionBase=${versionBase}`);
const vivas = async (c: Cliente) => (await v.reglasBd(c.id)).filter((r: any) => !r.eliminada);

function sinCanarios(texto: string): void {
  expect(texto).not.toContain(PROV);
  expect(texto).not.toContain(RAZON);
  expect(texto).not.toMatch(/\d+\.\d{2}/);
}

// ===================================================================================================================
// Caja negra (spec, plan «Contratos: HTTP» y 04 §2.3: permisos y alcance con la sesión viva)
// ===================================================================================================================

describe("R1 · permisos y alcance con la sesión viva (D-9, CA-5)", () => {
  it("cliente desasignado durante la sesión: GET, Recordar, PATCH y DELETE dan el 404 de inexistente y nada se escribe", async () => {
    const c = await nuevoCliente();
    const id = await compra(c, "1");
    const regla = await v.sembrarRegla(E.tenantId, c.id, { usuarioId: E.titular.id, destino: "DNG" });
    // Control: asignado, ve las reglas.
    expect((await v.http(colaborador, "GET", rutaReglas(c.id))).status).toBe(200);
    const q = await v.http(E.titular, "DELETE", `/clientes/${c.id}/asignaciones/${colaborador.id}`);
    expect(q.status, q.text).toBe(204);
    const antes = await v.reglasBd(c.id);
    const respuestas = [
      await v.http(colaborador, "GET", rutaReglas(c.id)),
      await recordar(colaborador, c, [id], "DG", 1),
      await editar(colaborador, c, regla, { versionBase: 1, destino: "DG" }),
      await eliminar(colaborador, c, regla, 1),
    ];
    for (const r of respuestas) {
      expect(r.status, r.text).toBe(404);
      expect(r.body).toEqual({ codigo: "no_encontrado" });
    }
    expect(await v.reglasBd(c.id)).toEqual(antes);
  });

  it("usuario desactivado con la sesión viva: «Recordar» y PATCH se rechazan (401/403) y la regla no cambia", async () => {
    const p = v.b.c.p.b;
    const x = await p.miembro(E.tenantId, "contador");
    const c = await nuevoCliente(E, { colaboradores: [colaborador.id, x.id] });
    const id = await compra(c, "1");
    const regla = await v.sembrarRegla(E.tenantId, c.id, { usuarioId: E.titular.id, destino: "DNG" });
    const d = await v.http(E.titular, "POST", `/usuarios/${x.id}/desactivar`);
    expect(d.status, d.text).toBeLessThan(300);
    const antes = await v.reglasBd(c.id);
    for (const r of [await recordar(x, c, [id], "DG", 1), await editar(x, c, regla, { versionBase: 1, activa: false })]) {
      expect([401, 403], r.text).toContain(r.status);
    }
    expect(await v.reglasBd(c.id)).toEqual(antes);
  });
});

describe("R1 · identidades ajenas en el cuerpo (CA-5, D-2)", () => {
  it("clienteId, tenantId, proveedor y periodo de otro cliente u otro estudio en el cuerpo se ignoran: la regla es del cliente de la URL y del proveedor de la compra", async () => {
    const a = await nuevoCliente();
    const b = await nuevoCliente();
    const ajeno = await nuevoCliente(F);
    const id = await compra(a, "1");
    const intruso = {
      clienteId: b.id,
      tenantId: F.tenantId,
      docTipo: "6",
      docNumero: "20999999990",
      proveedor: { tipo: "6", numero: "20999999990" },
      periodoAprendido: "200001",
      activa: false,
      version: 99,
    };
    const r = await v.http(contador, "POST", `${rutaReglas(a.id)}/recordar`, { compraIds: [id], destino: "DNG", versionBase: null, ...intruso });
    expect(r.status, r.text).toBe(200);
    const [fila] = await vivas(a);
    expect(fila).toMatchObject({ doc_numero: PROV, periodo_aprendido: PERIODO, version: 1, activa: true });
    // `activa` sí es del contrato del PATCH: se quita del intruso para ver solo las claves ajenas.
    const intrusoPatch: Record<string, unknown> = { ...intruso };
    delete intrusoPatch.activa;
    const e = await editar(contador, a, fila.id, { versionBase: 1, destino: "DG", ...intrusoPatch, clienteId: ajeno.id });
    expect(e.status, e.text).toBe(200);
    expect(await vivas(a)).toEqual([expect.objectContaining({ id: fila.id, doc_numero: PROV, destino: "DG", periodo_aprendido: PERIODO, version: 2, activa: true })]);
    expect(await v.reglasBd(b.id)).toEqual([]);
    expect(await v.reglasBd(ajeno.id)).toEqual([]);
  });
});

describe("R1 · contrato de «Recordar» (plan: «todas las compras del cliente, vivas, de un mismo periodo y del mismo proveedor»)", () => {
  // H-021-1-1: el repositorio acepta compras de periodos distintos y fija `periodo_aprendido` al mayor en silencio.
  it("H-021-1-1 · compras del mismo proveedor en dos periodos: se rechaza (no 200) y no se crea regla", async () => {
    const c = await nuevoCliente();
    const p1 = await compra(c, "1", { periodo: "202609" });
    const p2 = await compra(c, "2", { periodo: "202611" });
    const r = await recordar(contador, c, [p1, p2], "DNG", null);
    expect(r.status, r.text).not.toBe(200);
    expect([400, 404, 409, 422]).toContain(r.status);
    expect(await vivas(c)).toEqual([]);
  });
});

describe("R1 · canarios en errores (D-10, CA-13)", () => {
  it("cuerpo JSON mal formado con RUC, razón social y montos dentro: 400 sin eco de la entrada", async () => {
    const c = await nuevoCliente();
    const crudo = `{"compraIds":["${PROV}"],"destino":"${RAZON} 1180.00" ,,, }`;
    for (const [metodo, ruta] of [
      ["POST", `${rutaReglas(c.id)}/recordar`],
      ["PATCH", `${rutaReglas(c.id)}/${crypto.randomUUID()}`],
    ] as const) {
      const m = await v.b.c.p.b.llamar(contador, metodo, ruta, undefined, { crudo });
      expect(m.status, m.text).toBe(400);
      sinCanarios(m.text);
    }
  });
});

// ===================================================================================================================
// Caja blanca (reglas.service.ts, packages/db/src/reglas/escritura.ts, 0047, 0048)
// ===================================================================================================================

describe("R1 · versionBase fuera del rango de `integer` (versionBaseSchema = z.number().int().min(1), sin cota)", () => {
  // H-021-1-2: 2^31 pasa el esquema y llega a `version = $n` (integer): la BD responde 22003 y la ruta da 500.
  it("H-021-1-2 · PATCH, «Recordar» y DELETE con versionBase = 2^31: 409 regla_cambiada (o 400), nunca 500, y la regla no cambia", async () => {
    const c = await nuevoCliente();
    const id = await compra(c, "1");
    const regla = await v.sembrarRegla(E.tenantId, c.id, { usuarioId: E.titular.id, destino: "DNG" });
    const grande = 2 ** 31;
    const antes = await v.reglasBd(c.id);
    for (const r of [
      await editar(contador, c, regla, { versionBase: grande, destino: "DG" }),
      await recordar(contador, c, [id], "DG", grande),
      await v.http(contador, "DELETE", `${rutaReglas(c.id)}/${regla}?versionBase=${grande}`),
    ]) {
      expect([400, 409], r.text).toContain(r.status);
      sinCanarios(r.text);
    }
    expect(await v.reglasBd(c.id)).toEqual(antes);
  });
});

describe("R1 · dos «Recordar» y un PATCH contra una descarga en curso (CA-9, plan: Orden de bloqueo)", () => {
  it("las tres escrituras esperan a la descarga; al terminar gana una (200), las otras dos dan 409 y la descarga aplicó el destino que leyó", async () => {
    const c = await nuevoCliente();
    const id = await compra(c, "1");
    const regla = await v.sembrarRegla(E.tenantId, c.id, { usuarioId: E.titular.id, destino: "DNG" });
    let soltar!: () => void;
    const puerta = new Promise<void>((r) => (soltar = r));
    let leida!: () => void;
    const leyo = new Promise<void>((r) => (leida = r));
    // La descarga del periodo siguiente lee las reglas (FOR SHARE) y queda abierta.
    const descarga = worker.withTenant({ tenantId: E.tenantId }, async (tx) => {
      const r = await tx.query("select regla_id, destino, version from public.reglas_historial_vigentes($1, '202611')", [c.id]);
      leida();
      await puerta;
      return r.rows;
    });
    await leyo;
    let terminadas = 0;
    const contar = <T>(p: Promise<T>) => p.finally(() => (terminadas += 1));
    const escrituras = Promise.all([
      contar(recordar(contador, c, [id], "DG", 1)),
      contar(recordar(E.titular, c, [id], "DGNG", 1)),
      contar(editar(colaborador, c, regla, { versionBase: 1, destino: "DG" })),
    ]);
    // Las tres quedan esperando el candado de la fila (no terminan mientras la descarga siga abierta).
    const limite = Date.now() + 15_000;
    let esperando = 0;
    while (Date.now() < limite) {
      const [f] = await v.b.sql(
        `select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and query ilike '%regla_aprendida%'`,
      );
      esperando = f.n;
      if (esperando >= 3) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(esperando).toBeGreaterThanOrEqual(3);
    expect(terminadas).toBe(0);
    soltar();
    const leidas = await descarga;
    const rs = await escrituras;
    expect(leidas).toEqual([{ regla_id: regla, destino: "DNG", version: 1 }]);
    expect(rs.map((r) => r.status).sort(), rs.map((r) => r.text).join(" | ")).toEqual([200, 409, 409]);
    for (const r of rs.filter((x) => x.status === 409)) expect(r.body).toEqual({ codigo: "regla_cambiada" });
    const filas = await vivas(c);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ id: regla, version: 2 });
  });
});
