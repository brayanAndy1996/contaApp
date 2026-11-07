import { ErrorCredencial, ErrorTransitorio } from "@contapp/sunat";
import type { ContappDb } from "@contapp/db";
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
  minimoTx,
  nuevoPrefijo,
  restaurarConfig,
  volcarPrefijo,
  type ProcesoWorker,
} from "../../../test/trabajos.js";
import {
  PERIODO,
  RUC_FIXTURE,
  SireApiControlado,
  SireAuthTokenFijo,
  TIPO_DESCARGA,
  boletas290y292,
  contarDiferencias,
  contarPropuestas,
  contarVentas,
  diferenciasDe,
  encolarDescarga,
  fila,
  liberarDedupe,
  limpiarVentas,
  mundoVentas,
  muchas,
  propuestasDe,
  saltosDe,
  sembrarManual,
  sembrarSalto,
  sembrarVentas,
  ventasDe,
  volcarTablasVentas,
  type FilaVenta,
  type MundoVentas,
} from "../../../test/ventas.js";

// Spec 013, T5 (rojo; integración con PostgreSQL y Redis reales, BullMQ real y el mock de SireApiClient): procesador
// `sire.propuesta.descargar` con el persistidor de ventas (D2, D3, D10, D16, D18; CA-1, CA-2, CA-3, CA-11). Se encola como
// lo hace el backend (rol backend, prioridad `interactivo`) y lo ejecuta el worker con la KEK `mock`.
//
// CONTRATO que fija (T11/T12), además del de test/ventas.ts:
// - Éxito: el trabajo queda `completado` y deja UNA `propuesta` (libro `ventas`, fuente `api`, `usuario_id` = quien encoló,
//   `trabajo_id` = el trabajo, `hash` de 64 hex) con los contadores recibidas = nuevas + iguales + distintas, las filas nuevas
//   en `venta` (origen `sire`, `propuesta_id` = esa propuesta, clave `tipo|SERIE|numero`) y una `propuesta_diferencia` por
//   cada comprobante distinto. Nada se actualiza ni se borra (D4, D16).
// - `resultado` = { propuestaId, recibidas, nuevas, iguales, distintas, claves, truncado }: `claves` son hasta 40 claves de los
//   que difieren, `truncado` dice si hay más; pesa ≤ 4 KB y no lleva montos (D16).
// - Una fila ilegible, más de 20.000 filas recibidas o más de 20.000 vivas del periodo tras complementar (`propuesta_demasiado_grande`)
//   o un libro sin persistidor (`libro_no_soportado`) son `ErrorDatos`: el trabajo queda `error/datos_invalidos` sin reintentos y
//   no se guarda NADA (ni el encabezado). Un fallo transitorio se reintenta (008) y tampoco guarda nada; una credencial rechazada no
//   se reintenta y deja `credencial_invalida`. El código fino (`propuesta_demasiado_grande`, `libro_no_soportado`) no llega a
//   `job_registro` (el motivo del catálogo es `datos_invalidos`), así que aquí no se puede observar; lo cubre la prueba unitaria de T12.
// - Una fila legible pero descuadrada se guarda tal cual llegó (D3).
// - D18: un comprobante repetido dentro de la misma descarga se guarda una vez, en su primera aparición; las demás cuentan como
//   `iguales` (idénticas a la primera) o `distintas` (si no), así que recibidas = nuevas + iguales + distintas se mantiene.
// - Sin transacción abierta mientras corre el puerto (008 D6); ni el token, ni los secretos, ni el contenido crudo de una fila
//   aparecen en logs, `job_registro`, Redis ni tablas.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const REINTENTOS = 3;
let admin: ContappDb;
let backend: ContappDb;
let redis: Redis;
let e: Escenario;
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
  await limpiarVentas(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  for (const x of prefijos)
    await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), admin?.close()]);
});

