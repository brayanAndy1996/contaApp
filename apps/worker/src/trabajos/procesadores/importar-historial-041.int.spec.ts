import { crearClaves, type ClavesCola } from "@contapp/queue";
import * as sunat from "@contapp/sunat";
import type { SireApiClient, SireAuth } from "@contapp/sunat";
import type { ContappDb } from "@contapp/db";
import { iniciarServidorSireFalso } from "@contapp/sunat/dist/http/pruebas/servidor-sire-falso.js";
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
import {
  arrancar007b,
  esperarTerminal,
} from "../../../test/procesadores-007b.js";
import { limpiarCompras } from "../../../test/compras.js";
import {
  candidatasDe,
  encolarImportacion,
  importacionDe,
  iniciarImportacion,
  limpiarAprendizaje,
  volcarTablasAprendizaje,
} from "../../../test/importar-historial.js";
import { limpiarReglas } from "../../../test/reglas.js";
import {
  RelojSire,
  RUTAS_SIRE,
  leerFixture,
  mundoSireHttp,
  registroTicket,
  respuestaToken,
  zipRegistroRealDe,
  type ServidorSireFalso,
} from "../../../test/sire-http.js";
import {
  canario,
  loggerEspia,
  rastros,
  volcado,
} from "../../../test/soporte.js";
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
import { PERIODO, RUC_FIXTURE } from "../../../test/ventas.js";
import { AlmacenTicketsRedis } from "../token-sire/almacen-tickets-redis.js";

// Spec 041 · T17 (verificación de CA-13; integración con PostgreSQL y Redis reales, BullMQ real y el SERVIDOR SUNAT FALSO de T3):
// `reglas.historial.importar` (spec 025) con `SIRE_CLIENT=http` lee el REGISTRO PRESENTADO de compras (servicio 5.51 + 5.31 + 5.32,
// codLibro 080000, plan «P-3») con `HttpSireAuth` + `HttpSireApiClient`, sin salir a internet ni dormir.
// Rediseño CA-13 (corrida real de contrato): `codMoneda` NO FILTRA en el 5.51 (con PEN el archivo trae todos los comprobantes, USD
// incluidos). UNA sola solicitud por periodo (`codProceso=70`, `codMoneda=PEN`), un solo ticket, un solo archivo; sin unión ni
// verificación de moneda por fila; la clave del ticket es `…:registro` (ya no existen `registro-pen` ni `registro-usd`).
// Fixture: `fixtures/sire/http/compras-registro-202610-mixto.txt` (PEN y una fila USD; RUC 20700000002 y proveedores de
// `fixtures/rucs-prueba.json`).

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

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

const RUTA_REGISTRO = /\/solicitardescarga$/;
const PERIODO_SIN_REGISTRO = "202609";
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
  await limpiarAprendizaje(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarReglas(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarCompras(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  for (const x of prefijos)
    await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), admin?.close()]);
});

/** Archivo único del registro del periodo: comprobantes PEN y una fila USD (el 5.51 no filtra por moneda). */
const FIXTURE_REGISTRO = "compras-registro-202610-mixto.txt";
const NOMBRE_ZIP = "registro-202610.zip";
const zipRegistro = () =>
  zipRegistroRealDe("20700000002-registro-202610", leerFixture(FIXTURE_REGISTRO));

/**
 * Token, solicitud 5.51 (PERIODO con registro; PERIODO_SIN_REGISTRO responde 422 «sin datos»), ticket 06 con el único ZIP del
 * registro y archivo.
 */
function guionarRegistro(token: string): void {
  let n = 0;
  srv.guionar("POST", RUTAS_SIRE.token, respuestaToken(token));
  srv.guionar("GET", RUTA_REGISTRO, (p) => {
    if (p.ruta.includes(`/${PERIODO_SIN_REGISTRO}/`))
      return { estado: 422, json: { errors: [{ cod: "1070", msg: "sin datos" }] } };
    return { json: { numTicket: `2026100000${String(++n).padStart(4, "0")}` } };
  });
  srv.guionar("GET", RUTAS_SIRE.ticket, (p) => ({
    json: registroTicket(p.query["numTicket"] ?? "", "06", PERIODO, {
      archivos: [{ nom: NOMBRE_ZIP, cod: "00" }],
    }),
  }));
  srv.guionar("GET", RUTAS_SIRE.archivo, () => ({ bytes: zipRegistro() }));
}

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

