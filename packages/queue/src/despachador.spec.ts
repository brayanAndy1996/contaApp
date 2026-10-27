import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
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

// Contrato (plan 008, Despachador; D2, D3, D4, D5, D17, D19; CA-2, CA-3, CA-4, CA-9, CA-14, CA-15):
//  new Despachador({ db, redis, reloj, prefijo, agregarACola }) con
//    - db: { withTenant, withSistema } (doble de soporte-pruebas/bd-falsa.ts; los repos de
//      @contapp/db estan mockeados con las firmas documentadas alli);
//    - reloj: { ahora(): Date };  prefijo: "p1:" (se antepone tal cual, ver claves.spec.ts);
//    - agregarACola(cola, payload): puerto para agregar a BullMQ (el indice de queue no importa
//      bullmq: el adaptador vive en `@contapp/queue/worker`). payload = { jobId, tenantId, tipo }.
//  `ciclo()`: por cada cola con config: toma o renueva el liderazgo (lider:{cola}, arriendo 30 s;
//  solo un despachador hace ciclos efectivos), recarga config_sistema (<= 10 s; si falla o trae
//  valores invalidos conserva la ultima valida), recorre en round-robin tenants:{cola} y por cada
//  tenant, en un withTenant propio (secuencial, NUNCA anidado), toma el siguiente en_cola y lo
//  despacha SOLO si hay cupo global, cupo del tenant y el lock de su RUC (por canal) esta libre.
//  Despachar = revalidar (D17) + credencial (CA-9) + transicionar(en_cola -> ejecutando) y, si gana,
//  tomar arriendos de 30 s (cupo:{cola}:{tenant}, cupo:{cola}, lock:ruc:{canal}:{ruc}) y llamar a
//  agregarACola FUERA del callback de withTenant. Quien no gana la transicion no toma nada.
//  Un `ciclo()` despacha como maximo un trabajo por tenant y cola.
const ARRIENDO_MS = 30_000;
const [TA, TB, TC] = [uuidDe(0xa1), uuidDe(0xb1), uuidDe(0xc1)];

registrarTipo({
  tipo: "test.sire",
  cola: "sire",
  canal: "sire",
  credencial: null,
  permiso: null,
  idempotente: true,
  parametros: z.object({}),
});
registrarTipo({
  tipo: "test.sol",
  cola: "sol",
  canal: "sol",
  credencial: "sol",
  permiso: null,
  idempotente: true,
  parametros: z.object({}),
});
registrarTipo({
  tipo: "test.sire.cred",
  cola: "sire",
  canal: "sire",
  credencial: "sire_api",
  permiso: null,
  idempotente: true,
  parametros: z.object({}),
});

let reloj: RelojFalso;
let redis: RedisFalso;
let agregados: { cola: string; payload: unknown; dentro: boolean }[];
let k: ReturnType<typeof crearClaves>;
let contadorRuc = 0;
let contadorTiempo = 0;

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

function ajustar(cola: string, cambios: Record<string, number>): void {
  Object.assign(bd.config.get(cola)!, cambios);
}

