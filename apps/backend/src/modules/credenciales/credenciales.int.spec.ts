/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 007b (T4, rojo): rutas de credenciales (D3 a D6; CA-4, CA-5 en su parte HTTP, CA-6 y CA-10).
// Contrato (plan: HTTP; errores `{codigo}` y `Cache-Control: no-store`; `:clienteId` con `ClienteScopeGuard`):
//  - PUT  /clientes/:id/credenciales/:tipo   `credenciales.editar` -> 200 `{tipo, estado}` · 400 `solicitud_invalida` ·
//    404 · 409 `cliente_archivado`. `sol` = `{usuario, clave}`; `sire_api` = `{clientId, clientSecret}`, 1-256 B UTF-8.
//  - GET  /clientes/:id/credenciales          `clientes.ver`        -> 200 `[{tipo, estado, fecha|null, motivo|null}]`
//    (los dos tipos; nunca el sobre ni el secreto).
//  - POST /clientes/:id/credenciales/:tipo/verificar `credenciales.editar` -> 202 `TrabajoVista` · 404 · 409
//    `cliente_archivado` | `credencial_no_configurada`. Encola `credencial.verificar_sol` (cola `sol`) o
//    `credencial.verificar_sire` (cola `sire`), prioridad `interactivo`; idempotente (dedupe por cliente).
// El backend cifra con `cifrarCredencial` (AAD tenant, cliente y tipo) y nunca descifra: aquí el sobre se abre con
// `abrirSobreMock` (solo `node:crypto` y el par de pruebas del fixture `mock`). El canario de cada clave no puede
// aparecer en cuerpos, cabeceras, logs, errores (400/403/404/409) ni en los bytes del sobre.
// Rojo: las rutas aún no existen (T10).
import { randomUUID } from "node:crypto";
import { trabajoVistaSchema } from "@contapp/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirBancoCola,
  abrirSobreMock,
  canario,
  filtrados,
  type Actor,
  type BancoCola,
  type Estudio,
} from "../../../test/soporte-credenciales.js";
import { capturarLogs, forma } from "../../../test/soporte.js";

let b: BancoCola;
let E: Estudio; // Dueño titular
let F: Estudio; // otro estudio
let admin: Actor;
let contador: Actor; // credenciales.editar, alcance asignado
let asistente: Actor;
let lectura: Actor;
let clienteContador: string; // asignado al contador

beforeAll(async () => {
  b = await abrirBancoCola();
  E = await b.estudio();
  F = await b.estudio();
  const p = b.c.p.b;
  admin = await p.miembro(E.tenantId, "admin");
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
  lectura = await p.miembro(E.tenantId, "lectura");
  clienteContador = (await b.c.sembrar(E.tenantId, { responsable: contador.id })).id;
});
afterAll(async () => {
  await b?.cerrar();
});

const llamar = (a: Actor, m: "GET" | "POST" | "PUT", ruta: string, cuerpo?: unknown) => b.c.p.b.llamar(a, m, ruta, cuerpo);
const guardar = (a: Actor, clienteId: string, tipo: string, cuerpo: unknown) =>
  llamar(a, "PUT", `/clientes/${clienteId}/credenciales/${tipo}`, cuerpo);
const estado = (a: Actor, clienteId: string) => llamar(a, "GET", `/clientes/${clienteId}/credenciales`);
const verificar = (a: Actor, clienteId: string, tipo: string) =>
  llamar(a, "POST", `/clientes/${clienteId}/credenciales/${tipo}/verificar`);
const cliente = async (t: Estudio = E, o: Parameters<typeof b.c.sembrar>[1] = {}) => (await b.c.sembrar(t.tenantId, o)).id;
const porTipo = (r: any[]) => Object.fromEntries(r.map((x) => [x.tipo, x]));
const filas = (clienteId: string) => b.credenciales(clienteId);
const trabajosDe = (clienteId: string) =>
  b.sql("select * from job_registro where cliente_id = $1 and tipo like 'credencial.%' order by creado_en", [clienteId]);

const SOL = (u: string, k: string) => ({ usuario: u, clave: k });
const SIRE = (i: string, s: string) => ({ clientId: i, clientSecret: s });

