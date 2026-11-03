/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas adversariales */
// Spec 008, T13a (adversario, ronda 1a, caja negra): IDOR de `jobId`/`clienteId` en lista y cancelar por vías
// alternativas, SSE ante cambios de sesión/estudio y carrera en el cupo de 3 streams. Solo HTTP, `crearApp` (vía el
// soporte de test/) y Redis real con prefijo propio del banco. Cada prueba deja BD y Redis como estaban (`cerrar`).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Estudio } from "../../../test/soporte-acceso.js";
import {
  abrirBancoTrabajos,
  abrirSse,
  cerrarSseAbiertos,
  emitir,
  esEventoId,
  esperarSuscripcion,
  vistaCon,
  type BancoTrabajos,
  type ClienteSse,
} from "../../../test/soporte-trabajos.js";

let b: BancoTrabajos;
let A: Estudio;
let B: Estudio;
let cA: string[];
let cB: string[];

beforeAll(async () => {
  b = await abrirBancoTrabajos();
  A = await b.estudio();
  B = await b.estudio();
  cA = await b.clientes(A.tenantId, 2);
  cB = await b.clientes(B.tenantId, 2);
}, 60_000);

afterAll(async () => {
  cerrarSseAbiertos();
  await b?.cerrar();
}, 60_000);

const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cuerpo = (r: { status: number; body: any }) => ({
  status: r.status,
  body: r.body,
});

describe("CA-5 / CA-7 · IDOR con formas alternativas del UUID", () => {
  it("cancelar un trabajo de otro estudio con el id en mayúsculas, entre llaves, sin guiones o con espacios da el mismo 404 que uno inexistente", async () => {
    const ajeno = await b.sembrar(B.tenantId, cB[0]!, {
      creadoPor: B.titular.id,
    });
    const base = cuerpo(
      await b.llamar(A.titular, "POST", `/trabajos/${randomUUID()}/cancelar`),
    );
    const formas = [
      ajeno.id.toUpperCase(),
      `{${ajeno.id}}`,
      ajeno.id.replace(/-/g, ""),
      encodeURIComponent(` ${ajeno.id}`),
      encodeURIComponent(`${ajeno.id} `),
    ];
    const respuestas = [];
    for (const f of formas)
      respuestas.push(
        cuerpo(await b.llamar(A.titular, "POST", `/trabajos/${f}/cancelar`)),
      );
    const fila = await b.fila(ajeno.id);
    expect({ respuestas, estado: fila.estado }).toEqual({
      respuestas: formas.map(() => base),
      estado: "en_cola",
    });
  });

  it("GET /trabajos?clienteId con el cliente de otro estudio en formas alternativas da el mismo 404 y nunca sus trabajos", async () => {
    await b.sembrar(B.tenantId, cB[1]!, { creadoPor: B.titular.id });
    const base = cuerpo(
      await b.llamar(A.titular, "GET", `/trabajos?clienteId=${randomUUID()}`),
    );
    const formas = [
      cB[1]!.toUpperCase(),
      `{${cB[1]}}`,
      cB[1]!.replace(/-/g, ""),
    ];
    const respuestas = [];
    for (const f of formas)
      respuestas.push(
        cuerpo(
          await b.llamar(
            A.titular,
            "GET",
            `/trabajos?clienteId=${encodeURIComponent(f)}`,
          ),
        ),
      );
    expect(respuestas).toEqual(formas.map(() => base));
  });
});

