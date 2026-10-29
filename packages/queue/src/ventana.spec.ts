import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as queue from "./index.js";
import { Despachador, crearClaves, registrarTipo } from "./index.js";
import {
  bd,
  dbFalsa,
  uuidDe,
  type FilaTrabajo,
  type PrioridadFalsa,
} from "./soporte-pruebas/bd-falsa.js";
import { RedisFalso } from "./soporte-pruebas/redis-falso.js";
import { RelojFalso } from "./soporte-pruebas/reloj-falso.js";

vi.mock(
  "@contapp/db",
  async () => (await import("./soporte-pruebas/bd-falsa.js")).moduloDbFalso,
);

// T9c (plan 008, "Ventana de candidatos (D21)"; spec CA-2, CA-3, D21), en ROJO hasta T9d.
// Contrato (ademas del de despachador.spec.ts, que no cambia):
//  - `VENTANA_CANDIDATOS = 20` exportado por @contapp/queue.
//  - Por estudio y cola, dentro de su withTenant, el despachador (1) sin cupo global ni del estudio NO lee
//    candidatos; (2) lee `siguientesDisponibles(tx, cola, ahora, 20)` (doble: bd.ventanas) y recorre la
//    ventana en orden. Un candidato cuyo RUC ya se vio ocupado en el ciclo, o cuyo `lock:ruc:{canal}:{ruc}`
//    existe (EXISTS), se salta SIN revalidar ni tocar el trabajo; (3) con el primer RUC libre revalida (D17) y
//    comprueba la credencial (CA-9): si se cancela, sigue con el siguiente (no gasta el despacho); si no, toma
//    el lock (SET NX PX) y, si lo pierde, lo trata como ocupado y sigue; con el lock hace en_cola -> ejecutando
//    y, si pierde la transicion, suelta el lock y sigue; (4) como maximo un despacho por estudio y cola en cada
//    `ciclo()` y cada candidato se revisa una sola vez; (5) ventana agotada sin despachar: ese estudio no
//    despacha en el ciclo y el round-robin sigue con el siguiente. Canal `ninguno`: sin lock, nunca se salta.
const [TA, TB] = [uuidDe(0xa1), uuidDe(0xb1)];
const VENTANA = 20;

registrarTipo({
  tipo: "test.ven.sire",
  cola: "sire",
  canal: "sire",
  credencial: null,
  permiso: null,
  idempotente: true,
  parametros: z.object({}),
});
registrarTipo({
  tipo: "test.ven.cred",
  cola: "sire",
  canal: "sire",
  credencial: "sire_api",
  permiso: null,
  idempotente: true,
  parametros: z.object({}),
});
registrarTipo({
  tipo: "test.ven.ninguno",
  cola: "sire",
  canal: "ninguno",
  credencial: null,
  permiso: null,
  idempotente: true,
  parametros: z.object({}),
});

let reloj: RelojFalso;
let redis: RedisFalso;
let agregados: { cola: string; payload: unknown; dentro: boolean }[];
let k: ReturnType<typeof crearClaves>;
let contador = 0;

const nuevoDespachador = (): Despachador =>
  new Despachador({
    db: dbFalsa as never,
    redis: redis as never,
    reloj,
    prefijo: "p1:",
    agregarACola: async (cola: string, payload: unknown) => {
      agregados.push({ cola, payload, dentro: bd.dentro });
    },
  });

