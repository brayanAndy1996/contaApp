import type { ContappDb } from "@contapp/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConsultaRucCiiu,
  ciiuDe,
  exigirImplementado027,
  limpiarGastos,
  sembrarCiiu,
  type RespuestaCiiu,
} from "../../../test/gastos.js";
import { espiarSentencias } from "../../../test/prorrata.js";
import { canario, Escenario, crearDbAdmin, crearDbRol, dbEspiada } from "../../../test/trabajos.js";
import { asegurarCiiu } from "./ciiu.js";

// Spec 027, T5 (rojo; integración con PostgreSQL real): el CIIU del proveedor y del cliente al llegar el XML (R-14; CA-16).
//
// CONTRATO que fija (T11): `asegurarCiiu({ db, consultaRuc }, { tenantId }, rucs)` lee los RUC pendientes de la caché del estudio
// (`ciiuPendientes`: sin fila o con más de 30 días), consulta cada uno SIN transacción abierta (008 D6) por el puerto `ConsultaRuc` y
// guarda lo obtenido con `gnd_ciiu_guardar` en una transacción corta (nunca con DML directo). `ErrorDatos` guarda «sin dato»
// (`ciiu` null, 30 días); `ErrorTransitorio` y cualquier otro fallo no guardan nada. NUNCA lanza.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const RUC_PROVEEDOR = "20700000070";
const RUC_CLIENTE = "20700000002";

let admin: ContappDb;
let dbWorker: ContappDb;
let e: Escenario;

beforeAll(async () => {
  admin = crearDbAdmin();
  dbWorker = crearDbRol("contapp_worker", 4);
  e = new Escenario(admin);
  await exigirImplementado027(admin);
});

