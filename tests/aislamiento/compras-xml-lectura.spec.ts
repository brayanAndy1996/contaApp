// Spec 016 (complemento de T5): pruebas de BD de las funciones de LECTURA de la lupa (T11, `packages/db/src/xml/`):
//   leerDetalleXml(tx, clienteId, periodo, compraId)                  · detalle de 014 + identidad + xml vigente + obtencion
//   leerHistorialProveedor(tx, clienteId, periodo, {docTipo, docNumero}) · hasta 50 compras de los 6 periodos anteriores
//   leerObtencion(tx, clienteId, identidad)                           · estado efectivo (pendiente > 1 h = transitorio)
// Contrato: plan.md «Contratos: BD» y D-8/D-4 de la spec. La implementacion ya existe: estas pruebas deben pasar; si una falla es
// un posible defecto de produccion. El plan fija que `leerXmlVigente` (y por tanto `xml`) devuelve `ruta`; el resto de lo que sale
// de estas funciones (compra, versiones, hallazgos, historial, identidad, obtencion) no lleva ruta, sha256 ni tenantId.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, exportado } from "./auth-soporte";
import type { ContappDb, Tx } from "./soporte";
import { crearDb, type ClientePrueba } from "./trabajos-soporte";
import { MONTOS_DG, PERIODO } from "./compras-soporte";
import {
  CANARIO_XML,
  detalleXml,
  EscenarioXml,
  fijarObtencion,
  type EstadoObtencion,
  type IdentidadXml,
  type OrigenXml,
} from "./compras-xml-soporte";

interface DetalleXmlLeido {
  compra: { id: string; serie: string; numero: string; docNumero: string; montos: Record<string, string> };
  proveedorNuevo: boolean;
  versiones: { n: number; accion: string }[];
  hallazgos: { regla: string }[];
  identidad: IdentidadXml;
  xml: {
    id: string;
    n: number;
    origen: OrigenXml;
    detalle: { marca?: string };
    ruta: string;
    sha256: string;
    tamano: number;
    subidoPor: string | null;
    creadaEn: Date;
  } | null;
  obtencion: { estado: EstadoObtencion; intentos: number; actualizadoEn: Date } | null;
}
interface FilaHistorial {
  periodo: string;
  serie: string;
  numero: string;
  biDg: string;
  biDgng: string;
  biDng: string;
  excluida: boolean;
}

const leerDetalleXml = (tx: Tx, c: string, p: string, id: string) =>
  exportado<(tx: Tx, c: string, p: string, id: string) => Promise<DetalleXmlLeido | null>>("leerDetalleXml")(tx, c, p, id);
const leerHistorialProveedor = (tx: Tx, c: string, p: string, prov: { docTipo: string; docNumero: string }) =>
  exportado<(tx: Tx, c: string, p: string, prov: { docTipo: string; docNumero: string }) => Promise<FilaHistorial[]>>(
    "leerHistorialProveedor",
  )(tx, c, p, prov);
const leerObtencion = (tx: Tx, c: string, i: IdentidadXml) =>
  exportado<(tx: Tx, c: string, i: IdentidadXml) => Promise<DetalleXmlLeido["obtencion"]>>("leerObtencion")(tx, c, i);
const TOPE_HISTORIAL = () => exportado<number>("TOPE_HISTORIAL");

let admin: Pool;
let ec: EscenarioXml;
let backend: ContappDb;
let X: string;
let Y: string;
let cx: ClientePrueba;
let cy: ClientePrueba;
let propX: string;

