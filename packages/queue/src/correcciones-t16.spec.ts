// T16 (backend, correcciones de la ronda adversarial 2) con dobles: una sola fuente de tiempo (TIME de Redis) en
// cupos, despachador y latido (H-008-2a-2, H-008-2b-1 a 2b-5); el despachador que pierde la transición frente a otro
// despachador no suelta el cupo ni el lock de esa ejecución (H-008-2a-1 = 2b-6); `encolar` con el tope atómico de
// pendientes y los reintentos ante choques de dedupe (H-008-2a-3, H-008-2b-7). La carrera real la fijan los
// `*-r2a`/`*-r2b.adv.int.spec.ts` de este paquete.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as db from "@contapp/db";
import {
  ARRIENDO_MS,
  ColaLlenaError,
  crearClaves,
  Despachador,
  encolar,
  registrarTipo,
  renovarArriendos,
  tomarCupos,
  tomarEjecucion,
} from "./index.js";
import { bd, dbFalsa, uuidDe, type FilaTrabajo } from "./soporte-pruebas/bd-falsa.js";
import { RedisFalso } from "./soporte-pruebas/redis-falso.js";
import { RelojFalso } from "./soporte-pruebas/reloj-falso.js";

/** ids cuya transición `en_cola → ejecutando` la gana "otro despachador" justo antes (queda `ejecutando`). */
const ganadosPorOtro = vi.hoisted(() => new Set<string>());

vi.mock("@contapp/db", async () => {
  const { moduloDbFalso, bd: b } = await import("./soporte-pruebas/bd-falsa.js");
  return {
    ...moduloDbFalso,
    insertarTrabajo: vi.fn(moduloDbFalso.insertarTrabajo),
    trabajoVivoPorClave: vi.fn(moduloDbFalso.trabajoVivoPorClave),
    async transicionar(tx: never, id: string, desde: string, hacia: string, campos?: never) {
      if (ganadosPorOtro.has(id) && desde === "en_cola") {
        const f = b.trabajos.get(id)!;
        f.estado = "ejecutando";
        return false;
      }
      return moduloDbFalso.transicionar(tx, id, desde, hacia, campos);
    },
  };
});

registrarTipo({
  tipo: "correccion.ronda_dos",
  cola: "sire",
  canal: "sire",
  credencial: null,
  permiso: null,
  idempotente: true,
  parametros: z.object({ n: z.number().optional() }),
});

const T = uuidDe(0xa1);
const k = crearClaves("t16:");
let reloj: RelojFalso;
let redis: RedisFalso;

beforeEach(() => {
  bd.reiniciar();
  ganadosPorOtro.clear();
  reloj = new RelojFalso();
  redis = new RedisFalso(reloj);
  vi.mocked(db.insertarTrabajo).mockClear();
  vi.mocked(db.trabajoVivoPorClave).mockClear();
});

/** Reloj local desfasado `ms` respecto del de Redis (`reloj`). */
const desfasado = (ms: number) => ({ ahora: () => new Date(reloj.ms() + ms) });

function sembrar(n: number, o: Partial<FilaTrabajo> = {}): string {
  const id = uuidDe(0x100 + n);
  const creadoEn = new Date(reloj.ms() - 1000 + n);
  bd.trabajos.set(id, {
    id,
    tenantId: T,
    clienteId: uuidDe(0x200 + n),
    ruc: `2010000000${n}`,
    tipo: "correccion.ronda_dos",
    cola: "sire",
    canal: "sire",
    prioridad: "interactivo",
    estado: "en_cola",
    intentos: 0,
    motivo: null,
    creadoPor: null,
    creadoEn,
    disponibleDesde: creadoEn,
    iniciadoEn: null,
    terminadoEn: null,
    claveDedupe: id,
    parametros: {},
    ...o,
  });
  return id;
}

const despachador = (ahoraLocal: { ahora: () => Date }) =>
  new Despachador({
    db: dbFalsa as never,
    redis: redis as never,
    reloj: ahoraLocal,
    prefijo: "t16:",
    agregarACola: async () => undefined,
  });

