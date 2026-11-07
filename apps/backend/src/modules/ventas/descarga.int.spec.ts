/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 013 (T6, rojo): POST /clientes/:clienteId/periodos/:periodo/ventas/descargar (D2, D5; CA-1, CA-4).
// Contrato (plan: Rutas; errores `{codigo}`):
//  - 202 `{ trabajoId }` y NADA más (el cuerpo no trae el trabajo ni datos del estudio). Encola `sire.propuesta.descargar`
//    con `{ periodo, libro: "ventas" }` (cola y canal `sire`, prioridad `interactivo`, `creado_por` = quien pulsó) y publica en
//    Redis; no llama a SUNAT (el backend no importa `@contapp/sunat`) ni espera a nadie: sin worker el trabajo queda `en_cola`.
//  - Idempotente (008 D8): pulsar dos veces con el trabajo vivo devuelve el MISMO `trabajoId` y no crea otra fila.
//  - Permiso `sire.descargar` (403 `permiso_denegado`: lectura); `ClienteScopeGuard` (no asignado = inexistente = 404
//    `no_encontrado`); cliente archivado 409 `cliente_archivado`; periodo mal formado, con mes fuera de 01-12 o futuro 400
//    `solicitud_invalida`. Nada de esto crea una fila en `job_registro`.
//  - No escribe en `propuesta`, `venta` ni saltos: eso lo hace el worker.
// Rojo: el módulo `ventas` aún no existe (T13).
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoVentas,
  base,
  PERIODO,
  type Actor,
  type BancoVentas,
  type Estudio,
} from "../../../test/soporte-ventas.js";
import { forma } from "../../../test/soporte.js";

// Siembras de miles de filas, archivos de decenas de MB y rondas de carreras: el tiempo por defecto no alcanza.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let v: BancoVentas;
let E: Estudio;
let contador: Actor;
let asistente: Actor;
let lectura: Actor;

