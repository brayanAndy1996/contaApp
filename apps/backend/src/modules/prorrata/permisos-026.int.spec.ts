/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 026 (T6, rojo): permisos, alcance y planes de la prorrata (D-5, U-11, U-13; CA-8, CA-9).
// Contrato (plan 026 y spec D-5):
//  - Ver (`GET …/prorrata` y `GET …/prorrata/meses/:periodo/historial`): `prorrata.ver`, que tienen los cinco roles; con alcance asignado
//    para Contador, Asistente y Lectura (Dueño y Administrador son globales).
//  - Obtener, guardar o eliminar el manual y guardar la prorrata usada: `prorrata.gestionar` = Dueño, Administrador y Contador (no Asistente ni
//    Lectura) y cliente visible. Quien no lo tiene recibe 403 `permiso_denegado` ANTES de mirar el cliente (como 025) y no se escribe nada.
//  - Cliente de otro estudio, no visible o inexistente: el mismo 404 `no_encontrado`, sin revelar cuál es.
//  - Sin sesión: 401. Todos los planes: ninguna ruta mira `features` (U-13).
//  - `GET /acceso/yo`: `prorrata.gestionar` en Dueño, Administrador y Contador; `prorrata.ver` en los cinco (los conteos totales están en
//    `acceso/permisos.int.spec.ts`).
// Rojo: las rutas aún no existen (T12): responden 404 de ruta inexistente; el permiso nuevo es de T9.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoProrrata,
  M,
  NO_ENCONTRADO,
  PERMISO_DENEGADO,
  rutaEliminar,
  rutaHistorial,
  rutaManual,
  rutaObtener,
  rutaUsada,
  rutaVista,
  type Actor,
  type BancoProrrata,
  type Estudio,
} from "../../../test/soporte-prorrata.js";
import { ROLES, type RolSistema } from "../../../test/soporte-acceso.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let v: BancoProrrata;
let E: Estudio;
const actores = {} as Record<RolSistema, Actor>;
let contadorAjeno: Actor; // contador del estudio sin el cliente asignado

beforeAll(async () => {
  v = await abrirBancoProrrata();
  E = await v.estudio();
  const p = v.b.c.p.b;
  actores.dueno = E.titular;
  for (const rol of ROLES) if (rol !== "dueno") actores[rol] = await p.miembro(E.tenantId, rol);
  contadorAjeno = await p.miembro(E.tenantId, "contador");
});
afterAll(async () => {
  await v?.cerrar();
});

type Cliente = { id: string; ruc: string };
const P = "202601";
const u = (): string => E.titular.id;
/** Cliente con los roles de alcance «asignado» como colaboradores (el Contador, además, responsable). */
const nuevoCliente = (o: Parameters<typeof v.cliente>[1] = {}): Promise<Cliente> =>
  v.cliente(E, { responsable: actores.contador.id, colaboradores: [actores.asistente.id, actores.lectura.id], ...o });

const TODOS: RolSistema[] = [...ROLES];
const GESTORES: RolSistema[] = ["dueno", "admin", "contador"];

interface Caso {
  nombre: string;
  permitidos: RolSistema[];
  /** Deja el cliente en el estado que la ruta necesita (p. ej. un manual que eliminar). */
  preparar?: (c: Cliente) => Promise<void>;
  pedir: (c: Cliente) => { metodo: "GET" | "POST" | "PUT"; ruta: string; cuerpo?: unknown };
}

