// Spec 027 (T4, rojo): repositorio de la caché de CIIU por estudio (R-14, CA-16). Contra la BD real con el backend (lectura) y el worker
// (escritura), más una `tx` falsa para la traducción de errores. Necesita DATABASE_URL y MIGRATIONS_DATABASE_URL: si faltan, FALLA
// (no se salta). El reloj es el de la BD: la siembra fija `consultado_en` como `clock_timestamp() - intervalo`, de modo que las
// pruebas no dependen del reloj de Node.
//
// CONTRATO que fijan estas pruebas (lo implementa T10 en `packages/db/src/gastos/ciiu.ts`):
//   ciiuPendientes(tx, rucs) -> string[]   los RUC (sin repetir, en su orden de entrada) que no tienen fila en `gnd_ciiu` del estudio o
//       cuyo `consultado_en` tiene más de 30 días respecto de `clock_timestamp()`. Una fila con `ciiu` null («sin dato») también
//       dura 30 días. Lista vacía -> []. La leen backend y worker (la usa el worker).
//   guardarCiiu(tx, entradas: {ruc, ciiu | null}[]) -> número de entradas guardadas   `gnd_ciiu_guardar` (solo el worker): hasta 50;
//       inserta o actualiza `ciiu` y `consultado_en = clock_timestamp()`; no escribe ninguna otra tabla.
//   Errores (GastosRepoError.codigo): 22023 (más de 50 entradas, RUC que no son 11 dígitos, CIIU que no son 4 dígitos ni null),
//       42501 (el backend no puede escribir; sin estudio).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ciiuPendientes, guardarCiiu } from "./index";
import {
  abrirArnes,
  falla,
  pruebasTraduccion,
  sembrarCiiu,
  sembrarPropia,
  type Arnes,
  type Estudio,
} from "./soporte-prueba";

let h: Arnes;

beforeAll(async () => {
  h = await abrirArnes();
}, 60_000);

afterAll(async () => {
  await h?.cerrar();
});

let n = 0;
/** RUC sintético único por llamada (11 dígitos). */
const ruc = (): string => `20${String(900_000_000 + ++n)}`;

const pendientes = (rucs: string[], e: Estudio = h.A) =>
  h.comoWorker((tx) => ciiuPendientes(tx, rucs), e);

const guardar = (
  entradas: Array<{ ruc: string; ciiu: string | null }>,
  e: Estudio = h.A,
) => h.comoWorker((tx) => guardarCiiu(tx, entradas), e);

const fila = async (e: Estudio, r: string) =>
  (
    await h.admin.query(
      `select ciiu, (consultado_en > clock_timestamp() - interval '1 minute') as reciente from gnd_ciiu where tenant_id = $1 and ruc = $2`,
      [e.tenantId, r],
    )
  ).rows[0] as { ciiu: string | null; reciente: boolean } | undefined;

describe("ciiuPendientes (R-14, CA-16)", () => {
  it("sin fila en la caché: pendiente", async () => {
    const r = ruc();
    expect(await pendientes([r])).toEqual([r]);
  });

  it("a 29 días: vigente (no pendiente); a 31 días: pendiente", async () => {
    const e = await h.nuevoEstudio();
    const [vigente, vencido, reciente] = [ruc(), ruc(), ruc()];
    await sembrarCiiu(h.admin, e, vigente, "4771", "29 days");
    await sembrarCiiu(h.admin, e, vencido, "4771", "31 days");
    await sembrarCiiu(h.admin, e, reciente, "4752", "1 minute");
    expect(await pendientes([vigente, vencido, reciente], e)).toEqual([
      vencido,
    ]);
  });

  it("«sin dato» (ciiu null) también dura 30 días", async () => {
    const e = await h.nuevoEstudio();
    const [vigente, vencido] = [ruc(), ruc()];
    await sembrarCiiu(h.admin, e, vigente, null, "29 days");
    await sembrarCiiu(h.admin, e, vencido, null, "31 days");
    expect(await pendientes([vigente, vencido], e)).toEqual([vencido]);
  });

  it("conserva el orden de entrada y no repite", async () => {
    const e = await h.nuevoEstudio();
    const [a, b, c, d] = [ruc(), ruc(), ruc(), ruc()];
    await sembrarCiiu(h.admin, e, b, "4752");
    expect(await pendientes([d, a, b, a, c, d], e)).toEqual([d, a, c]);
  });

  it("lista vacía -> []", async () => {
    expect(await pendientes([])).toEqual([]);
  });

  it("la caché es por estudio: lo vigente en otro estudio no cuenta", async () => {
    const e = await h.nuevoEstudio();
    const r = ruc();
    await sembrarCiiu(h.admin, h.B, r, "4771"); // vigente en B
    expect(await pendientes([r], e)).toEqual([r]);
    expect(await pendientes([r], h.B)).toEqual([]);
  });

  it("también la puede leer el backend (con usuario)", async () => {
    const e = await h.nuevoEstudio();
    const [a, b] = [ruc(), ruc()];
    await sembrarCiiu(h.admin, e, a, "4771");
    expect(await h.comoDueno((tx) => ciiuPendientes(tx, [a, b]), e)).toEqual([
      b,
    ]);
  });
});

