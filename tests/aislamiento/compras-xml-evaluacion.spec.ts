// Spec 016 (T5, rojo): `guardarDocumentoXml` (P-6, n correlativo, identidad normalizada), `leerXmlVigente`, `fijarObtencion`,
// `listarPorObtener` y la EVALUACION NUMERADA (D-5, P-2): re-evaluar la misma version inserta `n + 1` sin choque, los hallazgos
// vigentes son los de la ultima evaluacion de la version vigente y toda version nueva nace con la evaluacion 1 y el XML vigente.
// Cubre CA-6 (parte de BD), CA-7 (idem), CA-8 (parte secuencial) y CA-10 (idempotencia en BD). Hasta T11 fallan porque las tablas
// y las funciones no existen. Contrato: encabezado de `compras-xml-soporte.ts`. `evaluar` y `transformar` son funciones de prueba:
// ninguna prueba de `packages/db` importa el dominio.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin } from "./auth-soporte";
import type { ContappDb, Tx } from "./soporte";
import { crearDb, type ClientePrueba } from "./trabajos-soporte";
import {
  claveCompra,
  contarFilas,
  MONTOS_DG,
  montos,
  PERIODO,
  transformarFalso,
  type DatosVersion,
} from "./compras-soporte";
import {
  aplicarAccion,
  aplicarMasiva,
  CANARIO_XML,
  codigoError,
  crearVersion,
  detalleXml,
  entradaXml,
  EscenarioXml,
  evaluacionesDe,
  evaluadorXml,
  fijarObtencion,
  guardarDocumentoXml,
  hallazgosPorEvaluacion,
  insertarCompras,
  leerDetalleCompra,
  leerHallazgosVigentes,
  leerXmlVigente,
  listarCompras,
  listarPorObtener,
  punteroDe,
  reevaluarCompra,
  versionesN,
  xmlsDe,
  type EvaluarConXml,
  type IdentidadXml,
} from "./compras-xml-soporte";

let admin: Pool;
let ec: EscenarioXml;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let Y: string;
let cy: ClientePrueba;
let ux: string;