beforeAll(async () => {
  v = await abrirBancoVentas();
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
const nuevo = (o: Parameters<BancoVentas["cliente"]>[1] = {}) =>
  v.cliente(E, { responsable: contador.id, ...o });

describe("CA-1 · descargar responde 202 con el trabajoId y encola sin llamar a SUNAT", () => {
  it("202 { trabajoId }, fila en_cola de la cola sire con { periodo, libro } y publicada en Redis", async () => {
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
    expect(filas[0].parametros).toEqual({ periodo: PERIODO, libro: "ventas" });
    expect(await enRedis(E.tenantId, r.body.trabajoId)).not.toBeNull();
  });

  it("el trabajo aparece en el panel del usuario con su tipo y su posición (GET /trabajos)", async () => {
    const c = await nuevo();
    const r = await descargar(contador, c.id);
    expect(r.status).toBe(202);
    const lista = await v.llamar(contador, "GET", "/trabajos");
    expect(lista.status, lista.text).toBe(200);
    const t = (lista.body as any[]).find((x) => x.id === r.body.trabajoId);
    expect(t).toMatchObject({
      tipo: "sire.propuesta.descargar",
      clienteId: c.id,
      estado: "en_cola",
    });
    // T22a (T22, punto 1): el título promete la posición; mientras está en cola es un entero >= 1.
    expect(Number.isInteger(t.posicion), `posicion=${String(t.posicion)}`).toBe(true);
    expect(t.posicion).toBeGreaterThanOrEqual(1);
  });

  it("no escribe ventas ni propuestas: eso es del worker", async () => {
    const c = await nuevo();
    expect((await descargar(contador, c.id)).status).toBe(202);
    expect(await v.conteo(c.id)).toEqual({
      propuestas: 0,
      ventas: 0,
      diferencias: 0,
      saltos: 0,
    });
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
    const rs = await Promise.all([
      descargar(contador, c.id),
      descargar(contador, c.id),
    ]);
    expect(rs.map((r) => r.status)).toEqual([202, 202]);
    expect(rs[1]!.body.trabajoId).toBe(rs[0]!.body.trabajoId);
    expect(await v.trabajos(c.id)).toHaveLength(1);
  });

  it("otro periodo del mismo cliente es otro trabajo", async () => {
    const c = await nuevo();
    const a = await descargar(contador, c.id, "202610");
    const b = await descargar(contador, c.id, "202609");
    expect(b.body.trabajoId).not.toBe(a.body.trabajoId);
    const filas = await v.trabajos(c.id);
    expect(filas.map((f) => f.parametros.periodo).sort()).toEqual([
      "202609",
      "202610",
    ]);
  });

  it("el backend no llama a SUNAT: ni el módulo ni el paquete dependen de @contapp/sunat", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const fuentes = readdirSync(dir).filter(
      (n) => n.endsWith(".ts") && !n.endsWith(".spec.ts"),
    );
    expect(fuentes.length, "el módulo ventas existe").toBeGreaterThan(0);
    for (const n of fuentes) {
      expect(readFileSync(join(dir, n), "utf8"), n).not.toMatch(
        /@contapp\/sunat/,
      );
    }
    const paquete = readFileSync(
      fileURLToPath(new URL("../../../package.json", import.meta.url)),
      "utf8",
    );
    expect(paquete).not.toMatch(/@contapp\/sunat/);
  });
});

describe("periodo: AAAAMM con mes 01 a 12 y sin futuro", () => {
  const MALOS = [
    "2026-10",
    "20261",
    "2026100",
    "202613",
    "202600",
    "abcdef",
    "209912",
    "2026%2010",
    "202610'",
  ];
  it.each(MALOS)(
    "«%s» da 400 solicitud_invalida y no encola nada",
    async (p) => {
      const c = await nuevo();
      const r = await v.llamar(
        contador,
        "POST",
        `/clientes/${c.id}/periodos/${p}/ventas/descargar`,
      );
      expect(r.status, r.text).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
      expect(await v.trabajos(c.id)).toHaveLength(0);
    },
  );

  it("el mes en curso vale", async () => {
    const c = await nuevo();
    const hoy = new Date();
    const periodo = `${hoy.getFullYear()}${String(hoy.getMonth() + 1).padStart(2, "0")}`;
    const r = await descargar(contador, c.id, periodo);
    expect(r.status, r.text).toBe(202);
  });
});

describe("D5 · permisos, alcance y cliente archivado", () => {
  it("Dueño, Administrador, contador asignado y asistente asignado descargan; lectura recibe 403 permiso_denegado y no encola", async () => {
    const admin = await v.b.c.p.b.miembro(E.tenantId, "admin");
    const c = await nuevo({ colaboradores: [asistente.id, lectura.id] });
    for (const a of [E.titular, admin, contador, asistente]) {
      const c2 = await nuevo({ colaboradores: [asistente.id] });
      const r = await descargar(a, c2.id);
      expect(r.status, a.rol).toBe(202);
    }
    const r = await descargar(lectura, c.id);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ codigo: "permiso_denegado" });
    expect(await v.trabajos(c.id)).toHaveLength(0);
  });

  it("el contador no asignado recibe el mismo 404 que un cliente inexistente y no se encola nada", async () => {
    const ajeno = await v.cliente(E); // sin responsable
    // Control: la ruta existe y el Dueño (alcance global) sí puede; si no, el 404 de abajo no probaría nada.
    expect((await descargar(E.titular, ajeno.id)).status).toBe(202);
    const r = await descargar(contador, ajeno.id);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(forma(r)).toEqual(forma(await descargar(contador, randomUUID())));
    expect(await v.trabajos(ajeno.id)).toHaveLength(1); // solo el del control
  });

  it("otro estudio: el cliente de E es un 404 para el Dueño de F", async () => {
    const F = await v.estudio();
    const c = await nuevo();
    expect((await descargar(E.titular, c.id)).status).toBe(202); // control: la ruta existe
    const r = await descargar(F.titular, c.id);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(await v.trabajos(c.id)).toHaveLength(1); // solo el del control
  });

  it("cliente archivado: 409 cliente_archivado y no se encola nada", async () => {
    const c = await nuevo({ archivado: true });
    const r = await descargar(contador, c.id);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
    expect(await v.trabajos(c.id)).toHaveLength(0);
  });
});
