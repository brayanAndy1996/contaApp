/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// T4 (005) · CA-5 (alcance, HU-08) y CA-6 (cliente desasignado con sesión viva).
// Rojo: `GET /clientes`, `ClienteScopeGuard` y la tabla `asignacion` aún no existen.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirBanco, type Actor, type Banco, type Estudio } from "../../../test/soporte-acceso.js";
import { forma } from "../../../test/soporte.js";

let b: Banco;
let E: Estudio; // 120 clientes
let ajeno: Estudio; // otro estudio con un cliente
let admin: Actor;
let asistente: Actor;
let contador: Actor;
let lectura: Actor;
let clientes: string[];
let propios: string[]; // los 15 del asistente (14 colaboraciones + 1 como responsable)
let clienteAjeno: string;

beforeAll(async () => {
  b = await abrirBanco();
  E = await b.estudio();
  ajeno = await b.estudio();
  [clienteAjeno] = await b.clientes(ajeno.tenantId, 1) as [string];
  clientes = await b.clientes(E.tenantId, 120);
  admin = await b.miembro(E.tenantId, "admin");
  asistente = await b.miembro(E.tenantId, "asistente");
  contador = await b.miembro(E.tenantId, "contador");
  lectura = await b.miembro(E.tenantId, "lectura");
  propios = clientes.slice(10, 24);
  for (const c of propios) await b.asignar(E.tenantId, c, asistente.id, "colaborador");
  await b.asignar(E.tenantId, clientes[0]!, contador.id, "responsable");
  await b.asignar(E.tenantId, clientes[1]!, contador.id, "colaborador");
  await b.asignar(E.tenantId, clientes[1]!, asistente.id, "responsable"); // asistente ve también el 1
  propios = [clientes[1]!, ...propios];
});
afterAll(async () => {
  await b?.cerrar();
});

const ids = (r: { body: any }) => r.body.map((x: any) => x.id);

