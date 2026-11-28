import { crearClaves, type ClavesCola } from "@contapp/queue";
import * as sunat from "@contapp/sunat";
import type { SireApiClient, SireAuth } from "@contapp/sunat";
import type { ContappDb } from "@contapp/db";
import { iniciarServidorSireFalso } from "@contapp/sunat/dist/http/pruebas/servidor-sire-falso.js";
import { planEsperaTicket } from "@contapp/sunat/dist/http/ticket.js";
import type { Redis } from "ioredis";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { arrancar007b, esperarTerminal } from "../../../test/procesadores-007b.js";
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
} from "../../../test/sire-http.js";
import { canario, loggerEspia, rastros, volcado } from "../../../test/soporte.js";
import {
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  Escenario,
  esperarHasta,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
  restaurarConfig,
  volcarPrefijo,
  type ProcesoWorker,
} from "../../../test/trabajos.js";
import {
  PERIODO,
  RUC_FIXTURE,
  SireApiControlado,
  contarPropuestas,
  contarVentas,
  encolarDescarga,
  limpiarVentas,
  ventasDe,
  volcarTablasVentas,
  type MundoVentas,
} from "../../../test/ventas.js";
import { AlmacenTicketsRedis } from "../token-sire/almacen-tickets-redis.js";

// Spec 041 · T4 (rojo; integración con PostgreSQL y Redis reales, BullMQ real y el SERVIDOR SUNAT FALSO de T3): el worker con
// `HttpSireAuth` + `HttpSireApiClient` (SIRE_CLIENT=http; CA-1, CA-8, CA-11, CA-12). Se arma el adaptador a mano, como lo hará
// `crearAdaptadores`, con `urlsDePrueba` y reloj/`dormir` falsos: ninguna prueba sale a internet ni duerme.
//
// CONTRATO que fija (T6/T7), además de los de T3 y de `almacen-tickets-redis.int.spec.ts`:
// - `descargarPropuesta` pasa `claveReanudacion = "{tenantId}:{clienteId}"` al puerto; `HttpSireApiClient` la completa con libro, periodo y
//   operación y la entrega al `AlmacenTicketsRedis` del worker, que la guarda en `crearClaves(prefijo).ticketSire(tenant, cliente, libro,
//   periodo, "propuesta")`: la clave lleva estudio Y cliente.
// - 401 de la API → `TokenRechazadoError` → la caché de 008 borra el token, lo pide UNA vez más y reintenta; otro 401 → `ErrorCredencial`
//   (error/credencial_invalida sin reintentos y la credencial `sire_api` queda inválida). 403 → `ErrorCredencial` sin renovar.
//   422 → `ErrorDatos` (datos_invalidos). 5xx → `ErrorTransitorio` (reintentos de 008, sunat_no_responde al agotarse).
// - Ticket que no termina en el presupuesto: se guarda en Redis (TTL ≤ 1 h) y el trabajo falla como transitorio; el reintento retoma el
//   MISMO ticket (el exportar no se repite) y, al terminar, borra la clave. Estado 03 → `ErrorDatos`.
// - Ni el token, ni `client_secret`, ni la clave SOL aparecen en logs, `job_registro`, Redis ni tablas; el token solo viaja en
//   `Authorization` hacia la API y los secretos solo en el cuerpo del POST del token.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

// Los adaptadores HTTP los agrega T6; se leen por nombre para que la prueba compile y falle por «no existe».
const { HttpSireAuth, HttpSireApiClient } = sunat as unknown as {
  HttpSireAuth: new (o?: Record<string, unknown>) => SireAuth;
  HttpSireApiClient: new (o?: Record<string, unknown>) => SireApiClient;
};
type ClavesConTicket = ClavesCola & {
  ticketSire(
    tenantId: string,
    clienteId: string,
    libro: string,
    periodo: string,
    operacion: string,
  ): string;
};

const REINTENTOS = 3;
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
  await fijarConfig(admin, "sire", {
    global: 4,
    tenant: 2,
    espera: 0,
    reintentos: REINTENTOS,
    base: 100,
  });
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
  for (const x of prefijos)
    await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), admin?.close()]);
});

/** ZIP de ventas con el TXT sintético de T1 (8 filas del RUC y el periodo de la prueba). */
const zipVentas = () =>
  zipDe("ventas-propuesta-202610.txt", leerFixture("ventas-propuesta-202610.txt"));
