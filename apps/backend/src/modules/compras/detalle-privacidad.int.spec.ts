// Spec 016 (T13): la respuesta del detalle y de obtener no deja salir la ruta de storage, el hash ni el tenant, aunque la lectura
// de `packages/db` los traiga (`leerDetalleXml().xml` incluye `ruta` y `sha256`). El XML se siembra por SQL (la subida es de T14).
import { randomUUID } from "node:crypto";
import { leerUbl } from "@contapp/domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBancoCompras, base, type Actor, type BancoCompras, type Estudio } from "../../../test/soporte-compras.js";
import { bytes, detalleLupaSchema, prepararStorage, xmlDe, type StoragePrueba } from "../../../test/soporte-xml.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let st: StoragePrueba;
let v: BancoCompras;
let E: Estudio;
let contador: Actor;

beforeAll(async () => {
  st = prepararStorage();
  v = await abrirBancoCompras();
  E = await v.estudio();
  contador = await v.b.c.p.b.miembro(E.tenantId, "contador");
});
afterAll(async () => {
  await v?.cerrar();
  st?.restaurar();
});

describe("CA-17 · el detalle no filtra la ruta de storage, el hash ni el tenant", () => {
  it("con un XML guardado, el cuerpo cumple detalleLupaSchema y no contiene ruta, sha256 ni tenantId", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    const ids = await v.sembrarFixture(E.tenantId, c.id, { usuarioId: E.titular.id });
    const ruta = `xml/${E.tenantId}/${c.id}/${randomUUID()}.xml`;
    const hash = "ab".repeat(32);
    const detalle = leerUbl(bytes(xmlDe("2056", c.ruc)));
    await v.b.sql(
      `insert into documento_xml (tenant_id, cliente_id, ruc_emisor, tipo, serie, numero, n, origen, ruta, sha256, tamano, detalle, subido_por)
       values ($1, $2, '20700000045', '01', 'F001', '2056', 1, 'subido', $3, decode($4, 'hex'), 100, $5::jsonb, $6)`,
      [E.tenantId, c.id, ruta, hash, JSON.stringify(detalle), contador.id],
    );
    const r = await v.llamar(contador, "GET", `${base(c.id)}/${ids["F001-2056"]}/detalle`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.xml).toMatchObject({ estado: "disponible", origen: "subido" });
    expect(detalleLupaSchema.safeParse(r.body).success).toBe(true);
    for (const prohibido of [E.tenantId, ruta, hash, "sha256", "tenantId", "ruta", "storage"]) {
      expect(r.text, prohibido).not.toContain(prohibido);
    }
    expect(Object.keys(r.body.xml).sort()).toEqual(["estado", "origen", "subidoEn", "subidoPor"]);
  });
});
