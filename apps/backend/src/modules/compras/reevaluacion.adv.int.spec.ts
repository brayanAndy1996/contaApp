/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 016 · T21 · ronda adversarial 2 (HTTP): re-evaluación y aceptación en bloque (D-4 a D-7, P-4, P-6; CA-6 a CA-9, CA-13,
// CA-16). Caja negra (C1–C2: la bandera P-4 y el bloque de 5.000) y caja blanca (C3–C4, tras leer `aceptar.ts` del dominio,
// `xml.service.ts`, `desde-xml.service.ts` y `packages/db/src/xml/reevaluar.ts`). No repite T7 (`xml.int.spec.ts`,
// `desde-xml.int.spec.ts`, `masivas.int.spec.ts`). Una prueba en rojo es un hallazgo H-016-n.
// Hallazgos: C1 -> H-016-10 · C3 -> H-016-11 · C4 -> H-016-12. En verde: C2.
import { randomUUID } from "node:crypto";
import { crearEvaluarCompras, leerUbl } from "@contapp/domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoCompras,
  base,
  PERIODO,
  type Actor,
  type BancoCompras,
  type Estudio,
  type HallazgoSembrado,
  type Montos,
} from "../../../test/soporte-compras.js";
import {
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

vi.setConfig({ testTimeout: 300_000, hookTimeout: 120_000 });

let st: StoragePrueba;
let v: BancoCompras;
let E: Estudio;
let contador: Actor;
let otro: Actor;
let banderaOriginal: string | undefined;

beforeAll(async () => {
  st = prepararStorage();
  v = await abrirBancoCompras();
  E = await v.estudio();
  contador = await v.b.c.p.b.miembro(E.tenantId, "contador");
  otro = await v.b.c.p.b.miembro(E.tenantId, "contador");
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
const nuevoCliente = (): Promise<Cliente> => v.cliente(E, { responsable: contador.id, colaboradores: [otro.id] });
const ruta = (c: Cliente, id: string, resto = "", periodo = PERIODO) => `${base(c.id, periodo)}/${id}${resto}`;
const subir = (c: Cliente, id: string, xml: string, periodo = PERIODO) =>
  pedirXml(v, contador, "POST", ruta(c, id, "/xml", periodo), bytes(xml));
const detalle = (c: Cliente, id: string, periodo = PERIODO) => v.llamar(contador, "GET", ruta(c, id, "/detalle", periodo));
const post = (a: Actor, c: Cliente, id: string, resto: string, cuerpo: unknown, periodo = PERIODO) =>
  v.llamar(a, "POST", ruta(c, id, resto, periodo), cuerpo);
const masiva = (c: Cliente, items: { compraId: string; versionBase: number }[], periodo = PERIODO) =>
  v.llamar(contador, "POST", `${base(c.id, periodo)}/masivas/aceptar`, { items, regla: "R-MIX" });
const rMix = (d: any) => (d.hallazgos as any[]).find((h) => h.regla === "R-MIX");

/** El XML de la mixta con otro número de comprobante. */
const conNumero = (xml: string, numero: string) => cambiar(xml, "<cbc:ID>F001-2056</cbc:ID>", `<cbc:ID>F001-${numero}</cbc:ID>`);
/** La mixta con otra separación dentro del rango de R-MIX (8.92–8.97): gravado 8.95 y no gravado 12.53, mismo IGV y total. */
const variante = (xml: string) => cambiar(cambiar(xml, ">8.97<", ">8.95<"), ">12.51<", ">12.53<");
const enUsd = (xml: string) =>
  cambiar(cambiar(xml, 'currencyID="PEN"', 'currencyID="USD"'), ">PEN</cbc:DocumentCurrencyCode>", ">USD</cbc:DocumentCurrencyCode>");

const MIXTA: Partial<Montos> = { biDg: "21.48", igvDg: "1.61", total: "23.09" };
const RUC_MIXTA = "20700000045";

/** Hallazgo R-MIX sin XML (el que dejaría la descarga), calculado con la misma función del dominio. */
function rMixSinXml(numero: string, montos: Partial<Montos>, tipoDoc = "01"): HallazgoSembrado[] {
  const completo = { biDg: "0.00", igvDg: "0.00", biDgng: "0.00", igvDgng: "0.00", biDng: "0.00", igvDng: "0.00",
    noGravado: "0.00", isc: "0.00", icbper: "0.00", otrosTributos: "0.00", total: "0.00", ...montos };
  const h = crearEvaluarCompras([{ tipo: "6", numero: RUC_MIXTA }], { xmlSimuladoEnReglas: false })({
    docTipo: "6", docNumero: RUC_MIXTA, tipoDoc, serie: "F001", numero, moneda: "PEN", clasificada: false, montos: completo,
  });
  return h.filter((x) => x.regla === "R-MIX") as HallazgoSembrado[];
}

/** Un XML `simulado` que llegó con la bandera apagada: guardado sin evaluación nueva (lo que deja el worker, D-7). */
async function sembrarSimulado(c: Cliente, numero: string, xml: string): Promise<void> {
  const b = bytes(xml);
  await v.b.sql(
    `insert into documento_xml (tenant_id, cliente_id, ruc_emisor, tipo, serie, numero, n, origen, ruta, sha256, tamano, detalle)
     values ($1, $2, $3, '01', 'F001', $4, 1, 'simulado', $5, decode($6, 'hex'), $7, $8::jsonb)`,
    [E.tenantId, c.id, RUC_MIXTA, numero, `xml/${E.tenantId}/${c.id}/${randomUUID()}.xml`, sha256Hex(b), b.length,
      JSON.stringify(leerUbl(b))],
  );
}

// ---------------------------------------------------------------------------------------------------------- caja negra
describe("T21 · caja negra · bandera P-4 cambiada entre evaluar y aceptar (D-7, CA-16)", () => {
  it("C1 · R-MIX exacto de un XML simulado (evaluado con la bandera en 1) no se aplica en bloque cuando la bandera ya está en 0", async () => {
    const c = await nuevoCliente();
    const ids = await v.sembrarFixture(E.tenantId, c.id, { usuarioId: E.titular.id });
    const id = ids["F001-2056"]!;
    expect((await subir(c, id, xmlDe("2056", c.ruc))).status).toBe(200);
    const [doc] = await documentosXml(v, c.id);
    await forzarOrigen(v, doc!.id, "simulado"); // el XML vigente es el del mock (P-4)
    // Una versión nueva se evalúa con el simulado y la bandera en 1 (excluir y restaurar no cambian montos).
    expect((await post(contador, c, id, "/excluir", { versionBase: 1 })).status).toBe(200);
    expect((await post(contador, c, id, "/restaurar", { versionBase: 2 })).status).toBe(200);
    const antes = await detalle(c, id);
    expect(antes.body.xml).toMatchObject({ estado: "disponible", origen: "simulado" });
    expect(rMix(antes.body)).toMatchObject({ requiereConfirmacion: false, sugerencia: { exacto: "8.97" } });

    process.env.XML_SIMULADO_EN_REGLAS = "0"; // producción: el simulado ya no entra en las reglas
    try {
      const foto = await v.foto(c.id);
      const r = await masiva(c, [{ compraId: id, versionBase: 3 }]);
      expect(r.status, r.text).toBe(200);
      expect(
        r.body.aplicadas,
        "con la bandera apagada, la re-evaluación con el mismo entorno ya no da el exacto del simulado: 409/rechazo (plan, Decisiones)",
      ).toBe(0);
      expect(await v.foto(c.id)).toEqual(foto);
    } finally {
      process.env.XML_SIMULADO_EN_REGLAS = "1";
    }
  });
});

describe("T21 · caja negra · aceptación en bloque de 5.000 filas mezcladas", () => {
  it("C2 · lo aplicado es exactamente lo que la lupa mostraba; lo demás es rechazo y no cambia (XML, sin XML, otra moneda, simulado sin bandera, cambiada por otro, nota de crédito)", async () => {
    const c = await nuevoCliente();
    const fixture = await v.sembrarFixture(E.tenantId, c.id, { usuarioId: E.titular.id });
    const especiales: Record<string, string> = {};
    const sembrar = async (numero: string, montos: Partial<Montos>, tipoDoc = "01") => {
      especiales[numero] = await v.sembrarCompra(E.tenantId, c.id, {
        tipoDoc, serie: "F001", numero, doc: RUC_MIXTA, fecha: "2026-10-05", montos, usuarioId: E.titular.id,
        hallazgos: rMixSinXml(numero, montos, tipoDoc),
      });
    };
    await sembrar("2060", MIXTA); // hallazgo previo al XML, sin XML
    await sembrar("2061", MIXTA); // XML en USD sobre una fila PEN
    await sembrar("2062", MIXTA); // simulado guardado con la bandera apagada (sin evaluación nueva)
    await sembrar("2063", MIXTA); // con XML, y luego la cambia otro usuario
    await sembrar("2064", { biDg: "-21.48", igvDg: "-1.61", total: "-23.09" }, "07"); // nota de crédito
    expect((await subir(c, fixture["F001-2056"]!, xmlDe("2056", c.ruc))).status).toBe(200);
    expect((await subir(c, especiales["2061"]!, enUsd(conNumero(xmlDe("2056", c.ruc), "2061")))).status).toBe(200);
    await sembrarSimulado(c, "2062", conNumero(xmlDe("2056", c.ruc), "2062"));
    expect((await subir(c, especiales["2063"]!, conNumero(xmlDe("2056", c.ruc), "2063"))).status).toBe(200);
    const volumen = await v.sembrarVolumen(E.tenantId, c.id, 5000 - 5 - 5, { usuarioId: E.titular.id });

    // Lo que la lupa muestra de cada fila con R-MIX, justo antes del bloque.
    const vistos = new Map<string, { h: any; montos: any; version: number }>();
    for (const id of [fixture["F001-2056"]!, ...Object.values(especiales)]) {
      const d = await detalle(c, id);
      expect(d.status, d.text).toBe(200);
      const versiones = await v.versiones(id);
      const vigente = versiones.at(-1)!;
      vistos.set(id, { h: rMix(d.body), montos: vigente, version: vigente.n });
    }
    // Otro usuario cambia 2063 después de que la lupa se leyó.
    expect((await post(otro, c, especiales["2063"]!, "/editar", { versionBase: 1, cambios: { biDg: "21.47", total: "23.08" } })).status).toBe(200);

    const items = [...Object.values(fixture), ...Object.values(especiales), ...volumen].map((compraId) => ({ compraId, versionBase: 1 }));
    expect(items).toHaveLength(5000);
    const r = await masiva(c, items);
    expect(r.status, r.text).toBe(200);
    const rechazadas = new Map<string, string>((r.body.rechazadas as any[]).map((x) => [x.compraId, x.codigo]));
    expect(r.body.aplicadas + rechazadas.size).toBe(5000);

    for (const [id, visto] of vistos) {
      const despues = (await v.versiones(id)).at(-1)!;
      if (rechazadas.has(id)) {
        expect(despues.n, `${id}: rechazada (${rechazadas.get(id)}) no escribe`).toBe(id === especiales["2063"] ? 2 : visto.version);
        continue;
      }
      // Aplicada: la lupa tenía un R-MIX sin confirmación con exacto, y el monto escrito es ese, no otro.
      expect(visto.h, `${id}: aplicada sin que la lupa mostrara un R-MIX`).toBeDefined();
      expect(visto.h.requiereConfirmacion, `${id}: aplicada con confirmación pendiente`).toBe(false);
      const exacto = visto.h.sugerencia.exacto as string;
      expect(despues).toMatchObject({ n: visto.version + 1, accion: "sugerencia", biDg: exacto, igvDg: visto.montos.igvDg, total: visto.montos.total });
    }
    expect(r.body.aplicadas, "solo F001-2056 tenía un R-MIX respaldado y vigente").toBe(1);
    expect(rechazadas.get(especiales["2063"]!)).toBe("version_obsoleta");
    for (const n of ["2060", "2061", "2062"]) expect(rechazadas.get(especiales[n]!), n).toBe("no_masiva");
    expect(rechazadas.has(especiales["2064"]!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------- caja blanca
describe("T21 · caja blanca · el XML vigente cambia sin re-evaluar todas las compras del comprobante (D-4, D-5)", () => {
  it("C3 · mismo comprobante en dos periodos: el XML nuevo re-evalúa solo una fila; la otra no debe aplicar el exacto de un XML que ya no es vigente", async () => {
    const c = await nuevoCliente();
    const p1 = await v.sembrarFixture(E.tenantId, c.id, { usuarioId: E.titular.id });
    const p2 = await v.sembrarFixture(E.tenantId, c.id, { usuarioId: E.titular.id, periodo: P2 });
    const a = p1["F001-2056"]!;
    const b = p2["F001-2056"]!;
    // B (P2) se evalúa con el primer XML (8.97), que queda como simulado (vigente reemplazable, P-6).
    expect((await subir(c, b, xmlDe("2056", c.ruc), P2)).status).toBe(200);
    const [primero] = await documentosXml(v, c.id);
    await forzarOrigen(v, primero!.id, "simulado");
    // Llega a A (P1) otro XML del MISMO comprobante (8.95 / 12.53): es el vigente del comprobante (D-4).
    const s = await subir(c, a, variante(xmlDe("2056", c.ruc)));
    expect(s.status, s.texto).toBe(200);
    expect((await documentosXml(v, c.id)).map((d) => d.origen)).toEqual(["simulado", "subido"]);
    const lupaB = await detalle(c, b, P2);
    expect(lupaB.body.xml).toMatchObject({ estado: "disponible", origen: "subido" });

    const r = await masiva(c, [{ compraId: b, versionBase: 1 }], P2);
    expect(r.status, r.text).toBe(200);
    const ultima = (await v.versiones(b)).at(-1)!;
    const aplicado = ultima.n === 2 ? ultima.biDg : null;
    expect(
      [null, "8.95"],
      "o se rechaza, o se aplica el gravado del XML vigente (8.95); nunca el de un XML reemplazado",
    ).toContain(aplicado);
  });
});

describe("T21 · caja blanca · XML de una compra descartada y vuelta a agregar desde otro XML (HU-18, P-6, CA-13)", () => {
  it("C4 · re-agregar el comprobante con otro XML: o 409 xml_existente, o la compra queda con SU XML (nunca montos de un XML que no se guardó)", async () => {
    const c = await nuevoCliente();
    const alta = (xml: string) => pedirXml(v, contador, "POST", `${base(c.id)}/desde-xml?destino=DG`, bytes(xml));
    const r1 = await alta(xmlDe("2056", c.ruc));
    expect(r1.status, r1.texto).toBe(201);
    const d = await post(contador, c, r1.json.id, "/descartar", { versionBase: 1 });
    expect(d.status, d.text).toBe(200);

    const segundo = variante(xmlDe("2056", c.ruc));
    const r2 = await alta(segundo);
    if (r2.status === 409) {
      expect(r2.json).toEqual({ codigo: "xml_existente" });
      return;
    }
    expect(r2.status, r2.texto).toBe(201);
    expect(r2.json.montos).toMatchObject({ biDg: "8.95", noGravado: "12.53" });
    const vigente = (await documentosXml(v, c.id)).at(-1)!;
    expect(
      vigente.sha256,
      "la compra creada con los montos del segundo XML debe tener ese XML como vigente (la lupa compara contra él)",
    ).toBe(sha256Hex(bytes(segundo)));
  });
});