describe("CA-5 · lo que ve cada rol (HU-08)", () => {
  it("un asistente con 15 de 120 clientes asignados ve exactamente esos, ordenados por razón social", async () => {
    const r = await b.llamar(asistente, "GET", "/clientes");
    expect(r.status).toBe(200);
    expect(ids(r).sort()).toEqual([...propios].sort());
    const nombres = r.body.map((x: any) => x.razonSocial);
    expect(nombres).toEqual([...nombres].sort());
    expect(Object.keys(r.body[0]).sort()).toEqual(["id", "razonSocial", "responsable", "ruc"]);
    expect(r.body.find((x: any) => x.id === clientes[1])!.responsable).toEqual({
      usuarioId: asistente.id,
      nombre: expect.any(String),
    });
  });

  it("Dueño y Administrador ven los 120; contador y lectura solo los suyos (lectura sin asignaciones: lista vacía)", async () => {
    expect(ids(await b.llamar(E.titular, "GET", "/clientes"))).toHaveLength(120);
    expect(ids(await b.llamar(admin, "GET", "/clientes"))).toHaveLength(120);
    expect(ids(await b.llamar(contador, "GET", "/clientes")).sort()).toEqual([clientes[0], clientes[1]].sort());
    const vacia = await b.llamar(lectura, "GET", "/clientes");
    expect(vacia.status).toBe(200);
    expect(vacia.body).toEqual([]);
  });

  it("GET /clientes/:id devuelve el cliente asignado (id, ruc, razonSocial) y 404 si no lo está", async () => {
    const r = await b.llamar(asistente, "GET", `/clientes/${propios[0]}`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["id", "razonSocial", "ruc"]);
    const noAsignado = await b.llamar(asistente, "GET", `/clientes/${clientes[100]}`);
    expect(noAsignado.status).toBe(404);
    expect(noAsignado.body).toEqual({ codigo: "no_encontrado" });
    expect((await b.llamar(E.titular, "GET", `/clientes/${clientes[100]}`)).status).toBe(200);
  });

  it("no asignado, inexistente, de otro estudio y UUID mal formado dan el mismo 404 (código, cuerpo y cabeceras salvo Date)", async () => {
    const casos = [clientes[100], randomUUID(), clienteAjeno, "no-es-un-uuid", "0"];
    const formas = [];
    for (const c of casos) formas.push(forma(await b.llamar(asistente, "GET", `/clientes/${c}`)));
    for (const f of formas) expect(f).toEqual(formas[0]);
    expect(formas[0]!.status).toBe(404);
    expect(formas[0]!.body).toEqual({ codigo: "no_encontrado" });
    // También para quien tiene alcance global: el de otro estudio es inexistente.
    const g = [forma(await b.llamar(E.titular, "GET", `/clientes/${clienteAjeno}`)), forma(await b.llamar(E.titular, "GET", `/clientes/${randomUUID()}`))];
    expect(g[0]).toEqual(g[1]);
    expect(g[0]!.status).toBe(404);
  });

  it("el permiso se exige antes de mirar el cliente: 403 idéntico exista, esté asignado o no", async () => {
    const rutas = [
      `/clientes/${propios[0]}/asignaciones`, // asignado
      `/clientes/${clientes[100]}/asignaciones`, // existe, no asignado
      `/clientes/${randomUUID()}/asignaciones`, // inexistente
      `/clientes/${clienteAjeno}/asignaciones`, // de otro estudio
    ];
    const formas = [];
    for (const ruta of rutas) formas.push(forma(await b.llamar(asistente, "GET", ruta)));
    for (const f of formas) expect(f).toEqual(formas[0]);
    expect(formas[0]!.status).toBe(403);
    expect(formas[0]!.body).toEqual({ codigo: "permiso_denegado" });
    // Con permiso, el cliente ajeno o inexistente sí es 404.
    expect((await b.llamar(E.titular, "GET", `/clientes/${clienteAjeno}/asignaciones`)).status).toBe(404);
    expect((await b.llamar(E.titular, "GET", `/clientes/${randomUUID()}/asignaciones`)).status).toBe(404);
  });

  it("el estudio sale solo de la sesión: X-Estudio, query o cuerpo de otro estudio no amplían el listado (D13)", async () => {
    const r = await b.llamar(asistente, "GET", `/clientes?tenantId=${ajeno.tenantId}&usuarioId=${E.titular.id}`);
    expect(r.status).toBe(200);
    expect(ids(r).sort()).toEqual([...propios].sort());
    const desfasado = await b.llamar(asistente, "GET", "/clientes", undefined, { estudio: ajeno.tenantId });
    expect(desfasado.status).toBe(409);
    expect(desfasado.body).toEqual({ codigo: "estudio_desfasado" });
  });
});

describe("CA-6 · cliente desasignado durante la sesión (D3)", () => {
  it("al quitar la asignación, la siguiente petición ya da 404 y desaparece del listado", async () => {
    const u = await b.miembro(E.tenantId, "asistente");
    const c = clientes[50]!;
    await b.asignar(E.tenantId, c, u.id, "colaborador");
    expect((await b.llamar(u, "GET", `/clientes/${c}`)).status).toBe(200);
    expect(ids(await b.llamar(u, "GET", "/clientes"))).toContain(c);

    const del = await b.llamar(E.titular, "DELETE", `/clientes/${c}/asignaciones/${u.id}`);
    expect(del.status).toBe(204);

    expect((await b.llamar(u, "GET", `/clientes/${c}`)).status).toBe(404);
    expect(ids(await b.llamar(u, "GET", "/clientes"))).not.toContain(c);
  });

  it("al asignar, la siguiente petición ya lo ve", async () => {
    const u = await b.miembro(E.tenantId, "contador");
    const c = clientes[60]!;
    expect((await b.llamar(u, "GET", `/clientes/${c}`)).status).toBe(404);
    expect((await b.llamar(E.titular, "PUT", `/clientes/${c}/asignaciones/${u.id}`, { tipo: "colaborador" })).status).toBe(200);
    expect((await b.llamar(u, "GET", `/clientes/${c}`)).status).toBe(200);
  });
});