beforeAll(async () => {
  admin = abrirAdmin(6);
  ec = new EscenarioXml(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  cx = await ec.cliente(X);
  cy = await ec.cliente(Y);
  backend = crearDb("contapp_backend", 6);
  propX = await ec.propuesta(X, cx, { libro: "compras", nuevas: 1 });
});
afterAll(async () => {
  await ec?.limpiar();
  await backend?.close().catch(() => undefined);
  await admin?.end();
});

const comoX = <T>(fn: (tx: Tx) => Promise<T>) => backend.withTenant({ tenantId: X }, fn);
const comoY = <T>(fn: (tx: Tx) => Promise<T>) => backend.withTenant({ tenantId: Y }, fn);

/** Todas las claves (a cualquier profundidad) de un valor JSON-like; las fechas y buffers no se recorren. */
function claves(v: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => claves(x, acc));
  else if (v !== null && typeof v === "object" && !(v instanceof Date) && !Buffer.isBuffer(v))
    for (const [k, x] of Object.entries(v)) {
      acc.add(k);
      claves(x, acc);
    }
  return acc;
}
const PROHIBIDAS = ["ruta", "sha256", "tenantId", "tenant_id"];

let ruc = 20100080000;
/** RUC de proveedor unico por prueba (los historiales no se mezclan). */
const nuevoRuc = () => String(++ruc);

describe("leerDetalleXml · casos felices", () => {
  it("sin XML ni obtencion: el detalle de 014 con identidad normalizada, xml null y obtencion null", async () => {
    const c = await ec.cliente(X);
    const docNumero = nuevoRuc();
    const k = await ec.compra(X, c, { serie: "f0a1", numero: "000123", propuestaId: propX, docNumero });
    await ec.version(X, k.id, 2, { montos: { biDg: "500.00", igvDg: "90.00" }, accion: "editar", motivo: null });
    await ec.hallazgo(X, k.id, 2, "R-LUPA");
    const d = await comoX((tx) => leerDetalleXml(tx, c.id, PERIODO, k.id));
    expect(d).not.toBeNull();
    expect(d!.compra.id).toBe(k.id);
    expect(d!.compra.montos.biDg).toBe("500.00");
    expect(d!.versiones.map((v) => [v.n, v.accion])).toEqual([
      [1, "original"],
      [2, "editar"],
    ]);
    expect(d!.hallazgos.map((h) => h.regla)).toEqual(["R-LUPA"]);
    expect(d!.proveedorNuevo).toBe(true);
    expect(d!.identidad).toEqual({ rucEmisor: docNumero, tipo: "01", serie: "F0A1", numero: "123" });
    expect(d!.xml).toBeNull();
    expect(d!.obtencion).toBeNull();
  });

  it("con varios XML devuelve el vigente (mayor n) con origen, detalle, tamano y fecha; el anterior no sale", async () => {
    const c = await ec.cliente(X);
    const docNumero = nuevoRuc();
    const k = await ec.compra(X, c, { serie: "F001", numero: "7", propuestaId: propX, docNumero });
    const id: IdentidadXml = { rucEmisor: docNumero, tipo: "01", serie: "F001", numero: "7" };
    await ec.xml(X, c, id, { origen: "simulado", detalle: detalleXml("MARCA-N1") });
    const idN2 = await ec.xml(X, c, id, { origen: "real", detalle: detalleXml(CANARIO_XML), tamano: 4321 });
    const d = await comoX((tx) => leerDetalleXml(tx, c.id, PERIODO, k.id));
    expect(d!.xml).not.toBeNull();
    expect(d!.xml!.id).toBe(idN2);
    expect(d!.xml!.n).toBe(2);
    expect(d!.xml!.origen).toBe("real");
    expect(d!.xml!.detalle.marca).toBe(CANARIO_XML);
    expect(d!.xml!.tamano).toBe(4321);
    expect(d!.xml!.subidoPor).toBeNull();
    expect(d!.xml!.creadaEn).toBeInstanceOf(Date);
  });

  it("un XML subido trae el usuario que lo subio", async () => {
    const c = await ec.cliente(X);
    const u = await ec.usuarioDe(X);
    const docNumero = nuevoRuc();
    const k = await ec.compra(X, c, { serie: "F001", numero: "8", propuestaId: propX, docNumero });
    await ec.xml(X, c, { rucEmisor: docNumero, tipo: "01", serie: "F001", numero: "8" }, { origen: "subido", subidoPor: u });
    const d = await comoX((tx) => leerDetalleXml(tx, c.id, PERIODO, k.id));
    expect(d!.xml!.origen).toBe("subido");
    expect(d!.xml!.subidoPor).toBe(u);
  });

  it("encuentra el XML aunque la compra guarde la serie en minusculas y el numero con ceros", async () => {
    const c = await ec.cliente(X);
    const docNumero = nuevoRuc();
    const k = await ec.compra(X, c, { serie: "f001", numero: "0009", propuestaId: propX, docNumero });
    await ec.xml(X, c, { rucEmisor: docNumero, tipo: "01", serie: "F001", numero: "9" });
    const d = await comoX((tx) => leerDetalleXml(tx, c.id, PERIODO, k.id));
    expect(d!.xml).not.toBeNull();
  });

  it("un XML de otro tipo de comprobante, de otro RUC, serie o numero no se confunde con el de la compra", async () => {
    const c = await ec.cliente(X);
    const docNumero = nuevoRuc();
    const k = await ec.compra(X, c, { serie: "F001", numero: "10", propuestaId: propX, docNumero });
    const base: IdentidadXml = { rucEmisor: docNumero, tipo: "01", serie: "F001", numero: "10" };
    await ec.xml(X, c, { ...base, tipo: "03" });
    await ec.xml(X, c, { ...base, rucEmisor: nuevoRuc() });
    await ec.xml(X, c, { ...base, serie: "F002" });
    await ec.xml(X, c, { ...base, numero: "11" });
    const d = await comoX((tx) => leerDetalleXml(tx, c.id, PERIODO, k.id));
    expect(d!.xml).toBeNull();
  });
});

