import type { ContappDb } from "@contapp/db";
import { ErrorCredencial, ErrorTransitorio } from "@contapp/sunat";
import type { Redis } from "ioredis";
import {
  afterAll,
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
import {
  cambiosEntre,
  comprasDe,
  contarDe,
  fotoDe,
  limpiarCompras,
  nuevasEntre,
  versionesDe,
} from "../../../test/compras.js";
import {
  PERIODOS_6,
  PROV,
  SireRegistroControlado,
  TIPO_IMPORTAR,
  activarCandidatas,
  candidatasDe,
  comoEsperada,
  crearDirFixtures,
  deducir,
  encolarImportacion,
  escenario6,
  filaRegistro,
  importacionDe,
  importacionTexto,
  iniciarImportacion,
  limpiarAprendizaje,
  reglasDeCliente,
  rucProveedor,
  volcarTablasAprendizaje,
  type DirFixtures,
} from "../../../test/importar-historial.js";
import {
  aplicacionesDe,
  contarAplicaciones,
  limpiarReglas,
  volcarAuditoria,
} from "../../../test/reglas.js";
import {
  canario,
  loggerEspia,
  rastros,
  volcado,
} from "../../../test/soporte.js";
import {
  Escenario,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  encolarYPublicar,
  esperarHasta,
  fijarConfig,
  limpiarPrefijo,
  minimoTx,
  nuevoPrefijo,
  restaurarConfig,
  volcarPrefijo,
  type ProcesoWorker,
} from "../../../test/trabajos.js";
import {
  SireAuthTokenFijo,
  contarPropuestas,
  encolarDescarga,
  mundoVentas,
  type MundoVentas,
} from "../../../test/ventas.js";

// Spec 025, T5 (rojo; integración con PostgreSQL y Redis reales, BullMQ real y el mock de SireApiClient con una carpeta de
// fixtures propia): procesador `reglas.historial.importar` (D-1, D-2, D-11; CA-1, CA-6, CA-12). Se encola como lo hace el backend
// (iniciar -> encolar y fijar el trabajo en la misma transacción -> publicar) y lo ejecuta el worker real.
//
// CONTRATO que fija (T11 worker; T9 cola y puerto; T10 BD), además del de `test/importar-historial.ts` y plan.md (Worker):
// - Éxito: el trabajo queda `completado` (sin reintentos) y la importación `completada` con `periodos_leidos`, `periodos_sin_datos`,
//   `candidatas` y `sin_criterio`, y UNA fila de `regla_candidata` por proveedor con destino propuesto (o `null`), conteos por destino
//   y `periodos_con_proveedor`, en estado `pendiente`. `resultado` = {periodosLeidos, periodosSinDatos: n, candidatas, sinCriterio}:
//   solo conteos (D-11).
// - Lee del periodo más reciente al más antiguo, uno por llamada al puerto y SIN transacción abierta; `ErrorDatos` = «sin datos»
//   y sigue. `ErrorCredencial` falla el trabajo como 014 (`credencial_invalida`, la credencial `sire_api` queda inválida) y
//   `ErrorTransitorio` se reintenta (008) y, agotado, falla `sunat_no_responde`; en ambos la importación queda `fallida` con el
//   mismo motivo y sin candidatas.
// - Escribe en UNA transacción (`reglas_importacion_completar`), sin `SAVEPOINT`, y no toca `compra*`, `propuesta`, `regla_aprendida`
//   ni versiones. Importación ya cerrada (o cerrada mientras se lee): el trabajo termina bien sin escribir.
// - La descarga siguiente no crea versiones «Según historial» hasta que el contador activa las candidatas (CA-1, D-4, D-5).

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const REINTENTOS = 3;
let admin: ContappDb;
let backend: ContappDb;
let redis: Redis;
let e: Escenario;
let fx: DirFixtures;
// Un prefijo de Redis por prueba: así no sobreviven arriendos del líder ni jobs de BullMQ de la prueba anterior.
let prefijo = nuevoPrefijo();
const prefijos = [prefijo];
beforeEach(() => {
  prefijo = nuevoPrefijo();
  prefijos.push(prefijo);
});

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  redis = conectarRedis();
  e = new Escenario(admin);
  fx = crearDirFixtures();
  await fijarConfig(admin, "sire", {
    global: 4,
    tenant: 2,
    espera: 0,
    reintentos: REINTENTOS,
    base: 100,
  });
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
  fx?.limpiar();
  await Promise.all([backend?.close(), admin?.close()]);
});

