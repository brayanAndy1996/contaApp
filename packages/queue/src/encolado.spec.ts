import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ColaLlenaError,
  ParametrosInvalidosError,
  TipoDesconocidoError,
  crearClaves,
  encolar,
  payloadBullmq,
  publicar,
  registrarTipo,
} from "./index.js";
import { bd, uuidDe } from "./soporte-pruebas/bd-falsa.js";
import { RedisFalso } from "./soporte-pruebas/redis-falso.js";
import { RelojFalso } from "./soporte-pruebas/reloj-falso.js";

vi.mock(
  "@contapp/db",
  async () => (await import("./soporte-pruebas/bd-falsa.js")).moduloDbFalso,
);

// Contrato (plan 008, packages/queue/src/encolado.ts), CA-1, CA-15, CA-16, D3, D8:
//  - encolar(tx, { tipo, clienteId, parametros, prioridad, creadoPor: string | null })
//      -> { trabajo: TrabajoVista, nuevo: boolean }. Solo escribe en BD (usa los repos de
//      @contapp/db con `tx`: ver soporte-pruebas/bd-falsa.ts). Valida `parametros` con el esquema
//      zod del tipo y PERSISTE la salida parseada (las claves desconocidas se descartan: un secreto
//      colado en `parametros` no llega a job_registro). `claveDedupe` = claveDedupe(tipo, cliente,
//      parametros parseados) (Buffer de 32 B) y `cola`/`canal` salen de la definicion del tipo.
//      - tipo no registrado -> TipoDesconocidoError; parametros invalidos -> ParametrosInvalidosError
//        (el `message` NO incluye los valores). En ambos casos no se inserta nada.
//      - Si ya hay un trabajo vivo con la misma clave (en_cola/ejecutando) devuelve ese trabajo con
//        nuevo=false y no inserta (D8). Uno terminado no cuenta.
//      - Si contarPendientes(tx, cola) >= leerConfig(tx).get(cola).maxPendientesTenant -> lanza
//        ColaLlenaError (codigo "cola_llena", HTTP 429) sin insertar.
//  - publicar(redis, trabajos: { id, tenantId, cola, prioridad, creadoEn: Date }[], opciones?:
//      { prefijo?: string }): despues del commit. Para cada trabajo: ZADD en pend:{cola}:{tenantId}
//      con puntaje = prioridad (interactivo antes que cualquier programado) + tiempo de creacion, y
//      SADD del tenant en tenants:{cola}. Idempotente. Los errores de Redis NO se propagan (se
//      registran sin datos sensibles; el reconciliador repone).
//  - payloadBullmq(trabajo) -> exactamente { jobId, tenantId, tipo } (CA-15).
const T1 = uuidDe(0xa1);
const T2 = uuidDe(0xa2);
const CLIENTE1 = uuidDe(0xc1);
const CLIENTE2 = uuidDe(0xc2);
const USUARIO = uuidDe(0xe1);
const CANARIO = "CANARIO-SOL-clave-1234";
const tx1 = { tenantId: T1 } as never;
const tx2 = { tenantId: T2 } as never;

registrarTipo({
  tipo: "test.encolar",
  cola: "sire",
  canal: "sire",
  credencial: null,
  permiso: null,
  idempotente: true,
  parametros: z.object({
    periodo: z.string().regex(/^\d{6}$/),
    modo: z.string().optional(),
  }),
});

const entrada = (extra: Record<string, unknown> = {}) => ({
  tipo: "test.encolar",
  clienteId: CLIENTE1,
  parametros: { periodo: "202610", modo: "completo" },
  prioridad: "interactivo" as const,
  creadoPor: USUARIO,
  ...extra,
});

beforeEach(() => bd.reiniciar());