afterAll(async () => {
  await limpiarGastos(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  await Promise.all([dbWorker?.close(), admin?.close()]);
});

/** Un `asegurarCiiu` con la BD del worker espiada (transacciones abiertas) y una `ConsultaRuc` que anota las llamadas. */
function armar(respuestas: Record<string, RespuestaCiiu>, porDefecto: RespuestaCiiu = "datos") {
  const consulta = new ConsultaRucCiiu(respuestas, porDefecto);
  const espiada = dbEspiada(dbWorker, { muerto: false });
  consulta.contarTx = () => espiada.estado.abiertas;
  const deps = { db: espiada.db, consultaRuc: consulta };
  return { consulta, deps, espiada };
}

let T: string;
beforeEach(async () => {
  T = await e.estudio();
});

describe("CA-16: consulta lo que falta y lo guarda en la caché del estudio", () => {
  it("sin caché consulta el proveedor y el cliente fuera de toda transacción y guarda sus clases", async () => {
    const { consulta, deps } = armar({ [RUC_PROVEEDOR]: "4771", [RUC_CLIENTE]: "4752" });
    await asegurarCiiu(deps, { tenantId: T }, [RUC_PROVEEDOR, RUC_CLIENTE]);

    expect([...consulta.rucs].sort()).toEqual([RUC_CLIENTE, RUC_PROVEEDOR]);
    expect(consulta.llamadas.map((l) => l.en), "ninguna consulta dentro de una transacción").toEqual([0, 0]);
    const filas = await ciiuDe(admin, T);
    expect(filas.map((f) => [f.ruc, f.ciiu])).toEqual([
      [RUC_CLIENTE, "4752"],
      [RUC_PROVEEDOR, "4771"],
    ]);
    expect(filas.every((f) => f.antiguedad < 60)).toBe(true);
  });

  it("un RUC repetido en la lista se consulta una sola vez", async () => {
    const { consulta, deps } = armar({ [RUC_PROVEEDOR]: "4771" });
    await asegurarCiiu(deps, { tenantId: T }, [RUC_PROVEEDOR, RUC_PROVEEDOR]);
    expect(consulta.rucs).toEqual([RUC_PROVEEDOR]);
    expect((await ciiuDe(admin, T)).map((f) => f.ruc)).toEqual([RUC_PROVEEDOR]);
  });

  it("sin nada que pedir no consulta nada y no lanza", async () => {
    const { consulta, deps } = armar({});
    await expect(asegurarCiiu(deps, { tenantId: T }, [])).resolves.toBeUndefined();
    expect(consulta.rucs).toEqual([]);
    expect(await ciiuDe(admin, T)).toEqual([]);
  });

  it("dentro de 30 días no vuelve a consultar (29 días: caché vigente) y no toca la fila", async () => {
    await sembrarCiiu(admin, T, RUC_PROVEEDOR, "4771", 29);
    await sembrarCiiu(admin, T, RUC_CLIENTE, "4752", 29);
    const { consulta, deps } = armar({ [RUC_PROVEEDOR]: "9999", [RUC_CLIENTE]: "9999" });
    await asegurarCiiu(deps, { tenantId: T }, [RUC_PROVEEDOR, RUC_CLIENTE]);

    expect(consulta.rucs).toEqual([]);
    const filas = await ciiuDe(admin, T);
    expect(filas.map((f) => f.ciiu)).toEqual(["4752", "4771"]);
    expect(filas.every((f) => f.antiguedad > 28 * 86_400)).toBe(true);
  });

  it("después de 30 días (31) consulta de nuevo solo lo vencido y renueva la fila", async () => {
    await sembrarCiiu(admin, T, RUC_PROVEEDOR, "4771", 31);
    await sembrarCiiu(admin, T, RUC_CLIENTE, "4752", 29);
    const { consulta, deps } = armar({ [RUC_PROVEEDOR]: "4772", [RUC_CLIENTE]: "9999" });
    await asegurarCiiu(deps, { tenantId: T }, [RUC_PROVEEDOR, RUC_CLIENTE]);

    expect(consulta.rucs).toEqual([RUC_PROVEEDOR]);
    const filas = new Map((await ciiuDe(admin, T)).map((f) => [f.ruc, f]));
    expect(filas.get(RUC_PROVEEDOR)).toMatchObject({ ciiu: "4772" });
    expect(filas.get(RUC_PROVEEDOR)!.antiguedad).toBeLessThan(60);
    expect(filas.get(RUC_CLIENTE)).toMatchObject({ ciiu: "4752" });
  });

  it("«sin dato» también es caché: un null vigente no se vuelve a consultar y uno de 31 días sí", async () => {
    await sembrarCiiu(admin, T, RUC_PROVEEDOR, null, 5);
    await sembrarCiiu(admin, T, RUC_CLIENTE, null, 31);
    const { consulta, deps } = armar({ [RUC_PROVEEDOR]: "4771", [RUC_CLIENTE]: "4752" });
    await asegurarCiiu(deps, { tenantId: T }, [RUC_PROVEEDOR, RUC_CLIENTE]);

    expect(consulta.rucs).toEqual([RUC_CLIENTE]);
    const filas = new Map((await ciiuDe(admin, T)).map((f) => [f.ruc, f.ciiu]));
    expect(filas.get(RUC_PROVEEDOR)).toBeNull();
    expect(filas.get(RUC_CLIENTE)).toBe("4752");
  });

  it("otro estudio consulta por su cuenta aunque el primero ya tenga la caché", async () => {
    const otro = await e.estudio();
    await sembrarCiiu(admin, T, RUC_PROVEEDOR, "4771", 1);
    const { consulta, deps } = armar({ [RUC_PROVEEDOR]: "4772" });
    await asegurarCiiu(deps, { tenantId: otro }, [RUC_PROVEEDOR]);

    expect(consulta.rucs).toEqual([RUC_PROVEEDOR]);
    expect((await ciiuDe(admin, otro)).map((f) => [f.ruc, f.ciiu])).toEqual([[RUC_PROVEEDOR, "4772"]]);
    expect((await ciiuDe(admin, T)).map((f) => f.ciiu), "la caché del primero no cambia").toEqual(["4771"]);
  });
});

describe("CA-16: los fallos no fallan el trabajo del XML", () => {
  it("ErrorDatos guarda «sin dato» y no se vuelve a consultar dentro de 30 días", async () => {
    const { consulta, deps } = armar({ [RUC_PROVEEDOR]: "datos" });
    await asegurarCiiu(deps, { tenantId: T }, [RUC_PROVEEDOR]);
    expect(consulta.rucs).toEqual([RUC_PROVEEDOR]);
    expect((await ciiuDe(admin, T)).map((f) => [f.ruc, f.ciiu])).toEqual([[RUC_PROVEEDOR, null]]);

    await asegurarCiiu(deps, { tenantId: T }, [RUC_PROVEEDOR]);
    expect(consulta.rucs, "la segunda vez sale de la caché").toEqual([RUC_PROVEEDOR]);
  });

  it("ErrorTransitorio no lanza ni guarda nada: la siguiente vez consulta de nuevo", async () => {
    const { consulta, deps } = armar({ [RUC_PROVEEDOR]: "transitorio" });
    await expect(asegurarCiiu(deps, { tenantId: T }, [RUC_PROVEEDOR])).resolves.toBeUndefined();
    expect(await ciiuDe(admin, T)).toEqual([]);

    consulta.responder(RUC_PROVEEDOR, "4771");
    await asegurarCiiu(deps, { tenantId: T }, [RUC_PROVEEDOR]);
    expect(consulta.rucs).toEqual([RUC_PROVEEDOR, RUC_PROVEEDOR]);
    expect((await ciiuDe(admin, T)).map((f) => f.ciiu)).toEqual(["4771"]);
  });

  it("un RUC que falla no impide guardar el otro", async () => {
    const { deps } = armar({ [RUC_PROVEEDOR]: "transitorio", [RUC_CLIENTE]: "4752" });
    await expect(asegurarCiiu(deps, { tenantId: T }, [RUC_PROVEEDOR, RUC_CLIENTE])).resolves.toBeUndefined();
    expect((await ciiuDe(admin, T)).map((f) => [f.ruc, f.ciiu])).toEqual([[RUC_CLIENTE, "4752"]]);
  });

  it("un error inesperado del puerto (con un canario en el mensaje) no lanza y no guarda nada", async () => {
    const secreto = canario("ciiu");
    const espiada = dbEspiada(dbWorker, { muerto: false });
    const deps = {
      db: espiada.db,
      consultaRuc: {
        consultar: async () => {
          throw new Error(secreto);
        },
      },
    };
    const resultado = await asegurarCiiu(deps, { tenantId: T }, [RUC_PROVEEDOR]).then(
      () => "ok",
      (error: Error) => `lanzó: ${error.message}`,
    );
    expect(resultado).toBe("ok");
    expect(await ciiuDe(admin, T)).toEqual([]);
  });
});

describe("CA-16: la caché solo se escribe por la función acotada y en una transacción corta", () => {
  it("guarda con gnd_ciiu_guardar (sin INSERT/UPDATE/DELETE directo) y ninguna consulta ocurre dentro de la transacción", async () => {
    const { consulta, deps } = armar({ [RUC_PROVEEDOR]: "4771", [RUC_CLIENTE]: "4752" });
    const espia = espiarSentencias((dbWorker as unknown as { pool: unknown }).pool);
    try {
      await asegurarCiiu(deps, { tenantId: T }, [RUC_PROVEEDOR, RUC_CLIENTE]);
    } finally {
      espia.restaurar();
    }
    const textos = espia.sentencias.map((s) => s.texto);
    expect(textos.some((t) => /gnd_ciiu_guardar/i.test(t)), "guarda con la función acotada").toBe(true);
    expect(textos.filter((t) => /\b(insert\s+into|update|delete\s+from)\s+"?(public"?\."?)?gnd_/i.test(t))).toEqual([]);
    expect(consulta.llamadas.every((l) => l.en === 0)).toBe(true);
  });
});
