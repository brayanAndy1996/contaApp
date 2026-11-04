import type { ContappDb } from "@contapp/db";
import { MockConsultaRuc } from "@contapp/sunat";
import type { Redis } from "ioredis";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  ConsultaRucControlada,
  arrancar007b,
  esperarTerminal,
} from "../../../test/procesadores-007b.js";
import {
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  encolarYPublicar,
  Escenario,
  esperarHasta,
  fijarConfig,
  limpiarPrefijo,
  minimoTx,
  nuevoPrefijo,
  restaurarConfig,
  rucNuevo,
} from "../../../test/trabajos.js";

// Spec 007b, T5 (rojo; integración con PostgreSQL y Redis reales y MockConsultaRuc): procesador de `cliente.consultar_ruc`
// (D1; CA-9). Se encola como lo hace el alta o la importación (rol backend, prioridad `programado`) y lo ejecuta el worker.
//
// CONTRATO que fija (T9), además del de test/procesadores-007b.ts:
// - Completa `estado_contribuyente` y `condicion_contribuyente`, y `razon_social` solo si sigue siendo exactamente «RUC <ruc>»
//   (comparación en el mismo UPDATE: una edición manual, también la concurrente, nunca se pisa). Trabajo `completado`.
// - Mock con ErrorTransitorio: el cliente queda intacto y el trabajo se reintenta (backoff de 008); agotados los reintentos
//   queda `error/sunat_no_responde`. Con ErrorDatos: `error/datos_invalidos` sin reintentos. Nunca toca otro estudio.
// - Sin transacción abierta mientras corre el puerto (008 D6).

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const REINTENTOS = 2;
let admin: ContappDb;
let backend: ContappDb;
let redis: Redis;
let e: Escenario;
// Un prefijo de Redis por prueba: así no sobreviven arriendos del líder ni jobs de BullMQ de la prueba anterior.
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
  await fijarConfig(admin, "xml", {
    global: 4,
    tenant: 2,
    espera: 0,
    reintentos: REINTENTOS,
    base: 100,
  });
});

afterAll(async () => {
  await restaurarConfig(admin).catch(() => undefined);
  await e?.limpiar();
  for (const x of prefijos)
    await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), admin?.close()]);
});

interface Fila {
  razon_social: string;
  estado_contribuyente: string | null;
  condicion_contribuyente: string | null;
  fila: string;
}

async function leer(clienteId: string): Promise<Fila> {
  return (
    await admin.pool.query(
      `select razon_social, estado_contribuyente, condicion_contribuyente, to_jsonb(c)::text as fila
       from cliente c where id = $1`,
      [clienteId],
    )
  ).rows[0] as Fila;
}

/** Cliente con la razón social provisional que deja 007a: exactamente «RUC <ruc>». */
async function clienteProvisional(
  tenantId: string,
  usuario: string,
  ruc = rucNuevo(),
) {
  const c = await e.cliente(tenantId, ruc);
  await admin.pool.query(
    "update cliente set razon_social = 'RUC ' || ruc where id = $1",
    [c.id],
  );
  await e.asignar(tenantId, c.id, usuario);
  return c;
}

function encolarConsulta(tenantId: string, clienteId: string, usuario: string) {
  return encolarYPublicar(backend, redis, prefijo, tenantId, {
    tipo: "cliente.consultar_ruc",
    clienteId,
    parametros: {},
    prioridad: "programado",
    creadoPor: usuario,
  }).then((r) => r.trabajo.id);
}

