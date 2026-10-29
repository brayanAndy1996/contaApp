/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas */
// T6 (008) · `GET /trabajos`: CA-5 (estado, posición, intentos, motivo; alcance de 005), D11 (rutas), D15 (solo
// API) y la parte HTTP de CA-14 (cliente desasignado). PG y Redis reales; los trabajos se siembran con `encolar`
// de `@contapp/queue` (no hay ruta de encolar en 008) y los estados se fijan por SQL.
// Rojo: la ruta `/trabajos` y el módulo `trabajos` del backend aún no existen (T11): hoy responde 404.
//
// Contrato fijado por estas pruebas (T11):
//  - `GET /trabajos` con `@SoloEstudio` y `filtroAlcance` de 005: 200 con `TrabajoVista[]` (forma exacta de
//    `trabajoVistaSchema`: sin tenantId, ruc, parámetros, resultado ni clave de dedupe), del más nuevo al más viejo
//    (`creado_en DESC`), máximo 100. Dueño y Administrador ven todo el estudio; los demás roles, los clientes asignados.
//  - `posicion` = 1 + los `en_cola` del MISMO estudio y la MISMA cola que salen antes (interactivo antes que
//    programado, luego `creado_en`), contando también los de clientes que el usuario no ve; `null` fuera de `en_cola`.
//  - Query `clienteId?` y `estado?`; las claves desconocidas (`tenantId`, `usuarioId`...) se descartan sin efecto.
//    `clienteId` mal formado, inexistente, de otro estudio o no visible: 404 `{codigo:"no_encontrado"}` idéntico
//    (código, cuerpo y cabeceras salvo Date). Un `estado` fuera de los cinco: 400 `{codigo:"solicitud_invalida"}`.
//  - Sin sesión: 401 `sesion_invalida`; `X-Estudio` distinto del de la sesión: 409 `estudio_desfasado`.
//    Todas las respuestas llevan `Cache-Control: no-store`.
//  - Un cliente desasignado deja de verse en la lista y sus trabajos dejan de ser visibles (el despachador los
//    cancela con `acceso_retirado`, CA-14; aquí solo se comprueba que la API no los muestra ni los deja cancelar).
import { randomUUID } from "node:crypto";
import { PRUEBA_ECO, registrarTipo } from "@contapp/queue";
import { trabajoVistaSchema, type TrabajoVista } from "@contapp/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, type Estudio } from "../../../test/soporte-acceso.js";
import {
  abrirBancoTrabajos,
  type BancoTrabajos,
} from "../../../test/soporte-trabajos.js";
import { forma } from "../../../test/soporte.js";

const CLAVES_VISTA = [
  "clienteId",
  "creadoEn",
  "creadoPor",
  "estado",
  "id",
  "iniciadoEn",
  "intentos",
  "motivo",
  "posicion",
  "terminadoEn",
  "tipo",
];

let b: BancoTrabajos;
let E: Estudio;
let ajeno: Estudio;
let admin: Actor;
let contador: Actor;
let asistente: Actor;
let lectura: Actor;
let c: string[]; // clientes de E: c0..c5
let cAjeno: string;
let J: TrabajoVista[]; // j0..j7 de E, en el orden en que se crearon
let jAjeno: TrabajoVista;

const ids = (r: { status: number; body: any }): string[] => {
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.map((x: any) => x.id);
};
const ordenados = (xs: string[]) => [...xs].sort();
const lista = (a: Actor, consulta = "") =>
  b.llamar(a, "GET", `/trabajos${consulta}`);

