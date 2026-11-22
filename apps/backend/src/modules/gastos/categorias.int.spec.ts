/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 027 (T6, rojo): categorías permitidas por cliente por HTTP (R-13, U-14, D-6; CA-1, CA-5 S3, CA-14).
// Contrato (plan 027, «Contratos: HTTP» y `@contapp/shared`: `categoriasClienteVistaSchema`, `categoriasClienteSchema`):
//  - `GET /clientes/:clienteId/gastos/categorias` (`reglas.ver`, cliente visible) -> 200 `{ciiu, seccion, base, permitidas, quitadas, efectivas,
//    version}`: el CIIU sale de la caché del estudio (el backend nunca consulta), la sección de su división, la base de la matriz del dominio
//    (D-6: C y G sin categorías) y `efectivas = (base ∪ permitidas) − quitadas`. Sin CIIU en la caché: `ciiu` y `seccion` null y base vacía.
//    Sin ajuste guardado: permitidas y quitadas vacías y versión 0.
//  - `PUT …/gastos/categorias {permitidas, quitadas, version}` (`reglas.gestionar`, cliente visible; Contador asignado incluido) -> 200 `{version}`;
//    listas no disjuntas o fuera de las 6 categorías 400; versión que no es la vigente 409 `version_cambiada`; cliente archivado 409
//    `cliente_archivado`; cliente de otro estudio, no visible o inexistente 404 `no_encontrado`, el mismo.
//  - Auditoría (017): `gnd.categorias_cliente` con el usuario, el cliente y `{clienteId, antes: {permitidas, quitadas}, despues: {…}}`.
// Rojo: las rutas aún no existen (T12): responden 404 de ruta inexistente.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoGastos,
  CATEGORIAS,
  cumple,
  inexistente,
  NO_ENCONTRADO,
  rutaCategorias,
  SOLICITUD_INVALIDA,
  type Actor,
  type BancoGastos,
  type Estudio,
} from "../../../test/soporte-gastos.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let v: BancoGastos;
let E: Estudio;
let F: Estudio;
let admin: Actor;
let contador: Actor;
let contadorAjeno: Actor; // contador del estudio sin el cliente asignado
let asistente: Actor;
let lectura: Actor;

beforeAll(async () => {
  v = await abrirBancoGastos();
  E = await v.estudio();
  F = await v.estudio();
  const p = v.b.c.p.b;
  admin = await p.miembro(E.tenantId, "admin");
  contador = await p.miembro(E.tenantId, "contador");
  contadorAjeno = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
  lectura = await p.miembro(E.tenantId, "lectura");
});
afterAll(async () => {
  await v?.cerrar();
});

type Cliente = { id: string; ruc: string };
const nuevoCliente = (o: Parameters<typeof v.cliente>[1] = {}): Promise<Cliente> =>
  v.cliente(E, { responsable: contador.id, colaboradores: [asistente.id, lectura.id], ...o });
const leer = (a: Actor, c: { id: string }) => v.http(a, "GET", rutaCategorias(c.id));
const fijar = (a: Actor, c: { id: string }, cuerpo: unknown) => v.http(a, "PUT", rutaCategorias(c.id), cuerpo);
const ordenadas = (l: string[]) => [...l].sort();

