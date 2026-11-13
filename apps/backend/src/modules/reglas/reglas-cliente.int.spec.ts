/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 021 (T5, rojo): reglas aprendidas del cliente por HTTP (D-2, D-5, D-9, P-2, P-7, P-9, P-10; CA-1, CA-5, CA-6, CA-7, CA-9, CA-13).
// Contrato (plan 021, «Contratos: HTTP»; formas de `reglaVistaSchema`, `recordarReglaSchema`, `editarReglaSchema` y
// `eliminarReglaSchema` de `@contapp/shared`):
//  - `GET /clientes/:clienteId/reglas` (`reglas.ver`) -> 200 `ReglaVista[]` `{id, proveedor: {tipo, numero, razonSocial}, destino, activa,
//    version, periodoAprendido, aplicada, aceptada, creadaPor, creadaEn, actualizadaEn}`, sin eliminadas; la razón social es la de la
//    compra más reciente del proveedor en el cliente.
//  - `POST …/reglas/recordar {compraIds, destino, versionBase}` (`reglas.gestionar`) -> 200 `ReglaVista` · 404 si alguna compra no es del
//    cliente o no está viva · 422 `proveedores_distintos` · 409 `regla_cambiada`. `versionBase = null` crea (409 si ya hay una viva); con
//    número actualiza el destino (y reactiva una inactiva) si la versión coincide. `periodoAprendido` = periodo de esas compras (P-5).
//    No crea versiones de compras (D-5). Registra la confirmación si el RUC empieza en 20 y el aporte está encendido (P-1, P-10).
//  - `PATCH …/reglas/:reglaId {versionBase, destino?, activa?}` y `DELETE …/reglas/:reglaId?versionBase=n` (`reglas.gestionar`):
//    200 `ReglaVista` y 204; 404 y 409 `regla_cambiada`. DELETE es baja lógica (P-9).
//  - Todas: `Cache-Control: no-store`; cliente de otro estudio, no visible o inexistente, y regla de otro cliente o estudio: el mismo 404
//    `{codigo:"no_encontrado"}`; escrituras con cliente archivado: 409 `cliente_archivado`; cuerpo inválido: 400 `solicitud_invalida`.
//  - Auditoría (017): `regla.creada`, `regla.editada` (`datos.destino = {anterior, nuevo}`), `regla.activada`, `regla.desactivada`,
//    `regla.eliminada`, con el usuario, el cliente y la regla; los `datos` nunca llevan RUC ni razón social (D-10).
// Rojo: las rutas aún no existen (T11): responden 404 de ruta inexistente.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoReglas,
  APRENDIDO,
  cumple,
  inexistente,
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
let contador: Actor; // responsable del cliente: reglas.gestionar, alcance asignado
let asistente: Actor; // colaborador: solo reglas.ver
let lectura: Actor; // colaborador: solo reglas.ver
let contadorAjeno: Actor; // contador del estudio sin el cliente asignado: no lo ve
let admin: Actor; // alcance global

// Datos con forma de canario: no pueden aparecer en ningún error ni en la auditoría (D-10, CA-13).
const PROV = "20700000011";
const RAZON = "CANARIO RAZON SOCIAL SAC";

beforeAll(async () => {
  v = await abrirBancoReglas();
  E = await v.estudio();
  F = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
  lectura = await p.miembro(E.tenantId, "lectura");
  contadorAjeno = await p.miembro(E.tenantId, "contador");
  admin = await p.miembro(E.tenantId, "admin");
});
afterAll(async () => {
  await v?.cerrar();
});

type Cliente = { id: string; ruc: string };
const nuevoCliente = (o: Parameters<BancoReglas["cliente"]>[1] = {}): Promise<Cliente> =>
  v.cliente(E, { responsable: contador.id, colaboradores: [asistente.id, lectura.id], ...o });
const u = (): string => E.titular.id;

/** Una compra del SIRE del proveedor, en el periodo dado. */
const compra = (c: Cliente, numero: string, o: { periodo?: string; doc?: string; docTipo?: string; razonSocial?: string | null; estudio?: Estudio } = {}) =>
  v.sembrarCompra((o.estudio ?? E).tenantId, c.id, {
    serie: "F001",
    numero,
    doc: o.doc ?? PROV,
    ...(o.docTipo === undefined ? {} : { docTipo: o.docTipo }),
    razonSocial: o.razonSocial === undefined ? RAZON : o.razonSocial,
    ...(o.periodo === undefined ? {} : { periodo: o.periodo }),
    usuarioId: (o.estudio ?? E).titular.id,
  });

const listar = (a: Actor, c: { id: string }) => v.http(a, "GET", rutaReglas(c.id));
const recordar = (a: Actor, c: { id: string }, compraIds: string[], destino: string, versionBase: number | null) =>
  v.http(a, "POST", `${rutaReglas(c.id)}/recordar`, { compraIds, destino, versionBase });
const editar = (a: Actor, c: { id: string }, reglaId: string, cuerpo: unknown) => v.http(a, "PATCH", `${rutaReglas(c.id)}/${reglaId}`, cuerpo);
const eliminar = (a: Actor, c: { id: string }, reglaId: string, versionBase: number | string) =>
  v.http(a, "DELETE", `${rutaReglas(c.id)}/${reglaId}?versionBase=${versionBase}`);
