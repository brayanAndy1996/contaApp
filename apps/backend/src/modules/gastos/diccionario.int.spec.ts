/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 027 (T6, rojo): diccionario del estudio y umbral por HTTP (RF-117, R-4, R-6, R-8, R-11; D-2, D-3, D-4; CA-7, CA-10, CA-14).
// Contrato (plan 027, «Contratos: HTTP» y `@contapp/shared`: `gastosEstudioVistaSchema`, `agregarPalabraSchema`, `estadoPalabraSchema`,
// `estadoGlobalSchema`, `umbralSchema`; auditoría exacta de `tests/aislamiento/gnd-soporte.ts`):
//  - `GET /estudio/reglas-motor/gastos` (`reglas.ver`) -> 200 `GastosEstudioVista` (umbral, versionUmbral, activasPropias, limitePropias 2000,
//    globales activas con `desactivadaPorEstudio`, propias con origen, autor y compra de origen). Sin fila de config: umbral 3 y versión 0.
//  - `PUT …/umbral {umbral 1..20, version}` -> 200 `{version}` (la nueva); versión vieja 409 `version_cambiada`; 0, 21, decimal o «3» 400.
//  - `POST …/palabras {palabra, categoria, excepciones?}` -> 201 `{id, version: 1}`. El backend normaliza la palabra y las excepciones con el
//    dominio (sin tildes ni mayúsculas); repetida 409 `palabra_existente`; con 2.000 activas 409 `limite_palabras`.
//  - `PUT …/palabras/:id {activa, version}` -> 200 `{version}` (+1); versión vieja 409 `version_cambiada`; reactivar con 2.000 activas 409
//    `limite_palabras`; id de otro estudio o inexistente 404 `no_encontrado`, el mismo.
//  - `PUT …/globales/:id {activa}` -> 200 `{}`: el estudio desactiva (o reactiva) una global solo para él; global inexistente o inactiva 404.
//  - Escribir exige `reglas.gestionar` Y alcance global (Dueño o Administrador); los permisos están en `permisos-027.int.spec.ts`.
//  - Auditoría (017) con el usuario y datos exactos, nunca glosas; `Cache-Control: no-store`; errores `{codigo}`.
// Rojo: las rutas aún no existen (T12): responden 404 de ruta inexistente.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoGastos,
  ACCIONES_027,
  CATEGORIAS,
  cumple,
  inexistente,
  LIMITE_PROPIAS,
  NO_ENCONTRADO,
  rutaGlobal,
  rutaPalabra,
  rutaPalabras,
  rutaUmbral,
  RUTA_GASTOS,
  SOLICITUD_INVALIDA,
  UMBRAL_POR_DEFECTO,
  type Actor,
  type BancoGastos,
  type Estudio,
} from "../../../test/soporte-gastos.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let v: BancoGastos;
let E: Estudio;
let F: Estudio;
let G: Estudio; // estudio del límite al agregar (2.000 palabras sembradas): no contamina a E ni a F
let H: Estudio; // estudio del límite al reactivar (1.999 activas y dos inactivas)
let admin: Actor;
let contador: Actor;
let asistente: Actor;
let lectura: Actor;

beforeAll(async () => {
  v = await abrirBancoGastos();
  E = await v.estudio();
  F = await v.estudio();
  G = await v.estudio();
  H = await v.estudio();
  const p = v.b.c.p.b;
  admin = await p.miembro(E.tenantId, "admin");
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
  lectura = await p.miembro(E.tenantId, "lectura");
});
afterAll(async () => {
  await v?.cerrar();
});

const hex = (): string => Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, "x");
/** Palabra propia nueva (letras y dígitos, 3 a 40, única en el proceso). */
const nueva = (prefijo = "pal"): string => `${prefijo}${hex()}${Date.now().toString(36)}`;

/** Borra la fila del umbral del estudio (sin la tabla de T10 no hay nada que borrar: el rojo cae en la ruta, no aquí). */
const borrarConfig = (...tenants: string[]) =>
  v.b.sql("delete from gnd_config where tenant_id = any($1::uuid[])", [tenants]).catch((e: { code?: string }) => {
    if (e.code !== "42P01") throw e;
  });
