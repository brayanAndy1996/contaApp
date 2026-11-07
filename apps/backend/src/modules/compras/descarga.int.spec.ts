/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 014 (T10, rojo): POST /clientes/:clienteId/periodos/:periodo/compras/descargar (D-3, D-9, DU-14 punto 4, DU-21; CA-1
// parte HTTP, CA-12, CA-13). La persistencia de la descarga (5 compras, hallazgos, `resultado`) la prueba T8 en el worker.
// Contrato (plan: «Contrato real de 013», punto 10, y «Contratos: HTTP»; errores `{codigo}`):
//  - 202 `{ trabajoId }` y NADA más (no es `TrabajoVista`). Encola `sire.propuesta.descargar` con `{ periodo, libro: "compras" }`
//    (cola y canal `sire`, prioridad `interactivo`, `creado_por` = quien pulsó) y publica en Redis; no llama a SUNAT ni espera a
//    nadie. Idempotente con el trabajo vivo (008 D8). No escribe compras ni propuestas: eso lo hace el worker.
//  - Permiso `sire.descargar` (lectura: 403 `permiso_denegado`); `ClienteScopeGuard` (no asignado = inexistente = 404);
//    periodo mal formado o futuro: 400 `solicitud_invalida`.
//  - Cliente archivado: 409 `cliente_archivado`. Sin credencial SIRE configurada: 409 `credencial_no_configurada` (013 no lo
//    comprueba al encolar; 014 sí, plan «Contratos: HTTP»).
//  - Estado del periodo (D-9, DU-14 punto 4, DU-21): `revisado` exige `sire.aprobar_generar` (sin él, 403 `periodo_revisado`);
//    `generado` es 409 `periodo_generado` para todos. Nada de eso crea un trabajo.
//  - `apps/backend` no importa `@contapp/sunat` (lo que prueba la lectura de las fuentes del módulo y del `package.json`).
// Rojo: el módulo `compras` aún no existe (T15): toda ruta responde 404 de ruta inexistente.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoCompras,
  base,
  PERIODO,
  type Actor,
  type BancoCompras,
  type Estudio,
} from "../../../test/soporte-compras.js";
import { forma } from "../../../test/soporte.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let v: BancoCompras;
let E: Estudio;
let contador: Actor;
let asistente: Actor;
let lectura: Actor;

beforeAll(async () => {
  v = await abrirBancoCompras();
  E = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
  lectura = await p.miembro(E.tenantId, "lectura");
});
afterAll(async () => {
  await v?.cerrar();
});

const descargar = (a: Actor, clienteId: string, periodo = PERIODO) =>
  v.llamar(a, "POST", `${base(clienteId, periodo)}/descargar`);
const enRedis = (tenantId: string, id: string) =>
  v.b.redis.zscore(v.b.claves.pend("sire", tenantId), id) as Promise<
    string | null
  >;
/** Cliente nuevo del estudio para que cada prueba parta sin trabajos vivos. */
const nuevo = (o: Parameters<BancoCompras["cliente"]>[1] = {}) =>
  v.cliente(E, { responsable: contador.id, colaboradores: [asistente.id, lectura.id], ...o });

