import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ARRIENDO_MS,
  Reconciliador,
  crearClaves,
  registrarTipo,
  tomarCupos,
  tomarEjecucion,
  tomarLockRuc,
} from "./index.js";
import {
  bd,
  dbFalsa,
  uuidDe,
  type FilaTrabajo,
} from "./soporte-pruebas/bd-falsa.js";
import { RedisFalso } from "./soporte-pruebas/redis-falso.js";
import { RelojFalso } from "./soporte-pruebas/reloj-falso.js";

// Repos que el reconciliador usa ademas de los del doble (contrato: trabajos-repos.spec.ts):
// estudiosConTrabajos (withSistema), listarTrabajos y leerTrabajo (withTenant).
const extra = vi.hoisted(() => ({
  fallaEstudios: false,
  ocultos: new Set<string>(),
  noTransiciona: new Set<string>(),
  antiguedades: [] as number[],
}));

vi.mock("@contapp/db", async () => {
  const m = await import("./soporte-pruebas/bd-falsa.js");
  const { bd: b, moduloDbFalso } = m;
  return {
    ...moduloDbFalso,
    async estudiosConTrabajos(
      _tx: unknown,
      estados: readonly string[],
      antiguedadSeg: number,
    ) {
      if (extra.fallaEstudios) throw new Error("sistema caido");
      extra.antiguedades.push(antiguedadSeg);
      return [
        ...new Set(
          [...b.trabajos.values()]
            .filter((f) => estados.includes(f.estado))
            .map((f) => f.tenantId),
        ),
      ].sort();
    },
    // Devuelve todos los del estudio (sin filtrar por estado) para recorrer el descarte por estado.
    async listarTrabajos(tx: { tenantId: string }) {
      return [...b.trabajos.values()]
        .filter((f) => f.tenantId === tx.tenantId)
        .map((f) => ({ id: f.id }));
    },
    async leerTrabajo(tx: { tenantId: string }, id: string) {
      const f = b.trabajos.get(id);
      return f === undefined ||
        f.tenantId !== tx.tenantId ||
        extra.ocultos.has(id)
        ? null
        : { ...f };
    },
    async transicionar(
      tx: { tenantId: string },
      id: string,
      ...resto: unknown[]
    ) {
      if (extra.noTransiciona.has(id)) return false;
      return (moduloDbFalso.transicionar as (...a: unknown[]) => unknown)(
        tx,
        id,
        ...resto,
      );
    },
  };
});

// T9 (backend): Reconciliador (D1, D3, D18, CA-1, CA-10). Repone tenants:{cola} de los estudios con
// en_cola y resuelve los ejecutando sin arriendo vivo: idempotente con reintentos -> en_cola con el
// intento consumido; si no -> error/interrumpido. Un withTenant por estudio, en secuencia.
const [TA, TB] = [uuidDe(0xa1), uuidDe(0xb1)];
const k = crearClaves("r:");

registrarTipo({
  tipo: "rec.idem",
  cola: "sire",
  canal: "sire",
  credencial: null,
  permiso: null,
  idempotente: true,
  parametros: z.object({}),
});
registrarTipo({
  tipo: "rec.unico",
  cola: "sire",
  canal: "sire",
  credencial: null,
  permiso: null,
  idempotente: false,
  parametros: z.object({}),
});

let reloj: RelojFalso;
let redis: RedisFalso;
let n = 0;

const reconciliador = () =>
  new Reconciliador({
    db: dbFalsa as never,
    redis: redis as never,
    reloj,
    prefijo: "r:",
  });

function sembrar(o: Partial<FilaTrabajo> = {}): FilaTrabajo {
  n++;
  const id = bd.siguienteId();
  const creadoEn = new Date(reloj.ms() - 3_600_000);
  const f: FilaTrabajo = {
    id,
    tenantId: TA,
    clienteId: uuidDe(0x2000 + n),
    ruc: `2010${String(n).padStart(7, "0")}`,
    tipo: "rec.idem",
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
  };
  bd.trabajos.set(id, f);
  return f;
}