/** Siembra un trabajo en BD y la pista de Redis. `ruc` por defecto distinto en cada llamada. */
async function sembrar(
  o: Partial<FilaTrabajo> & { tenantId: string },
): Promise<string> {
  contador++;
  const id = bd.siguienteId();
  const creadoEn = o.creadoEn ?? new Date(reloj.ms() - 3_600_000 + contador);
  const fila: FilaTrabajo = {
    id,
    clienteId: uuidDe(0x2000 + contador),
    ruc: `2010${String(contador).padStart(7, "0")}`,
    tipo: "test.ven.sire",
    cola: "sire",
    canal: "sire",
    prioridad: "interactivo" as PrioridadFalsa,
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
  bd.trabajos.set(id, fila);
  await redis.sadd(k.tenants(fila.cola), fila.tenantId);
  await redis.zadd(
    k.pend(fila.cola, fila.tenantId),
    fila.prioridad === "interactivo" ? 0 : 1,
    id,
  );
  return id;
}

const estado = (id: string): string => bd.trabajos.get(id)!.estado;
const ejecutando = (tenantId?: string): FilaTrabajo[] =>
  [...bd.trabajos.values()].filter(
    (f) =>
      f.estado === "ejecutando" &&
      (tenantId === undefined || f.tenantId === tenantId),
  );
const jobsAgregados = (): string[] =>
  agregados.map((a) => (a.payload as { jobId: string }).jobId);

/** Otro proceso ya tiene el RUC (lock vivo por mucho mas que un ciclo). */
const ocupar = (ruc: string, canal = "sire"): Promise<"OK" | null> =>
  redis.set(k.lockRuc(canal, ruc), "otro", "PX", 600_000);

const rucDe = (id: string): string => bd.trabajos.get(id)!.ruc;

/** Lecturas EXISTS sobre el lock de un RUC (cuantas veces se consulto en Redis). */
const consultasDelLock = (spy: { mock: { calls: unknown[][] } }, ruc: string) =>
  spy.mock.calls.filter((c) => c.includes(k.lockRuc("sire", ruc))).length;

beforeEach(() => {
  bd.reiniciar();
  reloj = new RelojFalso();
  redis = new RedisFalso(reloj);
  agregados = [];
  k = crearClaves("p1:");
  contador = 0;
});

describe("constante de la ventana (D21)", () => {
  it("VENTANA_CANDIDATOS = 20", () => {
    expect((queue as Record<string, unknown>).VENTANA_CANDIDATOS).toBe(VENTANA);
  });
});

describe("RUC ocupado al frente (CA-3, D21)", () => {
  it("el primer candidato con RUC ocupado no frena al estudio: despacha el siguiente de RUC libre", async () => {
    const ocupado = await sembrar({ tenantId: TA });
    const libre = await sembrar({ tenantId: TA });
    await ocupar(rucDe(ocupado));
    await nuevoDespachador().ciclo();

    expect(estado(libre)).toBe("ejecutando");
    expect(jobsAgregados()).toEqual([libre]);
    expect(agregados[0]!.payload).toEqual({
      jobId: libre,
      tenantId: TA,
      tipo: "test.ven.sire",
    });
    // el ocupado sigue en cola, intacto: ni transicion, ni revalidacion, ni cupo, ni evento
    expect(estado(ocupado)).toBe("en_cola");
    expect(bd.trabajos.get(ocupado)!.motivo).toBeNull();
    expect(bd.transiciones.some((t) => t.id === ocupado)).toBe(false);
    expect(
      bd.revalidaciones.some((r) => r.args.id === ocupado),
      "no revalida al que salta",
    ).toBe(false);
    expect(await redis.zscore(k.pend("sire", TA), ocupado)).not.toBeNull();
    expect(await redis.zscore(k.cupoGlobal("sire"), ocupado)).toBeNull();
    expect(await redis.get(k.lockRuc("sire", rucDe(ocupado)))).toBe("otro");
    expect(
      redis.publicados.some((p) => p.mensaje.includes(ocupado)),
      "saltar no publica eventos",
    ).toBe(false);
  });

  it("con el RUC liberado el candidato saltado sale en un ciclo posterior (saltar no acorta la espera)", async () => {
    const ocupado = await sembrar({ tenantId: TA });
    await sembrar({ tenantId: TA });
    await ocupar(rucDe(ocupado));
    const d = nuevoDespachador();
    await d.ciclo();
    expect(estado(ocupado)).toBe("en_cola");
    await redis.del(k.lockRuc("sire", rucDe(ocupado)));
    await d.ciclo();
    expect(estado(ocupado)).toBe("ejecutando");
  });

  it("la ventana se pide con limite = 20, una vez por estudio y cola", async () => {
    await sembrar({ tenantId: TA });
    await nuevoDespachador().ciclo();
    expect(bd.ventanas).toEqual([{ tenantId: TA, cola: "sire", limite: 20 }]);
  });
});

describe("prioridad dentro de la ventana (CA-2)", () => {
  it("un interactivo de RUC libre sale antes que un programado mas viejo", async () => {
    const programado = await sembrar({
      tenantId: TA,
      prioridad: "programado",
      creadoEn: new Date(reloj.ms() - 7_200_000),
    });
    const interactivo = await sembrar({ tenantId: TA });
    await nuevoDespachador().ciclo();
    expect(jobsAgregados()).toEqual([interactivo]);
    expect(estado(programado)).toBe("en_cola");
  });

  it("un programado sale si todos los interactivos de la ventana tienen el RUC ocupado", async () => {
    const i1 = await sembrar({ tenantId: TA });
    const i2 = await sembrar({ tenantId: TA });
    const programado = await sembrar({ tenantId: TA, prioridad: "programado" });
    await ocupar(rucDe(i1));
    await ocupar(rucDe(i2));
    await nuevoDespachador().ciclo();
    expect(jobsAgregados()).toEqual([programado]);
    expect(estado(i1)).toBe("en_cola");
    expect(estado(i2)).toBe("en_cola");
  });

  it("un interactivo con RUC ocupado no frena a otro interactivo libre ni a un programado detras", async () => {
    const bloqueado = await sembrar({ tenantId: TA });
    const interactivoLibre = await sembrar({ tenantId: TA });
    const programado = await sembrar({ tenantId: TA, prioridad: "programado" });
    await ocupar(rucDe(bloqueado));
    const d = nuevoDespachador();
    await d.ciclo();
    expect(jobsAgregados()).toEqual([interactivoLibre]);
    await d.ciclo(); // un segundo ciclo (cupo del estudio = 2): ahora el programado
    expect(jobsAgregados()).toEqual([interactivoLibre, programado]);
    expect(estado(bloqueado)).toBe("en_cola");
  });
});

describe("limite de la ventana (D21)", () => {
  it("con 20 candidatos de RUC ocupado y el libre en el puesto 21 no despacha nada en ese ciclo", async () => {
    const ids: string[] = [];
    for (let i = 0; i < VENTANA; i++) {
      const id = await sembrar({ tenantId: TA });
      await ocupar(rucDe(id));
      ids.push(id);
    }
    const puesto21 = await sembrar({ tenantId: TA });
    await nuevoDespachador().ciclo();

    expect(agregados).toHaveLength(0);
    expect(estado(puesto21)).toBe("en_cola");
    for (const id of ids) expect(estado(id)).toBe("en_cola");
    expect(bd.ventanas).toEqual([{ tenantId: TA, cola: "sire", limite: 20 }]);
    expect(bd.revalidaciones).toHaveLength(0);
    expect(bd.transiciones).toHaveLength(0);
    expect(await redis.zcard(k.cupoGlobal("sire"))).toBe(0);
    expect(await redis.zcard(k.cupoTenant("sire", TA))).toBe(0);
  });

  it("el round-robin pasa al siguiente estudio aunque la ventana del primero se agote", async () => {
    for (let i = 0; i < VENTANA; i++) {
      await ocupar(rucDe(await sembrar({ tenantId: TA })));
    }
    const deB = await sembrar({ tenantId: TB });
    await nuevoDespachador().ciclo();
    expect(jobsAgregados()).toEqual([deB]);
    expect(ejecutando(TA)).toHaveLength(0);
    expect(bd.ctxs).toEqual([TA, TB]); // un withTenant por estudio, en secuencia
  });

  it("con 19 ocupados y el libre en el puesto 20 si despacha", async () => {
    for (let i = 0; i < VENTANA - 1; i++) {
      await ocupar(rucDe(await sembrar({ tenantId: TA })));
    }
    const puesto20 = await sembrar({ tenantId: TA });
    await nuevoDespachador().ciclo();
    expect(jobsAgregados()).toEqual([puesto20]);
  });
});

describe("cupos antes de leer candidatos (CA-2, D19)", () => {
  it("sin cupo del estudio no lee candidatos", async () => {
    ajustarCupos({ concurrenciaGlobal: 4, concurrenciaTenant: 1 });
    for (let i = 0; i < 3; i++) await sembrar({ tenantId: TA });
    const d = nuevoDespachador();
    await d.ciclo();
    expect(bd.ventanas).toHaveLength(1); // el primer ciclo si lee la ventana
    await d.ciclo(); // cupo del estudio lleno: ya no
    await d.ciclo();
    expect(bd.ventanas).toHaveLength(1);
    expect(ejecutando(TA)).toHaveLength(1);
  });

  it("sin cupo global no lee candidatos de los demas estudios", async () => {
    ajustarCupos({ concurrenciaGlobal: 1, concurrenciaTenant: 1 });
    await sembrar({ tenantId: TA });
    await sembrar({ tenantId: TB });
    await nuevoDespachador().ciclo();
    expect(bd.ventanas.map((v) => v.tenantId)).toEqual([TA]);
    expect(ejecutando()).toHaveLength(1);
  });
});

describe("candidatos cancelados al despachar (D17, CA-9, CA-14)", () => {
  it("un cancelado por acceso retirado no gasta el despacho: se sigue con el siguiente", async () => {
    const retirado = await sembrar({ tenantId: TA, creadoPor: uuidDe(0xe1) });
    const siguiente = await sembrar({ tenantId: TA });
    bd.retirados.add(retirado);
    await nuevoDespachador().ciclo();

    expect(bd.trabajos.get(retirado)).toMatchObject({
      estado: "cancelado",
      motivo: "acceso_retirado",
    });
    expect(jobsAgregados()).toEqual([siguiente]);
    expect(estado(siguiente)).toBe("ejecutando");
    expect(await redis.exists(k.lockRuc("sire", rucDe(retirado)))).toBe(0);
    expect(await redis.zscore(k.pend("sire", TA), retirado)).toBeNull();
    const evento = redis.publicados.find((p) => p.mensaje.includes(retirado));
    expect(JSON.parse(evento!.mensaje)).toMatchObject({
      id: retirado,
      estado: "cancelado",
      motivo: "acceso_retirado",
    });
  });

  it("un cancelado por credencial invalida tampoco gasta el despacho", async () => {
    const sinCredencial = await sembrar({
      tenantId: TA,
      tipo: "test.ven.cred",
    });
    const siguiente = await sembrar({ tenantId: TA });
    bd.credencialInvalida.add(bd.trabajos.get(sinCredencial)!.clienteId);
    await nuevoDespachador().ciclo();

    expect(bd.trabajos.get(sinCredencial)).toMatchObject({
      estado: "cancelado",
      motivo: "credencial_invalida",
    });
    expect(jobsAgregados()).toEqual([siguiente]);
    expect(await redis.exists(k.lockRuc("sire", rucDe(sinCredencial)))).toBe(0);
  });

  it("varios cancelados seguidos y un ocupado en medio: despacha el primero libre y valido", async () => {
    const a = await sembrar({ tenantId: TA, creadoPor: uuidDe(0xe1) });
    const ocupado = await sembrar({ tenantId: TA });
    const b = await sembrar({ tenantId: TA, creadoPor: uuidDe(0xe2) });
    const bueno = await sembrar({ tenantId: TA });
    bd.retirados.add(a);
    bd.retirados.add(b);
    await ocupar(rucDe(ocupado));
    await nuevoDespachador().ciclo();
    expect([estado(a), estado(b)]).toEqual(["cancelado", "cancelado"]);
    expect(estado(ocupado)).toBe("en_cola");
    expect(jobsAgregados()).toEqual([bueno]);
  });

  it("si la ventana se agota solo con cancelados no despacha, revisa a cada uno una vez y no lanza", async () => {
    const ids = [
      await sembrar({ tenantId: TA, creadoPor: uuidDe(0xe1) }),
      await sembrar({ tenantId: TA, creadoPor: uuidDe(0xe2) }),
      await sembrar({ tenantId: TA, creadoPor: uuidDe(0xe3) }),
    ];
    for (const id of ids) bd.retirados.add(id);
    await expect(nuevoDespachador().ciclo()).resolves.not.toThrow();
    expect(agregados).toHaveLength(0);
    for (const id of ids) {
      expect(estado(id)).toBe("cancelado");
      expect(bd.revalidaciones.filter((r) => r.args.id === id)).toHaveLength(1);
    }
    expect(bd.ventanas).toHaveLength(1);
  });
});

describe("carreras con Redis y con la cancelacion (D2, D20)", () => {
  it("lock perdido en SET NX: lo trata como ocupado y sigue; no vuelve a intentar ese RUC en el ciclo", async () => {
    const perdido = await sembrar({ tenantId: TA });
    // otro candidato del mismo RUC detras del perdido: se salta sin tocar el lock
    const mismoRuc = await sembrar({ tenantId: TA, ruc: rucDe(perdido) });
    const libre = await sembrar({ tenantId: TA });
    const claveLock = k.lockRuc("sire", rucDe(perdido));
    const real = redis.set.bind(redis);
    const set = vi
      .spyOn(redis, "set")
      .mockImplementation(async (clave, valor, ...resto) =>
        clave === claveLock ? null : real(clave, valor, ...resto),
      );
    await nuevoDespachador().ciclo();

    expect(jobsAgregados()).toEqual([libre]);
    expect(estado(perdido)).toBe("en_cola");
    expect(estado(mismoRuc)).toBe("en_cola");
    expect(set.mock.calls.filter((c) => c[0] === claveLock)).toHaveLength(1);
    expect(bd.transiciones.some((t) => t.id === perdido)).toBe(false);
    expect(await redis.zscore(k.cupoGlobal("sire"), perdido)).toBeNull();
  });

  it("transicion perdida (lo cancelaron): suelta el lock que habia tomado y sigue con el siguiente", async () => {
    const cancelado = await sembrar({ tenantId: TA });
    const siguiente = await sembrar({ tenantId: TA });
    bd.perdedores.add(cancelado);
    await nuevoDespachador().ciclo();

    expect(estado(cancelado)).toBe("cancelado");
    expect(await redis.exists(k.lockRuc("sire", rucDe(cancelado)))).toBe(0);
    expect(await redis.zscore(k.cupoGlobal("sire"), cancelado)).toBeNull();
    expect(await redis.zscore(k.pend("sire", TA), cancelado)).toBeNull();
    expect(jobsAgregados()).toEqual([siguiente]);
    expect(estado(siguiente)).toBe("ejecutando");
    expect(await redis.exists(k.lockRuc("sire", rucDe(siguiente)))).toBe(1);
  });
});

describe("un despacho por estudio y cola en cada ciclo", () => {
  it("con muchos candidatos libres y cupo de sobra despacha uno por ciclo", async () => {
    ajustarCupos({ concurrenciaGlobal: 8, concurrenciaTenant: 4 });
    for (let i = 0; i < 5; i++) await sembrar({ tenantId: TA });
    const d = nuevoDespachador();
    await d.ciclo();
    expect(ejecutando(TA)).toHaveLength(1);
    expect(agregados).toHaveLength(1);
    await d.ciclo();
    expect(ejecutando(TA)).toHaveLength(2);
  });

  it("uno por cola: el mismo estudio despacha en sire y en sol en el mismo ciclo", async () => {
    await sembrar({ tenantId: TA });
    await sembrar({ tenantId: TA });
    await sembrar({
      tenantId: TA,
      cola: "sol",
      canal: "sol",
      tipo: "test.ven.sire", // el tipo no importa para el despacho; la cola sale de la fila
    });
    await nuevoDespachador().ciclo();
    expect(ejecutando(TA).filter((f) => f.cola === "sire")).toHaveLength(1);
    expect(ejecutando(TA).filter((f) => f.cola === "sol")).toHaveLength(1);
  });
});

describe("consultas a Redis por RUC (CA-3, D21)", () => {
  it("un RUC ocupado se consulta una sola vez por ciclo aunque lo repitan varios candidatos", async () => {
    const primero = await sembrar({ tenantId: TA });
    const ruc = rucDe(primero);
    for (let i = 0; i < 5; i++) await sembrar({ tenantId: TA, ruc });
    const libre = await sembrar({ tenantId: TA });
    await ocupar(ruc);
    const exists = vi.spyOn(redis, "exists");
    const set = vi.spyOn(redis, "set");
    await nuevoDespachador().ciclo();

    expect(jobsAgregados()).toEqual([libre]);
    expect(consultasDelLock(exists, ruc)).toBe(1);
    expect(
      set.mock.calls.filter((c) => c[0] === k.lockRuc("sire", ruc)),
      "saltar no toma ni intenta tomar el lock",
    ).toHaveLength(0);
    expect(bd.revalidaciones).toHaveLength(1); // solo el candidato libre
  });

  it("RUC distintos se consultan cada uno una vez (a lo mas 20 EXISTS por ventana)", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = await sembrar({ tenantId: TA });
      await ocupar(rucDe(id));
      ids.push(id);
    }
    await sembrar({ tenantId: TA });
    const exists = vi.spyOn(redis, "exists");
    await nuevoDespachador().ciclo();
    for (const id of ids) expect(consultasDelLock(exists, rucDe(id))).toBe(1);
  });

  it("canal ninguno no usa lock: no se salta por RUC y no crea ni consulta locks", async () => {
    const ruc = "20999999999";
    await ocupar(ruc); // un trabajo SIRE de ese RUC corre en otro lado
    const sinCanal = await sembrar({
      tenantId: TA,
      tipo: "test.ven.ninguno",
      canal: "ninguno",
      ruc,
    });
    const exists = vi.spyOn(redis, "exists");
    await nuevoDespachador().ciclo();

    expect(jobsAgregados()).toEqual([sinCanal]);
    expect(
      redis.claves().filter((c) => c.includes("lock:ruc:ninguno")),
    ).toHaveLength(0);
    expect(await redis.get(k.lockRuc("sire", ruc))).toBe("otro");
    expect(
      exists.mock.calls.filter((c) => String(c[0]).includes("lock:ruc")),
    ).toHaveLength(0);
  });
});