const regla = (c: Cliente, o: Partial<Parameters<BancoReglas["sembrarRegla"]>[2]> = {}) =>
  v.sembrarRegla(E.tenantId, c.id, { usuarioId: u(), ...o });
const NO_ENCONTRADO = { codigo: "no_encontrado" };
const CLAVES_REGLA = [
  "aceptada",
  "actualizadaEn",
  "aplicada",
  "activa",
  "creadaEn",
  "creadaPor",
  "destino",
  "id",
  "periodoAprendido",
  "proveedor",
  "version",
].sort();

/** Una respuesta de error no lleva datos del cliente (D-10): ni RUC ni razón social ni montos. */
function sinCanarios(r: { text: string }): void {
  expect(r.text).not.toContain(PROV);
  expect(r.text).not.toContain(RAZON);
  expect(r.text).not.toMatch(/\d+\.\d{2}/);
}

// --- GET -------------------------------------------------------------------------------------------------------------

describe("GET /clientes/:clienteId/reglas (HU-31, RF-114, CA-7)", () => {
  it("un cliente sin reglas: 200 con la lista vacía y Cache-Control: no-store", async () => {
    const c = await nuevoCliente();
    const r = await listar(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual([]);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
  });

  it("devuelve la regla con la forma de reglaVistaSchema: proveedor, destino, estado, versión, periodo, contadores y autor", async () => {
    const c = await nuevoCliente();
    await compra(c, "1", { periodo: "202609", razonSocial: "RAZON VIEJA SAC" });
    await compra(c, "2", { periodo: "202610", razonSocial: "RAZON NUEVA SAC" });
    const id = await regla(c, { destino: "DNG", usuarioId: contador.id });
    const r = await listar(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(cumple("reglaVistaSchema", r.body[0]), r.text).toBe(true);
    expect(Object.keys(r.body[0]).sort()).toEqual(CLAVES_REGLA);
    expect(r.body[0]).toMatchObject({
      id,
      proveedor: { tipo: "6", numero: PROV, razonSocial: "RAZON NUEVA SAC" },
      destino: "DNG",
      activa: true,
      version: 1,
      periodoAprendido: APRENDIDO,
      aplicada: 0,
      aceptada: 0,
    });
    expect(r.body[0].creadaPor).toMatchObject({ id: contador.id });
  });

  it("lista las inactivas y no lista las eliminadas (P-9)", async () => {
    const c = await nuevoCliente();
    const activa = await regla(c, { docNumero: "20700000011" });
    const inactiva = await regla(c, { docNumero: "20700000045", activa: false });
    await regla(c, { docNumero: "20700000053", eliminada: true });
    const r = await listar(contador, c);
    expect(r.status, r.text).toBe(200);
    expect((r.body as any[]).map((x) => x.id).sort()).toEqual([activa, inactiva].sort());
    expect((r.body as any[]).find((x) => x.id === inactiva).activa).toBe(false);
  });

  it("aplicada = filas con versión historial y aceptada = las que seguían en el destino al revisar el periodo (P-4)", async () => {
    const c = await nuevoCliente();
    const id = await regla(c, { destino: "DNG" });
    const propuestaId = await v.sembrarPropuesta(E.tenantId, c.id, { libro: "compras", nuevas: 3, usuarioId: u() });
    const filas: string[] = [];
    for (const n of ["1", "2", "3"])
      filas.push(await v.sembrarSegunHistorial(E.tenantId, c.id, id, { serie: "F001", numero: n, propuestaId, usuarioId: u() }));
    await v.aceptarAplicacion(E.tenantId, id, filas[0]!);
    await v.aceptarAplicacion(E.tenantId, id, filas[1]!);
    const r = await listar(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(r.body[0]).toMatchObject({ id, aplicada: 3, aceptada: 2 });
  });

  it.each([
    ["contador", () => contador],
    ["asistente", () => asistente],
    ["lectura", () => lectura],
    ["dueño", () => E.titular],
    ["admin (cliente sin asignar)", () => admin],
  ])("%s con reglas.ver las lee (200)", async (_n, quien) => {
    const c = await nuevoCliente();
    await regla(c);
    const r = await listar(quien(), c);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toHaveLength(1);
  });

  it("CA-5 · la regla del cliente A no aparece en el cliente B del mismo estudio, aunque el proveedor sea el mismo", async () => {
    const a = await nuevoCliente();
    const b = await nuevoCliente();
    await regla(a, { docNumero: PROV });
    const rb = await listar(contador, b);
    expect(rb.status, rb.text).toBe(200);
    expect(rb.body).toEqual([]);
    expect(rb.text).not.toContain(PROV);
  });

  it("CA-5 · cliente de otro estudio, no visible o inexistente: el mismo 404 sin revelar cuál es", async () => {
    const ajeno = await v.cliente(F, {});
    const propio = await nuevoCliente();
    await regla(propio);
    const noVisible = await listar(contadorAjeno, propio);
    const deOtroEstudio = await listar(contador, ajeno);
    const noExiste = await listar(contador, { id: inexistente() });
    expect(noExiste.status, noExiste.text).toBe(404);
    expect(noExiste.body).toEqual(NO_ENCONTRADO);
    for (const r of [noVisible, deOtroEstudio]) {
      expect(r.status, r.text).toBe(404);
      expect(r.body).toEqual(noExiste.body);
      expect(r.text).toBe(noExiste.text);
    }
  });

  it("sin sesión: 401", async () => {
    const c = await nuevoCliente();
    const r = await v.sinSesion("GET", rutaReglas(c.id));
    expect(r.status, r.text).toBe(401);
  });
});

// --- POST recordar ---------------------------------------------------------------------------------------------------

describe("POST …/reglas/recordar (RF-110, HU-28, D-5, P-7; CA-1)", () => {
  it.each([
    ["asistente", () => asistente],
    ["lectura", () => lectura],
  ])("CA-1 · %s no tiene reglas.gestionar: 403 permiso_denegado y no se crea ninguna regla", async (_n, quien) => {
    const c = await nuevoCliente();
    const id = await compra(c, "1");
    const antes = await v.foto(c.id);
    const r = await recordar(quien(), c, [id], "DNG", null);
    expect(r.status, r.text).toBe(403);
    expect(r.body).toEqual({ codigo: "permiso_denegado" });
    expect(await v.reglasBd(c.id)).toEqual([]);
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("crea la regla con ese destino: 200 con la forma de reglaVistaSchema, versión 1 y el periodo de las compras (P-5)", async () => {
    const c = await nuevoCliente();
    const id = await compra(c, "1", { periodo: "202610" });
    const r = await recordar(contador, c, [id], "DNG", null);
    expect(r.status, r.text).toBe(200);
    expect(cumple("reglaVistaSchema", r.body), r.text).toBe(true);
    expect(Object.keys(r.body).sort()).toEqual(CLAVES_REGLA);
    expect(r.body).toMatchObject({
      proveedor: { tipo: "6", numero: PROV, razonSocial: RAZON },
      destino: "DNG",
      activa: true,
      version: 1,
      periodoAprendido: "202610",
      aplicada: 0,
      aceptada: 0,
    });
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    const bd = await v.reglasBd(c.id);
    expect(bd).toHaveLength(1);
    expect(bd[0]).toMatchObject({ id: r.body.id, doc_tipo: "6", doc_numero: PROV, destino: "DNG", activa: true, version: 1, periodo_aprendido: "202610", eliminada: false });
    expect(bd[0].creada_por).toBe(contador.id);
    const lista = await listar(contador, c);
    expect((lista.body as any[]).map((x) => x.id)).toEqual([r.body.id]);
  });

  it("varias compras del mismo proveedor y periodo dejan una sola regla", async () => {
    const c = await nuevoCliente();
    const ids = [await compra(c, "1"), await compra(c, "2"), await compra(c, "3")];
    const r = await recordar(contador, c, ids, "DGNG", null);
    expect(r.status, r.text).toBe(200);
    expect(await v.reglasBd(c.id)).toHaveLength(1);
  });

  it("D-5 · no crea versiones de ninguna compra (ni de las que se clasificaron ni de las demás)", async () => {
    const c = await nuevoCliente();
    const ids = [await compra(c, "1"), await compra(c, "2")];
    await compra(c, "3", { periodo: "202611" }); // del mismo proveedor, de otro periodo: tampoco cambia
    const antes = await v.foto(c.id);
    const r = await recordar(contador, c, ids, "DNG", null);
    expect(r.status, r.text).toBe(200);
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("el dueño (alcance global, cliente sin asignar) también puede recordar", async () => {
    const c = await nuevoCliente();
    const r = await recordar(E.titular, c, [await compra(c, "1")], "DG", null);
    expect(r.status, r.text).toBe(200);
  });

  it("con una regla viva y versionBase = su versión actualiza el destino (el último gana) y sube la versión", async () => {
    const c = await nuevoCliente();
    await regla(c, { destino: "DNG", version: 1 });
    const r = await recordar(contador, c, [await compra(c, "1")], "DG", 1);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ destino: "DG", activa: true, version: 2 });
    const bd = await v.reglasBd(c.id);
    expect(bd).toHaveLength(1);
    expect(bd[0]).toMatchObject({ destino: "DG", version: 2, eliminada: false });
    const aud = await v.auditoriaDe(E.tenantId, "regla.editada");
    expect(aud.at(-1)).toMatchObject({ usuario_id: contador.id, cliente_id: c.id, entidad_id: r.body.id });
    expect(aud.at(-1).datos.destino).toEqual({ anterior: "DNG", nuevo: "DG" });
  });

  it("«Recordar» sobre una regla desactivada la reactiva con el destino nuevo (auditado como regla.editada y regla.activada)", async () => {
    const c = await nuevoCliente();
    const id = await regla(c, { destino: "DNG", activa: false, version: 3 });
    const r = await recordar(contador, c, [await compra(c, "1")], "DGNG", 3);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ id, destino: "DGNG", activa: true });
    expect(r.body.version).toBeGreaterThan(3);
    const bd = await v.reglasBd(c.id);
    expect(bd).toHaveLength(1);
    expect(bd[0]).toMatchObject({ destino: "DGNG", activa: true });
    expect((await v.auditoriaDe(E.tenantId, "regla.activada")).some((a) => a.entidad_id === id)).toBe(true);
    expect((await v.auditoriaDe(E.tenantId, "regla.editada")).some((a) => a.entidad_id === id)).toBe(true);
  });

  it("D-5 · versionBase null con una regla viva: 409 regla_cambiada y la regla no cambia", async () => {
    const c = await nuevoCliente();
    await regla(c, { destino: "DNG", version: 2 });
    const r = await recordar(contador, c, [await compra(c, "1")], "DG", null);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "regla_cambiada" });
    sinCanarios(r);
    const bd = await v.reglasBd(c.id);
    expect(bd).toHaveLength(1);
    expect(bd[0]).toMatchObject({ destino: "DNG", version: 2 });
  });

  it("CA-9 · versionBase vieja: 409 regla_cambiada, la regla queda igual y no se audita nada", async () => {
    const c = await nuevoCliente();
    await regla(c, { destino: "DNG", version: 4 });
    const antes = (await v.auditoriaDe(E.tenantId, "regla.editada")).length;
    const r = await recordar(contador, c, [await compra(c, "1")], "DG", 3);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "regla_cambiada" });
    sinCanarios(r);
    expect((await v.reglasBd(c.id))[0]).toMatchObject({ destino: "DNG", version: 4 });
    expect((await v.auditoriaDe(E.tenantId, "regla.editada")).length).toBe(antes);
  });

  it("P-2 · proveedores mezclados: 422 proveedores_distintos, sin regla, sin versiones (D-5) y sin datos del proveedor", async () => {
    const c = await nuevoCliente();
    const a = await compra(c, "1", { doc: PROV });
    const b = await compra(c, "2", { doc: "20700000045" });
    const antes = await v.foto(c.id);
    const r = await recordar(contador, c, [a, b], "DNG", null);
    expect(r.status, r.text).toBe(422);
    expect(r.body).toEqual({ codigo: "proveedores_distintos" });
    sinCanarios(r);
    expect(await v.reglasBd(c.id)).toEqual([]);
    expect(await v.foto(c.id)).toEqual(antes);
    expect(await v.confirmacionesBd(E.tenantId)).toEqual([]);
  });

  it("P-2 · el mismo número con otro tipo de documento es otro proveedor: 422", async () => {
    const c = await nuevoCliente();
    const a = await compra(c, "1", { doc: "20700000011", docTipo: "6" });
    const b = await compra(c, "2", { doc: "20700000011", docTipo: "1" });
    const r = await recordar(contador, c, [a, b], "DNG", null);
    expect(r.status, r.text).toBe(422);
    expect(r.body).toEqual({ codigo: "proveedores_distintos" });
    expect(await v.reglasBd(c.id)).toEqual([]);
  });

  it("CA-5 · una compra de otro cliente, de otro estudio, inexistente o descartada: 404 idéntico y no se crea la regla", async () => {
    const c = await nuevoCliente();
    const otroCliente = await nuevoCliente();
    const deOtro = await compra(otroCliente, "1");
    const ajeno = await v.cliente(F, {});
    const deOtroEstudio = await compra(ajeno, "1", { estudio: F });
    const descartada = await v.sembrarCompra(E.tenantId, c.id, { origen: "agregada", serie: "F009", numero: "9", doc: PROV, usuarioId: u(), descartada: true });
    const propia = await compra(c, "1");
    const esperado = await recordar(contador, c, [inexistente()], "DNG", null);
    expect(esperado.status, esperado.text).toBe(404);
    expect(esperado.body).toEqual(NO_ENCONTRADO);
    for (const ids of [[deOtro], [deOtroEstudio], [descartada], [propia, deOtro], [propia, deOtroEstudio], [propia, inexistente()]]) {
      const r = await recordar(contador, c, ids, "DNG", null);
      expect(r.status, r.text).toBe(404);
      expect(r.body).toEqual(esperado.body);
      expect(r.text).toBe(esperado.text);
    }
    expect(await v.reglasBd(c.id)).toEqual([]);
    expect(await v.reglasBd(otroCliente.id)).toEqual([]);
  });

  it("CA-5 · cliente de otro estudio, no visible o inexistente: el mismo 404", async () => {
    const propio = await nuevoCliente();
    const id = await compra(propio, "1");
    const ajeno = await v.cliente(F, {});
    const noExiste = await recordar(contador, { id: inexistente() }, [id], "DNG", null);
    expect(noExiste.status, noExiste.text).toBe(404);
    expect(noExiste.body).toEqual(NO_ENCONTRADO);
    for (const r of [await recordar(contadorAjeno, propio, [id], "DNG", null), await recordar(contador, ajeno, [id], "DNG", null)]) {
      expect(r.status, r.text).toBe(404);
      expect(r.text).toBe(noExiste.text);
    }
    expect(await v.reglasBd(propio.id)).toEqual([]);
  });

  it.each([
    ["sin versionBase", (id: string) => ({ compraIds: [id], destino: "DNG" })],
    ["destino inexistente", (id: string) => ({ compraIds: [id], destino: "XX", versionBase: null })],
    ["destino en minúsculas", (id: string) => ({ compraIds: [id], destino: "dng", versionBase: null })],
    ["compraIds vacío", () => ({ compraIds: [], destino: "DNG", versionBase: null })],
    ["compraIds repetidos", (id: string) => ({ compraIds: [id, id], destino: "DNG", versionBase: null })],
    ["compraIds que no son uuid", () => ({ compraIds: ["no-es-uuid"], destino: "DNG", versionBase: null })],
    ["versionBase cero", (id: string) => ({ compraIds: [id], destino: "DNG", versionBase: 0 })],
    ["versionBase como cadena", (id: string) => ({ compraIds: [id], destino: "DNG", versionBase: "1" })],
  ])("400 solicitud_invalida y no se escribe nada: %s", async (_n, cuerpo) => {
    const c = await nuevoCliente();
    const id = await compra(c, "1");
    const r = await v.http(contador, "POST", `${rutaReglas(c.id)}/recordar`, cuerpo(id));
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await v.reglasBd(c.id)).toEqual([]);
  });

  it("cliente archivado: 409 cliente_archivado y no escribe", async () => {
    const c = await nuevoCliente({ archivado: true });
    const id = await compra(c, "1");
    const r = await recordar(contador, c, [id], "DNG", null);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
    expect(await v.reglasBd(c.id)).toEqual([]);
  });

  it("auditoría: regla.creada con el usuario, el cliente y la regla; los datos no llevan RUC ni razón social (D-10)", async () => {
    const c = await nuevoCliente();
    const r = await recordar(contador, c, [await compra(c, "1")], "DNG", null);
    expect(r.status, r.text).toBe(200);
    const aud = (await v.auditoriaDe(E.tenantId, "regla.creada")).filter((a) => a.entidad_id === r.body.id);
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({ actor_tipo: "usuario", usuario_id: contador.id, cliente_id: c.id });
    const texto = await v.textoAuditoria(E.tenantId);
    expect(texto).not.toContain(PROV);
    expect(texto).not.toContain(RAZON);
  });

  it("después de eliminar la regla, «Recordar» con versionBase null crea otra (la única es la parcial de las vivas)", async () => {
    const c = await nuevoCliente();
    const vieja = await regla(c, { eliminada: true });
    const r = await recordar(contador, c, [await compra(c, "1")], "DG", null);
    expect(r.status, r.text).toBe(200);
    expect(r.body.id).not.toBe(vieja);
    expect(r.body.version).toBe(1);
    expect((await v.reglasBd(c.id)).filter((x) => !x.eliminada)).toHaveLength(1);
  });

  it("CA-9 · dos «Recordar» del mismo proveedor a la vez dejan una sola regla: uno 200 y el otro 409 regla_cambiada (10 rondas)", async () => {
    for (let ronda = 0; ronda < 10; ronda++) {
      const c = await nuevoCliente();
      const id = await compra(c, "1");
      const [x, y] = await Promise.all([recordar(contador, c, [id], "DNG", null), recordar(E.titular, c, [id], "DG", null)]);
      expect([x.status, y.status].sort(), `${x.text} | ${y.text}`).toEqual([200, 409]);
      const perdedor = x.status === 409 ? x : y;
      expect(perdedor.body).toEqual({ codigo: "regla_cambiada" });
      expect(await v.reglasBd(c.id)).toHaveLength(1);
    }
  });
});

