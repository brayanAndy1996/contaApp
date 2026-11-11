/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 017 (T5, rojo): consulta de auditoría `GET /auditoria?cursor=` (P-2, D-1, D-2, D-6, D-12; CA-4, CA-6, CA-7, CA-13, CA-14). PG real.
// Contrato (plan 017, «Contratos: HTTP» y shared; lo implementa T10 sobre las tablas de T7 y `listarAuditoria` de T8):
//  - `@Permiso("auditoria.ver")` (Dueño y Administrador). Contador, Asistente y Lectura: 403 `{ codigo: "permiso_denegado" }` sin datos;
//    sin sesión 401 `sesion_invalida`. `Cache-Control: no-store`.
//  - 200 `{ items, siguiente }`: del estudio de la sesión, por `(ocurrida_en, id)` desc, a lo sumo 50; `siguiente` es un cursor OPACO
//    (texto) o `null` en la última página. Un cursor mal formado, o una consulta con claves (`usuarioId`, `tenantId`, `clienteId`,
//    `limite`), es 400 `{ codigo: "solicitud_invalida" }`.
//  - Cada item es exactamente `{ id, ocurridaEn, accion, actor, cliente, entidad, entidadId, datos }`, sin `tenantId` ni `usuarioId`:
//      actor   = { tipo: "usuario" | "trabajo" | "sistema", autor: { id, nombre, activo } | null, trabajoId: uuid | null }
//                (usuario: autor de la sesión; trabajo: autor = quien lanzó el trabajo; sistema: autor null y trabajoId null).
//                `autor` sigue D-12: miembro activo = su nombre; desactivado = su nombre con activo false; un id que no es miembro del
//                estudio = `nombre: null`, `activo: false` y NUNCA el nombre del usuario.
//      cliente = { id, ruc, razonSocial } | null.
//  - Une `auditoria_descifrado` (003, D-6): sale como `accion: "credencial.descifrada"`, con el `id` y el instante (`created_at`) de la
//    fila de descifrado, el cliente, `actor` de sistema (el registro no guarda quién) y `datos` con `tipo`, `motivo` y `resultado`;
//    se intercala por instante con el resto. Un descifrado también exige `auditoria.ver`.
//  - El actor de lo que audita la API es el de la SESIÓN, nunca un campo del cuerpo (CA-4). `datos` es la lista blanca del plan: p. ej.
//    `cliente.creado` = `{ origen: "manual" }`, `credencial.guardada` = `{ tipo }`; nunca un secreto (CA-6).
// Rojo: la ruta aún no existe (T10): 404 de ruta. Las pruebas que siembran filas fallan además por las tablas de T7, pero cada una
// comprueba antes la ruta para que el rojo sea «ruta ausente».
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, type RolSistema } from "../../../test/soporte-acceso.js";
import { abrirBancoCola, canario, filtrados, rucValido, type BancoCola, type Estudio } from "../../../test/soporte-credenciales.js";
import {
  CLAVES_INTERNAS,
  esNoStore,
  limpiarAvisosDeEstudios,
  sembrarAuditoria,
  sembrarAuditorias,
  sembrarDescifrado,
} from "../../../test/soporte-notificaciones.js";
import { capturarLogs, type Resp } from "../../../test/soporte.js";

let b: BancoCola;
const estudios: string[] = [];

beforeAll(async () => {
  b = await abrirBancoCola();
});
afterAll(async () => {
  if (b) await limpiarAvisosDeEstudios(estudios);
  await b?.cerrar();
});

const sql = <T = any>(t: string, v?: unknown[]) => b.sql<T>(t, v);
const llamar = (a: Actor, m: "GET" | "POST" | "PUT", ruta: string, cuerpo?: unknown, extra?: Parameters<typeof b.c.p.b.llamar>[4]) =>
  b.c.p.b.llamar(a, m, ruta, cuerpo, extra);
const get = (a: Actor, ruta: string) => llamar(a, "GET", ruta);

