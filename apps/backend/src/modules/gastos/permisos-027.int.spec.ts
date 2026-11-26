// Spec 027 (T6, rojo): permisos y alcance de los gastos no deducibles (D-3, U-11; CA-7, CA-8, CA-14).
// Contrato (spec 027 D-3 y plan «Contratos: HTTP»; sin permisos nuevos: `reglas.ver`, `reglas.gestionar` y `sire.clasificar` ya existen):
//  - Ver el diccionario, el umbral y las categorías del cliente: `reglas.ver` (los cinco roles; con cliente visible para las categorías).
//  - Diccionario y umbral del estudio (agregar, activar o desactivar propias y globales, umbral): `reglas.gestionar` Y alcance global = Dueño y
//    Administrador; el Contador (que tiene `reglas.gestionar` con alcance asignado), el Asistente y Lectura reciben 403 `permiso_denegado`.
//  - Categorías del cliente y «Aprender estas palabras»: `reglas.gestionar` y cliente visible = Dueño, Administrador y Contador asignado; Asistente y
//    Lectura reciben 403.
//  - «Volver a evaluar»: `sire.clasificar` y cliente visible = Dueño, Administrador, Contador y Asistente (asignado); Lectura 403.
//  - Diccionario global: solo super-admin (`plataforma.int.spec.ts`).
//  - Quien no tiene el permiso recibe 403 `permiso_denegado` ANTES de mirar el cliente o el recurso (como 025 y 026) y no se escribe nada.
//  - Cliente de otro estudio, no visible para el usuario o inexistente: el mismo 404 `no_encontrado`, sin revelar cuál es. Sin sesión: 401.
//  - Las 14 rutas declaran el permiso del plan (`@Permiso`); las de plataforma, `@SoloPlataforma` (sin permiso de estudio).
// Rojo: las rutas aún no existen (T12): responden 404 de ruta inexistente.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoGastos,
  inexistente,
  NO_ENCONTRADO,
  PERIODO,
  PERMISO_DENEGADO,
  RUTA_GASTOS,
  rutaAprender,
  rutaCategorias,
  rutaGlobal,
  rutaPalabra,
  rutaPalabras,
  rutaReevaluar,
  rutasDeGastos,
  RUTAS_027,
  rutaUmbral,
  type Actor,
  type BancoGastos,
  type Estudio,
} from "../../../test/soporte-gastos.js";
import { ROLES, type RolSistema } from "../../../test/soporte-acceso.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let v: BancoGastos;
let E: Estudio;
let F: Estudio;
const actores = {} as Record<RolSistema, Actor>;
let contadorAjeno: Actor; // contador del estudio sin el cliente asignado

beforeAll(async () => {
  v = await abrirBancoGastos();
  E = await v.estudio();
  F = await v.estudio();
  const p = v.b.c.p.b;
  actores.dueno = E.titular;
  for (const rol of ROLES) if (rol !== "dueno") actores[rol] = await p.miembro(E.tenantId, rol);
  contadorAjeno = await p.miembro(E.tenantId, "contador");
});
afterAll(async () => {
  await v?.cerrar();
});

type Cliente = { id: string; ruc: string };
/** Cliente con los roles de alcance «asignado» como colaboradores (el Contador, además, responsable). */
const nuevoCliente = (): Promise<Cliente> => v.cliente(E, { responsable: actores.contador.id, colaboradores: [actores.asistente.id, actores.lectura.id] });

const TODOS: RolSistema[] = [...ROLES];
const GLOBALES: RolSistema[] = ["dueno", "admin"];
const GESTORES: RolSistema[] = ["dueno", "admin", "contador"];
const CLASIFICAN: RolSistema[] = ["dueno", "admin", "contador", "asistente"];

interface Contexto {
  cliente: Cliente;
  compraId: string;
  propiaId: string;
  rol: RolSistema;
}
interface Caso {
  nombre: string;
  permitidos: RolSistema[];
  /** Estado que devuelve quien sí tiene permiso (la prueba no necesita la ruta feliz completa: cada archivo la prueba). */
  exito: number;
  /** Cuerpo de error esperado de quien tiene permiso (si el éxito no es 2xx). */
  errorExito?: unknown;
  /** Si la ruta es de un cliente (para las pruebas de 404). */
  deCliente: boolean;
  pedir: (c: Contexto) => Promise<{ metodo: "GET" | "POST" | "PUT"; ruta: string; cuerpo?: unknown }>;
}

const unica = (p: string): string => `${p}${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36)}`;
const versionUmbral = async (): Promise<number> => (await v.configBd(E.tenantId))[0]?.version ?? 0;