describe("guardarCiiu (R-14, CA-16)", () => {
  it("inserta y deja de estar pendiente; devuelve cuántas guardó", async () => {
    const e = await h.nuevoEstudio();
    const [a, b] = [ruc(), ruc()];
    expect(
      await guardar(
        [
          { ruc: a, ciiu: "4771" },
          { ruc: b, ciiu: null },
        ],
        e,
      ),
    ).toBe(2);
    expect((await fila(e, a))!.ciiu).toBe("4771");
    expect((await fila(e, b))!.ciiu).toBeNull();
    expect(await pendientes([a, b], e)).toEqual([]);
  });

  it("actualiza la clase y renueva `consultado_en` (reloj de la BD)", async () => {
    const e = await h.nuevoEstudio();
    const r = ruc();
    await sembrarCiiu(h.admin, e, r, "4771", "31 days");
    expect(await pendientes([r], e)).toEqual([r]);
    expect(await guardar([{ ruc: r, ciiu: "5610" }], e)).toBe(1);
    const f = (await fila(e, r))!;
    expect(f.ciiu).toBe("5610");
    expect(f.reciente).toBe(true); // recién consultado
    expect(await pendientes([r], e)).toEqual([]);
    const total = await h.admin.query(
      "select count(*)::int as n from gnd_ciiu where tenant_id = $1 and ruc = $2",
      [e.tenantId, r],
    );
    expect(total.rows[0].n).toBe(1); // actualizó, no duplicó
  });

  it("un «sin dato» posterior reemplaza una clase anterior", async () => {
    const e = await h.nuevoEstudio();
    const r = ruc();
    await guardar([{ ruc: r, ciiu: "4771" }], e);
    await guardar([{ ruc: r, ciiu: null }], e);
    expect((await fila(e, r))!.ciiu).toBeNull();
  });

  it("acepta 50 entradas y 0 entradas", async () => {
    const e = await h.nuevoEstudio();
    const entradas = Array.from({ length: 50 }, (_, i) => ({
      ruc: `2070000${String(i).padStart(4, "0")}`,
      ciiu: "4752",
    }));
    expect(await guardar(entradas, e)).toBe(50);
    expect(await guardar([], e)).toBe(0);
  });

  it("51 entradas -> 22023 y no guarda ninguna", async () => {
    const e = await h.nuevoEstudio();
    const entradas = Array.from({ length: 51 }, (_, i) => ({
      ruc: `2060000${String(i).padStart(4, "0")}`,
      ciiu: "4752",
    }));
    expect((await falla(guardar(entradas, e))).codigo).toBe("22023");
    const total = await h.admin.query(
      "select count(*)::int as n from gnd_ciiu where tenant_id = $1",
      [e.tenantId],
    );
    expect(total.rows[0].n).toBe(0);
  });

  it.each([
    ["RUC de 10 dígitos", { ruc: "2010007097", ciiu: "4771" }],
    ["RUC de 12 dígitos", { ruc: "201000709701", ciiu: "4771" }],
    ["RUC con letras", { ruc: "2010007097A", ciiu: "4771" }],
    ["RUC vacío", { ruc: "", ciiu: "4771" }],
    ["CIIU de 3 dígitos", { ruc: "20100070970", ciiu: "477" }],
    ["CIIU de 5 dígitos", { ruc: "20100070970", ciiu: "47711" }],
    ["CIIU con letra", { ruc: "20100070970", ciiu: "47A1" }],
    ["CIIU vacío", { ruc: "20100070970", ciiu: "" }],
  ])(
    "%s -> 22023 y no guarda ni las entradas válidas del mismo lote",
    async (_n, mala) => {
      const e = await h.nuevoEstudio();
      const buena = { ruc: ruc(), ciiu: "4752" };
      expect(
        (
          await falla(
            guardar([buena, mala as { ruc: string; ciiu: string | null }], e),
          )
        ).codigo,
      ).toBe("22023");
      const total = await h.admin.query(
        "select count(*)::int as n from gnd_ciiu where tenant_id = $1",
        [e.tenantId],
      );
      expect(total.rows[0].n).toBe(0);
    },
  );

  it("el backend no puede escribir la caché -> 42501", async () => {
    const e = await h.nuevoEstudio();
    const r = await falla(
      h.comoDueno((tx) => guardarCiiu(tx, [{ ruc: ruc(), ciiu: "4771" }]), e),
    );
    expect(r.codigo).toBe("42501");
  });

  it("escribe en el estudio de la sesión: el otro estudio no cambia", async () => {
    const e = await h.nuevoEstudio();
    const r = ruc();
    await guardar([{ ruc: r, ciiu: "4771" }], e);
    expect(await fila(h.B, r)).toBeUndefined();
    expect(await pendientes([r], h.B)).toEqual([r]);
  });

  it("no toca otras tablas del estudio (diccionario propio, umbral, categorías)", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    await sembrarPropia(h.admin, e, { palabra: "intacta" });
    const contar = async () =>
      (
        await h.admin.query(
          `select (select count(*) from gnd_palabra_estudio where tenant_id = $1)::int as propias,
                  (select count(*) from gnd_config where tenant_id = $1)::int as config,
                  (select count(*) from gnd_cliente_categorias where tenant_id = $1)::int as categorias,
                  (select count(*) from gnd_global_desactivada where tenant_id = $1)::int as desactivadas,
                  (select count(*) from compra where tenant_id = $1)::int as compras,
                  (select count(*) from cliente where tenant_id = $1 and id = $2)::int as clientes`,
          [e.tenantId, c.id],
        )
      ).rows[0];
    const antes = await contar();
    await guardar([{ ruc: ruc(), ciiu: "4771" }], e);
    expect(await contar()).toEqual(antes);
  });
});

pruebasTraduccion([
  ["ciiuPendientes", (tx) => ciiuPendientes(tx, ["20100070970"])],
  [
    "guardarCiiu",
    (tx) => guardarCiiu(tx, [{ ruc: "20100070970", ciiu: "4771" }]),
  ],
]);
