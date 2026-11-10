import type { ContappDb } from "@contapp/db";
import { ErrorTransitorio } from "@contapp/sunat";
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
import { esperarTerminal } from "../../../test/procesadores-007b.js";
import { loggerEspia, volcado } from "../../../test/soporte.js";
import {
  PERIODO,
  RUC_FIXTURE,
  RUC_PROVEEDOR,
  SireApiControlado,
  comprasDe,
  encolarDescarga,
  filaCompra,
  limpiarCompras,
  mundoVentas,
  sembrarCompra,
  versionesDe,
  volcarTablasCompras,
  type MundoVentas,
} from "../../../test/compras.js";
import {
  Escenario,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  esperarHasta,
  fijarConfig,
  limpiarPrefijo,
  minimoTx,
  notificadorEspia,
  nuevoPrefijo,
  restaurarConfig,
  rucNuevo,
  volcarPrefijo,
  type ProcesoWorker,
} from "../../../test/trabajos.js";
import {
  EMISORES,
  NUMEROS_FIXTURE,
  RESULTADO_CERO,
  arrancarXml,
  canarioXml,
  claveXml,
  contarDocumentos,
  documentosDe,
  encolarXml,
  esperarLotesXml,
  evaluacionesDe,
  fixtureXml,
  hallazgosEvaluadosDe,
  limpiarXml,
  obtencionesDe,
  puertosXml,
  reemplazar,
  sha256Hex,
  trabajosXmlDe,
  volcarTablasXml,
  type PuertosXml,
  type TrabajoXmlBd,
} from "../../../test/xml.js";

// Spec 016, T6 (rojo; integración con PostgreSQL y Redis reales, BullMQ real, `MockXmlProvider` y un storage en memoria):
// el procesador `xml.obtener` y los lotes que la descarga de la propuesta encola (D-7, D-11, P-4, P-7; CA-6, CA-10, CA-11).
// Se encola como lo hace el backend (rol backend) o lo encola el propio worker tras la descarga, y lo ejecuta el worker.
//
// CONTRATO que fija (T12), además del de test/xml.ts:
// - Tras CADA descarga de compras (también la que no trae filas nuevas) el worker encola, en lotes de hasta 100 y en
//   prioridad `programado`, `xml.obtener` para las compras vivas del periodo sin XML guardado, sin `pendiente` vivo y sin
//   `no_encontrado`/`credencial` previos; las que tienen hallazgos van primero. Un lote tiene `compraIds` ordenados y
//   únicos. Si la cola está llena se detiene sin fallar la descarga ni cambiar su `resultado` (el de 013).
// - `xml.obtener` (cola `xml`, canal `ninguno`, sin credencial): por compra, omite la que ya tiene XML; pide al
//   `XmlProvider` fuera de transacción con `referencia` de la versión 1; guarda en storage los bytes del XML (en su
//   codificación declarada) en `xml/{tenant}/{cliente}/{uuid}.xml` y en BD (`documento_xml`, origen `simulado`).
// - Resultado por comprobante, EXCLUYENTE (la suma de los seis contadores es el tamaño del lote):
//   guardado | omitido (ya había XML) | noEncontrados (`ErrorDatos` del proveedor) | credencial (`ErrorCredencial`, sin
//   reintento y sin tocar la credencial del cliente) | transitorios (`ErrorTransitorio` o error desconocido) | invalidos
//   (XML ilegible, hostil o ajeno: no se guarda nada ni en storage ni en BD). El estado de obtención queda en
//   `documento_xml_obtencion` (invalido -> `no_encontrado`).
// - El trabajo termina `completado` con `resultado` = `{guardados, omitidos, noEncontrados, credencial, transitorios,
//   invalidos}` (solo conteos). Si quedó algún transitorio, lo ya guardado se conserva y el trabajo lanza
//   `ErrorTransitorio` para que 008 reintente el lote (lo guardado se omite); agotados los reintentos queda
//   `error/sunat_no_responde`.
// - Con `xmlSimuladoEnReglas` el XML guardado re-evalúa la compra (evaluación `n + 1` sin versión nueva); apagada, solo se
//   guarda (P-4). Un XML rechazado nunca re-evalúa.
// - Ni el XML, ni montos, glosas, razones sociales o rutas de storage llegan a logs, `job_registro`, Redis ni errores.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const REINTENTOS = 2;
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
    reintentos: 1,
    base: 100,
  });
  await fijarConfig(admin, "xml", {
    global: 4,
    tenant: 2,
    espera: 0,
    reintentos: REINTENTOS,
    base: 100,
  });
});

afterAll(async () => {
  await restaurarConfig(admin).catch(() => undefined);
  await limpiarXml(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarCompras(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  for (const x of prefijos)
    await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), admin?.close()]);
});

// ---------------------------------------------------------------------------------------------------------------
// Soporte local
// ---------------------------------------------------------------------------------------------------------------

/** Arranca el worker con los puertos de la prueba, corre `fn` y lo detiene. */
async function conWorker<T>(
  p: PuertosXml,
  simuladoEnReglas: boolean,
  fn: (w: ProcesoWorker) => Promise<T>,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const w = await arrancarXml(prefijo, p, { simuladoEnReglas, ...extra });
  try {
    return await fn(w);
  } finally {
    await w.detener({ esperaMs: 2000 });
  }
}