// --- CA-6 · confirmaciones para el catálogo (D-3, P-1, P-10) ----------------------------------------------------------------

describe("CA-6 · «Recordar» y la confirmación para el catálogo (D-3, P-10)", () => {
  it("RUC que empieza en 20 con el aporte encendido: una confirmación `recordar` del estudio, sin montos ni usuario", async () => {
    const c = await nuevoCliente();
    const r = await recordar(contador, c, [await compra(c, "1")], "DNG", null);
    expect(r.status, r.text).toBe(200);
    const filas = (await v.confirmacionesBd(E.tenantId)).filter((x) => x.cliente_id === c.id);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ regla_id: r.body.id, ruc_proveedor: PROV, destino: "DNG", origen: "recordar" });
    expect(Object.keys(filas[0]).sort()).toEqual(["cliente_id", "destino", "origen", "regla_id", "ruc_proveedor"]);
  });

  it("la respuesta de la ruta no trae nada de la confirmación (solo la regla)", async () => {
    const c = await nuevoCliente();
    const r = await recordar(contador, c, [await compra(c, "1")], "DNG", null);
    expect(r.status, r.text).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(CLAVES_REGLA);
    expect(r.text).not.toMatch(/confirmaci/i);
  });

  it.each([
    ["RUC que empieza en 10 (persona natural)", { doc: "10700000011", docTipo: "6" }],
    ["documento que no es RUC (DNI que empieza en 20)", { doc: "20123456", docTipo: "1" }],
  ])("%s: crea la regla pero no registra confirmación", async (_n, prov) => {
    const c = await nuevoCliente();
    const r = await recordar(contador, c, [await compra(c, "1", prov)], "DNG", null);
    expect(r.status, r.text).toBe(200);
    expect(await v.reglasBd(c.id)).toHaveLength(1);
    expect((await v.confirmacionesBd(E.tenantId)).filter((x) => x.cliente_id === c.id)).toEqual([]);
  });

  it("con el aporte del estudio apagado crea la regla y no registra nada", async () => {
    const e = await v.estudio();
    const dueno = e.titular;
    const cont = await v.b.c.p.b.miembro(e.tenantId, "contador");
    const c = await v.cliente(e, { responsable: cont.id });
    await v.fijarAporteBd(e.tenantId, false);
    const compraId = await v.sembrarCompra(e.tenantId, c.id, { serie: "F001", numero: "1", doc: PROV, usuarioId: dueno.id });
    const r = await recordar(cont, c, [compraId], "DNG", null);
    expect(r.status, r.text).toBe(200);
    expect(await v.reglasBd(c.id)).toHaveLength(1);
    expect(await v.confirmacionesBd(e.tenantId)).toEqual([]);
  });

  it("la confirmación queda en el estudio de quien recordó y en ningún otro", async () => {
    const c = await nuevoCliente();
    expect((await recordar(contador, c, [await compra(c, "1")], "DNG", null)).status).toBe(200);
    expect((await v.confirmacionesBd(E.tenantId)).filter((x) => x.cliente_id === c.id)).toHaveLength(1);
    expect((await v.confirmacionesBd(F.tenantId)).filter((x) => x.cliente_id === c.id)).toEqual([]);
  });
});

