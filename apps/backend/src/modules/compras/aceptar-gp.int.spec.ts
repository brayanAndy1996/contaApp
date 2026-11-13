// Spec 021 (defecto previo de 014/016): aceptar la sugerencia R-GP de una compra con XML subido. R-GP siempre pide confirmación y
// exige XML (011, CA-12); aceptar re-evalúa la fila (CA-9 de 011) y la fila de esa re-evaluación no llevaba el XML, así que
// respondía siempre 409 `revisar_de_nuevo`. Contrato:
//  - zapatilla F001-5070 con su XML subido y R-GP encendida: `POST …/sugerencias/aceptar {versionBase, regla: "R-GP", confirmar: true}`
//    -> 200, versión 2 excluida con los montos intactos;
//  - sin XML no hay hallazgo R-GP: 409 `revisar_de_nuevo`, sin escribir;
//  - si el XML vigente cambió desde la evaluación (ya no trae la palabra), el hallazgo guardado es obsoleto: 409 `revisar_de_nuevo`;
//  - sin `confirmar`: 422/409 de siempre (`requiere_confirmacion`), sin escribir;
//  - la masiva de aceptar no admite R-GP (pide confirmación, DU-6): se rechaza como `no_masiva` sin escribir.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBancoReglas, base, type Actor, type BancoReglas, type Estudio } from "../../../test/soporte-reglas.js";
import { bytes, pedirXml, prepararStorage, xmlDe, type StoragePrueba } from "../../../test/soporte-xml.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let st: StoragePrueba;
let v: BancoReglas;
let E: Estudio;
let contador: Actor;

beforeAll(async () => {
  st = prepararStorage();
  v = await abrirBancoReglas();
  E = await v.estudio();
  contador = await v.b.c.p.b.miembro(E.tenantId, "contador");
});
afterAll(async () => {
  await v?.cerrar();
  st?.restaurar();
});

type Cliente = { id: string; ruc: string };
const post = (c: Cliente, ruta: string, cuerpo: unknown) => v.llamar(contador, "POST", `${base(c.id)}${ruta}`, cuerpo);
const aceptarGp = (c: Cliente, id: string, o: Record<string, unknown> = {}) =>
  post(c, `/${id}/sugerencias/aceptar`, { versionBase: 1, regla: "R-GP", confirmar: true, ...o });

/** La zapatilla F001-5070 del fixture, con o sin su XML subido. */
async function zapatilla(conXml: boolean): Promise<{ c: Cliente; id: string }> {
  const c = await v.cliente(E, { responsable: contador.id });
  const ids = await v.sembrarFixture(E.tenantId, c.id, { usuarioId: E.titular.id });
  const id = ids["F001-5070"]!;
  if (conXml) {
    const r = await pedirXml(v, contador, "POST", `${base(c.id)}/${id}/xml`, bytes(xmlDe("5070", c.ruc)));
    expect(r.status, r.texto).toBe(200);
  }
  return { c, id };
}

describe("aceptar R-GP con XML (defecto previo de 014/016)", () => {
  it("con el XML subido: 200, versión 2 excluida y los montos intactos", async () => {
    const { c, id } = await zapatilla(true);
    expect((await v.hallazgosDe(id, 1)).map((h) => h.regla)).toContain("R-GP"); // control: el XML dejó el hallazgo guardado
    const antes = (await v.versiones(id))[0]!;
    const r = await aceptarGp(c, id);
    expect(r.status, r.text).toBe(200);
    expect(r.body.fila).toMatchObject({ id, version: 2, excluida: true });
    const vs = await v.versiones(id);
    expect(vs.map((x) => x.n)).toEqual([1, 2]);
    expect(vs[1]).toMatchObject({ accion: "sugerencia", excluida: true, biDg: antes.biDg, igvDg: antes.igvDg, total: antes.total });
  });

  it("sin XML no hay R-GP que aceptar: 409 revisar_de_nuevo y no escribe", async () => {
    const { c, id } = await zapatilla(false);
    const antes = await v.foto(c.id);
    const r = await aceptarGp(c, id);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "revisar_de_nuevo" });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("si el XML vigente cambió y ya no trae la palabra: hallazgo obsoleto, 409 revisar_de_nuevo y no escribe", async () => {
    const { c, id } = await zapatilla(true);
    await v.b.sql(
      "update documento_xml set detalle = replace(detalle::text, 'zapatilla', 'servicio')::jsonb where cliente_id = $1",
      [c.id],
    );
    const antes = await v.foto(c.id);
    const r = await aceptarGp(c, id);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "revisar_de_nuevo" });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("sin confirmar sigue pidiendo confirmación y no escribe", async () => {
    const { c, id } = await zapatilla(true);
    const antes = await v.foto(c.id);
    const r = await aceptarGp(c, id, { confirmar: false });
    expect(r.status, r.text).not.toBe(200);
    expect(r.body).toEqual({ codigo: "requiere_confirmacion" });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("la masiva de aceptar no admite R-GP (pide confirmación): rechazada sin escribir", async () => {
    const { c, id } = await zapatilla(true);
    const antes = await v.foto(c.id);
    const r = await post(c, "/masivas/aceptar", { items: [{ compraId: id, versionBase: 1 }], regla: "R-GP" });
    expect(r.status, r.text).toBe(200);
    expect(r.body.aplicadas).toBe(0);
    expect(r.body.rechazadas).toEqual([{ compraId: id, codigo: "no_masiva" }]);
    expect(await v.foto(c.id)).toEqual(antes);
  });
});