describe("encolar", () => {
  it("crea el trabajo en_cola con la definicion del tipo y su clave de dedupe", async () => {
    const r = await encolar(tx1, entrada());
    expect(r.nuevo).toBe(true);
    expect(r.trabajo).toMatchObject({
      tipo: "test.encolar",
      clienteId: CLIENTE1,
      estado: "en_cola",
      intentos: 0,
      motivo: null,
      creadoPor: { usuarioId: USUARIO },
    });
    expect(bd.insertados).toHaveLength(1);
    const ins = bd.insertados[0]!;
    expect(ins).toMatchObject({
      tipo: "test.encolar",
      cola: "sire",
      canal: "sire",
      prioridad: "interactivo",
      clienteId: CLIENTE1,
      creadoPor: USUARIO,
      parametros: { periodo: "202610", modo: "completo" },
    });
    expect(Buffer.isBuffer(ins.claveDedupe)).toBe(true);
    expect((ins.claveDedupe as Buffer).length).toBe(32);
  });

  it("acepta creadoPor null (trabajo programado sin usuario)", async () => {
    const r = await encolar(
      tx1,
      entrada({ creadoPor: null, prioridad: "programado" }),
    );
    expect(r.trabajo.creadoPor).toBeNull();
    expect(bd.insertados[0]).toMatchObject({
      creadoPor: null,
      prioridad: "programado",
    });
  });

  it("D8: el mismo trabajo (aunque cambie el orden de las claves) devuelve el existente", async () => {
    const a = await encolar(tx1, entrada());
    const b = await encolar(
      tx1,
      entrada({ parametros: { modo: "completo", periodo: "202610" } }),
    );
    expect(b.nuevo).toBe(false);
    expect(b.trabajo.id).toBe(a.trabajo.id);
    expect(bd.insertados).toHaveLength(1);
  });

  it("D8: encolar 50 veces lo mismo deja un solo trabajo", async () => {
    const resultados = [];
    for (let i = 0; i < 50; i++) resultados.push(await encolar(tx1, entrada()));
    expect(bd.insertados).toHaveLength(1);
    expect(new Set(resultados.map((r) => r.trabajo.id)).size).toBe(1);
    expect(resultados.filter((r) => r.nuevo)).toHaveLength(1);
  });

  it("una clave desconocida en los parametros no evade la deduplicacion ni se persiste", async () => {
    await encolar(tx1, entrada());
    const r = await encolar(
      tx1,
      entrada({
        parametros: { periodo: "202610", modo: "completo", claveSol: CANARIO },
      }),
    );
    expect(r.nuevo).toBe(false);
    expect(JSON.stringify(bd.insertados)).not.toContain("CANARIO");
  });

  it("otro tipo de valor, otro cliente u otro periodo son trabajos distintos", async () => {
    await encolar(tx1, entrada());
    await encolar(tx1, entrada({ clienteId: CLIENTE2 }));
    await encolar(
      tx1,
      entrada({ parametros: { periodo: "202611", modo: "completo" } }),
    );
    await encolar(tx1, entrada({ parametros: { periodo: "202610" } }));
    expect(bd.insertados).toHaveLength(4);
  });

  it("un trabajo terminado no bloquea volver a encolar", async () => {
    const a = await encolar(tx1, entrada());
    bd.trabajos.get(a.trabajo.id)!.estado = "completado";
    const b = await encolar(tx1, entrada());
    expect(b.nuevo).toBe(true);
    expect(b.trabajo.id).not.toBe(a.trabajo.id);
  });

  it("un tipo no registrado lanza TipoDesconocidoError y no inserta", async () => {
    await expect(
      encolar(tx1, entrada({ tipo: "no.existe" })),
    ).rejects.toBeInstanceOf(TipoDesconocidoError);
    expect(bd.insertados).toHaveLength(0);
  });

  it("parametros invalidos lanzan ParametrosInvalidosError sin valores en el mensaje", async () => {
    for (const parametros of [
      { periodo: CANARIO },
      { periodo: 202610 },
      {},
      null,
      "texto",
      [CANARIO],
    ]) {
      const e: unknown = await encolar(tx1, entrada({ parametros })).catch(
        (x: unknown) => x,
      );
      expect(e, JSON.stringify(parametros)).toBeInstanceOf(
        ParametrosInvalidosError,
      );
      expect((e as Error).message).not.toContain("CANARIO");
    }
    expect(bd.insertados).toHaveLength(0);
  });

  describe("limite de pendientes por estudio y cola (D8)", () => {
    const encolarN = async (tx: never, n: number, desde = 0) => {
      for (let i = 0; i < n; i++) {
        await encolar(
          tx,
          entrada({
            parametros: {
              periodo: `2026${String(desde + i + 1).padStart(2, "0")}`,
            },
          }),
        );
      }
    };

    it("lanza ColaLlenaError al llegar a max_pendientes_tenant y no inserta", async () => {
      bd.config.get("sire")!.maxPendientesTenant = 2;
      await encolarN(tx1, 2);
      const e: unknown = await encolar(
        tx1,
        entrada({ parametros: { periodo: "202699" } }),
      ).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ColaLlenaError);
      expect((e as { codigo?: string }).codigo).toBe("cola_llena");
      expect(bd.insertados).toHaveLength(2);
    });

    it("el limite es por estudio: otro estudio sigue pudiendo encolar", async () => {
      bd.config.get("sire")!.maxPendientesTenant = 2;
      await encolarN(tx1, 2);
      await expect(encolar(tx2, entrada())).resolves.toMatchObject({
        nuevo: true,
      });
    });

    it("al liberarse un lugar (el trabajo sale de en_cola) vuelve a aceptar", async () => {
      bd.config.get("sire")!.maxPendientesTenant = 2;
      await encolarN(tx1, 2);
      const [primero] = [...bd.trabajos.values()];
      primero!.estado = "ejecutando";
      await expect(
        encolar(tx1, entrada({ parametros: { periodo: "202699" } })),
      ).resolves.toMatchObject({ nuevo: true });
    });
  });
});