const CASOS: Caso[] = [
  { nombre: "GET /estudio/reglas-motor/gastos", permitidos: TODOS, exito: 200, deCliente: false, pedir: async () => ({ metodo: "GET", ruta: RUTA_GASTOS }) },
  {
    nombre: "PUT /estudio/reglas-motor/gastos/umbral",
    permitidos: GLOBALES,
    exito: 200,
    deCliente: false,
    pedir: async () => ({ metodo: "PUT", ruta: rutaUmbral(), cuerpo: { umbral: 4, version: await versionUmbral() } }),
  },
  {
    nombre: "POST /estudio/reglas-motor/gastos/palabras",
    permitidos: GLOBALES,
    exito: 201,
    deCliente: false,
    pedir: async () => ({ metodo: "POST", ruta: rutaPalabras(), cuerpo: { palabra: unica("pm"), categoria: "juguetes" } }),
  },
  {
    nombre: "PUT /estudio/reglas-motor/gastos/palabras/:id",
    permitidos: GLOBALES,
    exito: 200,
    deCliente: false,
    pedir: async (c) => ({ metodo: "PUT", ruta: rutaPalabra(c.propiaId), cuerpo: { activa: false, version: 1 } }),
  },
  {
    nombre: "PUT /estudio/reglas-motor/gastos/globales/:id",
    permitidos: GLOBALES,
    exito: 200,
    deCliente: false,
    pedir: async () => ({ metodo: "PUT", ruta: rutaGlobal(await v.idGlobal("zapato")), cuerpo: { activa: true } }),
  },
  { nombre: "GET /clientes/:id/gastos/categorias", permitidos: TODOS, exito: 200, deCliente: true, pedir: async (c) => ({ metodo: "GET", ruta: rutaCategorias(c.cliente.id) }) },
  {
    nombre: "PUT /clientes/:id/gastos/categorias",
    permitidos: GESTORES,
    exito: 200,
    deCliente: true,
    pedir: async (c) => ({ metodo: "PUT", ruta: rutaCategorias(c.cliente.id), cuerpo: { permitidas: ["juguetes"], quitadas: [], version: 0 } }),
  },
  {
    nombre: "GET /clientes/:id/periodos/:periodo/gastos/aprender/:compraId",
    permitidos: GESTORES,
    exito: 409,
    errorExito: { codigo: "compra_no_excluida" },
    deCliente: true,
    pedir: async (c) => ({ metodo: "GET", ruta: rutaAprender(c.cliente.id, PERIODO, c.compraId) }),
  },
  {
    nombre: "POST /clientes/:id/periodos/:periodo/gastos/aprender/:compraId",
    permitidos: GESTORES,
    exito: 409,
    errorExito: { codigo: "compra_no_excluida" },
    deCliente: true,
    pedir: async (c) => ({ metodo: "POST", ruta: rutaAprender(c.cliente.id, PERIODO, c.compraId), cuerpo: { terminos: [{ termino: "valido", categoria: "juguetes" }] } }),
  },
  {
    nombre: "POST /clientes/:id/periodos/:periodo/gastos/reevaluar",
    permitidos: CLASIFICAN,
    exito: 202,
    deCliente: true,
    pedir: async (c) => ({ metodo: "POST", ruta: rutaReevaluar(c.cliente.id, PERIODO), cuerpo: {} }),
  },
];

/** Cliente (con el fixture de compras) y una palabra propia nuevos para cada rol: la ruta feliz de cada uno parte del mismo estado. */
async function preparar(rol: RolSistema): Promise<Contexto> {
  const cliente = await nuevoCliente();
  const ids = await v.sembrarFixture(E.tenantId, cliente.id, { usuarioId: E.titular.id });
  const propiaId = await v.sembrarPropia(E.tenantId, { palabra: unica("pp"), creadoPor: E.titular.id });
  return { cliente, compraId: ids["F001-5070"]!, propiaId, rol };
}