describe("CA-4 · guardar es de solo escritura: responde solo {tipo, estado} y nada del secreto sale ni queda a la vista", () => {
  it("sol: 200 {tipo, estado: configurada}, no-store, el canario no está en cuerpo, cabeceras ni logs", async () => {
    const cl = await cliente();
    const u = canario("usuario");
    const k = canario("clave");
    const { resultado: r, logs } = await capturarLogs(() => guardar(E.titular, cl, "sol", SOL(u, k)));
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ tipo: "sol", estado: "configurada" });
    expect(Object.keys(r.body).sort()).toEqual(["estado", "tipo"]);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(filtrados([u, k], r.text, r.body, r.headers, logs)).toEqual([]);
  });

  it("sire_api: 200 {tipo, estado: configurada} y el canario no está en cuerpo, cabeceras ni logs", async () => {
    const cl = await cliente();
    const i = canario("client-id");
    const s = canario("client-secret");
    const { resultado: r, logs } = await capturarLogs(() => guardar(E.titular, cl, "sire_api", SIRE(i, s)));
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ tipo: "sire_api", estado: "configurada" });
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(filtrados([i, s], r.text, r.body, r.headers, logs)).toEqual([]);
  });

  it("queda una fila por (cliente, tipo) con el sobre del mock; el canario no está en sus bytes ni en la fila", async () => {
    const cl = await cliente();
    const u = canario("usuario");
    const k = canario("clave");
    expect((await guardar(E.titular, cl, "sol", SOL(u, k))).status).toBe(200);
    const f = await filas(cl);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ tenant_id: E.tenantId, cliente_id: cl, tipo: "sol", estado: "configurada", kek_id: "mock" });
    expect(f[0].nonce).toHaveLength(12);
    expect(f[0].tag).toHaveLength(16);
    for (const campo of ["ciphertext", "nonce", "tag", "dek_envuelta"]) {
      expect((f[0][campo] as Buffer).includes(u), campo).toBe(false);
      expect((f[0][campo] as Buffer).includes(k), campo).toBe(false);
    }
    expect(filtrados([u, k], JSON.stringify({ ...f[0], ciphertext: f[0].ciphertext.toString("latin1") }))).toEqual([]);
  });

  it("el sobre lleva la AAD de tenant, cliente y tipo: abre con la suya y no con otro cliente, otro estudio u otro tipo", async () => {
    const cl = await cliente();
    const u = canario("usuario");
    const k = canario("clave");
    expect((await guardar(E.titular, cl, "sol", SOL(u, k))).status).toBe(200);
    const [f] = await filas(cl);
    expect(abrirSobreMock(f, { tenantId: E.tenantId, clienteId: cl, tipo: "sol" })).toEqual({ usuario: u, clave: k });
    expect(abrirSobreMock(f, { tenantId: E.tenantId, clienteId: randomUUID(), tipo: "sol" })).toBeNull();
    expect(abrirSobreMock(f, { tenantId: F.tenantId, clienteId: cl, tipo: "sol" })).toBeNull();
    expect(abrirSobreMock(f, { tenantId: E.tenantId, clienteId: cl, tipo: "sire_api" })).toBeNull();
  });

  it("la fila copiada a otro cliente del mismo estudio (o a otro tipo) no se descifra: la AAD no coincide", async () => {
    const origen = await cliente();
    const otro = await cliente();
    const i = canario("client-id");
    const s = canario("client-secret");
    expect((await guardar(E.titular, origen, "sire_api", SIRE(i, s))).status).toBe(200);
    const [f] = await filas(origen);
    // La copia se inserta por SQL con la conexión de migraciones (lo que haría un atacante con acceso a la BD).
    await b.sql(
      `insert into credencial (tenant_id, cliente_id, tipo, ciphertext, nonce, tag, dek_envuelta, kek_id, version)
       values ($1, $2, 'sire_api', $3, $4, $5, $6, $7, 1)`,
      [E.tenantId, otro, f.ciphertext, f.nonce, f.tag, f.dek_envuelta, f.kek_id],
    );
    const [copia] = await filas(otro);
    expect(abrirSobreMock(copia, { tenantId: E.tenantId, clienteId: otro, tipo: "sire_api" })).toBeNull();
    expect(abrirSobreMock(copia, { tenantId: E.tenantId, clienteId: origen, tipo: "sire_api" })).toEqual({
      clientId: i,
      clientSecret: s,
    });
  });

  it("la clave no se recorta ni se normaliza: lo que llega es lo que se cifra (espacios, Unicode, símbolos iniciales)", async () => {
    const cl = await cliente();
    const k = `  =${canario("clave")} ñ日本🔐 `;
    expect((await guardar(E.titular, cl, "sol", SOL("usuario-ñ", k))).status).toBe(200);
    const [f] = await filas(cl);
    expect(abrirSobreMock(f, { tenantId: E.tenantId, clienteId: cl, tipo: "sol" })).toEqual({ usuario: "usuario-ñ", clave: k });
  });

  it("claves desconocidas del cuerpo se descartan y el tenant sale de la sesión, no del cuerpo", async () => {
    const cl = await cliente();
    const u = canario("usuario");
    const k = canario("clave");
    const r = await guardar(E.titular, cl, "sol", { ...SOL(u, k), tenantId: F.tenantId, clienteId: randomUUID(), extra: "x" });
    expect(r.status, r.text).toBe(200);
    const [f] = await filas(cl);
    expect(f.tenant_id).toBe(E.tenantId);
    expect(abrirSobreMock(f, { tenantId: E.tenantId, clienteId: cl, tipo: "sol" })).toEqual({ usuario: u, clave: k });
  });

  it("guardar de nuevo reemplaza el sobre (una sola fila) y el estado vuelve a configurada", async () => {
    const cl = await cliente();
    const k1 = canario("clave-1");
    const k2 = canario("clave-2");
    expect((await guardar(E.titular, cl, "sol", SOL("u1", k1))).status).toBe(200);
    expect((await guardar(E.titular, cl, "sol", SOL("u2", k2))).status).toBe(200);
    const f = await filas(cl);
    expect(f).toHaveLength(1);
    expect(abrirSobreMock(f[0], { tenantId: E.tenantId, clienteId: cl, tipo: "sol" })).toEqual({ usuario: "u2", clave: k2 });
  });

  it("guardar una credencial verificada o inválida la reinicia a configurada, sin fecha ni motivo (CA-6)", async () => {
    for (const previo of ["verificada", "invalida"] as const) {
      const cl = await cliente(E, { sol: previo });
      if (previo === "invalida") {
        await b.sql("update credencial set estado_motivo = 'credencial_invalida', estado_at = now() where cliente_id = $1", [cl]);
      } else {
        await b.sql("update credencial set estado_at = now() where cliente_id = $1", [cl]);
      }
      expect(porTipo((await estado(E.titular, cl)).body).sol.estado).toBe(previo);
      const r = await guardar(E.titular, cl, "sol", SOL("u", canario("k")));
      expect(r.body).toEqual({ tipo: "sol", estado: "configurada" });
      expect(porTipo((await estado(E.titular, cl)).body).sol).toMatchObject({ estado: "configurada", motivo: null });
    }
  });
});