// --- PATCH -----------------------------------------------------------------------------------------------------------

describe("PATCH …/reglas/:reglaId (editar, activar y desactivar; CA-7)", () => {
  it.each([
    ["asistente", () => asistente],
    ["lectura", () => lectura],
  ])("%s no tiene reglas.gestionar: 403 permiso_denegado y la regla no cambia", async (_n, quien) => {
    const c = await nuevoCliente();
    const id = await regla(c, { destino: "DNG" });
    const r = await editar(quien(), c, id, { versionBase: 1, destino: "DG" });
    expect(r.status, r.text).toBe(403);
    expect(r.body).toEqual({ codigo: "permiso_denegado" });
    expect((await v.reglasBd(c.id))[0]).toMatchObject({ destino: "DNG", version: 1 });
  });

  it("edita el destino: 200, versión + 1, lo ve el listado y queda en la auditoría con valor anterior y nuevo", async () => {
    const c = await nuevoCliente();
    const id = await regla(c, { destino: "DNG" });
    const r = await editar(contador, c, id, { versionBase: 1, destino: "DGNG" });
    expect(r.status, r.text).toBe(200);
    expect(cumple("reglaVistaSchema", r.body), r.text).toBe(true);
    expect(r.body).toMatchObject({ id, destino: "DGNG", activa: true, version: 2 });
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect((await listar(contador, c)).body[0]).toMatchObject({ destino: "DGNG", version: 2 });
    const aud = (await v.auditoriaDe(E.tenantId, "regla.editada")).filter((a) => a.entidad_id === id);
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({ usuario_id: contador.id, cliente_id: c.id });
    expect(aud[0].datos.destino).toEqual({ anterior: "DNG", nuevo: "DGNG" });
  });

  it("desactiva (regla.desactivada) y vuelve a activar (regla.activada); desactivada sigue en el listado con activa false", async () => {
    const c = await nuevoCliente();
    const id = await regla(c);
    const off = await editar(contador, c, id, { versionBase: 1, activa: false });
    expect(off.status, off.text).toBe(200);
    expect(off.body).toMatchObject({ id, activa: false, version: 2 });
    expect((await listar(contador, c)).body[0]).toMatchObject({ id, activa: false });
    expect((await v.auditoriaDe(E.tenantId, "regla.desactivada")).filter((a) => a.entidad_id === id)).toHaveLength(1);
    const on = await editar(contador, c, id, { versionBase: 2, activa: true });
    expect(on.status, on.text).toBe(200);
    expect(on.body).toMatchObject({ id, activa: true, version: 3 });
    expect((await v.auditoriaDe(E.tenantId, "regla.activada")).filter((a) => a.entidad_id === id)).toHaveLength(1);
  });

  it("destino y activa a la vez: una sola versión nueva", async () => {
    const c = await nuevoCliente();
    const id = await regla(c, { destino: "DNG", activa: false });
    const r = await editar(contador, c, id, { versionBase: 1, destino: "DG", activa: true });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ destino: "DG", activa: true, version: 2 });
  });

  it("CA-9 · versionBase vieja: 409 regla_cambiada, la regla queda igual", async () => {
    const c = await nuevoCliente();
    const id = await regla(c, { destino: "DNG", version: 3 });
    const r = await editar(contador, c, id, { versionBase: 2, destino: "DG" });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "regla_cambiada" });
    sinCanarios(r);
    expect((await v.reglasBd(c.id))[0]).toMatchObject({ destino: "DNG", version: 3 });
  });

  it("CA-9 · dos ediciones con la misma versionBase a la vez: una 200 y la otra 409 (10 rondas)", async () => {
    for (let ronda = 0; ronda < 10; ronda++) {
      const c = await nuevoCliente();
      const id = await regla(c, { destino: "DNG" });
      const [x, y] = await Promise.all([
        editar(contador, c, id, { versionBase: 1, destino: "DG" }),
        editar(E.titular, c, id, { versionBase: 1, destino: "DGNG" }),
      ]);
      expect([x.status, y.status].sort(), `${x.text} | ${y.text}`).toEqual([200, 409]);
      expect((await v.reglasBd(c.id))[0].version).toBe(2);
    }
  });

  it("CA-5 · regla inexistente, de otro cliente, de otro estudio, eliminada o con el cliente no visible: el mismo 404", async () => {
    const c = await nuevoCliente();
    const otro = await nuevoCliente();
    const ajeno = await v.cliente(F, {});
    const deOtroCliente = await regla(otro);
    const deOtroEstudio = await v.sembrarRegla(F.tenantId, ajeno.id, { usuarioId: F.titular.id });
    const eliminada = await regla(c, { docNumero: "20700000045", eliminada: true });
    const propia = await regla(c);
    const esperado = await editar(contador, c, inexistente(), { versionBase: 1, destino: "DG" });
    expect(esperado.status, esperado.text).toBe(404);
    expect(esperado.body).toEqual(NO_ENCONTRADO);
    const intentos = [
      await editar(contador, c, deOtroCliente, { versionBase: 1, destino: "DG" }),
      await editar(contador, c, deOtroEstudio, { versionBase: 1, destino: "DG" }),
      await editar(contador, c, eliminada, { versionBase: 1, destino: "DG" }),
      await editar(contadorAjeno, c, propia, { versionBase: 1, destino: "DG" }),
      await editar(contador, ajeno, propia, { versionBase: 1, destino: "DG" }),
    ];
    for (const r of intentos) {
      expect(r.status, r.text).toBe(404);
      expect(r.text).toBe(esperado.text);
    }
    expect((await v.reglasBd(otro.id))[0]).toMatchObject({ destino: "DNG", version: 1 });
    expect((await v.reglasBd(c.id)).find((x) => x.id === propia)).toMatchObject({ destino: "DNG", version: 1 });
  });

  it.each([
    ["sin cambios (solo versionBase)", { versionBase: 1 }],
    ["sin versionBase", { destino: "DG" }],
    ["destino inexistente", { versionBase: 1, destino: "XX" }],
    ["activa como cadena", { versionBase: 1, activa: "true" }],
    ["versionBase cero", { versionBase: 0, destino: "DG" }],
    ["solo claves ajenas", { versionBase: 1, proveedor: "20700000045", periodoAprendido: "202601" }],
  ])("400 solicitud_invalida y la regla no cambia: %s", async (_n, cuerpo) => {
    const c = await nuevoCliente();
    const id = await regla(c, { destino: "DNG" });
    const r = await editar(contador, c, id, cuerpo);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect((await v.reglasBd(c.id))[0]).toMatchObject({ destino: "DNG", version: 1, activa: true });
  });

  it("cliente archivado: 409 cliente_archivado y no escribe", async () => {
    const c = await nuevoCliente({ archivado: true });
    const id = await regla(c, { destino: "DNG" });
    const r = await editar(contador, c, id, { versionBase: 1, destino: "DG" });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
    expect((await v.reglasBd(c.id))[0]).toMatchObject({ destino: "DNG", version: 1 });
  });
});