describe("CA-1 · descargar responde 202 con el trabajoId y encola con libro compras sin llamar a SUNAT", () => {
  it("202 { trabajoId }, fila en_cola de la cola sire con { periodo, libro: compras } y publicada en Redis", async () => {
    const c = await nuevo();
    const r = await descargar(contador, c.id);
    expect(r.status, r.text).toBe(202);
    expect(Object.keys(r.body)).toEqual(["trabajoId"]);
    expect(r.body.trabajoId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.ms).toBeLessThan(3000); // nada espera a SUNAT

    const filas = await v.trabajos(c.id);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      id: r.body.trabajoId,
      tenant_id: E.tenantId,
      cliente_id: c.id,
      tipo: "sire.propuesta.descargar",
      cola: "sire",
      canal: "sire",
      prioridad: "interactivo",
      estado: "en_cola",
      intentos: 0,
      creado_por: contador.id,
      ruc: c.ruc,
    });
    expect(filas[0].parametros).toEqual({ periodo: PERIODO, libro: "compras" });
    expect(await enRedis(E.tenantId, r.body.trabajoId)).not.toBeNull();
    expect(r.headers["cache-control"]).toMatch(/no-store/);
  });

  it("el trabajo aparece en el panel del usuario con su tipo (GET /trabajos)", async () => {
    const c = await nuevo();
    const r = await descargar(contador, c.id);
    expect(r.status).toBe(202);
    const lista = await v.llamar(contador, "GET", "/trabajos");
    expect(lista.status, lista.text).toBe(200);
    const t = (lista.body as any[]).find((x) => x.id === r.body.trabajoId);
    expect(t).toMatchObject({ tipo: "sire.propuesta.descargar", clienteId: c.id, estado: "en_cola" });
  });

  it("no escribe compras, versiones, operaciones ni propuestas: eso es del worker", async () => {
    const c = await nuevo();
    const antes = await v.foto(c.id);
    expect((await descargar(contador, c.id)).status).toBe(202);
    const despues = await v.foto(c.id);
    expect(despues.compras).toEqual(antes.compras);
    expect(despues.versiones).toEqual(antes.versiones);
    expect(despues.operaciones).toEqual(antes.operaciones);
    expect(despues.propuestas).toBe(0);
    expect(despues.compras).toHaveLength(0);
  });

  it("pulsar dos veces con el trabajo vivo devuelve el mismo trabajoId y deja una sola fila (008 D8)", async () => {
    const c = await nuevo();
    const a = await descargar(contador, c.id);
    const b = await descargar(contador, c.id);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(b.body.trabajoId).toBe(a.body.trabajoId);
    expect(await v.trabajos(c.id)).toHaveLength(1);
  });

  it("dos clics simultáneos tampoco duplican el trabajo", async () => {
    const c = await nuevo();
    const rs = await Promise.all([descargar(contador, c.id), descargar(contador, c.id)]);
    expect(rs.map((r) => r.status)).toEqual([202, 202]);
    expect(rs[1]!.body.trabajoId).toBe(rs[0]!.body.trabajoId);
    expect(await v.trabajos(c.id)).toHaveLength(1);
  });

  it("otro periodo del mismo cliente es otro trabajo", async () => {
    const c = await nuevo();
    const a = await descargar(contador, c.id, "202610");
    const b = await descargar(contador, c.id, "202609");
    expect(b.body.trabajoId).not.toBe(a.body.trabajoId);
    expect((await v.trabajos(c.id)).map((f) => f.parametros.periodo).sort()).toEqual(["202609", "202610"]);
  });

  it("el libro distingue el trabajo: descargar compras y ventas del mismo periodo son dos trabajos", async () => {
    const c = await nuevo();
    const compras = await descargar(contador, c.id);
    const ventas = await v.llamar(contador, "POST", `/clientes/${c.id}/periodos/${PERIODO}/ventas/descargar`);
    expect([compras.status, ventas.status], `${compras.text} ${ventas.text}`).toEqual([202, 202]);
    expect(ventas.body.trabajoId).not.toBe(compras.body.trabajoId);
    const filas = await v.trabajos(c.id);
    expect(filas.map((f) => f.parametros.libro).sort()).toEqual(["compras", "ventas"]);
  });

  it("el backend no llama a SUNAT: ni el módulo ni el paquete dependen de @contapp/sunat", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const fuentes = readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".spec.ts"));
    expect(fuentes.length, "el módulo compras existe").toBeGreaterThan(0);
    for (const n of fuentes) expect(readFileSync(join(dir, n), "utf8"), n).not.toMatch(/@contapp\/sunat/);
    const paquete = readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8");
    expect(paquete).not.toMatch(/@contapp\/sunat/);
  });
});

describe("periodo: AAAAMM con mes 01 a 12 y sin futuro", () => {
  const MALOS = ["2026-10", "20261", "2026100", "202613", "202600", "abcdef", "209912", "2026%2010", "202610'"];
  it.each(MALOS)("«%s» da 400 solicitud_invalida y no encola nada", async (p) => {
    const c = await nuevo();
    const r = await v.llamar(contador, "POST", `/clientes/${c.id}/periodos/${p}/compras/descargar`);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await v.trabajos(c.id)).toHaveLength(0);
  });

  it("el mes en curso vale", async () => {
    const c = await nuevo();
    const hoy = new Date();
    const periodo = `${hoy.getFullYear()}${String(hoy.getMonth() + 1).padStart(2, "0")}`;
    const r = await descargar(contador, c.id, periodo);
    expect(r.status, r.text).toBe(202);
  });
});