const CASOS: Caso[] = [
  { nombre: "GET /clientes/:id/prorrata", permitidos: TODOS, pedir: (c) => ({ metodo: "GET", ruta: rutaVista(c.id, M) }) },
  { nombre: "GET /clientes/:id/prorrata/meses/:periodo/historial", permitidos: TODOS, pedir: (c) => ({ metodo: "GET", ruta: rutaHistorial(c.id, P) }) },
  {
    nombre: "POST /clientes/:id/prorrata/declaraciones",
    permitidos: GESTORES,
    pedir: (c) => ({ metodo: "POST", ruta: rutaObtener(c.id), cuerpo: { periodo: M } }),
  },
  {
    nombre: "PUT /clientes/:id/prorrata/meses/:periodo",
    permitidos: GESTORES,
    pedir: (c) => ({
      metodo: "PUT",
      ruta: rutaManual(c.id, P),
      cuerpo: { gravadas: "10.00", exportaciones: "0.00", noGravadas: "5.00", motivo: "Libro físico", version: 0 },
    }),
  },
  {
    nombre: "POST /clientes/:id/prorrata/meses/:periodo/eliminar",
    permitidos: GESTORES,
    preparar: async (c) => {
      await v.sembrarManual(E.tenantId, c.id, { periodo: P, version: 1, autor: u() });
    },
    pedir: (c) => ({ metodo: "POST", ruta: rutaEliminar(c.id, P), cuerpo: { motivo: "Quitar", version: 1 } }),
  },
  {
    nombre: "PUT /clientes/:id/prorrata/usada/:periodo",
    permitidos: GESTORES,
    pedir: (c) => ({ metodo: "PUT", ruta: rutaUsada(c.id, M), cuerpo: { porcentaje: "50.00", version: 0 } }),
  },
];

const clase = (status: number): number | "2xx" => (status >= 200 && status < 300 ? "2xx" : status);

describe("matriz de roles de la prorrata (D-5, U-11, CA-9): 5 roles × 6 rutas", () => {
  it.each(CASOS.map((c) => [c.nombre, c] as const))("%s", async (_n, caso) => {
    const observado: Record<string, number | "2xx"> = {};
    const esperado: Record<string, number | "2xx"> = {};
    for (const rol of ROLES) {
      const c = await nuevoCliente();
      if (caso.preparar) await caso.preparar(c);
      const antes = await v.fotoProrrata(E.tenantId, c.id);
      const p = caso.pedir(c);
      const r = await v.http(actores[rol], p.metodo, p.ruta, p.cuerpo);
      observado[rol] = clase(r.status);
      esperado[rol] = caso.permitidos.includes(rol) ? "2xx" : 403;
      if (!caso.permitidos.includes(rol)) {
        expect(r.body, `${rol}: ${r.text}`).toEqual(PERMISO_DENEGADO);
        expect(await v.fotoProrrata(E.tenantId, c.id), `${rol}: un 403 no escribe`).toEqual(antes);
      }
    }
    expect(observado).toEqual(esperado);
  });
});

describe("`GET /acceso/yo` y `prorrata.gestionar` (U-11)", () => {
  it("Dueño, Administrador y Contador tienen prorrata.gestionar y prorrata.ver; Asistente y Lectura solo prorrata.ver", async () => {
    for (const rol of ROLES) {
      const r = await v.http(actores[rol], "GET", "/acceso/yo");
      expect(r.status, r.text).toBe(200);
      expect(r.body.permisos, rol).toContain("prorrata.ver");
      if (GESTORES.includes(rol)) expect(r.body.permisos, rol).toContain("prorrata.gestionar");
      else expect(r.body.permisos, rol).not.toContain("prorrata.gestionar");
    }
  });
});