const leer = async (a: Actor) => {
  const r = await v.http(a, "GET", RUTA_GASTOS);
  expect(r.status, r.text).toBe(200);
  return r;
};
const agregar = (a: Actor, cuerpo: unknown) => v.http(a, "POST", rutaPalabras(), cuerpo);
const estadoPalabra = (a: Actor, id: string, cuerpo: unknown) => v.http(a, "PUT", rutaPalabra(id), cuerpo);
const estadoGlobal = (a: Actor, id: string, cuerpo: unknown) => v.http(a, "PUT", rutaGlobal(id), cuerpo);
const fijarUmbral = (a: Actor, cuerpo: unknown) => v.http(a, "PUT", rutaUmbral(), cuerpo);
const globalDe = (vista: any, palabra: string) => (vista.globales as any[]).find((g) => g.palabra === palabra);
const propiaDe = (vista: any, palabra: string) => (vista.propias as any[]).find((p) => p.palabra === palabra);

describe("GET /estudio/reglas-motor/gastos (RF-117, R-11, CA-7)", () => {
  it("200 con la forma de gastosEstudioVistaSchema: umbral 3 y versión 0 por omisión, límite 2000, sin propias", async () => {
    const r = await leer(admin);
    expect(r.status, r.text).toBe(200);
    expect(cumple("gastosEstudioVistaSchema", r.body), r.text).toBe(true);
    expect(Object.keys(r.body).sort()).toEqual(["activasPropias", "globales", "limitePropias", "propias", "umbral", "versionUmbral"]);
    expect(r.body).toMatchObject({ umbral: UMBRAL_POR_DEFECTO, versionUmbral: 0, activasPropias: 0, limitePropias: LIMITE_PROPIAS, propias: [] });
    expect(r.headers["cache-control"]).toMatch(/no-store/);
  });

  it("las globales traen la semilla: «zapatilla» con sus excepciones, «polo» con «a tierra», y ninguna desactivada por el estudio", async () => {
    const r = await leer(admin);
    expect(r.status, r.text).toBe(200);
    expect(globalDe(r.body, "zapatilla")).toMatchObject({ categoria: "calzado-ropa", desactivadaPorEstudio: false });
    expect(globalDe(r.body, "zapatilla").excepciones).toEqual(expect.arrayContaining(["seguridad", "punta de acero"]));
    expect(globalDe(r.body, "polo").excepciones).toEqual(["a tierra"]);
    expect((r.body.globales as any[]).filter((g) => g.desactivadaPorEstudio)).toEqual([]);
    expect(new Set((r.body.globales as any[]).map((g) => g.categoria))).toEqual(new Set(CATEGORIAS));
    for (const g of r.body.globales as any[]) expect(Object.keys(g).sort()).toEqual(["categoria", "desactivadaPorEstudio", "excepciones", "id", "palabra"]);
  });

  it.each([
    ["admin", () => admin],
    ["dueño", () => E.titular],
    ["contador", () => contador],
    ["asistente", () => asistente],
    ["lectura", () => lectura],
  ])("%s con reglas.ver la lee (200)", async (_n, quien) => {
    const r = await leer(quien());
    expect(r.status, r.text).toBe(200);
  });

  it("sin sesión: 401", async () => {
    const r = await v.sinSesion("GET", RUTA_GASTOS);
    expect(r.status, r.text).toBe(401);
  });

  it("refleja lo sembrado: propias activas e inactivas con su origen, su autor y su versión; el umbral y su versión", async () => {
    const activa = nueva("act");
    const inactiva = nueva("ina");
    const idA = await v.sembrarPropia(E.tenantId, { palabra: activa, categoria: "juguetes", creadoPor: admin.id, excepciones: ["lego"] });
    const idI = await v.sembrarPropia(E.tenantId, { palabra: inactiva, categoria: "cuidado-personal", creadoPor: contador.id, activa: false, version: 4 });
    await v.sembrarConfig(E.tenantId, 7, 2);
    const r = await leer(lectura);
    expect(r.status, r.text).toBe(200);
    expect(cumple("gastosEstudioVistaSchema", r.body), r.text).toBe(true);
    expect(r.body).toMatchObject({ umbral: 7, versionUmbral: 2, activasPropias: 1 });
    expect(propiaDe(r.body, activa)).toMatchObject({
      id: idA,
      categoria: "juguetes",
      excepciones: ["lego"],
      origen: "manual",
      activa: true,
      version: 1,
      autor: { id: admin.id, nombre: await v.nombreDe(admin.id) },
      compraOrigenId: null,
    });
    expect(propiaDe(r.body, inactiva)).toMatchObject({ id: idI, categoria: "cuidado-personal", activa: false, version: 4, autor: { id: contador.id } });
    await borrarConfig(E.tenantId);
  });

  it("es del estudio (CA-7, R-6): las propias y el umbral de uno no se ven en otro", async () => {
    const mia = nueva("mia");
    await v.sembrarPropia(F.tenantId, { palabra: mia, creadoPor: F.titular.id });
    await v.sembrarConfig(F.tenantId, 11, 3);
    const deF = await leer(F.titular);
    expect(propiaDe(deF.body, mia)).toBeDefined();
    expect(deF.body.umbral).toBe(11);
    const deE = await leer(admin);
    expect(propiaDe(deE.body, mia)).toBeUndefined();
    expect(deE.text).not.toContain(mia);
    expect(deE.body.umbral).not.toBe(11);
    await borrarConfig(F.tenantId);
  });
});