describe("D-11 · permisos, alcance, credencial y cliente archivado", () => {
  it("Dueño, contador asignado y asistente asignado descargan; lectura recibe 403 permiso_denegado y no encola", async () => {
    for (const a of [E.titular, contador, asistente]) {
      const c = await nuevo();
      const r = await descargar(a, c.id);
      expect(r.status, `${a.rol}: ${r.text}`).toBe(202);
    }
    const c = await nuevo();
    const r = await descargar(lectura, c.id);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ codigo: "permiso_denegado" });
    expect(await v.trabajos(c.id)).toHaveLength(0);
  });

  it("el contador no asignado recibe el mismo 404 que un cliente inexistente y no se encola nada", async () => {
    const ajeno = await v.cliente(E); // sin responsable
    expect((await descargar(E.titular, ajeno.id)).status).toBe(202); // control: la ruta existe
    const r = await descargar(contador, ajeno.id);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(forma(r)).toEqual(forma(await descargar(contador, randomUUID())));
    expect(await v.trabajos(ajeno.id)).toHaveLength(1); // solo el del control
  });

  it("otro estudio: el cliente de E es un 404 para el Dueño de F", async () => {
    const F = await v.estudio();
    const c = await nuevo();
    expect((await descargar(E.titular, c.id)).status).toBe(202); // control
    const r = await descargar(F.titular, c.id);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(await v.trabajos(c.id)).toHaveLength(1);
  });

  it("sin sesión: 401 y no se encola nada", async () => {
    const c = await nuevo();
    expect((await descargar(E.titular, c.id)).status).toBe(202); // control
    const r = await v.sinSesion("POST", `${base(c.id)}/descargar`);
    expect(r.status, r.text).toBe(401);
    expect(await v.trabajos(c.id)).toHaveLength(1);
  });

  it("cliente archivado: 409 cliente_archivado y no se encola nada", async () => {
    const c = await nuevo({ archivado: true });
    const r = await descargar(contador, c.id);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
    expect(await v.trabajos(c.id)).toHaveLength(0);
  });

  it("sin credencial SIRE configurada: 409 credencial_no_configurada y no se encola nada", async () => {
    const c = await nuevo({ sireApi: "no_configurada" });
    expect((await descargar(E.titular, (await nuevo()).id)).status).toBe(202); // control: con credencial sí
    const r = await descargar(contador, c.id);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "credencial_no_configurada" });
    expect(await v.trabajos(c.id)).toHaveLength(0);
  });

  it("la respuesta no deja ver nada del estudio ni de la credencial", async () => {
    const c = await nuevo();
    const r = await descargar(contador, c.id);
    expect(r.status).toBe(202);
    const texto = JSON.stringify(r.body);
    for (const prohibido of [E.tenantId, c.id, c.ruc]) expect(texto).not.toContain(prohibido);
  });
});

describe("CA-12 / DU-14 punto 4 / DU-21 · descargar de nuevo según el estado del periodo", () => {
  it("revisado: sire.descargar sin sire.aprobar_generar recibe 403 periodo_revisado y no encola; con sire.aprobar_generar, 202", async () => {
    const c = await nuevo();
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "revisado", contador.id);
    const bloq = await descargar(asistente, c.id);
    expect(bloq.status, bloq.text).toBe(403);
    expect(bloq.body).toEqual({ codigo: "periodo_revisado" });
    expect(await v.trabajos(c.id)).toHaveLength(0);
    const ok = await descargar(contador, c.id);
    expect(ok.status, ok.text).toBe(202);
    expect(await v.trabajos(c.id)).toHaveLength(1);
  });

  it("generado: nadie descarga, ni con sire.aprobar_generar (409 periodo_generado), y no se encola", async () => {
    const c = await nuevo();
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "generado", contador.id);
    for (const a of [asistente, contador, E.titular]) {
      const r = await descargar(a, c.id);
      expect(r.status, `${a.rol}: ${r.text}`).toBe(409);
      expect(r.body).toEqual({ codigo: "periodo_generado" });
    }
    expect(await v.trabajos(c.id)).toHaveLength(0);
  });

  it("el estado de un periodo no bloquea otro periodo del mismo cliente", async () => {
    const c = await nuevo();
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "generado", contador.id);
    const r = await descargar(asistente, c.id, "202609");
    expect(r.status, r.text).toBe(202);
  });

  it("abierto: basta sire.descargar", async () => {
    const c = await nuevo();
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "abierto");
    expect((await descargar(asistente, c.id)).status).toBe(202);
  });
});
