/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 016 · T22 · correcciones de la ronda adversarial 2, parte HTTP (rojo). Decisiones del orquestador sobre T21:
//   H-016-10  Aceptar una sugerencia (individual o en bloque) re-evalúa con el entorno ACTUAL (bandera P-4 y XML vigente). Si el
//             resultado difiere de lo que se mostró: 409 `revisar_de_nuevo` en la individual; rechazo o no aplicación en la masiva.
//             Nunca se aplica un monto distinto del vigente.
//   H-016-11  Cuando llega o se sube un XML se re-evalúan TODAS las compras de ese comprobante (mismo cliente e identidad, en
//             cualquier periodo no descartado). Aceptar contrasta además con el XML vigente, como en H-016-10.
//   H-016-12  «Agregar desde XML» con un XML `real` o `subido` ya guardado para el comprobante responde 409 `xml_existente`
//             (P-6) y no crea la compra (ni deja archivo ni fila nueva de XML).
// Las pruebas "se mantiene" pasan hoy (controles que evitan sobrecorregir); las demás fallan hoy por la causa del hallazgo.
// No repite `reevaluacion.adv.int.spec.ts` (T21): es la versión no adversarial que fija el comportamiento correcto.
import { randomUUID } from "node:crypto";
import { leerUbl } from "@contapp/domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoCompras,
  base,
  PERIODO,
  type Actor,
  type BancoCompras,
  type Estudio,
} from "../../../test/soporte-compras.js";
import {
  archivosDe,
  bytes,
  cambiar,
  documentosXml,
  forzarOrigen,
  pedirXml,
  prepararStorage,
  sha256Hex,
  xmlDe,
  type StoragePrueba,
} from "../../../test/soporte-xml.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let st: StoragePrueba;
let v: BancoCompras;
let E: Estudio;
let contador: Actor;
let banderaOriginal: string | undefined;

beforeAll(async () => {
  st = prepararStorage();
  v = await abrirBancoCompras();
  E = await v.estudio();
  contador = await v.b.c.p.b.miembro(E.tenantId, "contador");
  banderaOriginal = process.env.XML_SIMULADO_EN_REGLAS;
  process.env.XML_SIMULADO_EN_REGLAS = "1";
});
afterAll(async () => {
  if (banderaOriginal === undefined) delete process.env.XML_SIMULADO_EN_REGLAS;
  else process.env.XML_SIMULADO_EN_REGLAS = banderaOriginal;
  await v?.cerrar();
  st?.restaurar();
});

type Cliente = { id: string; ruc: string };
const P2 = "202609";
const RUC_MIXTA = "20700000045";
const nuevoCliente = (): Promise<Cliente> => v.cliente(E, { responsable: contador.id });
const ruta = (c: Cliente, id: string, resto = "", periodo = PERIODO) => `${base(c.id, periodo)}/${id}${resto}`;
const subir = (c: Cliente, id: string, xml: string, periodo = PERIODO) =>
  pedirXml(v, contador, "POST", ruta(c, id, "/xml", periodo), bytes(xml));
const detalle = (c: Cliente, id: string, periodo = PERIODO) => v.llamar(contador, "GET", ruta(c, id, "/detalle", periodo));
const post = (c: Cliente, id: string, resto: string, cuerpo: unknown, periodo = PERIODO) =>
  v.llamar(contador, "POST", ruta(c, id, resto, periodo), cuerpo);
const aceptar = (c: Cliente, id: string, versionBase: number, periodo = PERIODO) =>
  post(c, id, "/sugerencias/aceptar", { versionBase, regla: "R-MIX", confirmar: true }, periodo);
const masiva = (c: Cliente, items: { compraId: string; versionBase: number }[], periodo = PERIODO) =>
  v.llamar(contador, "POST", `${base(c.id, periodo)}/masivas/aceptar`, { items, regla: "R-MIX" });
const desdeXml = (c: Cliente, xml: string, periodo = PERIODO) =>
  pedirXml(v, contador, "POST", `${base(c.id, periodo)}/desde-xml?destino=DG`, bytes(xml));