describe("POST …/palabras (RF-117, R-4, CA-7)", () => {
  it("201 {id, version: 1}: la palabra queda propia, manual, activa y normalizada (sin tildes ni mayúsculas), con el usuario", async () => {
    const r = await agregar(admin, { palabra: "AudíFonos", categoria: "entretenimiento" });
    expect(r.status, r.text).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(["id", "version"]);
    expect(r.body.version).toBe(1);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    const fila = (await v.propiasBd(E.tenantId)).find((p) => p.palabra === "audifonos");
    expect(fila).toMatchObject({ id: r.body.id, categoria: "entretenimiento", excepciones: [], origen: "manual", activa: true, version: 1, creado_por: admin.id, compra_origen_id: null });
    const vista = await leer(lectura);
    expect(propiaDe(vista.body, "audifonos")).toMatchObject({ id: r.body.id, origen: "manual", autor: { id: admin.id } });
    await v.b.sql("delete from gnd_palabra_estudio where id = $1", [r.body.id]);
  });

  it("las excepciones se normalizan igual (frases de 1 a 3 palabras en minúsculas y sin tildes)", async () => {
    const palabra = nueva("exc");
    const r = await agregar(admin, { palabra, categoria: "calzado-ropa", excepciones: ["SEGURIDAD", "Punta de ACERO", "reflectíva"] });
    expect(r.status, r.text).toBe(201);
    const fila = (await v.propiasBd(E.tenantId)).find((p) => p.palabra === palabra);
    expect(fila.excepciones).toEqual(["seguridad", "punta de acero", "reflectiva"]);
  });

  it.each(CATEGORIAS)("acepta la categoría %s", async (categoria) => {
    const r = await agregar(admin, { palabra: nueva("cat"), categoria });
    expect(r.status, r.text).toBe(201);
  });

  it("CA-7 · la misma palabra otra vez: 409 palabra_existente y no se guarda ni se audita nada; tampoco con otra grafía (mayúsculas, tildes)", async () => {
    const palabra = nueva("dup");
    expect((await agregar(admin, { palabra, categoria: "juguetes" })).status).toBe(201);
    const antes = await v.fotoGastos(E.tenantId);
    for (const grafia of [palabra, palabra.toUpperCase(), `${palabra.slice(0, -1)}${palabra.slice(-1).toUpperCase()}`]) {
      const r = await agregar(admin, { palabra: grafia, categoria: "entretenimiento" });
      expect(r.status, r.text).toBe(409);
      expect(r.body).toEqual({ codigo: "palabra_existente" });
    }
    expect(await v.fotoGastos(E.tenantId)).toEqual(antes);
  });

  it("una propia con el texto de una global es válida: la reemplaza para el estudio (R-4)", async () => {
    const r = await agregar(admin, { palabra: "zapatilla", categoria: "entretenimiento" });
    expect(r.status, r.text).toBe(201);
    const vista = await leer(admin);
    expect(propiaDe(vista.body, "zapatilla")).toMatchObject({ categoria: "entretenimiento", origen: "manual" });
    expect(globalDe(vista.body, "zapatilla")).toBeDefined(); // la global sigue en la lista; la propia manda en la evaluación
  });

  it("CA-7 · es del estudio: la misma palabra en otro estudio es otra palabra (201), y no aparece en el primero", async () => {
    const palabra = nueva("aud");
    expect((await agregar(admin, { palabra, categoria: "entretenimiento" })).status).toBe(201);
    const enF = await agregar(F.titular, { palabra, categoria: "juguetes" });
    expect(enF.status, enF.text).toBe(201);
    expect((await v.propiasBd(F.tenantId)).find((p) => p.palabra === palabra)).toMatchObject({ categoria: "juguetes", creado_por: F.titular.id });
    expect((await v.propiasBd(E.tenantId)).find((p) => p.palabra === palabra)).toMatchObject({ categoria: "entretenimiento", creado_por: admin.id });
  });

  it.each([
    ["con espacios", { palabra: "dos palabras", categoria: "juguetes" }],
    ["de 2 letras", { palabra: "ab", categoria: "juguetes" }],
    ["de 41 letras", { palabra: "a".repeat(41), categoria: "juguetes" }],
    ["con guion", { palabra: "polo-azul", categoria: "juguetes" }],
    ["con etiqueta", { palabra: "<script>", categoria: "juguetes" }],
    ["vacía", { palabra: "", categoria: "juguetes" }],
    ["número", { palabra: 12345, categoria: "juguetes" }],
    ["sin categoría", { palabra: "algo1" }],
    ["categoría fuera de las 6", { palabra: "algo2", categoria: "personal" }],
    ["categoría con mayúscula", { palabra: "algo3", categoria: "Juguetes" }],
    ["6 excepciones", { palabra: "algo4", categoria: "juguetes", excepciones: ["a1", "b2", "c3", "d4", "e5", "f6"] }],
    ["una excepción de 4 palabras", { palabra: "algo5", categoria: "juguetes", excepciones: ["punta de acero fino"] }],
    ["excepciones nulas", { palabra: "algo6", categoria: "juguetes", excepciones: null }],
    ["tenantId (el estudio sale de la sesión)", { palabra: "algo7", categoria: "juguetes", tenantId: "x" }],
    ["usuarioId", { palabra: "algo8", categoria: "juguetes", usuarioId: "x" }],
    ["origen", { palabra: "algo9", categoria: "juguetes", origen: "aprendida" }],
    ["activa y versión", { palabra: "algoa", categoria: "juguetes", activa: true, version: 1 }],
    ["cuerpo vacío", {}],
    ["lista", [{ palabra: "algob", categoria: "juguetes" }]],
  ])("400 solicitud_invalida y no se guarda nada: %s", async (_n, cuerpo) => {
    const antes = await v.fotoGastos(E.tenantId);
    const r = await agregar(admin, cuerpo);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual(SOLICITUD_INVALIDA);
    expect(await v.fotoGastos(E.tenantId)).toEqual(antes);
  });

  it("sin cuerpo: 400 y no se guarda nada", async () => {
    const antes = await v.fotoGastos(E.tenantId);
    const r = await v.http(admin, "POST", rutaPalabras());
    expect(r.status, r.text).toBe(400);
    expect(await v.fotoGastos(E.tenantId)).toEqual(antes);
  });

  it("R-4 · el límite: con 1.999 activas entra la 2.000 y la siguiente es 409 limite_palabras; las inactivas no cuentan", async () => {
    await v.sembrarPropiasMasivas(G.tenantId, LIMITE_PROPIAS - 1, G.titular.id);
    await v.sembrarPropia(G.tenantId, { palabra: nueva("ina"), creadoPor: G.titular.id, activa: false });
    const ok = await agregar(G.titular, { palabra: nueva("ult"), categoria: "juguetes" });
    expect(ok.status, ok.text).toBe(201);
    const vista = await leer(G.titular);
    expect(vista.body.activasPropias).toBe(LIMITE_PROPIAS);
    const antes = await v.fotoGastos(G.tenantId);
    const r = await agregar(G.titular, { palabra: nueva("pas"), categoria: "juguetes" });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "limite_palabras" });
    expect(await v.fotoGastos(G.tenantId)).toEqual(antes);
  });

  it("R-4 · el límite es del estudio: otro estudio sigue agregando", async () => {
    const r = await agregar(F.titular, { palabra: nueva("otro"), categoria: "juguetes" });
    expect(r.status, r.text).toBe(201);
  });

  it("CA-14 · audita gnd.palabra_agregada con el usuario y {palabra, categoria, origen}, sin las excepciones ni nada más", async () => {
    const palabra = nueva("aud");
    const antes = (await v.auditoria027(E.tenantId)).filter((a) => a.accion === "gnd.palabra_agregada").length;
    const r = await agregar(admin, { palabra, categoria: "cuidado-personal", excepciones: ["frase uno"] });
    expect(r.status, r.text).toBe(201);
    const filas = (await v.auditoria027(E.tenantId)).filter((a) => a.accion === "gnd.palabra_agregada");
    expect(filas).toHaveLength(antes + 1);
    expect(filas.at(-1)).toMatchObject({
      actor_tipo: "usuario",
      usuario_id: admin.id,
      cliente_id: null,
      entidad: "gnd_palabra_estudio",
      entidad_id: r.body.id,
    });
    expect(filas.at(-1).datos).toEqual({ palabra, categoria: "cuidado-personal", origen: "manual" });
  });
});