/** Arranca el worker con el puerto SIRE de la prueba, corre `fn` y lo detiene. */
async function conWorker<T>(
  api: SireApiControlado,
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

interface Resultado {
  propuestaId: string;
  recibidas: number;
  nuevas: number;
  iguales: number;
  distintas: number;
  claves: string[];
  truncado: boolean;
}

/** Encola una descarga y espera su fin (el worker ya debe estar en marcha). */
async function descargar(
  m: MundoVentas,
  o: { periodo?: string; libro?: "ventas" | "compras" } = {},
  timeoutMs = 60_000,
) {
  const id = await encolarDescarga(backend, redis, prefijo, m, o);
  const f = await esperarTerminal(e, id, timeoutMs);
  return {
    id,
    estado: f.estado,
    motivo: f.motivo,
    intentos: f.intentos,
    resultado: (f as { resultado?: unknown }).resultado as Resultado | null,
  };
}

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

async function nada(m: MundoVentas, periodo = PERIODO): Promise<void> {
  expect(await contarPropuestas(admin, m.c.id), "propuestas").toBe(0);
  expect(await contarVentas(admin, m.c.id, periodo), "ventas").toBe(0);
  expect(await contarDiferencias(admin, m.c.id), "diferencias").toBe(0);
}

// ---------------------------------------------------------------------------------------------------------------
describe("CA-1: la primera descarga con el mock", () => {
  it("contribuyente de prueba: 1 propuesta con contadores y las 11 filas del fixture en `venta` origen sire (B001-290 y B001-292, sin la 291)", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const api = new SireApiControlado();
    const r = await conWorker(api, () => descargar(m));

    expect([r.estado, r.motivo, r.intentos]).toEqual(["completado", null, 0]);
    const props = await propuestasDe(admin, m.c.id);
    expect(props).toHaveLength(1);
    const p = props[0]!;
    expect(p).toMatchObject({
      libro: "ventas",
      fuente: "api",
      filas_recibidas: 11,
      filas_nuevas: 11,
      filas_iguales: 0,
      filas_distintas: 0,
      usuario_id: m.u,
      trabajo_id: r.id,
    });
    expect(p.hash).toMatch(/^[0-9a-f]{64}$/);

    const ventas = await ventasDe(admin, m.c.id);
    expect(ventas).toHaveLength(11);
    expect(ventas.every((v) => v.origen === "sire")).toBe(true);
    expect(ventas.every((v) => v.propuesta_id === p.id)).toBe(true);
    expect(ventas.every((v) => v.creada_por === null)).toBe(true);
    const claves = ventas.map((v) => v.clave);
    expect(claves).toContain("03|B001|290");
    expect(claves).toContain("03|B001|292");
    expect(claves).not.toContain("03|B001|291");
    expect(await diferenciasDe(admin, p.id)).toEqual([]);

    // La resolución del mock llegó al puerto con el RUC, el periodo y el libro del trabajo.
    expect(api.llamadas).toHaveLength(1);
    expect(api.llamadas[0]!.solicitud).toEqual({
      ruc: RUC_FIXTURE,
      periodo: PERIODO,
      libro: "ventas",
    });
    expect(api.llamadas[0]!.token.length).toBeGreaterThan(0);

    expect(r.resultado).toEqual({
      propuestaId: p.id,
      recibidas: 11,
      nuevas: 11,
      iguales: 0,
      distintas: 0,
      claves: [],
      truncado: false,
    });
  });

  it("los datos de cada fila quedan tal como llegaron: boleta 290, nota de crédito en negativo, exonerada, USD con y sin tipo de cambio", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await conWorker(new SireApiControlado(), () => descargar(m));
    const por = new Map(
      (await ventasDe(admin, m.c.id)).map((v) => [v.clave, v]),
    );

    const b290 = por.get("03|B001|290")!;
    expect(b290).toMatchObject({
      tipo: "03",
      serie: "B001",
      numero: "290",
      numero_n: 290,
      fecha: "2026-10-03",
      moneda: "PEN",
      tipo_cambio: null,
      doc_contraparte: "-",
      base_gravada: "100.00",
      igv: "18.00",
      exonerada: "0.00",
      total: "118.00",
    });
    expect(por.get("07|F001|1")).toMatchObject({
      base_gravada: "-50.00",
      igv: "-9.00",
      total: "-59.00",
    });
    expect(por.get("01|F001|12")).toMatchObject({
      exonerada: "150.00",
      total: "150.00",
    });
    expect(por.get("01|F001|10")).toMatchObject({
      tipo_doc_contraparte: "6",
      doc_contraparte: "20700000011",
    });
    const usd = por.get("01|F002|1")!;
    expect(usd.moneda).toBe("USD");
    expect(Number(usd.tipo_cambio)).toBe(3.3);
    // La USD sin tipo de cambio es legible: se guarda y el resumen la avisa (CA-9), no se descarta.
    const sinTc = por.get("01|F002|2")!;
    expect(sinTc.moneda).toBe("USD");
    expect(sinTc.tipo_cambio).toBeNull();
  });

  it("cliente sin fixture propio: el conjunto genérico del mock deja B001-290 y B001-292 en el periodo pedido", async () => {
    const m = await mundoVentas(e, backend);
    const r = await conWorker(new SireApiControlado(), () =>
      descargar(m, { periodo: "202609" }),
    );
    expect(r.estado).toBe("completado");
    const ventas = await ventasDe(admin, m.c.id, "202609");
    expect(ventas.map((v) => v.clave)).toEqual(["03|B001|290", "03|B001|292"]);
    expect(ventas.every((v) => v.fecha.startsWith("2026-09"))).toBe(true);
    expect(r.resultado).toMatchObject({
      recibidas: 2,
      nuevas: 2,
      iguales: 0,
      distintas: 0,
    });
  });

  it("el hash es del contenido: los mismos datos dan el mismo y otros datos dan otro", async () => {
    const m = await mundoVentas(e, backend);
    const api = new SireApiControlado().responder(boletas290y292());
    await conWorker(api, async () => {
      await descargar(m);
      await descargar(m);
      api.responder([fila("B001", "290", { total: "119.00" })]);
      await descargar(m);
    });
    const [a, b, c] = await propuestasDe(admin, m.c.id);
    expect(a!.hash).toBe(b!.hash);
    expect(c!.hash).not.toBe(a!.hash);
  });

  it("libro compras (sin persistidor hasta 014): error/datos_invalidos sin reintentos y nada guardado", async () => {
    const m = await mundoVentas(e, backend);
    const api = new SireApiControlado();
    const r = await conWorker(api, () => descargar(m, { libro: "compras" }));
    expect([r.estado, r.motivo, r.intentos]).toEqual([
      "error",
      "datos_invalidos",
      0,
    ]);
    await nada(m);
    // Cuando 014 registre el persistidor de compras esta prueba se reemplaza por la suya (plan: Riesgos).
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("CA-2: errores del puerto", () => {
  it("fallar(timeout): reintentos de 008 y, agotados, error/sunat_no_responde sin guardar nada", async () => {
    const m = await mundoVentas(e, backend);
    const api = new SireApiControlado();
    api.fallar("timeout");
    const r = await conWorker(api, () => descargar(m));
    expect([r.estado, r.motivo]).toEqual(["error", "sunat_no_responde"]);
    expect(r.intentos).toBe(REINTENTOS);
    expect(api.llamadas).toHaveLength(1 + REINTENTOS);
    await nada(m);
  });

  it("fallar(401): sin reintento, error/credencial_invalida, la credencial sire_api queda inválida y nada se guarda", async () => {
    const m = await mundoVentas(e, backend);
    const api = new SireApiControlado();
    api.fallar("401");
    const r = await conWorker(api, () => descargar(m));
    expect([r.estado, r.motivo, r.intentos]).toEqual([
      "error",
      "credencial_invalida",
      0,
    ]);
    expect((await e.credencialEstado(m.c.id, "sire_api"))?.estado).toBe(
      "invalida",
    );
    await nada(m);
  });

  it("fallar(datos): sin reintento, error/datos_invalidos y nada guardado", async () => {
    const m = await mundoVentas(e, backend);
    const api = new SireApiControlado();
    api.fallar("datos");
    const r = await conWorker(api, () => descargar(m));
    expect([r.estado, r.motivo, r.intentos]).toEqual([
      "error",
      "datos_invalidos",
      0,
    ]);
    await nada(m);
  });

  it("sin transacción abierta mientras el puerto corre (008 D6)", async () => {
    const m = await mundoVentas(e, backend);
    const api = new SireApiControlado().responder(boletas290y292());
    api.pausar();
    await conWorker(api, async (p) => {
      const id = await encolarDescarga(backend, redis, prefijo, m);
      await esperarHasta(
        () => api.llamadas.length === 1,
        "el puerto recibe la llamada",
      );
      expect(await minimoTx(p.dbEstado, 300)).toBe(0);
      api.abrir();
      const f = await esperarTerminal(e, id);
      expect(f.estado).toBe("completado");
    });
    expect(await contarVentas(admin, m.c.id)).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("CA-3: todo o nada", () => {
  const ILEGIBLES: Array<[string, Partial<FilaVenta>]> = [
    ["monto no numérico", { total: "abc" }],
    ["monto con tres decimales", { igv: "18.001" }],
    ["monto fuera de NUMERIC(14,2)", { total: "1000000000000.00" }],
    ["fecha inexistente", { fechaEmision: "2026-02-30" }],
    ["tipo de comprobante de un solo dígito", { tipo: "3" }],
    ["serie de cinco caracteres", { serie: "B0001" }],
    ["número vacío", { numero: "" }],
    ["moneda desconocida", { moneda: "EUR" as never }],
    ["tipo de cambio en una venta en soles", { tipoCambio: "3.300" }],
  ];

  it.each(ILEGIBLES)(
    "una fila ilegible (%s) entre filas válidas: error/datos_invalidos sin reintentos y no se guarda nada (ni el encabezado)",
    async (_motivo, mala) => {
      const m = await mundoVentas(e, backend);
      const api = new SireApiControlado().responder([
        fila("B001", "290"),
        fila("B001", "291", mala),
        fila("B001", "292"),
      ]);
      const r = await conWorker(api, () => descargar(m));
      expect([r.estado, r.motivo, r.intentos]).toEqual([
        "error",
        "datos_invalidos",
        0,
      ]);
      expect(api.llamadas).toHaveLength(1);
      await nada(m);
    },
  );

  it("más de 20.000 filas recibidas: error/datos_invalidos (propuesta_demasiado_grande) y nada guardado", async () => {
    const m = await mundoVentas(e, backend);
    const api = new SireApiControlado().responder(muchas(20_001));
    const r = await conWorker(api, () => descargar(m));
    expect([r.estado, r.motivo, r.intentos]).toEqual([
      "error",
      "datos_invalidos",
      0,
    ]);
    await nada(m);
  });

  it("exactamente 20.000 filas: se guardan todas en una propuesta", async () => {
    const m = await mundoVentas(e, backend);
    const api = new SireApiControlado().responder(muchas(20_000));
    const r = await conWorker(api, () => descargar(m));
    expect(r.estado).toBe("completado");
    expect(r.resultado).toMatchObject({
      recibidas: 20_000,
      nuevas: 20_000,
      iguales: 0,
      distintas: 0,
    });
    expect(await contarVentas(admin, m.c.id)).toBe(20_000);
    const props = await propuestasDe(admin, m.c.id);
    expect(props).toHaveLength(1);
    expect(props[0]!.filas_recibidas).toBe(20_000);
  });

  it("el periodo no pasa de 20.000 filas vivas tras complementar: 19.999 + 2 nuevas es propuesta_demasiado_grande y no guarda nada", async () => {
    const m = await mundoVentas(e, backend);
    await sembrarVentas(admin, m, 19_999);
    const api = new SireApiControlado().responder([
      fila("N001", "1"),
      fila("N001", "2"),
    ]);
    const r = await conWorker(api, () => descargar(m));
    expect([r.estado, r.motivo, r.intentos]).toEqual([
      "error",
      "datos_invalidos",
      0,
    ]);
    expect(await contarVentas(admin, m.c.id)).toBe(19_999);
    // Solo queda el encabezado sembrado: la descarga fallida no dejó el suyo.
    expect(await propuestasDe(admin, m.c.id)).toHaveLength(1);
  });

  it("19.999 + 1 nueva llega justo a 20.000 vivas y se guarda; lo igual no cuenta contra el tope", async () => {
    const m = await mundoVentas(e, backend);
    await sembrarVentas(admin, m, 19_999);
    const api = new SireApiControlado().responder([
      fila("S001", "1"), // igual a la sembrada
      fila("N001", "1"), // nueva
    ]);
    const r = await conWorker(api, () => descargar(m));
    expect(r.estado).toBe("completado");
    expect(r.resultado).toMatchObject({
      recibidas: 2,
      nuevas: 1,
      iguales: 1,
      distintas: 0,
    });
    expect(await contarVentas(admin, m.c.id)).toBe(20_000);
  });

  it("una fila descuadrada pero legible se guarda tal cual llegó (nunca se corrige ni se descarta)", async () => {
    const m = await mundoVentas(e, backend);
    const api = new SireApiControlado().responder([
      fila("B001", "290", { total: "119.00" }), // 100.00 + 18.00 ≠ 119.00
    ]);
    const r = await conWorker(api, () => descargar(m));
    expect(r.estado).toBe("completado");
    const [v] = await ventasDe(admin, m.c.id);
    expect(v).toMatchObject({
      base_gravada: "100.00",
      igv: "18.00",
      total: "119.00",
    });
    expect(r.resultado).toMatchObject({ nuevas: 1 });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("CA-11: complementar (D16)", () => {
  /** Primera descarga (290 y 292), 291 agregada a mano y justificada, y el cliente listo para la segunda descarga. */
  async function periodoTrabajado(api: SireApiControlado) {
    const m = await mundoVentas(e, backend);
    api.responder(boletas290y292());
    const primera = await descargar(m);
    expect(primera.estado).toBe("completado");
    const manual = fila("B001", "291", {
      tipoDocContraparte: "0",
      fechaEmision: "2026-10-04",
    });
    const idManual = await sembrarManual(admin, m, manual);
    const idSalto = await sembrarSalto(admin, m, { desde: 291, hasta: 291 });
    const antes = await ventasDe(admin, m.c.id);
    return { m, primera, manual, idManual, idSalto, antes };
  }

  it("la 293 es nueva y la 290 trae otro total: solo se inserta la 293; 290 y 291 intactas, la 290 sale en las diferencias, la justificación sigue y el resultado (≤ 4 KB) lo informa", async () => {
    const api = new SireApiControlado();
    await conWorker(api, async () => {
      const { m, primera, idManual, idSalto, antes } =
        await periodoTrabajado(api);
      api.responder([
        fila("B001", "290", { total: "120.00" }),
        fila("B001", "293", { fechaEmision: "2026-10-08" }),
      ]);
      const segunda = await descargar(m);
      expect(segunda.estado).toBe("completado");

      const despues = await ventasDe(admin, m.c.id);
      expect(despues.map((v) => v.clave)).toEqual([
        "03|B001|290",
        "03|B001|291",
        "03|B001|292",
        "03|B001|293",
      ]);
      // Las tres que ya había son la misma fila, sin tocar (ni siquiera cambia su id ni su propuesta).
      for (const v of antes)
        expect(despues.find((d) => d.id === v.id)).toEqual(v);
      expect(despues.find((v) => v.clave === "03|B001|290")).toMatchObject({
        total: "118.00",
        propuesta_id: primera.resultado!.propuestaId,
      });
      expect(despues.find((v) => v.id === idManual)).toMatchObject({
        origen: "manual",
        propuesta_id: null,
      });

      const props = await propuestasDe(admin, m.c.id);
      expect(props).toHaveLength(2);
      const p2 = props.find((p) => p.trabajo_id === segunda.id)!;
      expect(p2).toMatchObject({
        filas_recibidas: 2,
        filas_nuevas: 1,
        filas_iguales: 0,
        filas_distintas: 1,
        usuario_id: m.u,
      });
      expect(despues.find((v) => v.clave === "03|B001|293")!.propuesta_id).toBe(
        p2.id,
      );
      expect(
        await diferenciasDe(admin, primera.resultado!.propuestaId),
      ).toEqual([]);
      expect(await diferenciasDe(admin, p2.id)).toEqual([
        {
          propuesta_id: p2.id,
          clave: "03|B001|290",
          tipo: "03",
          serie: "B001",
          numero: "290",
          origen_existente: "sire",
          campos: ["total"],
          valores_sire: { total: "120.00" },
        },
      ]);

      // La justificación del contador sigue vigente y sin cambios.
      const saltos = await saltosDe(admin, m.c.id);
      expect(saltos).toHaveLength(1);
      expect(saltos[0]).toMatchObject({
        id: idSalto,
        desde: 291,
        hasta: 291,
        comentario: "Boleta anulada en caja",
        revertido_en: null,
      });

      expect(segunda.resultado).toEqual({
        propuestaId: p2.id,
        recibidas: 2,
        nuevas: 1,
        iguales: 0,
        distintas: 1,
        claves: ["03|B001|290"],
        truncado: false,
      });
      expect(bytes(segunda.resultado)).toBeLessThanOrEqual(4096);
    });
  });

  it("repetir con los mismos datos da 0 nuevas, otra propuesta y ninguna fila de más", async () => {
    const m = await mundoVentas(e, backend);
    const api = new SireApiControlado();
    await conWorker(api, async () => {
      const primera = await descargar(m); // conjunto genérico: 290 y 292, sin tipo de documento de la contraparte
      const segunda = await descargar(m);
      const tercera = await descargar(m);
      expect(primera.resultado).toMatchObject({
        nuevas: 2,
        iguales: 0,
        distintas: 0,
      });
      for (const r of [segunda, tercera]) {
        expect(r.estado).toBe("completado");
        expect(r.resultado).toMatchObject({
          recibidas: 2,
          nuevas: 0,
          iguales: 2,
          distintas: 0,
          claves: [],
          truncado: false,
        });
      }
    });
    expect(await contarVentas(admin, m.c.id)).toBe(2);
    const props = await propuestasDe(admin, m.c.id);
    expect(props).toHaveLength(3);
    expect(
      props
        .slice(1)
        .map((p) => [p.filas_nuevas, p.filas_iguales, p.filas_distintas]),
    ).toEqual([
      [0, 2, 0],
      [0, 2, 0],
    ]);
    expect(await contarDiferencias(admin, m.c.id)).toBe(0);
  });

  it("la misma descarga con una distinta se repite igual: la 290 sigue informándose y la 293 ya es igual", async () => {
    const api = new SireApiControlado();
    await conWorker(api, async () => {
      const { m } = await periodoTrabajado(api);
      api.responder([
        fila("B001", "290", { total: "120.00" }),
        fila("B001", "293"),
      ]);
      await descargar(m);
      const otra = await descargar(m);
      expect(otra.resultado).toMatchObject({
        recibidas: 2,
        nuevas: 0,
        iguales: 1,
        distintas: 1,
        claves: ["03|B001|290"],
      });
      expect(await contarVentas(admin, m.c.id)).toBe(4);
    });
  });

  it("la 291 que el SIRE trae con otro total que la agregada a mano se informa (origen manual) y la agregada no cambia", async () => {
    const api = new SireApiControlado();
    await conWorker(api, async () => {
      const { m, idManual, antes } = await periodoTrabajado(api);
      api.responder([
        fila("B001", "291", {
          tipoDocContraparte: "0",
          fechaEmision: "2026-10-04",
          total: "130.00",
        }),
      ]);
      const r = await descargar(m);
      expect(r.resultado).toMatchObject({
        recibidas: 1,
        nuevas: 0,
        iguales: 0,
        distintas: 1,
        claves: ["03|B001|291"],
      });
      const despues = await ventasDe(admin, m.c.id);
      expect(despues).toEqual(antes); // ni una fila más ni una cambiada
      expect(despues.find((v) => v.id === idManual)!.total).toBe("118.00");
      const dif = await diferenciasDe(admin, r.resultado!.propuestaId);
      expect(dif).toHaveLength(1);
      expect(dif[0]).toMatchObject({
        clave: "03|B001|291",
        origen_existente: "manual",
        campos: ["total"],
        valores_sire: { total: "130.00" },
      });
    });
  });

  it("la 291 que el SIRE trae igual a la agregada a mano cuenta como igual y no se duplica", async () => {
    const api = new SireApiControlado();
    await conWorker(api, async () => {
      const { m, manual, antes } = await periodoTrabajado(api);
      api.responder([manual]);
      const r = await descargar(m);
      expect(r.resultado).toMatchObject({
        recibidas: 1,
        nuevas: 0,
        iguales: 1,
        distintas: 0,
        claves: [],
      });
      expect(await ventasDe(admin, m.c.id)).toEqual(antes);
    });
  });

  it("lo que el SIRE dejó de traer no se borra: una descarga con solo la 292 deja la 290 y la 291", async () => {
    const api = new SireApiControlado();
    await conWorker(api, async () => {
      const { m, antes } = await periodoTrabajado(api);
      api.responder([boletas290y292()[1]!]);
      const r = await descargar(m);
      expect(r.resultado).toMatchObject({
        recibidas: 1,
        nuevas: 0,
        iguales: 1,
        distintas: 0,
      });
      expect(await ventasDe(admin, m.c.id)).toEqual(antes);
    });
  });

  it("cada periodo se complementa por separado: la misma clave en otro periodo es nueva", async () => {
    const api = new SireApiControlado().responder(boletas290y292());
    const m = await mundoVentas(e, backend);
    await conWorker(api, async () => {
      await descargar(m, { periodo: "202609" });
      const otro = await descargar(m, { periodo: "202610" });
      expect(otro.resultado).toMatchObject({
        nuevas: 2,
        iguales: 0,
        distintas: 0,
      });
    });
    expect(await contarVentas(admin, m.c.id, "202609")).toBe(2);
    expect(await contarVentas(admin, m.c.id, "202610")).toBe(2);
  });

  it("el resultado pesa ≤ 4 KB aun con 20.000 filas distintas, lista a lo más 40 claves, avisa que se truncó y no lleva montos", async () => {
    const m = await mundoVentas(e, backend);
    await sembrarVentas(admin, m, 20_000); // S001-1..20000 de S/ 118.00
    const api = new SireApiControlado().responder(
      muchas(20_000, "S001", {
        baseGravada: "200.00",
        igv: "36.00",
        total: "236.00",
      }),
    );
    const r = await conWorker(api, () => descargar(m));
    expect(r.estado).toBe("completado");
    const res = r.resultado!;
    expect(res).toMatchObject({
      recibidas: 20_000,
      nuevas: 0,
      iguales: 0,
      distintas: 20_000,
      truncado: true,
    });
    expect(res.claves).toHaveLength(40);
    expect(bytes(res)).toBeLessThanOrEqual(4096);
    expect(JSON.stringify(res)).not.toMatch(/\d+\.\d{2}/);
    expect(Object.keys(res).sort()).toEqual([
      "claves",
      "distintas",
      "iguales",
      "nuevas",
      "propuestaId",
      "recibidas",
      "truncado",
    ]);
    // La lista completa queda en la tabla y nada de lo existente cambió.
    expect(await contarDiferencias(admin, m.c.id)).toBe(20_000);
    expect(await contarVentas(admin, m.c.id)).toBe(20_000);
    const cambiadas = await admin.pool.query(
      "select count(*)::int as n from venta where cliente_id = $1 and total <> 118",
      [m.c.id],
    );
    expect(cambiadas.rows[0].n).toBe(0);
  });

  it("dos descargas simultáneas del mismo cliente y periodo (30 rondas): sin 40P01 ni filas duplicadas; una agrega y la otra encuentra todo igual", async () => {
    // Por la cola no pueden correr dos a la vez (deduplicación de 008 D8 y lock del RUC), así que se invoca el procesador
    // directo con dos trabajos reales, sin worker en marcha. Es la carrera que importa: worker contra worker de otro
    // proceso, o contra una importación (la de importación va en T6).
    // Importación dinámica con nombre en variable: así solo esta prueba falla (y `tsc` no se rompe) mientras T12 no exista.
    const modulo = "./descargar-propuesta.js";
    const { descargarPropuesta } = (await import(
      /* @vite-ignore */ modulo
    )) as {
      descargarPropuesta: (d: {
        db: ContappDb;
        sireApi: SireApiControlado;
      }) => (ctx: unknown) => Promise<unknown>;
    };
    const m = await mundoVentas(e, backend);
    const dbWorker = crearDbRol("contapp_worker");
    const api = new SireApiControlado().responder([
      ...boletas290y292(),
      fila("B001", "293", { fechaEmision: "2026-10-08" }),
    ]);
    api.barrera(2);
    const proc = descargarPropuesta({ db: dbWorker, sireApi: api });
    try {
      for (let i = 0; i < 30; i++) {
        const periodo = `${2024 + Math.floor(i / 12)}${String((i % 12) + 1).padStart(2, "0")}`;
        const a = await encolarDescarga(backend, redis, prefijo, m, {
          periodo,
        });
        await liberarDedupe(admin, a);
        const b = await encolarDescarga(backend, redis, prefijo, m, {
          periodo,
        });
        const ctx = (id: string) => ({
          trabajo: {
            id,
            tenantId: m.T,
            clienteId: m.c.id,
            ruc: m.c.ruc,
            tipo: TIPO_DESCARGA,
            parametros: { periodo, libro: "ventas" },
            intentos: 0,
            creadoPor: m.u,
          },
          conToken: <T>(usar: (t: string) => Promise<T>) =>
            usar("token-de-prueba"),
        });
        api.barrera(2); // reinicia la barrera de la ronda
        const resultados = (await Promise.all([
          proc(ctx(a)),
          proc(ctx(b)),
        ])) as Resultado[];

        expect(resultados.map((r) => r.nuevas).sort(), `ronda ${i}`).toEqual([
          0, 3,
        ]);
        expect(resultados.map((r) => r.iguales).sort(), `ronda ${i}`).toEqual([
          0, 3,
        ]);
        expect(
          resultados.map((r) => r.distintas),
          `ronda ${i}`,
        ).toEqual([0, 0]);
        const ventas = await ventasDe(admin, m.c.id, periodo);
        expect(
          ventas.map((v) => v.clave),
          `ronda ${i}`,
        ).toEqual(["03|B001|290", "03|B001|292", "03|B001|293"]);
        expect(
          await propuestasDe(admin, m.c.id, periodo),
          `ronda ${i}`,
        ).toHaveLength(2);
      }
    } finally {
      // Los trabajos quedaron `en_cola` sin worker: se cancelan para que ningún worker posterior los recoja.
      await admin.pool
        .query(
          "update job_registro set estado = 'cancelado', motivo = 'cancelado_usuario', terminado_en = now(), actualizado_en = now() where cliente_id = $1 and estado = 'en_cola'",
          [m.c.id],
        )
        .catch(() => undefined);
      await dbWorker.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("D18: comprobantes repetidos dentro de una misma descarga", () => {
  /** 290 dos veces idéntica (una con ceros a la izquierda), 292 dos veces con otro total y la 293 una sola vez. */
  const REPETIDAS = (): FilaVenta[] => [
    fila("B001", "290"),
    fila("B001", "290"),
    fila("B001", "0290"),
    fila("B001", "292", { baseGravada: "50.00", igv: "9.00", total: "59.00" }),
    fila("B001", "292", { baseGravada: "50.00", igv: "9.00", total: "60.00" }),
    fila("B001", "293"),
  ];

  it("se guarda la primera aparición; las idénticas cuentan como iguales y la que difiere como distinta (recibidas = nuevas + iguales + distintas)", async () => {
    const m = await mundoVentas(e, backend);
    const api = new SireApiControlado().responder(REPETIDAS());
    const r = await conWorker(api, () => descargar(m));
    expect([r.estado, r.intentos]).toEqual(["completado", 0]);

    const ventas = await ventasDe(admin, m.c.id);
    expect(ventas.map((v) => v.clave)).toEqual([
      "03|B001|290",
      "03|B001|292",
      "03|B001|293",
    ]);
    // De la 292 quedó la primera aparición (59.00), no la segunda (60.00).
    expect(ventas.find((v) => v.clave === "03|B001|292")!.total).toBe("59.00");

    const [p] = await propuestasDe(admin, m.c.id);
    expect(p).toMatchObject({
      filas_recibidas: 6,
      filas_nuevas: 3,
      filas_iguales: 2,
      filas_distintas: 1,
    });
    expect(r.resultado).toEqual({
      propuestaId: p!.id,
      recibidas: 6,
      nuevas: 3,
      iguales: 2,
      distintas: 1,
      claves: ["03|B001|292"],
      truncado: false,
    });
  });

  it("la distinta repetida queda también en propuesta_diferencia, con el valor de la aparición que difiere (la lista completa es la de la tabla)", async () => {
    const m = await mundoVentas(e, backend);
    const api = new SireApiControlado().responder(REPETIDAS());
    const r = await conWorker(api, () => descargar(m));
    const dif = await diferenciasDe(admin, r.resultado!.propuestaId);
    expect(dif).toHaveLength(1);
    expect(dif[0]).toMatchObject({
      clave: "03|B001|292",
      tipo: "03",
      serie: "B001",
      numero: "292",
      origen_existente: "sire",
      campos: ["total"],
      valores_sire: { total: "60.00" },
    });
  });

  it("una repetida de un comprobante que ya estaba en el periodo cuenta contra la fila existente, no contra la primera aparición", async () => {
    const m = await mundoVentas(e, backend);
    const api = new SireApiControlado().responder(boletas290y292());
    await conWorker(api, async () => {
      await descargar(m);
      api.responder([
        fila("B001", "290"), // igual a la existente
        fila("B001", "290", { total: "120.00" }), // difiere de la existente
      ]);
      const r = await descargar(m);
      expect(r.resultado).toMatchObject({
        recibidas: 2,
        nuevas: 0,
        iguales: 1,
        distintas: 1,
        claves: ["03|B001|290"],
      });
    });
    expect(await contarVentas(admin, m.c.id)).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("secretos y contenido crudo (RNF-004)", () => {
  it("ni el token SIRE, ni los secretos del cliente, ni el contenido de una fila ilegible aparecen en logs, job_registro, Redis ni tablas", async () => {
    const ok = await mundoVentas(e, backend);
    const caido = await mundoVentas(e, backend);
    const malo = await mundoVentas(e, backend);
    const ilegible = await mundoVentas(e, backend);
    const token = canario("token_sire");
    const montoSucio = canario("monto");
    const secretos = [
      token,
      montoSucio,
      ...[ok, caido, malo, ilegible].flatMap((m) => [
        m.secretos.clave,
        m.secretos.clientSecret,
      ]),
    ];

    // Errores del puerto con el secreto en el mensaje, en la causa y en propiedades.
    const sucio = (s: string): Error =>
      Object.assign(new Error(`rechazo con ${s}`, { cause: new Error(s) }), {
        detail: s,
      });
    const api = new SireApiControlado().responder((s) => {
      if (s.ruc === caido.c.ruc) throw new ErrorTransitorio(sucio(token));
      if (s.ruc === malo.c.ruc) throw new ErrorCredencial(sucio(token));
      if (s.ruc === ilegible.c.ruc)
        return [fila("B001", "290", { total: montoSucio })];
      return boletas290y292();
    });

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

    try {
      await conWorker(
        api,
        async () => {
          const r = [];
          for (const m of [ok, caido, malo, ilegible])
            r.push(await descargar(m, {}, 30_000));
          expect(r.map((x) => [x.estado, x.motivo])).toEqual([
            ["completado", null],
            ["error", "sunat_no_responde"],
            ["error", "credencial_invalida"],
            ["error", "datos_invalidos"],
          ]);
        },
        { sireAuth: new SireAuthTokenFijo(token), logger },
      );

      // El token sí llegó al puerto (la prueba no es vacua).
      expect(api.llamadas.length).toBeGreaterThan(0);
      expect(api.llamadas.every((l) => l.token === token)).toBe(true);

      const jobs = await e.volcarJobs();
      const todoRedis = await volcarPrefijo(redis, prefijo);
      const logs = volcado(llamadas) + "\n" + capturado.join("\n");
      const tablas = await volcarTablasVentas(admin, e.estudios);
      for (const s of secretos)
        for (const x of rastros(s)) {
          expect(jobs, "job_registro").not.toContain(x);
          expect(todoRedis, "Redis").not.toContain(x);
          expect(logs, "logs").not.toContain(x);
          expect(tablas, "tablas de propuesta y ventas").not.toContain(x);
        }
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
