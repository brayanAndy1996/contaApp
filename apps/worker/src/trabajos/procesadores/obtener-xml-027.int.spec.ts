import type { ContappDb } from "@contapp/db";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RUC_FIXTURE,
  filaCompra,
  comprasDe,
  encolarDescarga,
  limpiarCompras,
  mundoVentas,
  sembrarCompra,
  volcarTablasCompras,
  type MundoVentas,
} from "../../../test/compras.js";
import { esperarTerminal } from "../../../test/procesadores-007b.js";
import {
  GLOSA_5070,
  ConsultaRucCiiu,
  arrancarConCiiu,
  ciiuDe,
  consultaFerreteria,
  desactivarGlobal,
  exigirImplementado027,
  fijarCategorias,
  fijarUmbral,
  limpiarGastos,
  rgpDe,
  sembrarCiiu,
  sembrarPalabra,
  volcarTablasGastos,
} from "../../../test/gastos.js";
import { fijarInterruptor, limpiarReglas } from "../../../test/reglas.js";
import { loggerEspia, volcado } from "../../../test/soporte.js";
import {
  Escenario,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  esperarHasta,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
  restaurarConfig,
  volcarPrefijo,
} from "../../../test/trabajos.js";
import {
  EMISORES,
  RESULTADO_CERO,
  canarioXml,
  claveXml,
  esperarLotesXml,
  evaluacionesDe,
  fixtureXml,
  limpiarXml,
  puertosXml,
  reemplazar,
  type PuertosXml,
} from "../../../test/xml.js";

// Spec 027, T5 (rojo; integración con PostgreSQL y Redis reales, BullMQ real, `MockXmlProvider` y un storage en memoria): `xml.obtener`
// consulta el CIIU al llegar el XML y evalúa R-GP con el contexto del estudio (R-5, R-8, R-14, D-5; CA-1, CA-10 a CA-13, CA-16).
//
// CONTRATO que fija (T11): antes de la transacción de escritura de cada XML válido, `obtener-xml.ts` llama a `asegurarCiiu` con el
// RUC del proveedor y el del cliente (no consulta si el XML no llegó o no es válido); dentro de esa transacción arma el contexto con
// `contextoGastos` y la evaluación `n + 1` lleva el hallazgo R-GP con puntaje y señales. La evaluación 1 de la descarga no lo trae
// (sin XML no se evalúa, U-9). Las pruebas pasan su `ConsultaRuc` a `DepsTrabajos.consultaRuc`.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

let admin: ContappDb;
let backend: ContappDb;
let redis: Redis;
let e: Escenario;
let prefijo = nuevoPrefijo();
const prefijos = [prefijo];
beforeEach(() => {
  prefijo = nuevoPrefijo();
  prefijos.push(prefijo);
});

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  redis = conectarRedis();
  e = new Escenario(admin);
  await exigirImplementado027(admin);
  await fijarConfig(admin, "sire", { global: 4, tenant: 2, espera: 0, reintentos: 1, base: 100 });
  await fijarConfig(admin, "xml", { global: 4, tenant: 2, espera: 0, reintentos: 2, base: 100 });
});

