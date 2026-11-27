// Spec 041 · T13 · Ronda adversarial 2 (CAJA BLANCA), lado worker: `CacheTokenSire.conToken` + `HttpSireApiClient` +
// `AlmacenTicketsRedis` con PostgreSQL y Redis reales y el SERVIDOR SUNAT FALSO en 127.0.0.1. Nada sale a internet ni duerme.
import { randomUUID } from "node:crypto";
import type { ContappDb } from "@contapp/db";
import { HttpSireApiClient, HttpSireAuth, type CredencialSire } from "@contapp/sunat";
import { iniciarServidorSireFalso } from "@contapp/sunat/dist/http/pruebas/servidor-sire-falso.js";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { arrancar007b, esperarTerminal } from "../../test/procesadores-007b.js";
import {
  RelojSire,
  RUTAS_SIRE,
  guionarSire,
  leerFixture,
  mundoSireHttp,
  registroTicket,
  respuestaToken,
  zipDe,
  type ServidorSireFalso,
} from "../../test/sire-http.js";
import { canario, rastros } from "../../test/soporte.js";
import {
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  Escenario,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
  restaurarConfig,
  volcarPrefijo,
} from "../../test/trabajos.js";
import { PERIODO, RUC_FIXTURE, encolarDescarga, limpiarVentas } from "../../test/ventas.js";
import { AlmacenTicketsRedis } from "./token-sire/almacen-tickets-redis.js";
import { CacheTokenSire } from "./token-sire/cache-token.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

let admin: ContappDb;
let backend: ContappDb;
let redis: Redis;
let e: Escenario;
let prefijo = nuevoPrefijo();
const prefijos = [prefijo];
let srv: ServidorSireFalso;
let reloj: RelojSire;

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  redis = conectarRedis();
  e = new Escenario(admin);
  await fijarConfig(admin, "sire", { global: 4, tenant: 2, espera: 0, reintentos: 3, base: 100 });
});
beforeEach(async () => {
  prefijo = nuevoPrefijo();
  prefijos.push(prefijo);
  srv = await iniciarServidorSireFalso();
  reloj = new RelojSire();
});
afterEach(async () => {
  await srv?.cerrar();
});
afterAll(async () => {
  await restaurarConfig(admin).catch(() => undefined);
  await limpiarVentas(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  for (const x of prefijos) await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), admin?.close()]);
});

const zipVentas = () => zipDe("ventas-propuesta-202610.txt", leerFixture("ventas-propuesta-202610.txt"));
const peticiones = (ruta: RegExp, metodo = "GET") => srv.peticionesDe(metodo, ruta);

describe("adv2 worker · 401 en la consulta del ticket recién exportado", () => {
  it("la renovación del token (conToken) retoma el ticket ya exportado: un solo exportar en todo el trabajo", async () => {
    const m = await mundoSireHttp(e, backend, { ruc: RUC_FIXTURE });
    const A = canario("token_A");
    const B = canario("token_B");
    guionarSire(srv, { tokens: [A, B], periodo: PERIODO, zip: zipVentas() });
    // El exportar acepta A; la PRIMERA consulta del ticket con A responde 401 (token revocado entre dos peticiones).
    srv.guionar("GET", RUTAS_SIRE.ticket, (p) =>
      p.cabeceras["authorization"] === `Bearer ${A}`
        ? { estado: 401, json: { cod: "401" } }
        : { json: registroTicket(p.query["numTicket"] ?? "", "06", PERIODO) },
    );
    const urlsDePrueba = { seguridad: srv.origen, sire: srv.origen };
    const p = await arrancar007b({
      prefijo,
      sireAuth: new HttpSireAuth({ urlsDePrueba }),
      sireApi: new HttpSireApiClient({
        urlsDePrueba,
        ahora: reloj.ahora,
        dormir: reloj.dormir,
        almacenTickets: new AlmacenTicketsRedis({ redis, prefijo }),
      }),
    } as Parameters<typeof arrancar007b>[0]);
    let f: Awaited<ReturnType<typeof esperarTerminal>> | undefined;
    try {
      const id = await encolarDescarga(backend, redis, prefijo, m, { periodo: PERIODO, libro: "ventas" });
      f = await esperarTerminal(e, id, 60_000);
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
    expect([f?.estado, f?.motivo]).toEqual(["completado", null]);
    expect(peticiones(RUTAS_SIRE.token, "POST")).toHaveLength(2);
    const tickets = peticiones(RUTAS_SIRE.exportar).length;
    expect(tickets, "exportaciones: el ticket del token A se abandonó y se generó otro").toBe(1);
    expect(await redis.keys(`${prefijo}sire:ticket:*`)).toEqual([]);
  });
});

describe("adv2 worker · dos usos concurrentes del mismo cliente con el token revocado", () => {
  it("el segundo 401 (del token VIEJO) no tira el token recién renovado ni pide un tercero; Redis sin secretos", async () => {
    const A = canario("token_A");
    const B = canario("token_B");
    const C = canario("token_C");
    const secreto = canario("client_secret");
    const clave = canario("clave_sol");
    const cred: CredencialSire = {
      clientId: "cid-r2-0001",
      clientSecret: secreto,
      usuarioSol: "USUARIOSOL",
      claveSol: clave,
      ruc: RUC_FIXTURE,
    };
    guionarSire(srv, { tokens: [A, B, C], periodo: PERIODO, zip: zipVentas() });
    srv.guionar("POST", RUTAS_SIRE.token, respuestaToken(A), respuestaToken(B), respuestaToken(C));
    // Solo A está revocado.
    srv.guionar("GET", RUTAS_SIRE.exportar, (p) =>
      p.cabeceras["authorization"] === `Bearer ${A}`
        ? { estado: 401, json: { cod: "401" } }
        : { json: { numTicket: `2026${Math.floor(Math.random() * 1e9)}` } },
    );
    const urlsDePrueba = { seguridad: srv.origen, sire: srv.origen };
    const cache = new CacheTokenSire({
      redis,
      prefijo,
      sireAuth: new HttpSireAuth({ urlsDePrueba }),
      credenciales: async () => ({ ...cred }),
    });
    const api = new HttpSireApiClient({ urlsDePrueba, ahora: reloj.ahora, dormir: reloj.dormir });
    const ctx = { tenantId: randomUUID(), clienteId: randomUUID(), ruc: RUC_FIXTURE };
    const bajar = (token: string) =>
      api.descargarPropuesta({ token, expiraEn: new Date(0) }, { ruc: RUC_FIXTURE, periodo: PERIODO, libro: "ventas" });

    // Ambos obtienen A (single-flight). El segundo usa A recién cuando el primero ya renovó a B.
    const p1 = cache.conToken(ctx, bajar);
    let primera = true;
    const p2 = cache.conToken(ctx, async (token) => {
      if (primera) {
        primera = false;
        await p1.catch(() => undefined);
      }
      return bajar(token);
    });
    const [r1, r2] = await Promise.allSettled([p1, p2]);
    expect([r1.status, r2.status]).toEqual(["fulfilled", "fulfilled"]);
    const pedidos = peticiones(RUTAS_SIRE.token, "POST").length;
    const usados = peticiones(RUTAS_SIRE.exportar).map((x) => (x.cabeceras["authorization"] ?? "").slice(-6));

    const todoRedis = await volcarPrefijo(redis, prefijo);
    for (const s of [A, B, C, secreto, clave])
      for (const x of rastros(s)) expect(todoRedis, "Redis").not.toContain(x);
    expect(pedidos, `tokens pedidos (exportar con …${usados.join(", …")})`).toBe(2);
  });
});
