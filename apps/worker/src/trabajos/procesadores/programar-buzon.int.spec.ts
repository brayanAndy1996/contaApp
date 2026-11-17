import type { ContappDb, Tx } from "@contapp/db";
import { crearColaSistema } from "@contapp/queue/worker";
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
  EscenarioBuzon,
  PortalControlado,
  ProgramacionGuardada,
  encolarRevisar,
  estadoDeCaptura,
  terminarTrabajosBuzon,
  trabajosRevisar,
  type ClientePrueba,
} from "../../../test/buzon.js";
import type { LoggerTrabajos } from "../registro.js";
import { programarBuzon, type ResultadoCicloBuzon } from "./programar-buzon.js";
import { limpiarFilas017 } from "../../../test/notificaciones.js";
import { canario, loggerEspia } from "../../../test/soporte.js";
import {
  arrancar,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  dormir,
  esperarHasta,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
  opcionesBull,
  restaurarConfig,
  volcarPrefijo,
} from "../../../test/trabajos.js";

// Spec 023, T5 (rojo; integración con PostgreSQL y Redis reales): el programador `buzon.programar` (D-5, P-2; CA-1, CA-2, CA-10,
// CA-11). El tiempo sale de la BD: las pruebas lo fijan con filas de `buzon_programacion` y `buzon_estado_cliente` (como
// `contapp_migrator`), sin dormir. Cada prueba tiene su propio escenario (todo estudio con suscripción vigente entra al ciclo).
// CONTRATO que fija (T12): el de test/buzon.ts (cabecera): `programarBuzon(deps)` devuelve la función de un tick con
// `ResultadoCicloBuzon = {tomado, estudios, encolados, perdioCandado}`, más el caso `buzon.programar` de `procesarSistema` y
// `BUZON_PROGRAMADOR=off` en `iniciarTrabajos`. Lo encolado: `sol.buzon.revisar`, prioridad `programado`, `creado_por` nulo,
// y `ultima_programada_en` consumida; nada para archivados, sin credencial SOL, con ella `invalida`, estudios sin suscripción
// activa o con prueba vencida ni clientes con una captura viva.

vi.setConfig({ testTimeout: 150_000, hookTimeout: 60_000 });

type Tick = () => Promise<ResultadoCicloBuzon>;

let admin: ContappDb;
let backend: ContappDb;
let worker: ContappDb;
let redis: Redis;
let e: EscenarioBuzon;
let prog: ProgramacionGuardada;
let prefijo = nuevoPrefijo();
const prefijos = [prefijo];
let entornoAnterior: string | undefined;

beforeAll(async () => {
  entornoAnterior = process.env.BUZON_PROGRAMADOR;
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  worker = crearDbRol("contapp_worker", 8);
  redis = conectarRedis();
  prog = new ProgramacionGuardada(admin);
  await prog.guardar();
});

beforeEach(async () => {
  process.env.BUZON_PROGRAMADOR = "off";
  prefijo = nuevoPrefijo();
  prefijos.push(prefijo);
  e = new EscenarioBuzon(admin);
  await fijarConfig(admin, "sol", {
    global: 2,
    tenant: 1,
    espera: 0,
    reintentos: 2,
    base: 100,
    maxPendientes: 2000,
  });
});

afterEach(async () => {
  await limpiarFilas017(admin, e.estudios).catch(() => undefined);
  await e.limpiar();
  await prog.restaurar();
});

afterAll(async () => {
  if (entornoAnterior === undefined) delete process.env.BUZON_PROGRAMADOR;
  else process.env.BUZON_PROGRAMADOR = entornoAnterior;
  await restaurarConfig(admin).catch(() => undefined);
  for (const x of prefijos)
    await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), worker?.close(), admin?.close()]);
});

// ---------------------------------------------------------------------------------------------------------------
// Soporte local
// ---------------------------------------------------------------------------------------------------------------

/**
 * Las suites con BD comparten la base: `sistema.estudios_buzon()` devuelve los estudios de TODAS. El programador de la prueba
 * solo atiende los que sembró esta prueba (`e.estudios`), así que sus conteos (`estudios`, `encolados`) no dependen de lo que
 * haya en la base. Todo lo demás (candado, intervalo, cola) pasa tal cual.
 */
