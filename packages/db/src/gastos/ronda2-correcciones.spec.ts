// Spec 027 · T19 (H-027-2-1, aclaración del usuario 2026-11-23, «ambas reemplazan»): agregar como propia la MISMA forma o la OTRA forma (+s / +es)
// de una palabra GLOBAL activa se acepta y la propia reemplaza a la global en el estudio (el reemplazo efectivo lo prueban el dominio y
// `apps/backend/src/modules/gastos/ronda2.correcciones.int.spec.ts`). Sigue siendo CA420 la otra forma de otra PROPIA (activa o desactivada, T16/T17).
// Una global desactivada por el estudio: sin cambios. Estas pruebas pasan hoy (`gnd_palabra_agregar` solo compara con las propias): fijan que T20
// NO añada una comparación con las globales. Necesita DATABASE_URL y MIGRATIONS_DATABASE_URL: si faltan, FALLA (no se salta).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agregarPalabra, leerGastosEstudio } from "./index";
import { UUID, abrirArnes, desactivarGlobalDelEstudio, falla, idGlobal, sembrarPropia, type Arnes } from "./soporte-prueba";

let h: Arnes;

beforeAll(async () => {
  h = await abrirArnes();
}, 60_000);

afterAll(async () => {
  await h?.cerrar();
});

const agregar = (palabra: string, e = h.A, categoria = "entretenimiento") =>
  h.comoDueno((tx) => agregarPalabra(tx, { palabra, categoria }), e);
const propias = async (e = h.A): Promise<string[]> => (await h.comoDueno((tx) => leerGastosEstudio(tx), e)).propias.map((p) => p.palabra);
const auditorias = async (e = h.A): Promise<number> =>
  Number((await h.admin.query("select count(*)::int as n from auditoria where tenant_id = $1 and accion = 'gnd.palabra_agregada'", [e.tenantId])).rows[0].n);

describe("agregarPalabra · la propia reemplaza a la global en cualquiera de sus formas (T19, H-027-2-1)", () => {
  it.each([
    ["zapatilla", "zapatillas"],
    ["zapato", "zapatos"],
    ["jean", "jeans"],
    ["pantalon", "pantalones"],
    ["ron", "rones"],
    ["cine", "cines"],
    ["lego", "legos"],
    ["perfume", "perfumes"],
    ["zapatilla", "zapatilla"],
  ])("global «%s»: agregar «%s» se acepta y queda como propia", async (_global, otra) => {
    const e = await h.nuevoEstudio();
    await expect(agregar(otra, e)).resolves.toMatch(UUID);
    expect(await propias(e)).toEqual([otra]);
    expect(await auditorias(e)).toBe(1);
  });

  it("con la global desactivada por el estudio, la otra forma se agrega igual (sin cambios)", async () => {
    const e = await h.nuevoEstudio();
    await desactivarGlobalDelEstudio(h.admin, e, await idGlobal(h.admin, "zapatilla"));
    await expect(agregar("zapatillas", e)).resolves.toMatch(UUID);
    expect(await propias(e)).toEqual(["zapatillas"]);
  });

  it("sin raíces ni prefijos (D-8): «perfum», «polonia» y «chocolat» se agregan", async () => {
    const e = await h.nuevoEstudio();
    for (const palabra of ["perfum", "polonia", "chocolat"]) await expect(agregar(palabra, e)).resolves.toMatch(UUID);
    expect((await propias(e)).sort()).toEqual(["chocolat", "perfum", "polonia"]);
  });

  it("regresión: la otra forma de otra PROPIA (activa o desactivada) sigue siendo CA420, aunque exista también la global", async () => {
    const e = await h.nuevoEstudio();
    await sembrarPropia(h.admin, e, { palabra: "audifonos" });
    await sembrarPropia(h.admin, e, { palabra: "zapatillas", activa: false });
    expect((await falla(agregar("audifono", e))).codigo).toBe("CA420");
    expect((await falla(agregar("zapatilla", e))).codigo).toBe("CA420");
    expect((await propias(e)).sort()).toEqual(["audifonos", "zapatillas"]);
  });
});