describe("PUT …/palabras/:id (R-8, CA-7)", () => {
  const propia = async (o: { activa?: boolean; version?: number } = {}) => {
    const palabra = nueva("p");
    const id = await v.sembrarPropia(E.tenantId, { palabra, categoria: "juguetes", creadoPor: admin.id, ...o });
    return { id, palabra };
  };

  it("desactivar y reactivar: 200 {version} (+1) cada vez; la lista lo refleja y la BD queda con activa y versión", async () => {
    const { id, palabra } = await propia();
    const d = await estadoPalabra(admin, id, { activa: false, version: 1 });
    expect(d.status, d.text).toBe(200);
    expect(d.body).toEqual({ version: 2 });
    expect(d.headers["cache-control"]).toMatch(/no-store/);
    expect(propiaDe((await leer(lectura)).body, palabra)).toMatchObject({ activa: false, version: 2 });
    expect((await v.propiasBd(E.tenantId)).find((p) => p.id === id)).toMatchObject({ activa: false, version: 2 });
    const a = await estadoPalabra(admin, id, { activa: true, version: 2 });
    expect(a.status, a.text).toBe(200);
    expect(a.body).toEqual({ version: 3 });
    expect((await v.propiasBd(E.tenantId)).find((p) => p.id === id)).toMatchObject({ activa: true, version: 3 });
  });

  it("CA-14 · audita gnd.palabra_desactivada y gnd.palabra_reactivada con el usuario y {palabra, categoria, origen}", async () => {
    const { id, palabra } = await propia();
    const antes = (await v.auditoria027(E.tenantId)).length;
    expect((await estadoPalabra(admin, id, { activa: false, version: 1 })).status).toBe(200);
    expect((await estadoPalabra(contador, id, { activa: true, version: 2 })).status).toBe(403); // el contador no gestiona el diccionario
    expect((await estadoPalabra(E.titular, id, { activa: true, version: 2 })).status).toBe(200);
    const nuevas = (await v.auditoria027(E.tenantId)).slice(antes);
    expect(nuevas.map((a) => a.accion)).toEqual(["gnd.palabra_desactivada", "gnd.palabra_reactivada"]);
    expect(nuevas[0]).toMatchObject({ actor_tipo: "usuario", usuario_id: admin.id, entidad: "gnd_palabra_estudio", entidad_id: id });
    expect(nuevas[1]).toMatchObject({ actor_tipo: "usuario", usuario_id: E.titular.id, entidad_id: id });
    for (const a of nuevas) expect(a.datos).toEqual({ palabra, categoria: "juguetes", origen: "manual" });
  });

  it("una versión que no es la vigente: 409 version_cambiada y no cambia nada (ni versión futura ni vieja)", async () => {
    const { id } = await propia({ version: 3 });
    const antes = await v.fotoGastos(E.tenantId);
    for (const version of [1, 2, 4, 99]) {
      const r = await estadoPalabra(admin, id, { activa: false, version });
      expect(r.status, `versión ${version}: ${r.text}`).toBe(409);
      expect(r.body).toEqual({ codigo: "version_cambiada" });
    }
    expect(await v.fotoGastos(E.tenantId)).toEqual(antes);
  });

  it("dos desactivaciones con la misma versión a la vez: una gana (200) y la otra recibe 409 version_cambiada", async () => {
    const { id } = await propia();
    const [a, b] = await Promise.all([estadoPalabra(admin, id, { activa: false, version: 1 }), estadoPalabra(E.titular, id, { activa: false, version: 1 })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a, b].find((r) => r.status === 409)!.body).toEqual({ codigo: "version_cambiada" });
    expect((await v.propiasBd(E.tenantId)).find((p) => p.id === id)).toMatchObject({ activa: false, version: 2 });
  });

  it("R-4 · reactivar respeta el límite: con 1.999 activas se reactiva una (2.000) y la siguiente es 409 limite_palabras", async () => {
    await v.sembrarPropiasMasivas(H.tenantId, LIMITE_PROPIAS - 1, H.titular.id);
    const a = await v.sembrarPropia(H.tenantId, { palabra: nueva("ra"), creadoPor: H.titular.id, activa: false });
    const b = await v.sembrarPropia(H.tenantId, { palabra: nueva("rb"), creadoPor: H.titular.id, activa: false });
    const ok = await estadoPalabra(H.titular, a, { activa: true, version: 1 });
    expect(ok.status, ok.text).toBe(200);
    const antes = await v.fotoGastos(H.tenantId);
    const r = await estadoPalabra(H.titular, b, { activa: true, version: 1 });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "limite_palabras" });
    expect(await v.fotoGastos(H.tenantId)).toEqual(antes);
    // Desactivar nunca choca con el límite.
    expect((await estadoPalabra(H.titular, a, { activa: false, version: 2 })).status).toBe(200);
  });

  it("CA-7 · una palabra de otro estudio o inexistente: el mismo 404 no_encontrado, y la ajena no cambia", async () => {
    const ajena = await v.sembrarPropia(F.tenantId, { palabra: nueva("aje"), creadoPor: F.titular.id });
    const antesF = await v.fotoGastos(F.tenantId);
    const propiaE = await v.sembrarPropia(E.tenantId, { palabra: nueva("ctl"), creadoPor: admin.id });
    expect((await estadoPalabra(admin, propiaE, { activa: false, version: 1 })).status, "control: la palabra propia sí se cambia").toBe(200);
    const antesE = await v.fotoGastos(E.tenantId); // después de la escritura de control: lo que no debe cambiar es lo que sigue
    const referencia = await estadoPalabra(admin, inexistente(), { activa: false, version: 1 });
    expect(referencia.status, referencia.text).toBe(404);
    expect(referencia.body).toEqual(NO_ENCONTRADO);
    const r = await estadoPalabra(admin, ajena, { activa: false, version: 1 });
    expect(r.status, r.text).toBe(404);
    expect(r.text).toBe(referencia.text);
    expect(await v.fotoGastos(F.tenantId)).toEqual(antesF);
    expect(await v.fotoGastos(E.tenantId)).toEqual(antesE);
  });

  it.each([
    ["sin versión", { activa: false }],
    ["sin activa", { version: 1 }],
    ["activa como cadena", { activa: "false", version: 1 }],
    ["versión 0", { activa: false, version: 0 }],
    ["versión decimal", { activa: false, version: 1.5 }],
    ["versión como cadena", { activa: false, version: "1" }],
    ["clave extra palabra", { activa: false, version: 1, palabra: "otra" }],
    ["clave extra categoria", { activa: false, version: 1, categoria: "juguetes" }],
    ["cuerpo vacío", {}],
  ])("400 solicitud_invalida y no cambia nada: %s", async (_n, cuerpo) => {
    const { id } = await propia();
    const antes = await v.fotoGastos(E.tenantId);
    const r = await estadoPalabra(admin, id, cuerpo);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual(SOLICITUD_INVALIDA);
    expect(await v.fotoGastos(E.tenantId)).toEqual(antes);
  });

  it("un id que no es uuid: 404 o 400, nunca 500, y no cambia nada", async () => {
    const propiaE = await v.sembrarPropia(E.tenantId, { palabra: nueva("ctl"), creadoPor: admin.id });
    expect((await estadoPalabra(admin, propiaE, { activa: false, version: 1 })).status, "control: un uuid válido sí se cambia").toBe(200);
    const antes = await v.fotoGastos(E.tenantId);
    const r = await estadoPalabra(admin, "no-es-uuid", { activa: false, version: 1 });
    expect([400, 404], r.text).toContain(r.status);
    expect(await v.fotoGastos(E.tenantId)).toEqual(antes);
  });
});

