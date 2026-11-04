/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 007b (T4, rojo): el alta y la importación encolan `cliente.consultar_ruc` (D1, CA-9 en su parte del backend;
// plan: «Carga de la cola»). El worker lo ejecuta (T5/T9); aquí solo lo que hace el backend:
//  - POST /clientes y POST /clientes/importacion/confirmar encolan un trabajo `cliente.consultar_ruc` por cliente creado
//    (cola `xml`, canal `ninguno`, prioridad `programado`, parámetros `{}`, `creado_por` el usuario) DESPUÉS del commit; la
//    fila queda en la BD y la pista en Redis. El contrato HTTP del alta no cambia (mismo `ClienteDto`).
//  - Si encolar falla (Redis caído, cola con reserva agotada) el alta y la importación NO fallan: el cliente existe con la
//    razón social provisional y el informe lo cuenta en `consultasOmitidas` (P2: no hay forma de repetirlo en R1).
//  - Reserva del 50 %: solo se encola mientras los pendientes de la cola `xml` del estudio sean < `max_pendientes_tenant / 2`
//    (1.000 con los valores de 008); el resto se omite para no agotar el tope que necesitan `xml.obtener` (012/016).
//  - `Encolador.encolarLote` inserta de 100 en 100 (cada lote en su propia `withTenant`) y publica la pista y el evento
//    `en_cola` tras cada commit: con 250 clientes quedan 250 filas, 250 pistas y 250 eventos, sin tope de 100.
// Rojo: el alta aún no encola (T12) y el informe de la importación aún no existe.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { observarEventos, URL_REDIS_CAIDO } from "../../../test/soporte-trabajos.js";
import {
  abrirBancoCola,
  pedirBin,
  type Actor,
  type BancoCola,
  type Estudio,
} from "../../../test/soporte-credenciales.js";
import { rucConPrefijo, xlsxConDatos } from "../../../test/soporte-importacion.js";

const CONFIRMAR = "/clientes/importacion/confirmar";
const TIPO = "cliente.consultar_ruc";
const CLAVES_DTO = [
  "archivado",
  "condicionContribuyente",
  "credenciales",
  "estadoContribuyente",
  "id",
  "perfil",
  "razonSocial",
  "responsable",
  "ruc",
];
let b: BancoCola;
let serie = 3_000_000 + (process.pid % 997) * 1000;
const rucs = (n: number) => Array.from({ length: n }, () => rucConPrefijo("20", serie++));
const archivo = (lista: string[]) => xlsxConDatos(lista.map((ruc) => ({ ruc })));
const confirmar = (bnc: BancoCola, a: Actor, bytes: Uint8Array) => pedirBin(bnc.c.p.b.h, a, "POST", CONFIRMAR, bytes);
const esperarHasta = async <T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> => {
  const fin = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > fin) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
};

beforeAll(async () => {
  b = await abrirBancoCola();
});
afterAll(async () => {
  await b?.cerrar();
});