const CLAVES_VENTAS = [
  "01|F001|10",
  "01|F001|11",
  "01|F001|12",
  "01|F001|13",
  "01|F002|1",
  "03|B001|290",
  "03|B001|292",
  "07|F001|1",
];

/** Arranca el worker con el SIRE por HTTP (contra el servidor falso), corre `fn` y lo detiene. */
async function conWorkerHttp<T>(
  fn: (p: ProcesoWorker) => Promise<T>,
  extra: Record<string, unknown> = {},
): Promise<T> {
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
    ...extra,
  } as Parameters<typeof arrancar007b>[0]);
  try {
    return await fn(p);
  } finally {
    await p.detener({ esperaMs: 2000 });
  }
}

async function descargar(m: MundoVentas, timeoutMs = 60_000) {
  const id = await encolarDescarga(backend, redis, prefijo, m, {
    periodo: PERIODO,
    libro: "ventas",
  });
  const f = await esperarTerminal(e, id, timeoutMs);
  return { id, estado: f.estado, motivo: f.motivo, intentos: f.intentos };
}

const peticiones = (ruta: RegExp, metodo = "GET") => srv.peticionesDe(metodo, ruta);
const tokensDe = () => peticiones(RUTAS_SIRE.token, "POST");
const bearer = (t: string) => `Bearer ${t}`;
const claveTicket = (m: MundoVentas, op = "propuesta") =>
  (crearClaves(prefijo) as ClavesConTicket).ticketSire(m.T, m.c.id, "ventas", PERIODO, op);

async function nada(m: MundoVentas): Promise<void> {
  expect(await contarPropuestas(admin, m.c.id), "propuestas").toBe(0);
  expect(await contarVentas(admin, m.c.id, PERIODO), "ventas").toBe(0);
}