describe("PUT …/globales/:id (RF-117, CA-7)", () => {
  it("el estudio desactiva «zapatilla» solo para él: 200 {}, la lista lo marca y otro estudio no lo ve; reactivar lo quita", async () => {
    const id = await v.idGlobal("zapatilla");
    const d = await estadoGlobal(admin, id, { activa: false });
    expect(d.status, d.text).toBe(200);
    expect(d.body).toEqual({});
    expect(d.headers["cache-control"]).toMatch(/no-store/);
    expect(await v.desactivadasBd(E.tenantId)).toEqual(["zapatilla"]);
    expect(await v.desactivadasBd(F.tenantId)).toEqual([]);
    expect(globalDe((await leer(lectura)).body, "zapatilla").desactivadaPorEstudio).toBe(true);
    expect(globalDe((await leer(F.titular)).body, "zapatilla").desactivadaPorEstudio).toBe(false);
    const a = await estadoGlobal(admin, id, { activa: true });
    expect(a.status, a.text).toBe(200);
    expect(await v.desactivadasBd(E.tenantId)).toEqual([]);
    expect(globalDe((await leer(lectura)).body, "zapatilla").desactivadaPorEstudio).toBe(false);
  });

  it("CA-14 · audita gnd.global_desactivada y gnd.global_reactivada con el usuario y {palabra, categoria} de la global", async () => {
    const id = await v.idGlobal("polo");
    const antes = (await v.auditoria027(E.tenantId)).length;
    expect((await estadoGlobal(admin, id, { activa: false })).status).toBe(200);
    expect((await estadoGlobal(E.titular, id, { activa: true })).status).toBe(200);
    const nuevas = (await v.auditoria027(E.tenantId)).slice(antes);
    expect(nuevas.map((a) => a.accion)).toEqual(["gnd.global_desactivada", "gnd.global_reactivada"]);
    expect(nuevas[0]).toMatchObject({ actor_tipo: "usuario", usuario_id: admin.id, cliente_id: null, entidad: "gnd_palabra_global", entidad_id: id });
    expect(nuevas[1]).toMatchObject({ usuario_id: E.titular.id, entidad_id: id });
    for (const a of nuevas) expect(a.datos).toEqual({ palabra: "polo", categoria: "calzado-ropa" });
  });

  it("una global inexistente, una propia (no es global) o una desactivada por la plataforma: 404 no_encontrado y no cambia nada", async () => {
    const propia = await v.sembrarPropia(E.tenantId, { palabra: nueva("pro"), creadoPor: admin.id });
    const inactiva = await v.sembrarGlobal({ activa: false });
    expect((await estadoGlobal(admin, await v.idGlobal("zapato"), { activa: true })).status, "control: una global activa sí se cambia").toBe(200);
    const antes = await v.fotoGastos(E.tenantId);
    for (const id of [inexistente(), propia, inactiva.id]) {
      const r = await estadoGlobal(admin, id, { activa: false });
      expect(r.status, `${id}: ${r.text}`).toBe(404);
      expect(r.body).toEqual(NO_ENCONTRADO);
    }
    expect(await v.fotoGastos(E.tenantId)).toEqual(antes);
  });

  it("una global desactivada por la plataforma ya no figura en la lista del estudio", async () => {
    const g = await v.sembrarGlobal({ activa: true });
    const inactiva = await v.sembrarGlobal({ activa: false });
    const vista = await leer(lectura);
    expect(globalDe(vista.body, g.palabra)).toMatchObject({ id: g.id });
    expect(globalDe(vista.body, inactiva.palabra)).toBeUndefined();
  });

  it.each([
    ["sin activa", {}],
    ["activa como cadena", { activa: "false" }],
    ["activa nula", { activa: null }],
    ["con versión (la desactivación del estudio no versiona)", { activa: false, version: 1 }],
    ["clave extra", { activa: false, estudio: "x" }],
  ])("400 solicitud_invalida y no cambia nada: %s", async (_n, cuerpo) => {
    const id = await v.idGlobal("zapato");
    const antes = await v.fotoGastos(E.tenantId);
    const r = await estadoGlobal(admin, id, cuerpo);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual(SOLICITUD_INVALIDA);
    expect(await v.fotoGastos(E.tenantId)).toEqual(antes);
  });
});