describe("CA-9 · el alta encola la consulta de RUC sin cambiar su contrato", () => {
  it("201 con el mismo ClienteDto y un trabajo cliente.consultar_ruc programado, en la cola xml, con su pista en Redis", async () => {
    const E = await b.estudio();
    const ruc = rucs(1)[0]!;
    const r = await b.c.crear(E.titular, { ruc });
    expect(r.status, r.text).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(CLAVES_DTO);
    expect(r.body.razonSocial).toBe(`RUC ${ruc}`); // provisional hasta que el worker la complete
    const filas = await esperarHasta(() => b.trabajos(E.tenantId, TIPO), (f) => f.length >= 1);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      tenant_id: E.tenantId,
      cliente_id: r.body.id,
      ruc: ruc,
      cola: "xml",
      canal: "ninguno",
      prioridad: "programado",
      estado: "en_cola",
      creado_por: E.titular.id,
      parametros: {},
    });
    expect(await b.redis.zscore(b.claves.pend("xml", E.tenantId), filas[0].id)).not.toBeNull();
    // Visible en el panel del estudio.
    const lista = await b.c.p.b.llamar(E.titular, "GET", `/trabajos?clienteId=${r.body.id}`);
    expect(lista.body.map((t: any) => t.tipo)).toContain(TIPO);
  });

  it("un alta rechazada (RUC inválido, duplicado o sin cupo) no encola nada", async () => {
    const E = await b.estudioCon(1);
    const [uno, dos] = rucs(2) as [string, string];
    expect((await b.c.crear(E.titular, { ruc: uno })).status).toBe(201);
    await esperarHasta(() => b.trabajos(E.tenantId, TIPO), (f) => f.length >= 1);
    expect((await b.c.crear(E.titular, { ruc: uno })).status).toBe(409); // ruc_duplicado
    expect((await b.c.crear(E.titular, { ruc: dos })).status).toBe(409); // cupo_rucs
    expect((await b.c.crear(E.titular, { ruc: "123" })).status).toBe(400);
    await new Promise((r) => setTimeout(r, 300));
    expect(await b.trabajos(E.tenantId, TIPO)).toHaveLength(1);
  });

  it("la importación encola una consulta por cliente creado (programado, xml) y las cuenta en el informe", async () => {
    const E = await b.estudio();
    const lista = rucs(3);
    const obs = await observarEventos(b.prefijo, E.tenantId);
    try {
      const r = await confirmar(b, E.titular, archivo(lista));
      expect(r.status, r.texto).toBe(200);
      expect(r.json).toMatchObject({ creadas: 3, consultasEncoladas: 3, consultasOmitidas: 0 });
      const filas = await esperarHasta(() => b.trabajos(E.tenantId, TIPO), (f) => f.length >= 3);
      expect(filas.map((f) => f.ruc_cliente).sort()).toEqual([...lista].sort());
      for (const f of filas) {
        expect(f).toMatchObject({ cola: "xml", canal: "ninguno", prioridad: "programado", estado: "en_cola", creado_por: E.titular.id });
        expect(await b.redis.zscore(b.claves.pend("xml", E.tenantId), f.id)).not.toBeNull();
      }
      // Un evento en_cola por trabajo en el canal del estudio (lo que alimenta el panel).
      for (const f of filas) expect(await obs.esperar((m) => m.id === f.id && m.estado === "en_cola"), f.id).not.toBeNull();
    } finally {
      obs.cerrar();
    }
  });

  it("las filas no importadas (duplicado, RUC inválido, cupo) no encolan consulta", async () => {
    const E = await b.estudioCon(2);
    const existente = await b.c.sembrar(E.tenantId);
    const [a, c] = rucs(2) as [string, string];
    const r = await confirmar(b, E.titular, archivo([existente.ruc, a, c]));
    expect(r.json).toMatchObject({ creadas: 1, consultasEncoladas: 1 });
    const filas = await esperarHasta(() => b.trabajos(E.tenantId, TIPO), (f) => f.length >= 1);
    expect(filas.map((f) => f.ruc_cliente)).toEqual([a]);
  });
});

describe("D1 · si encolar falla, el alta y la importación no fallan", () => {
  let caido: BancoCola;
  let Ec: Estudio;
  beforeAll(async () => {
    caido = await abrirBancoCola({ redisApp: URL_REDIS_CAIDO });
    Ec = await caido.estudio();
  });
  afterAll(async () => {
    await caido?.cerrar();
  });

  it("con Redis caído el alta responde 201 en menos de 5 s y el trabajo queda en_cola en la BD (el reconciliador lo repone)", async () => {
    const t0 = Date.now();
    const ruc = rucs(1)[0]!;
    const r = await caido.c.crear(Ec.titular, { ruc });
    expect(r.status, r.text).toBe(201);
    expect(Date.now() - t0, "el alta esperó a un Redis caído").toBeLessThan(5000);
    expect(Object.keys(r.body).sort()).toEqual(CLAVES_DTO);
    const filas = await esperarHasta(() => caido.trabajos(Ec.tenantId, TIPO), (f) => f.length >= 1);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ cliente_id: r.body.id, estado: "en_cola", prioridad: "programado" });
    expect(await caido.redis.zscore(caido.claves.pend("xml", Ec.tenantId), filas[0].id)).toBeNull();
  }, 30_000);

  it("con Redis caído la importación responde 200: los clientes existen y las consultas quedan en la BD", async () => {
    const t0 = Date.now();
    const lista = rucs(3);
    const r = await confirmar(caido, Ec.titular, archivo(lista));
    expect(r.status, r.texto).toBe(200);
    expect(Date.now() - t0, "la importación esperó a un Redis caído").toBeLessThan(15_000);
    expect(r.json.creadas).toBe(3);
    expect(r.json.consultasEncoladas + r.json.consultasOmitidas).toBe(3);
    const existentes = (await caido.sql("select ruc from cliente where tenant_id = $1", [Ec.tenantId])).map((f) => f.ruc);
    for (const x of lista) expect(existentes).toContain(x);
  }, 30_000);
});