interface ResultadoDescarga {
  propuestaId: string;
  recibidas: number;
  nuevas: number;
  iguales: number;
  distintas: number;
  claves: string[];
  truncado: boolean;
}

/** Encola una descarga de compras y espera su fin (el worker ya debe estar en marcha). */
async function descargar(m: MundoVentas, timeoutMs = 30_000) {
  const id = await encolarDescarga(backend, redis, prefijo, m, { libro: "compras" });
  const f = await esperarTerminal(e, id, timeoutMs);
  return {
    id,
    estado: f.estado,
    motivo: f.motivo,
    resultado: (f as { resultado?: unknown }).resultado as ResultadoDescarga | null,
  };
}

const lotes = (m: MundoVentas, minimo: number, timeoutMs = 25_000) =>
  esperarLotesXml(admin, m.c.id, minimo, esperarHasta, timeoutMs);

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

/** Compra sembrada de un comprobante del proveedor sintético (o del emisor del fixture, si `numero` es de un fixture). */
async function sembrarComprobante(
  m: Pick<MundoVentas, "T" | "u" | "c">,
  numero: string,
  o: { periodo?: string } = {},
): Promise<string> {
  return sembrarCompra(
    admin,
    m,
    filaCompra(numero, { rucContraparte: EMISORES[numero] ?? RUC_PROVEEDOR }),
    { periodo: o.periodo },
  );
}

const porNumero = async (m: MundoVentas) =>
  new Map((await comprasDe(admin, m.c.id)).map((c) => [c.numero, c]));