beforeEach(() => {
  bd.reiniciar();
  reloj = new RelojFalso();
  redis = new RedisFalso(reloj);
  extra.fallaEstudios = false;
  extra.ocultos.clear();
  extra.noTransiciona.clear();
  extra.antiguedades = [];
  n = 0;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("reponer pendientes (CA-1)", () => {
  it("vuelve a poner en tenants:{cola} a los estudios con en_cola (Redis perdido)", async () => {
    sembrar({ tenantId: TA });
    sembrar({ tenantId: TB, cola: "sol", tipo: "rec.idem" });
    const r = await reconciliador().ciclo();
    expect(r).toMatchObject({ estudios: 2, repuestos: 2 });
    expect(await redis.smembers(k.tenants("sire"))).toEqual([TA]);
    expect(await redis.smembers(k.tenants("sol"))).toEqual([TB]);
    expect(extra.antiguedades).toEqual([ARRIENDO_MS / 1000]);
  });

  it("sin estudios con trabajos no toca Redis", async () => {
    sembrar({ estado: "completado" });
    expect(await reconciliador().ciclo()).toEqual({
      estudios: 0,
      repuestos: 0,
      reencolados: 0,
      interrumpidos: 0,
    });
    expect(redis.comandos).toBe(0);
  });

  it("si la enumeracion falla no lanza", async () => {
    extra.fallaEstudios = true;
    await expect(reconciliador().ciclo()).resolves.toMatchObject({
      estudios: 0,
    });
  });
});

describe("ejecutando con arriendo vencido (CA-10)", () => {
  const corriendo = async (o: Partial<FilaTrabajo> = {}) => {
    const f = sembrar({
      estado: "ejecutando",
      iniciadoEn: reloj.ahora(),
      ...o,
    });
    await tomarCupos(redis as never, k, f, reloj.ms());
    await tomarLockRuc(redis as never, k, f);
    return f;
  };

  it("idempotente: vuelve a en_cola con el intento consumido, libera cupo y lock y repone la pista", async () => {
    const f = await corriendo();
    reloj.avanzar(ARRIENDO_MS + 1);
    const r = await reconciliador().ciclo();
    expect(r).toMatchObject({ reencolados: 1, interrumpidos: 0 });
    expect(f.estado).toBe("en_cola");
    expect(f.intentos).toBe(1);
    expect(await redis.zcard(k.cupoGlobal("sire"))).toBe(0);
    expect(await redis.zcard(k.cupoTenant("sire", TA))).toBe(0);
    expect(await redis.exists(k.lockRuc("sire", f.ruc))).toBe(0); // vencio con el arriendo
    expect(await redis.smembers(k.tenants("sire"))).toEqual([TA]);
    const ev = JSON.parse(redis.publicados[0]!.mensaje);
    expect(ev).toMatchObject({ id: f.id, estado: "en_cola", intentos: 1 });
    expect(ev).not.toHaveProperty("ruc");
  });

  it("no idempotente: error/interrumpido", async () => {
    const f = await corriendo({ tipo: "rec.unico" });
    reloj.avanzar(ARRIENDO_MS + 1);
    expect(await reconciliador().ciclo()).toMatchObject({ interrumpidos: 1 });
    expect(f).toMatchObject({ estado: "error", motivo: "interrumpido" });
    expect(JSON.parse(redis.publicados[0]!.mensaje)).toMatchObject({
      estado: "error",
      motivo: "interrumpido",
    });
  });

  it("idempotente sin reintentos disponibles: error/interrumpido", async () => {
    const f = await corriendo({ intentos: 3 });
    reloj.avanzar(ARRIENDO_MS + 1);
    await reconciliador().ciclo();
    expect(f).toMatchObject({ estado: "error", motivo: "interrumpido" });
  });

  it("una cola sin config_sistema no reintenta (0 reintentos) y suelta el lock sin espera", async () => {
    const f = await corriendo({ cola: "archivos", tipo: "rec.idem" });
    await redis.set(k.lockRuc("sire", f.ruc), f.id, "PX", 60_000);
    reloj.avanzar(ARRIENDO_MS + 1);
    await reconciliador().ciclo();
    expect(f).toMatchObject({ estado: "error", motivo: "interrumpido" });
    expect(await redis.exists(k.lockRuc("sire", f.ruc))).toBe(0);
  });

  it("un tipo fuera del catalogo se trata como no idempotente", async () => {
    const f = await corriendo({ tipo: "rec.retirado" });
    reloj.avanzar(ARRIENDO_MS + 1);
    await reconciliador().ciclo();
    expect(f).toMatchObject({ estado: "error", motivo: "interrumpido" });
  });

  it("con el arriendo del ejecutor vivo, o el cupo aun vigente, no lo toca", async () => {
    const conEjec = await corriendo();
    await tomarEjecucion(redis as never, k, conEjec.id);
    const recien = await corriendo();
    reloj.avanzar(ARRIENDO_MS - 1);
    await redis.set(k.ejec(conEjec.id), conEjec.id, "PX", ARRIENDO_MS);
    await reconciliador().ciclo();
    expect(conEjec.estado).toBe("ejecutando");
    expect(recien.estado).toBe("ejecutando");
  });

  it("sin cupo registrado (Redis perdido) cuenta como vencido", async () => {
    const f = sembrar({ estado: "ejecutando" });
    await reconciliador().ciclo();
    expect(f.estado).toBe("en_cola");
  });

  it("si otro actor gana la transicion no publica ni libera", async () => {
    const a = await corriendo();
    const b = await corriendo({ tipo: "rec.unico" });
    extra.noTransiciona.add(a.id);
    extra.noTransiciona.add(b.id);
    reloj.avanzar(ARRIENDO_MS + 1);
    expect(await reconciliador().ciclo()).toMatchObject({
      reencolados: 0,
      interrumpidos: 0,
    });
    expect(redis.publicados).toHaveLength(0);
  });

  it("ignora filas que ya no se leen o que cambiaron de estado", async () => {
    const oculto = await corriendo();
    extra.ocultos.add(oculto.id);
    reloj.avanzar(ARRIENDO_MS + 1);
    await reconciliador().ciclo();
    expect(oculto.estado).toBe("ejecutando");
  });

  it("un estudio que falla no impide atender al siguiente", async () => {
    sembrar({ tenantId: TA });
    sembrar({ tenantId: TB });
    const db = {
      ...dbFalsa,
      withTenant: async (
        ctx: { tenantId: string },
        fn: (t: unknown) => Promise<unknown>,
      ) => {
        if (ctx.tenantId === TA) throw new Error("x");
        return dbFalsa.withTenant(ctx, fn as never);
      },
    };
    const r = await new Reconciliador({
      db: db as never,
      redis: redis as never,
      reloj,
      prefijo: "r:",
      antiguedadSeg: 5,
    }).ciclo();
    expect(r.estudios).toBe(2);
    expect(await redis.smembers(k.tenants("sire"))).toEqual([TB]);
    expect(extra.antiguedades).toEqual([5]);
  });
});