beforeAll(async () => {
  // Segundo tipo de otra cola: la posición es por cola (el catálogo es el del proceso de la prueba).
  registrarTipo({
    ...PRUEBA_ECO,
    tipo: "prueba.sol",
    cola: "sol",
    canal: "sol",
  });
  b = await abrirBancoTrabajos();
  E = await b.estudio();
  ajeno = await b.estudio();
  c = await b.clientes(E.tenantId, 6);
  [cAjeno] = (await b.clientes(ajeno.tenantId, 1)) as [string];
  admin = await b.miembro(E.tenantId, "admin");
  contador = await b.miembro(E.tenantId, "contador");
  asistente = await b.miembro(E.tenantId, "asistente");
  lectura = await b.miembro(E.tenantId, "lectura");
  await b.asignar(E.tenantId, c[0]!, contador.id, "responsable");
  await b.asignar(E.tenantId, c[1]!, contador.id, "colaborador");
  await b.asignar(E.tenantId, c[1]!, asistente.id, "colaborador");
  await b.asignar(E.tenantId, c[2]!, asistente.id, "colaborador");

  const t = E.tenantId;
  J = [];
  J.push(
    await b.sembrar(t, c[0]!, {
      prioridad: "interactivo",
      creadoPor: contador.id,
    }),
  ); // j0
  J.push(
    await b.sembrar(t, c[1]!, { prioridad: "programado", creadoPor: null }),
  ); // j1
  J.push(
    await b.sembrar(t, c[2]!, {
      prioridad: "interactivo",
      creadoPor: asistente.id,
    }),
  ); // j2
  J.push(
    await b.sembrar(t, c[3]!, { prioridad: "programado", creadoPor: admin.id }),
  ); // j3
  J.push(
    await b.sembrar(t, c[1]!, {
      estado: "ejecutando",
      intentos: 1,
      creadoPor: contador.id,
    }),
  ); // j4
  J.push(
    await b.sembrar(t, c[2]!, {
      estado: "error",
      motivo: "sunat_no_responde",
      intentos: 3,
      creadoPor: asistente.id,
    }),
  ); // j5
  J.push(
    await b.sembrar(t, c[0]!, {
      estado: "completado",
      intentos: 1,
      creadoPor: contador.id,
    }),
  ); // j6
  J.push(
    await b.sembrar(t, c[4]!, {
      estado: "cancelado",
      motivo: "cancelado_usuario",
      prioridad: "programado",
      creadoPor: admin.id,
    }),
  ); // j7
  jAjeno = await b.sembrar(ajeno.tenantId, cAjeno, {
    creadoPor: ajeno.titular.id,
  });
});
afterAll(async () => {
  await b?.cerrar();
});

