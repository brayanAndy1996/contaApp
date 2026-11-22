/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 027 (T6, rojo): diccionario global del super-admin por HTTP (RF-117, U-2, U-13, R-6; D-2, D-4; CA-7, CA-14).
// Contrato (plan 027, «Contratos: HTTP» y `@contapp/shared`: `diccionarioGlobalVistaSchema`, `historialGlobalVistaSchema`, `palabraGlobalSchema`,
// `editarGlobalSchema`; funciones `auth.gnd_global_*` de 0070):
//  - Las cuatro rutas son de plataforma (`@SinEstudio`, `@SoloPlataforma`): solo el super-admin con sesión viva y alta en `admin_plataforma`
//    (revalidada en cada llamada); un usuario de estudio (con o sin `X-Estudio`) o sin estudio recibe 403 `permiso_denegado`; sin sesión 401.
//  - `GET /plataforma/diccionario` -> 200 `{palabras: [{id, palabra, categoria, excepciones, activa, version, actualizadaEn}]}` (todas, también las
//    inactivas, por categoría y palabra).
//  - `POST /plataforma/diccionario {palabra, categoria, excepciones?}` -> 201 con la palabra creada (la misma forma de cada ítem de la lista:
//    `id`, `palabra` normalizada, `categoria`, `excepciones`, `activa: true`, `version: 1`, `actualizadaEn`); repetida 409 `palabra_existente`.
//  - `PUT /plataforma/diccionario/:id {categoria, excepciones, activa, version}` -> 200 con la palabra (versión + 1); versión vieja 409
//    `version_cambiada`; id inexistente 404 `no_encontrado`. La palabra no se renombra ni se borra.
//  - `GET /plataforma/diccionario/historial?limite=&antes=` -> 200 `{items, siguiente}` más recientes primero, con la acción (`agregada` o
//    `editada`), `antes` (null al agregar) y `despues`, el autor y la fecha; `siguiente` (ISO) continúa la lista con `antes=`; `limite` 1..200.
//  - Cada escritura deja su fila en el historial global (la auditoría de 017 es por estudio y no la usa) y rige para todos los estudios en su
//    siguiente evaluación (R-8): se ve en la lista de «Gastos no deducibles» de cualquier estudio.
// Rojo: las rutas aún no existen (T12): responden 404 de ruta inexistente.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { forma } from "../../../test/soporte.js";
import {
  abrirBancoGastos,
  CATEGORIAS,
  cumple,
  inexistente,
  NO_ENCONTRADO,
  RUTA_GASTOS,
  RUTA_PLATAFORMA,
  rutaPlataformaHistorial,
  rutaPlataformaPalabra,
  SOLICITUD_INVALIDA,
  type BancoGastos,
  type Estudio,
  type SuperAdmin,
} from "../../../test/soporte-gastos.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let v: BancoGastos;
let admin: SuperAdmin;
let E: Estudio;
beforeAll(async () => {
  v = await abrirBancoGastos();
  admin = await v.superAdmin();
  E = await v.estudio();
});
afterAll(async () => {
  await v?.cerrar();
});

const plat = (metodo: "GET" | "POST" | "PUT", ruta: string, cuerpo?: unknown, a: { cookie: string; csrf: string } = admin) => v.plataforma(a, metodo, ruta, cuerpo);
const listar = async () => {
  const r = await plat("GET", RUTA_PLATAFORMA);
  expect(r.status, r.text).toBe(200);
  return r;
};
const agregar = (cuerpo: unknown) => plat("POST", RUTA_PLATAFORMA, cuerpo);
const editar = (id: string, cuerpo: unknown) => plat("PUT", rutaPlataformaPalabra(id), cuerpo);
const historial = (consulta = "") => plat("GET", rutaPlataformaHistorial(consulta));
const enLista = (r: any, palabra: string) => (r.body.palabras as any[]).find((p) => p.palabra === palabra);
const CLAVES_PALABRA = ["activa", "actualizadaEn", "categoria", "excepciones", "id", "palabra", "version"];
/** Palabra global nueva (la limpieza la borra con su historial). */
const nueva = (): string => v.palabraGlobalNueva();
/** Crea una palabra global por la API y devuelve su fila. */
async function crear(o: { categoria?: string; excepciones?: string[] } = {}) {
  const palabra = nueva();
  const r = await agregar({ palabra, categoria: o.categoria ?? "entretenimiento", ...(o.excepciones ? { excepciones: o.excepciones } : {}) });
  expect(r.status, r.text).toBe(201);
  return { palabra, fila: r.body };
}