describe("CA-13: importar historial con registro presentado y SIRE_CLIENT=http", () => {
  it("lee el registro presentado de dos periodos (uno sin datos) contra el servidor falso: una sola solicitud 5.51 y un solo ticket por periodo, archivo mixto PEN+USD completo, clave registro borrada, candidatas y sin secretos", async () => {
    const m = await mundoSireHttp(e, backend, { ruc: RUC_FIXTURE });
    const TOKEN = canario("token_sire");
    guionarRegistro(TOKEN);
    const espia = loggerEspia();

    const periodos = [PERIODO_SIN_REGISTRO, PERIODO];
    const importacionId = await iniciarImportacion(backend, m, periodos);
    const r = await conWorkerHttp(
      async () => {
        const trabajoId = await encolarImportacion(
          backend,
          redis,
          prefijo,
          m,
          importacionId,
        );
        return esperarTerminal(e, trabajoId, 60_000);
      },
      { logger: espia.logger },
    );
    expect([r.estado, r.motivo, r.intentos]).toEqual(["completado", null, 0]);

    // La importación se completa: un periodo leído, otro «sin datos», y candidatas por proveedor del TXT de prueba.
    const imp = await importacionDe(admin, importacionId);
    expect(imp.estado).toBe("completada");
    expect(imp.periodos_leidos).toBe(1);
    expect(imp.periodos_sin_datos).toEqual([PERIODO_SIN_REGISTRO]);
    const cand = await candidatasDe(admin, { importacionId });
    expect(cand.length).toBe(imp.candidatas);
    const docs = cand.map((c) => c.doc_numero);
    expect(docs).toEqual(
      expect.arrayContaining([
        "20700000011",
        "20700000045",
        "20700000053",
        "20700000061",
        "20700000070",
        "20700000096",
      ]),
    );
    expect(
      cand.every(
        (c) => c.razon_social === null || c.razon_social.startsWith("PRUEBA"),
      ),
    ).toBe(true);
    // El archivo mixto se importa completo, sin unión ni verificación de moneda por fila: la fila USD (proveedor 20700000061) entra
    // igual que las PEN. El proveedor mixto aparece en dos comprobantes PEN (F001-2056 y F003-20).
    expect(cand.find((c) => c.doc_numero === "20700000061")).toMatchObject({ n_total: 1 });
    const mixto = cand.find((c) => c.doc_numero === "20700000045");
    expect(mixto).toMatchObject({ periodos_con_proveedor: 1 });
    expect(mixto!.n_total).toBeGreaterThanOrEqual(2);

    // Un solo token para toda la importación; el registro se pide por el servicio 5.51 (nunca el de la propuesta).
    expect(srv.peticionesDe("POST", RUTAS_SIRE.token)).toHaveLength(1);
    expect(srv.peticionesDe("GET", RUTAS_SIRE.exportar)).toHaveLength(0);
    const solicitudes = srv.peticionesDe("GET", RUTA_REGISTRO);
    const con = solicitudes.filter((p) => p.ruta.includes(`/${PERIODO}/`));
    const sin = solicitudes.filter((p) =>
      p.ruta.includes(`/${PERIODO_SIN_REGISTRO}/`),
    );
    // 5.51 UNA sola vez por periodo, con codMoneda PEN y siempre codProceso 70 (nunca 01/02, nunca USD).
    expect(con.map((p) => p.query["codMoneda"])).toEqual(["PEN"]);
    expect(sin.map((p) => p.query["codMoneda"])).toEqual(["PEN"]);
    expect(solicitudes).toHaveLength(2);
    for (const p of solicitudes) {
      expect(p.query["codProceso"], p.ruta).toBe("70");
      expect(p.query["codTipoArchivo"], p.ruta).toBe("0");
      expect(p.query["codOrigen"], p.ruta).toBe("2");
    }
    // Un ticket y un archivo para el periodo con registro; el periodo sin datos no consulta ticket ni archivo.
    expect(srv.peticionesDe("GET", RUTAS_SIRE.ticket)).toHaveLength(1);
    const archivo = srv.peticionesDe("GET", RUTAS_SIRE.archivo);
    expect(archivo.map((p) => p.query["nomArchivoReporte"])).toEqual([NOMBRE_ZIP]);
    for (const p of archivo)
      expect(p.query).toMatchObject({
        codLibro: "080000",
        perTributario: PERIODO,
      });
    for (const p of [
      ...solicitudes,
      ...srv.peticionesDe("GET", RUTAS_SIRE.ticket),
      ...archivo,
    ])
      expect(p.cabeceras["authorization"], p.ruta).toBe(`Bearer ${TOKEN}`);
    expect(srv.sinGuion).toEqual([]);

    // El ticket terminado se borra de Redis (la clave lleva estudio, cliente, libro, periodo y la operación «registro»).
    for (const per of periodos)
      expect(
        await redis.exists(
          (crearClaves(prefijo) as ClavesConTicket).ticketSire(m.T, m.c.id, "compras", per, "registro"),
        ),
        per,
      ).toBe(0);

    // Ni el token ni los secretos de la credencial aparecen en logs, tablas, job_registro ni Redis.
    const jobs = await e.volcarJobs();
    const todoRedis = await volcarPrefijo(redis, prefijo);
    const logs = volcado(espia.llamadas);
    const tablas = await volcarTablasAprendizaje(admin, [m.T]);
    for (const sec of [TOKEN, m.secretos.clave, m.secretos.clientSecret])
      for (const x of rastros(sec)) {
        expect(jobs, "job_registro").not.toContain(x);
        expect(todoRedis, "Redis").not.toContain(x);
        expect(logs, "logs").not.toContain(x);
        expect(tablas, "tablas").not.toContain(x);
      }
    expect(
      espia.llamadas.length,
      "el worker sí registra eventos",
    ).toBeGreaterThan(0);
  });

  it("registro pendiente: guarda el ticket `registro` en Redis y el reintento lo retoma sin repetir el 5.51", async () => {
    const m = await mundoSireHttp(e, backend, { ruc: RUC_FIXTURE });
    const TOKEN = canario("token_sire");
    const claveRegistro = (crearClaves(prefijo) as ClavesConTicket).ticketSire(
      m.T,
      m.c.id,
      "compras",
      PERIODO,
      "registro",
    );
    const TICKET = "202610000098";
    srv.guionar("POST", RUTAS_SIRE.token, respuestaToken(TOKEN));
    srv.guionar("GET", RUTA_REGISTRO, () => ({ json: { numTicket: TICKET } }));
    srv.guionar("GET", RUTAS_SIRE.ticket, (p) => ({
      json: registroTicket(p.query["numTicket"] ?? "", "02", PERIODO),
    }));
    srv.guionar("GET", RUTAS_SIRE.archivo, () => ({ bytes: zipRegistro() }));

    const importacionId = await iniciarImportacion(backend, m, [PERIODO]);
    const r = await conWorkerHttp(async () => {
      const trabajoId = await encolarImportacion(
        backend,
        redis,
        prefijo,
        m,
        importacionId,
      );
      await esperarHasta(
        async () => (await redis.exists(claveRegistro)) === 1,
        "ticket de registro guardado",
        { timeoutMs: 30_000 },
      );
      expect(await redis.get(claveRegistro)).toBe(TICKET);
      // El ticket termina: el siguiente intento del trabajo lo retoma (sin volver a pedir el 5.51).
      srv.guionar("GET", RUTAS_SIRE.ticket, (p) => ({
        json: registroTicket(p.query["numTicket"] ?? "", "06", PERIODO, {
          archivos: [{ nom: NOMBRE_ZIP, cod: "00" }],
        }),
      }));
      return esperarTerminal(e, trabajoId, 60_000);
    });
    expect(r.estado).toBe("completado");
    const solicitudes = srv.peticionesDe("GET", RUTA_REGISTRO);
    expect(solicitudes.map((p) => p.query["codMoneda"])).toEqual(["PEN"]);
    expect(await redis.exists(claveRegistro)).toBe(0);
    expect((await importacionDe(admin, importacionId)).estado).toBe(
      "completada",
    );
    // El ticket guardado es solo el número: ni el token ni los secretos de la credencial pasan por Redis.
    const todoRedis = await volcarPrefijo(redis, prefijo);
    for (const sec of [TOKEN, m.secretos.clave, m.secretos.clientSecret])
      for (const x of rastros(sec)) expect(todoRedis, "Redis").not.toContain(x);
  });
});
