// 007b T18a (D-1) · `GET /trabajos/resumen`: conteo por tipo y estado de TODOS los trabajos visibles (el listado
// `GET /trabajos` se limita a 100 y el panel perdía el total con más de 100). PG y Redis reales. Mismo alcance que el
// listado (filtroAlcance de 005); forma `resumenTrabajosSchema`; sin sesión 401.
import { PRUEBA_ECO, registrarTipo } from "@contapp/queue";
import { resumenTrabajosSchema } from "@contapp/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, type Estudio } from "../../../test/soporte-acceso.js";
import {
  abrirBancoTrabajos,
  type BancoTrabajos,
} from "../../../test/soporte-trabajos.js";

let b: BancoTrabajos;
let E: Estudio;
let ajeno: Estudio;
let asistente: Actor;
let c: string[];

const TIPO = PRUEBA_ECO.tipo;

beforeAll(async () => {
  registrarTipo({ ...PRUEBA_ECO, tipo: "prueba.sol", cola: "sol", canal: "sol" });
  b = await abrirBancoTrabajos();
  E = await b.estudio();
  ajeno = await b.estudio();
  c = await b.clientes(E.tenantId, 2);
  asistente = await b.miembro(E.tenantId, "asistente");
  await b.asignar(E.tenantId, c[0]!, asistente.id, "colaborador");
  const [cAjeno] = (await b.clientes(ajeno.tenantId, 1)) as [string];
  // 105 completados + 3 en cola del cliente asignado; 2 en cola del cliente NO asignado; 1 de otro estudio.
  for (let i = 0; i < 105; i++) {
    await b.sembrar(E.tenantId, c[0]!, {
      estado: "completado",
      intentos: 1,
      creadoPor: E.titular.id,
    });
  }
  for (let i = 0; i < 3; i++) {
    await b.sembrar(E.tenantId, c[0]!, { creadoPor: E.titular.id });
  }
  for (let i = 0; i < 2; i++) {
    await b.sembrar(E.tenantId, c[1]!, { creadoPor: E.titular.id });
  }
  await b.sembrar(ajeno.tenantId, cAjeno, { creadoPor: ajeno.titular.id });
});
afterAll(async () => {
  await b?.cerrar();
});

const total = (
  filas: { tipo: string; estado: string; total: number }[],
  estado: string,
) => filas.find((f) => f.tipo === TIPO && f.estado === estado)?.total ?? 0;

describe("GET /trabajos/resumen", () => {
  it("cuenta los 105 completados aunque el listado solo traiga 100", async () => {
    const lista = await b.llamar(E.titular, "GET", "/trabajos");
    expect(lista.body).toHaveLength(100);
    const r = await b.llamar(E.titular, "GET", "/trabajos/resumen");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const filas = resumenTrabajosSchema.parse(r.body);
    expect(total(filas, "completado")).toBe(105);
    expect(total(filas, "en_cola")).toBe(5);
    expect(filas.reduce((n, f) => n + f.total, 0)).toBe(110);
  });

  it("el asistente cuenta solo los de su cliente asignado (sin los 2 ajenos al alcance)", async () => {
    const r = await b.llamar(asistente, "GET", "/trabajos/resumen");
    expect(r.status).toBe(200);
    const filas = resumenTrabajosSchema.parse(r.body);
    expect(total(filas, "completado")).toBe(105);
    expect(total(filas, "en_cola")).toBe(3);
  });

  it("el otro estudio cuenta solo lo suyo", async () => {
    const r = await b.llamar(ajeno.titular, "GET", "/trabajos/resumen");
    const filas = resumenTrabajosSchema.parse(r.body);
    expect(filas.reduce((n, f) => n + f.total, 0)).toBe(1);
  });

  it("la respuesta no lleva cache ni claves extra, y sin sesión es 401", async () => {
    const r = await b.llamar(E.titular, "GET", "/trabajos/resumen");
    for (const f of r.body as Record<string, unknown>[]) {
      expect(Object.keys(f).sort()).toEqual(["estado", "tipo", "total"]);
    }
    const sin = await b.h.pedir({ ruta: "/trabajos/resumen", estudio: E.tenantId });
    expect(sin.status).toBe(401);
  });
});