beforeAll(async () => {
  admin = abrirAdmin(8);
  ec = new EscenarioXml(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  cy = await ec.cliente(Y);
  ux = await ec.usuarioDe(X);
  backend = crearDb("contapp_backend", 6);
  worker = crearDb("contapp_worker", 4);
});
afterAll(async () => {
  await ec?.limpiar();
  await Promise.all(
    [backend?.close(), worker?.close()].map((p) => p?.catch(() => undefined)),
  );
  await admin?.end();
});

const comoBackend = <T>(fn: (tx: Tx) => Promise<T>, tenantId = X) =>
  backend.withTenant({ tenantId }, fn);
const comoWorker = <T>(fn: (tx: Tx) => Promise<T>, tenantId = X) =>
  worker.withTenant({ tenantId }, fn);

let consecutivo = 100;
/** Un comprobante nuevo (numero unico por archivo) con su identidad de XML. */
const comprobante = (serie = "F001") => {
  const numero = String(++consecutivo);
  return {
    serie,
    numero,
    id: { rucEmisor: "20100070970", tipo: "01", serie, numero } as IdentidadXml,
  };
};
/** Un cliente propio para que cada prueba tenga su periodo limpio. */
const clienteNuevo = () => ec.cliente(X);
const compraDe = async (c: ClientePrueba, serie = "F001") => {
  const k = comprobante(serie);
  const s = await ec.compraXml(X, c, { serie: k.serie, numero: k.numero });
  // `id` es el uuid de la compra; la identidad del XML va aparte en `idXml` (k.id la pisaba).
  return { ...s, serie: k.serie, numero: k.numero, id: s.id, idXml: k.id };
};
const datos = (m: Partial<DatosVersion["montos"]>): DatosVersion => ({
  montos: montos({ ...MONTOS_DG, ...m }),
  excluida: false,
  motivo: null,
  clasificada: false,
});

// =================================================================================================
describe("guardarDocumentoXml · P-6, n correlativo e identidad normalizada (D-4)", () => {
  it("sin XML: guardar un subido inserta n = 1 con el autor", async () => {
    const c = await clienteNuevo();
    const k = comprobante();
    const r = await comoBackend((tx) =>
      guardarDocumentoXml(
        tx,
        entradaXml(X, c.id, k.id, { origen: "subido", subidoPor: ux }),
      ),
    );
    expect(r).toMatchObject({ n: 1 });
    expect(typeof (r as { id: string }).id).toBe("string");
    const f = (
      await admin.query(
        "select n, origen, subido_por, cliente_id from documento_xml where id = $1",
        [(r as { id: string }).id],
      )
    ).rows[0];
    expect(f).toEqual({
      n: 1,
      origen: "subido",
      subido_por: ux,
      cliente_id: c.id,
    });
  });

  it("P-6: con un XML simulado vigente, subir uno propio inserta n + 1 y conserva el anterior; el vigente es el ultimo", async () => {
    const c = await clienteNuevo();
    const k = comprobante();
    const simulado = await ec.xml(X, c, k.id, { origen: "simulado" });
    const r = await comoBackend((tx) =>
      guardarDocumentoXml(
        tx,
        entradaXml(X, c.id, k.id, { origen: "subido", subidoPor: ux }),
      ),
    );
    expect(r).toMatchObject({ n: 2 });
    expect(await xmlsDe(admin, c.id, k.id)).toEqual([
      { id: simulado, n: 1, origen: "simulado" },
      { id: (r as { id: string }).id, n: 2, origen: "subido" },
    ]);
    const vigente = await comoBackend((tx) => leerXmlVigente(tx, c.id, k.id));
    expect(vigente).toMatchObject({
      id: (r as { id: string }).id,
      n: 2,
      origen: "subido",
      subidoPor: ux,
    });
  });

  it("n sigue al mayor existente: con n = 1 y n = 2 simulados, el siguiente es 3", async () => {
    const c = await clienteNuevo();
    const k = comprobante();
    await ec.xml(X, c, k.id, { origen: "simulado", n: 1 });
    await ec.xml(X, c, k.id, { origen: "simulado", n: 2 });
    const r = await comoBackend((tx) =>
      guardarDocumentoXml(
        tx,
        entradaXml(X, c.id, k.id, { origen: "subido", subidoPor: ux }),
      ),
    );
    expect(r).toMatchObject({ n: 3 });
  });

  it("P-6: con un XML real vigente, subir otro devuelve existente_no_simulado y no inserta nada", async () => {
    const c = await clienteNuevo();
    const k = comprobante();
    await ec.xml(X, c, k.id, { origen: "real" });
    const r = await comoBackend((tx) =>
      guardarDocumentoXml(
        tx,
        entradaXml(X, c.id, k.id, { origen: "subido", subidoPor: ux }),
      ),
    );
    expect(r).toBe("existente_no_simulado");
    expect((await xmlsDe(admin, c.id, k.id)).map((x) => x.origen)).toEqual([
      "real",
    ]);
  });

  it("P-6: con un XML subido vigente, subir otro devuelve existente_no_simulado (aunque haya un simulado antes)", async () => {
    const c = await clienteNuevo();
    const k = comprobante();
    await ec.xml(X, c, k.id, { origen: "simulado" });
    await ec.xml(X, c, k.id, { origen: "subido", subidoPor: ux });
    const r = await comoBackend((tx) =>
      guardarDocumentoXml(
        tx,
        entradaXml(X, c.id, k.id, { origen: "subido", subidoPor: ux }),
      ),
    );
    expect(r).toBe("existente_no_simulado");
    expect((await xmlsDe(admin, c.id, k.id)).map((x) => x.n)).toEqual([1, 2]);
  });

  it("el worker guarda el XML real de un comprobante sin XML (n = 1)", async () => {
    const c = await clienteNuevo();
    const k = comprobante();
    const r = await comoWorker((tx) =>
      guardarDocumentoXml(tx, entradaXml(X, c.id, k.id, { origen: "real" })),
    );
    expect(r).toMatchObject({ n: 1 });
  });

  it("la identidad se normaliza como la clave de 014: serie en mayusculas y numero sin ceros", async () => {
    const c = await clienteNuevo();
    const k = comprobante("F777");
    const r = await comoBackend((tx) =>
      guardarDocumentoXml(
        tx,
        entradaXml(
          X,
          c.id,
          { ...k.id, serie: "f777", numero: `000${k.numero}` },
          { origen: "real" },
        ),
      ),
    );
    expect(r).toMatchObject({ n: 1 });
    const f = (
      await admin.query(
        "select serie, numero from documento_xml where cliente_id = $1",
        [c.id],
      )
    ).rows;
    expect(f).toEqual([{ serie: "F777", numero: k.numero }]);
    for (const variante of [
      { ...k.id },
      { ...k.id, serie: "f777", numero: `00${k.numero}` },
    ])
      expect(
        await comoBackend((tx) => leerXmlVigente(tx, c.id, variante)),
        JSON.stringify(variante),
      ).toMatchObject({ n: 1, origen: "real" });
  });

  it("un comprobante con otra forma del numero (000123 y 123) es el mismo: la segunda subida ve la primera (P-6)", async () => {
    const c = await clienteNuevo();
    const k = comprobante("F778");
    await comoBackend((tx) =>
      guardarDocumentoXml(
        tx,
        entradaXml(
          X,
          c.id,
          { ...k.id, numero: `000${k.numero}` },
          { origen: "real" },
        ),
      ),
    );
    const r = await comoBackend((tx) =>
      guardarDocumentoXml(
        tx,
        entradaXml(X, c.id, k.id, { origen: "subido", subidoPor: ux }),
      ),
    );
    expect(r).toBe("existente_no_simulado");
  });

  it("no se guarda para un cliente de otro estudio: falla y no queda nada", async () => {
    const k = comprobante();
    const codigo = await codigoError(
      comoBackend((tx) =>
        guardarDocumentoXml(tx, entradaXml(X, cy.id, k.id, { origen: "real" })),
      ),
    );
    expect(codigo).not.toBe("ok");
    expect(await xmlsDe(admin, cy.id, k.id)).toEqual([]);
  });
});

describe("leerXmlVigente · el de mayor n, de ese cliente y comprobante (D-4)", () => {
  it("devuelve id, n, origen, detalle, ruta, tamano, autor y fecha del vigente", async () => {
    const c = await clienteNuevo();
    const k = comprobante();
    await ec.xml(X, c, k.id, {
      origen: "simulado",
      detalle: detalleXml("viejo"),
    });
    const id2 = await ec.xml(X, c, k.id, {
      origen: "subido",
      subidoPor: ux,
      detalle: detalleXml(),
      tamano: 4321,
    });
    const v = await comoBackend((tx) => leerXmlVigente(tx, c.id, k.id));
    expect(v).toMatchObject({
      id: id2,
      n: 2,
      origen: "subido",
      subidoPor: ux,
      tamano: 4321,
      detalle: detalleXml(),
    });
    expect(v?.ruta).toMatch(
      /^xml\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.xml$/,
    );
    expect(v?.creadaEn).toBeInstanceOf(Date);
  });

  it("null sin XML, para otro comprobante, otro cliente del estudio y desde otro estudio", async () => {
    const c = await clienteNuevo();
    const otro = await clienteNuevo();
    const k = comprobante();
    await ec.xml(X, c, k.id);
    expect(
      await comoBackend((tx) =>
        leerXmlVigente(tx, c.id, { ...k.id, numero: `${k.numero}9` }),
      ),
    ).toBeNull();
    expect(
      await comoBackend((tx) => leerXmlVigente(tx, otro.id, k.id)),
    ).toBeNull();
    expect(
      await comoBackend((tx) =>
        leerXmlVigente(tx, c.id, { ...k.id, rucEmisor: "20555555555" }),
      ),
    ).toBeNull();
    expect(
      await comoBackend((tx) => leerXmlVigente(tx, c.id, k.id), Y),
    ).toBeNull();
    expect(
      await comoBackend((tx) => leerXmlVigente(tx, c.id, k.id)),
    ).not.toBeNull();
  });
});

describe("fijarObtencion y listarPorObtener (D-4, D-10)", () => {
  it("fijarObtencion deja UNA fila por comprobante y la actualiza (backend y worker)", async () => {
    const c = await clienteNuevo();
    const k = comprobante();
    await comoWorker((tx) => fijarObtencion(tx, c.id, k.id, "pendiente"));
    await comoWorker((tx) => fijarObtencion(tx, c.id, k.id, "transitorio"));
    await comoBackend((tx) => fijarObtencion(tx, c.id, k.id, "no_encontrado"));
    const f = (
      await admin.query(
        "select estado from documento_xml_obtencion where cliente_id = $1",
        [c.id],
      )
    ).rows;
    expect(f).toEqual([{ estado: "no_encontrado" }]);
  });

  it("fijarObtencion rechaza un estado fuera del catalogo", async () => {
    const c = await clienteNuevo();
    const k = comprobante();
    const codigo = await codigoError(
      comoWorker((tx) => fijarObtencion(tx, c.id, k.id, "listo" as never)),
    );
    expect(codigo).not.toBe("ok");
    expect(
      await contarFilas(admin, "documento_xml_obtencion", "cliente_id = $1", [
        c.id,
      ]),
    ).toBe(0);
  });

  it("listarPorObtener: conHallazgos sale de la ultima evaluacion y tieneXml de cualquier origen; solo el cliente y periodo pedidos", async () => {
    const c = await clienteNuevo();
    const a = await compraDe(c); // hallazgo vigente, sin XML
    const b = await compraDe(c); // con XML, sin hallazgos
    const d = await compraDe(c); // hallazgo en la evaluacion 1, ninguno en la 2 (vigente)
    await ec.hallazgo(X, a.id, 1, "R-ISC", 1);
    await ec.xml(X, c, b.idXml, { origen: "simulado" });
    await ec.hallazgo(X, d.id, 1, "R-MIX", 1);
    await ec.evaluacion(X, d.id, 1, 2);
    const ajena = await compraDe(await clienteNuevo());
    await ec.hallazgo(X, ajena.id, 1, "R-ISC", 1);
    const lista = await comoBackend((tx) =>
      listarPorObtener(tx, c.id, PERIODO),
    );
    const por = new Map(lista.map((f) => [f.compraId, f]));
    expect([...por.keys()].sort()).toEqual([a.id, b.id, d.id].sort());
    expect(por.get(a.id)).toMatchObject({
      conHallazgos: true,
      tieneXml: false,
    });
    expect(por.get(b.id)).toMatchObject({
      conHallazgos: false,
      tieneXml: true,
    });
    expect(por.get(d.id)).toMatchObject({
      conHallazgos: false,
      tieneXml: false,
    });
    expect(
      await comoBackend((tx) => listarPorObtener(tx, c.id, "202501")),
    ).toEqual([]);
  });
});

// =================================================================================================
describe("evaluacion numerada · versiones nuevas (D-5, P-2)", () => {
  it("insertarCompras: cada compra nace con la evaluacion 1 de su version 1; si ya hay XML del comprobante, la evaluacion lo lleva y evaluar lo recibe", async () => {
    const c = await clienteNuevo();
    const propuestaId = await ec.propuesta(X, c, {
      libro: "compras",
      nuevas: 2,
    });
    const con = comprobante();
    const sin = comprobante();
    const xmlId = await ec.xml(X, c, con.id, { origen: "real" }); // sobrevive a descartar y volver a agregar (D-4)
    const nueva = (k: ReturnType<typeof comprobante>) => ({
      clave: claveCompra("01", k.serie, k.numero, "6", "20100070970"),
      tipoDoc: "01",
      serie: k.serie,
      numero: k.numero,
      docTipo: "6",
      docNumero: "20100070970",
      razonSocial: "PROVEEDOR SINTETICO SAC",
      fecha: "2026-10-05",
      moneda: "PEN" as const,
      tipoCambio: null,
      montos: montos(MONTOS_DG),
    });
    const { evaluar, llamadas } = evaluadorXml();
    const ids = await comoWorker((tx) =>
      insertarCompras(
        tx,
        { clienteId: c.id, periodo: PERIODO, propuestaId },
        [nueva(con), nueva(sin)],
        { evaluar },
      ),
    );
    expect(await evaluacionesDe(admin, ids[0]!)).toEqual([
      { version_n: 1, n: 1, documento_xml_id: xmlId },
    ]);
    expect(await evaluacionesDe(admin, ids[1]!)).toEqual([
      { version_n: 1, n: 1, documento_xml_id: null },
    ]);
    expect(llamadas.map((l) => l.xml?.origen ?? null)).toEqual(["real", null]);
    expect(llamadas[0]!.xml?.detalle).toEqual(detalleXml());
    expect(
      (await hallazgosPorEvaluacion(admin, ids[0]!)).map((h) => [
        h.evaluacion_n,
        h.lecturas.xml,
      ]),
    ).toEqual([[1, "real"]]);
    expect(
      (await hallazgosPorEvaluacion(admin, ids[1]!)).map((h) => [
        h.evaluacion_n,
        h.lecturas.xml,
      ]),
    ).toEqual([[1, "sin"]]);
  });

  it("crearVersion: la version nueva nace con la evaluacion 1 y el XML vigente leido dentro de la transaccion", async () => {
    const c = await clienteNuevo();
    const k = await compraDe(c);
    const xmlId = await ec.xml(X, c, k.idXml, {
      origen: "subido",
      subidoPor: ux,
    });
    const { evaluar, llamadas } = evaluadorXml();
    const v = await comoBackend((tx) =>
      crearVersion(
        tx,
        {
          compraId: k.id,
          versionBase: 1,
          datos: datos({ biDg: "900.00", igvDg: "162.00", total: undefined }),
          accion: "editar",
          usuarioId: ux,
        },
        { evaluar },
      ),
    );
    expect(v.n).toBe(2);
    expect(llamadas).toEqual([
      { version: 2, xml: { origen: "subido", detalle: detalleXml() } },
    ]);
    expect(await evaluacionesDe(admin, k.id)).toEqual([
      { version_n: 1, n: 1, documento_xml_id: null },
      { version_n: 2, n: 1, documento_xml_id: xmlId },
    ]);
    expect(
      (await hallazgosPorEvaluacion(admin, k.id)).map((h) => [
        h.version_n,
        h.evaluacion_n,
      ]),
    ).toEqual([[2, 1]]);
  });

  it("crearVersion sin XML: evaluar recibe xml nulo y la evaluacion no apunta a ningun documento", async () => {
    const c = await clienteNuevo();
    const k = await compraDe(c);
    const { evaluar, llamadas } = evaluadorXml();
    await comoBackend((tx) =>
      crearVersion(
        tx,
        {
          compraId: k.id,
          versionBase: 1,
          datos: datos({}),
          accion: "editar",
          usuarioId: ux,
        },
        { evaluar },
      ),
    );
    expect(llamadas.map((l) => l.xml)).toEqual([null]);
    expect(
      (await evaluacionesDe(admin, k.id)).map((e) => e.documento_xml_id),
    ).toEqual([null, null]);
  });

  it("aplicarAccion y aplicarMasiva evaluan cada version nueva con su XML (unico punto de escritura)", async () => {
    const c = await clienteNuevo();
    const a = await compraDe(c);
    const b = await compraDe(c);
    const d = await compraDe(c);
    const xa = await ec.xml(X, c, a.idXml, { origen: "real" });
    const xb = await ec.xml(X, c, b.idXml, { origen: "simulado" });
    const accion = evaluadorXml();
    await comoBackend((tx) =>
      aplicarAccion(
        tx,
        {
          compraId: a.id,
          versionBase: 1,
          accion: "clasificar",
          parametros: { tipo: "dng" },
          usuarioId: ux,
        },
        { transformar: transformarFalso, evaluar: accion.evaluar },
      ),
    );
    expect(accion.llamadas.map((l) => [l.version, l.xml?.origen])).toEqual([
      [2, "real"],
    ]);
    expect(await evaluacionesDe(admin, a.id)).toEqual([
      { version_n: 1, n: 1, documento_xml_id: null },
      { version_n: 2, n: 1, documento_xml_id: xa },
    ]);
    const masiva = evaluadorXml();
    const r = await comoBackend((tx) =>
      aplicarMasiva(
        tx,
        {
          clienteId: c.id,
          periodo: PERIODO,
          usuarioId: ux,
          accion: "clasificar",
          parametros: { tipo: "dng" },
          items: [
            { compraId: b.id, versionBase: 1 },
            { compraId: d.id, versionBase: 1 },
          ],
        },
        { transformar: transformarFalso, evaluar: masiva.evaluar },
      ),
    );
    expect(r.aplicadas).toBe(2);
    expect(await evaluacionesDe(admin, b.id)).toEqual([
      { version_n: 1, n: 1, documento_xml_id: null },
      { version_n: 2, n: 1, documento_xml_id: xb },
    ]);
    expect(await evaluacionesDe(admin, d.id)).toEqual([
      { version_n: 1, n: 1, documento_xml_id: null },
      { version_n: 2, n: 1, documento_xml_id: null },
    ]);
  });
});

// =================================================================================================
describe("evaluacion numerada · re-evaluar la misma version (D-5, CA-6, CA-7, CA-8)", () => {
  it("la llegada del XML inserta la evaluacion n = 2 sin choque, sin version nueva y sin mover el puntero", async () => {
    const c = await clienteNuevo();
    const k = await compraDe(c);
    await ec.hallazgo(X, k.id, 1, "R-XML", 1, { xml: "sin", version: "1" });
    const xmlId = await ec.xml(X, c, k.idXml, { origen: "real" });
    const { evaluar, llamadas } = evaluadorXml();
    await comoWorker((tx) => reevaluarCompra(tx, k.id, { evaluar }));
    expect(llamadas).toEqual([
      { version: 1, xml: { origen: "real", detalle: detalleXml() } },
    ]);
    expect(await evaluacionesDe(admin, k.id)).toEqual([
      { version_n: 1, n: 1, documento_xml_id: null },
      { version_n: 1, n: 2, documento_xml_id: xmlId },
    ]);
    expect(
      (await hallazgosPorEvaluacion(admin, k.id)).map((h) => [
        h.evaluacion_n,
        h.regla,
        h.lecturas.xml,
      ]),
    ).toEqual([
      [1, "R-XML", "sin"],
      [2, "R-XML", "real"],
    ]);
    expect(await versionesN(admin, k.id)).toEqual([1]);
    expect(await punteroDe(admin, k.id)).toBe(1);
  });

  it("re-evaluar varias veces numera 2, 3, 4 y nunca choca; cada una apunta al XML vigente de ese momento", async () => {
    const c = await clienteNuevo();
    const k = await compraDe(c);
    const x1 = await ec.xml(X, c, k.idXml, { origen: "simulado" });
    await comoBackend((tx) =>
      reevaluarCompra(tx, k.id, { evaluar: evaluadorXml().evaluar }),
    );
    await comoBackend((tx) =>
      reevaluarCompra(tx, k.id, { evaluar: evaluadorXml().evaluar }),
    );
    const x2 = await ec.xml(X, c, k.idXml, { origen: "subido", subidoPor: ux });
    const ultima = evaluadorXml();
    await comoBackend((tx) =>
      reevaluarCompra(tx, k.id, { evaluar: ultima.evaluar }),
    );
    expect(await evaluacionesDe(admin, k.id)).toEqual([
      { version_n: 1, n: 1, documento_xml_id: null },
      { version_n: 1, n: 2, documento_xml_id: x1 },
      { version_n: 1, n: 3, documento_xml_id: x1 },
      { version_n: 1, n: 4, documento_xml_id: x2 },
    ]);
    expect(ultima.llamadas[0]!.xml?.origen, "el vigente es el de mayor n").toBe(
      "subido",
    );
  });

  it.each([
    {
      caso: "mixta F001-2056 (CA-6): R-MIX pasa de estimado 8.94 a exacto 8.97 / 12.51 sin confirmacion",
      regla: "R-MIX",
      sin: {
        lecturas: { igvEstimado: "8.94", rango: "8.92-8.97" },
        requiere: true,
      },
      con: { lecturas: { igv: "8.97", base: "12.51" }, requiere: false },
    },
    {
      caso: "San Juan F001-1040 (CA-7): R-ISC sin XML no sugiere; con XML mueve 770.00 de DG a ISC",
      regla: "R-ISC",
      sin: { lecturas: { motivo: "sin_respaldo" }, requiere: true },
      con: { lecturas: { isc: "770.00", origen: "xml" }, requiere: false },
    },
  ])("$caso", async ({ regla, sin, con }) => {
    const c = await clienteNuevo();
    const k = await compraDe(c);
    const evaluar = evaluadorXml((f) => [
      {
        regla,
        sugerencia: { destino: "DNG" },
        lecturas: f.xml ? con.lecturas : sin.lecturas,
        requiereConfirmacion: f.xml ? con.requiere : sin.requiere,
      },
    ]);
    // Evaluacion 1 (sin XML), como la deja la descarga.
    await ec.hallazgo(X, k.id, 1, regla, 1, sin.lecturas);
    await ec.xml(X, c, k.idXml, { origen: "real" });
    await comoWorker((tx) =>
      reevaluarCompra(tx, k.id, { evaluar: evaluar.evaluar }),
    );
    const vigentes = await comoBackend((tx) =>
      leerHallazgosVigentes(tx, [k.id]),
    );
    expect(vigentes.get(k.id)).toEqual([
      {
        compraId: k.id,
        regla,
        sugerencia: { destino: "DNG" },
        lecturas: con.lecturas,
        requiereConfirmacion: con.requiere,
      },
    ]);
    expect(
      await punteroDe(admin, k.id),
      "la version de la fila no cambia",
    ).toBe(1);
    // La masiva/aceptacion de 014 todavia la acepta: versionBase sigue siendo 1.
    const r = await comoBackend((tx) =>
      aplicarAccion(
        tx,
        {
          compraId: k.id,
          versionBase: 1,
          accion: "clasificar",
          parametros: { tipo: "dng" },
          usuarioId: ux,
        },
        { transformar: transformarFalso, evaluar: evaluadorXml().evaluar },
      ),
    );
    expect((r as { version: { n: number } }).version.n).toBe(2);
  });

  it("los hallazgos vigentes son los de la ULTIMA evaluacion: una re-evaluacion vacia deja la fila sin hallazgos (listado, detalle y leerHallazgosVigentes)", async () => {
    const c = await clienteNuevo();
    const k = await compraDe(c);
    await ec.hallazgo(X, k.id, 1, "R-XML", 1);
    const antes = await comoBackend((tx) =>
      listarCompras(tx, c.id, PERIODO, { limite: 50, alertas: true }),
    );
    expect(antes.filas.map((f) => f.compra.id)).toEqual([k.id]);
    await ec.xml(X, c, k.idXml, { origen: "real" });
    await comoBackend((tx) =>
      reevaluarCompra(tx, k.id, { evaluar: evaluadorXml(() => []).evaluar }),
    );
    const despues = await comoBackend((tx) =>
      listarCompras(tx, c.id, PERIODO, { limite: 50, alertas: true }),
    );
    expect(despues.filas, "con_hallazgos mira la ultima evaluacion").toEqual(
      [],
    );
    const todas = await comoBackend((tx) =>
      listarCompras(tx, c.id, PERIODO, { limite: 50 }),
    );
    expect(todas.filas.map((f) => [f.compra.id, f.hallazgos])).toEqual([
      [k.id, []],
    ]);
    expect(
      (await comoBackend((tx) => leerHallazgosVigentes(tx, [k.id]))).get(
        k.id,
      ) ?? [],
    ).toEqual([]);
    expect(
      (await comoBackend((tx) => leerDetalleCompra(tx, c.id, PERIODO, k.id)))
        ?.hallazgos,
    ).toEqual([]);
    expect(
      await contarFilas(admin, "compra_hallazgo", "compra_id = $1", [k.id]),
      "la evaluacion 1 se conserva",
    ).toBe(1);
  });

  it("lo contrario: sin hallazgos en la evaluacion 1 y con uno en la 2, el listado con alertas y el detalle lo ven", async () => {
    const c = await clienteNuevo();
    const k = await compraDe(c);
    await ec.xml(X, c, k.idXml, { origen: "real" });
    await comoBackend((tx) =>
      reevaluarCompra(tx, k.id, { evaluar: evaluadorXml().evaluar }),
    );
    const lista = await comoBackend((tx) =>
      listarCompras(tx, c.id, PERIODO, { limite: 50, alertas: true }),
    );
    expect(
      lista.filas.map((f) => [
        f.compra.id,
        f.hallazgos.map((h) => h.lecturas.xml),
      ]),
    ).toEqual([[k.id, ["real"]]]);
    const detalle = await comoBackend((tx) =>
      leerDetalleCompra(tx, c.id, PERIODO, k.id),
    );
    expect(
      detalle?.versiones.map((v) => v.n),
      "re-evaluar no agrega versiones al historial",
    ).toEqual([1]);
    expect(detalle?.hallazgos.map((h) => h.lecturas.xml)).toEqual(["real"]);
  });

  it("una version nueva despues de re-evaluar vuelve a la evaluacion 1 con el XML vigente; los vigentes son los suyos, no los de la evaluacion 2 anterior", async () => {
    const c = await clienteNuevo();
    const k = await compraDe(c);
    const xmlId = await ec.xml(X, c, k.idXml, { origen: "real" });
    await comoBackend((tx) =>
      reevaluarCompra(tx, k.id, { evaluar: evaluadorXml().evaluar }),
    );
    const { evaluar, llamadas } = evaluadorXml();
    await comoBackend((tx) =>
      crearVersion(
        tx,
        {
          compraId: k.id,
          versionBase: 1,
          datos: datos({ biDg: "500.00", igvDg: "90.00", total: undefined }),
          accion: "editar",
          usuarioId: ux,
        },
        { evaluar },
      ),
    );
    expect(llamadas[0]).toMatchObject({ version: 2, xml: { origen: "real" } });
    expect(await evaluacionesDe(admin, k.id)).toEqual([
      { version_n: 1, n: 1, documento_xml_id: null },
      { version_n: 1, n: 2, documento_xml_id: xmlId },
      { version_n: 2, n: 1, documento_xml_id: xmlId },
    ]);
    const vigentes =
      (await comoBackend((tx) => leerHallazgosVigentes(tx, [k.id]))).get(
        k.id,
      ) ?? [];
    expect(vigentes.map((h) => h.lecturas)).toEqual([
      { xml: "real", version: "2" },
    ]);
  });

  it("re-evaluar una version posterior a la 1 evalua la vigente (version = 2) y numera dentro de ELLA", async () => {
    const c = await clienteNuevo();
    const k = await compraDe(c);
    await comoBackend((tx) =>
      crearVersion(
        tx,
        {
          compraId: k.id,
          versionBase: 1,
          datos: datos({ biDg: "700.00", igvDg: "126.00", total: undefined }),
          accion: "editar",
          usuarioId: ux,
        },
        { evaluar: evaluadorXml().evaluar },
      ),
    );
    await ec.xml(X, c, k.idXml, { origen: "real" });
    const { evaluar, llamadas } = evaluadorXml();
    await comoWorker((tx) => reevaluarCompra(tx, k.id, { evaluar }));
    expect(llamadas.map((l) => l.version)).toEqual([2]);
    expect(
      (await evaluacionesDe(admin, k.id)).map((e) => [e.version_n, e.n]),
    ).toEqual([
      [1, 1],
      [2, 1],
      [2, 2],
    ]);
  });

  it("D-7: se puede re-evaluar con el periodo revisado o generado (no crea version ni cambia montos)", async () => {
    for (const estado of ["revisado", "generado"] as const) {
      const c = await clienteNuevo();
      const k = await compraDe(c);
      await ec.estadoPeriodo(X, c, PERIODO, estado, ux);
      await ec.xml(X, c, k.idXml, { origen: "real" });
      await comoWorker((tx) =>
        reevaluarCompra(tx, k.id, { evaluar: evaluadorXml().evaluar }),
      );
      expect(
        (await evaluacionesDe(admin, k.id)).map((e) => e.n),
        estado,
      ).toEqual([1, 2]);
      expect(await versionesN(admin, k.id)).toEqual([1]);
    }
  });

  it("si evaluar lanza, la transaccion se revierte y no queda evaluacion ni hallazgos nuevos (014 D-4)", async () => {
    const c = await clienteNuevo();
    const k = await compraDe(c);
    await ec.xml(X, c, k.idXml, { origen: "real" });
    const codigo = await codigoError(
      comoBackend((tx) =>
        reevaluarCompra(tx, k.id, {
          evaluar: async () => {
            throw new Error("la regla fallo a proposito");
          },
        }),
      ),
    );
    expect(codigo).not.toBe("ok");
    expect(await evaluacionesDe(admin, k.id)).toEqual([
      { version_n: 1, n: 1, documento_xml_id: null },
    ]);
    expect(
      await contarFilas(admin, "compra_hallazgo", "compra_id = $1", [k.id]),
    ).toBe(0);
  });

  it("no_encontrada: compra inexistente, de otro estudio o descartada; no escribe nada y no revela cual", async () => {
    const c = await clienteNuevo();
    const ajena = await ec.compraXml(Y, cy, { serie: "F001", numero: "9100" });
    const agregada = await ec.compra(X, c, {
      origen: "agregada",
      serie: "F001",
      numero: "9101",
    });
    await ec.evaluacion(X, agregada.id, 1, 1);
    await admin.query("update compra set descartada_en = now() where id = $1", [
      agregada.id,
    ]);
    for (const id of [
      ajena.id,
      agregada.id,
      "00000000-0000-4000-8000-0000000000aa",
      "no-es-un-uuid",
    ])
      expect(
        await codigoError(
          comoBackend((tx) =>
            reevaluarCompra(tx, id, { evaluar: evaluadorXml().evaluar }),
          ),
        ),
        id,
      ).toBe("no_encontrada");
    expect(await evaluacionesDe(admin, ajena.id)).toEqual([
      { version_n: 1, n: 1, documento_xml_id: null },
    ]);
    expect(await evaluacionesDe(admin, agregada.id)).toEqual([
      { version_n: 1, n: 1, documento_xml_id: null },
    ]);
  });

  it("el detalle sembrado llega a evaluar tal cual (opaco) y nada mas: ni ruta ni sha256 ni autor", async () => {
    const c = await clienteNuevo();
    const k = await compraDe(c);
    await ec.xml(X, c, k.idXml, {
      origen: "subido",
      subidoPor: ux,
      detalle: detalleXml(CANARIO_XML),
    });
    let visto: unknown;
    const evaluar: EvaluarConXml = (f) => {
      visto = f.xml;
      return [];
    };
    await comoBackend((tx) => reevaluarCompra(tx, k.id, { evaluar }));
    expect(visto).toEqual({
      origen: "subido",
      detalle: detalleXml(CANARIO_XML),
    });
  });
});