const rMix = (d: any) => (d.hallazgos as any[]).find((h) => h.regla === "R-MIX");

/** La mixta con otra separación dentro del rango de R-MIX (8.92–8.97): gravado 8.95 y no gravado 12.53, mismo IGV y total. */
const variante = (xml: string) => cambiar(cambiar(xml, ">8.97<", ">8.95<"), ">12.51<", ">12.53<");

/** Evaluaciones de una compra: [versión, n, id del XML con el que se evaluó]. */
const evaluaciones = (compraId: string): Promise<{ version_n: number; n: number; documento_xml_id: string | null }[]> =>
  v.b.sql(
    "select version_n::int as version_n, n::int as n, documento_xml_id from compra_evaluacion where compra_id = $1 order by version_n, n",
    [compraId],
  );

/** Un XML `real` guardado detrás de la evaluación (sin re-evaluar): la ventana en la que la lupa mostraba un exacto ya viejo. */
async function sembrarRealSinReevaluar(c: Cliente, numero: string, xml: string): Promise<void> {
  const b = bytes(xml);
  const siguiente = (
    await v.b.sql(
      "select coalesce(max(n), 0)::int + 1 as n from documento_xml where cliente_id = $1 and ruc_emisor = $2 and serie = 'F001' and numero = $3",
      [c.id, RUC_MIXTA, numero],
    )
  )[0].n as number;
  await v.b.sql(
    `insert into documento_xml (tenant_id, cliente_id, ruc_emisor, tipo, serie, numero, n, origen, ruta, sha256, tamano, detalle)
     values ($1, $2, $3, '01', 'F001', $4, $5, 'real', $6, decode($7, 'hex'), $8, $9::jsonb)`,
    [E.tenantId, c.id, RUC_MIXTA, numero, siguiente, `xml/${E.tenantId}/${c.id}/${randomUUID()}.xml`, sha256Hex(b), b.length,
      JSON.stringify(leerUbl(b))],
  );
}

// ---------------------------------------------------------------------------------------------------------- H-016-10
describe("H-016-10 · aceptar re-evalúa con el entorno actual: la bandera P-4 cambia entre evaluar y aceptar", () => {
  /** La mixta con un XML simulado evaluado con la bandera en 1: la lupa muestra R-MIX exacto 8.97 sin confirmación. */
  async function conExactoDelSimulado() {
    const c = await nuevoCliente();
    const ids = await v.sembrarFixture(E.tenantId, c.id, { usuarioId: E.titular.id });
    const id = ids["F001-2056"]!;
    expect((await subir(c, id, xmlDe("2056", c.ruc))).status).toBe(200);
    const [doc] = await documentosXml(v, c.id);
    await forzarOrigen(v, doc!.id, "simulado");
    // Versión nueva evaluada con el simulado y la bandera en 1 (excluir y restaurar no cambian montos): versión vigente 3.
    expect((await post(c, id, "/excluir", { versionBase: 1 })).status).toBe(200);
    expect((await post(c, id, "/restaurar", { versionBase: 2 })).status).toBe(200);
    const visto = await detalle(c, id);
    expect(visto.body.xml).toMatchObject({ estado: "disponible", origen: "simulado" });
    expect(rMix(visto.body)).toMatchObject({ requiereConfirmacion: false, sugerencia: { exacto: "8.97" } });
    return { c, id };
  }
  const sinBandera = async <R>(fn: () => Promise<R>): Promise<R> => {
    process.env.XML_SIMULADO_EN_REGLAS = "0"; // producción: el simulado ya no entra en las reglas
    try {
      return await fn();
    } finally {
      process.env.XML_SIMULADO_EN_REGLAS = "1";
    }
  };

  it("individual: con la bandera ya apagada, el exacto del simulado que mostró la lupa da 409 revisar_de_nuevo y no escribe", async () => {
    const { c, id } = await conExactoDelSimulado();
    const foto = await v.foto(c.id);
    const r = await sinBandera(() => aceptar(c, id, 3));
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "revisar_de_nuevo" });
    expect(await v.foto(c.id)).toEqual(foto);
  });

  it("en bloque: con la bandera ya apagada, no se aplica el exacto del simulado (0 aplicadas y nada cambia)", async () => {
    const { c, id } = await conExactoDelSimulado();
    const foto = await v.foto(c.id);
    const r = await sinBandera(() => masiva(c, [{ compraId: id, versionBase: 3 }]));
    expect(r.status, r.text).toBe(200);
    expect(r.body.aplicadas).toBe(0);
    expect(await v.foto(c.id)).toEqual(foto);
  });

  it("se mantiene: con la bandera sin cambiar, aceptar una a una y en bloque aplica el exacto que mostró la lupa (8.97)", async () => {
    const individual = await conExactoDelSimulado();
    const a = await aceptar(individual.c, individual.id, 3);
    expect(a.status, a.text).toBe(200);
    expect((await v.versiones(individual.id)).at(-1)).toMatchObject({ n: 4, accion: "sugerencia", biDg: "8.97" });

    const enBloque = await conExactoDelSimulado();
    const m = await masiva(enBloque.c, [{ compraId: enBloque.id, versionBase: 3 }]);
    expect(m.status, m.text).toBe(200);
    expect(m.body.aplicadas).toBe(1);
    expect((await v.versiones(enBloque.id)).at(-1)).toMatchObject({ n: 4, accion: "sugerencia", biDg: "8.97" });
  });
});