describe("CA-5 · contaminación de parámetros en GET /trabajos", () => {
  it("clienteId repetido (propio + ajeno), en arreglo u objeto y estado repetido: nunca 5xx ni trabajos del otro estudio", async () => {
    await b.sembrar(A.tenantId, cA[0]!, { creadoPor: A.titular.id });
    const ajeno = await b.sembrar(B.tenantId, cB[0]!, {
      creadoPor: B.titular.id,
    });
    const rutas = [
      `/trabajos?clienteId=${cA[0]}&clienteId=${cB[0]}`,
      `/trabajos?clienteId=${cB[0]}&clienteId=${cA[0]}`,
      `/trabajos?clienteId[]=${cB[0]}`,
      `/trabajos?clienteId[$ne]=${cA[0]}`,
      `/trabajos?estado=en_cola&estado=error`,
      `/trabajos?estado[]=en_cola`,
    ];
    const res: Array<{ ruta: string; status: number; ajenoVisible: boolean }> =
      [];
    for (const r of rutas) {
      const x = await b.llamar(A.titular, "GET", r);
      const texto = JSON.stringify(x.body ?? null);
      res.push({
        ruta: r,
        status: x.status,
        ajenoVisible: texto.includes(ajeno.id) || texto.includes(cB[0]!),
      });
    }
    const malos = res.filter((x) => x.status >= 500 || x.ajenoVisible);
    expect(malos).toEqual([]);
  });

  it("clienteId en forma de arreglo u objeto (valor mal formado de una clave conocida) da el 404 de un clienteId mal formado, no la lista sin filtrar", async () => {
    await b.sembrar(A.tenantId, cA[0]!, { creadoPor: A.titular.id });
    await b.sembrar(A.tenantId, cA[1]!, { creadoPor: A.titular.id });
    const malFormado = cuerpo(
      await b.llamar(A.titular, "GET", `/trabajos?clienteId=no-es-uuid`),
    );
    const formas = [
      `clienteId[]=${cB[0]}`,
      `clienteId[]=${randomUUID()}`,
      `clienteId[]=${cA[0]}`,
      `clienteId[x]=${cA[0]}`,
    ];
    const respuestas = [];
    for (const f of formas) {
      const r = await b.llamar(A.titular, "GET", `/trabajos?${f}`);
      respuestas.push({
        status: r.status,
        body:
          r.status === 200 ? `lista de ${(r.body as any[]).length}` : r.body,
      });
    }
    expect(respuestas).toEqual(formas.map(() => malFormado));
  });
});

describe("CA-6 · cupo de 3 streams por sesión en carrera", () => {
  it("6 aperturas simultáneas con la misma sesión: como mucho 3 son 200 y las demás 429; cerradas, se vuelven a abrir 3", async () => {
    const u = await b.miembro(A.tenantId, "admin");
    const abiertas = await Promise.all(
      Array.from({ length: 6 }, () =>
        abrirSse(b.h, { cookie: u.cookie, estudio: A.tenantId }),
      ),
    );
    const estados = abiertas.map((s) => s.status).sort();
    for (const s of abiertas) s.cerrar();
    await pausa(1000);
    const otra = await Promise.all(
      Array.from({ length: 3 }, () =>
        abrirSse(b.h, { cookie: u.cookie, estudio: A.tenantId }),
      ),
    );
    const reabiertas = otra.map((s) => s.status);
    for (const s of otra) s.cerrar();
    expect({
      ok: estados.filter((s) => s === 200).length,
      resto: estados.filter((s) => s !== 200),
      reabiertas,
    }).toEqual({
      ok: 3,
      resto: [429, 429, 429],
      reabiertas: [200, 200, 200],
    });
  });
});