describe("una sola fuente de tiempo: TIME de Redis", () => {
  it("tomarCupos y renovarArriendos vencen a TIME + 30 s aunque la hora local esté adelantada", async () => {
    const t = { id: uuidDe(1), tenantId: T, cola: "sire", canal: "sire", ruc: "20100000001", ejecucion: "e" };
    await tomarCupos(redis as never, k, t, reloj.ms() + 40_000);
    expect(Number(await redis.zscore(k.cupoGlobal("sire"), t.id))).toBe(reloj.ms() + ARRIENDO_MS);
    await tomarEjecucion(redis as never, k, t.id, "e");
    reloj.avanzar(10_000);
    expect(await renovarArriendos(redis as never, k, t, reloj.ms() + 40_000)).toBe(true);
    expect(Number(await redis.zscore(k.cupoTenant("sire", T), t.id))).toBe(reloj.ms() + ARRIENDO_MS);
  });

  it("un líder con el reloj 40 s atrasado poda los cupos vencidos según Redis y ve los trabajos ya disponibles", async () => {
    const id = sembrar(1);
    await redis.sadd(k.tenants("sire"), T);
    for (const muerto of [uuidDe(0x901), uuidDe(0x902)]) {
      await redis.zadd(k.cupoTenant("sire", T), reloj.ms() - 1, muerto);
      await redis.zadd(k.cupoGlobal("sire"), reloj.ms() - 1, muerto);
    }
    await despachador(desfasado(-40_000)).ciclo();
    expect(bd.trabajos.get(id)!.estado).toBe("ejecutando");
    expect(Number(await redis.zscore(k.cupoGlobal("sire"), id))).toBe(reloj.ms() + ARRIENDO_MS);
  });

  it("error: con Redis caído el ciclo no despacha ni lanza", async () => {
    const id = sembrar(1);
    redis.fallar(new Error("caído"));
    await expect(despachador(desfasado(0)).ciclo()).resolves.toBeUndefined();
    expect(bd.trabajos.get(id)!.estado).toBe("en_cola");
  });
});

describe("transición perdida (H-008-2a-1)", () => {
  it("frente a otro despachador (queda ejecutando) no suelta el cupo ni el lock de esa ejecución", async () => {
    const id = sembrar(1);
    ganadosPorOtro.add(id);
    await redis.sadd(k.tenants("sire"), T);
    await despachador(desfasado(0)).ciclo();
    expect(await redis.zscore(k.cupoTenant("sire", T), id)).not.toBeNull();
    expect(await redis.zscore(k.cupoGlobal("sire"), id)).not.toBeNull();
    expect(await redis.get(k.lockRuc("sire", "20100000001"))).toBe(id);
  });

  it("frente a una cancelación suelta la reserva (cupos y lock)", async () => {
    const id = sembrar(1);
    bd.perdedores.add(id);
    await redis.sadd(k.tenants("sire"), T);
    await despachador(desfasado(0)).ciclo();
    expect(await redis.zscore(k.cupoTenant("sire", T), id)).toBeNull();
    expect(await redis.zscore(k.cupoGlobal("sire"), id)).toBeNull();
    expect(await redis.get(k.lockRuc("sire", "20100000001"))).toBeNull();
  });
});

describe("encolar: tope atómico y choques de dedupe", () => {
  const entrada = (n: number) => ({
    tipo: "correccion.ronda_dos",
    clienteId: uuidDe(0xc1),
    parametros: { n },
    prioridad: "interactivo" as const,
    creadoPor: null,
  });
  const tx = { tenantId: T } as never;

  it("pasa el tope del estudio al INSERT (rechazo atómico) y devuelve el nuevo", async () => {
    const r = await encolar(tx, entrada(1));
    expect(r.nuevo).toBe(true);
    expect(vi.mocked(db.insertarTrabajo).mock.calls[0]![1]).toMatchObject({ maxPendientes: 2000 });
  });

  it("error: si el INSERT responde 'lleno' (otro encolado ocupó el último lugar), ColaLlenaError", async () => {
    vi.mocked(db.insertarTrabajo).mockResolvedValueOnce("lleno" as never);
    await expect(encolar(tx, entrada(2))).rejects.toBeInstanceOf(ColaLlenaError);
  });

  it("error: 'lleno' en el reintento tras un choque con un vivo que terminó también es ColaLlenaError", async () => {
    vi.mocked(db.insertarTrabajo).mockResolvedValueOnce(null).mockResolvedValueOnce("lleno" as never);
    vi.mocked(db.trabajoVivoPorClave).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(encolar(tx, entrada(3))).rejects.toBeInstanceOf(ColaLlenaError);
  });

  it("un reintento que choca con otro que reintenta a la vez (null) relee y devuelve el de ese", async () => {
    const otro = await encolar(tx, entrada(4));
    vi.mocked(db.insertarTrabajo).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    vi.mocked(db.trabajoVivoPorClave).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const r = await encolar(tx, entrada(4));
    expect(r).toEqual({ trabajo: otro.trabajo, nuevo: false });
  });

  it("error: si cada intento choca con un vivo que ya terminó, lanza sin datos", async () => {
    vi.mocked(db.insertarTrabajo).mockResolvedValue(null);
    vi.mocked(db.trabajoVivoPorClave).mockResolvedValue(null);
    try {
      const e = await encolar(tx, entrada(5)).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe("encolar: conflicto de dedupe persistente");
      expect(vi.mocked(db.insertarTrabajo)).toHaveBeenCalledTimes(3);
    } finally {
      vi.mocked(db.insertarTrabajo).mockReset();
      vi.mocked(db.trabajoVivoPorClave).mockReset();
    }
  });
});