describe("leerDetalleXml · estado de obtencion", () => {
  const compraConId = async (serie: string, numero: string) => {
    const c = await ec.cliente(X);
    const docNumero = nuevoRuc();
    const k = await ec.compra(X, c, { serie, numero, propuestaId: propX, docNumero });
    return { c, k, id: { rucEmisor: docNumero, tipo: "01", serie, numero } as IdentidadXml };
  };

  it("pendiente reciente se lee pendiente con 0 intentos", async () => {
    const { c, k, id } = await compraConId("F001", "20");
    await ec.obtencion(X, c, id, "pendiente");
    const d = await comoX((tx) => leerDetalleXml(tx, c.id, PERIODO, k.id));
    expect(d!.obtencion?.estado).toBe("pendiente");
    expect(d!.obtencion?.intentos).toBe(0);
    expect(d!.obtencion?.actualizadoEn).toBeInstanceOf(Date);
    expect(d!.xml).toBeNull();
  });

  it("un pendiente de mas de 1 h se lee transitorio; uno de menos de 1 h sigue pendiente", async () => {
    const { c, k, id } = await compraConId("F001", "21");
    await ec.obtencion(X, c, id, "pendiente");
    await admin.query(
      "update documento_xml_obtencion set actualizado_en = now() - interval '59 minutes' where cliente_id = $1",
      [c.id],
    );
    expect((await comoX((tx) => leerDetalleXml(tx, c.id, PERIODO, k.id)))!.obtencion?.estado).toBe("pendiente");
    await admin.query(
      "update documento_xml_obtencion set actualizado_en = now() - interval '61 minutes' where cliente_id = $1",
      [c.id],
    );
    expect((await comoX((tx) => leerDetalleXml(tx, c.id, PERIODO, k.id)))!.obtencion?.estado).toBe("transitorio");
  });

  it.each(["no_encontrado", "credencial", "transitorio"] as const)("%s viejo no se reinterpreta", async (estado) => {
    const { c, k, id } = await compraConId("F001", `3${estado.length}`);
    await ec.obtencion(X, c, id, estado);
    await admin.query(
      "update documento_xml_obtencion set actualizado_en = now() - interval '5 hours' where cliente_id = $1",
      [c.id],
    );
    const d = await comoX((tx) => leerDetalleXml(tx, c.id, PERIODO, k.id));
    expect(d!.obtencion?.estado).toBe(estado);
  });

  it("fijarObtencion cuenta los resultados: los intentos suben con cada estado distinto de pendiente", async () => {
    const { c, id } = await compraConId("F001", "40");
    await comoX((tx) => fijarObtencion(tx, c.id, id, "pendiente"));
    expect((await comoX((tx) => leerObtencion(tx, c.id, id)))?.intentos).toBe(0);
    await comoX((tx) => fijarObtencion(tx, c.id, id, "no_encontrado"));
    await comoX((tx) => fijarObtencion(tx, c.id, id, "transitorio"));
    const o = await comoX((tx) => leerObtencion(tx, c.id, id));
    expect(o?.estado).toBe("transitorio");
    expect(o?.intentos).toBe(2);
  });

  it("leerObtencion normaliza la identidad (serie en mayusculas, numero sin ceros)", async () => {
    const { c, id } = await compraConId("F001", "41");
    await ec.obtencion(X, c, id, "credencial");
    const o = await comoX((tx) => leerObtencion(tx, c.id, { ...id, serie: "f001", numero: "0041" }));
    expect(o?.estado).toBe("credencial");
  });

  it("leerObtencion es null si nadie lo pidio, y el estado de otro cliente u otro estudio no se ve", async () => {
    const { c, id } = await compraConId("F001", "42");
    const otro = await ec.cliente(X);
    await ec.obtencion(X, c, id, "credencial");
    expect(await comoX((tx) => leerObtencion(tx, c.id, { ...id, numero: "999" }))).toBeNull();
    expect(await comoX((tx) => leerObtencion(tx, otro.id, id))).toBeNull();
    expect(await comoY((tx) => leerObtencion(tx, c.id, id))).toBeNull();
    expect((await comoX((tx) => leerObtencion(tx, c.id, id)))?.estado).toBe("credencial");
  });
});