describe("CA-6 · cierre de sesión con el stream abierto", () => {
  it("tras POST /auth/logout el stream se cierra en ≤ 10,5 s y no recibe eventos posteriores", async () => {
    const u = await b.miembro(A.tenantId, "admin");
    const s: ClienteSse = await abrirSse(b.h, {
      cookie: u.cookie,
      estudio: A.tenantId,
    });
    expect(s.status).toBe(200);
    await esperarSuscripcion(b.redis, b.prefijo, A.tenantId);
    const v = await b.sembrar(A.tenantId, cA[1]!, { creadoPor: u.id });
    await emitir(
      b.redis,
      b.prefijo,
      A.tenantId,
      vistaCon(v, { estado: "ejecutando" }),
    );
    const antes = await s.esperar(esEventoId(v.id), 2500);
    const salir = await b.llamar(u, "POST", "/auth/logout");
    expect([200, 204]).toContain(salir.status);
    const cerrado = await s.esperarCierre(10_500);
    await emitir(
      b.redis,
      b.prefijo,
      A.tenantId,
      vistaCon(v, { estado: "completado" }),
    );
    await pausa(800);
    const despues = s.eventos.filter(
      (e) => e.json?.id === v.id && e.json?.estado === "completado",
    ).length;
    s.cerrar();
    expect({ antes: antes !== null, cerrado, despues }).toEqual({
      antes: true,
      cerrado: true,
      despues: 0,
    });
  }, 30_000);
});

describe("CA-5 / CA-6 · miembro de dos estudios: el stream es solo del estudio de la sesión", () => {
  it("un Administrador de A y de B con sesión en A no recibe por su stream eventos de B (aunque el canal de B esté suscrito)", async () => {
    const u = await b.miembro(A.tenantId, "admin");
    await b.sql(
      "insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'admin')",
      [B.tenantId, u.id],
    );
    const sA = await abrirSse(b.h, { cookie: u.cookie, estudio: A.tenantId });
    const sB = await abrirSse(b.h, {
      cookie: B.titular.cookie,
      estudio: B.tenantId,
    }); // suscribe el canal de B en la app
    expect([sA.status, sB.status]).toEqual([200, 200]);
    await esperarSuscripcion(b.redis, b.prefijo, A.tenantId);
    await esperarSuscripcion(b.redis, b.prefijo, B.tenantId);
    const vB = await b.sembrar(B.tenantId, cB[1]!, { creadoPor: B.titular.id });
    await emitir(
      b.redis,
      b.prefijo,
      B.tenantId,
      vistaCon(vB, { estado: "ejecutando" }),
    );
    const enB = await sB.esperar(esEventoId(vB.id), 2500);
    await pausa(500);
    const enA = sA.eventos.filter(
      (e) => e.json?.id === vB.id || e.datos.includes(vB.id),
    ).length;
    sA.cerrar();
    sB.cerrar();
    expect({ llegaAlDeB: enB !== null, llegaAlDeA: enA }).toEqual({
      llegaAlDeB: true,
      llegaAlDeA: 0,
    });
  });

  it("al cambiar la sesión al estudio B, el stream abierto en A no empieza a recibir eventos de B", async () => {
    const u = await b.miembro(A.tenantId, "admin");
    await b.sql(
      "insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'admin')",
      [B.tenantId, u.id],
    );
    const sA = await abrirSse(b.h, { cookie: u.cookie, estudio: A.tenantId });
    const sB = await abrirSse(b.h, {
      cookie: B.titular.cookie,
      estudio: B.tenantId,
    });
    expect([sA.status, sB.status]).toEqual([200, 200]);
    const cambio = await b.h.pedir({
      ruta: "/auth/estudio",
      cuerpo: { tenantId: B.tenantId },
      cookie: u.cookie,
      csrf: u.csrf,
    });
    expect(cambio.status).toBe(200);
    await pausa(10_500);
    await esperarSuscripcion(b.redis, b.prefijo, B.tenantId);
    const vB = await b.sembrar(B.tenantId, cB[0]!, { creadoPor: B.titular.id });
    await emitir(
      b.redis,
      b.prefijo,
      B.tenantId,
      vistaCon(vB, { estado: "ejecutando" }),
    );
    await sB.esperar(esEventoId(vB.id), 2500);
    await pausa(500);
    const enA = sA.eventos.filter((e) => e.datos.includes(vB.id)).length;
    sA.cerrar();
    sB.cerrar();
    expect(enA).toBe(0);
  }, 30_000);
});