describe("alcance: el cliente se ve o no se ve igual que ante un cliente inexistente (D-5, CA-8)", () => {
  const INEXISTENTE = "00000000-0000-4000-8000-000000000000";
  const lecturas = (c: { id: string }) => [
    { metodo: "GET" as const, ruta: rutaVista(c.id, M) },
    { metodo: "GET" as const, ruta: rutaHistorial(c.id, P) },
  ];
  const escrituras = (c: { id: string }) => [
    { metodo: "POST" as const, ruta: rutaObtener(c.id), cuerpo: { periodo: M } },
    { metodo: "PUT" as const, ruta: rutaManual(c.id, P), cuerpo: { gravadas: "1.00", exportaciones: "0.00", noGravadas: "1.00", motivo: "x", version: 0 } },
    { metodo: "POST" as const, ruta: rutaEliminar(c.id, P), cuerpo: { motivo: "x", version: 1 } },
    { metodo: "PUT" as const, ruta: rutaUsada(c.id, M), cuerpo: { porcentaje: "50.00", version: 0 } },
  ];

  it("un Contador sin el cliente asignado: 404 en las seis rutas, idéntico al de un cliente inexistente, y no escribe", async () => {
    const c = await nuevoCliente();
    // Control: la ruta existe y quien tiene el cliente asignado lo lee (si no, el 404 de abajo sería el de «ruta inexistente»).
    const control = await v.http(actores.contador, "GET", rutaVista(c.id, M));
    expect(control.status, control.text).toBe(200);
    const antes = await v.fotoProrrata(E.tenantId, c.id);
    const reales = [...lecturas(c), ...escrituras(c)];
    const inexistentes = [...lecturas({ id: INEXISTENTE }), ...escrituras({ id: INEXISTENTE })];
    for (const [i, p] of reales.entries()) {
      const r = await v.http(contadorAjeno, p.metodo, p.ruta, (p as any).cuerpo);
      expect(r.status, `${p.metodo} ${p.ruta}: ${r.text}`).toBe(404);
      expect(r.body).toEqual(NO_ENCONTRADO);
      const q = inexistentes[i]!;
      const ref = await v.http(contadorAjeno, q.metodo, q.ruta, (q as any).cuerpo);
      expect(r.text).toBe(ref.text);
    }
    expect(await v.fotoProrrata(E.tenantId, c.id)).toEqual(antes);
  });

  it("Asistente y Lectura sin el cliente asignado: lecturas 404 y escrituras 403 (el permiso se mira antes que el cliente)", async () => {
    const c = await v.cliente(E, { responsable: actores.contador.id }); // sin colaboradores
    for (const rol of ["asistente", "lectura"] as const) {
      for (const p of lecturas(c)) {
        const r = await v.http(actores[rol], p.metodo, p.ruta);
        expect(r.status, `${rol} ${p.ruta}: ${r.text}`).toBe(404);
        expect(r.body).toEqual(NO_ENCONTRADO);
      }
      for (const p of escrituras(c)) {
        const r = await v.http(actores[rol], p.metodo, p.ruta, p.cuerpo);
        expect(r.status, `${rol} ${p.metodo} ${p.ruta}: ${r.text}`).toBe(403);
        expect(r.body).toEqual(PERMISO_DENEGADO);
      }
    }
  });

  it("un Contador asignado solo como colaborador (no responsable) lee y escribe", async () => {
    const c = await v.cliente(E, { colaboradores: [actores.contador.id] });
    const lee = await v.http(actores.contador, "GET", rutaVista(c.id, M));
    expect(lee.status, lee.text).toBe(200);
    const escribe = await v.http(actores.contador, "PUT", rutaUsada(c.id, M), { porcentaje: "50.00", version: 0 });
    expect(escribe.status, escribe.text).toBe(200);
  });

  it("el Dueño y el Administrador ven y escriben cualquier cliente del estudio aunque no estén asignados (alcance global)", async () => {
    const c = await v.cliente(E, {});
    for (const rol of ["dueno", "admin"] as const) {
      const lee = await v.http(actores[rol], "GET", rutaVista(c.id, M));
      expect(lee.status, `${rol}: ${lee.text}`).toBe(200);
      const escribe = await v.http(actores[rol], "POST", rutaObtener(c.id), { periodo: M });
      expect(escribe.status, `${rol}: ${escribe.text}`).toBe(202);
    }
  });

  it("un cliente de OTRO estudio: 404 igual que uno inexistente en las seis rutas, sin efectos en ninguno de los dos estudios", async () => {
    const F = await v.estudio();
    const ajeno = await v.cliente(F, {});
    const control = await v.http(E.titular, "GET", rutaVista((await nuevoCliente()).id, M)); // la ruta existe
    expect(control.status, control.text).toBe(200);
    await v.sembrarDeclaraciones(F.tenantId, ajeno.id, [{ periodo: P, numeroOrden: "1" }]);
    const antes = await v.fotoProrrata(F.tenantId, ajeno.id);
    const noExiste = await v.http(E.titular, "GET", rutaVista(INEXISTENTE, M));
    for (const p of [...lecturas(ajeno), ...escrituras(ajeno)]) {
      const r = await v.http(E.titular, p.metodo, p.ruta, (p as any).cuerpo);
      expect(r.status, `${p.metodo} ${p.ruta}: ${r.text}`).toBe(404);
      expect(r.body).toEqual(NO_ENCONTRADO);
    }
    expect((await v.http(E.titular, "GET", rutaVista(ajeno.id, M))).text).toBe(noExiste.text);
    expect(await v.fotoProrrata(F.tenantId, ajeno.id)).toEqual(antes);
    expect(await v.manualesBd(ajeno.id)).toHaveLength(0);
    expect(await v.usadasBd(ajeno.id)).toHaveLength(0);
    expect(await v.trabajosDescarga(E.tenantId, ajeno.id)).toHaveLength(0);
  });

  it("sin sesión: 401 en la lectura", async () => {
    const c = await nuevoCliente();
    expect((await v.http(actores.contador, "GET", rutaVista(c.id, M))).status).toBe(200); // la ruta existe
    const r = await v.sinSesion("GET", rutaVista(c.id, M));
    expect(r.status, r.text).toBe(401);
  });
});