describe("RUC compartido entre dos estudios (D20, CA-3)", () => {
  it("el estudio que tiene el RUC ocupado no frena los otros RUC del otro estudio", async () => {
    const compartido = "20555555555";
    const deA = await sembrar({ tenantId: TA, ruc: compartido });
    const deBBloqueado = await sembrar({ tenantId: TB, ruc: compartido });
    const deBLibre = await sembrar({ tenantId: TB });
    await nuevoDespachador().ciclo();

    // A tomo el RUC compartido; B salta su cabeza y despacha su otro RUC en el mismo ciclo
    expect(estado(deA)).toBe("ejecutando");
    expect(estado(deBBloqueado)).toBe("en_cola");
    expect(estado(deBLibre)).toBe("ejecutando");
    expect(
      ejecutando().filter((f) => f.ruc === compartido),
      "nunca dos del mismo RUC a la vez",
    ).toHaveLength(1);
    expect(bd.revalidaciones.some((r) => r.args.id === deBBloqueado)).toBe(
      false,
    );
  });

  it("al reves: el RUC ocupado por B (otro estudio) tampoco deja sin despacho a A", async () => {
    const compartido = "20555555556";
    const deA1 = await sembrar({ tenantId: TA, ruc: compartido });
    const deA2 = await sembrar({ tenantId: TA });
    await redis.set(k.lockRuc("sire", compartido), "de-B", "PX", 30_000);
    await nuevoDespachador().ciclo();
    expect(estado(deA1)).toBe("en_cola");
    expect(estado(deA2)).toBe("ejecutando");
  });
});