describe("PUT …/umbral (R-11, U-6, CA-10, CA-14)", () => {
  beforeAll(async () => {
    await borrarConfig(E.tenantId, F.tenantId);
  });

  it("CA-10 · sube el umbral a 9: 200 {version: 1}, la lista lo muestra y la BD guarda umbral y versión; otro estudio no cambia", async () => {
    const r = await fijarUmbral(admin, { umbral: 9, version: 0 });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ version: 1 });
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(await v.configBd(E.tenantId)).toEqual([{ umbral: 9, version: 1 }]);
    expect(await v.configBd(F.tenantId)).toEqual([]);
    expect((await leer(lectura)).body).toMatchObject({ umbral: 9, versionUmbral: 1 });
    expect((await leer(F.titular)).body).toMatchObject({ umbral: UMBRAL_POR_DEFECTO, versionUmbral: 0 });
  });

  it("CA-14 · audita gnd.umbral_cambiado con el usuario y {antes, despues} (números; 3 si no había fila)", async () => {
    await borrarConfig(E.tenantId);
    const antes = (await v.auditoria027(E.tenantId)).length;
    expect((await fijarUmbral(admin, { umbral: 5, version: 0 })).status).toBe(200);
    expect((await fijarUmbral(E.titular, { umbral: 9, version: 1 })).status).toBe(200);
    const nuevas = (await v.auditoria027(E.tenantId)).slice(antes);
    expect(nuevas.map((a) => a.accion)).toEqual(["gnd.umbral_cambiado", "gnd.umbral_cambiado"]);
    expect(nuevas[0]).toMatchObject({ actor_tipo: "usuario", usuario_id: admin.id, cliente_id: null, entidad: "gnd_config" });
    expect(nuevas[0].datos).toEqual({ antes: 3, despues: 5 });
    expect(nuevas[1]).toMatchObject({ usuario_id: E.titular.id });
    expect(nuevas[1].datos).toEqual({ antes: 5, despues: 9 });
  });

  it.each([1, 3, 20])("acepta el umbral %j (los bordes y el valor por defecto)", async (umbral) => {
    const version = (await v.configBd(E.tenantId))[0]?.version ?? 0;
    const r = await fijarUmbral(admin, { umbral, version });
    expect(r.status, r.text).toBe(200);
    expect((await v.configBd(E.tenantId))[0].umbral).toBe(umbral);
  });

  it.each([
    ["0", 0],
    ["21", 21],
    ["-1", -1],
    ["3.5 (decimal)", 3.5],
    ["«3» como cadena", "3"],
    ["nulo", null],
  ])("CA-10 · el umbral %s: 400 solicitud_invalida y no cambia nada", async (_n, umbral) => {
    const antes = await v.fotoGastos(E.tenantId);
    const version = (await v.configBd(E.tenantId))[0]?.version ?? 0;
    const r = await fijarUmbral(admin, { umbral, version });
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual(SOLICITUD_INVALIDA);
    expect(await v.fotoGastos(E.tenantId)).toEqual(antes);
  });

  it.each([
    ["sin versión", { umbral: 4 }],
    ["sin umbral", { version: 0 }],
    ["versión negativa", { umbral: 4, version: -1 }],
    ["versión decimal", { umbral: 4, version: 0.5 }],
    ["clave extra tenantId", { umbral: 4, version: 0, tenantId: "x" }],
    ["cuerpo vacío", {}],
  ])("400 solicitud_invalida y no cambia nada: %s", async (_n, cuerpo) => {
    const antes = await v.fotoGastos(E.tenantId);
    const r = await fijarUmbral(admin, cuerpo);
    expect(r.status, r.text).toBe(400);
    expect(await v.fotoGastos(E.tenantId)).toEqual(antes);
  });

  it("CA-10 · una versión vieja o futura: 409 version_cambiada y no cambia nada; sin fila solo vale la versión 0", async () => {
    await borrarConfig(F.tenantId);
    const antes = await v.fotoGastos(F.tenantId);
    for (const version of [1, 2, 7]) {
      const r = await fijarUmbral(F.titular, { umbral: 6, version });
      expect(r.status, `sin fila, versión ${version}: ${r.text}`).toBe(409);
      expect(r.body).toEqual({ codigo: "version_cambiada" });
    }
    expect(await v.fotoGastos(F.tenantId)).toEqual(antes);
    expect((await fijarUmbral(F.titular, { umbral: 6, version: 0 })).status).toBe(200);
    const vieja = await fijarUmbral(F.titular, { umbral: 8, version: 0 });
    expect(vieja.status, vieja.text).toBe(409);
    expect(vieja.body).toEqual({ codigo: "version_cambiada" });
    expect(await v.configBd(F.tenantId)).toEqual([{ umbral: 6, version: 1 }]);
  });
});

describe("el diccionario no guarda glosas ni secretos (CA-11, CA-14)", () => {
  it("la auditoría de 027 del estudio solo lleva acciones del catálogo y claves de palabra, categoría, origen, antes y después", async () => {
    const filas = await v.auditoria027(E.tenantId);
    expect(filas.length).toBeGreaterThan(0);
    for (const f of filas) {
      expect(ACCIONES_027, f.accion).toContain(f.accion);
      for (const clave of Object.keys(f.datos)) expect(["palabra", "categoria", "origen", "antes", "despues"], `${f.accion}.${clave}`).toContain(clave);
    }
  });
});