describe("leerDetalleXml · aislamiento y compras que no existen", () => {
  it("el XML y la obtencion de otro cliente del mismo estudio, con el mismo comprobante, no se mezclan", async () => {
    const a = await ec.cliente(X);
    const b = await ec.cliente(X);
    const docNumero = nuevoRuc();
    const ka = await ec.compra(X, a, { serie: "F001", numero: "50", propuestaId: propX, docNumero });
    const kb = await ec.compra(X, b, { serie: "F001", numero: "50", propuestaId: propX, docNumero });
    const id: IdentidadXml = { rucEmisor: docNumero, tipo: "01", serie: "F001", numero: "50" };
    await ec.xml(X, a, id, { detalle: detalleXml("SOLO-DE-A") });
    await ec.obtencion(X, a, id, "credencial");
    const da = await comoX((tx) => leerDetalleXml(tx, a.id, PERIODO, ka.id));
    const db = await comoX((tx) => leerDetalleXml(tx, b.id, PERIODO, kb.id));
    expect(da!.xml?.detalle.marca).toBe("SOLO-DE-A");
    expect(da!.obtencion?.estado).toBe("credencial");
    expect(db!.xml).toBeNull();
    expect(db!.obtencion).toBeNull();
    // y si B tiene el suyo, cada uno ve el propio
    await ec.xml(X, b, id, { detalle: detalleXml("SOLO-DE-B") });
    expect((await comoX((tx) => leerDetalleXml(tx, b.id, PERIODO, kb.id)))!.xml?.detalle.marca).toBe("SOLO-DE-B");
    expect((await comoX((tx) => leerDetalleXml(tx, a.id, PERIODO, ka.id)))!.xml?.detalle.marca).toBe("SOLO-DE-A");
  });

  it("otro estudio no ve la compra ni su XML; el suyo, con la misma identidad, es independiente", async () => {
    const c = await ec.cliente(X);
    const docNumero = nuevoRuc();
    const k = await ec.compra(X, c, { serie: "F001", numero: "51", propuestaId: propX, docNumero });
    const id: IdentidadXml = { rucEmisor: docNumero, tipo: "01", serie: "F001", numero: "51" };
    await ec.xml(X, c, id, { detalle: detalleXml("DEL-ESTUDIO-X") });
    await ec.obtencion(X, c, id, "pendiente");
    expect(await comoY((tx) => leerDetalleXml(tx, c.id, PERIODO, k.id))).toBeNull();
    const ky = await ec.compra(Y, cy, { serie: "F001", numero: "51", docNumero });
    const dy = await comoY((tx) => leerDetalleXml(tx, cy.id, PERIODO, ky.id));
    expect(dy!.xml).toBeNull();
    expect(dy!.obtencion).toBeNull();
    await ec.xml(Y, cy, id, { detalle: detalleXml("DEL-ESTUDIO-Y") });
    expect((await comoY((tx) => leerDetalleXml(tx, cy.id, PERIODO, ky.id)))!.xml?.detalle.marca).toBe("DEL-ESTUDIO-Y");
    expect((await comoX((tx) => leerDetalleXml(tx, c.id, PERIODO, k.id)))!.xml?.detalle.marca).toBe("DEL-ESTUDIO-X");
  });

  it("es null para id mal formado, inexistente, de otro periodo o cliente, o de otro estudio, aunque haya XML", async () => {
    const c = await ec.cliente(X);
    const otro = await ec.cliente(X);
    const docNumero = nuevoRuc();
    const k = await ec.compra(X, c, { serie: "F001", numero: "52", propuestaId: propX, docNumero });
    await ec.xml(X, c, { rucEmisor: docNumero, tipo: "01", serie: "F001", numero: "52" });
    const leer = (cl: string, p: string, id: string) => comoX((tx) => leerDetalleXml(tx, cl, p, id));
    expect(await leer(c.id, PERIODO, "no-es-un-uuid")).toBeNull();
    expect(await leer(c.id, PERIODO, "00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(await leer(c.id, "202609", k.id)).toBeNull();
    expect(await leer(otro.id, PERIODO, k.id)).toBeNull();
    expect(await comoY((tx) => leerDetalleXml(tx, c.id, PERIODO, k.id))).toBeNull();
    expect(await leer(c.id, PERIODO, k.id)).not.toBeNull();
  });

  it("una compra descartada es null aunque tenga XML; al volver a agregarla (nueva compra) recupera el mismo XML", async () => {
    const c = await ec.cliente(X);
    const docNumero = nuevoRuc();
    const g = await ec.compra(X, c, { serie: "F001", numero: "53", origen: "agregada", docNumero });
    await ec.xml(X, c, { rucEmisor: docNumero, tipo: "01", serie: "F001", numero: "53" }, { detalle: detalleXml("SOBREVIVE") });
    await admin.query("update compra set descartada_en = now() where id = $1", [g.id]);
    expect(await comoX((tx) => leerDetalleXml(tx, c.id, PERIODO, g.id))).toBeNull();
    // D-4: el XML cuelga del comprobante, no de la compra: otra compra con la misma identidad lo ve
    const h = await ec.compra(X, c, { serie: "F001", numero: "53", origen: "agregada", docNumero, clave: "otra-clave-53" });
    const d = await comoX((tx) => leerDetalleXml(tx, c.id, PERIODO, h.id));
    expect(d!.xml?.detalle.marca).toBe("SOBREVIVE");
  });
});

describe("leerDetalleXml · lo que nunca sale", () => {
  it("fuera de `xml` no aparece ruta, sha256 ni tenantId a ninguna profundidad", async () => {
    const c = await ec.cliente(X);
    const docNumero = nuevoRuc();
    const k = await ec.compra(X, c, { serie: "F001", numero: "60", propuestaId: propX, docNumero });
    await ec.version(X, k.id, 2, { montos: { biDg: "400.00", igvDg: "72.00" }, accion: "editar", motivo: null });
    await ec.hallazgo(X, k.id, 2, "R-LUPA");
    const id: IdentidadXml = { rucEmisor: docNumero, tipo: "01", serie: "F001", numero: "60" };
    await ec.xml(X, c, id);
    await ec.obtencion(X, c, id, "pendiente");
    const d = await comoX((tx) => leerDetalleXml(tx, c.id, PERIODO, k.id));
    const { xml, ...resto } = d!;
    expect(xml).not.toBeNull();
    const fuera = claves(resto);
    for (const p of PROHIBIDAS) expect(fuera.has(p), `clave ${p} fuera de xml`).toBe(false);
    expect(Object.keys(d!).sort()).toEqual(
      ["compra", "hallazgos", "identidad", "obtencion", "proveedorNuevo", "versiones", "xml"].sort(),
    );
  });

  it("`xml` no lleva tenantId; la ruta y el hash que trae son los del plan (ruta del storage y SHA-256 en hex)", async () => {
    const c = await ec.cliente(X);
    const docNumero = nuevoRuc();
    const k = await ec.compra(X, c, { serie: "F001", numero: "61", propuestaId: propX, docNumero });
    await ec.xml(X, c, { rucEmisor: docNumero, tipo: "01", serie: "F001", numero: "61" });
    const d = await comoX((tx) => leerDetalleXml(tx, c.id, PERIODO, k.id));
    const x = d!.xml!;
    expect(Object.keys(x).sort()).toEqual(
      ["creadaEn", "detalle", "id", "n", "origen", "ruta", "sha256", "subidoPor", "tamano"].sort(),
    );
    expect(x.ruta).toMatch(new RegExp(`^xml/${X}/${c.id}/[0-9a-f-]{36}\\.xml$`));
    expect(x.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(x)).not.toContain(Y);
  });
});

describe("leerHistorialProveedor", () => {
  const compra = (c: ClientePrueba, docNumero: string, periodo: string, numero: string, o: Record<string, unknown> = {}) =>
    ec.compra(X, c, { periodo, serie: "F001", numero, origen: "agregada", docNumero, fecha: `${periodo.slice(0, 4)}-${periodo.slice(4)}-10`, ...o });
  const prov = (docNumero: string, docTipo = "6") => ({ docTipo, docNumero });

  it("constante TOPE_HISTORIAL = 50", () => {
    expect(TOPE_HISTORIAL()).toBe(50);
  });

  it("proveedor sin compras previas: lista vacia", async () => {
    const c = await ec.cliente(X);
    expect(await comoX((tx) => leerHistorialProveedor(tx, c.id, PERIODO, prov(nuevoRuc())))).toEqual([]);
  });

  it("devuelve las del proveedor con bases exactas de la version VIGENTE, vivas y excluidas, de la mas reciente a la mas antigua", async () => {
    const c = await ec.cliente(X);
    const p = nuevoRuc();
    const a = await compra(c, p, "202609", "1", { montos: { biDg: "1000.00", igvDg: "180.00" } });
    const b = await compra(c, p, "202609", "2", { fecha: "2026-09-20", montos: { biDg: "200.50", igvDg: "36.09" } });
    const e = await compra(c, p, "202608", "3", { montos: { biDgng: "300.10", biDng: "40.05" } });
    // la vigente de `a` es la 2 (editada) y la de `e` queda excluida
    await ec.version(X, a.id, 2, { montos: { biDg: "999.99", igvDg: "180.00", biDng: "1.01" }, accion: "editar", motivo: null });
    await ec.version(X, e.id, 2, { montos: { biDgng: "300.10", biDng: "40.05" }, excluida: true, motivo: "duplicada", accion: "excluir" });
    // el cliente analiza 202610
    const h = await comoX((tx) => leerHistorialProveedor(tx, c.id, PERIODO, prov(p)));
    expect(h).toEqual([
      // 202609: fecha desc -> la del 20 (numero 2) antes que la del 10 (numero 1)
      { periodo: "202609", serie: "F001", numero: "2", biDg: "200.50", biDgng: "0.00", biDng: "0.00", excluida: false },
      { periodo: "202609", serie: "F001", numero: "1", biDg: "999.99", biDgng: "0.00", biDng: "1.01", excluida: false },
      { periodo: "202608", serie: "F001", numero: "3", biDg: "0.00", biDgng: "300.10", biDng: "40.05", excluida: true },
    ]);
    expect(b.id).toBeTruthy();
  });

  it("los montos son cadenas NUMERIC exactas, nunca number", async () => {
    const c = await ec.cliente(X);
    const p = nuevoRuc();
    await compra(c, p, "202609", "1", { montos: { biDg: "12345678901.23", biDgng: "0.10", biDng: "0.20" } });
    const [f] = await comoX((tx) => leerHistorialProveedor(tx, c.id, PERIODO, prov(p)));
    expect([f!.biDg, f!.biDgng, f!.biDng]).toEqual(["12345678901.23", "0.10", "0.20"]);
    for (const m of [f!.biDg, f!.biDgng, f!.biDng]) expect(typeof m).toBe("string");
  });

  it("ventana de 6 periodos anteriores: 202604 entra y 202603 no para 202610; el periodo pedido y los posteriores tampoco", async () => {
    const c = await ec.cliente(X);
    const p = nuevoRuc();
    for (const [i, per] of ["202603", "202604", "202609", "202610", "202611"].entries()) await compra(c, p, per, String(i + 1));
    const h = await comoX((tx) => leerHistorialProveedor(tx, c.id, "202610", prov(p)));
    expect(h.map((f) => f.periodo)).toEqual(["202609", "202604"]);
  });

  it("la ventana cruza el cambio de anio: para 202602 entra 202508 y no 202507", async () => {
    const c = await ec.cliente(X);
    const p = nuevoRuc();
    for (const [i, per] of ["202507", "202508", "202512", "202601", "202602"].entries()) await compra(c, p, per, String(i + 1));
    const h = await comoX((tx) => leerHistorialProveedor(tx, c.id, "202602", prov(p)));
    expect(h.map((f) => f.periodo)).toEqual(["202601", "202512", "202508"]);
  });

  it("no incluye descartadas ni compras de otro proveedor (otro numero, o mismo numero con otro tipo de documento)", async () => {
    const c = await ec.cliente(X);
    const p = nuevoRuc();
    const viva = await compra(c, p, "202609", "1");
    const muerta = await compra(c, p, "202609", "2");
    await admin.query("update compra set descartada_en = now() where id = $1", [muerta.id]);
    await compra(c, nuevoRuc(), "202609", "3");
    await compra(c, p, "202609", "4", { docTipo: "1" });
    const h = await comoX((tx) => leerHistorialProveedor(tx, c.id, PERIODO, prov(p)));
    expect(h.map((f) => f.numero)).toEqual(["1"]);
    expect(viva.id).toBeTruthy();
    expect(await comoX((tx) => leerHistorialProveedor(tx, c.id, PERIODO, prov(p, "1")))).toHaveLength(1);
  });

  it("tope de 50: con 55 compras devuelve las 50 mas recientes, con el orden numerico del numero dentro del periodo", async () => {
    const c = await ec.cliente(X);
    const p = nuevoRuc();
    // 30 en 202609 y 25 en 202608, misma fecha y serie dentro de cada periodo
    for (let i = 1; i <= 30; i++) await compra(c, p, "202609", String(i));
    for (let i = 1; i <= 25; i++) await compra(c, p, "202608", String(i));
    const h = await comoX((tx) => leerHistorialProveedor(tx, c.id, PERIODO, prov(p)));
    expect(h).toHaveLength(50);
    expect(h.slice(0, 30).every((f) => f.periodo === "202609")).toBe(true);
    expect(h.slice(0, 30).map((f) => f.numero)).toEqual(Array.from({ length: 30 }, (_, i) => String(i + 1)));
    expect(h.slice(30).every((f) => f.periodo === "202608")).toBe(true);
    expect(h.slice(30).map((f) => f.numero)).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1)));
  }, 60_000);

  it("exactamente 50 compras: devuelve las 50, ninguna se pierde", async () => {
    const c = await ec.cliente(X);
    const p = nuevoRuc();
    for (let i = 1; i <= 50; i++) await compra(c, p, "202609", String(i));
    expect(await comoX((tx) => leerHistorialProveedor(tx, c.id, PERIODO, prov(p)))).toHaveLength(50);
  }, 60_000);

  it("aislamiento por cliente: las compras del mismo proveedor de otro cliente del estudio no aparecen", async () => {
    const a = await ec.cliente(X);
    const b = await ec.cliente(X);
    const p = nuevoRuc();
    await compra(a, p, "202609", "1");
    await compra(b, p, "202609", "2");
    await compra(b, p, "202608", "3");
    expect((await comoX((tx) => leerHistorialProveedor(tx, a.id, PERIODO, prov(p)))).map((f) => f.numero)).toEqual(["1"]);
    expect((await comoX((tx) => leerHistorialProveedor(tx, b.id, PERIODO, prov(p)))).map((f) => f.numero)).toEqual(["2", "3"]);
  });

  it("aislamiento por estudio: otro estudio no lee el historial de mi cliente; el suyo es independiente", async () => {
    const c = await ec.cliente(X);
    const p = nuevoRuc();
    await compra(c, p, "202609", "1");
    expect(await comoY((tx) => leerHistorialProveedor(tx, c.id, PERIODO, prov(p)))).toEqual([]);
    await ec.compra(Y, cy, { periodo: "202609", serie: "F001", numero: "9", origen: "agregada", docNumero: p, fecha: "2026-09-10" });
    const hy = await comoY((tx) => leerHistorialProveedor(tx, cy.id, PERIODO, prov(p)));
    expect(hy.map((f) => f.numero)).toEqual(["9"]);
    expect((await comoX((tx) => leerHistorialProveedor(tx, c.id, PERIODO, prov(p)))).map((f) => f.numero)).toEqual(["1"]);
    // un cliente que no existe en el estudio tampoco devuelve nada
    expect(await comoX((tx) => leerHistorialProveedor(tx, cy.id, PERIODO, prov(p)))).toEqual([]);
  });

  it("cada fila lleva solo las 7 claves del contrato: sin id, ruta, sha256 ni tenantId", async () => {
    const c = await ec.cliente(X);
    const p = nuevoRuc();
    await compra(c, p, "202609", "1");
    await ec.xml(X, c, { rucEmisor: p, tipo: "01", serie: "F001", numero: "1" });
    const h = await comoX((tx) => leerHistorialProveedor(tx, c.id, PERIODO, prov(p)));
    expect(h).toHaveLength(1);
    expect(Object.keys(h[0]!).sort()).toEqual(["biDg", "biDgng", "biDng", "excluida", "numero", "periodo", "serie"]);
    const ks = claves(h);
    for (const k of PROHIBIDAS) expect(ks.has(k)).toBe(false);
  });

  it("una compra vigente con los montos de la grilla (MONTOS_DG) se refleja en biDg", async () => {
    const c = await ec.cliente(X);
    const p = nuevoRuc();
    await compra(c, p, "202609", "1");
    const [f] = await comoX((tx) => leerHistorialProveedor(tx, c.id, PERIODO, prov(p)));
    expect(f!.biDg).toBe(MONTOS_DG.biDg);
  });
});