const RUTAS: ReadonlyArray<readonly [string, "GET" | "POST" | "PUT", string, unknown]> = [
  ["listar", "GET", RUTA_PLATAFORMA, undefined],
  ["agregar", "POST", RUTA_PLATAFORMA, { palabra: "zqnoentra", categoria: "juguetes" }],
  ["editar", "PUT", rutaPlataformaPalabra(randomUUID()), { categoria: "juguetes", excepciones: [], activa: true, version: 1 }],
  ["historial", "GET", rutaPlataformaHistorial(), undefined],
];

describe("acceso · solo el super-admin entra (CA-7, R-6)", () => {
  it.each(RUTAS)("%s: un Dueño de estudio (con y sin X-Estudio) y un usuario sin estudio reciben el mismo 403 permiso_denegado y no se escribe nada", async (_n, metodo, ruta, cuerpo) => {
    const sinEstudio = await v.b.c.p.b.h.crearUsuario({ estudios: [] });
    const s = await v.b.c.p.b.h.entrar(sinEstudio);
    const antes = (await v.b.sql("select count(*)::int n from gnd_palabra_global").catch(() => [{ n: 0 }]))[0].n;
    const rs = [
      await v.http(E.titular, metodo, ruta, cuerpo), // con X-Estudio propio
      await plat(metodo, ruta, cuerpo, E.titular), // sin X-Estudio
      await plat(metodo, ruta, cuerpo, s),
    ];
    for (const r of rs) {
      expect(r.status, `${metodo} ${ruta}: ${JSON.stringify(r.body)}`).toBe(403);
      expect(r.body).toEqual({ codigo: "permiso_denegado" });
      expect(r.text).not.toMatch(/zapatilla|precio|argon/i);
    }
    expect(forma(rs[1]!)).toEqual(forma(rs[2]!));
    const despues = (await v.b.sql("select count(*)::int n from gnd_palabra_global").catch(() => [{ n: 0 }]))[0].n;
    expect(despues).toBe(antes);
  });

  it.each(RUTAS)("%s: sin sesión 401, y con CSRF u Origen ajeno no pasa", async (_n, metodo, ruta, cuerpo) => {
    const anon = await v.b.c.p.b.h.pedir({ metodo, ruta, cuerpo });
    expect(anon.status).toBe(401);
    if (metodo !== "GET") {
      const sinCsrf = await v.b.c.p.b.h.pedir({ metodo, ruta, cuerpo, cookie: admin.cookie });
      expect(sinCsrf.status).toBe(403);
      const origen = await v.b.c.p.como(admin, metodo, ruta, cuerpo, { origen: "https://evil.example" });
      expect(origen.status).toBe(403);
    }
  });

  it("el alta en admin_plataforma se revalida en cada llamada: sin alta, el mismo cookie recibe 403 en las cuatro rutas (y con alta, 200)", async () => {
    const otro = await v.superAdmin();
    expect((await plat("GET", RUTA_PLATAFORMA, undefined, otro)).status).toBe(200);
    await v.b.sql("delete from admin_plataforma where usuario_id = $1", [otro.id]);
    for (const [, metodo, ruta, cuerpo] of RUTAS) {
      const r = await plat(metodo, ruta, cuerpo, otro);
      expect(r.status, `${metodo} ${ruta}`).toBe(403);
    }
    await v.b.sql("insert into admin_plataforma (usuario_id) values ($1)", [otro.id]);
    expect((await plat("GET", RUTA_PLATAFORMA, undefined, otro)).status).toBe(200);
  });
});