describe("publicar", () => {
  const reloj = new RelojFalso();
  let redis: RedisFalso;
  const publicable = (n: number, extra: Record<string, unknown> = {}) => ({
    id: uuidDe(0x500 + n),
    tenantId: T1,
    cola: "sire",
    prioridad: "interactivo",
    creadoEn: new Date(Date.parse("2026-10-27T15:00:00.000Z") + n * 1000),
    ...extra,
  });

  beforeEach(() => {
    redis = new RedisFalso(reloj);
  });
  afterEach(() => vi.restoreAllMocks());

  it("agrega el jobId a pend:{cola}:{tenantId} y el tenant a tenants:{cola}", async () => {
    const k = crearClaves();
    await publicar(redis as never, [publicable(1)]);
    expect(await redis.zrange(k.pend("sire", T1), 0, -1)).toEqual([
      publicable(1).id,
    ]);
    expect(await redis.smembers(k.tenants("sire"))).toEqual([T1]);
  });

  it("usa el prefijo indicado", async () => {
    await publicar(redis as never, [publicable(1)], { prefijo: "p9:" });
    expect(redis.claves().every((c) => c.startsWith("p9:"))).toBe(true);
    expect(redis.claves().length).toBeGreaterThan(0);
  });

  it("separa por cola y por estudio", async () => {
    const k = crearClaves();
    await publicar(redis as never, [
      publicable(1),
      publicable(2, { cola: "sol" }),
      publicable(3, { tenantId: T2 }),
    ]);
    expect(await redis.zcard(k.pend("sire", T1))).toBe(1);
    expect(await redis.zcard(k.pend("sol", T1))).toBe(1);
    expect(await redis.zcard(k.pend("sire", T2))).toBe(1);
    expect((await redis.smembers(k.tenants("sire"))).sort()).toEqual(
      [T1, T2].sort(),
    );
    expect(await redis.smembers(k.tenants("sol"))).toEqual([T1]);
  });

  it("un interactivo sale antes que cualquier programado, aunque se haya creado despues", async () => {
    const k = crearClaves();
    const programadoViejo = publicable(1, {
      prioridad: "programado",
      creadoEn: new Date("2026-01-01T00:00:00Z"),
    });
    const interactivoNuevo = publicable(2, {
      prioridad: "interactivo",
      creadoEn: new Date("2026-12-31T23:59:59Z"),
    });
    await publicar(redis as never, [programadoViejo, interactivoNuevo]);
    expect(await redis.zrange(k.pend("sire", T1), 0, -1)).toEqual([
      interactivoNuevo.id,
      programadoViejo.id,
    ]);
  });

  it("dentro de una misma prioridad sale primero el mas antiguo", async () => {
    const k = crearClaves();
    const [a, b, c] = [publicable(3), publicable(1), publicable(2)];
    await publicar(redis as never, [a, b, c]);
    expect(await redis.zrange(k.pend("sire", T1), 0, -1)).toEqual([
      b.id,
      c.id,
      a.id,
    ]);
  });

  it("es idempotente: publicar dos veces no duplica", async () => {
    const k = crearClaves();
    await publicar(redis as never, [publicable(1)]);
    await publicar(redis as never, [publicable(1)]);
    expect(await redis.zcard(k.pend("sire", T1))).toBe(1);
  });

  it("sin trabajos no toca Redis", async () => {
    await publicar(redis as never, []);
    expect(redis.comandos).toBe(0);
  });

  it("si Redis esta caido NO propaga el error y no deja rastro del mensaje en consola", async () => {
    const espias = (["log", "info", "warn", "error", "debug"] as const).map(
      (m) => vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    redis.fallar(new Error(`ECONNREFUSED ${CANARIO}`));
    await expect(
      publicar(redis as never, [publicable(1), publicable(2)]),
    ).resolves.not.toThrow();
    for (const e of espias)
      expect(JSON.stringify(e.mock.calls)).not.toContain("CANARIO");
  });

  it("un fallo de un solo comando tampoco se propaga", async () => {
    vi.spyOn(redis, "zadd").mockRejectedValueOnce(new Error("OOM"));
    vi.spyOn(redis, "sadd").mockRejectedValueOnce(new Error("OOM"));
    await expect(
      publicar(redis as never, [publicable(1), publicable(2)]),
    ).resolves.not.toThrow();
  });
});

describe("payloadBullmq (CA-15)", () => {
  it("lleva solo jobId, tenantId y tipo", () => {
    const p = payloadBullmq({
      id: uuidDe(0x777),
      tenantId: T1,
      tipo: "test.encolar",
      clienteId: CLIENTE1,
      ruc: "20100000001",
      parametros: { claveSol: CANARIO },
      creadoPor: USUARIO,
    } as never);
    expect(p).toEqual({
      jobId: uuidDe(0x777),
      tenantId: T1,
      tipo: "test.encolar",
    });
    expect(Object.keys(p).sort()).toEqual(["jobId", "tenantId", "tipo"]);
    expect(JSON.stringify(p)).not.toContain("CANARIO");
  });
});