describe("CA-9 / D1: cliente.consultar_ruc con el mock", () => {
  it("completa estado, condición y la razón social provisional; el trabajo queda completado", async () => {
    const T = await e.estudio();
    const u = await e.usuario(T, "admin");
    const c = await clienteProvisional(T, u);
    const mock = new MockConsultaRuc();
    const esperado = await new MockConsultaRuc().consultar(c.ruc);
    const p = await arrancar007b({ prefijo, consultaRuc: mock });
    try {
      const id = await encolarConsulta(T, c.id, u);
      const fila = await esperarTerminal(e, id);
      expect(fila.estado).toBe("completado");
      expect(fila.motivo).toBeNull();
      const cli = await leer(c.id);
      expect(cli.razon_social).toBe(esperado.razonSocial);
      expect(cli.razon_social).not.toBe(`RUC ${c.ruc}`);
      expect(cli.estado_contribuyente).toBe(esperado.estado);
      expect(cli.condicion_contribuyente).toBe(esperado.condicion);
      expect(mock.llamadasDe(c.ruc), "una sola consulta al puerto").toBe(1);
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });

  it("una razón social editada a mano no se pisa; estado y condición sí se completan", async () => {
    const T = await e.estudio();
    const u = await e.usuario(T, "admin");
    const c = await clienteProvisional(T, u);
    await admin.pool.query(
      "update cliente set razon_social = 'Editada por el contador S.A.C.' where id = $1",
      [c.id],
    );
    const esperado = await new MockConsultaRuc().consultar(c.ruc);
    const p = await arrancar007b({
      prefijo,
      consultaRuc: new MockConsultaRuc(),
    });
    try {
      const id = await encolarConsulta(T, c.id, u);
      expect((await esperarTerminal(e, id)).estado).toBe("completado");
      const cli = await leer(c.id);
      expect(cli.razon_social).toBe("Editada por el contador S.A.C.");
      expect(cli.estado_contribuyente).toBe(esperado.estado);
      expect(cli.condicion_contribuyente).toBe(esperado.condicion);
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });

  it("una edición manual que llega mientras se consulta tampoco se pisa (mismo UPDATE)", async () => {
    const T = await e.estudio();
    const u = await e.usuario(T, "admin");
    const c = await clienteProvisional(T, u);
    const puerto = new ConsultaRucControlada(new MockConsultaRuc());
    puerto.pausar();
    const p = await arrancar007b({ prefijo, consultaRuc: puerto });
    try {
      const id = await encolarConsulta(T, c.id, u);
      await esperarHasta(
        () => puerto.rucs.length > 0,
        "el puerto recibe la consulta",
      );
      await admin.pool.query(
        "update cliente set razon_social = 'Editada durante la consulta' where id = $1",
        [c.id],
      );
      puerto.abrir();
      expect((await esperarTerminal(e, id)).estado).toBe("completado");
      const cli = await leer(c.id);
      expect(cli.razon_social).toBe("Editada durante la consulta");
      expect(cli.estado_contribuyente).toBe("ACTIVO");
    } finally {
      puerto.abrir();
      await p.detener({ esperaMs: 2000 });
    }
  });

  it("solo toca el cliente del trabajo: el mismo RUC en otro estudio queda intacto", async () => {
    const T1 = await e.estudio();
    const T2 = await e.estudio();
    const u = await e.usuario(T1, "admin");
    const u2 = await e.usuario(T2, "admin");
    const ruc = rucNuevo();
    const c1 = await clienteProvisional(T1, u, ruc);
    const c2 = await clienteProvisional(T2, u2, ruc);
    const antes = await leer(c2.id);
    const p = await arrancar007b({
      prefijo,
      consultaRuc: new MockConsultaRuc(),
    });
    try {
      const id = await encolarConsulta(T1, c1.id, u);
      expect((await esperarTerminal(e, id)).estado).toBe("completado");
      expect((await leer(c1.id)).estado_contribuyente).toBe("ACTIVO");
      expect(
        await leer(c2.id),
        "el cliente del otro estudio no cambia",
      ).toEqual(antes);
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });
});

describe("CA-9: con el mock en fallo el cliente queda intacto y el trabajo figura fallido", () => {
  it("transitorio que se recupera: se reintenta y completa en el segundo intento", async () => {
    const T = await e.estudio();
    const u = await e.usuario(T, "admin");
    const c = await clienteProvisional(T, u);
    const mock = new MockConsultaRuc();
    mock.fallar("5xx", { veces: 1 });
    const p = await arrancar007b({ prefijo, consultaRuc: mock });
    try {
      const id = await encolarConsulta(T, c.id, u);
      const fila = await esperarTerminal(e, id);
      expect(fila.estado).toBe("completado");
      expect(mock.llamadasDe(c.ruc), "un intento fallido y uno bueno").toBe(2);
      expect((await leer(c.id)).condicion_contribuyente).toBe("HABIDO");
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });

  it("transitorio persistente: agota los reintentos, error/sunat_no_responde y el cliente intacto", async () => {
    const T = await e.estudio();
    const u = await e.usuario(T, "admin");
    const c = await clienteProvisional(T, u);
    const antes = await leer(c.id);
    const mock = new MockConsultaRuc();
    mock.fallar("timeout");
    const p = await arrancar007b({ prefijo, consultaRuc: mock });
    try {
      const id = await encolarConsulta(T, c.id, u);
      const fila = await esperarTerminal(e, id);
      expect(fila.estado).toBe("error");
      expect(fila.motivo).toBe("sunat_no_responde");
      expect(mock.llamadasDe(c.ruc)).toBeGreaterThan(1);
      expect(mock.llamadasDe(c.ruc)).toBeLessThanOrEqual(1 + REINTENTOS);
      expect(await leer(c.id), "el cliente queda como estaba").toEqual(antes);
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });

  it("de datos (RUC terminado en 8): error/datos_invalidos sin reintentos y el cliente intacto", async () => {
    const T = await e.estudio();
    const u = await e.usuario(T, "admin");
    const c = await clienteProvisional(T, u, `2${rucNuevo().slice(1, 10)}8`);
    const antes = await leer(c.id);
    const mock = new MockConsultaRuc();
    const p = await arrancar007b({ prefijo, consultaRuc: mock });
    try {
      const id = await encolarConsulta(T, c.id, u);
      const fila = await esperarTerminal(e, id);
      expect(fila.estado).toBe("error");
      expect(fila.motivo).toBe("datos_invalidos");
      // Espera más que el backoff: un reintento indebido llamaría otra vez al puerto.
      await new Promise((r) => setTimeout(r, 600));
      expect(mock.llamadasDe(c.ruc), "no se reintenta").toBe(1);
      expect(await leer(c.id)).toEqual(antes);
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });

  it("de datos forzado con fallar('datos') sobre un RUC normal: mismo desenlace", async () => {
    const T = await e.estudio();
    const u = await e.usuario(T, "admin");
    const c = await clienteProvisional(T, u);
    const antes = await leer(c.id);
    const mock = new MockConsultaRuc();
    mock.fallar("datos");
    const p = await arrancar007b({ prefijo, consultaRuc: mock });
    try {
      const id = await encolarConsulta(T, c.id, u);
      const fila = await esperarTerminal(e, id);
      expect([fila.estado, fila.motivo]).toEqual(["error", "datos_invalidos"]);
      expect(mock.llamadasDe(c.ruc)).toBe(1);
      expect(await leer(c.id)).toEqual(antes);
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });
});

describe("008 D6: sin transacción abierta durante la llamada al puerto", () => {
  it("mientras corre la consulta del RUC el ejecutor no mantiene ninguna transacción de BD", async () => {
    const T = await e.estudio();
    const u = await e.usuario(T, "admin");
    const c = await clienteProvisional(T, u);
    const puerto = new ConsultaRucControlada(new MockConsultaRuc());
    puerto.pausar();
    const p = await arrancar007b({ prefijo, consultaRuc: puerto });
    try {
      const id = await encolarConsulta(T, c.id, u);
      await esperarHasta(
        () => puerto.rucs.length > 0,
        "el puerto recibe la consulta",
      );
      const minimo = await minimoTx(p.dbEstado, 400);
      expect(minimo, "una transacción abierta dejaría el mínimo en ≥ 1").toBe(
        0,
      );
      puerto.abrir();
      expect((await esperarTerminal(e, id)).estado).toBe("completado");
    } finally {
      puerto.abrir();
      await p.detener({ esperaMs: 2000 });
    }
  });
});