describe("CA-4 · entradas inválidas: 400 solicitud_invalida, no se escribe nada y el canario no se refleja", () => {
  const largo = (c: string) => `${c}${"a".repeat(257 - c.length)}`;
  const casos: [string, string, (c: string) => unknown][] = [
    ["sol sin clave", "sol", (c) => ({ usuario: c })],
    ["sol sin usuario", "sol", (c) => ({ clave: c })],
    ["sol con clave vacía", "sol", (c) => ({ usuario: c, clave: "" })],
    ["sol con usuario vacío", "sol", (c) => ({ usuario: "", clave: c })],
    ["sol con clave de 257 bytes", "sol", (c) => ({ usuario: "u", clave: largo(c) })],
    ["sol con clave de tipo número", "sol", (c) => ({ usuario: c, clave: 12345 })],
    ["sol con clave null", "sol", (c) => ({ usuario: c, clave: null })],
    ["sol con sustituto suelto", "sol", (c) => ({ usuario: c, clave: "ab\ud800cd" })],
    ["sol con los campos de sire_api", "sol", (c) => ({ clientId: c, clientSecret: c })],
    ["sire_api con los campos de sol", "sire_api", (c) => ({ usuario: c, clave: c })],
    ["sire_api sin clientSecret", "sire_api", (c) => ({ clientId: c })],
    ["sire_api con clientSecret de 257 bytes", "sire_api", (c) => ({ clientId: "i", clientSecret: largo(c) })],
    ["sire_api con clientId vacío", "sire_api", (c) => ({ clientId: "", clientSecret: c })],
    ["cuerpo arreglo", "sol", (c) => [c, c]],
    ["cuerpo vacío", "sol", () => ({})],
  ];
  it.each(casos)("%s", async (_n, tipo, hacer) => {
    const cl = await cliente();
    const c = canario("c400");
    const { resultado: r, logs } = await capturarLogs(() => guardar(E.titular, cl, tipo, hacer(c)));
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(await filas(cl)).toHaveLength(0);
    expect(filtrados([c], r.text, r.headers, logs)).toEqual([]);
  });

  it("un tipo desconocido no escribe nada (400 o 404) y no refleja el cuerpo", async () => {
    const cl = await cliente();
    expect((await guardar(E.titular, cl, "sire_api", SIRE("i", canario("control")))).status).toBe(200); // la ruta existe
    const c = canario("tipo");
    const r = await guardar(E.titular, cl, "otro", SOL(c, c));
    expect([400, 404], r.text).toContain(r.status);
    expect((await filas(cl)).map((f) => f.tipo)).toEqual(["sire_api"]);
    expect(filtrados([c], r.text, r.headers)).toEqual([]);
  });

  it("un cuerpo que no es JSON da 400 sin reflejar el contenido", async () => {
    const cl = await cliente();
    expect((await guardar(E.titular, cl, "sire_api", SIRE("i", canario("control")))).status).toBe(200); // la ruta existe
    const c = canario("roto");
    const r = await b.c.p.b.h.pedir({
      metodo: "PUT",
      ruta: `/clientes/${cl}/credenciales/sol`,
      crudo: `{"usuario":"${c}","clave":`,
      cookie: E.titular.cookie,
      csrf: E.titular.csrf,
      estudio: E.tenantId,
    });
    expect(r.status).toBe(400);
    expect(filtrados([c], r.text, r.headers)).toEqual([]);
    expect((await filas(cl)).map((f) => f.tipo)).toEqual(["sire_api"]);
  });
});