afterAll(async () => {
  await restaurarConfig(admin).catch(() => undefined);
  await limpiarGastos(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarReglas(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarXml(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarCompras(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  for (const x of prefijos) await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), admin?.close()]);
});

/** Descarga de compras y los lotes de XML que ella encola, con el worker en marcha y la `ConsultaRuc` dada. */
async function correr(
  m: MundoVentas,
  p: PuertosXml,
  consulta: ConsultaRucCiiu,
  extra: Record<string, unknown> = {},
) {
  const w = await arrancarConCiiu(prefijo, p, consulta, extra);
  try {
    const id = await encolarDescarga(backend, redis, prefijo, m, { libro: "compras" });
    const f = await esperarTerminal(e, id, 30_000);
    expect([f.estado, f.motivo], "la descarga termina bien").toEqual(["completado", null]);
    return await esperarLotesXml(admin, m.c.id, 1, esperarHasta, 25_000);
  } finally {
    await w.detener({ esperaMs: 2000 });
  }
}

const mundo = (): Promise<MundoVentas> => mundoVentas(e, backend, { ruc: RUC_FIXTURE });

/** F001-5070 ya es conocido del cliente (otro periodo): el proveedor no es nuevo y S5 no suma. */
async function proveedorConocido(m: MundoVentas): Promise<void> {
  await sembrarCompra(
    admin,
    m,
    filaCompra("77", { rucContraparte: EMISORES["5070"]!, fechaEmision: "2026-09-10" }),
    { periodo: "202609" },
  );
}

const porNumero = async (m: MundoVentas) => new Map((await comprasDe(admin, m.c.id)).map((c) => [c.numero, c]));

const codigos = (s: { senales: Array<{ codigo: string }> }) => s.senales.map((x) => x.codigo);

describe("CA-1 · CA-16: al llegar el XML se consulta el CIIU y R-GP puntúa con el contexto del estudio", () => {
  it("ferretería (4752) y proveedor de calzado (4771) con «zapatillas»: puntaje 8 con S1, S2 y S3; la evaluación 1 no lo trae; sin versión nueva", async () => {
    const m = await mundo();
    await proveedorConocido(m);
    const consulta = consultaFerreteria(RUC_FIXTURE);
    const p = puertosXml();
    const lotes = await correr(m, p, consulta);
    expect(lotes[0]).toMatchObject({ estado: "completado", resultado: { ...RESULTADO_CERO, guardados: 5 } });

    const compras = await porNumero(m);
    const id = compras.get("5070")!.id;

    // Sin XML (evaluación 1 de la descarga) no hay hallazgo ni puntaje R-GP en ninguna compra (R-5, U-9; CA-11).
    for (const c of compras.values()) expect(await rgpDe(admin, c.id, 1), `R-GP en la evaluación 1 de ${c.numero}`).toBeNull();

    // Con el XML: la evaluación 2 lleva R-GP con el puntaje y las señales de CA-1.
    const rgp = await rgpDe(admin, id, 2);
    expect(rgp, "R-GP en la evaluación 2 de F001-5070").not.toBeNull();
    expect(rgp!.requiere_confirmacion).toBe(true);
    expect(rgp!.sugerencia).toMatchObject({ tipo: "excluir", palabra: "zapatilla", categoria: "calzado-ropa", puntaje: 8 });
    expect(codigos(rgp!.sugerencia)).toEqual(["S1", "S2", "S3"]);
    expect(rgp!.sugerencia.senales[0]).toMatchObject({ puntos: 3, palabra: "zapatilla", items: { coinciden: 1, total: 1 } });
    expect(rgp!.sugerencia.senales[1]).toMatchObject({ puntos: 3 });
    expect(rgp!.sugerencia.senales[2]).toMatchObject({ puntos: 2, categoria: "calzado-ropa" });

    // Las demás compras (glosas sin palabras del diccionario) no se marcan; ninguna versión se creó.
    for (const [numero, c] of compras) {
      if (numero !== "5070") expect(await rgpDe(admin, c.id, 2), `R-GP en ${numero}`).toBeNull();
      expect(c.version_vigente, numero).toBe(1);
      expect((await evaluacionesDe(admin, c.id)).map((x) => [x.version_n, x.n]), numero).toEqual([
        [1, 1],
        [1, 2],
      ]);
    }
  });

  it("el CIIU del cliente y de cada proveedor se consulta UNA vez, fuera de toda transacción, y queda en la caché del estudio", async () => {
    const m = await mundo();
    const consulta = consultaFerreteria(RUC_FIXTURE);
    const p = puertosXml();
    await correr(m, p, consulta);

    const rucs = consulta.rucs;
    expect(new Set(rucs).size, "ningún RUC se consulta dos veces").toBe(rucs.length);
    expect(rucs).toContain(RUC_FIXTURE);
    for (const emisor of Object.values(EMISORES)) expect(rucs, `proveedor ${emisor}`).toContain(emisor);
    expect(rucs).toHaveLength(6);
    expect(consulta.llamadas.every((l) => l.en === 0), "consultas dentro de una transacción abierta").toBe(true);

    const cache = new Map((await ciiuDe(admin, m.T)).map((f) => [f.ruc, f.ciiu]));
    expect(cache.get(RUC_FIXTURE)).toBe("4752");
    expect(cache.get(EMISORES["5070"]!)).toBe("4771");
    // El resto responde «sin dato» (ErrorDatos): queda guardado como null y no se vuelve a pedir.
    expect(cache.get(EMISORES["1040"]!)).toBeNull();
    expect(cache.size).toBe(6);
  });

  it("proveedor nuevo para el cliente: puntaje 9 con S5 al final", async () => {
    const m = await mundo();
    const p = puertosXml();
    await correr(m, p, consultaFerreteria(RUC_FIXTURE));

    const rgp = await rgpDe(admin, (await porNumero(m)).get("5070")!.id, 2);
    expect(rgp!.sugerencia.puntaje).toBe(9);
    expect(codigos(rgp!.sugerencia)).toEqual(["S1", "S2", "S3", "S5"]);
  });

  it("con calzado-ropa permitida al cliente: puntaje 6 y sin S3", async () => {
    const m = await mundo();
    await proveedorConocido(m);
    await fijarCategorias(admin, m, { permitidas: ["calzado-ropa"] });
    const p = puertosXml();
    await correr(m, p, consultaFerreteria(RUC_FIXTURE));

    const rgp = await rgpDe(admin, (await porNumero(m)).get("5070")!.id, 2);
    expect(rgp!.sugerencia.puntaje).toBe(6);
    expect(codigos(rgp!.sugerencia)).toEqual(["S1", "S2"]);
  });

  it("sin XML (el proveedor no lo encuentra) no hay R-GP, no se consulta ningún CIIU y no falla nada", async () => {
    const m = await mundo();
    const consulta = consultaFerreteria(RUC_FIXTURE);
    const p = puertosXml();
    p.xml.mock.fallar("no_encontrado");
    const lotes = await correr(m, p, consulta);

    expect(lotes[0]).toMatchObject({ estado: "completado", resultado: { ...RESULTADO_CERO, noEncontrados: 5 } });
    expect(consulta.rucs, "el CIIU se pide al llegar el XML, no antes").toEqual([]);
    expect(await ciiuDe(admin, m.T)).toEqual([]);
    for (const c of (await comprasDe(admin, m.c.id)))
      for (const n of [1, 2]) expect(await rgpDe(admin, c.id, n), `${c.numero} n=${n}`).toBeNull();
  });
});

describe("R-14 · CA-16: la caché y los fallos del CIIU no fallan el trabajo del XML", () => {
  it("con la caché vigente (29 días) no consulta al cliente ni al proveedor y puntúa con lo guardado", async () => {
    const m = await mundo();
    await proveedorConocido(m);
    await sembrarCiiu(admin, m.T, RUC_FIXTURE, "4752", 29);
    await sembrarCiiu(admin, m.T, EMISORES["5070"]!, "4771", 29);
    const consulta = consultaFerreteria(RUC_FIXTURE);
    const p = puertosXml();
    await correr(m, p, consulta);

    expect(consulta.rucs).not.toContain(RUC_FIXTURE);
    expect(consulta.rucs).not.toContain(EMISORES["5070"]);
    expect(consulta.rucs).toHaveLength(4);
    expect((await rgpDe(admin, (await porNumero(m)).get("5070")!.id, 2))!.sugerencia.puntaje).toBe(8);
  });

  it("con 31 días consulta de nuevo solo ese RUC y renueva la fila", async () => {
    const m = await mundo();
    await proveedorConocido(m);
    await sembrarCiiu(admin, m.T, RUC_FIXTURE, "4752", 29);
    await sembrarCiiu(admin, m.T, EMISORES["5070"]!, null, 31);
    const consulta = consultaFerreteria(RUC_FIXTURE);
    const p = puertosXml();
    await correr(m, p, consulta);

    expect(consulta.rucs).toContain(EMISORES["5070"]);
    expect(consulta.rucs).not.toContain(RUC_FIXTURE);
    const fila = (await ciiuDe(admin, m.T)).find((f) => f.ruc === EMISORES["5070"])!;
    expect(fila.ciiu).toBe("4771");
    expect(fila.antiguedad).toBeLessThan(300);
    expect((await rgpDe(admin, (await porNumero(m)).get("5070")!.id, 2))!.sugerencia.puntaje).toBe(8);
  });

  it("otro estudio con otro cliente consulta por su cuenta aunque ya exista la caché del primero", async () => {
    const a = await mundo();
    await sembrarCiiu(admin, a.T, EMISORES["5070"]!, "4771", 1);
    const b = await mundo();
    const consulta = consultaFerreteria(RUC_FIXTURE);
    const p = puertosXml();
    await correr(b, p, consulta);

    expect(consulta.rucs).toContain(EMISORES["5070"]);
    expect((await ciiuDe(admin, b.T)).find((f) => f.ruc === EMISORES["5070"])!.ciiu).toBe("4771");
    expect((await ciiuDe(admin, a.T)).map((f) => f.ruc), "el primer estudio no recibe nada del segundo").toEqual([EMISORES["5070"]]);
  });

  it("ErrorTransitorio del puerto: el XML se guarda y el lote termina bien; sin CIIU solo suma S1 (S2, S3 y S4 dan 0) y no se guarda caché", async () => {
    const m = await mundo();
    await proveedorConocido(m);
    const consulta = new ConsultaRucCiiu({}, "transitorio");
    const p = puertosXml();
    const lotes = await correr(m, p, consulta);

    expect(lotes[0]).toMatchObject({ estado: "completado", resultado: { ...RESULTADO_CERO, guardados: 5 } });
    expect(await ciiuDe(admin, m.T)).toEqual([]);
    const rgp = await rgpDe(admin, (await porNumero(m)).get("5070")!.id, 2);
    expect(rgp!.sugerencia.puntaje).toBe(3);
    expect(codigos(rgp!.sugerencia)).toEqual(["S1"]);
  });

  it("ErrorDatos del puerto: el XML se guarda, queda «sin dato» en la caché y R-GP puntúa sin CIIU", async () => {
    const m = await mundo();
    await proveedorConocido(m);
    const consulta = new ConsultaRucCiiu({}, "datos");
    const p = puertosXml();
    const lotes = await correr(m, p, consulta);

    expect(lotes[0]).toMatchObject({ estado: "completado", resultado: { ...RESULTADO_CERO, guardados: 5 } });
    const cache = await ciiuDe(admin, m.T);
    expect(cache).toHaveLength(6);
    expect(cache.every((f) => f.ciiu === null)).toBe(true);
    const rgp = await rgpDe(admin, (await porNumero(m)).get("5070")!.id, 2);
    expect(rgp!.sugerencia.puntaje).toBe(3);
    expect(codigos(rgp!.sugerencia)).toEqual(["S1"]);
  });
});

describe("R-8 · CA-10 · CA-13: el diccionario, el umbral y los interruptores del estudio rigen al llegar el XML", () => {
  it("umbral 9: el caso de CA-1 (puntaje 8) ya no se marca", async () => {
    const m = await mundo();
    await proveedorConocido(m);
    await fijarUmbral(admin, m, 9);
    const p = puertosXml();
    await correr(m, p, consultaFerreteria(RUC_FIXTURE));

    const id = (await porNumero(m)).get("5070")!.id;
    expect(await rgpDe(admin, id, 2)).toBeNull();
    expect((await evaluacionesDe(admin, id)).map((x) => x.n), "la evaluación 2 existe: solo falta el hallazgo").toEqual([1, 2]);
  });

  it("palabra propia del estudio con la global «zapatilla» desactivada: R-GP lleva la palabra y la categoría del estudio", async () => {
    const m = await mundo();
    await proveedorConocido(m);
    await desactivarGlobal(admin, m, "zapatilla");
    await sembrarPalabra(admin, m, "deportivas", { categoria: "entretenimiento" });
    const p = puertosXml();
    await correr(m, p, consultaFerreteria(RUC_FIXTURE));

    const rgp = await rgpDe(admin, (await porNumero(m)).get("5070")!.id, 2);
    expect(rgp!.sugerencia).toMatchObject({ palabra: "deportivas", categoria: "entretenimiento", puntaje: 8 });
    expect(rgp!.sugerencia.senales[0]).toMatchObject({ codigo: "S1", palabra: "deportivas" });
    expect(rgp!.sugerencia.senales[2]).toMatchObject({ codigo: "S3", categoria: "entretenimiento" });
  });

  it("con la global desactivada y sin palabras propias la glosa no coincide: sin S1 ni S3 queda solo S2, con palabra y categoría nulas", async () => {
    const m = await mundo();
    await proveedorConocido(m);
    await desactivarGlobal(admin, m, "zapatilla");
    const p = puertosXml();
    await correr(m, p, consultaFerreteria(RUC_FIXTURE));

    const rgp = await rgpDe(admin, (await porNumero(m)).get("5070")!.id, 2);
    expect(rgp!.sugerencia).toMatchObject({ palabra: null, categoria: null, puntaje: 3 });
    expect(codigos(rgp!.sugerencia)).toEqual(["S2"]);
  });

  it("con R-GP apagada en «Reglas del motor» no hay hallazgo ni puntaje, pero el CIIU y el XML siguen su curso", async () => {
    const m = await mundo();
    await proveedorConocido(m);
    await fijarInterruptor(admin, m, "R-GP", false);
    const p = puertosXml();
    const lotes = await correr(m, p, consultaFerreteria(RUC_FIXTURE));

    expect(lotes[0]).toMatchObject({ estado: "completado", resultado: { ...RESULTADO_CERO, guardados: 5 } });
    expect(await rgpDe(admin, (await porNumero(m)).get("5070")!.id, 2)).toBeNull();
    const cache = new Map((await ciiuDe(admin, m.T)).map((f) => [f.ruc, f.ciiu]));
    expect(cache.get(EMISORES["5070"]!), "el CIIU se pide igual: la caché sirve a las demás evaluaciones").toBe("4771");
  });
});

describe("CA-11 · R-5: lo que dice la glosa no sale de la glosa", () => {
  it("una glosa con un canario y <script> solo deja la palabra del diccionario: ni jobs, ni tablas, ni logs, ni Redis, ni auditoría", async () => {
    const m = await mundo();
    await proveedorConocido(m);
    const secreto = canarioXml("glosa");
    const p = puertosXml();
    p.xml.mock.inyectar(claveXml("5070"), {
      xml: reemplazar(
        fixtureXml("5070"),
        GLOSA_5070,
        `ZAPATILLAS ${secreto} &lt;script&gt;alert(1)&lt;/script&gt;`,
      ),
    });
    const espia = loggerEspia();
    const consulta = consultaFerreteria(RUC_FIXTURE);
    const lotes = await correr(m, p, consulta, { logger: espia.logger });

    expect(lotes[0]).toMatchObject({ estado: "completado", resultado: { ...RESULTADO_CERO, guardados: 5 } });
    const rgp = await rgpDe(admin, (await porNumero(m)).get("5070")!.id, 2);
    expect(rgp!.sugerencia).toMatchObject({ palabra: "zapatilla", categoria: "calzado-ropa", puntaje: 8 });
    expect(codigos(rgp!.sugerencia)).toEqual(["S1", "S2", "S3"]);
    // La señal S1 lleva la palabra del diccionario y los conteos, nunca la glosa.
    expect(JSON.stringify(rgp!.sugerencia)).not.toContain(secreto);

    const auditoria = (
      await admin.pool.query("select to_jsonb(a)::text as t from auditoria a where tenant_id = $1", [m.T])
    ).rows.map((f: { t: string }) => f.t);
    const visible = [
      await e.volcarJobs(),
      await volcarTablasCompras(admin, [m.T]),
      await volcarTablasGastos(admin, [m.T]),
      await volcarPrefijo(redis, prefijo),
      volcado(espia.llamadas),
      volcado(consulta.llamadas),
      ...auditoria,
    ].join("\n");
    expect(visible).not.toContain(secreto);
    expect(visible).not.toContain("alert(1)");
    expect(visible).not.toContain("<script");
  });
});