/** Arranca el worker con el puerto SIRE de la prueba, corre `fn` y lo detiene. */
async function conWorker<T>(
  api: SireRegistroControlado,
  fn: (p: ProcesoWorker) => Promise<T>,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const p = await arrancar007b({
    prefijo,
    sireApi: api,
    ...extra,
  } as Parameters<typeof arrancar007b>[0]);
  api.contarTx = () => p.dbEstado.abiertas;
  try {
    return await fn(p);
  } finally {
    await p.detener({ esperaMs: 2000 });
  }
}

interface ResultadoImportacion {
  periodosLeidos: number;
  periodosSinDatos: number;
  candidatas: number;
  sinCriterio: number;
}

/** Inicia la importación, encola su trabajo (el worker ya debe estar en marcha) y espera su fin. */
async function importar(
  m: MundoVentas,
  periodos: readonly string[] = PERIODOS_6,
  timeoutMs = 60_000,
) {
  const importacionId = await iniciarImportacion(backend, m, periodos);
  const trabajoId = await encolarImportacion(
    backend,
    redis,
    prefijo,
    m,
    importacionId,
  );
  const f = await esperarTerminal(e, trabajoId, timeoutMs);
  return {
    importacionId,
    trabajoId,
    estado: f.estado,
    motivo: f.motivo,
    intentos: f.intentos,
    resultado: (f as { resultado?: unknown })
      .resultado as ResultadoImportacion | null,
  };
}

/** Un cliente con su registro de seis periodos escrito en la carpeta del mock. */
async function mundoConRegistro(
  porPeriodo = escenario6().porPeriodo,
  sinDatos?: string[],
): Promise<MundoVentas> {
  const m = await mundoVentas(e, backend);
  fx.registro(m.c.ruc, porPeriodo);
  if (sinDatos !== undefined) fx.sinDatos(m.c.ruc, sinDatos);
  return m;
}

const PROXIMO = "202611";

/** La propuesta de compras del periodo siguiente: una compra del proveedor A, con base en DG. */
function propuestaSiguiente(m: MundoVentas, numero: string, periodo = PROXIMO) {
  fx.propuesta(m.c.ruc, periodo, [
    filaRegistro({
      periodo,
      numero,
      ruc: PROV.A,
      razon: "ALFA SAC",
      destino: "DG",
    }),
  ]);
}

async function descargar(m: MundoVentas, periodo = PROXIMO) {
  const id = await encolarDescarga(backend, redis, prefijo, m, {
    libro: "compras",
    periodo,
  });
  const f = await esperarTerminal(e, id, 60_000);
  return { estado: f.estado, motivo: f.motivo };
}