describe("D5 · GET estado por tipo: fecha y motivo, nunca el sobre ni el secreto", () => {
  it("sin credenciales: los dos tipos no_configurada, sin fecha ni motivo", async () => {
    const cl = await cliente();
    const r = await estado(E.titular, cl);
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(r.body).toHaveLength(2);
    expect(porTipo(r.body)).toEqual({
      sol: { tipo: "sol", estado: "no_configurada", fecha: null, motivo: null },
      sire_api: { tipo: "sire_api", estado: "no_configurada", fecha: null, motivo: null },
    });
  });

  it("tras guardar una, esa es configurada y la otra sigue no_configurada", async () => {
    const cl = await cliente();
    await guardar(E.titular, cl, "sire_api", SIRE("i", canario("s")));
    const t = porTipo((await estado(E.titular, cl)).body);
    expect(t.sire_api.estado).toBe("configurada");
    expect(t.sol.estado).toBe("no_configurada");
  });

  it("verificada trae la fecha (ISO) e invalida trae el motivo credencial_invalida", async () => {
    const cl = await cliente(E, { sol: "verificada", sireApi: "invalida" });
    await b.sql("update credencial set estado_at = '2026-11-03T15:00:00Z' where cliente_id = $1 and tipo = 'sol'", [cl]);
    await b.sql(
      "update credencial set estado_motivo = 'credencial_invalida', estado_at = '2026-11-04T09:30:00Z' where cliente_id = $1 and tipo = 'sire_api'",
      [cl],
    );
    const r = await estado(E.titular, cl);
    const t = porTipo(r.body);
    expect(t.sol).toMatchObject({ tipo: "sol", estado: "verificada", motivo: null });
    expect(new Date(t.sol.fecha).toISOString()).toBe("2026-11-03T15:00:00.000Z");
    expect(t.sire_api).toMatchObject({ tipo: "sire_api", estado: "invalida", motivo: "credencial_invalida" });
    expect(new Date(t.sire_api.fecha).toISOString()).toBe("2026-11-04T09:30:00.000Z");
  });

  it("la respuesta no tiene claves del sobre ni el canario guardado", async () => {
    const cl = await cliente();
    const u = canario("usuario");
    const k = canario("clave");
    await guardar(E.titular, cl, "sol", SOL(u, k));
    const { resultado: r, logs } = await capturarLogs(() => estado(E.titular, cl));
    expect(Object.keys(r.body[0]).sort()).toEqual(["estado", "fecha", "motivo", "tipo"]);
    expect(r.text).not.toMatch(/ciphertext|nonce|dek|kek|"tag"|version/i);
    expect(filtrados([u, k], r.text, r.headers, logs)).toEqual([]);
  });

  it("un cliente archivado se puede leer (solo se bloquea guardar y verificar)", async () => {
    const cl = await cliente(E, { sol: "configurada", archivado: true });
    const r = await estado(E.titular, cl);
    expect(r.status).toBe(200);
    expect(porTipo(r.body).sol.estado).toBe("configurada");
  });
});