describe("plan: Carga de la cola · reserva del 50 %", () => {
  it("con 999 pendientes el alta encola (llega a 1.000); con 1.000 responde 201 sin encolar (consulta omitida; razón social provisional)", async () => {
    const E = await b.estudio();
    const base = await b.c.sembrar(E.tenantId);
    await b.sembrarPendientesXml(E.tenantId, base.id, 999);
    const [rucUno, rucDos] = rucs(2) as [string, string];
    const uno = await b.c.crear(E.titular, { ruc: rucUno });
    expect(uno.status, uno.text).toBe(201);
    await esperarHasta(() => b.pendientesXml(E.tenantId), (n) => n >= 1000);
    expect(await b.pendientesXml(E.tenantId)).toBe(1000); // cabía justo una
    const dos = await b.c.crear(E.titular, { ruc: rucDos });
    expect(dos.status, dos.text).toBe(201);
    expect(dos.body.razonSocial).toBe(`RUC ${rucDos}`);
    await new Promise((x) => setTimeout(x, 300));
    expect(await b.pendientesXml(E.tenantId)).toBe(1000);
    expect((await b.trabajos(E.tenantId, TIPO)).filter((f) => f.cliente_id === dos.body.id)).toEqual([]);
  });

  it("la importación con la reserva agotada crea los clientes y los cuenta en consultasOmitidas (200)", async () => {
    const E = await b.estudio();
    const base = await b.c.sembrar(E.tenantId);
    await b.sembrarPendientesXml(E.tenantId, base.id, 1000);
    const lista = rucs(3);
    const r = await confirmar(b, E.titular, archivo(lista));
    expect(r.status, r.texto).toBe(200);
    expect(r.json).toMatchObject({ creadas: 3, consultasEncoladas: 0, consultasOmitidas: 3 });
    expect(await b.pendientesXml(E.tenantId)).toBe(1000);
    const nombres = (await b.sql("select ruc, razon_social from cliente where tenant_id = $1 and ruc = any($2)", [E.tenantId, lista])) as any[];
    expect(nombres).toHaveLength(3);
    for (const n of nombres) expect(n.razon_social).toBe(`RUC ${n.ruc}`);
  });

  it("con 998 pendientes se encolan solo las 2 que caben hasta 1.000 y el resto se omite", async () => {
    const E = await b.estudio();
    const base = await b.c.sembrar(E.tenantId);
    await b.sembrarPendientesXml(E.tenantId, base.id, 998);
    const r = await confirmar(b, E.titular, archivo(rucs(5)));
    expect(r.status, r.texto).toBe(200);
    expect(r.json).toMatchObject({ creadas: 5, consultasEncoladas: 2, consultasOmitidas: 3 });
    expect(await b.pendientesXml(E.tenantId)).toBe(1000);
  });

  it("la reserva es por estudio: los pendientes de otro estudio no cuentan", async () => {
    const lleno = await b.estudio();
    const baseLleno = await b.c.sembrar(lleno.tenantId);
    await b.sembrarPendientesXml(lleno.tenantId, baseLleno.id, 1000);
    const libre = await b.estudio();
    const r = await confirmar(b, libre.titular, archivo(rucs(2)));
    expect(r.json).toMatchObject({ creadas: 2, consultasEncoladas: 2, consultasOmitidas: 0 });
  });
});

describe("plan: Carga de la cola · encolarLote por lotes de 100", () => {
  it("250 clientes importados dejan 250 trabajos, 250 pistas y 250 eventos en_cola, sin tope de 100", async () => {
    const E = await b.estudio();
    const obs = await observarEventos(b.prefijo, E.tenantId);
    try {
      const r = await confirmar(b, E.titular, archivo(rucs(250)));
      expect(r.status, r.texto.slice(0, 300)).toBe(200);
      expect(r.json).toMatchObject({ creadas: 250, consultasEncoladas: 250, consultasOmitidas: 0 });
      const filas = await esperarHasta(() => b.trabajos(E.tenantId, TIPO), (f) => f.length >= 250, 15_000);
      expect(filas).toHaveLength(250);
      expect(new Set(filas.map((f) => f.cliente_id)).size).toBe(250); // un trabajo por cliente
      expect(await b.redis.zcard(b.claves.pend("xml", E.tenantId))).toBe(250);
      await esperarHasta(async () => obs.mensajes.length, (n) => n >= 250, 15_000);
      const enCola = obs.mensajes.filter((m) => m.tipo === TIPO && m.estado === "en_cola");
      expect(new Set(enCola.map((m) => m.id)).size).toBe(250);
    } finally {
      obs.cerrar();
    }
  }, 60_000);

  it("el lote se publica después de su commit: cuando Redis ve la pista de un trabajo, su fila ya es visible para otra conexión", async () => {
    const E = await b.estudio();
    const monitor = await b.redis.monitor();
    const visibles: Promise<boolean>[] = [];
    monitor.on("monitor", (_h: string, args: string[]) => {
      if (String(args[0]).toLowerCase() === "zadd" && args[1] === b.claves.pend("xml", E.tenantId)) {
        // El miembro de la pista es el id del trabajo (el último argumento de cada par puntaje-miembro).
        for (const id of args.slice(2).filter((_x, i) => i % 2 === 1)) {
          visibles.push(
            b.sql("select estado from job_registro where id = $1", [id]).then((f) => f[0]?.estado === "en_cola"),
          );
        }
      }
    });
    try {
      const r = await confirmar(b, E.titular, archivo(rucs(150)));
      expect(r.status, r.texto.slice(0, 300)).toBe(200);
      await esperarHasta(async () => visibles.length, (n) => n >= 150, 10_000);
      expect(visibles.length).toBeGreaterThanOrEqual(150);
      expect((await Promise.all(visibles)).every(Boolean)).toBe(true);
    } finally {
      monitor.disconnect();
    }
  }, 60_000);
});