// T9e (plan 008, "Ventana de candidatos (D21)" (5) y "Ratificaciones de T5/T6" (7)), en ROJO hasta T10.
// El puntero del round-robin solo lo mueve un estudio que DESPACHA: los ciclos con el RUC compartido ocupado (ventanas agotadas
// en ambos estudios) no cambian quién sale después. Cupos por defecto de sire (4 global / 2 por estudio).
describe("round-robin con RUC compartido entre dos estudios (T9e, CA-2, CA-3, RNF-041)", () => {
  const compartido = "20777777777";

  /** Termina el trabajo despachado: estado final, cupos devueltos y lock del RUC liberado. */
  async function terminar(id: string): Promise<void> {
    const f = bd.trabajos.get(id)!;
    f.estado = "completado";
    await redis.zrem(k.cupoGlobal("sire"), id);
    await redis.zrem(k.cupoTenant("sire", f.tenantId), id);
    await redis.del(k.lockRuc("sire", compartido));
  }

  /** Un ciclo con el lock libre: devuelve el estudio que inició (o null) y lo termina. */
  async function liberarYDespachar(d: Despachador): Promise<string | null> {
    await redis.del(k.lockRuc("sire", compartido));
    await d.ciclo();
    const iniciados = ejecutando();
    if (iniciados.length === 0) return null;
    expect(iniciados, "nunca dos del mismo RUC a la vez").toHaveLength(1);
    const f = iniciados[0]!;
    await terminar(f.id);
    return f.tenantId;
  }

  async function sembrarAmbos(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await sembrar({ tenantId: TA, ruc: compartido });
      await sembrar({ tenantId: TB, ruc: compartido });
    }
  }

  it("con 3 trabajos por estudio y ciclos con el lock ocupado entre cada inicio, los inicios alternan entre estudios", async () => {
    await sembrarAmbos(3);
    const d = nuevoDespachador();
    const orden: string[] = [];
    for (let ronda = 0; ronda < 6; ronda++) {
      await ocupar(compartido);
      for (let i = 0; i < 2; i++) {
        await d.ciclo();
        expect(ejecutando(), "con el RUC ocupado no inicia nadie").toHaveLength(
          0,
        );
      }
      const quien = await liberarYDespachar(d);
      expect(quien, `ronda ${ronda}: debe iniciar alguien`).not.toBeNull();
      orden.push(quien === TA ? "A" : "B");
    }
    expect(orden.filter((x) => x === "A")).toHaveLength(3);
    for (let i = 1; i < orden.length; i++) {
      expect(
        orden[i],
        `posición ${i} de ${orden.join("")}: no dos seguidos del mismo estudio con el otro pendiente`,
      ).not.toBe(orden[i - 1]);
    }
  });

  it.each([1, 2, 3])(
    "%i ciclos con el RUC ocupado después de que sale A no cambian quién sale después: sale B",
    async (bloqueados) => {
      await sembrarAmbos(3);
      const d = nuevoDespachador();
      const primero = await liberarYDespachar(d);
      expect(
        primero,
        "sin historia, el round-robin empieza por el primer estudio",
      ).toBe(TA);

      await ocupar(compartido);
      for (let i = 0; i < bloqueados; i++) {
        await d.ciclo(); // ambas ventanas se agotan: el puntero no se mueve
        expect(ejecutando()).toHaveLength(0);
      }
      expect(await liberarYDespachar(d), "toca al otro estudio").toBe(TB);
      expect(await liberarYDespachar(d), "y luego otra vez al primero").toBe(
        TA,
      );
    },
  );
});

function ajustarCupos(cambios: Record<string, number>): void {
  Object.assign(bd.config.get("sire")!, cambios);
}