describe("D3 · permisos y alcance", () => {
  it("Dueño y Administrador guardan en cualquier cliente; el contador solo en uno asignado", async () => {
    const cualquiera = await cliente();
    expect((await guardar(E.titular, cualquiera, "sol", SOL("u", canario("k")))).status).toBe(200);
    expect((await guardar(admin, cualquiera, "sire_api", SIRE("i", canario("s")))).status).toBe(200);
    expect((await guardar(contador, clienteContador, "sol", SOL("u", canario("k")))).status).toBe(200);
  });

  it("el contador no asignado recibe 404, igual que un cliente inexistente, y no se escribe nada", async () => {
    const ajenoAlContador = await cliente();
    expect((await guardar(contador, clienteContador, "sol", SOL("u", canario("control")))).status).toBe(200); // la ruta existe
    const c = canario("alcance");
    const r = await guardar(contador, ajenoAlContador, "sol", SOL(c, c));
    const inexistente = await guardar(contador, randomUUID(), "sol", SOL(c, c));
    expect(r.status).toBe(404);
    expect(forma(r)).toEqual(forma(inexistente));
    expect(await filas(ajenoAlContador)).toHaveLength(0);
    expect(filtrados([c], r.text, r.headers)).toEqual([]);
  });

  it("asistente y lectura no guardan: 403 permiso_denegado y no se escribe nada", async () => {
    const cl = await cliente(E, { responsable: asistente.id, colaboradores: [lectura.id] });
    for (const a of [asistente, lectura]) {
      const c = canario(`perm-${a.rol}`);
      const r = await guardar(a, cl, "sol", SOL(c, c));
      expect(r.status, a.rol).toBe(403);
      expect(r.body).toEqual({ codigo: "permiso_denegado" });
      expect(filtrados([c], r.text, r.headers)).toEqual([]);
    }
    expect(await filas(cl)).toHaveLength(0);
  });

  it("el permiso se exige antes de validar el cuerpo: un cuerpo inválido sin permiso da 403, no 400", async () => {
    const cl = await cliente(E, { responsable: asistente.id });
    const r = await guardar(asistente, cl, "sol", { usuario: "" });
    expect(r.status).toBe(403);
  });

  it("GET exige clientes.ver (lectura colaborador lo ve) y respeta el alcance (lectura no asignado: 404)", async () => {
    const mio = await cliente(E, { colaboradores: [lectura.id], sol: "configurada" });
    const ajeno = await cliente(E, { sol: "configurada" });
    expect((await estado(lectura, mio)).status).toBe(200);
    const r = await estado(lectura, ajeno);
    expect(r.status).toBe(404);
    expect(forma(r)).toEqual(forma(await estado(lectura, randomUUID())));
  });
});