// ---------------------------------------------------------------------------------------------------------- H-016-11 (aceptar)
describe("H-016-11 · aceptar contrasta con el XML vigente del comprobante (no con el que tenía la última evaluación)", () => {
  /** La lupa mostró el exacto 8.97 del XML subido; después quedó guardado otro XML (8.95) sin que nadie re-evaluara. */
  async function conXmlVigenteDistinto() {
    const c = await nuevoCliente();
    const ids = await v.sembrarFixture(E.tenantId, c.id, { usuarioId: E.titular.id });
    const id = ids["F001-2056"]!;
    expect((await subir(c, id, xmlDe("2056", c.ruc))).status).toBe(200);
    expect(rMix((await detalle(c, id)).body)).toMatchObject({ sugerencia: { exacto: "8.97" } });
    await sembrarRealSinReevaluar(c, "2056", variante(xmlDe("2056", c.ruc)));
    return { c, id };
  }

  it("individual: el exacto guardado (8.97) ya no es el del XML vigente (8.95): 409 revisar_de_nuevo y no escribe", async () => {
    const { c, id } = await conXmlVigenteDistinto();
    const foto = await v.foto(c.id);
    const r = await aceptar(c, id, 1);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "revisar_de_nuevo" });
    expect(await v.foto(c.id)).toEqual(foto);
  });

  it("en bloque: no se aplica el exacto de un XML que ya no es el vigente (0 aplicadas y nada cambia)", async () => {
    const { c, id } = await conXmlVigenteDistinto();
    const foto = await v.foto(c.id);
    const r = await masiva(c, [{ compraId: id, versionBase: 1 }]);
    expect(r.status, r.text).toBe(200);
    expect(r.body.aplicadas).toBe(0);
    expect(await v.foto(c.id)).toEqual(foto);
  });
});