describe("GET …/gastos/categorias (R-13, D-6, CA-5)", () => {
  it("200 con la forma de categoriasClienteVistaSchema; sin CIIU en la caché: ciiu y sección null, base y ajuste vacíos, versión 0", async () => {
    const c = await nuevoCliente();
    const r = await leer(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(cumple("categoriasClienteVistaSchema", r.body), r.text).toBe(true);
    expect(r.body).toEqual({ ciiu: null, seccion: null, base: [], permitidas: [], quitadas: [], efectivas: [], version: 0 });
    expect(r.headers["cache-control"]).toMatch(/no-store/);
  });

  it.each([
    ["5610", "I", ["alimentos-personales"]],
    ["4752", "G", []],
    ["1071", "C", []],
    ["6201", "J", []],
    ["8510", "P", ["juguetes", "utiles-escolares"]],
    ["8620", "Q", ["cuidado-personal"]],
    ["9200", "R", ["alimentos-personales", "entretenimiento", "juguetes"]],
    ["9602", "S", ["cuidado-personal"]],
  ])("el CIIU %s es de la sección %s: base %j de la matriz y efectivas = base sin ajuste (D-6: C y G sin categorías)", async (ciiu, seccion, base) => {
    const c = await nuevoCliente();
    await v.sembrarCiiu(E.tenantId, c.ruc, ciiu);
    const r = await leer(lectura, c);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ ciiu, seccion, permitidas: [], quitadas: [], version: 0 });
    expect(ordenadas(r.body.base)).toEqual(ordenadas(base));
    expect(ordenadas(r.body.efectivas)).toEqual(ordenadas(base));
  });

  it("el ajuste prevalece sobre la base: efectivas = (base ∪ permitidas) − quitadas, con la versión guardada", async () => {
    const c = await nuevoCliente();
    await v.sembrarCiiu(E.tenantId, c.ruc, "5610");
    await v.sembrarCategorias(E.tenantId, c.id, ["calzado-ropa", "juguetes"], ["alimentos-personales"], 4);
    const r = await leer(asistente, c);
    expect(r.status, r.text).toBe(200);
    expect(cumple("categoriasClienteVistaSchema", r.body), r.text).toBe(true);
    expect(r.body).toMatchObject({ ciiu: "5610", seccion: "I", version: 4 });
    expect(ordenadas(r.body.base)).toEqual(["alimentos-personales"]);
    expect(ordenadas(r.body.permitidas)).toEqual(["calzado-ropa", "juguetes"]);
    expect(r.body.quitadas).toEqual(["alimentos-personales"]);
    expect(ordenadas(r.body.efectivas)).toEqual(["calzado-ropa", "juguetes"]);
  });

  it("sin CIIU del cliente solo cuenta el ajuste: lo permitido por el estudio es efectivo y lo quitado no resta nada de una base vacía", async () => {
    const c = await nuevoCliente();
    await v.sembrarCategorias(E.tenantId, c.id, ["calzado-ropa"], ["juguetes"], 1);
    const r = await leer(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ ciiu: null, seccion: null, base: [], permitidas: ["calzado-ropa"], quitadas: ["juguetes"], efectivas: ["calzado-ropa"], version: 1 });
  });

  it("un CIIU sin dato («sin dato» en la caché) se ve como sin CIIU", async () => {
    const c = await nuevoCliente();
    await v.sembrarCiiu(E.tenantId, c.ruc, null);
    const r = await leer(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ ciiu: null, seccion: null, base: [], efectivas: [] });
  });

  it("solo ve el CIIU de su cliente: el de otro cliente (o de otro estudio) con otro RUC no aparece", async () => {
    const c = await nuevoCliente();
    const otro = await nuevoCliente();
    await v.sembrarCiiu(E.tenantId, otro.ruc, "9602");
    const ajeno = await v.cliente(F, { responsable: F.titular.id });
    await v.sembrarCiiu(F.tenantId, ajeno.ruc, "8510");
    const r = await leer(contador, c);
    expect(r.body).toMatchObject({ ciiu: null, seccion: null });
    expect(r.text).not.toContain("9602");
    expect(r.text).not.toContain("8510");
  });

  it("el ajuste es del cliente: otro cliente del estudio no lo hereda", async () => {
    const c = await nuevoCliente();
    const otro = await nuevoCliente();
    await v.sembrarCategorias(E.tenantId, c.id, ["juguetes"], [], 2);
    expect((await leer(contador, otro)).body).toMatchObject({ permitidas: [], version: 0 });
  });

  it("un cliente archivado se lee (solo la escritura se rechaza)", async () => {
    const c = await nuevoCliente();
    await v.archivar(c.id);
    const r = await leer(contador, c);
    expect(r.status, r.text).toBe(200);
  });

  it("cliente de otro estudio, no visible para el usuario o inexistente: el mismo 404 no_encontrado, sin revelar cuál es", async () => {
    const mio = await nuevoCliente();
    const deF = await v.cliente(F, { responsable: F.titular.id });
    expect((await leer(contador, mio)).status, "control: el cliente propio y visible sí se lee").toBe(200);
    const referencia = await leer(contador, { id: inexistente() });
    expect(referencia.status, referencia.text).toBe(404);
    expect(referencia.body).toEqual(NO_ENCONTRADO);
    for (const [quien, c] of [
      [contador, deF],
      [admin, deF],
      [contadorAjeno, mio],
      [lectura, deF],
    ] as const) {
      const r = await leer(quien, c);
      expect(r.status, r.text).toBe(404);
      expect(r.text).toBe(referencia.text);
    }
  });

  it("sin sesión: 401", async () => {
    const c = await nuevoCliente();
    const r = await v.sinSesion("GET", rutaCategorias(c.id));
    expect(r.status, r.text).toBe(401);
  });
});