describe("GET /plataforma/diccionario (RF-117)", () => {
  it("200 con la forma de diccionarioGlobalVistaSchema y la semilla de 0069 (las seis categorías), sin caché", async () => {
    const r = await listar();
    expect(r.status, r.text).toBe(200);
    expect(cumple("diccionarioGlobalVistaSchema", r.body), r.text).toBe(true);
    expect(Object.keys(r.body)).toEqual(["palabras"]);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(enLista(r, "zapatilla")).toMatchObject({ categoria: "calzado-ropa", activa: true });
    expect(enLista(r, "zapatilla").excepciones).toEqual(expect.arrayContaining(["seguridad", "punta de acero"]));
    expect(enLista(r, "polo").excepciones).toEqual(["a tierra"]);
    expect(new Set((r.body.palabras as any[]).map((p) => p.categoria))).toEqual(new Set(CATEGORIAS));
    for (const p of r.body.palabras as any[]) expect(Object.keys(p).sort()).toEqual(CLAVES_PALABRA);
  });

  it("incluye las inactivas (el super-admin las puede reactivar)", async () => {
    const g = await v.sembrarGlobal({ activa: false });
    const r = await listar();
    expect(enLista(r, g.palabra)).toMatchObject({ id: g.id, activa: false });
  });

  it("no mezcla datos de estudios: ninguna palabra propia ni el nombre de un estudio aparece", async () => {
    const propia = `zqprop${Date.now().toString(36)}`;
    await v.sembrarPropia(E.tenantId, { palabra: propia, creadoPor: E.titular.id });
    const r = await listar();
    expect(r.text).not.toContain(propia);
    expect(r.text).not.toContain(E.tenantId);
  });
});