describe("cliente archivado: se lee y no se escribe, con cualquier rol (D-5)", () => {
  it("los gestores reciben 409 cliente_archivado en las cuatro escrituras; todos los roles leen (200)", async () => {
    const c = await nuevoCliente({ archivado: true });
    await v.sembrarManual(E.tenantId, c.id, { periodo: P, version: 1, autor: u() });
    const antes = await v.fotoProrrata(E.tenantId, c.id);
    for (const rol of GESTORES) {
      for (const p of [
        { metodo: "POST" as const, ruta: rutaObtener(c.id), cuerpo: { periodo: M } },
        { metodo: "PUT" as const, ruta: rutaManual(c.id, "202602"), cuerpo: { gravadas: "1.00", exportaciones: "0.00", noGravadas: "1.00", motivo: "x", version: 0 } },
        { metodo: "POST" as const, ruta: rutaEliminar(c.id, P), cuerpo: { motivo: "x", version: 1 } },
        { metodo: "PUT" as const, ruta: rutaUsada(c.id, M), cuerpo: { porcentaje: "50.00", version: 0 } },
      ]) {
        const r = await v.http(actores[rol], p.metodo, p.ruta, p.cuerpo);
        expect(r.status, `${rol} ${p.metodo} ${p.ruta}: ${r.text}`).toBe(409);
        expect(r.body).toEqual({ codigo: "cliente_archivado" });
      }
    }
    expect(await v.fotoProrrata(E.tenantId, c.id)).toEqual(antes);
    for (const rol of ROLES) {
      const r = await v.http(actores[rol], "GET", rutaVista(c.id, M));
      expect(r.status, `${rol}: ${r.text}`).toBe(200);
    }
  });
});

describe("planes (U-13): ninguna ruta de la prorrata mira las características del plan", () => {
  it("un estudio con el plan más pequeño y sin ninguna característica lee, obtiene, guarda el manual y la prorrata usada", async () => {
    const plan = await v.b.c.p.plan({ features: {}, maxRucs: 1 });
    const F = await v.b.c.p.estudio(plan);
    const cont = await v.b.c.p.b.miembro(F.tenantId, "contador");
    const c = await v.cliente(F, { responsable: cont.id });
    const lee = await v.http(cont, "GET", rutaVista(c.id, M));
    expect(lee.status, lee.text).toBe(200);
    const obtiene = await v.http(cont, "POST", rutaObtener(c.id), { periodo: M });
    expect(obtiene.status, obtiene.text).toBe(202);
    const manual = await v.http(cont, "PUT", rutaManual(c.id, P), { gravadas: "1.00", exportaciones: "0.00", noGravadas: "1.00", motivo: "Libro", version: 0 });
    expect(manual.status, manual.text).toBe(200);
    const usada = await v.http(cont, "PUT", rutaUsada(c.id, M), { porcentaje: "50.00", version: 0 });
    expect(usada.status, usada.text).toBe(200);
  });
});