// ---------------------------------------------------------------------------------------------------------- H-016-11 (llegada)
describe("H-016-11 · el XML que llega o se sube re-evalúa todas las compras de su comprobante", () => {
  /** El mismo comprobante F001-2056 en dos periodos (P1 = PERIODO y P2), sin XML todavía. */
  async function enDosPeriodos() {
    const c = await nuevoCliente();
    const p1 = await v.sembrarFixture(E.tenantId, c.id, { usuarioId: E.titular.id });
    const p2 = await v.sembrarFixture(E.tenantId, c.id, { usuarioId: E.titular.id, periodo: P2 });
    return { c, a: p1["F001-2056"]!, b: p2["F001-2056"]! };
  }

  it("subir el XML en un periodo re-evalúa la compra del mismo comprobante en el otro (su lupa y su evaluación usan ese XML)", async () => {
    const { c, a, b } = await enDosPeriodos();
    expect(rMix((await detalle(c, b, P2)).body)).toMatchObject({ requiereConfirmacion: true }); // antes: sin XML
    expect((await subir(c, a, xmlDe("2056", c.ruc))).status).toBe(200);
    const [xml] = await documentosXml(v, c.id);
    const delOtroPeriodo = await evaluaciones(b);
    expect(delOtroPeriodo.at(-1)?.documento_xml_id, "la última evaluación de la compra de P2 usa el XML subido en P1").toBe(xml!.id);
    const lupa = await detalle(c, b, P2);
    expect(lupa.body.xml).toMatchObject({ estado: "disponible", origen: "subido" });
    expect(rMix(lupa.body)).toMatchObject({ requiereConfirmacion: false, sugerencia: { exacto: "8.97" } });
  });

  it("subir un XML que reemplaza al vigente (simulado) deja a las dos compras con el exacto del nuevo (8.95), y la masiva aplica ese", async () => {
    const { c, a, b } = await enDosPeriodos();
    expect((await subir(c, b, xmlDe("2056", c.ruc), P2)).status).toBe(200);
    const [primero] = await documentosXml(v, c.id);
    await forzarOrigen(v, primero!.id, "simulado"); // reemplazable (P-6)
    expect((await subir(c, a, variante(xmlDe("2056", c.ruc)))).status).toBe(200);
    expect((await documentosXml(v, c.id)).map((d) => d.origen)).toEqual(["simulado", "subido"]);
    const lupa = await detalle(c, b, P2);
    expect(rMix(lupa.body), "B ya no muestra el exacto del XML reemplazado").toMatchObject({ sugerencia: { exacto: "8.95" } });
    const r = await masiva(c, [{ compraId: b, versionBase: 1 }], P2);
    expect(r.status, r.text).toBe(200);
    expect(r.body.aplicadas).toBe(1);
    expect((await v.versiones(b)).at(-1)).toMatchObject({ n: 2, accion: "sugerencia", biDg: "8.95" });
  });

  it("agregar desde XML (que guarda el XML del comprobante) re-evalúa la compra del SIRE del mismo comprobante en otro periodo", async () => {
    const c = await nuevoCliente();
    const p1 = await v.sembrarFixture(E.tenantId, c.id, { usuarioId: E.titular.id });
    const sire = p1["F001-2056"]!;
    expect(rMix((await detalle(c, sire)).body)).toMatchObject({ requiereConfirmacion: true }); // antes: sin XML
    const alta = await desdeXml(c, xmlDe("2056", c.ruc), P2);
    expect(alta.status, alta.texto).toBe(201);
    const [xml] = await documentosXml(v, c.id);
    expect((await evaluaciones(sire)).at(-1)?.documento_xml_id).toBe(xml!.id);
    expect(rMix((await detalle(c, sire)).body)).toMatchObject({ requiereConfirmacion: false, sugerencia: { exacto: "8.97" } });
  });

  it("se mantiene: la compra descartada del comprobante y la de otro cliente del estudio no se re-evalúan", async () => {
    const { c, a } = await enDosPeriodos();
    const descartada = await v.sembrarCompra(E.tenantId, c.id, {
      origen: "agregada",
      periodo: "202608",
      serie: "F001",
      numero: "2056",
      doc: RUC_MIXTA,
      usuarioId: E.titular.id,
      descartada: true,
    });
    const otro = await nuevoCliente();
    const deOtro = (await v.sembrarFixture(E.tenantId, otro.id, { usuarioId: E.titular.id }))["F001-2056"]!;
    const antes = { descartada: (await evaluaciones(descartada)).length, deOtro: (await evaluaciones(deOtro)).length };
    expect((await subir(c, a, xmlDe("2056", c.ruc))).status).toBe(200);
    expect((await evaluaciones(descartada)).length, "descartada: D-7, no cambia").toBe(antes.descartada);
    expect((await evaluaciones(deOtro)).length, "otro cliente: su comprobante tiene su propio XML").toBe(antes.deOtro);
  });
});