function soloMisEstudios(base: ContappDb): ContappDb {
  const propios = (tx: Tx): Tx =>
    new Proxy(tx, {
      get(t, p, r) {
        if (p === "query")
          return async (texto: unknown, ...resto: unknown[]) => {
            const res = await (
              t.query as unknown as (...a: unknown[]) => Promise<{
                rows: { tenant_id?: unknown }[];
              }>
            )(texto, ...resto);
            if (typeof texto !== "string" || !texto.includes("estudios_buzon"))
              return res;
            const mios = new Set(e.estudios);
            return {
              ...res,
              rows: res.rows.filter((f) => mios.has(String(f.tenant_id))),
            };
          };
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  return new Proxy(base, {
    get(t, p, r) {
      if (p === "withSistema")
        return <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
          t.withSistema((tx) => fn(propios(tx)));
      const v = Reflect.get(t, p, r);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

/** Una instancia del programador (un «proceso» con su dueño propio). */
async function instancia(
  o: { db?: ContappDb; logger?: LoggerTrabajos; dueno?: string } = {},
): Promise<Tick> {
  return programarBuzon({
    db: soloMisEstudios(o.db ?? worker),
    redis,
    prefijo,
    ...(o.logger === undefined ? {} : { logger: o.logger }),
    ...(o.dueno === undefined ? {} : { dueno: o.dueno }),
  });
}

/** Marca la última programación de un cliente (como si ya hubiera entrado en su franja). */
async function programadoHace(
  T: string,
  clienteId: string,
  intervaloSql: string,
): Promise<void> {
  await admin.pool.query(
    `insert into buzon_estado_cliente (tenant_id, cliente_id, ultima_programada_en)
     values ($1, $2, now() - $3::interval)
     on conflict (tenant_id, cliente_id) do update set ultima_programada_en = excluded.ultima_programada_en`,
    [T, clienteId, intervaloSql],
  );
}

const trabajosDe = async (c: ClientePrueba) =>
  trabajosRevisar(admin, { clienteId: c.id });

const solo = <T>(xs: T[]): T => {
  expect(xs).toHaveLength(1);
  return xs[0]!;
};

// ---------------------------------------------------------------------------------------------------------------
// CA-1: a quién encola y cuándo
// ---------------------------------------------------------------------------------------------------------------

describe("CA-1: un ciclo encola solo lo que corresponde", () => {
  it("encola `programado` a los clientes vencidos de estudios vigentes y a nadie más", async () => {
    const S1 = await e.estudioConSub({ estado: "activa" });
    const usuario = await e.usuario(S1, "contador");
    const vencido = await e.clienteBuzon(S1);
    const verificada = await e.clienteBuzon(S1, { cred: "verificada" });
    const archivado = await e.clienteBuzon(S1, { archivado: true });
    const sinCred = await e.clienteBuzon(S1, { cred: null });
    const invalida = await e.clienteBuzon(S1, { cred: "invalida" });
    const soloSire = await e.clienteBuzon(S1, { cred: "solo_sire" });
    const viva = await e.clienteBuzon(S1);
    const yaProgramado = await e.clienteBuzon(S1);
    await programadoHace(S1, yaProgramado.id, "0 seconds");
    const vivaId = await encolarRevisar(
      backend,
      redis,
      prefijo,
      { T: S1, u: usuario, c: viva },
      "programado",
    );
    const S2 = await e.estudioConSub({ estado: null });
    const sinSub = await e.clienteBuzon(S2);
    const S3 = await e.estudioConSub({ estado: "prueba", venceEn: "-1 day" });
    const pruebaVencida = await e.clienteBuzon(S3);
    const S4 = await e.estudioConSub({ estado: "prueba" });
    const enPrueba = await e.clienteBuzon(S4);

    await prog.listoParaTomar(15);
    const ciclo = await instancia();
    const r = await ciclo();
    expect(r).toMatchObject({ tomado: true, perdioCandado: false });
    expect(r.encolados).toBe(3);

    for (const c of [vencido, verificada, enPrueba]) {
      const t = solo(await trabajosDe(c));
      expect(t, "programado, sin usuario").toMatchObject({
        estado: "en_cola",
        prioridad: "programado",
        creado_por: null,
      });
      expect(
        (await estadoDeCaptura(admin, c.id))?.ultima_programada_en,
        "la franja queda consumida",
      ).not.toBeNull();
    }
    for (const [nombre, c] of Object.entries({
      archivado,
      sinCred,
      invalida,
      soloSire,
      sinSub,
      pruebaVencida,
      yaProgramado,
    }))
      expect(await trabajosDe(c), nombre).toHaveLength(0);
    // La captura que ya estaba viva sigue siendo la única.
    expect((await trabajosDe(viva)).map((t) => t.id)).toEqual([vivaId]);
  });

  it("un cliente nunca capturado entra en el ciclo siguiente y no vuelve a entrar en la misma franja", async () => {
    const S = await e.estudioConSub();
    const a = await e.clienteBuzon(S);
    await prog.listoParaTomar(15);
    const ciclo = await instancia();
    expect((await ciclo()).encolados).toBe(1);
    await terminarTrabajosBuzon(admin, [S]);

    // Otro ciclo, ya cumplido el intervalo: la franja de `a` está consumida.
    await prog.listoParaTomar(15);
    expect((await ciclo()).encolados).toBe(0);
    expect(await trabajosDe(a)).toHaveLength(1);
  });

  it("el intervalo del ciclo sale de la BD y un cambio surte efecto en el tick siguiente, sin reiniciar", async () => {
    const S = await e.estudioConSub();
    const a = await e.clienteBuzon(S);
    await prog.listoParaTomar(15);
    await prog.fijar({
      ultimo_ciclo_inicio: new Date(Date.now() - 10 * 60_000),
    });
    const ciclo = await instancia();

    // Pasaron 10 min y el intervalo es de 15: no toca.
    const antes = await ciclo();
    expect(antes).toMatchObject({ tomado: false, encolados: 0 });
    expect(await trabajosDe(a)).toHaveLength(0);

    // El operador baja el intervalo a 5 min: el mismo proceso toma el ciclo.
    await prog.fijar({ intervalo_min: 5 });
    const ahora = await ciclo();
    expect(ahora).toMatchObject({ tomado: true, encolados: 1 });
    const f = await prog.leer();
    expect(f.ciclo_hasta, "soltó el candado al terminar").toBeNull();
    expect(f.ultimo_ciclo_fin).not.toBeNull();

    // Un cliente nuevo inmediatamente después: el intervalo desde el ciclo anterior aún no pasa.
    const b = await e.clienteBuzon(S);
    expect(await ciclo()).toMatchObject({ tomado: false, encolados: 0 });
    expect(await trabajosDe(b)).toHaveLength(0);
    await prog.fijar({
      ultimo_ciclo_inicio: new Date(Date.now() - 6 * 60_000),
    });
    expect(await ciclo()).toMatchObject({ tomado: true, encolados: 1 });
    expect(await trabajosDe(b)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-1, CA-11: varios workers
// ---------------------------------------------------------------------------------------------------------------

describe("CA-1, CA-11: varios workers", () => {
  it("con tres instancias y ticks simultáneos durante 10 ciclos, cada cliente vencido recibe una captura por franja y el ciclo nunca corre dos veces", async () => {
    const S1 = await e.estudioConSub();
    const S2 = await e.estudioConSub();
    const clientes = [
      ...(await Promise.all(
        Array.from({ length: 12 }, () => e.clienteBuzon(S1)),
      )),
      ...(await Promise.all(
        Array.from({ length: 12 }, () => e.clienteBuzon(S2)),
      )),
    ];
    const ciclos = await Promise.all([instancia(), instancia(), instancia()]);
    const contar = async (c: ClientePrueba) => (await trabajosDe(c)).length;

    for (let ronda = 1; ronda <= 10; ronda++) {
      // Franja nueva: lo anterior terminó y los clientes vuelven a estar vencidos; el intervalo ya pasó.
      await terminarTrabajosBuzon(admin, [S1, S2]);
      await admin.pool.query(
        "update buzon_estado_cliente set ultima_programada_en = null where tenant_id = any($1::uuid[])",
        [[S1, S2]],
      );
      await prog.listoParaTomar(15);
      const inicioAnterior = (await prog.leer()).ultimo_ciclo_inicio;

      const rs = await Promise.all(ciclos.map((c) => c()));
      expect(
        rs.filter((r) => r.tomado),
        `ronda ${ronda}: un solo ciclo`,
      ).toHaveLength(1);
      expect(
        rs.reduce((n, r) => n + r.encolados, 0),
        `ronda ${ronda}: cada cliente una vez`,
      ).toBe(24);
      expect(
        (await prog.leer()).ultimo_ciclo_inicio?.getTime(),
      ).toBeGreaterThan(inicioAnterior!.getTime());
      const vivos = await admin.pool.query(
        `select cliente_id, count(*)::int as n from job_registro
          where tenant_id = any($1::uuid[]) and tipo = 'sol.buzon.revisar' and estado = 'en_cola' group by cliente_id`,
        [[S1, S2]],
      );
      expect(vivos.rows, `ronda ${ronda}`).toHaveLength(24);
      expect(vivos.rows.every((f: { n: number }) => f.n === 1)).toBe(true);

      // Otro tick de los tres, ya con el ciclo cumplido y el intervalo sin pasar: nadie lo toma.
      const otra = await Promise.all(ciclos.map((c) => c()));
      expect(
        otra.filter((r) => r.tomado),
        `ronda ${ronda}: segundo tick`,
      ).toHaveLength(0);
    }
    for (const c of clientes) expect(await contar(c)).toBe(10);
  });

  it("si el worker que tiene el ciclo muere, otro lo toma cuando vence el candado", async () => {
    const S = await e.estudioConSub();
    const a = await e.clienteBuzon(S);
    await admin.pool.query(
      `update buzon_programacion set intervalo_min = 15, ciclo_dueno = 'worker-muerto',
              ciclo_hasta = clock_timestamp() + interval '5 minutes',
              ultimo_ciclo_inicio = clock_timestamp() - interval '1 hour'`,
    );
    const ciclos = await Promise.all([instancia(), instancia(), instancia()]);

    // Con el candado vigente nadie hace nada, aunque el intervalo ya pasó.
    const durante = await Promise.all(ciclos.map((c) => c()));
    expect(durante.filter((r) => r.tomado)).toHaveLength(0);
    expect(durante.reduce((n, r) => n + r.encolados, 0)).toBe(0);
    expect(await trabajosDe(a)).toHaveLength(0);

    // El candado vence: exactamente uno lo toma y encola.
    await admin.pool.query(
      "update buzon_programacion set ciclo_hasta = clock_timestamp() - interval '1 second'",
    );
    const despues = await Promise.all(ciclos.map((c) => c()));
    expect(despues.filter((r) => r.tomado)).toHaveLength(1);
    expect(despues.reduce((n, r) => n + r.encolados, 0)).toBe(1);
    expect(await trabajosDe(a)).toHaveLength(1);
    expect((await prog.leer()).ciclo_dueno).not.toBe("worker-muerto");
  });

  it("si pierde el candado en pleno ciclo, se detiene sin encolar más y no suelta el candado ajeno", async () => {
    const S1 = await e.estudioConSub();
    const S2 = await e.estudioConSub();
    await e.clienteBuzon(S1);
    await e.clienteBuzon(S2);
    await prog.listoParaTomar(15);

    let robado = false;
    const conGancho = new Proxy(worker, {
      get(t, p, r) {
        if (p === "withTenant")
          return async (...args: unknown[]) => {
            const v = await (
              t.withTenant as (...a: unknown[]) => Promise<unknown>
            )(...args);
            if (
              !robado &&
              (await trabajosRevisar(admin, { tenantId: S1 })).length +
                (await trabajosRevisar(admin, { tenantId: S2 })).length >
                0
            ) {
              robado = true;
              // Pasó el vencimiento y otro worker tomó el ciclo.
              await admin.pool.query(
                `update buzon_programacion set ciclo_dueno = 'otro-worker', ciclo_hasta = clock_timestamp() + interval '5 minutes'`,
              );
            }
            return v;
          };
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as ContappDb;
    const ciclo = await instancia({ db: conGancho });
    const r = await ciclo();
    expect(r).toMatchObject({
      tomado: true,
      perdioCandado: true,
      encolados: 1,
    });
    expect(
      (await trabajosRevisar(admin, { tenantId: S1 })).length +
        (await trabajosRevisar(admin, { tenantId: S2 })).length,
      "el segundo estudio no recibió nada",
    ).toBe(1);
    const f = await prog.leer();
    expect(f.ciclo_dueno).toBe("otro-worker");
    expect(f.ciclo_hasta, "no soltó el candado de otro").not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-2: estudios grandes y chicos
// ---------------------------------------------------------------------------------------------------------------

describe("CA-2: un estudio de 720 clientes y otro de 1", () => {
  it("el de 1 se encola en el primer ciclo y el grande no pasa del tope menos la reserva", async () => {
    await fijarConfig(admin, "sol", { maxPendientes: 150 });
    const grande = await e.estudioConSub();
    const chico = await e.estudioConSub();
    await e.clientesMasivos(grande, 720);
    const unico = await e.clienteBuzon(chico);
    await prog.listoParaTomar(15);
    await prog.fijar({ reserva_interactiva: 50, lote_estudio: 1000 });
    const ciclo = await instancia();

    const r = await ciclo();
    expect(r.tomado).toBe(true);
    expect(await trabajosDe(unico), "el estudio de 1 no espera").toHaveLength(
      1,
    );
    const enCola = async () =>
      (
        await admin.pool.query(
          "select count(*)::int as n from job_registro where tenant_id = $1 and tipo = 'sol.buzon.revisar' and estado = 'en_cola'",
          [grande],
        )
      ).rows[0].n as number;
    expect(await enCola(), "max_pendientes_tenant − reserva").toBe(100);
    expect(r.encolados).toBe(101);

    // El siguiente ciclo no rebasa el tope: queda lugar solo para lo interactivo.
    await prog.listoParaTomar(15);
    await ciclo();
    expect(await enCola()).toBe(100);
    expect(await trabajosDe(unico)).toHaveLength(1);
  });

  it("el lote por estudio de la BD limita lo que se encola en un ciclo", async () => {
    const S = await e.estudioConSub();
    await e.clientesMasivos(S, 40);
    await prog.listoParaTomar(15);
    await prog.fijar({ lote_estudio: 10, reserva_interactiva: 0 });
    const ciclo = await instancia();
    expect((await ciclo()).encolados).toBe(10);
    await prog.listoParaTomar(15);
    expect((await ciclo()).encolados).toBe(10);
    expect((await trabajosRevisar(admin, { tenantId: S })).length).toBe(20);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Publicación, fallos y trazas
// ---------------------------------------------------------------------------------------------------------------

describe("publicación y fallos del ciclo", () => {
  it("publica la pista de cada trabajo encolado en Redis (si se pierde, lo repone el reconciliador)", async () => {
    const S = await e.estudioConSub();
    const clientes = await Promise.all([
      e.clienteBuzon(S),
      e.clienteBuzon(S),
      e.clienteBuzon(S),
    ]);
    await prog.listoParaTomar(15);
    expect((await (await instancia())()).encolados).toBe(3);
    const ids = (await trabajosRevisar(admin, { tenantId: S })).map(
      (t) => t.id,
    );
    expect(ids).toHaveLength(3);
    const volcado = await volcarPrefijo(redis, prefijo);
    for (const id of ids) expect(volcado).toContain(id);
    expect(clientes).toHaveLength(3);
  });

  it("el fallo de un estudio no tumba el ciclo ni llega al log, y el candado se suelta", async () => {
    const malo = await e.estudioConSub();
    const bueno = await e.estudioConSub();
    await e.clienteBuzon(malo);
    const clienteBueno = await e.clienteBuzon(bueno);
    const canarioFalla = canario("falla_pg");
    const conFalla = new Proxy(worker, {
      get(t, p, r) {
        if (p === "withTenant")
          return async (...args: unknown[]) => {
            const ctx = args[0] as { tenantId?: string };
            if (ctx?.tenantId === malo)
              throw new Error(`falla simulada de pg: ${canarioFalla}`);
            return (t.withTenant as (...a: unknown[]) => Promise<unknown>)(
              ...args,
            );
          };
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as ContappDb;
    const espia = loggerEspia();
    await prog.listoParaTomar(15);
    const ciclo = await instancia({
      db: conFalla,
      logger: espia.logger as unknown as LoggerTrabajos,
    });
    const r = await ciclo();
    expect(r.tomado).toBe(true);
    expect(
      await trabajosDe(clienteBueno),
      "el otro estudio sí se atendió",
    ).toHaveLength(1);
    expect(JSON.stringify(espia.llamadas)).not.toContain(canarioFalla);
    const f = await prog.leer();
    expect(f.ciclo_hasta, "candado soltado").toBeNull();
    expect(f.ultimo_ciclo_fin).not.toBeNull();
  });

  it("los logs llevan solo ids de estudio, conteos y códigos: nunca RUC, razón social ni ids de cliente (D-10)", async () => {
    const S = await e.estudioConSub();
    const clientes = await Promise.all([e.clienteBuzon(S), e.clienteBuzon(S)]);
    const espia = loggerEspia();
    await prog.listoParaTomar(15);
    expect(
      (
        await (
          await instancia({ logger: espia.logger as unknown as LoggerTrabajos })
        )()
      ).encolados,
    ).toBe(2);
    const texto = JSON.stringify(espia.llamadas);
    for (const c of clientes) {
      expect(texto).not.toContain(c.ruc);
      expect(texto).not.toContain(c.id);
    }
    expect(texto).not.toContain("Cliente T5");
    for (const llamada of espia.llamadas)
      for (const arg of llamada.args)
        for (const v of Object.values(arg as Record<string, unknown>))
          expect(
            ["string", "number", "boolean", "undefined"].includes(typeof v) ||
              v === null,
          ).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Ensamblado en el worker
// ---------------------------------------------------------------------------------------------------------------

describe("D-5: el repetible y el tick en el worker", () => {
  it("registra `buzon.programar` como repetible y `BUZON_PROGRAMADOR=off` no lo registra", async () => {
    // Por omisión (sin la variable) el repetible existe.
    delete process.env.BUZON_PROGRAMADOR;
    const conRepetible = nuevoPrefijo();
    prefijos.push(conRepetible);
    const w1 = await arrancar({ prefijo: conRepetible });
    try {
      await esperarHasta(
        async () =>
          /buzon\.programar/.test(
            await volcarPrefijo(redis, `${conRepetible}bull:programados`),
          ),
        "buzon.programar registrado como repetible",
      );
    } finally {
      await w1.detener({ esperaMs: 2000 });
    }

    // Con `off` solo queda la purga: el worker arrancó (auth.purgar está) y el programador no.
    process.env.BUZON_PROGRAMADOR = "off";
    const sinRepetible = nuevoPrefijo();
    prefijos.push(sinRepetible);
    const w2 = await arrancar({ prefijo: sinRepetible });
    try {
      await esperarHasta(
        async () =>
          /auth\.purgar/.test(
            await volcarPrefijo(redis, `${sinRepetible}bull:programados`),
          ),
        "el worker registró lo demás",
      );
      await dormir(300);
      expect(
        await volcarPrefijo(redis, `${sinRepetible}bull:programados`),
      ).not.toMatch(/buzon\.programar/);
    } finally {
      await w2.detener({ esperaMs: 2000 });
    }
  });

  it("el job de sistema `buzon.programar` ejecuta un ciclo dentro del worker y deja un trabajo `programado`", async () => {
    const S = await e.estudioConSub();
    const c = await e.clienteBuzon(S);
    await prog.listoParaTomar(15);
    process.env.BUZON_PROGRAMADOR = "off";
    const w = await arrancar({
      prefijo,
      solPortal: new PortalControlado(),
    } as Parameters<typeof arrancar>[0]);
    const cola = crearColaSistema({ conexion: opcionesBull(), prefijo });
    try {
      await cola.encolar({ tipo: "buzon.programar" });
      await esperarHasta(
        async () => (await trabajosDe(c)).length > 0,
        "el tick encoló la captura del cliente",
      );
      const t = (await trabajosDe(c))[0]!;
      expect(t).toMatchObject({ prioridad: "programado", creado_por: null });
      expect(
        (await estadoDeCaptura(admin, c.id))?.ultima_programada_en,
      ).not.toBeNull();
    } finally {
      await cola.cerrar();
      await w.detener({ esperaMs: 2000 });
    }
  });
});