describe("CA-5 · lo que ve cada rol en GET /trabajos", () => {
  it("el Dueño ve los 8 trabajos de su estudio, del más nuevo al más viejo, y ninguno del otro estudio", async () => {
    const r = await lista(E.titular);
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual([...J].reverse().map((x) => x.id));
    expect(ids(r)).not.toContain(jAjeno.id);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
  });

  it("el Administrador ve lo mismo que el Dueño", async () => {
    expect(ids(await lista(admin))).toEqual([...J].reverse().map((x) => x.id));
  });

  it("el asistente ve solo los trabajos de sus clientes asignados (c1 y c2)", async () => {
    const r = await lista(asistente);
    expect(r.status).toBe(200);
    expect(ordenados(ids(r))).toEqual(
      ordenados([J[1]!.id, J[2]!.id, J[4]!.id, J[5]!.id]),
    );
  });

  it("el contador ve solo los de c0 y c1; lectura sin asignaciones recibe la lista vacía", async () => {
    expect(ordenados(ids(await lista(contador)))).toEqual(
      ordenados([J[0]!.id, J[1]!.id, J[4]!.id, J[6]!.id]),
    );
    const vacia = await lista(lectura);
    expect(vacia.status).toBe(200);
    expect(vacia.body).toEqual([]);
  });

  it("cada elemento tiene exactamente la forma de trabajoVistaSchema (sin tenantId, ruc, parámetros ni resultado)", async () => {
    const r = await lista(E.titular);
    expect(r.body.length).toBe(8);
    for (const x of r.body) {
      expect(Object.keys(x).sort()).toEqual(CLAVES_VISTA);
      expect(trabajoVistaSchema.safeParse(x).success).toBe(true);
    }
  });

  it("muestra estado, posición, intentos, motivo y fechas de cada trabajo", async () => {
    const r = await lista(E.titular);
    const p = new Map<string, any>(r.body.map((x: any) => [x.id, x]));
    expect(p.get(J[0]!.id)).toMatchObject({
      estado: "en_cola",
      posicion: 1,
      intentos: 0,
      motivo: null,
      iniciadoEn: null,
      terminadoEn: null,
    });
    expect(p.get(J[2]!.id)).toMatchObject({ estado: "en_cola", posicion: 2 });
    expect(p.get(J[1]!.id)).toMatchObject({ estado: "en_cola", posicion: 3 });
    expect(p.get(J[3]!.id)).toMatchObject({ estado: "en_cola", posicion: 4 });
    expect(p.get(J[4]!.id)).toMatchObject({
      estado: "ejecutando",
      posicion: null,
      intentos: 1,
      motivo: null,
      terminadoEn: null,
    });
    expect(p.get(J[4]!.id).iniciadoEn).toEqual(expect.any(String));
    expect(p.get(J[5]!.id)).toMatchObject({
      estado: "error",
      posicion: null,
      intentos: 3,
      motivo: "sunat_no_responde",
    });
    expect(p.get(J[5]!.id).terminadoEn).toEqual(expect.any(String));
    expect(p.get(J[6]!.id)).toMatchObject({
      estado: "completado",
      posicion: null,
      motivo: null,
    });
    expect(p.get(J[7]!.id)).toMatchObject({
      estado: "cancelado",
      posicion: null,
      motivo: "cancelado_usuario",
    });
    expect(p.get(J[0]!.id)).toMatchObject({
      tipo: "prueba.eco",
      clienteId: c[0],
      creadoPor: { usuarioId: contador.id },
    });
    expect(p.get(J[1]!.id)!.creadoPor).toBeNull();
  });

  it("la posición cuenta toda la cola del estudio, también lo que el usuario no ve (el asistente ve 2 y 3)", async () => {
    const r = await lista(asistente);
    const p = new Map<string, any>(r.body.map((x: any) => [x.id, x]));
    expect(p.get(J[2]!.id).posicion).toBe(2); // delante: j0, de c0 (no visible para él)
    expect(p.get(J[1]!.id).posicion).toBe(3); // delante: j0 y j2
  });

  it("la posición es por cola: un trabajo de la cola sol empieza en 1", async () => {
    const sol = await b.sembrar(E.tenantId, c[5]!, {
      tipo: "prueba.sol",
      prioridad: "programado",
      creadoPor: null,
    });
    try {
      const r = await lista(E.titular, `?clienteId=${c[5]}`);
      expect(r.status).toBe(200);
      expect(r.body.map((x: any) => [x.id, x.posicion])).toEqual([[sol.id, 1]]);
      // Y no mueve la posición de la cola sire.
      const sire = await lista(E.titular, `?clienteId=${c[0]}&estado=en_cola`);
      expect(sire.body.map((x: any) => x.posicion)).toEqual([1]);
    } finally {
      await b.sql("delete from job_registro where id = $1", [sol.id]);
    }
  });
});