describe("POST /plataforma/diccionario (RF-117, U-2)", () => {
  it("201 con la palabra creada (activa, versión 1, normalizada) y deja su fila `agregada` en el historial con el autor y antes null", async () => {
    const palabra = nueva();
    const r = await agregar({ palabra: palabra.toUpperCase(), categoria: "cuidado-personal", excepciones: ["PUNTA de acero"] });
    expect(r.status, r.text).toBe(201);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(Object.keys(r.body).sort()).toEqual(CLAVES_PALABRA);
    expect(r.body).toMatchObject({ palabra, categoria: "cuidado-personal", excepciones: ["punta de acero"], activa: true, version: 1 });
    expect(typeof r.body.id).toBe("string");
    expect(await v.globalBd(palabra)).toMatchObject({ id: r.body.id, categoria: "cuidado-personal", excepciones: ["punta de acero"], activa: true, version: 1 });
    const h = await v.historialGlobalBd(palabra);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ accion: "agregada", antes: null, usuario_id: admin.id });
    expect(h[0].despues).toMatchObject({ categoria: "cuidado-personal", excepciones: ["punta de acero"], activa: true });
  });

  it.each(CATEGORIAS)("acepta la categoría %s", async (categoria) => {
    const r = await agregar({ palabra: nueva(), categoria });
    expect(r.status, r.text).toBe(201);
  });

  it("rige para todos los estudios: la lista de «Gastos no deducibles» de un estudio la trae con su id, categoría y excepciones (R-8)", async () => {
    const { palabra, fila } = await crear({ categoria: "juguetes", excepciones: ["de lujo"] });
    const vista = await v.http(E.titular, "GET", RUTA_GASTOS);
    expect(vista.status, vista.text).toBe(200);
    expect((vista.body.globales as any[]).find((g) => g.palabra === palabra)).toMatchObject({ id: fila.id, categoria: "juguetes", excepciones: ["de lujo"], desactivadaPorEstudio: false });
  });

  it("una palabra que ya existe (también con otra grafía): 409 palabra_existente, sin cambios y sin historial nuevo", async () => {
    const { palabra } = await crear();
    for (const grafia of [palabra, palabra.toUpperCase()]) {
      const r = await agregar({ palabra: grafia, categoria: "juguetes" });
      expect(r.status, r.text).toBe(409);
      expect(r.body).toEqual({ codigo: "palabra_existente" });
    }
    expect((await v.historialGlobalBd(palabra)).length).toBe(1);
    const semilla = await agregar({ palabra: "zapatilla", categoria: "juguetes" });
    expect(semilla.status, semilla.text).toBe(409);
    expect(semilla.body).toEqual({ codigo: "palabra_existente" });
  });

  it.each([
    ["con espacios", { palabra: "dos palabras", categoria: "juguetes" }],
    ["de 2 letras", { palabra: "ab", categoria: "juguetes" }],
    ["de 41 letras", { palabra: "a".repeat(41), categoria: "juguetes" }],
    ["con etiqueta", { palabra: "<script>", categoria: "juguetes" }],
    ["sin categoría", { palabra: "zqsincat" }],
    ["categoría fuera de las 6", { palabra: "zqfuera", categoria: "personal" }],
    ["6 excepciones", { palabra: "zqseis", categoria: "juguetes", excepciones: ["a1", "b2", "c3", "d4", "e5", "f6"] }],
    ["una excepción de 4 palabras", { palabra: "zqcuatro", categoria: "juguetes", excepciones: ["una dos tres cuatro"] }],
    ["activa y versión (las pone el sistema)", { palabra: "zqextra", categoria: "juguetes", activa: false, version: 5 }],
    ["cuerpo vacío", {}],
  ])("400 solicitud_invalida y no se crea nada: %s", async (_n, cuerpo) => {
    const antes = (await listar()).body.palabras.length;
    const r = await agregar(cuerpo);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual(SOLICITUD_INVALIDA);
    expect((await listar()).body.palabras.length).toBe(antes);
  });

  it("D-4 · el cambio del super-admin queda en el historial global, no en la auditoría de ningún estudio", async () => {
    await crear();
    const f = await v.b.sql("select count(*)::int n from auditoria where usuario_id = $1", [admin.id]);
    expect(f[0].n).toBe(0);
  });
});