describe("PUT …/gastos/categorias (R-13, CA-14)", () => {
  it("200 {version: 1} sin ajuste previo (versión 0); la BD guarda las listas; la vista las muestra; otro cliente y otro estudio no cambian", async () => {
    const c = await nuevoCliente();
    const otro = await nuevoCliente();
    const r = await fijar(admin, c, { permitidas: ["juguetes", "utiles-escolares"], quitadas: ["calzado-ropa"], version: 0 });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ version: 1 });
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(await v.categoriasBd(E.tenantId, c.id)).toEqual([{ cliente_id: c.id, permitidas: ["juguetes", "utiles-escolares"], quitadas: ["calzado-ropa"], version: 1 }]);
    expect(await v.categoriasBd(E.tenantId, otro.id)).toEqual([]);
    expect(await v.categoriasBd(F.tenantId)).toEqual([]);
    const vista = await leer(lectura, c);
    expect(vista.body).toMatchObject({ permitidas: ["juguetes", "utiles-escolares"], quitadas: ["calzado-ropa"], version: 1 });
    expect(cumple("categoriasClienteVistaSchema", vista.body), vista.text).toBe(true);
  });

  it("el Contador asignado ajusta las categorías de su cliente (reglas.gestionar sobre el cliente, D-3)", async () => {
    const c = await nuevoCliente();
    const r = await fijar(contador, c, { permitidas: ["calzado-ropa"], quitadas: [], version: 0 });
    expect(r.status, r.text).toBe(200);
    expect(await v.categoriasBd(E.tenantId, c.id)).toMatchObject([{ permitidas: ["calzado-ropa"], quitadas: [], version: 1 }]);
  });

  it("la versión sube de a una y las listas se reemplazan enteras; las dos vacías quitan todo el ajuste (sigue la base)", async () => {
    const c = await nuevoCliente();
    await v.sembrarCiiu(E.tenantId, c.ruc, "5610");
    expect((await fijar(admin, c, { permitidas: ["juguetes"], quitadas: ["alimentos-personales"], version: 0 })).body).toEqual({ version: 1 });
    expect((await fijar(admin, c, { permitidas: ["calzado-ropa"], quitadas: [], version: 1 })).body).toEqual({ version: 2 });
    expect(await v.categoriasBd(E.tenantId, c.id)).toMatchObject([{ permitidas: ["calzado-ropa"], quitadas: [], version: 2 }]);
    expect((await fijar(admin, c, { permitidas: [], quitadas: [], version: 2 })).body).toEqual({ version: 3 });
    const vista = await leer(admin, c);
    expect(vista.body).toMatchObject({ permitidas: [], quitadas: [], version: 3 });
    expect(ordenadas(vista.body.efectivas)).toEqual(["alimentos-personales"]);
  });

  it("CA-14 · audita gnd.categorias_cliente con el usuario, el cliente y {clienteId, antes, despues}", async () => {
    const c = await nuevoCliente();
    const antes = (await v.auditoria027(E.tenantId)).filter((a) => a.accion === "gnd.categorias_cliente" && a.cliente_id === c.id).length;
    expect((await fijar(admin, c, { permitidas: ["juguetes", "utiles-escolares"], quitadas: ["calzado-ropa"], version: 0 })).status).toBe(200);
    expect((await fijar(contador, c, { permitidas: ["calzado-ropa"], quitadas: [], version: 1 })).status).toBe(200);
    const filas = (await v.auditoria027(E.tenantId)).filter((a) => a.accion === "gnd.categorias_cliente" && a.cliente_id === c.id);
    expect(filas).toHaveLength(antes + 2);
    expect(filas[0]).toMatchObject({ actor_tipo: "usuario", usuario_id: admin.id, cliente_id: c.id, entidad: "gnd_cliente_categorias" });
    expect(filas[0].datos).toEqual({
      clienteId: c.id,
      antes: { permitidas: [], quitadas: [] },
      despues: { permitidas: ["juguetes", "utiles-escolares"], quitadas: ["calzado-ropa"] },
    });
    expect(filas[1]).toMatchObject({ usuario_id: contador.id });
    expect(filas[1].datos).toEqual({
      clienteId: c.id,
      antes: { permitidas: ["juguetes", "utiles-escolares"], quitadas: ["calzado-ropa"] },
      despues: { permitidas: ["calzado-ropa"], quitadas: [] },
    });
  });

  it("una versión que no es la vigente (vieja, futura o ≥ 1 sin fila): 409 version_cambiada y no cambia nada", async () => {
    const c = await nuevoCliente();
    const sinFila = await fijar(admin, c, { permitidas: [], quitadas: ["juguetes"], version: 1 });
    expect(sinFila.status, sinFila.text).toBe(409);
    expect(sinFila.body).toEqual({ codigo: "version_cambiada" });
    await v.sembrarCategorias(E.tenantId, c.id, ["juguetes"], [], 3);
    const antes = await v.fotoGastos(E.tenantId);
    for (const version of [0, 1, 2, 4, 9]) {
      const r = await fijar(admin, c, { permitidas: [], quitadas: ["juguetes"], version });
      expect(r.status, `versión ${version}: ${r.text}`).toBe(409);
      expect(r.body).toEqual({ codigo: "version_cambiada" });
    }
    expect(await v.fotoGastos(E.tenantId)).toEqual(antes);
  });

  it("dos ajustes con la misma versión a la vez: uno gana (200) y el otro recibe 409 version_cambiada", async () => {
    const c = await nuevoCliente();
    await v.sembrarCategorias(E.tenantId, c.id, [], [], 1);
    const [a, b] = await Promise.all([
      fijar(admin, c, { permitidas: ["juguetes"], quitadas: [], version: 1 }),
      fijar(contador, c, { permitidas: ["calzado-ropa"], quitadas: [], version: 1 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a, b].find((r) => r.status === 409)!.body).toEqual({ codigo: "version_cambiada" });
    expect((await v.categoriasBd(E.tenantId, c.id))[0].version).toBe(2);
  });

  it("un cliente archivado: 409 cliente_archivado y no se escribe nada", async () => {
    const c = await nuevoCliente();
    await v.archivar(c.id);
    const antes = await v.fotoGastos(E.tenantId);
    const r = await fijar(admin, c, { permitidas: ["juguetes"], quitadas: [], version: 0 });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
    expect(await v.fotoGastos(E.tenantId)).toEqual(antes);
  });

  it("cliente de otro estudio, no visible para el contador o inexistente: el mismo 404 no_encontrado y nada se escribe", async () => {
    const mio = await nuevoCliente();
    const deF = await v.cliente(F, { responsable: F.titular.id });
    const antesF = await v.fotoGastos(F.tenantId);
    const cuerpo = { permitidas: ["juguetes"], quitadas: [], version: 0 };
    expect((await fijar(contador, mio, cuerpo)).status, "control: el cliente propio y visible sí se escribe").toBe(200);
    const antesE = await v.fotoGastos(E.tenantId);
    const referencia = await fijar(contador, { id: inexistente() }, cuerpo);
    expect(referencia.status, referencia.text).toBe(404);
    expect(referencia.body).toEqual(NO_ENCONTRADO);
    for (const [quien, c] of [
      [contador, deF],
      [admin, deF],
      [contadorAjeno, mio],
    ] as const) {
      const r = await fijar(quien, c, cuerpo);
      expect(r.status, r.text).toBe(404);
      expect(r.text).toBe(referencia.text);
    }
    expect(await v.fotoGastos(E.tenantId)).toEqual(antesE);
    expect(await v.fotoGastos(F.tenantId)).toEqual(antesF);
  });

  it.each([
    ["listas no disjuntas", { permitidas: ["juguetes"], quitadas: ["juguetes"], version: 0 }],
    ["una categoría fuera de las 6 en permitidas", { permitidas: ["personal"], quitadas: [], version: 0 }],
    ["una categoría fuera de las 6 en quitadas", { permitidas: [], quitadas: ["Juguetes"], version: 0 }],
    ["permitidas que no es lista", { permitidas: "juguetes", quitadas: [], version: 0 }],
    ["quitadas nula", { permitidas: [], quitadas: null, version: 0 }],
    ["sin quitadas", { permitidas: [], version: 0 }],
    ["sin permitidas", { quitadas: [], version: 0 }],
    ["sin versión", { permitidas: [], quitadas: [] }],
    ["versión negativa", { permitidas: [], quitadas: [], version: -1 }],
    ["versión decimal", { permitidas: [], quitadas: [], version: 0.5 }],
    ["efectivas (calculadas, no se envían)", { permitidas: [], quitadas: [], version: 0, efectivas: [] }],
    ["clienteId en el cuerpo (sale de la ruta)", { permitidas: [], quitadas: [], version: 0, clienteId: "x" }],
    ["tenantId en el cuerpo", { permitidas: [], quitadas: [], version: 0, tenantId: "x" }],
    ["cuerpo vacío", {}],
  ])("400 solicitud_invalida y no se escribe nada: %s", async (_n, cuerpo) => {
    const c = await nuevoCliente();
    const antes = await v.fotoGastos(E.tenantId);
    const r = await fijar(admin, c, cuerpo);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual(SOLICITUD_INVALIDA);
    expect(await v.fotoGastos(E.tenantId)).toEqual(antes);
  });

  it("acepta las seis categorías en una lista y la otra vacía", async () => {
    const c = await nuevoCliente();
    const r = await fijar(admin, c, { permitidas: [...CATEGORIAS], quitadas: [], version: 0 });
    expect(r.status, r.text).toBe(200);
    const q = await fijar(admin, c, { permitidas: [], quitadas: [...CATEGORIAS], version: 1 });
    expect(q.status, q.text).toBe(200);
    expect((await leer(admin, c)).body.efectivas).toEqual([]);
  });

  it("no toca el diccionario, el umbral ni la caché de CIIU del estudio", async () => {
    const c = await nuevoCliente();
    await v.sembrarCiiu(E.tenantId, c.ruc, "5610");
    const antes = (await v.fotoGastos(E.tenantId)) as any;
    expect((await fijar(admin, c, { permitidas: ["juguetes"], quitadas: [], version: 0 })).status).toBe(200);
    const despues = (await v.fotoGastos(E.tenantId)) as any;
    expect({ ...despues, categorias: [], auditoria: 0 }).toEqual({ ...antes, categorias: [], auditoria: 0 });
  });
});