// ---------------------------------------------------------------------------------------------------------------
describe("CA-1: importar seis periodos del mock", () => {
  it("control de la prueba: la lista escrita a mano coincide con el oráculo simple de la deducción", () => {
    const esc = escenario6();
    expect(deducir(esc.porPeriodo, PERIODOS_6)).toEqual(esc.esperadas);
  });

  it("deja una candidata por proveedor (destino, conteos y periodos), la importación completada y un resultado solo de conteos", async () => {
    const esc = escenario6();
    const m = await mundoConRegistro(esc.porPeriodo);
    const api = new SireRegistroControlado(fx.dir);
    const r = await conWorker(api, () => importar(m));

    expect([r.estado, r.motivo, r.intentos]).toEqual(["completado", null, 0]);
    expect(r.resultado).toEqual({
      periodosLeidos: 6,
      periodosSinDatos: 0,
      candidatas: 8,
      sinCriterio: 3,
    });

    const imp = await importacionDe(admin, r.importacionId);
    expect(imp).toMatchObject({
      estado: "completada",
      periodo_hasta: "202610",
      trabajo_id: r.trabajoId,
      periodos_leidos: 6,
      candidatas: 8,
      sin_criterio: 3,
      motivo: null,
    });
    expect([...imp.periodos].sort()).toEqual([...PERIODOS_6].sort());
    expect(imp.periodos_sin_datos ?? []).toEqual([]);
    expect(imp.terminada_en).not.toBeNull();

    const cands = await candidatasDe(admin, { importacionId: r.importacionId });
    expect(cands.map(comoEsperada)).toEqual(esc.esperadas);
    // Todas pendientes: ninguna se aplica hasta que el contador las activa (D-4).
    for (const c of cands) {
      expect(c.estado, c.doc_numero).toBe("pendiente");
      expect(c.regla_id, c.doc_numero).toBeNull();
      expect(c.destino_elegido, c.doc_numero).toBeNull();
    }

    // Del periodo más reciente al más antiguo, uno por llamada, con el RUC del cliente y el token de la caché.
    expect(api.llamadas.map((l) => l.solicitud)).toMatchObject(
      PERIODOS_6.map((periodo) => ({ ruc: m.c.ruc, periodo })),
    );
    expect(api.llamadas.every((l) => l.token.length > 0)).toBe(true);
  });

  it("ninguna se aplica: la descarga siguiente no crea versiones «Según historial» ni aplicaciones hasta activar", async () => {
    const m = await mundoConRegistro();
    propuestaSiguiente(m, "9001");
    const api = new SireRegistroControlado(fx.dir);
    await conWorker(api, async () => {
      expect((await importar(m)).estado).toBe("completado");
      expect(await descargar(m)).toEqual({
        estado: "completado",
        motivo: null,
      });
    });
    const compras = await comprasDe(admin, m.c.id, PROXIMO);
    expect(compras.map((c) => c.numero)).toEqual(["9001"]);
    const c = compras[0]!;
    expect(c.version_vigente).toBe(1);
    expect(
      (await versionesDe(admin, c.id)).map((v) => [v.n, v.accion]),
    ).toEqual([[1, "original"]]);
    expect(await aplicacionesDe(admin, m.c.id)).toEqual([]);
    expect(await contarAplicaciones(admin, m.T)).toBe(0);
    expect(await reglasDeCliente(admin, m.c.id)).toEqual([]);
  });

  it("control: tras activar las candidatas, la descarga siguiente sí aplica la regla (versión 2 «historial»)", async () => {
    const m = await mundoConRegistro();
    propuestaSiguiente(m, "9001");
    const api = new SireRegistroControlado(fx.dir);
    await conWorker(api, async () => {
      const r = await importar(m);
      expect(r.estado).toBe("completado");
      await activarCandidatas(backend, m, { todas: r.importacionId });
      expect(await descargar(m)).toEqual({
        estado: "completado",
        motivo: null,
      });
    });
    // «Activar todas» crea la regla de las cinco candidatas con destino propuesto (las tres sin criterio no).
    const reglas = await reglasDeCliente(admin, m.c.id);
    expect(reglas).toHaveLength(5);
    expect(reglas.every((x) => x.origen === "importacion" && x.activa)).toBe(
      true,
    );
    expect(reglas.every((x) => x.periodo_aprendido === "202610")).toBe(true);
    const c = (await comprasDe(admin, m.c.id, PROXIMO))[0]!;
    expect(c.version_vigente).toBe(2);
    expect(
      (await versionesDe(admin, c.id)).map((v) => [v.n, v.accion]),
    ).toEqual([
      [1, "original"],
      [2, "historial"],
    ]);
    expect(await aplicacionesDe(admin, m.c.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("D-2: el trabajo solo guarda lo agregado", () => {
  it("no crea compras, versiones, hallazgos, periodos, propuestas ni reglas; lo ya guardado queda idéntico", async () => {
    const m = await mundoConRegistro();
    propuestaSiguiente(m, "9001");
    const api = new SireRegistroControlado(fx.dir);
    await conWorker(api, async () => {
      expect(await descargar(m)).toEqual({
        estado: "completado",
        motivo: null,
      });
      const antes = await fotoDe(admin, m.c.id);
      const props = await contarPropuestas(admin, m.c.id);
      expect(antes.compra.size).toBe(1);

      const r = await importar(m);
      expect(r.estado).toBe("completado");

      const despues = await fotoDe(admin, m.c.id);
      expect(cambiosEntre(antes, despues)).toEqual([]);
      for (const t of [
        "compra",
        "compra_version",
        "compra_hallazgo",
        "compra_periodo",
      ] as const)
        expect(nuevasEntre(antes, despues, t), t).toEqual([]);
      expect(await contarPropuestas(admin, m.c.id)).toBe(props);
      expect(await contarDe(admin, "compra", m.c.id)).toBe(1);
      expect(await reglasDeCliente(admin, m.c.id)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("CA-6: lectura fuera de la transacción, una escritura sin SAVEPOINT", () => {
  it("las llamadas al puerto ocurren sin transacción abierta (008 D6)", async () => {
    const m = await mundoConRegistro();
    const api = new SireRegistroControlado(fx.dir);
    api.pausar();
    await conWorker(api, async (p) => {
      const importacionId = await iniciarImportacion(backend, m, PERIODOS_6);
      const trabajoId = await encolarImportacion(
        backend,
        redis,
        prefijo,
        m,
        importacionId,
      );
      await esperarHasta(
        () => api.llamadas.length === 1,
        "el puerto recibe la primera llamada",
      );
      expect(await minimoTx(p.dbEstado, 300)).toBe(0);
      api.abrir();
      expect((await esperarTerminal(e, trabajoId)).estado).toBe("completado");
    });
    // Mientras corría no había importación a medias: se escribió una vez, al final.
    expect(api.llamadas).toHaveLength(6);
  });

  it("escribe con UNA sola llamada a reglas_importacion_completar, en una transacción sin SAVEPOINT ni escritura de compras", async () => {
    const m = await mundoConRegistro();
    const api = new SireRegistroControlado(fx.dir);
    await conWorker(api, async (p) => {
      const espia = espiarSentencias(p.db.pool);
      try {
        const r = await importar(m);
        expect(r.estado).toBe("completado");
      } finally {
        espia.restaurar();
      }
      const todas = espia.sentencias;
      expect(todas.length, "el espía sí vio sentencias").toBeGreaterThan(0);
      expect(
        todas.filter((s) => /savepoint/i.test(s.texto)).map((s) => s.texto),
        "SAVEPOINT",
      ).toEqual([]);
      const completar = todas.filter((s) =>
        /reglas_importacion_completar/i.test(s.texto),
      );
      expect(completar, "reglas_importacion_completar").toHaveLength(1);
      expect(
        todas.filter((s) => /reglas_importacion_fallar/i.test(s.texto)),
        "reglas_importacion_fallar",
      ).toHaveLength(0);

      // La transacción de la escritura: de su BEGIN a su COMMIT, sin ningún INSERT/UPDATE/DELETE de compras, propuestas ni reglas.
      const tx = transaccionDe(todas, completar[0]!);
      expect(tx.length).toBeGreaterThan(1);
      expect(tx[tx.length - 1]!.texto).toMatch(/^\s*commit/i);
      expect(
        tx
          .filter((s) =>
            /\b(insert\s+into|update|delete\s+from)\s+"?(compra|compra_version|compra_hallazgo|compra_periodo|propuesta|regla_aprendida)\b/i.test(
              s.texto,
            ),
          )
          .map((s) => s.texto),
      ).toEqual([]);
    });
    // El puerto ya había respondido las seis veces antes de abrir la transacción de escritura.
    expect(api.llamadas).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("CA-6: periodos sin datos y fallos del puerto", () => {
  it("un periodo sin registro queda «sin datos» y el resto se importa con lo leído", async () => {
    const esc = escenario6();
    const m = await mundoConRegistro(esc.porPeriodo, ["202607"]);
    const api = new SireRegistroControlado(fx.dir);
    const r = await conWorker(api, () => importar(m));

    const leidos = PERIODOS_6.filter((p) => p !== "202607");
    const esperadas = deducir(esc.porPeriodo, leidos);
    // Control de la prueba: sin el periodo 202607 cambian propuestas (D y F pasan el umbral) y es lo que se espera.
    expect(
      esperadas.find((c) => c.doc_numero === PROV.D)?.destino_propuesto,
    ).toBe("DG");
    expect(
      esperadas.find((c) => c.doc_numero === PROV.F)?.destino_propuesto,
    ).toBe("DGNG");

    expect([r.estado, r.motivo, r.intentos]).toEqual(["completado", null, 0]);
    const sinCriterio = esperadas.filter(
      (c) => c.destino_propuesto === null,
    ).length;
    expect(r.resultado).toEqual({
      periodosLeidos: 5,
      periodosSinDatos: 1,
      candidatas: esperadas.length,
      sinCriterio,
    });
    const imp = await importacionDe(admin, r.importacionId);
    expect(imp).toMatchObject({
      estado: "completada",
      periodos_leidos: 5,
      candidatas: esperadas.length,
      sin_criterio: sinCriterio,
    });
    expect(imp.periodos_sin_datos).toEqual(["202607"]);
    expect(
      (await candidatasDe(admin, { importacionId: r.importacionId })).map(
        comoEsperada,
      ),
    ).toEqual(esperadas);
    // Se pidieron los seis periodos, también el que no tenía registro.
    expect(api.llamadas.map((l) => l.solicitud.periodo)).toEqual([
      ...PERIODOS_6,
    ]);
  });

  it("credencial rechazada: error/credencial_invalida sin reintentos, importación fallida sin candidatas y la credencial sire_api inválida", async () => {
    const m = await mundoConRegistro();
    const api = new SireRegistroControlado(fx.dir).programar(() => {
      throw new ErrorCredencial();
    });
    const r = await conWorker(api, () => importar(m));
    expect([r.estado, r.motivo, r.intentos]).toEqual([
      "error",
      "credencial_invalida",
      0,
    ]);
    await esperarHasta(
      async () =>
        (await importacionDe(admin, r.importacionId)).estado === "fallida",
      "la importación queda fallida",
      { timeoutMs: 10_000 },
    );
    expect(await importacionDe(admin, r.importacionId)).toMatchObject({
      estado: "fallida",
      motivo: "credencial_invalida",
    });
    expect(await candidatasDe(admin, { clienteId: m.c.id })).toEqual([]);
    expect((await e.credencialEstado(m.c.id, "sire_api"))?.estado).toBe(
      "invalida",
    );
    expect(await reglasDeCliente(admin, m.c.id)).toEqual([]);
  });

  it("red agotada: se reintenta como 008 y, agotados los reintentos, error/sunat_no_responde, importación fallida sin candidatas", async () => {
    const m = await mundoConRegistro();
    const api = new SireRegistroControlado(fx.dir).programar(() => {
      throw new ErrorTransitorio();
    });
    const r = await conWorker(api, () => importar(m, PERIODOS_6, 90_000));
    expect([r.estado, r.motivo]).toEqual(["error", "sunat_no_responde"]);
    expect(r.intentos).toBe(REINTENTOS);
    expect(api.llamadas.length).toBeGreaterThan(REINTENTOS);
    await esperarHasta(
      async () =>
        (await importacionDe(admin, r.importacionId)).estado === "fallida",
      "la importación queda fallida al agotar los reintentos",
      { timeoutMs: 10_000 },
    );
    expect(await importacionDe(admin, r.importacionId)).toMatchObject({
      estado: "fallida",
      motivo: "sunat_no_responde",
    });
    expect(await candidatasDe(admin, { clienteId: m.c.id })).toEqual([]);
  });

  it("un fallo transitorio que se recupera en el reintento no deja la importación fallida: se completa con lo leído", async () => {
    const esc = escenario6();
    const m = await mundoConRegistro(esc.porPeriodo);
    const api = new SireRegistroControlado(fx.dir);
    let fallos = 1;
    api.programar((s) => {
      if (fallos > 0) {
        fallos -= 1;
        throw new ErrorTransitorio();
      }
      return esc.porPeriodo.get(s.periodo) ?? [];
    });
    const r = await conWorker(api, () => importar(m));
    expect([r.estado, r.motivo]).toEqual(["completado", null]);
    expect(r.intentos).toBe(1);
    expect(await importacionDe(admin, r.importacionId)).toMatchObject({
      estado: "completada",
      candidatas: 8,
    });
    expect(
      (await candidatasDe(admin, { importacionId: r.importacionId })).map(
        comoEsperada,
      ),
    ).toEqual(esc.esperadas);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("CA-6: importación ya cerrada", () => {
  it("una importación completada no se vuelve a escribir: el trabajo termina bien y la fila y las candidatas quedan idénticas", async () => {
    const esc = escenario6();
    const m = await mundoConRegistro(esc.porPeriodo);
    const api = new SireRegistroControlado(fx.dir);
    await conWorker(api, async () => {
      const r = await importar(m);
      expect(r.estado).toBe("completado");
      const fila = await importacionTexto(admin, r.importacionId);
      const antes = JSON.stringify(
        await candidatasDe(admin, { importacionId: r.importacionId }),
      );
      // El registro cambia: una segunda ejecución con el mismo `importacionId` no debe notarse. Se encola sin volver a fijar el
      // trabajo en la importación (eso ya no se puede), como lo haría un reintento manual o un payload repetido.
      api.programar(() => []);
      const id = (
        await encolarYPublicar(backend, redis, prefijo, m.T, {
          tipo: TIPO_IMPORTAR,
          clienteId: m.c.id,
          parametros: { importacionId: r.importacionId },
          prioridad: "interactivo",
          creadoPor: m.u,
        })
      ).trabajo.id;
      const f = await esperarTerminal(e, id, 60_000);
      expect(f.estado).toBe("completado");
      expect(await importacionTexto(admin, r.importacionId)).toBe(fila);
      expect(
        JSON.stringify(
          await candidatasDe(admin, { importacionId: r.importacionId }),
        ),
      ).toBe(antes);
    });
  });

  it("cerrada mientras se lee (otro proceso la dio por interrumpida): el trabajo termina bien y no escribe candidatas ni cambia la fila", async () => {
    const m = await mundoConRegistro();
    const api = new SireRegistroControlado(fx.dir);
    api.pausar();
    await conWorker(api, async (p) => {
      const importacionId = await iniciarImportacion(backend, m, PERIODOS_6);
      const trabajoId = await encolarImportacion(
        backend,
        redis,
        prefijo,
        m,
        importacionId,
      );
      await esperarHasta(
        () => api.llamadas.length === 1,
        "el puerto recibe la primera llamada",
      );
      // Entre la lectura y la escritura se cierra: lo hace la función del worker (la misma que usa al fallar).
      await p.db.withTenant({ tenantId: m.T }, (tx) =>
        tx.query("select reglas_importacion_fallar($1::uuid, $2)", [
          importacionId,
          "interrumpido",
        ]),
      );
      const cerrada = await importacionTexto(admin, importacionId);
      api.abrir();
      const f = await esperarTerminal(e, trabajoId);
      expect([f.estado, f.motivo]).toEqual(["completado", null]);
      expect(await importacionTexto(admin, importacionId)).toBe(cerrada);
      expect(await importacionDe(admin, importacionId)).toMatchObject({
        estado: "fallida",
        motivo: "interrumpido",
      });
    });
    expect(await candidatasDe(admin, { clienteId: m.c.id })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("D-11, CA-12: sin datos sensibles en trazas", () => {
  it("ni el token, ni los secretos, ni montos, RUC o razones sociales de proveedor llegan a logs, job_registro, Redis, auditoría ni al `resultado`", async () => {
    const ok = await mundoVentas(e, backend);
    const caido = await mundoVentas(e, backend);
    const malo = await mundoVentas(e, backend);
    const token = canario("token_sire");
    const razon = canario("razon_social");
    const rucSucio = rucProveedor(7_654_321);
    const baseSucia = "8123.45";
    const igvSucio = "1462.22";
    const sucio = (s: string): Error =>
      Object.assign(new Error(`rechazo con ${s}`, { cause: new Error(s) }), {
        detail: s,
      });
    const filasSucias = PERIODOS_6.flatMap((periodo, i) => [
      filaRegistro({
        periodo,
        numero: String(5000 + 2 * i),
        ruc: rucSucio,
        razon,
        destino: "DNG",
        base: baseSucia,
        igv: igvSucio,
      }),
      filaRegistro({
        periodo,
        numero: String(5001 + 2 * i),
        ruc: rucSucio,
        razon,
        destino: "DNG",
        base: baseSucia,
        igv: igvSucio,
      }),
    ]);
    const api = new SireRegistroControlado(fx.dir).programar((s) => {
      if (s.ruc === caido.c.ruc)
        throw new ErrorTransitorio(sucio(token + rucSucio + razon));
      if (s.ruc === malo.c.ruc)
        throw new ErrorCredencial(sucio(token + baseSucia + razon));
      return filasSucias.filter((f) =>
        f.fechaEmision.startsWith(
          s.periodo.slice(0, 4) + "-" + s.periodo.slice(4),
        ),
      );
    });
    const secretos = [
      token,
      razon,
      rucSucio,
      baseSucia,
      igvSucio,
      ...[ok, caido, malo].flatMap((m) => [
        m.secretos.clave,
        m.secretos.clientSecret,
      ]),
    ];

    const { logger, llamadas } = loggerEspia();
    const capturado: string[] = [];
    const espias = (["log", "info", "warn", "error", "debug"] as const).map(
      (n) =>
        vi
          .spyOn(console, n)
          .mockImplementation(
            (...a: unknown[]) => void capturado.push(volcado(a)),
          ),
    );
    const stdoutOrig = process.stdout.write;
    const stderrOrig = process.stderr.write;
    const capturar = (orig: typeof process.stdout.write) =>
      ((chunk: unknown, ...resto: unknown[]) => {
        capturado.push(String(chunk));
        return (orig as (...a: unknown[]) => boolean).call(
          process.stdout,
          chunk,
          ...resto,
        );
      }) as typeof process.stdout.write;
    process.stdout.write = capturar(stdoutOrig);
    process.stderr.write = capturar(stderrOrig);

    const trabajos: Array<Record<string, unknown>> = [];
    try {
      await conWorker(
        api,
        async () => {
          for (const m of [ok, caido, malo]) {
            const r = await importar(m, PERIODOS_6, 90_000);
            trabajos.push({
              estado: r.estado,
              motivo: r.motivo,
              resultado: r.resultado,
            });
          }
        },
        { sireAuth: new SireAuthTokenFijo(token), logger },
      );

      expect(trabajos.map((t) => [t.estado, t.motivo])).toEqual([
        ["completado", null],
        ["error", "sunat_no_responde"],
        ["error", "credencial_invalida"],
      ]);
      // La prueba no es vacua: el token llegó al puerto y el cliente sano sí guardó su candidata con el RUC y la razón.
      expect(api.llamadas.length).toBeGreaterThan(0);
      expect(api.llamadas.every((l) => l.token === token)).toBe(true);
      const cands = await candidatasDe(admin, { clienteId: ok.c.id });
      expect(cands.map((c) => [c.doc_numero, c.razon_social, c.n_dng])).toEqual(
        [[rucSucio, razon, 12]],
      );

      const jobs = await e.volcarJobs();
      const todoRedis = await volcarPrefijo(redis, prefijo);
      const logs = volcado(llamadas) + "\n" + capturado.join("\n");
      const resultados = JSON.stringify(trabajos);
      let auditoria = "";
      for (const m of [ok, caido, malo])
        auditoria += (await volcarAuditoria(admin, m.T)) + "\n";
      const tablas = await volcarTablasAprendizaje(admin, e.estudios);
      for (const s of secretos)
        for (const x of rastros(s)) {
          expect(jobs, "job_registro").not.toContain(x);
          expect(todoRedis, "Redis").not.toContain(x);
          expect(logs, "logs").not.toContain(x);
          expect(auditoria, "auditoría").not.toContain(x);
          expect(resultados, "resultado").not.toContain(x);
        }
      // En las tablas de aprendizaje solo está lo agregado (D-2): ni montos ni secretos; el RUC y la razón sí (son la candidata).
      for (const s of [
        token,
        baseSucia,
        igvSucio,
        ok.secretos.clave,
        ok.secretos.clientSecret,
      ])
        for (const x of rastros(s))
          expect(tablas, "tablas de aprendizaje").not.toContain(x);
      expect(llamadas.length, "el worker sí registra eventos").toBeGreaterThan(
        0,
      );
    } finally {
      process.stdout.write = stdoutOrig;
      process.stderr.write = stderrOrig;
      for (const s of espias) s.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Registro de sentencias del pool del worker (CA-6: una sola escritura, sin SAVEPOINT)
// ---------------------------------------------------------------------------------------------------------------

interface Sentencia {
  /** Número de la conexión del pool (cada una ejecuta sus sentencias en orden). */
  cliente: number;
  texto: string;
}

type ClientePg = { query: (...a: unknown[]) => unknown };
type PoolPg = {
  connect: (...a: unknown[]) => unknown;
};

/** Anota el texto de cada sentencia que el pool dado envía a la BD (valores y resultados no se guardan). */
function espiarSentencias(pool: unknown): {
  sentencias: Sentencia[];
  restaurar(): void;
} {
  const p = pool as PoolPg;
  const original = p.connect;
  const sentencias: Sentencia[] = [];
  const ids = new WeakMap<object, number>();
  let n = 0;
  const instrumentar = (c: ClientePg): void => {
    if (ids.has(c)) return;
    const id = (n += 1);
    ids.set(c, id);
    const q = c.query.bind(c);
    c.query = (...args: unknown[]) => {
      const a0 = args[0] as string | { text?: string } | undefined;
      sentencias.push({
        cliente: id,
        texto: typeof a0 === "string" ? a0 : String(a0?.text ?? ""),
      });
      return q(...args);
    };
  };
  p.connect = (...args: unknown[]) => {
    const ultimo = args[args.length - 1];
    if (typeof ultimo === "function") {
      const cb = ultimo as (err: unknown, c: ClientePg, done: unknown) => void;
      return original.call(
        p,
        ...args.slice(0, -1),
        (err: unknown, c: ClientePg, done: unknown) => {
          if (c) instrumentar(c);
          cb(err, c, done);
        },
      );
    }
    return (original.call(p, ...args) as Promise<ClientePg>).then((c) => {
      instrumentar(c);
      return c;
    });
  };
  return {
    sentencias,
    restaurar: () => {
      p.connect = original;
    },
  };
}

/** Las sentencias de la transacción de `s`: desde su BEGIN hasta su COMMIT o ROLLBACK, en su conexión. */
function transaccionDe(todas: Sentencia[], s: Sentencia): Sentencia[] {
  const propias = todas.filter((x) => x.cliente === s.cliente);
  const i = propias.indexOf(s);
  let ini = i;
  while (ini > 0 && !/^\s*begin/i.test(propias[ini]!.texto)) ini -= 1;
  let fin = i;
  while (
    fin < propias.length - 1 &&
    !/^\s*(commit|rollback)/i.test(propias[fin]!.texto)
  )
    fin += 1;
  return propias.slice(ini, fin + 1);
}