// --- DELETE ----------------------------------------------------------------------------------------------------------

describe("DELETE …/reglas/:reglaId?versionBase=n (baja lógica, P-9; CA-7)", () => {
  it.each([
    ["asistente", () => asistente],
    ["lectura", () => lectura],
  ])("%s no tiene reglas.gestionar: 403 permiso_denegado y la regla sigue", async (_n, quien) => {
    const c = await nuevoCliente();
    const id = await regla(c);
    const r = await eliminar(quien(), c, id, 1);
    expect(r.status, r.text).toBe(403);
    expect(r.body).toEqual({ codigo: "permiso_denegado" });
    expect((await v.reglasBd(c.id))[0]).toMatchObject({ eliminada: false });
  });

  it("204 sin cuerpo: deja de listarla, la fila queda con la baja lógica y la auditoría lo registra", async () => {
    const c = await nuevoCliente();
    const id = await regla(c);
    const r = await eliminar(contador, c, id, 1);
    expect(r.status, r.text).toBe(204);
    expect(r.text).toBe("");
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect((await listar(contador, c)).body).toEqual([]);
    const bd = await v.reglasBd(c.id);
    expect(bd).toHaveLength(1); // no se borra la fila: las versiones pasadas conservan su «Según historial»
    expect(bd[0]).toMatchObject({ id, eliminada: true });
    const aud = (await v.auditoriaDe(E.tenantId, "regla.eliminada")).filter((a) => a.entidad_id === id);
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({ usuario_id: contador.id, cliente_id: c.id });
  });

  it("una regla eliminada ya no se edita ni se vuelve a eliminar (404)", async () => {
    const c = await nuevoCliente();
    const id = await regla(c);
    expect((await eliminar(contador, c, id, 1)).status).toBe(204);
    expect((await editar(contador, c, id, { versionBase: 1, destino: "DG" })).status).toBe(404);
    expect((await eliminar(contador, c, id, 1)).status).toBe(404);
  });

  it("CA-9 · versionBase vieja: 409 regla_cambiada y la regla sigue viva", async () => {
    const c = await nuevoCliente();
    const id = await regla(c, { version: 3 });
    const r = await eliminar(contador, c, id, 2);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "regla_cambiada" });
    expect((await v.reglasBd(c.id))[0]).toMatchObject({ id, eliminada: false, version: 3 });
  });

  it.each([
    ["sin versionBase", ""],
    ["versionBase no numérica", "?versionBase=abc"],
    ["versionBase cero", "?versionBase=0"],
    ["versionBase decimal", "?versionBase=1.5"],
  ])("400 solicitud_invalida y la regla sigue viva: %s", async (_n, query) => {
    const c = await nuevoCliente();
    const id = await regla(c);
    const r = await v.http(contador, "DELETE", `${rutaReglas(c.id)}/${id}${query}`);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect((await v.reglasBd(c.id))[0]).toMatchObject({ eliminada: false });
  });

  it("CA-5 · regla inexistente, de otro cliente, de otro estudio o con el cliente no visible: el mismo 404 y nada se elimina", async () => {
    const c = await nuevoCliente();
    const otro = await nuevoCliente();
    const ajeno = await v.cliente(F, {});
    const deOtroCliente = await regla(otro);
    const deOtroEstudio = await v.sembrarRegla(F.tenantId, ajeno.id, { usuarioId: F.titular.id });
    const propia = await regla(c);
    const esperado = await eliminar(contador, c, inexistente(), 1);
    expect(esperado.status, esperado.text).toBe(404);
    expect(esperado.body).toEqual(NO_ENCONTRADO);
    for (const r of [
      await eliminar(contador, c, deOtroCliente, 1),
      await eliminar(contador, c, deOtroEstudio, 1),
      await eliminar(contadorAjeno, c, propia, 1),
      await eliminar(contador, ajeno, propia, 1),
    ]) {
      expect(r.status, r.text).toBe(404);
      expect(r.text).toBe(esperado.text);
    }
    expect((await v.reglasBd(otro.id))[0]).toMatchObject({ eliminada: false });
    expect((await v.reglasBd(ajeno.id))[0]).toMatchObject({ eliminada: false });
    expect((await v.reglasBd(c.id))[0]).toMatchObject({ eliminada: false });
  });

  it("cliente archivado: 409 cliente_archivado y no elimina", async () => {
    const c = await nuevoCliente({ archivado: true });
    const id = await regla(c);
    const r = await eliminar(contador, c, id, 1);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
    expect((await v.reglasBd(c.id))[0]).toMatchObject({ eliminada: false });
  });
});