// ---------------------------------------------------------------------------------------------------------------
describe("claveReanudacion (CA-8)", () => {
  it("el procesador la pasa al puerto con estudio y cliente (con el mock de SireApiClient)", async () => {
    const m = await mundoSireHttp(e, backend, { ruc: RUC_FIXTURE });
    const api = new SireApiControlado();
    const p = await arrancar007b({ prefijo, sireApi: api } as Parameters<typeof arrancar007b>[0]);
    try {
      const id = await encolarDescarga(backend, redis, prefijo, m);
      expect((await esperarTerminal(e, id)).estado).toBe("completado");
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
    expect(api.llamadas).toHaveLength(1);
    expect(api.llamadas[0]!.solicitud).toEqual({
      ruc: RUC_FIXTURE,
      periodo: PERIODO,
      libro: "ventas",
      claveReanudacion: `${m.T}:${m.c.id}`,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("CA-1/CA-2: descarga completa con SIRE_CLIENT=http", () => {
  it("token → exportar → ticket → archivo: guarda las 8 filas del TXT y el token solo viaja en Authorization a la API", async () => {
    const m = await mundoSireHttp(e, backend, { ruc: RUC_FIXTURE });
    const TOKEN = canario("token_sire");
    guionarSire(srv, { tokens: [TOKEN], periodo: PERIODO, zip: zipVentas() });

    const r = await conWorkerHttp(() => descargar(m));
    expect([r.estado, r.motivo, r.intentos]).toEqual(["completado", null, 0]);

    const ventas = await ventasDe(admin, m.c.id);
    expect(ventas.map((v) => v.clave).sort()).toEqual(CLAVES_VENTAS);
    expect(await contarPropuestas(admin, m.c.id)).toBe(1);
    const por = new Map(ventas.map((v) => [v.clave, v]));
    expect(por.get("01|F001|11")).toMatchObject({ base_gravada: "1837.50", igv: "330.75", total: "2168.25" });
    expect(por.get("07|F001|1")).toMatchObject({ base_gravada: "-50.00", total: "-59.00" });
    expect(por.get("03|B001|290")).toMatchObject({ doc_contraparte: "-", total: "118.00" });

    // Un solo token, un exportar, el ticket por su número exacto y el archivo del ticket (ventas = codLibro 140000).
    expect(tokensDe()).toHaveLength(1);
    const exportar = peticiones(RUTAS_SIRE.exportar);
    expect(exportar).toHaveLength(1);
    const consultas = peticiones(RUTAS_SIRE.ticket);
    expect(consultas.length).toBeGreaterThanOrEqual(1);
    const numTicket = consultas[0]!.query["numTicket"];
    expect(numTicket).toMatch(/^\d+$/);
    expect(consultas.every((c) => c.query["numTicket"] === numTicket)).toBe(true);
    const archivo = peticiones(RUTAS_SIRE.archivo);
    expect(archivo).toHaveLength(1);
    expect(archivo[0]!.query).toMatchObject({ numTicket, codLibro: "140000", perTributario: PERIODO });
    for (const p of [...exportar, ...consultas, ...archivo])
      expect(p.cabeceras["authorization"], p.ruta).toBe(bearer(TOKEN));
    expect(srv.sinGuion).toEqual([]);

    // El formulario del token lleva los 6 campos (CA-2) y ninguna cabecera Authorization.
    const t = tokensDe()[0]!;
    expect(t.cabeceras["authorization"]).toBeUndefined();
    expect(t.formulario).toEqual({
      grant_type: "password",
      scope: "https://api-sire.sunat.gob.pe",
      client_id: m.secretos.clientId,
      client_secret: m.secretos.clientSecret,
      username: `${RUC_FIXTURE}${m.secretos.usuario}`,
      password: m.secretos.clave,
    });
    expect(t.ruta).toBe(`/v1/clientessol/${m.secretos.clientId}/oauth2/token/`);
    // Los secretos no viajan en ninguna petición a la API (ruta, query, cuerpo ni cabeceras).
    for (const p of [...exportar, ...consultas, ...archivo]) {
      const texto = JSON.stringify(p);
      for (const s of [m.secretos.clientSecret, m.secretos.clave])
        expect(texto, p.ruta).not.toContain(s);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("CA-11: 401 → una renovación del token", () => {
  it("el primer token es rechazado: la caché pide uno nuevo UNA vez y la descarga termina bien", async () => {
    const m = await mundoSireHttp(e, backend, { ruc: RUC_FIXTURE });
    const A = canario("token_A");
    const B = canario("token_B");
    guionarSire(srv, { tokens: [A, B], periodo: PERIODO, zip: zipVentas(), rechazarPrimerToken: true });

    const r = await conWorkerHttp(() => descargar(m));
    expect([r.estado, r.motivo, r.intentos]).toEqual(["completado", null, 0]);

    expect(tokensDe()).toHaveLength(2);
    const exportar = peticiones(RUTAS_SIRE.exportar);
    expect(exportar.map((p) => p.cabeceras["authorization"])).toEqual([bearer(A), bearer(B)]);
    // Con el token nuevo el resto del flujo sigue con B.
    for (const p of [...peticiones(RUTAS_SIRE.ticket), ...peticiones(RUTAS_SIRE.archivo)])
      expect(p.cabeceras["authorization"], p.ruta).toBe(bearer(B));
    expect((await ventasDe(admin, m.c.id)).map((v) => v.clave).sort()).toEqual(CLAVES_VENTAS);
  });

  it("el token nuevo también es rechazado: error/credencial_invalida sin más reintentos, exactamente 2 tokens y nada guardado", async () => {
    const m = await mundoSireHttp(e, backend, { ruc: RUC_FIXTURE });
    guionarSire(srv, { tokens: [canario("tA"), canario("tB")], periodo: PERIODO, zip: zipVentas() });
    srv.guionar("GET", RUTAS_SIRE.exportar, { estado: 401, json: { cod: "401" } });

    const r = await conWorkerHttp(() => descargar(m));
    expect([r.estado, r.motivo, r.intentos]).toEqual(["error", "credencial_invalida", 0]);
    expect(tokensDe()).toHaveLength(2);
    expect(peticiones(RUTAS_SIRE.exportar)).toHaveLength(2);
    expect((await e.credencialEstado(m.c.id, "sire_api"))?.estado).toBe("invalida");
    await nada(m);
  });

  it("403 de la API: error/credencial_invalida sin renovar el token", async () => {
    const m = await mundoSireHttp(e, backend, { ruc: RUC_FIXTURE });
    guionarSire(srv, { tokens: [canario("t")], periodo: PERIODO, zip: zipVentas() });
    srv.guionar("GET", RUTAS_SIRE.exportar, { estado: 403, json: { cod: "403" } });

    const r = await conWorkerHttp(() => descargar(m));
    expect([r.estado, r.motivo, r.intentos]).toEqual(["error", "credencial_invalida", 0]);
    expect(tokensDe()).toHaveLength(1);
    expect(peticiones(RUTAS_SIRE.exportar)).toHaveLength(1);
    await nada(m);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("CA-11/CA-8: otros errores de la API", () => {
  it("422 al exportar: error/datos_invalidos sin reintentos", async () => {
    const m = await mundoSireHttp(e, backend, { ruc: RUC_FIXTURE });
    guionarSire(srv, { tokens: [canario("t")], periodo: PERIODO, zip: zipVentas() });
    srv.guionar("GET", RUTAS_SIRE.exportar, { estado: 422, json: { cod: "422" } });

    const r = await conWorkerHttp(() => descargar(m));
    expect([r.estado, r.motivo, r.intentos]).toEqual(["error", "datos_invalidos", 0]);
    expect(peticiones(RUTAS_SIRE.exportar)).toHaveLength(1);
    await nada(m);
  });

  it("503 al exportar: reintentos de 008 y, agotados, error/sunat_no_responde sin guardar nada", async () => {
    const m = await mundoSireHttp(e, backend, { ruc: RUC_FIXTURE });
    guionarSire(srv, { tokens: [canario("t")], periodo: PERIODO, zip: zipVentas() });
    srv.guionar("GET", RUTAS_SIRE.exportar, { estado: 503, texto: "no disponible" });

    const r = await conWorkerHttp(() => descargar(m));
    expect([r.estado, r.motivo]).toEqual(["error", "sunat_no_responde"]);
    expect(r.intentos).toBe(REINTENTOS);
    expect(peticiones(RUTAS_SIRE.exportar)).toHaveLength(1 + REINTENTOS);
    // El token de la caché se reutiliza entre intentos: un 503 no lo invalida.
    expect(tokensDe()).toHaveLength(1);
    await nada(m);
  });

  it("ticket en estado 03: error/datos_invalidos sin reintentos y sin dejar el ticket en Redis", async () => {
    const m = await mundoSireHttp(e, backend, { ruc: RUC_FIXTURE });
    guionarSire(srv, {
      tokens: [canario("t")],
      periodo: PERIODO,
      zip: zipVentas(),
      estadoTicket: () => "03",
    });

    const r = await conWorkerHttp(() => descargar(m));
    expect([r.estado, r.motivo, r.intentos]).toEqual(["error", "datos_invalidos", 0]);
    expect(peticiones(RUTAS_SIRE.exportar)).toHaveLength(1);
    expect(peticiones(RUTAS_SIRE.archivo)).toHaveLength(0);
    expect(await redis.exists(claveTicket(m))).toBe(0);
    await nada(m);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("CA-8: ticket que no termina (P-4 c)", () => {
  it("se guarda en Redis con estudio y cliente, el reintento retoma el mismo ticket sin exportar de nuevo y al terminar se borra", async () => {
    const m = await mundoSireHttp(e, backend, { ruc: RUC_FIXTURE });
    const TOKEN = canario("token_sire");
    // Sin depender de tiempos reales ni de cuándo la prueba «mire» a Redis: el guion cuenta consultas. Las del PRIMER intento
    // (una por cada espera del plan y una final) responden «en proceso»; la primera del reintento queda retenida en el
    // servidor falso hasta que la prueba suelta la compuerta, y entonces responde «listo».
    const plan = planEsperaTicket();
    const consultasPrimerIntento = plan.length + 1;
    const sumaPlan = plan.reduce((a, b) => a + b, 0);
    let recibidas = 0;
    let soltar!: () => void;
    const compuerta = new Promise<void>((res) => (soltar = res));
    guionarSire(srv, { tokens: [TOKEN], periodo: PERIODO, zip: zipVentas() });
    srv.guionar("GET", RUTAS_SIRE.ticket, (p) => {
      const n = ++recibidas;
      const numTicket = p.query["numTicket"] ?? "";
      return n <= consultasPrimerIntento
        ? { json: registroTicket(numTicket, "02", PERIODO) }
        : { json: registroTicket(numTicket, "06", PERIODO), hasta: compuerta };
    });

    const clave = claveTicket(m);
    const r = await conWorkerHttp(async () => {
      const id = await encolarDescarga(backend, redis, prefijo, m, { periodo: PERIODO, libro: "ventas" });
      // El primer intento agotó su plan de espera (todas sus consultas respondieron «en proceso») y el reintento ya consulta
      // el ticket guardado (retenido en la compuerta): el ticket pendiente está en Redis y nada puede terminar todavía.
      await esperarHasta(
        async () => recibidas > consultasPrimerIntento && (await redis.get(clave)) !== null,
        "el primer intento agotó su sondeo, el ticket pendiente sigue en Redis y el reintento lo retoma",
        { timeoutMs: 30_000 },
      );
      const numTicket = (await redis.get(clave))!;
      expect(numTicket).toMatch(/^\d+$/);
      const ttl = await redis.pttl(clave);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(3_600_000);
      // La clave lleva el estudio y el cliente (y solo ese ticket existe para este trabajo).
      expect(clave).toContain(m.T);
      expect(clave).toContain(m.c.id);
      expect(await redis.keys(`${prefijo}sire:ticket:*`)).toEqual([clave]);
      expect(await redis.exists(`${prefijo}sire:ticket:${m.T}:${m.c.id}:ventas:${PERIODO}:propuesta`)).toBe(1);
      // El sondeo no durmió de verdad: el reloj falso avanzó exactamente el plan del primer intento.
      expect(reloj.dormidos.length).toBeGreaterThan(0);
      expect(reloj.dormidos.reduce((a, b) => a + b, 0)).toBe(sumaPlan);
      // Hasta aquí hubo un solo exportar (el reintento no exporta de nuevo) y el ticket no se ha borrado.
      expect(peticiones(RUTAS_SIRE.exportar)).toHaveLength(1);

      soltar();
      const f = await esperarTerminal(e, id, 60_000);
      return { f, numTicket };
    });

    expect([r.f.estado, r.f.motivo]).toEqual(["completado", null]);
    expect(r.f.intentos).toBe(1);
    // Un solo exportar en todo el trabajo: los reintentos retoman el ticket guardado.
    expect(peticiones(RUTAS_SIRE.exportar)).toHaveLength(1);
    const consultas = peticiones(RUTAS_SIRE.ticket);
    expect(consultas.every((c) => c.query["numTicket"] === r.numTicket)).toBe(true);
    expect(peticiones(RUTAS_SIRE.archivo)).toHaveLength(1);
    expect(await redis.exists(clave)).toBe(0);
    expect((await ventasDe(admin, m.c.id)).map((v) => v.clave).sort()).toEqual(CLAVES_VENTAS);
    expect(await contarPropuestas(admin, m.c.id)).toBe(1);
  });

  it("un ticket guardado de otro estudio con el mismo RUC no se retoma: se exporta de nuevo", async () => {
    const ajeno = await mundoSireHttp(e, backend, { ruc: RUC_FIXTURE });
    const m = await mundoSireHttp(e, backend, { ruc: RUC_FIXTURE });
    guionarSire(srv, { tokens: [canario("t")], periodo: PERIODO, zip: zipVentas() });
    // Ticket pendiente de OTRO estudio (mismo RUC y periodo) ya guardado.
    await redis.set(claveTicket(ajeno), "20269999999999", "PX", 600_000);

    const r = await conWorkerHttp(() => descargar(m));
    expect([r.estado, r.motivo]).toEqual(["completado", null]);
    expect(peticiones(RUTAS_SIRE.exportar)).toHaveLength(1);
    expect(peticiones(RUTAS_SIRE.ticket).every((c) => c.query["numTicket"] !== "20269999999999")).toBe(true);
    // El ticket del otro estudio sigue intacto.
    expect(await redis.get(claveTicket(ajeno))).toBe("20269999999999");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("CA-12: secretos", () => {
  it("ni el token, ni client_secret, ni la clave SOL aparecen en logs, job_registro, Redis ni tablas (éxito, 401 repetido, 503 y ticket pendiente)", async () => {
    const ok = await mundoSireHttp(e, backend, { ruc: RUC_FIXTURE });
    const rechazado = await mundoSireHttp(e, backend, { ruc: RUC_FIXTURE });
    const caido = await mundoSireHttp(e, backend, { ruc: RUC_FIXTURE });
    const lento = await mundoSireHttp(e, backend, { ruc: RUC_FIXTURE });
    const TOKEN = canario("token_sire");
    const secretos = [
      TOKEN,
      ...[ok, rechazado, caido, lento].flatMap((m) => [m.secretos.clave, m.secretos.clientSecret]),
    ];
    const { logger, llamadas } = loggerEspia();
    const capturado: string[] = [];
    const espias = (["log", "info", "warn", "error", "debug"] as const).map((n) =>
      vi.spyOn(console, n).mockImplementation((...a: unknown[]) => void capturado.push(volcado(a))),
    );
    const stdoutOrig = process.stdout.write;
    const stderrOrig = process.stderr.write;
    const capturar = (orig: typeof process.stdout.write) =>
      ((chunk: unknown, ...resto: unknown[]) => {
        capturado.push(String(chunk));
        return (orig as (...a: unknown[]) => boolean).call(process.stdout, chunk, ...resto);
      }) as typeof process.stdout.write;
    process.stdout.write = capturar(stdoutOrig);
    process.stderr.write = capturar(stderrOrig);

    try {
      await conWorkerHttp(
        async () => {
          guionarSire(srv, { tokens: [TOKEN], periodo: PERIODO, zip: zipVentas() });
          expect((await descargar(ok)).estado).toBe("completado");

          srv.guionar("GET", RUTAS_SIRE.exportar, { estado: 401, json: { cod: "401", token: TOKEN } });
          expect((await descargar(rechazado)).motivo).toBe("credencial_invalida");

          srv.guionar("GET", RUTAS_SIRE.exportar, { estado: 503, texto: `caído ${TOKEN}` });
          expect((await descargar(caido)).motivo).toBe("sunat_no_responde");

          // Ticket pendiente: queda su número en Redis; el trabajo se cancela de la cola al detener el worker.
          guionarSire(srv, { tokens: [TOKEN], periodo: PERIODO, zip: zipVentas(), estadoTicket: () => "02" });
          const id = await encolarDescarga(backend, redis, prefijo, lento, { periodo: PERIODO, libro: "ventas" });
          await esperarHasta(async () => (await redis.exists(claveTicket(lento))) === 1, "ticket pendiente guardado", {
            timeoutMs: 30_000,
          });
          srv.guionar("GET", RUTAS_SIRE.ticket, { json: registroTicket("1", "03", PERIODO) });
          await esperarTerminal(e, id, 60_000);
        },
        { logger },
      );

      // El token sí circuló (la prueba no es vacua) y solo en el sitio permitido.
      expect(peticiones(RUTAS_SIRE.exportar).every((p) => p.cabeceras["authorization"] === bearer(TOKEN))).toBe(true);
      for (const p of tokensDe()) expect(p.cabeceras["authorization"]).toBeUndefined();

      const jobs = await e.volcarJobs();
      const todoRedis = await volcarPrefijo(redis, prefijo);
      const logs = volcado(llamadas) + "\n" + capturado.join("\n");
      const tablas = await volcarTablasVentas(admin, e.estudios);
      for (const s of secretos)
        for (const x of rastros(s)) {
          expect(jobs, "job_registro").not.toContain(x);
          expect(todoRedis, "Redis").not.toContain(x);
          expect(logs, "logs").not.toContain(x);
          expect(tablas, "tablas").not.toContain(x);
        }
      expect(llamadas.length, "el worker sí registra eventos").toBeGreaterThan(0);
    } finally {
      process.stdout.write = stdoutOrig;
      process.stderr.write = stderrOrig;
      for (const s of espias) s.mockRestore();
    }
  });
});

// El POST del token solo puede ir al host de seguridad; con un solo servidor el log distingue por ruta.
describe("CA-12: cada petición va a su ruta", () => {
  it("el POST del token no lleva el token y los GET de la API no llevan secretos", async () => {
    const m = await mundoSireHttp(e, backend, { ruc: RUC_FIXTURE });
    const TOKEN = canario("token_sire");
    guionarSire(srv, { tokens: [TOKEN], periodo: PERIODO, zip: zipVentas() });
    srv.guionar("POST", RUTAS_SIRE.token, respuestaToken(TOKEN));
    await conWorkerHttp(() => descargar(m));
    for (const p of srv.peticiones) {
      if (RUTAS_SIRE.token.test(p.ruta)) {
        expect(p.metodo).toBe("POST");
        expect(JSON.stringify(p)).not.toContain(TOKEN);
      } else {
        expect(p.metodo).toBe("GET");
        expect(p.cuerpo).toBe("");
      }
    }
  });
});