describe("D6 · verificar encola el trabajo (CA-5: visible en el panel)", () => {
  it("sol: 202 con la vista del trabajo credencial.verificar_sol, interactivo, cola sol, y fila en la BD", async () => {
    const cl = await cliente(E, { sol: "configurada" });
    const r = await verificar(E.titular, cl, "sol");
    expect(r.status, r.text).toBe(202);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(trabajoVistaSchema.safeParse(r.body).success).toBe(true);
    expect(r.body).toMatchObject({
      tipo: "credencial.verificar_sol",
      clienteId: cl,
      estado: "en_cola",
      intentos: 0,
      motivo: null,
      creadoPor: { usuarioId: E.titular.id },
    });
    const f = await b.sql("select * from job_registro where id = $1", [r.body.id]);
    expect(f[0]).toMatchObject({
      tenant_id: E.tenantId,
      cliente_id: cl,
      tipo: "credencial.verificar_sol",
      cola: "sol",
      canal: "sol",
      prioridad: "interactivo",
      estado: "en_cola",
      parametros: {},
    });
    expect(await b.redis.zscore(b.claves.pend("sol", E.tenantId), r.body.id)).not.toBeNull();
    // El trabajo es visible en el panel (GET /trabajos) del estudio.
    const lista = await llamar(E.titular, "GET", `/trabajos?clienteId=${cl}`);
    expect(lista.body.map((t: any) => t.id)).toContain(r.body.id);
  });

  it("sire_api con SOL y SIRE configuradas: 202 credencial.verificar_sire, cola sire", async () => {
    const cl = await cliente(E, { sol: "configurada", sireApi: "configurada" });
    const r = await verificar(E.titular, cl, "sire_api");
    expect(r.status, r.text).toBe(202);
    expect(r.body).toMatchObject({ tipo: "credencial.verificar_sire", clienteId: cl, estado: "en_cola" });
    const f = await b.sql("select cola, canal, prioridad from job_registro where id = $1", [r.body.id]);
    expect(f[0]).toEqual({ cola: "sire", canal: "sire", prioridad: "interactivo" });
  });

  it("es idempotente: verificar de nuevo devuelve el mismo trabajo y no crea otra fila", async () => {
    const cl = await cliente(E, { sol: "configurada" });
    const a = await verificar(E.titular, cl, "sol");
    const otra = await verificar(admin, cl, "sol");
    expect(a.status).toBe(202);
    expect(otra.status).toBe(202);
    expect(otra.body.id).toBe(a.body.id);
    expect(await trabajosDe(cl)).toHaveLength(1);
  });

  it("una credencial inválida sí se puede verificar de nuevo (CA-6)", async () => {
    const cl = await cliente(E, { sol: "invalida" });
    const r = await verificar(E.titular, cl, "sol");
    expect(r.status, r.text).toBe(202);
    expect(r.body.estado).toBe("en_cola");
  });

  it("409 credencial_no_configurada: sol sin credencial, sire_api sin credencial y sire_api sin SOL", async () => {
    const sinNada = await cliente();
    const soloSire = await cliente(E, { sireApi: "configurada" });
    const soloSol = await cliente(E, { sol: "configurada" });
    for (const [cl, tipo] of [
      [sinNada, "sol"],
      [sinNada, "sire_api"],
      [soloSire, "sire_api"], // SIRE sin SOL: el token SIRE usa ambas (D6)
      [soloSol, "sire_api"],
    ] as const) {
      const r = await verificar(E.titular, cl, tipo);
      expect(r.status, `${cl} ${tipo}: ${r.text}`).toBe(409);
      expect(r.body).toEqual({ codigo: "credencial_no_configurada" });
      expect(await trabajosDe(cl)).toHaveLength(0);
    }
  });

  it("asistente y lectura no verifican: 403 y no se encola nada; contador asignado sí (202)", async () => {
    const cl = await cliente(E, { responsable: asistente.id, colaboradores: [lectura.id], sol: "configurada" });
    for (const a of [asistente, lectura]) {
      const r = await verificar(a, cl, "sol");
      expect(r.status, a.rol).toBe(403);
      expect(r.body).toEqual({ codigo: "permiso_denegado" });
    }
    expect(await trabajosDe(cl)).toHaveLength(0);
    const r = await verificar(contador, (await b.c.sembrar(E.tenantId, { responsable: contador.id, sol: "configurada" })).id, "sol");
    expect(r.status, r.text).toBe(202);
  });

  it("el contador no asignado recibe 404 y no se encola nada", async () => {
    const cl = await cliente(E, { sol: "configurada" });
    const propio = await cliente(E, { responsable: contador.id, sol: "configurada" });
    expect((await verificar(contador, propio, "sol")).status).toBe(202); // la ruta existe
    const r = await verificar(contador, cl, "sol");
    expect(r.status).toBe(404);
    expect(await trabajosDe(cl)).toHaveLength(0);
  });
});