describe("matriz de roles de 027 (D-3, U-11, CA-8): 5 roles × 10 rutas de estudio y cliente", () => {
  it.each(CASOS.map((c) => [c.nombre, c] as const))("%s", async (_n, caso) => {
    const observado: Record<string, number | "403"> = {};
    const esperado: Record<string, number | "403"> = {};
    for (const rol of ROLES) {
      const ctx = await preparar(rol);
      const antes = await v.fotoGastos(E.tenantId);
      const trabajosAntes = (await v.trabajosReevaluar(E.tenantId, ctx.cliente.id)).length;
      const p = await caso.pedir(ctx);
      const r = await v.http(actores[rol], p.metodo, p.ruta, p.cuerpo);
      const permitido = caso.permitidos.includes(rol);
      observado[rol] = r.status === 403 ? "403" : r.status;
      esperado[rol] = permitido ? caso.exito : "403";
      if (!permitido) {
        expect(r.body, `${rol}: ${r.text}`).toEqual(PERMISO_DENEGADO);
        expect(await v.fotoGastos(E.tenantId), `${rol}: un 403 no escribe`).toEqual(antes);
        expect((await v.trabajosReevaluar(E.tenantId, ctx.cliente.id)).length, `${rol}: un 403 no encola`).toBe(trabajosAntes);
      } else if (caso.errorExito) {
        expect(r.body, `${rol}: ${r.text}`).toEqual(caso.errorExito);
      }
    }
    expect(observado).toEqual(esperado);
  });
});

describe("CA-8 · quien no tiene el permiso recibe 403 antes de mirar el cliente o el recurso", () => {
  const SIN_PERMISO = CASOS.filter((c) => c.deCliente && c.permitidos.length < 5).flatMap((c) =>
    ROLES.filter((rol) => !c.permitidos.includes(rol)).map((rol) => [c.nombre, rol, c] as const),
  );
  it.each(SIN_PERMISO)("%s · %s con un cliente inexistente: 403 permiso_denegado, no 404", async (_n, rol, caso) => {
    const ctx: Contexto = { cliente: { id: inexistente(), ruc: "00000000000" }, compraId: inexistente(), propiaId: inexistente(), rol };
    const p = await caso.pedir(ctx);
    const r = await v.http(actores[rol], p.metodo, p.ruta, p.cuerpo);
    expect(r.status, r.text).toBe(403);
    expect(r.body).toEqual(PERMISO_DENEGADO);
  });

  it("el Contador (reglas.gestionar sin alcance global) no toca el diccionario ni el umbral, pero sí aprende y ajusta categorías de su cliente", async () => {
    const ctx = await preparar("contador");
    for (const caso of CASOS.filter((c) => c.permitidos === GLOBALES)) {
      const p = await caso.pedir(ctx);
      const r = await v.http(actores.contador, p.metodo, p.ruta, p.cuerpo);
      expect(r.status, `${caso.nombre}: ${r.text}`).toBe(403);
    }
    const cat = await v.http(actores.contador, "PUT", rutaCategorias(ctx.cliente.id), { permitidas: ["juguetes"], quitadas: [], version: 0 });
    expect(cat.status, cat.text).toBe(200);
    const apr = await v.http(actores.contador, "GET", rutaAprender(ctx.cliente.id, PERIODO, ctx.compraId));
    expect(apr.status, apr.text).toBe(409); // pasó el permiso; la compra no está excluida
  });

  it("el Asistente solo vuelve a evaluar: 202 en su cliente asignado y 403 en categorías, aprender y diccionario", async () => {
    const ctx = await preparar("asistente");
    expect((await v.http(actores.asistente, "POST", rutaReevaluar(ctx.cliente.id, PERIODO), {})).status).toBe(202);
    for (const caso of CASOS.filter((c) => !c.permitidos.includes("asistente"))) {
      const p = await caso.pedir(ctx);
      const r = await v.http(actores.asistente, p.metodo, p.ruta, p.cuerpo);
      expect(r.status, caso.nombre).toBe(403);
    }
  });

  it("Lectura solo ve: 200 en las dos lecturas y 403 en toda escritura de 027", async () => {
    const ctx = await preparar("lectura");
    expect((await v.http(actores.lectura, "GET", RUTA_GASTOS)).status).toBe(200);
    expect((await v.http(actores.lectura, "GET", rutaCategorias(ctx.cliente.id))).status).toBe(200);
    for (const caso of CASOS.filter((c) => !c.permitidos.includes("lectura"))) {
      const p = await caso.pedir(ctx);
      const r = await v.http(actores.lectura, p.metodo, p.ruta, p.cuerpo);
      expect(r.status, caso.nombre).toBe(403);
    }
  });
});