// ---------------------------------------------------------------------------------------------------------- H-016-12
describe("H-016-12 · agregar desde XML con un XML real o subido ya guardado: 409 xml_existente (P-6)", () => {
  const conteos = async (c: Cliente) => ({
    compras: (await v.compras(c.id)).length + (await v.compras(c.id, P2)).length,
    documentos: (await documentosXml(v, c.id)).length,
    archivos: archivosDe(st.dir, E.tenantId, c.id).length,
  });

  it("el comprobante ya tiene el XML que subió el propio usuario (compra descartada): 409 y no crea ni la compra ni otro XML", async () => {
    const c = await nuevoCliente();
    const r1 = await desdeXml(c, xmlDe("2056", c.ruc));
    expect(r1.status, r1.texto).toBe(201);
    expect((await post(c, r1.json.id, "/descartar", { versionBase: 1 })).status).toBe(200);
    const antes = await conteos(c);
    const r2 = await desdeXml(c, variante(xmlDe("2056", c.ruc)));
    expect(r2.status, r2.texto).toBe(409);
    expect(r2.json).toEqual({ codigo: "xml_existente" });
    expect(await conteos(c)).toEqual(antes);
  });

  it("el comprobante ya tiene un XML subido para una compra del SIRE de otro periodo: 409 y no crea la compra", async () => {
    const c = await nuevoCliente();
    const sire = (await v.sembrarFixture(E.tenantId, c.id, { usuarioId: E.titular.id }))["F001-2056"]!;
    expect((await subir(c, sire, xmlDe("2056", c.ruc))).status).toBe(200);
    const antes = await conteos(c);
    const r = await desdeXml(c, xmlDe("2056", c.ruc), P2);
    expect(r.status, r.texto).toBe(409);
    expect(r.json).toEqual({ codigo: "xml_existente" });
    expect(await conteos(c)).toEqual(antes);
  });

  it("el comprobante ya tiene un XML real (el que trajo el worker): 409 y no crea la compra", async () => {
    const c = await nuevoCliente();
    const sire = (await v.sembrarFixture(E.tenantId, c.id, { usuarioId: E.titular.id }))["F001-2056"]!;
    expect((await subir(c, sire, xmlDe("2056", c.ruc))).status).toBe(200);
    const [doc] = await documentosXml(v, c.id);
    await forzarOrigen(v, doc!.id, "real");
    const antes = await conteos(c);
    const r = await desdeXml(c, xmlDe("2056", c.ruc), P2);
    expect(r.status, r.texto).toBe(409);
    expect(r.json).toEqual({ codigo: "xml_existente" });
    expect(await conteos(c)).toEqual(antes);
  });

  it("se mantiene (P-6): con un XML simulado vigente la alta se crea (201) y el subido pasa a ser el vigente", async () => {
    const c = await nuevoCliente();
    const sire = (await v.sembrarFixture(E.tenantId, c.id, { usuarioId: E.titular.id }))["F001-2056"]!;
    expect((await subir(c, sire, xmlDe("2056", c.ruc))).status).toBe(200);
    const [doc] = await documentosXml(v, c.id);
    await forzarOrigen(v, doc!.id, "simulado");
    const segundo = variante(xmlDe("2056", c.ruc));
    const r = await desdeXml(c, segundo, P2);
    expect(r.status, r.texto).toBe(201);
    const documentos = await documentosXml(v, c.id);
    expect(documentos.map((d) => d.origen)).toEqual(["simulado", "subido"]);
    expect(documentos.at(-1)!.sha256).toBe(sha256Hex(bytes(segundo)));
  });

  it("se mantiene: un comprobante sin ningún XML se agrega (201) y guarda su XML subido", async () => {
    const c = await nuevoCliente();
    const r = await desdeXml(c, xmlDe("2056", c.ruc));
    expect(r.status, r.texto).toBe(201);
    expect((await documentosXml(v, c.id)).map((d) => d.origen)).toEqual(["subido"]);
    expect(archivosDe(st.dir, E.tenantId, c.id)).toHaveLength(1);
  });
});