describe("CA-5 · filtros y consulta", () => {
  it("clienteId y estado filtran; juntos se combinan", async () => {
    expect(
      ordenados(ids(await lista(E.titular, `?clienteId=${c[1]}`))),
    ).toEqual(ordenados([J[1]!.id, J[4]!.id]));
    expect(ordenados(ids(await lista(E.titular, "?estado=en_cola")))).toEqual(
      ordenados([J[0]!.id, J[1]!.id, J[2]!.id, J[3]!.id]),
    );
    expect(
      ids(await lista(E.titular, `?clienteId=${c[1]}&estado=ejecutando`)),
    ).toEqual([J[4]!.id]);
    expect(ids(await lista(E.titular, "?estado=cancelado"))).toEqual([
      J[7]!.id,
    ]);
  });

  it("un cliente visible sin trabajos da 200 con lista vacía", async () => {
    const r = await lista(E.titular, `?clienteId=${c[5]}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it("las claves desconocidas se descartan: tenantId, usuarioId o limite no cambian el resultado", async () => {
    const base = ids(await lista(asistente));
    const r = await lista(
      asistente,
      `?tenantId=${ajeno.tenantId}&usuarioId=${E.titular.id}&limite=1&foo=bar`,
    );
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual(base);
  });

  it("clienteId no visible, inexistente, de otro estudio o mal formado da el mismo 404", async () => {
    // Controles: un cliente visible sí responde 200 (si no, el 404 uniforme sería el de una ruta inexistente).
    expect((await lista(asistente, `?clienteId=${c[1]}`)).status).toBe(200);
    expect((await lista(E.titular, `?clienteId=${c[0]}`)).status).toBe(200);
    const casos = [c[0], randomUUID(), cAjeno, "no-es-un-uuid", "0"]; // c0 existe pero el asistente no lo ve
    const formas = [];
    for (const x of casos)
      formas.push(forma(await lista(asistente, `?clienteId=${x}`)));
    for (const f of formas) expect(f).toEqual(formas[0]);
    expect(formas[0]!.status).toBe(404);
    expect(formas[0]!.body).toEqual({ codigo: "no_encontrado" });
    // También para quien tiene alcance global: el de otro estudio es inexistente.
    const g = [
      forma(await lista(E.titular, `?clienteId=${cAjeno}`)),
      forma(await lista(E.titular, `?clienteId=${randomUUID()}`)),
    ];
    expect(g[0]).toEqual(g[1]);
    expect(g[0]!.status).toBe(404);
  });

  it("un estado fuera de los cinco es 400 solicitud_invalida", async () => {
    const r = await lista(E.titular, "?estado=terminado");
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
  });

  it("el estudio sale solo de la sesión: X-Estudio ajeno es 409 y sin sesión es 401", async () => {
    const desfasado = await b.llamar(E.titular, "GET", "/trabajos", undefined, {
      estudio: ajeno.tenantId,
    });
    expect(desfasado.status).toBe(409);
    expect(desfasado.body).toEqual({ codigo: "estudio_desfasado" });
    const sin = await b.h.pedir({ ruta: "/trabajos", estudio: E.tenantId });
    expect(sin.status).toBe(401);
    expect(sin.body).toEqual({ codigo: "sesion_invalida" });
  });

  it("el otro estudio ve solo lo suyo", async () => {
    const r = await lista(ajeno.titular);
    expect(ids(r)).toEqual([jAjeno.id]);
  });
});

describe("CA-5 · máximo 100, del más nuevo al más viejo", () => {
  it("con 105 trabajos devuelve los 100 más nuevos en orden descendente", async () => {
    const E3 = await b.estudio();
    const [cl] = (await b.clientes(E3.tenantId, 1)) as [string];
    const creados: string[] = [];
    for (let i = 0; i < 105; i++) {
      creados.push(
        (
          await b.sembrar(E3.tenantId, cl, {
            prioridad: "programado",
            creadoPor: E3.titular.id,
          })
        ).id,
      );
    }
    const r = await lista(E3.titular);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(100);
    expect(ids(r)).toEqual(creados.slice(5).reverse());
  });
});

describe("CA-14 · cliente desasignado (parte HTTP)", () => {
  it("al desasignar el cliente, el trabajo sale de la lista, no se puede cancelar y sigue en_cola para el despachador", async () => {
    const u = await b.miembro(E.tenantId, "asistente");
    const cl = c[3]!;
    await b.asignar(E.tenantId, cl, u.id, "colaborador");
    const mio = await b.sembrar(E.tenantId, cl, { creadoPor: u.id });
    expect(ids(await lista(u))).toContain(mio.id);

    const del = await b.llamar(
      E.titular,
      "DELETE",
      `/clientes/${cl}/asignaciones/${u.id}`,
    );
    expect(del.status).toBe(204);

    expect(ids(await lista(u))).not.toContain(mio.id);
    const cancelar = await b.llamar(u, "POST", `/trabajos/${mio.id}/cancelar`);
    expect(cancelar.status).toBe(404);
    expect(cancelar.body).toEqual({ codigo: "no_encontrado" });
    expect((await b.fila(mio.id)).estado).toBe("en_cola");
    // Quien tiene alcance global sigue viéndolo.
    expect(ids(await lista(E.titular))).toContain(mio.id);
  });
});