describe("cliente de otro estudio, no visible o inexistente: el mismo 404 no_encontrado (D-3, CA-7)", () => {
  const DE_CLIENTE = CASOS.filter((c) => c.deCliente && c.permitidos.includes("contador"));

  it.each(DE_CLIENTE.map((c) => [c.nombre, c] as const))("%s", async (_n, caso) => {
    const mio = await preparar("contador");
    const deF = await v.cliente(F, { responsable: F.titular.id });
    const ctxDeF: Contexto = { cliente: deF, compraId: inexistente(), propiaId: inexistente(), rol: "dueno" };
    const pedir = async (quien: Actor, ctx: Contexto) => {
      const p = await caso.pedir(ctx);
      return v.http(quien, p.metodo, p.ruta, p.cuerpo);
    };
    expect((await pedir(actores.contador, mio)).status, "control: el cliente propio y visible de la ruta no es 404").not.toBe(404);
    const antesE = await v.fotoGastos(E.tenantId);
    const antesF = await v.fotoGastos(F.tenantId);
    const referencia = await pedir(actores.contador, { ...mio, cliente: { id: inexistente(), ruc: mio.cliente.ruc } });
    expect(referencia.status, referencia.text).toBe(404);
    expect(referencia.body).toEqual(NO_ENCONTRADO);
    for (const [quien, ctx] of [
      [actores.contador, ctxDeF], // cliente de otro estudio
      [actores.admin, ctxDeF], // global, pero de otro estudio
      [actores.dueno, ctxDeF],
      [contadorAjeno, mio], // del estudio, pero no asignado al contador
    ] as const) {
      const r = await pedir(quien, ctx);
      expect(r.status, `${quien.rol}: ${r.text}`).toBe(404);
      expect(r.text).toBe(referencia.text);
    }
    expect(await v.fotoGastos(E.tenantId)).toEqual(antesE);
    expect(await v.fotoGastos(F.tenantId)).toEqual(antesF);
    expect(await v.trabajosReevaluar(F.tenantId, deF.id)).toEqual([]);
  });

  it("el Asistente y Lectura no ven un cliente que no tienen asignado: 404 en categorías (leer) y en volver a evaluar (asistente)", async () => {
    const sinAsignar = await v.cliente(E, { responsable: actores.contador.id });
    const asignado = await nuevoCliente();
    for (const quien of [actores.asistente, actores.lectura]) {
      expect((await v.http(quien, "GET", rutaCategorias(asignado.id))).status, `control: ${quien.rol} lee el cliente que sí tiene asignado`).toBe(200);
      const r = await v.http(quien, "GET", rutaCategorias(sinAsignar.id));
      expect(r.status, `${quien.rol}: ${r.text}`).toBe(404);
      expect(r.body).toEqual(NO_ENCONTRADO);
    }
    const e = await v.http(actores.asistente, "POST", rutaReevaluar(sinAsignar.id, PERIODO), {});
    expect(e.status, e.text).toBe(404);
    expect(e.body).toEqual(NO_ENCONTRADO);
    expect(await v.trabajosReevaluar(E.tenantId, sinAsignar.id)).toEqual([]);
  });
});

describe("sin sesión: 401 en las 10 rutas de estudio y cliente", () => {
  it.each(CASOS.map((c) => [c.nombre, c] as const))("%s", async (_n, caso) => {
    const ctx = await preparar("dueno");
    const p = await caso.pedir(ctx);
    const r = await v.b.c.p.b.h.pedir({ metodo: p.metodo, ruta: p.ruta, cuerpo: p.cuerpo });
    expect(r.status, r.text).toBe(401);
  });
});

describe("las rutas declaran el permiso del plan (D-3)", () => {
  it("son exactamente las 14 rutas de 027, cada una con su permiso (las de plataforma sin permiso de estudio)", () => {
    const rutas = rutasDeGastos(v.b.c.p.b.h.app).map((r) => `${r.metodo} ${r.ruta} ${r.permiso ?? "-"}`);
    expect(rutas.sort()).toEqual(RUTAS_027);
  });

  it("GET /acceso/yo no cambia: reglas.ver en los cinco roles, reglas.gestionar en Dueño, Administrador y Contador, sire.clasificar salvo Lectura", async () => {
    for (const rol of ROLES) {
      const r = await v.http(actores[rol], "GET", "/acceso/yo");
      expect(r.status, r.text).toBe(200);
      const permisos: string[] = r.body.permisos;
      expect(permisos.includes("reglas.ver"), `${rol} reglas.ver`).toBe(true);
      expect(permisos.includes("reglas.gestionar"), `${rol} reglas.gestionar`).toBe(GESTORES.includes(rol));
      expect(permisos.includes("sire.clasificar"), `${rol} sire.clasificar`).toBe(CLASIFICAN.includes(rol));
      expect(r.body.alcance).toBe(GLOBALES.includes(rol) ? "global" : "asignado");
    }
  });
});