interface Esc {
  E: Estudio;
  dueno: Actor;
  cliente: { id: string; ruc: string; razonSocial: string };
  miembro(rol: RolSistema, nombre?: string): Promise<Actor>;
}
/** Estudio nuevo con su Dueño y un cliente (cada prueba el suyo: así el rastro de otras no ensucia el recorrido de páginas). */
async function escenario(): Promise<Esc> {
  const E = await b.estudio();
  estudios.push(E.tenantId);
  const razonSocial = `SAN JUAN SAC ${randomUUID().slice(0, 6)}`;
  const c = await b.c.sembrar(E.tenantId, { razonSocial });
  await sql("update usuario set nombre = 'Dueña Principal' where id = $1", [E.titular.id]);
  return {
    E,
    dueno: E.titular,
    cliente: { id: c.id, ruc: c.ruc, razonSocial },
    miembro: async (rol, nombre) => {
      const a = await b.c.p.b.miembro(E.tenantId, rol);
      if (nombre) await sql("update usuario set nombre = $2 where id = $1", [a.id, nombre]);
      return a;
    },
  };
}

/** Recorre TODAS las páginas siguiendo `siguiente`; cada página responde 200 y trae a lo sumo 50 filas. */
async function recorrer(a: Actor, max = 40): Promise<{ items: any[]; paginas: any[][]; texto: string }> {
  const items: any[] = [];
  const paginas: any[][] = [];
  let texto = "";
  let cursor: string | null = null;
  for (let i = 0; i < max; i++) {
    const r: Resp = await get(a, `/auditoria${cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`}`);
    expect(r.status, `página ${i + 1}: ${r.text}`).toBe(200);
    expect(r.body.items.length).toBeLessThanOrEqual(50);
    paginas.push(r.body.items);
    items.push(...r.body.items);
    texto += `${r.text}\n`;
    cursor = r.body.siguiente;
    if (cursor === null) return { items, paginas, texto };
    expect(typeof cursor).toBe("string");
  }
  throw new Error("la consulta de auditoría no termina de paginar");
}
/** Falla con «ruta ausente» antes de sembrar nada. */
async function exigirRuta(a: Actor): Promise<void> {
  const r = await get(a, "/auditoria");
  expect(r.status, `GET /auditoria no responde 200 (¿ruta ausente?): ${r.text}`).toBe(200);
}
const de = (items: any[], ids: string[]): any[] => items.filter((x) => ids.includes(x.id));

describe("CA-14 · solo con auditoria.ver (Dueño y Administrador)", () => {
  it("Dueño y Administrador 200 con { items, siguiente } y no-store; Contador, Asistente y Lectura 403 permiso_denegado sin datos", async () => {
    const e = await escenario();
    const admin = await e.miembro("admin");
    await exigirRuta(e.dueno);
    const fila = await sembrarAuditoria(sql, { tenantId: e.E.tenantId, usuarioId: e.dueno.id, clienteId: e.cliente.id, hace: 30 });
    await sembrarDescifrado(sql, { tenantId: e.E.tenantId, clienteId: e.cliente.id, hace: 20 });
    for (const a of [e.dueno, admin]) {
      const r = await get(a, "/auditoria");
      expect(r.status, `${a.rol}: ${r.text}`).toBe(200);
      expect(Object.keys(r.body).sort()).toEqual(["items", "siguiente"]);
      expect(esNoStore(r.headers["cache-control"])).toBe(true);
      expect(r.body.items.map((x: any) => x.id)).toContain(fila.id);
    }
    for (const rol of ["contador", "asistente", "lectura"] as const) {
      const a = await e.miembro(rol);
      const r = await get(a, "/auditoria");
      expect(r.status, `${rol}: ${r.text}`).toBe(403);
      expect(r.body).toEqual({ codigo: "permiso_denegado" });
      expect(r.text).not.toContain(e.cliente.razonSocial);
      expect(r.text).not.toContain("credencial.descifrada");
    }
  });

  it("sin sesión es 401 sesion_invalida", async () => {
    const e = await escenario();
    await exigirRuta(e.dueno);
    const r = await b.c.p.b.h.pedir({ ruta: "/auditoria" });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ codigo: "sesion_invalida" });
  });

  it("con el X-Estudio de otro estudio no se llega al negocio (409 estudio_desfasado)", async () => {
    const e = await escenario();
    const otro = await escenario();
    await exigirRuta(e.dueno);
    const r = await llamar(e.dueno, "GET", "/auditoria", undefined, { estudio: otro.E.tenantId });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "estudio_desfasado" });
  });
});

describe("P-2 · la lista: forma, orden y descifrados", () => {
  it("de la más nueva a la más vieja, con la forma exacta y los tres tipos de actor", async () => {
    const e = await escenario();
    await exigirRuta(e.dueno);
    const contador = await e.miembro("contador", "Carlos Contador");
    const trabajoId = randomUUID();
    const sistema = await sembrarAuditoria(sql, { tenantId: e.E.tenantId, accion: "miembro.alta", entidad: "membresia", datos: { rol: "contador", via: "otro" }, hace: 100 });
    const deTrabajo = await sembrarAuditoria(sql, {
      tenantId: e.E.tenantId,
      actorTipo: "trabajo",
      usuarioId: contador.id,
      trabajoId,
      accion: "propuesta.cargada",
      clienteId: e.cliente.id,
      entidad: "propuesta",
      entidadId: randomUUID(),
      datos: { libro: "compras", periodo: "202610", fuente: "sire", filasRecibidas: 12 },
      hace: 200,
    });
    const deUsuario = await sembrarAuditoria(sql, {
      tenantId: e.E.tenantId,
      usuarioId: e.dueno.id,
      accion: "cliente.editado",
      clienteId: e.cliente.id,
      datos: { cambios: { razon_social: ["VIEJA SAC", "SAN JUAN SAC"] } },
      hace: 300,
    });
    const r = await recorrer(e.dueno);
    const mias = de(r.items, [sistema.id, deTrabajo.id, deUsuario.id]);
    expect(mias.map((x) => x.id)).toEqual([sistema.id, deTrabajo.id, deUsuario.id]); // más nueva primero
    for (const x of mias) {
      expect(Object.keys(x).sort()).toEqual(["accion", "actor", "cliente", "datos", "entidad", "entidadId", "id", "ocurridaEn"]);
      expect(Object.keys(x.actor).sort()).toEqual(["autor", "tipo", "trabajoId"]);
    }
    const [s, t, u] = mias;
    expect(s).toMatchObject({ accion: "miembro.alta", cliente: null, entidad: "membresia", datos: { rol: "contador", via: "otro" }, actor: { tipo: "sistema", autor: null, trabajoId: null } });
    expect(t).toMatchObject({
      accion: "propuesta.cargada",
      entidad: "propuesta",
      datos: { libro: "compras", periodo: "202610", fuente: "sire", filasRecibidas: 12 },
      actor: { tipo: "trabajo", trabajoId, autor: { id: contador.id, nombre: "Carlos Contador", activo: true } },
    });
    expect(u).toMatchObject({
      accion: "cliente.editado",
      cliente: { id: e.cliente.id, ruc: e.cliente.ruc, razonSocial: e.cliente.razonSocial },
      entidadId: e.cliente.id,
      datos: { cambios: { razon_social: ["VIEJA SAC", "SAN JUAN SAC"] } },
      actor: { tipo: "usuario", trabajoId: null, autor: { id: e.dueno.id, nombre: "Dueña Principal", activo: true } },
    });
    expect(Object.keys(u.cliente).sort()).toEqual(["id", "razonSocial", "ruc"]);
    expect(u.ocurridaEn).toBe(deUsuario.creadaEn);
    for (const clave of CLAVES_INTERNAS) expect(r.texto, clave).not.toContain(clave);
  });

  it("une los descifrados de 003 como credencial.descifrada y los intercala por instante (CA-14)", async () => {
    const e = await escenario();
    await exigirRuta(e.dueno);
    const antes = await sembrarAuditoria(sql, { tenantId: e.E.tenantId, usuarioId: e.dueno.id, clienteId: e.cliente.id, hace: 500 });
    const despues = await sembrarAuditoria(sql, { tenantId: e.E.tenantId, usuarioId: e.dueno.id, clienteId: e.cliente.id, hace: 300 });
    const d = await sembrarDescifrado(sql, { tenantId: e.E.tenantId, clienteId: e.cliente.id, tipo: "sire_api", motivo: "sire.propuesta.descargar", resultado: "ok", hace: 400 });
    const r = await recorrer(e.dueno);
    const mias = de(r.items, [antes.id, despues.id, d.id]);
    expect(mias.map((x) => x.id)).toEqual([despues.id, d.id, antes.id]);
    const x = mias[1];
    expect(x).toMatchObject({
      accion: "credencial.descifrada",
      cliente: { id: e.cliente.id, ruc: e.cliente.ruc },
      actor: { tipo: "sistema", autor: null, trabajoId: null },
      datos: { tipo: "sire_api", motivo: "sire.propuesta.descargar", resultado: "ok" },
    });
    expect(x.ocurridaEn).toBe(d.creadaEn);
    expect(Object.keys(x).sort()).toEqual(["accion", "actor", "cliente", "datos", "entidad", "entidadId", "id", "ocurridaEn"]);
  });
});

describe("P-2 · cursor y página de 50", () => {
  it("62 filas con 4 empatadas en el corte de la primera página: sin repetir ni saltar y con cursor opaco", async () => {
    const e = await escenario();
    await exigirRuta(e.dueno);
    const esperadas = await sembrarAuditorias(sql, { tenantId: e.E.tenantId, usuarioId: e.dueno.id, clienteId: e.cliente.id, n: 62, empates: 14 });
    const primera = await get(e.dueno, "/auditoria");
    expect(primera.status, primera.text).toBe(200);
    expect(primera.body.items).toHaveLength(50);
    expect(typeof primera.body.siguiente).toBe("string");
    expect(primera.body.siguiente).not.toMatch(/\d{4}-\d{2}-\d{2}/); // opaco: no deja ver la fecha
    const r = await recorrer(e.dueno);
    expect(r.paginas.length).toBeGreaterThanOrEqual(2);
    expect(r.paginas[0]).toHaveLength(50);
    const ids = r.items.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length); // ninguna repetida
    expect(de(r.items, esperadas).map((x) => x.id)).toEqual(esperadas); // ni una saltada, en el orden (ocurrida_en, id) desc
  });

  it.each([
    ["basura", "basura"],
    ["signos", "!!!"],
    ["JSON sin forma", "eyJhIjoxfQ"],
    ["2000 caracteres", "x".repeat(2000)],
  ])("el cursor mal formado (%s) es 400 solicitud_invalida", async (_n, cursor) => {
    const e = await escenario();
    await exigirRuta(e.dueno);
    const r = await get(e.dueno, `/auditoria?cursor=${encodeURIComponent(cursor)}`);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
  });

  it.each(["usuarioId", "tenantId", "clienteId", "limite"])("la consulta es estricta: «%s» es 400 (CA-4)", async (clave) => {
    const e = await escenario();
    await exigirRuta(e.dueno);
    const r = await get(e.dueno, `/auditoria?${clave}=${clave === "limite" ? "1000" : e.dueno.id}`);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
  });
});

describe("CA-7 · aislamiento entre estudios", () => {
  it("la auditoría y los descifrados de otro estudio no salen, ni por la sesión ni por su X-Estudio", async () => {
    const a = await escenario();
    const otro = await escenario();
    await exigirRuta(a.dueno);
    const mia = await sembrarAuditoria(sql, { tenantId: a.E.tenantId, usuarioId: a.dueno.id, clienteId: a.cliente.id, hace: 30 });
    const ajena = await sembrarAuditoria(sql, { tenantId: otro.E.tenantId, usuarioId: otro.dueno.id, clienteId: otro.cliente.id, hace: 20 });
    const descAjeno = await sembrarDescifrado(sql, { tenantId: otro.E.tenantId, clienteId: otro.cliente.id, hace: 10 });
    const deA = await recorrer(a.dueno);
    expect(deA.items.map((x) => x.id)).toContain(mia.id);
    expect(deA.items.map((x) => x.id)).not.toContain(ajena.id);
    expect(deA.items.map((x) => x.id)).not.toContain(descAjeno.id);
    for (const marca of [otro.E.tenantId, otro.dueno.id, otro.cliente.id, otro.cliente.ruc, otro.cliente.razonSocial])
      expect(deA.texto, marca).not.toContain(marca);
    const deOtro = await recorrer(otro.dueno);
    expect(deOtro.items.map((x) => x.id)).toContain(ajena.id);
    expect(deOtro.items.map((x) => x.id)).not.toContain(mia.id);
    expect(deOtro.texto).not.toContain(a.cliente.razonSocial);
    const cruzada = await llamar(a.dueno, "GET", "/auditoria", undefined, { estudio: otro.E.tenantId });
    expect([403, 404, 409]).toContain(cruzada.status);
    expect(cruzada.text).not.toContain(ajena.id);
  });
});

describe("CA-13 · el actor con nombre (D-12)", () => {
  it("activo con su nombre, desactivado con activo=false y un id ajeno al estudio como nombre null sin filtrar el nombre real", async () => {
    const e = await escenario();
    const otro = await escenario();
    await exigirRuta(e.dueno);
    const activo = await e.miembro("contador", "Ana Activa");
    const inactivo = await e.miembro("contador", "Luis Inactivo");
    await sql("update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2", [e.E.tenantId, inactivo.id]);
    await sql("update usuario set nombre = 'Zoe Secreta Ajena' where id = $1", [otro.dueno.id]);
    const fila = (usuarioId: string, hace: number) => sembrarAuditoria(sql, { tenantId: e.E.tenantId, usuarioId, clienteId: e.cliente.id, hace });
    const fa = await fila(activo.id, 30);
    const fi = await fila(inactivo.id, 20);
    const fd = await fila(otro.dueno.id, 10); // usuario que no es miembro de este estudio
    const r = await recorrer(e.dueno);
    const autor = (id: string) => r.items.find((x) => x.id === id)?.actor.autor;
    expect(autor(fa.id)).toEqual({ id: activo.id, nombre: "Ana Activa", activo: true });
    expect(autor(fi.id)).toEqual({ id: inactivo.id, nombre: "Luis Inactivo", activo: false });
    expect(autor(fd.id)).toEqual({ id: otro.dueno.id, nombre: null, activo: false });
    expect(r.texto).not.toContain("Zoe Secreta Ajena");
  });
});

describe("CA-4 · el actor es el de la sesión", () => {
  const crear = (a: Actor, cuerpo: unknown) => llamar(a, "POST", "/clientes", cuerpo);

  it("un cliente creado por la API deja cliente.creado con el actor de la sesión y la lista blanca { origen }", async () => {
    const e = await escenario();
    const admin = await e.miembro("admin", "Alma Admin");
    await exigirRuta(e.dueno);
    const ruc = rucValido();
    const alta = await crear(admin, { ruc, razonSocial: "Alta Por API SAC" });
    expect(alta.status, alta.text).toBe(201);
    const r = await recorrer(e.dueno);
    const filas = r.items.filter((x) => x.accion === "cliente.creado" && x.cliente?.ruc === ruc);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      entidad: "cliente",
      entidadId: alta.body.id,
      cliente: { id: alta.body.id, ruc, razonSocial: "Alta Por API SAC" },
      datos: { origen: "manual" },
      actor: { tipo: "usuario", trabajoId: null, autor: { id: admin.id, nombre: "Alma Admin", activo: true } },
    });
  });

  it("un usuarioId o tenantId en el cuerpo no cambia el actor: queda el de la sesión o se rechaza, nunca el falsificado", async () => {
    const e = await escenario();
    const otro = await escenario();
    const admin = await e.miembro("admin");
    await exigirRuta(e.dueno);
    const ruc = rucValido();
    const intento = await crear(admin, { ruc, razonSocial: "Falsificado SAC", usuarioId: e.dueno.id, tenantId: otro.E.tenantId });
    const creado = await sql("select id, tenant_id from cliente where ruc = $1", [ruc]);
    const r = await recorrer(e.dueno);
    const filas = r.items.filter((x) => x.accion === "cliente.creado" && x.cliente?.ruc === ruc);
    if (intento.status === 201) {
      expect(creado).toHaveLength(1);
      expect(creado[0].tenant_id).toBe(e.E.tenantId); // el estudio es el de la sesión
      expect(filas).toHaveLength(1);
      expect(filas[0].actor.autor.id).toBe(admin.id);
    } else {
      expect(intento.status, intento.text).toBe(400);
      expect(creado).toHaveLength(0);
      expect(filas).toHaveLength(0);
    }
    const deOtro = await recorrer(otro.dueno);
    expect(deOtro.items.filter((x) => x.cliente?.ruc === ruc)).toEqual([]);
  });

  it("el ingreso a un estudio deja sesion.ingreso del usuario que entra, sin cliente y con datos vacíos", async () => {
    const e = await escenario();
    await exigirRuta(e.dueno);
    const nuevo = await e.miembro("contador", "Nora Nueva"); // inicia sesión y elige el estudio
    const r = await recorrer(e.dueno);
    const filas = r.items.filter((x) => x.accion === "sesion.ingreso" && x.actor.autor?.id === nuevo.id);
    expect(filas.length).toBeGreaterThanOrEqual(1);
    expect(filas[0]).toMatchObject({ cliente: null, entidad: "sesion", datos: {}, actor: { tipo: "usuario", autor: { nombre: "Nora Nueva", activo: true } } });
  });
});

describe("CA-6 · ningún valor centinela en auditoría, notificaciones, logs ni respuestas", () => {
  it("guardar, invalidar y descifrar credenciales con centinelas no deja rastro en la consulta, las notificaciones, los logs ni las tablas", async () => {
    const e = await escenario();
    const contador = await e.miembro("contador", "Cora Contadora");
    await exigirRuta(e.dueno);
    const cl = await b.c.sembrar(e.E.tenantId, { responsable: contador.id });
    const centinelas = [canario("usuario"), canario("clave"), canario("client-id"), canario("client-secret")];
    const { resultado, logs } = await capturarLogs(async () => {
      const g1 = await llamar(e.dueno, "PUT", `/clientes/${cl.id}/credenciales/sol`, { usuario: centinelas[0], clave: centinelas[1] });
      const g2 = await llamar(e.dueno, "PUT", `/clientes/${cl.id}/credenciales/sire_api`, { clientId: centinelas[2], clientSecret: centinelas[3] });
      expect(g1.status, g1.text).toBe(200);
      expect(g2.status, g2.text).toBe(200);
      await sql("update credencial set estado = 'invalida' where cliente_id = $1 and tipo = 'sol'", [cl.id]);
      await sembrarDescifrado(sql, { tenantId: e.E.tenantId, clienteId: cl.id, tipo: "sol", motivo: "credencial.verificar", resultado: "ok", hace: 5 });
      const aud = await recorrer(e.dueno);
      const dueno = await get(e.dueno, "/notificaciones");
      const resp = await get(contador, "/notificaciones");
      expect(dueno.status, dueno.text).toBe(200);
      expect(resp.status, resp.text).toBe(200);
      return { aud, textos: [dueno.text, resp.text] };
    });
    // Control de que la prueba no es vacía: la consulta ve las acciones de credencial, solo con el tipo (lista blanca).
    const guardadas = resultado.aud.items.filter((x) => x.accion === "credencial.guardada" && x.cliente?.id === cl.id);
    expect(guardadas.map((x) => x.datos).sort((p, q) => p.tipo.localeCompare(q.tipo))).toEqual([{ tipo: "sire_api" }, { tipo: "sol" }]);
    expect(resultado.aud.items.some((x) => x.accion === "credencial.invalidada" && x.cliente?.id === cl.id)).toBe(true);
    expect(resultado.aud.items.some((x) => x.accion === "credencial.descifrada" && x.cliente?.id === cl.id)).toBe(true);
    for (const x of resultado.aud.items.filter((y) => y.accion.startsWith("credencial.")))
      expect(Object.keys(x.datos).every((k) => ["tipo", "motivo", "resultado"].includes(k)), JSON.stringify(x.datos)).toBe(true);
    // Ningún centinela: respuestas, logs y las propias tablas.
    const enTablas = await sql(
      `select (select coalesce(string_agg(datos::text, ' '), '') from auditoria where tenant_id = $1)
           || (select coalesce(string_agg(params::text, ' '), '') from notificacion where tenant_id = $1) as t`,
      [e.E.tenantId],
    );
    expect(filtrados(centinelas, resultado.aud.texto, ...resultado.textos, logs, enTablas[0].t)).toEqual([]);
  });
});