// --- La siguiente descarga (CA-7, P-9) -------------------------------------------------------------------------------------

describe("CA-7 · lo que lee la siguiente descarga cambia con las rutas (reglas_historial_vigentes, como el worker)", () => {
  const PERIODO_SIGUIENTE = PERIODO; // 202610 es posterior al periodo aprendido (202609, P-5)

  it("control: una regla viva y activa se aplica en el periodo siguiente, con su destino y su versión", async () => {
    const c = await nuevoCliente();
    const id = await regla(c, { destino: "DNG" });
    const filas = await v.reglasParaDescarga(E.tenantId, c.id, PERIODO_SIGUIENTE);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ regla_id: id, doc_tipo: "6", doc_numero: PROV, destino: "DNG", version: 1 });
  });

  it("P-9 · eliminar la regla: la siguiente descarga no la lee", async () => {
    const c = await nuevoCliente();
    const id = await regla(c);
    expect((await eliminar(contador, c, id, 1)).status).toBe(204);
    expect(await v.reglasParaDescarga(E.tenantId, c.id, PERIODO_SIGUIENTE)).toEqual([]);
  });

  it("desactivar la regla: la siguiente descarga no la lee; volver a activarla, sí", async () => {
    const c = await nuevoCliente();
    const id = await regla(c);
    expect((await editar(contador, c, id, { versionBase: 1, activa: false })).status).toBe(200);
    expect(await v.reglasParaDescarga(E.tenantId, c.id, PERIODO_SIGUIENTE)).toEqual([]);
    expect((await editar(contador, c, id, { versionBase: 2, activa: true })).status).toBe(200);
    expect(await v.reglasParaDescarga(E.tenantId, c.id, PERIODO_SIGUIENTE)).toHaveLength(1);
  });

  it("editar el destino: la siguiente descarga lee el destino nuevo", async () => {
    const c = await nuevoCliente();
    const id = await regla(c, { destino: "DNG" });
    expect((await editar(contador, c, id, { versionBase: 1, destino: "DG" })).status).toBe(200);
    const filas = await v.reglasParaDescarga(E.tenantId, c.id, PERIODO_SIGUIENTE);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ destino: "DG", version: 2 });
  });

  it("«Recordar» no se aplica a su propio periodo ni a uno anterior (P-5)", async () => {
    const c = await nuevoCliente();
    const r = await recordar(contador, c, [await compra(c, "1", { periodo: "202610" })], "DNG", null);
    expect(r.status, r.text).toBe(200);
    expect(await v.reglasParaDescarga(E.tenantId, c.id, "202610")).toEqual([]);
    expect(await v.reglasParaDescarga(E.tenantId, c.id, "202609")).toEqual([]);
    expect(await v.reglasParaDescarga(E.tenantId, c.id, "202611")).toHaveLength(1);
  });
});
