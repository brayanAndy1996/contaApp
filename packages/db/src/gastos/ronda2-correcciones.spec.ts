// Spec 027 · T19 (rojo; H-027-2-1, decisión del usuario 2026-11-23): agregar una propia en la OTRA forma (+s / +es) de una palabra GLOBAL
// activa es un duplicado: CA420 (409 `palabra_existente` en HTTP), como ya lo es con otra propia (T16/T17) y como `aprender` la manda a
// `omitidas`. Una global DESACTIVADA por el estudio no bloquea (el estudio puede tener la suya, coherente con T16). La MISMA forma de una global
// sigue siendo válida y la reemplaza (plan: «una propia con la misma palabra que una global la reemplaza»; `diccionario.int.spec.ts`): no cambia.
// Rojo hoy: `gnd_palabra_agregar` (0071) solo compara con las propias del estudio; lo corrige T20 en la migración 0072. Necesita DATABASE_URL y
// MIGRATIONS_DATABASE_URL: si faltan, FALLA (no se salta).
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

describe("agregarPalabra · la otra forma de una global activa es un duplicado (T19, H-027-2-1)", () => {
  it.each([
    ["zapatilla", "zapatillas"],
    ["zapato", "zapatos"],
    ["jean", "jeans"],
    ["pantalon", "pantalones"],
    ["ron", "rones"],
    ["cine", "cines"],
    ["lego", "legos"],
    ["perfume", "perfumes"],
  ])("global «%s»: agregar «%s» -> CA420 y no guarda ni audita nada", async (_global, otra) => {
    const e = await h.nuevoEstudio();
    const auditoriasAntes = await auditorias(e);
    expect((await falla(agregar(otra, e))).codigo).toBe("CA420");
    expect(await propias(e)).toEqual([]);
    expect(await auditorias(e)).toBe(auditoriasAntes);
  });

  it("la desactiva el estudio: ya no cuenta y la otra forma se agrega; la global de OTRO estudio sigue bloqueando", async () => {
    const e = await h.nuevoEstudio();
    const otro = await h.nuevoEstudio();
    await desactivarGlobalDelEstudio(h.admin, e, await idGlobal(h.admin, "zapatilla"));
    await expect(agregar("zapatillas", e)).resolves.toMatch(UUID);
    expect(await propias(e)).toEqual(["zapatillas"]);
    expect((await falla(agregar("zapatillas", otro))).codigo).toBe("CA420");
  });

  it("sin raíces ni prefijos (D-8): «perfum», «polonia» y «chocolat» no son la otra forma de una global y se agregan", async () => {
    const e = await h.nuevoEstudio();
    for (const palabra of ["perfum", "polonia", "chocolat"]) await expect(agregar(palabra, e)).resolves.toMatch(UUID);
    expect((await propias(e)).sort()).toEqual(["chocolat", "perfum", "polonia"]);
  });

  it("regresión: la MISMA forma de una global sigue siendo válida (la reemplaza para el estudio) y una propia en otra forma de otra propia sigue siendo CA420", async () => {
    const e = await h.nuevoEstudio();
    await expect(agregar("zapatilla", e)).resolves.toMatch(UUID);
    await sembrarPropia(h.admin, e, { palabra: "audifonos" });
    expect((await falla(agregar("audifono", e))).codigo).toBe("CA420");
  });

  it("el rechazo por global no consume el límite ni la versión: tras el CA420 el estudio sigue agregando", async () => {
    const e = await h.nuevoEstudio();
    expect((await falla(agregar("zapatillas", e))).codigo).toBe("CA420");
    await expect(agregar("alfombra", e)).resolves.toMatch(UUID);
    expect(await propias(e)).toEqual(["alfombra"]);
  });
});