describe("PUT /plataforma/diccionario/:id (RF-117, U-2)", () => {
  it("edita categoría y excepciones: 200 con la palabra (versión + 1); la palabra no cambia; el historial guarda antes y después con el autor", async () => {
    const { palabra, fila } = await crear({ categoria: "juguetes", excepciones: ["viejo"] });
    const r = await editar(fila.id, { categoria: "entretenimiento", excepciones: ["nuevo uno", "nuevo dos"], activa: true, version: 1 });
    expect(r.status, r.text).toBe(200);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(Object.keys(r.body).sort()).toEqual(CLAVES_PALABRA);
    expect(r.body).toMatchObject({ id: fila.id, palabra, categoria: "entretenimiento", excepciones: ["nuevo uno", "nuevo dos"], activa: true, version: 2 });
    expect(await v.globalBd(palabra)).toMatchObject({ categoria: "entretenimiento", excepciones: ["nuevo uno", "nuevo dos"], version: 2 });
    const h = await v.historialGlobalBd(palabra);
    expect(h.map((x) => x.accion)).toEqual(["agregada", "editada"]);
    expect(h[1]).toMatchObject({ usuario_id: admin.id });
    expect(h[1].antes).toMatchObject({ categoria: "juguetes", excepciones: ["viejo"], activa: true });
    expect(h[1].despues).toMatchObject({ categoria: "entretenimiento", excepciones: ["nuevo uno", "nuevo dos"], activa: true });
  });

  it("desactivar y reactivar: 200 cada vez; una global desactivada sale de la lista de los estudios y al reactivarla vuelve (R-8)", async () => {
    const { palabra, fila } = await crear();
    const d = await editar(fila.id, { categoria: "entretenimiento", excepciones: [], activa: false, version: 1 });
    expect(d.status, d.text).toBe(200);
    expect(d.body).toMatchObject({ activa: false, version: 2 });
    const sin = await v.http(E.titular, "GET", RUTA_GASTOS);
    expect((sin.body.globales as any[]).find((g) => g.palabra === palabra)).toBeUndefined();
    expect(enLista(await listar(), palabra)).toMatchObject({ activa: false }); // el super-admin sí la ve
    const a = await editar(fila.id, { categoria: "entretenimiento", excepciones: [], activa: true, version: 2 });
    expect(a.status, a.text).toBe(200);
    expect(a.body).toMatchObject({ activa: true, version: 3 });
    const con = await v.http(E.titular, "GET", RUTA_GASTOS);
    expect((con.body.globales as any[]).find((g) => g.palabra === palabra)).toBeDefined();
    expect((await v.historialGlobalBd(palabra)).map((x) => x.accion)).toEqual(["agregada", "editada", "editada"]);
  });

  it("una versión vieja o futura: 409 version_cambiada, sin cambios y sin historial nuevo", async () => {
    const { palabra, fila } = await crear();
    for (const version of [2, 5]) {
      const r = await editar(fila.id, { categoria: "juguetes", excepciones: [], activa: true, version });
      expect(r.status, `versión ${version}: ${r.text}`).toBe(409);
      expect(r.body).toEqual({ codigo: "version_cambiada" });
    }
    expect(await v.globalBd(palabra)).toMatchObject({ categoria: "entretenimiento", version: 1 });
    expect((await v.historialGlobalBd(palabra)).length).toBe(1);
  });

  it("dos ediciones con la misma versión a la vez: una gana (200) y la otra recibe 409 version_cambiada", async () => {
    const { fila } = await crear();
    const [a, b] = await Promise.all([
      editar(fila.id, { categoria: "juguetes", excepciones: [], activa: true, version: 1 }),
      editar(fila.id, { categoria: "cuidado-personal", excepciones: [], activa: true, version: 1 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a, b].find((r) => r.status === 409)!.body).toEqual({ codigo: "version_cambiada" });
  });

  it("un id inexistente: 404 no_encontrado", async () => {
    const { fila } = await crear();
    expect((await editar(fila.id, { categoria: "juguetes", excepciones: [], activa: true, version: 1 })).status, "control: una palabra existente sí se edita").toBe(200);
    const r = await editar(inexistente(), { categoria: "juguetes", excepciones: [], activa: true, version: 1 });
    expect(r.status, r.text).toBe(404);
    expect(r.body).toEqual(NO_ENCONTRADO);
  });

  it.each([
    ["sin versión", { categoria: "juguetes", excepciones: [], activa: true }],
    ["sin categoría", { excepciones: [], activa: true, version: 1 }],
    ["sin excepciones", { categoria: "juguetes", activa: true, version: 1 }],
    ["sin activa", { categoria: "juguetes", excepciones: [], version: 1 }],
    ["categoría fuera de las 6", { categoria: "personal", excepciones: [], activa: true, version: 1 }],
    ["versión 0", { categoria: "juguetes", excepciones: [], activa: true, version: 0 }],
    ["6 excepciones", { categoria: "juguetes", excepciones: ["a1", "b2", "c3", "d4", "e5", "f6"], activa: true, version: 1 }],
    ["la palabra (no se renombra)", { palabra: "otra", categoria: "juguetes", excepciones: [], activa: true, version: 1 }],
    ["cuerpo vacío", {}],
  ])("400 solicitud_invalida y no cambia nada: %s", async (_n, cuerpo) => {
    const { palabra, fila } = await crear();
    const r = await editar(fila.id, cuerpo);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual(SOLICITUD_INVALIDA);
    expect(await v.globalBd(palabra)).toMatchObject({ categoria: "entretenimiento", version: 1 });
  });
});

describe("GET /plataforma/diccionario/historial (D-4, CA-14)", () => {
  it("200 con la forma de historialGlobalVistaSchema: las más recientes primero, con acción, antes, después, autor (id y nombre) y fecha", async () => {
    const { palabra, fila } = await crear({ categoria: "juguetes" });
    expect((await editar(fila.id, { categoria: "entretenimiento", excepciones: [], activa: true, version: 1 })).status).toBe(200);
    const r = await historial("?limite=200");
    expect(r.status, r.text).toBe(200);
    expect(cumple("historialGlobalVistaSchema", r.body), r.text).toBe(true);
    expect(Object.keys(r.body).sort()).toEqual(["items", "siguiente"]);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    const propios = (r.body.items as any[]).filter((i) => i.palabra === palabra);
    expect(propios.map((i) => i.accion)).toEqual(["editada", "agregada"]);
    expect(propios[0]).toMatchObject({ palabraGlobalId: fila.id, autor: { id: admin.id, nombre: await v.nombreDe(admin.id) } });
    expect(propios[0].antes).toMatchObject({ categoria: "juguetes" });
    expect(propios[0].despues).toMatchObject({ categoria: "entretenimiento" });
    expect(propios[1].antes).toBeNull();
    const fechas = (r.body.items as any[]).map((i) => i.ocurridaEn);
    expect([...fechas].sort().reverse()).toEqual(fechas);
  });

  it("pagina por fecha: con limite=2 trae dos y `siguiente` continúa con `antes=` sin repetir ni saltar", async () => {
    const { fila } = await crear();
    for (const version of [1, 2, 3]) {
      expect((await editar(fila.id, { categoria: version % 2 ? "juguetes" : "entretenimiento", excepciones: [], activa: true, version })).status).toBe(200);
    }
    const p1 = await historial("?limite=2");
    expect(p1.status, p1.text).toBe(200);
    expect(p1.body.items).toHaveLength(2);
    expect(typeof p1.body.siguiente).toBe("string");
    const p2 = await historial(`?limite=2&antes=${encodeURIComponent(p1.body.siguiente)}`);
    expect(p2.status, p2.text).toBe(200);
    const ids1 = (p1.body.items as any[]).map((i) => i.id);
    for (const i of p2.body.items as any[]) expect(ids1).not.toContain(i.id);
    expect(p2.body.items.length).toBeGreaterThan(0);
    expect(new Date(p2.body.items[0].ocurridaEn).getTime()).toBeLessThanOrEqual(new Date(p1.body.siguiente).getTime());
  });

  it.each([
    ["limite 0", "?limite=0"],
    ["limite 201", "?limite=201"],
    ["limite decimal", "?limite=1.5"],
    ["limite con letras", "?limite=abc"],
    ["antes que no es fecha", "?antes=ayer"],
  ])("400 solicitud_invalida: %s", async (_n, consulta) => {
    const r = await historial(consulta);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual(SOLICITUD_INVALIDA);
  });

  it("no lleva datos de estudios (sin tenant_id): cada ítem solo tiene las columnas del historial global", async () => {
    await crear();
    await v.sembrarPropia(E.tenantId, { palabra: `zqhist${Date.now().toString(36)}`, creadoPor: E.titular.id });
    const r = await historial("?limite=200");
    expect(r.status, r.text).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    for (const i of r.body.items as any[]) expect(Object.keys(i).sort()).toEqual(["accion", "antes", "autor", "despues", "id", "ocurridaEn", "palabra", "palabraGlobalId"]);
    expect(r.text).not.toContain(E.tenantId);
  });
});