/** Todo lo observable de un cliente donde podría colarse un canario. */
async function buscarEn(
  m: MundoVentas,
  p: PuertosXml,
  extra: unknown[] = [],
): Promise<string> {
  return [
    await e.volcarJobs(),
    await volcarTablasXml(admin, [m.T]),
    await volcarTablasCompras(admin, [m.T]),
    await volcarPrefijo(redis, prefijo),
    p.almacen.volcado(),
    JSON.stringify(p.xml.mock.registro()),
    ...extra.map((x) => volcado(x)),
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
describe("CA-10: lotes tras la descarga de la propuesta", () => {
  it("tras descargar los fixtures se encola UN lote (xml, ninguno, programado) con las 5 compras y se guardan 5 XML simulados", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const p = puertosXml();
    const r = await conWorker(p, false, async () => {
      const d = await descargar(m);
      return { d, lotes: await lotes(m, 1) };
    });

    // El resultado de la descarga es el de 013: la gancho posterior no le suma nada.
    expect([r.d.estado, r.d.motivo]).toEqual(["completado", null]);
    expect(Object.keys(r.d.resultado!).sort()).toEqual(
      ["claves", "distintas", "iguales", "nuevas", "propuestaId", "recibidas", "truncado"],
    );
    expect(r.d.resultado).toMatchObject({ recibidas: 5, nuevas: 5 });

    const compras = await comprasDe(admin, m.c.id);
    expect(compras).toHaveLength(5);
    expect(r.lotes).toHaveLength(1);
    const lote = r.lotes[0]!;
    expect(lote).toMatchObject({
      cola: "xml",
      canal: "ninguno",
      prioridad: "programado",
      estado: "completado",
      motivo: null,
      intentos: 0,
    });
    expect(Object.keys(lote.parametros).sort()).toEqual(["compraIds", "periodo"]);
    expect(lote.parametros.periodo).toBe(PERIODO);
    expect(lote.parametros.compraIds).toEqual(compras.map((c) => c.id).sort());
    expect(lote.resultado).toEqual({ ...RESULTADO_CERO, guardados: 5 });
    expect(bytes(lote.resultado)).toBeLessThanOrEqual(4096);

    // BD: un documento por comprobante, origen simulado, n = 1, ruta armada sin datos del comprobante.
    const docs = await documentosDe(admin, m.c.id);
    expect(docs).toHaveLength(5);
    const rutas = new Set<string>();
    for (const d of docs) {
      expect(d, d.numero).toMatchObject({
        tipo: "01",
        serie: "F001",
        n: 1,
        origen: "simulado",
        subido_por: null,
      });
      expect(d.ruc_emisor).toBe(EMISORES[d.numero]);
      expect(d.ruta).toMatch(
        new RegExp(`^xml/${m.T}/${m.c.id}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.xml$`),
      );
      rutas.add(d.ruta);
      // Storage: exactamente los bytes del fixture, y el hash y el tamaño son los de esos bytes.
      const guardado = Buffer.from(await p.almacen.leer(d.ruta));
      const original = Buffer.from(fixtureXml(d.numero), "utf8");
      expect(Buffer.compare(guardado, original), `bytes de ${d.numero}`).toBe(0);
      expect(d.sha).toBe(sha256Hex(original));
      expect(d.tamano).toBe(original.length);
    }
    expect(rutas.size, "una ruta distinta por documento").toBe(5);
    expect([...rutas].sort()).toEqual(p.almacen.rutas().sort());
    expect(p.almacen.intentosGuardar).toHaveLength(5);

    // El registro del mock: 5 pedidos buenos, de fixture.
    const reg = p.xml.mock.registro();
    expect(reg).toHaveLength(5);
    expect(reg.every((x) => x.resultado === "ok" && x.fuente === "fixture")).toBe(true);
    expect(reg.map((x) => x.clave).sort()).toEqual(NUMEROS_FIXTURE.map(claveXml).sort());

    // Sin la bandera, guardar el XML no toca las compras: una sola versión y ninguna evaluación nueva.
    for (const c of compras) {
      expect(c.version_vigente).toBe(1);
      expect(await versionesDe(admin, c.id)).toHaveLength(1);
    }
  });

  it("la referencia que recibe el proveedor es la fila del SIRE (versión 1): mixta en PEN y la de USD con su tipo de cambio", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const p = puertosXml();
    await conWorker(p, false, async () => {
      await descargar(m);
      await lotes(m, 1);
    });
    const pedidos = new Map(p.xml.llamadas.map((l) => [l.solicitud.numero, l.solicitud]));
    expect(pedidos.size).toBe(5);
    expect(pedidos.get("2056")).toMatchObject({
      rucEmisor: "20700000045",
      tipo: "01",
      serie: "F001",
      numero: "2056",
      referencia: {
        fechaEmision: "2026-10-05",
        moneda: "PEN",
        baseGravada: "21.48",
        igv: "1.61",
        noGravado: "0.00",
        isc: "0.00",
        icbper: "0.00",
        otros: "0.00",
        total: "23.09",
      },
    });
    expect(pedidos.get("4062")!.referencia).toMatchObject({
      moneda: "USD",
      tipoCambio: "3.300",
      igv: "0.03",
      total: "0.18",
    });
    expect(pedidos.get("3064")!.referencia).toMatchObject({ icbper: "1.50", total: "119.50" });
  });

  it("las compras con hallazgos van en el primer lote; los lotes son de 100, ordenados y únicos", async () => {
    const m = await mundoVentas(e, backend);
    const p = puertosXml();
    const api = new SireApiControlado();
    // 130 comprobantes; el último dígito del número nunca es 7, 8 ni 9 (centinelas del mock). Los 5 últimos tienen un IGV
    // que no cuadra (R-MIX): son los únicos con hallazgos y, sin prioridad, caerían en el segundo lote.
    const filas = Array.from({ length: 130 }, (_, i) =>
      filaCompra(String(1000 + i * 10 + (i % 7)), i >= 125 ? { igvDg: "17.00", total: "117.00" } : {}),
    );
    api.responder(filas as never);
    const r = await conWorker(
      p,
      false,
      async () => {
        const d = await descargar(m);
        return { d, lotes: await lotes(m, 2) };
      },
      { sireApi: api },
    );
    expect(r.d.estado).toBe("completado");
    expect(r.d.resultado).toMatchObject({ recibidas: 130, nuevas: 130 });

    const compras = await comprasDe(admin, m.c.id);
    const conHallazgos = new Set(
      (
        await admin.pool.query(
          "select distinct compra_id from compra_hallazgo where compra_id = any($1::uuid[])",
          [compras.map((c) => c.id)],
        )
      ).rows.map((f: { compra_id: string }) => f.compra_id),
    );
    expect(conHallazgos.size, "precondición: algunas, pero cabrían en un lote").toBeGreaterThanOrEqual(5);
    expect(conHallazgos.size).toBeLessThan(100);

    expect(r.lotes).toHaveLength(2);
    const [primero, segundo] = r.lotes as [TrabajoXmlBd, TrabajoXmlBd];
    expect(primero.parametros.compraIds).toHaveLength(100);
    expect(segundo.parametros.compraIds).toHaveLength(30);
    for (const l of r.lotes) {
      expect(l).toMatchObject({ cola: "xml", canal: "ninguno", prioridad: "programado" });
      const ids = l.parametros.compraIds;
      expect(ids, "ordenados").toEqual([...ids].sort());
      expect(new Set(ids).size, "únicos").toBe(ids.length);
    }
    for (const id of conHallazgos)
      expect(primero.parametros.compraIds, "con hallazgos, en el primer lote").toContain(id);
    // Entre los dos cubren todas las compras, cada una una sola vez.
    expect(
      [...primero.parametros.compraIds, ...segundo.parametros.compraIds].sort(),
    ).toEqual(compras.map((c) => c.id).sort());
  });

  it("repetir la descarga no duplica trabajos, ni pedidos al proveedor, ni filas de documento_xml; repetir el lote omite lo guardado", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const p = puertosXml();
    await conWorker(p, false, async () => {
      await descargar(m);
      const primeros = await lotes(m, 1);
      expect(primeros).toHaveLength(1);
      expect(await contarDocumentos(admin, m.c.id)).toBe(5);
      expect(p.xml.mock.registro()).toHaveLength(5);

      // Segunda descarga: nada nuevo; ya hay XML guardado, así que no hay nada que encolar.
      const otra = await descargar(m);
      expect(otra.resultado).toMatchObject({ nuevas: 0, iguales: 5 });
      expect(await trabajosXmlDe(admin, m.c.id), "no hay un segundo lote").toHaveLength(1);
      expect(await contarDocumentos(admin, m.c.id)).toBe(5);
      expect(p.xml.mock.registro(), "el XML ya guardado no se vuelve a pedir").toHaveLength(5);

      // Aun pidiéndolo a mano (lote ya completado, así que no hay dedupe): todo se omite.
      const compras = await comprasDe(admin, m.c.id);
      const id = await encolarXml(backend, redis, prefijo, m, compras.map((c) => c.id));
      const f = await esperarTerminal(e, id);
      expect([f.estado, f.motivo]).toEqual(["completado", null]);
      expect((f as { resultado?: unknown }).resultado).toEqual({ ...RESULTADO_CERO, omitidos: 5 });
    });
    expect(await contarDocumentos(admin, m.c.id)).toBe(5);
    expect(p.xml.mock.registro(), "ningún pedido nuevo al proveedor").toHaveLength(5);
    expect(p.almacen.intentosGuardar, "ni una escritura nueva en storage").toHaveLength(5);
    expect((await documentosDe(admin, m.c.id)).every((d) => d.n === 1)).toBe(true);
  });

  it("repetir la descarga mientras el lote sigue en marcha tampoco duplica el trabajo ni los pedidos", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const p = puertosXml();
    p.xml.pausar();
    await conWorker(p, false, async () => {
      await descargar(m);
      await esperarHasta(() => p.xml.llamadas.length > 0, "el proveedor recibe el primer pedido");
      const otra = await descargar(m);
      expect(otra.estado).toBe("completado");
      expect(await trabajosXmlDe(admin, m.c.id), "un solo lote vivo").toHaveLength(1);
      p.xml.abrir();
      const fin = await lotes(m, 1);
      expect(fin).toHaveLength(1);
      expect(fin[0]!.resultado).toEqual({ ...RESULTADO_CERO, guardados: 5 });
    });
    expect(await contarDocumentos(admin, m.c.id)).toBe(5);
    expect(p.xml.mock.registro()).toHaveLength(5);
  });

  it("con la cola de XML llena se detiene en el primer lote: la descarga termina bien y su resultado no cambia", async () => {
    const m = await mundoVentas(e, backend);
    const p = puertosXml();
    const api = new SireApiControlado();
    api.responder(
      Array.from({ length: 130 }, (_, i) => filaCompra(String(2000 + i * 10 + (i % 7)))) as never,
    );
    p.xml.pausar(); // el primer lote queda vivo mientras la descarga intenta encolar el segundo
    await fijarConfig(admin, "xml", { maxPendientes: 1 });
    try {
      await conWorker(
        p,
        false,
        async () => {
          const d = await descargar(m);
          expect([d.estado, d.motivo]).toEqual(["completado", null]);
          expect(Object.keys(d.resultado!).sort()).toEqual(
            ["claves", "distintas", "iguales", "nuevas", "propuestaId", "recibidas", "truncado"],
          );
          const vivos = await trabajosXmlDe(admin, m.c.id);
          expect(vivos, "solo el primer lote entró").toHaveLength(1);
          expect(vivos[0]!.parametros.compraIds).toHaveLength(100);
          p.xml.abrir();
        },
        { sireApi: api },
      );
    } finally {
      p.xml.abrir();
      await fijarConfig(admin, "xml", { maxPendientes: 2000 });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("CA-11: fallos del proveedor (centinelas 8, 7 y 9)", () => {
  it("centinela 8 (no encontrado): se anota y no se reintenta; el trabajo termina bien con el conteo", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const id8 = await sembrarComprobante(m, "1008");
    const p = puertosXml();
    const f = await conWorker(p, false, async () => {
      const j = await encolarXml(backend, redis, prefijo, m, [id8]);
      const f = await esperarTerminal(e, j);
      await new Promise((r) => setTimeout(r, 600)); // más que el backoff: un reintento indebido volvería a llamar
      return f;
    });
    expect([f.estado, f.motivo, f.intentos]).toEqual(["completado", null, 0]);
    expect((f as { resultado?: unknown }).resultado).toEqual({ ...RESULTADO_CERO, noEncontrados: 1 });
    expect(p.xml.llamadas, "una sola llamada").toHaveLength(1);
    expect(p.xml.mock.registro()).toMatchObject([{ resultado: "error", clase: "datos" }]);
    expect(await contarDocumentos(admin, m.c.id)).toBe(0);
    expect(p.almacen.intentosGuardar).toEqual([]);
    expect(await obtencionesDe(admin, m.c.id)).toMatchObject([
      { ruc_emisor: RUC_PROVEEDOR, tipo: "01", serie: "F001", numero: "1008", estado: "no_encontrado" },
    ]);
  });

  it("centinela 9 (credencial): no se reintenta y no toca la credencial del cliente ni avisa de credencial inválida", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const id9 = await sembrarComprobante(m, "1009");
    const antes = {
      sol: await e.credencialEstado(m.c.id, "sol"),
      sire: await e.credencialEstado(m.c.id, "sire_api"),
    };
    expect(antes.sol, "precondición: el cliente tiene sus credenciales").toBeDefined();
    const notificador = notificadorEspia();
    const p = puertosXml();
    const f = await conWorker(
      p,
      false,
      async () => {
        const j = await encolarXml(backend, redis, prefijo, m, [id9]);
        const f = await esperarTerminal(e, j);
        await new Promise((r) => setTimeout(r, 600));
        return f;
      },
      { notificador },
    );
    expect([f.estado, f.motivo, f.intentos]).toEqual(["completado", null, 0]);
    expect((f as { resultado?: unknown }).resultado).toEqual({ ...RESULTADO_CERO, credencial: 1 });
    expect(p.xml.llamadas, "sin reintento").toHaveLength(1);
    expect(p.xml.mock.registro()).toMatchObject([{ resultado: "error", clase: "credencial" }]);
    expect(await e.credencialEstado(m.c.id, "sol")).toEqual(antes.sol);
    expect(await e.credencialEstado(m.c.id, "sire_api")).toEqual(antes.sire);
    expect(notificador.llamadas, "no hay aviso de credencial inválida").toEqual([]);
    expect(await contarDocumentos(admin, m.c.id)).toBe(0);
    expect(await obtencionesDe(admin, m.c.id)).toMatchObject([{ numero: "1009", estado: "credencial" }]);
  });

  it("centinela 7 (transitorio): 008 reintenta el lote y, agotados los reintentos, queda error/sunat_no_responde sin nada guardado", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const id7 = await sembrarComprobante(m, "1007");
    const p = puertosXml();
    const f = await conWorker(p, false, async () => {
      const j = await encolarXml(backend, redis, prefijo, m, [id7]);
      return esperarTerminal(e, j, 30_000);
    });
    expect([f.estado, f.motivo]).toEqual(["error", "sunat_no_responde"]);
    expect(p.xml.llamadas.length).toBeGreaterThan(1);
    expect(p.xml.llamadas.length).toBeLessThanOrEqual(1 + REINTENTOS);
    expect(await contarDocumentos(admin, m.c.id)).toBe(0);
    expect(p.almacen.intentosGuardar).toEqual([]);
    const [o] = await obtencionesDe(admin, m.c.id);
    expect(o).toMatchObject({ numero: "1007", estado: "transitorio" });
  });

  it("un transitorio que se recupera: el reintento omite lo ya guardado y completa lo que faltaba", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const a = await sembrarComprobante(m, "1040");
    const b = await sembrarComprobante(m, "2056");
    const p = puertosXml();
    p.xml.fallarUnaVez(claveXml("2056"), new ErrorTransitorio());
    const f = await conWorker(p, false, async () => {
      const j = await encolarXml(backend, redis, prefijo, m, [a, b]);
      return esperarTerminal(e, j, 30_000);
    });
    expect([f.estado, f.motivo, f.intentos]).toEqual(["completado", null, 1]);
    // Segundo intento: la primera ya estaba guardada (omitida) y la segunda se guardó.
    expect((f as { resultado?: unknown }).resultado).toEqual({ ...RESULTADO_CERO, guardados: 1, omitidos: 1 });
    const claves = p.xml.claves();
    expect(claves.filter((c) => c === claveXml("1040")), "lo guardado no se vuelve a pedir").toHaveLength(1);
    expect(claves.filter((c) => c === claveXml("2056"))).toHaveLength(2);
    const docs = await documentosDe(admin, m.c.id);
    expect(docs.map((d) => [d.numero, d.n])).toEqual([["1040", 1], ["2056", 1]]);
    expect(p.almacen.intentosGuardar, "una escritura por documento, sin repetir").toHaveLength(2);
  });

  it("en un mismo lote cada comprobante sigue su camino: uno guardado, uno no encontrado y uno de credencial", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const ids = [
      await sembrarComprobante(m, "1040"),
      await sembrarComprobante(m, "1008"),
      await sembrarComprobante(m, "1009"),
    ];
    const p = puertosXml();
    const f = await conWorker(p, false, async () => {
      const j = await encolarXml(backend, redis, prefijo, m, ids);
      return esperarTerminal(e, j);
    });
    expect([f.estado, f.motivo]).toEqual(["completado", null]);
    expect((f as { resultado?: unknown }).resultado).toEqual({
      ...RESULTADO_CERO,
      guardados: 1,
      noEncontrados: 1,
      credencial: 1,
    });
    expect((await documentosDe(admin, m.c.id)).map((d) => d.numero)).toEqual(["1040"]);
    expect((await obtencionesDe(admin, m.c.id)).map((o) => [o.numero, o.estado])).toEqual(
      expect.arrayContaining([["1008", "no_encontrado"], ["1009", "credencial"]]),
    );
  });

  it("nada filtra la causa interna: un error del proveedor con un canario en el mensaje no llega a logs, trabajos, Redis ni tablas", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const id = await sembrarComprobante(m, "1006");
    const c = canarioXml("causa");
    const p = puertosXml();
    p.xml.mock.inyectar(`${RUC_PROVEEDOR}-01-F001-1006`, { error: new Error(`fallo ${c}`) });
    const espia = loggerEspia();
    const f = await conWorker(
      p,
      false,
      async () => {
        const j = await encolarXml(backend, redis, prefijo, m, [id]);
        return esperarTerminal(e, j, 30_000);
      },
      { logger: espia.logger },
    );
    expect(f.estado).toBe("error");
    expect(await buscarEn(m, p, [espia.llamadas])).not.toContain(c);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("CA-6 / P-4: re-evaluación con el XML que llega", () => {
  it("con XML_SIMULADO_EN_REGLAS=1: evaluación nueva con R-MIX exacto 8.97 sin confirmación; la versión no cambia", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const p = puertosXml();
    const r = await conWorker(p, true, async () => {
      await descargar(m);
      return lotes(m, 1);
    });
    expect(r[0]).toMatchObject({ estado: "completado", resultado: { ...RESULTADO_CERO, guardados: 5 } });
    const compras = await porNumero(m);
    const docs = new Map((await documentosDe(admin, m.c.id)).map((d) => [d.numero, d]));
    expect(docs.size).toBe(5);

    // La mixta: la evaluación 1 (la de la descarga, sin XML) pidió confirmar un estimado; la 2 usa el XML.
    const mixta = compras.get("2056")!;
    expect(await evaluacionesDe(admin, mixta.id)).toEqual([
      { version_n: 1, n: 1, documento_xml_id: null },
      { version_n: 1, n: 2, documento_xml_id: docs.get("2056")!.id },
    ]);
    const hs = await hallazgosEvaluadosDe(admin, mixta.id);
    const mix1 = hs.find((h) => h.regla === "R-MIX" && h.evaluacion_n === 1)!;
    const mix2 = hs.find((h) => h.regla === "R-MIX" && h.evaluacion_n === 2)!;
    expect(mix1.requiere_confirmacion).toBe(true);
    expect(mix1.sugerencia).toMatchObject({
      tipo: "separar",
      min: "8.92",
      max: "8.97",
      estimado: "8.94",
      exacto: null,
    });
    expect(mix2.requiere_confirmacion).toBe(false);
    expect(mix2.sugerencia).toMatchObject({ tipo: "separar", estimado: "8.94", exacto: "8.97" });
    expect(hs.every((h) => h.version_n === 1), "todo en la versión 1").toBe(true);

    // Sin versión nueva, ni cambio de puntero, ni de montos.
    expect(mixta.version_vigente).toBe(1);
    const versiones = await versionesDe(admin, mixta.id);
    expect(versiones).toHaveLength(1);
    expect(versiones[0]!.montos).toMatchObject({ biDg: "21.48", igvDg: "1.61", total: "23.09" });

    // San Juan sigue con su R-ISC en la evaluación 2; todas las compras tienen las dos evaluaciones.
    expect(
      (await hallazgosEvaluadosDe(admin, compras.get("1040")!.id)).filter(
        (h) => h.regla === "R-ISC" && h.evaluacion_n === 2,
      ),
    ).toHaveLength(1);
    for (const n of NUMEROS_FIXTURE) {
      const ev = await evaluacionesDe(admin, compras.get(n)!.id);
      expect(ev.map((x) => [x.version_n, x.n]), n).toEqual([[1, 1], [1, 2]]);
      expect(ev[1]!.documento_xml_id, n).toBe(docs.get(n)!.id);
    }
  });

  it("con XML_SIMULADO_EN_REGLAS=0: el XML se guarda y se ve, pero no hay evaluación nueva ni hallazgos nuevos", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const p = puertosXml();
    await conWorker(p, false, async () => {
      await descargar(m);
      await lotes(m, 1);
    });
    expect(await contarDocumentos(admin, m.c.id)).toBe(5);
    const compras = await porNumero(m);
    for (const n of NUMEROS_FIXTURE) {
      const ev = await evaluacionesDe(admin, compras.get(n)!.id);
      expect(ev, n).toEqual([{ version_n: 1, n: 1, documento_xml_id: null }]);
      expect((await hallazgosEvaluadosDe(admin, compras.get(n)!.id)).every((h) => h.evaluacion_n === 1), n).toBe(true);
    }
    // La mixta conserva su estimado sin confirmar.
    const mix = (await hallazgosEvaluadosDe(admin, compras.get("2056")!.id)).find((h) => h.regla === "R-MIX")!;
    expect(mix.requiere_confirmacion).toBe(true);
    expect(mix.sugerencia).toMatchObject({ exacto: null });
  });

  it("D-7: con el periodo ya revisado cuando llega el XML, igual se guarda y se re-evalúa (sin versión nueva)", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const p = puertosXml();
    const api = new SireApiControlado();
    api.responder([
      filaCompra("2056", {
        rucContraparte: EMISORES["2056"]!,
        fechaEmision: "2026-10-05",
        biDg: "21.48",
        igvDg: "1.61",
        total: "23.09",
      }),
    ] as never);
    p.xml.pausar(); // el XML llega después de que el contador marque el periodo
    await conWorker(
      p,
      true,
      async () => {
        await descargar(m);
        await esperarHasta(() => p.xml.llamadas.length > 0, "el proveedor recibe el pedido");
        await admin.pool.query(
          "update compra_periodo set estado = 'revisado', marcado_por = $3, marcado_en = now() where cliente_id = $1 and periodo = $2",
          [m.c.id, PERIODO, m.u],
        );
        p.xml.abrir();
        await lotes(m, 1);
      },
      { sireApi: api },
    );
    const estado = await admin.pool.query(
      "select estado from compra_periodo where cliente_id = $1 and periodo = $2",
      [m.c.id, PERIODO],
    );
    expect(estado.rows[0].estado, "el periodo sigue revisado").toBe("revisado");
    const mixta = (await porNumero(m)).get("2056")!;
    const [doc] = await documentosDe(admin, m.c.id);
    expect(await evaluacionesDe(admin, mixta.id)).toEqual([
      { version_n: 1, n: 1, documento_xml_id: null },
      { version_n: 1, n: 2, documento_xml_id: doc!.id },
    ]);
    expect(mixta.version_vigente).toBe(1);
    expect(await versionesDe(admin, mixta.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("CA-6 / CA-10 / D-11: XML hostil, inválido o ajeno no deja nada", () => {
  /** El XML de la mixta (F001-2056) con un canario en una glosa. */
  const mixtaCon = (c: string) =>
    reemplazar(fixtureXml("2056"), "Producto gravado de prueba (PRUEBA)", c);
  const cabecera = '<?xml version="1.0" encoding="UTF-8"?>';

  const CASOS: Array<[string, (c: string) => string]> = [
    [
      "XXE a un archivo local",
      (c) =>
        reemplazar(
          mixtaCon(`&xxe; ${c}`),
          cabecera,
          `${cabecera}\n<!DOCTYPE Invoice [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>`,
        ),
    ],
    [
      "expansión de entidades (billion laughs)",
      (c) =>
        reemplazar(
          mixtaCon(`&lol3; ${c}`),
          cabecera,
          `${cabecera}\n<!DOCTYPE Invoice [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;">]>`,
        ),
    ],
    [
      "entidad externa por HTTP",
      (c) =>
        reemplazar(
          mixtaCon(`&ext; ${c}`),
          cabecera,
          `${cabecera}\n<!DOCTYPE Invoice [<!ENTITY ext SYSTEM "http://127.0.0.1:9/${c}">]>`,
        ),
    ],
    [
      "DOCTYPE escondido en un comentario",
      (c) => reemplazar(mixtaCon(c), cabecera, `${cabecera}\n<!-- <!DOCTYPE Invoice> -->`),
    ],
    ["texto que no es XML", (c) => `esto no es un comprobante ${c}`],
    ["HTML en lugar de UBL", (c) => `<html><body><script>${c}</script></body></html>`],
    ["cadena vacía", () => ""],
    ["byte NUL", (c) => reemplazar(mixtaCon(c), "</cbc:Description>", "\u0000</cbc:Description>")],
    ["más de 1 MiB", (c) => reemplazar(mixtaCon(c), cabecera, `${cabecera}\n<!-- ${"A".repeat(1_048_576)} -->`)],
    [
      "ajeno: otro RUC de emisor",
      (c) => reemplazar(mixtaCon(c), 'schemeID="6">20700000045<', 'schemeID="6">20700000046<'),
    ],
    [
      "ajeno: otra serie",
      (c) => reemplazar(mixtaCon(c), "<cbc:ID>F001-2056</cbc:ID>", "<cbc:ID>F002-2056</cbc:ID>"),
    ],
    [
      "ajeno: otro número",
      (c) => reemplazar(mixtaCon(c), "<cbc:ID>F001-2056</cbc:ID>", "<cbc:ID>F001-2057</cbc:ID>"),
    ],
    [
      "ajeno: otro tipo de comprobante",
      (c) => reemplazar(mixtaCon(c), '<cbc:InvoiceTypeCode listID="0101">01<', '<cbc:InvoiceTypeCode listID="0101">03<'),
    ],
    [
      "ajeno: otro receptor (no es el RUC del cliente)",
      (c) => reemplazar(mixtaCon(c), 'schemeID="6">20700000002<', 'schemeID="6">20700000099<'),
    ],
    [
      "ajeno: el XML de otro comprobante",
      (c) => reemplazar(fixtureXml("3064"), "<cbc:Description>", `<cbc:Description>${c} `),
    ],
  ];

  it.each(CASOS)(
    "%s: no se guarda nada en storage ni en BD, no re-evalúa y el resultado solo trae conteos",
    async (_nombre, armar) => {
      const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
      const c = canarioXml("hostil");
      const xml = armar(c);
      expect(xml.length === 0 || xml.includes(c), "precondición: el XML trae el canario").toBe(true);
      const p = puertosXml();
      p.xml.mock.inyectar(claveXml("2056"), { xml });
      const espia = loggerEspia();
      const lote = await conWorker(
        p,
        true,
        async () => {
          await descargar(m);
          return (await lotes(m, 1))[0]!;
        },
        { logger: espia.logger },
      );

      // Las otras cuatro (fixtures) sí se guardaron: es el control positivo de que la prueba no pasa vacía.
      expect(lote).toMatchObject({ estado: "completado", motivo: null });
      expect(lote.resultado).toEqual({ ...RESULTADO_CERO, guardados: 4, invalidos: 1 });
      expect(bytes(lote.resultado)).toBeLessThanOrEqual(4096);
      const docs = await documentosDe(admin, m.c.id);
      expect(docs.map((d) => d.numero).sort()).toEqual(["1040", "3064", "4062", "5070"]);
      expect(p.almacen.intentosGuardar, "ni un intento de escribir el rechazado").toHaveLength(4);
      expect(p.almacen.rutas()).toHaveLength(4);

      // El rechazado queda como no disponible y sin evaluación nueva; los demás sí se re-evaluaron.
      const compras = await porNumero(m);
      expect(await evaluacionesDe(admin, compras.get("2056")!.id)).toEqual([
        { version_n: 1, n: 1, documento_xml_id: null },
      ]);
      expect((await hallazgosEvaluadosDe(admin, compras.get("2056")!.id)).every((h) => h.evaluacion_n === 1)).toBe(true);
      expect((await evaluacionesDe(admin, compras.get("1040")!.id)).map((x) => x.n)).toEqual([1, 2]);
      expect((await obtencionesDe(admin, m.c.id)).find((o) => o.numero === "2056")).toMatchObject({
        estado: "no_encontrado",
      });

      // Ningún rastro del contenido hostil en ningún lado.
      expect(await buscarEn(m, p, [espia.llamadas])).not.toContain(c);
    },
  );

  it("el XML que el proveedor devuelve en ISO-8859-1 se guarda en esos mismos bytes (no se reencoda a UTF-8)", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const id = await sembrarComprobante(m, "2056");
    const texto = reemplazar(
      reemplazar(fixtureXml("2056"), 'encoding="UTF-8"', 'encoding="ISO-8859-1"'),
      "Producto gravado de prueba (PRUEBA)",
      "Ñandú de prueba (PRUEBA)",
    );
    const esperado = Buffer.from(texto, "latin1");
    const p = puertosXml();
    p.xml.mock.inyectar(claveXml("2056"), { xml: texto });
    const f = await conWorker(p, false, async () => {
      const j = await encolarXml(backend, redis, prefijo, m, [id]);
      return esperarTerminal(e, j);
    });
    expect((f as { resultado?: unknown }).resultado).toEqual({ ...RESULTADO_CERO, guardados: 1 });
    const [d] = await documentosDe(admin, m.c.id);
    const guardado = Buffer.from(await p.almacen.leer(d!.ruta));
    expect(Buffer.compare(guardado, esperado)).toBe(0);
    expect(guardado.includes(0xd1), "la Ñ es un solo byte").toBe(true);
    expect(guardado.includes(Buffer.from([0xc3, 0x91])), "no es UTF-8").toBe(false);
    expect(d!.sha).toBe(sha256Hex(esperado));
    expect(d!.tamano).toBe(esperado.length);
    expect(d!.detalle, "la glosa se leyó bien en el detalle").toContain("Ñandú");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("aislamiento y procesos (008 D6)", () => {
  it("un lote solo toca las compras de su estudio, cliente y periodo: las demás ni se piden al proveedor", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const ajeno = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const otroCliente = await e.cliente(m.T, rucNuevo());
    await e.asignar(m.T, otroCliente.id, m.u);

    const propia = await sembrarComprobante(m, "1040");
    const deOtroEstudio = await sembrarComprobante(ajeno, "2056");
    const deOtroCliente = await sembrarComprobante({ ...m, c: otroCliente }, "3064");
    const deOtroPeriodo = await sembrarComprobante(m, "5070", { periodo: "202609" });

    const p = puertosXml();
    const f = await conWorker(p, false, async () => {
      const j = await encolarXml(backend, redis, prefijo, m, [propia, deOtroEstudio, deOtroCliente, deOtroPeriodo]);
      return esperarTerminal(e, j);
    });
    expect([f.estado, f.motivo]).toEqual(["completado", null]);
    expect((f as { resultado?: Record<string, number> }).resultado).toMatchObject({ guardados: 1, transitorios: 0, credencial: 0 });
    expect(p.xml.claves(), "solo se pidió la propia").toEqual([claveXml("1040")]);
    expect((await documentosDe(admin, m.c.id)).map((d) => d.numero)).toEqual(["1040"]);
    expect(await contarDocumentos(admin, ajeno.c.id)).toBe(0);
    expect(await contarDocumentos(admin, otroCliente.id)).toBe(0);
    expect(p.almacen.rutas()).toHaveLength(1);
  });

  it("el proveedor se llama sin ninguna transacción abierta (008 D6)", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const id = await sembrarComprobante(m, "1040");
    const p = puertosXml();
    p.xml.pausar();
    await conWorker(p, false, async (w: ProcesoWorker) => {
      const j = await encolarXml(backend, redis, prefijo, m, [id]);
      await esperarHasta(() => p.xml.llamadas.length > 0, "el proveedor recibe el pedido");
      expect(
        await minimoTx(w.dbEstado, 400),
        "una transacción abierta dejaría el mínimo en ≥ 1",
      ).toBe(0);
      p.xml.abrir();
      expect((await esperarTerminal(e, j)).estado).toBe("completado");
    });
  });
});