describe("CA-10 · cliente archivado, ajeno o inexistente", () => {
  it("archivado: guardar y verificar dan 409 cliente_archivado, sin escribir ni encolar, y sin reflejar el canario", async () => {
    const cl = await cliente(E, { sol: "configurada", sireApi: "configurada", archivado: true });
    const antes = await b.c.huellaCredenciales(cl);
    const c = canario("archivado");
    const { resultado: g, logs } = await capturarLogs(() => guardar(E.titular, cl, "sol", SOL(c, c)));
    expect(g.status).toBe(409);
    expect(g.body).toEqual({ codigo: "cliente_archivado" });
    expect(filtrados([c], g.text, g.headers, logs)).toEqual([]);
    for (const tipo of ["sol", "sire_api"]) {
      const v = await verificar(E.titular, cl, tipo);
      expect(v.status, tipo).toBe(409);
      expect(v.body).toEqual({ codigo: "cliente_archivado" });
    }
    expect(await b.c.huellaCredenciales(cl)).toEqual(antes);
    expect(await trabajosDe(cl)).toHaveLength(0);
  });

  it("reactivar el cliente vuelve a permitir guardar (el bloqueo es solo por el archivado)", async () => {
    const cl = await cliente(E, { archivado: true });
    expect((await guardar(E.titular, cl, "sol", SOL("u", canario("k")))).status).toBe(409);
    expect((await llamar(E.titular, "POST", `/clientes/${cl}/reactivar`)).status).toBe(200);
    expect((await guardar(E.titular, cl, "sol", SOL("u", canario("k")))).status).toBe(200);
  });

  it("ajeno (de otro estudio) e inexistente dan el mismo 404, idéntico byte a byte, en las tres rutas", async () => {
    const ajeno = await cliente(F, { sol: "configurada", sireApi: "configurada" });
    // Control: las tres rutas existen y funcionan con un cliente propio.
    const propio = await cliente(E, { sol: "configurada" });
    expect((await guardar(E.titular, propio, "sol", SOL("u", canario("control")))).status).toBe(200);
    expect((await estado(E.titular, propio)).status).toBe(200);
    expect((await verificar(E.titular, propio, "sol")).status).toBe(202);
    const huellaAjeno = await b.c.huellaCredenciales(ajeno);
    const inexistente = randomUUID();
    const c = canario("ajeno");
    const rutas: [string, (id: string) => Promise<any>][] = [
      ["PUT", (id) => guardar(E.titular, id, "sol", SOL(c, c))],
      ["GET", (id) => estado(E.titular, id)],
      ["POST verificar", (id) => verificar(E.titular, id, "sol")],
    ];
    for (const [nombre, pedir] of rutas) {
      const a = await pedir(ajeno);
      const i = await pedir(inexistente);
      expect(a.status, nombre).toBe(404);
      expect(forma(a), nombre).toEqual(forma(i));
      expect(a.text, nombre).not.toContain(ajeno);
    }
    // Nada cambió en el estudio ajeno: ni sobre ni trabajos.
    expect(await b.c.huellaCredenciales(ajeno)).toEqual(huellaAjeno);
    expect(await trabajosDe(ajeno)).toHaveLength(0);
  });

  it("un id que no es UUID da el mismo 404 en las tres rutas (nunca 500)", async () => {
    expect((await estado(E.titular, await cliente())).status).toBe(200); // la ruta existe
    for (const pedir of [
      () => guardar(E.titular, "no-es-un-uuid", "sol", SOL("u", "k")),
      () => estado(E.titular, "no-es-un-uuid"),
      () => verificar(E.titular, "no-es-un-uuid", "sol"),
    ]) {
      const r = await pedir();
      expect(r.status).toBe(404);
    }
  });
});