/** Siembra un trabajo en BD y la pista de Redis (lo que dejaria publicar()). */
async function sembrar(
  o: Partial<FilaTrabajo> & { tenantId: string },
): Promise<string> {
  contadorRuc++;
  contadorTiempo++;
  const cola = o.cola ?? "sire";
  const id = bd.siguienteId();
  const creadoEn =
    o.creadoEn ?? new Date(reloj.ms() - 3_600_000 + contadorTiempo);
  const fila: FilaTrabajo = {
    id,
    clienteId: uuidDe(0x2000 + contadorRuc),
    ruc: `2010${String(contadorRuc).padStart(7, "0")}`,
    tipo: cola === "sol" ? "test.sol" : "test.sire",
    cola,
    canal: cola === "sol" ? "sol" : "sire",
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

const ejecutando = (tenantId?: string): FilaTrabajo[] =>
  [...bd.trabajos.values()].filter(
    (f) =>
      f.estado === "ejecutando" &&
      (tenantId === undefined || f.tenantId === tenantId),
  );

/** Simula al ejecutor al terminar: libera cupos y deja el lock del RUC con PX = espera (D20). */
async function terminar(
  id: string,
  esperaMs = bd.config.get("sire")!.esperaRucMs,
): Promise<void> {
  const f = bd.trabajos.get(id)!;
  f.estado = "completado";
  await redis.zrem(k.cupoTenant(f.cola, f.tenantId), id);
  await redis.zrem(k.cupoGlobal(f.cola), id);
  await redis.set(k.lockRuc(f.canal, f.ruc), id, "PX", esperaMs);
}

beforeEach(() => {
  bd.reiniciar();
  reloj = new RelojFalso();
  redis = new RedisFalso(reloj);
  agregados = [];
  k = crearClaves("p1:");
  contadorRuc = 0;
  contadorTiempo = 0;
});

describe("despacho basico", () => {
  it("despacha un en_cola: ejecutando, payload minimo, arriendos y fuera de withTenant", async () => {
    const id = await sembrar({ tenantId: TA, creadoPor: uuidDe(0xe1) });
    const f = bd.trabajos.get(id)!;
    await nuevoDespachador().ciclo();

    expect(f.estado).toBe("ejecutando");
    expect(agregados).toHaveLength(1);
    expect(agregados[0]!.cola).toBe("sire");
    // CA-15: solo jobId, tenantId y tipo (nada de ruc, cliente, parametros ni usuario)
    expect(agregados[0]!.payload).toEqual({
      jobId: id,
      tenantId: TA,
      tipo: "test.sire",
    });
    // D3 / nota [004/008]: la cola externa se toca despues del commit, nunca dentro de withTenant
    expect(agregados[0]!.dentro).toBe(false);
    // arriendos de 30 s: cupo del tenant, cupo global y lock del RUC
    const vence = reloj.ms() + ARRIENDO_MS;
    expect(Number(await redis.zscore(k.cupoTenant("sire", TA), id))).toBe(
      vence,
    );
    expect(Number(await redis.zscore(k.cupoGlobal("sire"), id))).toBe(vence);
    expect(await redis.exists(k.lockRuc("sire", f.ruc))).toBe(1);
    // ya no esta pendiente en Redis
    expect(await redis.zscore(k.pend("sire", TA), id)).toBeNull();
  });

  it("abre un withTenant por estudio, en secuencia y solo con el tenantId del trabajo", async () => {
    await sembrar({ tenantId: TA });
    await sembrar({ tenantId: TB });
    await sembrar({ tenantId: TC });
    await nuevoDespachador().ciclo(); // no debe lanzar WithTenantAnidadoError
    expect(new Set(bd.ctxs)).toEqual(new Set([TA, TB, TC]));
    expect(
      agregados.map((a) => (a.payload as { tenantId: string }).tenantId).sort(),
    ).toEqual([TA, TB, TC].sort());
    expect(agregados.every((a) => !a.dentro)).toBe(true);
  });

  it("sin pendientes no hace nada ni lanza", async () => {
    await expect(nuevoDespachador().ciclo()).resolves.not.toThrow();
    expect(agregados).toHaveLength(0);
  });

  it("un tenant sin en_cola en BD (pista vieja en Redis) no rompe y se retira del conjunto", async () => {
    const id = await sembrar({ tenantId: TA });
    bd.trabajos.get(id)!.estado = "cancelado";
    await expect(nuevoDespachador().ciclo()).resolves.not.toThrow();
    expect(agregados).toHaveLength(0);
    expect(await redis.smembers(k.tenants("sire"))).not.toContain(TA);
  });

  it("al agotar los pendientes de un tenant lo saca de tenants:{cola}", async () => {
    await sembrar({ tenantId: TA });
    const d = nuevoDespachador();
    await d.ciclo();
    await d.ciclo();
    expect(await redis.smembers(k.tenants("sire"))).toEqual([]);
  });

  it("respeta disponibleDesde (un reintento con backoff no sale antes de tiempo)", async () => {
    const id = await sembrar({
      tenantId: TA,
      disponibleDesde: new Date(reloj.ms() + 5000),
    });
    const d = nuevoDespachador();
    await d.ciclo();
    expect(agregados).toHaveLength(0);
    reloj.avanzar(5000);
    // el ejecutor vuelve a publicar el reintento al re-encolarlo (plan: "se vuelve a publicar")
    await redis.sadd(k.tenants("sire"), TA);
    await d.ciclo();
    expect(bd.trabajos.get(id)!.estado).toBe("ejecutando");
  });
});

describe("cupos (CA-2, D19)", () => {
  it("el cupo del tenant limita: A con 10 trabajos nunca pasa de 2 en ejecucion", async () => {
    ajustar("sire", { concurrenciaGlobal: 4, concurrenciaTenant: 2 });
    for (let i = 0; i < 10; i++) await sembrar({ tenantId: TA });
    const d = nuevoDespachador();
    for (let i = 0; i < 6; i++) {
      await d.ciclo();
      expect(ejecutando(TA).length).toBeLessThanOrEqual(2);
    }
    expect(ejecutando(TA)).toHaveLength(2);
  });

  it("B (un solo trabajo) arranca mientras A esta en su tope, sin esperar a A", async () => {
    ajustar("sire", { concurrenciaGlobal: 4, concurrenciaTenant: 2 });
    for (let i = 0; i < 10; i++) await sembrar({ tenantId: TA });
    const d = nuevoDespachador();
    for (let i = 0; i < 3; i++) await d.ciclo();
    expect(ejecutando(TA)).toHaveLength(2);
    const idB = await sembrar({ tenantId: TB });
    await d.ciclo();
    expect(bd.trabajos.get(idB)!.estado).toBe("ejecutando");
    expect(ejecutando(TA)).toHaveLength(2); // A sigue en 2: nunca mas de la mitad
  });

  it("el cupo global limita entre estudios y el tercero entra al liberarse el primer cupo", async () => {
    ajustar("sire", { concurrenciaGlobal: 2, concurrenciaTenant: 1 });
    const ids = [
      await sembrar({ tenantId: TA }),
      await sembrar({ tenantId: TB }),
      await sembrar({ tenantId: TC }),
    ];
    const d = nuevoDespachador();
    await d.ciclo();
    await d.ciclo();
    expect(ejecutando()).toHaveLength(2);
    const enEspera = ids.find(
      (id) => bd.trabajos.get(id)!.estado === "en_cola",
    )!;
    const corriendo = ids.find(
      (id) => bd.trabajos.get(id)!.estado === "ejecutando",
    )!;
    await terminar(corriendo);
    await d.ciclo();
    expect(bd.trabajos.get(enEspera)!.estado).toBe("ejecutando");
    expect(ejecutando().length).toBeLessThanOrEqual(2);
  });

  it("el cupo de cola es por cola: llenar sire no bloquea sol", async () => {
    ajustar("sire", { concurrenciaGlobal: 1, concurrenciaTenant: 1 });
    await sembrar({ tenantId: TA });
    await sembrar({ tenantId: TB });
    const idSol = await sembrar({ tenantId: TA, cola: "sol" });
    await nuevoDespachador().ciclo();
    expect(ejecutando().filter((f) => f.cola === "sire")).toHaveLength(1);
    expect(bd.trabajos.get(idSol)!.estado).toBe("ejecutando");
  });
});

describe("round-robin entre estudios (CA-2)", () => {
  it("con 3 estudios y cupo de 1 se despacha A, B, C, A, B, C (en el mismo orden rotado)", async () => {
    ajustar("sire", { concurrenciaGlobal: 1, concurrenciaTenant: 1 });
    for (const t of [TA, TB, TC]) {
      await sembrar({ tenantId: t });
      await sembrar({ tenantId: t });
    }
    const d = nuevoDespachador();
    const orden: string[] = [];
    for (let i = 0; i < 6; i++) {
      await d.ciclo();
      const nuevos = ejecutando();
      expect(nuevos).toHaveLength(1);
      orden.push(nuevos[0]!.tenantId);
      await terminar(nuevos[0]!.id, 0);
    }
    expect(new Set(orden.slice(0, 3)).size).toBe(3); // los tres estudios antes de repetir
    expect(orden.slice(3)).toEqual(orden.slice(0, 3)); // y en el mismo orden
  });

  it("el estudio con 1,000 pendientes no desplaza al de 1: B sale en el primer ciclo con cupo", async () => {
    ajustar("sire", { concurrenciaGlobal: 2, concurrenciaTenant: 1 });
    for (let i = 0; i < 1000; i++) await sembrar({ tenantId: TA });
    const idB = await sembrar({ tenantId: TB });
    const d = nuevoDespachador();
    await d.ciclo();
    expect(bd.trabajos.get(idB)!.estado).toBe("ejecutando");
    expect(ejecutando(TA)).toHaveLength(1);
  });
});

describe("lock por RUC (CA-3, D20)", () => {
  const mismoRuc = "20100000001";

  it("dos trabajos del mismo RUC y canal nunca corren a la vez, ni desde dos estudios", async () => {
    const a = await sembrar({ tenantId: TA, ruc: mismoRuc });
    const b = await sembrar({ tenantId: TB, ruc: mismoRuc });
    const d = nuevoDespachador();
    await d.ciclo();
    await d.ciclo();
    expect(ejecutando()).toHaveLength(1);
    const primero = ejecutando()[0]!.id;
    expect([a, b]).toContain(primero);
  });

  it("tras terminar, el siguiente espera al menos espera_ruc_ms", async () => {
    ajustar("sire", { esperaRucMs: 2000 });
    const a = await sembrar({ tenantId: TA, ruc: mismoRuc });
    const b = await sembrar({ tenantId: TB, ruc: mismoRuc });
    const d = nuevoDespachador();
    await d.ciclo();
    const [primero, segundo] = ejecutando()[0]!.id === a ? [a, b] : [b, a];
    await terminar(primero!);
    await d.ciclo();
    expect(bd.trabajos.get(segundo!)!.estado).toBe("en_cola");
    reloj.avanzar(1999);
    await d.ciclo();
    expect(bd.trabajos.get(segundo!)!.estado).toBe("en_cola");
    reloj.avanzar(1);
    await d.ciclo();
    expect(bd.trabajos.get(segundo!)!.estado).toBe("ejecutando");
  });

  it("RUC distintos corren en paralelo", async () => {
    await sembrar({ tenantId: TA, ruc: "20100000001" });
    await sembrar({ tenantId: TB, ruc: "20100000002" });
    await nuevoDespachador().ciclo();
    expect(ejecutando()).toHaveLength(2);
  });

  it("el lock es por canal: el mismo RUC puede correr en SIRE y en SOL a la vez", async () => {
    await sembrar({ tenantId: TA, ruc: mismoRuc, cola: "sire" });
    await sembrar({ tenantId: TA, ruc: mismoRuc, cola: "sol" });
    await nuevoDespachador().ciclo();
    expect(ejecutando()).toHaveLength(2);
  });

  it("un lock ajeno ya tomado impide despachar y no consume cupo", async () => {
    const id = await sembrar({ tenantId: TA, ruc: mismoRuc });
    await redis.set(k.lockRuc("sire", mismoRuc), "otro", "PX", 10_000);
    await nuevoDespachador().ciclo();
    expect(bd.trabajos.get(id)!.estado).toBe("en_cola");
    expect(await redis.zcard(k.cupoGlobal("sire"))).toBe(0);
    expect(await redis.zcard(k.cupoTenant("sire", TA))).toBe(0);
  });
});

describe("arriendos vencidos (CA-10, D5)", () => {
  it("si el ejecutor muere, vencidos los 30 s el lock y el cupo quedan libres", async () => {
    ajustar("sire", { concurrenciaGlobal: 1, concurrenciaTenant: 1 });
    const ruc = "20100000001";
    await sembrar({ tenantId: TA, ruc });
    const d = nuevoDespachador();
    await d.ciclo(); // se despacha y el "proceso" muere: nadie renueva ni libera
    expect(agregados).toHaveLength(1);
    const otro = await sembrar({ tenantId: TB, ruc }); // mismo RUC y cupo global lleno
    reloj.avanzar(ARRIENDO_MS - 1);
    await d.ciclo();
    expect(bd.trabajos.get(otro)!.estado).toBe("en_cola");
    reloj.avanzar(2); // pasado el vencimiento (30 s + 1 ms)
    await d.ciclo();
    expect(bd.trabajos.get(otro)!.estado).toBe("ejecutando");
    expect(agregados).toHaveLength(2);
  });

  it("10 caidas seguidas no desfasan el contador de cupo", async () => {
    ajustar("sire", { concurrenciaGlobal: 1, concurrenciaTenant: 1 });
    const d = nuevoDespachador();
    for (let i = 0; i < 10; i++) {
      const id = await sembrar({ tenantId: TA });
      await d.ciclo();
      expect(bd.trabajos.get(id)!.estado).toBe("ejecutando");
      reloj.avanzar(ARRIENDO_MS + 1); // el proceso muere sin liberar
    }
    expect(agregados).toHaveLength(10);
    reloj.avanzar(ARRIENDO_MS + 1);
    expect(await redis.zcount(k.cupoGlobal("sire"), reloj.ms(), "+inf")).toBe(
      0,
    );
    expect(
      await redis.zcount(k.cupoTenant("sire", TA), reloj.ms(), "+inf"),
    ).toBe(0);
  });
});

describe("carrera con la cancelacion (CA-7, D2)", () => {
  it("si la transicion en_cola -> ejecutando pierde, no se agrega a la cola ni se toma nada", async () => {
    const id = await sembrar({ tenantId: TA });
    const f = bd.trabajos.get(id)!;
    bd.perdedores.add(id); // otro actor lo cancelo entre leer y transicionar
    await nuevoDespachador().ciclo();
    expect(agregados).toHaveLength(0);
    expect(f.estado).toBe("cancelado");
    expect(await redis.zcard(k.cupoGlobal("sire"))).toBe(0);
    expect(await redis.zcard(k.cupoTenant("sire", TA))).toBe(0);
    expect(await redis.exists(k.lockRuc("sire", f.ruc))).toBe(0);
  });

  it("un trabajo se despacha una sola vez aunque haya muchos ciclos", async () => {
    await sembrar({ tenantId: TA });
    const d = nuevoDespachador();
    for (let i = 0; i < 5; i++) await d.ciclo();
    expect(agregados).toHaveLength(1);
  });
});

describe("revalidacion al despachar (D17, CA-14)", () => {
  it("acceso retirado: cancelado/acceso_retirado, sin ejecutar y sin gastar cupo", async () => {
    ajustar("sire", { concurrenciaGlobal: 1, concurrenciaTenant: 1 });
    const retirado = await sembrar({ tenantId: TA, creadoPor: uuidDe(0xe1) });
    const siguiente = await sembrar({ tenantId: TA });
    bd.retirados.add(retirado);
    const d = nuevoDespachador();
    await d.ciclo();
    const f = bd.trabajos.get(retirado)!;
    expect(f.estado).toBe("cancelado");
    expect(f.motivo).toBe("acceso_retirado");
    expect(
      agregados.map((a) => (a.payload as { jobId: string }).jobId),
    ).not.toContain(retirado);
    expect(await redis.exists(k.lockRuc("sire", f.ruc))).toBe(0);
    await d.ciclo(); // el cupo no se gasto: el siguiente del mismo estudio entra
    expect(bd.trabajos.get(siguiente)!.estado).toBe("ejecutando");
  });
});

describe("credencial invalida (CA-9)", () => {
  it("cancela con credencial_invalida los trabajos del cliente que usan esa credencial", async () => {
    const clienteId = uuidDe(0x3001);
    const a = await sembrar({
      tenantId: TA,
      clienteId,
      tipo: "test.sire.cred",
    });
    const b = await sembrar({
      tenantId: TA,
      clienteId,
      tipo: "test.sire.cred",
    });
    bd.credencialInvalida.add(clienteId);
    const d = nuevoDespachador();
    await d.ciclo();
    await d.ciclo();
    for (const id of [a, b]) {
      expect(bd.trabajos.get(id)!.estado).toBe("cancelado");
      expect(bd.trabajos.get(id)!.motivo).toBe("credencial_invalida");
    }
    expect(agregados).toHaveLength(0);
  });

  it("no toca los trabajos de otros clientes ni los de tipos sin credencial", async () => {
    const malo = uuidDe(0x3001);
    const bueno = uuidDe(0x3002);
    bd.credencialInvalida.add(malo);
    const sinCredencial = await sembrar({
      tenantId: TA,
      clienteId: malo,
      tipo: "test.sire",
    });
    const otroCliente = await sembrar({
      tenantId: TA,
      clienteId: bueno,
      tipo: "test.sire.cred",
    });
    const d = nuevoDespachador();
    await d.ciclo();
    await d.ciclo();
    expect(bd.trabajos.get(sinCredencial)!.estado).toBe("ejecutando");
    expect(bd.trabajos.get(otroCliente)!.estado).toBe("ejecutando");
  });
});

describe("liderazgo por cola (D4)", () => {
  it("con dos despachadores solo uno despacha", async () => {
    await sembrar({ tenantId: TA });
    const d1 = nuevoDespachador();
    const d2 = nuevoDespachador();
    await d1.ciclo();
    await d2.ciclo();
    expect(agregados).toHaveLength(1);
    await sembrar({ tenantId: TB });
    await d2.ciclo(); // d1 sigue siendo el lider: d2 no despacha
    expect(agregados).toHaveLength(1);
    await d1.ciclo();
    expect(agregados).toHaveLength(2);
  });

  it("si el lider deja de renovar, otro toma el mando en <= 60 s", async () => {
    await sembrar({ tenantId: TA });
    const d1 = nuevoDespachador();
    const d2 = nuevoDespachador();
    await d1.ciclo(); // d1 lider y "muere"
    await sembrar({ tenantId: TB });
    reloj.avanzar(60_000);
    await d2.ciclo();
    expect(agregados).toHaveLength(2);
    expect((agregados[1]!.payload as { tenantId: string }).tenantId).toBe(TB);
  });

  it("el lider que sigue vivo conserva el mando entre ciclos (renueva)", async () => {
    const d1 = nuevoDespachador();
    const d2 = nuevoDespachador();
    await d1.ciclo();
    for (let i = 0; i < 5; i++) {
      reloj.avanzar(10_000);
      await d1.ciclo();
      await d2.ciclo();
    }
    await sembrar({ tenantId: TA });
    await d2.ciclo();
    expect(agregados).toHaveLength(0); // d2 nunca fue lider
    await d1.ciclo();
    expect(agregados).toHaveLength(1);
  });
});

describe("config_sistema sin reiniciar (CA-4)", () => {
  it("aplica un cambio de concurrencia en <= 10 s", async () => {
    ajustar("sire", { concurrenciaGlobal: 1, concurrenciaTenant: 1 });
    for (const t of [TA, TB, TC]) await sembrar({ tenantId: t });
    const d = nuevoDespachador();
    await d.ciclo();
    expect(ejecutando()).toHaveLength(1);
    ajustar("sire", { concurrenciaGlobal: 3, concurrenciaTenant: 1 });
    reloj.avanzar(10_000);
    await d.ciclo();
    expect(ejecutando()).toHaveLength(3);
  });

  it("si la lectura de config falla conserva la anterior (no abre ni cierra el grifo)", async () => {
    ajustar("sire", { concurrenciaGlobal: 1, concurrenciaTenant: 1 });
    for (const t of [TA, TB, TC]) await sembrar({ tenantId: t });
    const d = nuevoDespachador();
    await d.ciclo();
    expect(ejecutando()).toHaveLength(1);
    ajustar("sire", { concurrenciaGlobal: 3, concurrenciaTenant: 1 });
    bd.fallaConfig = true;
    reloj.avanzar(10_000);
    await expect(d.ciclo()).resolves.not.toThrow();
    expect(ejecutando()).toHaveLength(1); // sigue con global = 1
    bd.fallaConfig = false;
    reloj.avanzar(10_000);
    await d.ciclo();
    expect(ejecutando()).toHaveLength(3);
  });

  it.each([
    ["cero", { concurrenciaGlobal: 0, concurrenciaTenant: 0 }],
    ["negativos", { concurrenciaGlobal: -3, concurrenciaTenant: -1 }],
    ["enormes", { concurrenciaGlobal: 100_000, concurrenciaTenant: 50_000 }],
    [
      "tenant mayor que global/2",
      { concurrenciaGlobal: 4, concurrenciaTenant: 4 },
    ],
    [
      "no numericos",
      { concurrenciaGlobal: Number.NaN, concurrenciaTenant: Number.NaN },
    ],
  ])(
    "valores %s se rechazan y se conserva el ultimo valido (global 2, tenant 1)",
    async (_n, malos) => {
      ajustar("sire", { concurrenciaGlobal: 2, concurrenciaTenant: 1 });
      for (const t of [TA, TB, TC]) {
        await sembrar({ tenantId: t });
        await sembrar({ tenantId: t });
      }
      const d = nuevoDespachador();
      await d.ciclo();
      expect(ejecutando()).toHaveLength(2);
      ajustar("sire", malos);
      reloj.avanzar(10_000);
      const [uno] = ejecutando();
      await terminar(uno!.id, 0);
      for (let i = 0; i < 4; i++) {
        await d.ciclo();
        expect(ejecutando().length).toBeLessThanOrEqual(2); // global valido = 2
        expect(ejecutando().length).toBeGreaterThanOrEqual(1);
      }
      // el que quedo libre se repuso: con "cero" se habria quedado sin despachar
      expect(ejecutando()).toHaveLength(2);
    },
  );
});
