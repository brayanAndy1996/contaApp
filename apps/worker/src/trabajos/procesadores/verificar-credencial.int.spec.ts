import { ErrorCredencial, MockSireAuth, MockSolAuth } from "@contapp/sunat";
import type { ContappDb } from "@contapp/db";
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
  SireAuthControlado,
  SolAuthControlado,
  arrancar007b,
  esperarTerminal,
  guardarCredencial,
  registrarTipoSirePrueba,
} from "../../../test/procesadores-007b.js";
import { auditoriasDe } from "../../../test/bd.js";
import {
  canario,
  rastros,
  loggerEspia,
  volcado,
} from "../../../test/soporte.js";
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
  registrarTiposDePrueba,
  restaurarConfig,
  volcarPrefijo,
} from "../../../test/trabajos.js";
import { notificadorEspia } from "../../../test/notificaciones.js";

// Spec 007b, T5 (rojo; integración con PostgreSQL y Redis reales y mocks de SolAuth/SireAuth): procesadores
// `credencial.verificar_sol` y `credencial.verificar_sire` (D6; CA-5, CA-6). Se encolan como lo hace el backend
// (rol backend, prioridad `interactivo`) y los ejecuta el worker, que es quien descifra con la KEK `mock`.
//
// CONTRATO que fija (T9), además del de test/procesadores-007b.ts:
// - Éxito: la credencial pasa a `verificada` (estado_motivo nulo, estado_at actualizado) y el trabajo queda `completado`.
// - ErrorCredencial: la credencial pasa a `invalida` con motivo `credencial_invalida`; el trabajo queda `error/credencial_invalida`
//   sin reintentos. `verificar_sire` marca solo `sire_api` (nunca `sol`), aunque el puerto use ambas.
// - ErrorTransitorio: el estado NO cambia y se reintenta (backoff de 008); agotado, `error/sunat_no_responde`.
// - El resultado se escribe solo si la versión de la fila sigue siendo la que vio al empezar: un guardado concurrente gana
//   (la credencial queda `configurada`, ni `verificada` ni `invalida`).
// - Una credencial `invalida` SÍ se puede verificar (el catálogo va con `credencial: null`) y vuelve a `verificada`; tras ello
//   los trabajos SIRE (que el despachador cancelaba con `credencial_invalida`) vuelven a despacharse (CA-6).
// - Sin la credencial necesaria (borrada tras encolar): `error/credencial_invalida` sin llamar al puerto.
// - Cada descifrado deja auditoría con motivo `credencial.verificar` (`verificar_sire` descifra `sire_api` y `sol`, una vez cada una).
// - `verificar_sire` llama al puerto `SireAuth` directo, sin la caché de token (dos verificaciones = dos llamadas).
// - Ni el secreto descifrado ni el de un error del puerto aparecen en logs, job_registro, Redis ni notificaciones.
// - Sin transacción abierta mientras corre el puerto (008 D6).

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

registrarTiposDePrueba();
registrarTipoSirePrueba();

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
  for (const cola of ["sol", "sire"])
    await fijarConfig(admin, cola, {
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

interface Mundo {
  T: string;
  u: string;
  c: { id: string; ruc: string };
  idSol: string;
  idSire: string;
  secretos: {
    clave: string;
    clientSecret: string;
    clientId: string;
    usuario: string;
  };
}

/** Un estudio con un cliente que tiene las dos credenciales guardadas (canarios) y estado `configurada`. */
async function mundo(
  o: {
    clave?: string;
    clientSecret?: string;
    sol?: boolean;
    sire?: boolean;
  } = {},
): Promise<Mundo> {
  const T = await e.estudio();
  const u = await e.usuario(T, "contador");
  const c = await e.cliente(T);
  await e.asignar(T, c.id, u);
  const secretos = {
    clave: o.clave ?? canario("clave_sol"),
    clientSecret: o.clientSecret ?? canario("client_secret"),
    clientId: canario("client_id"),
    usuario: "USUARIOSOL",
  };
  const idSol =
    o.sol === false
      ? ""
      : await guardarCredencial(backend, T, c.id, "sol", {
          usuario: secretos.usuario,
          clave: secretos.clave,
        });
  const idSire =
    o.sire === false
      ? ""
      : await guardarCredencial(backend, T, c.id, "sire_api", {
          clientId: secretos.clientId,
          clientSecret: secretos.clientSecret,
        });
  return { T, u, c, idSol, idSire, secretos };
}

function encolar(m: Mundo, tipo: string): Promise<string> {
  return encolarYPublicar(backend, redis, prefijo, m.T, {
    tipo,
    clienteId: m.c.id,
    parametros: {},
    prioridad: tipo.startsWith("credencial.") ? "interactivo" : "programado",
    creadoPor: m.u,
  }).then((r) => r.trabajo.id);
}

async function estadoDe(clienteId: string, tipo: "sol" | "sire_api") {
  return (
    await admin.pool.query(
      "select estado, estado_motivo, estado_at from credencial where cliente_id = $1 and tipo = $2",
      [clienteId, tipo],
    )
  ).rows[0] as
    | { estado: string; estado_motivo: string | null; estado_at: Date | null }
    | undefined;
}

async function marcarInvalida(clienteId: string, tipo: "sol" | "sire_api") {
  await admin.pool.query(
    `update credencial set estado = 'invalida', estado_motivo = 'credencial_invalida', estado_at = clock_timestamp()
     where cliente_id = $1 and tipo = $2`,
    [clienteId, tipo],
  );
}

const esperarUnPoco = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("CA-5: credencial.verificar_sol", () => {
  it("con el mock en éxito: la SOL pasa a verificada (fecha, sin motivo) y el trabajo se completa", async () => {
    const m = await mundo();
    const sol = new SolAuthControlado(new MockSolAuth());
    const p = await arrancar007b({ prefijo, solAuth: sol });
    try {
      const antes = await estadoDe(m.c.id, "sol");
      expect(antes?.estado).toBe("configurada");
      const id = await encolar(m, "credencial.verificar_sol");
      const fila = await esperarTerminal(e, id);
      expect([fila.estado, fila.motivo]).toEqual(["completado", null]);
      const despues = await estadoDe(m.c.id, "sol");
      expect(despues?.estado).toBe("verificada");
      expect(despues?.estado_motivo).toBeNull();
      expect(despues?.estado_at?.getTime()).toBeGreaterThan(
        antes?.estado_at?.getTime() ?? 0,
      );
      // El puerto recibe lo descifrado: RUC del cliente, usuario y clave SOL.
      expect(sol.recibidas).toEqual([
        {
          ruc: m.c.ruc,
          usuarioSol: m.secretos.usuario,
          claveSol: m.secretos.clave,
        },
      ]);
      // La otra credencial no se toca.
      expect((await estadoDe(m.c.id, "sire_api"))?.estado).toBe("configurada");
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });

  it("con el centinela de clave errada: invalida (credencial_invalida), trabajo error/credencial_invalida y sin reintentos", async () => {
    const m = await mundo({ clave: "clave-errada" });
    const mock = new MockSolAuth();
    const p = await arrancar007b({ prefijo, solAuth: mock });
    try {
      const id = await encolar(m, "credencial.verificar_sol");
      const fila = await esperarTerminal(e, id);
      expect([fila.estado, fila.motivo]).toEqual([
        "error",
        "credencial_invalida",
      ]);
      const est = await estadoDe(m.c.id, "sol");
      expect([est?.estado, est?.estado_motivo]).toEqual([
        "invalida",
        "credencial_invalida",
      ]);
      await esperarUnPoco(700); // más que el backoff: un reintento indebido llamaría otra vez
      expect(mock.llamadasDe(m.c.ruc), "sin reintentos").toBe(1);
      expect((await estadoDe(m.c.id, "sire_api"))?.estado).toBe("configurada");
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });

  it("transitorio que se recupera: el estado no cambia entre intentos y termina verificada", async () => {
    const m = await mundo();
    const mock = new MockSolAuth();
    mock.fallar("timeout", { veces: 1 });
    const p = await arrancar007b({ prefijo, solAuth: mock });
    try {
      const id = await encolar(m, "credencial.verificar_sol");
      const fila = await esperarTerminal(e, id);
      expect(fila.estado).toBe("completado");
      expect(mock.llamadasDe(m.c.ruc)).toBe(2);
      expect((await estadoDe(m.c.id, "sol"))?.estado).toBe("verificada");
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });

  it("transitorio persistente: error/sunat_no_responde y la credencial sigue configurada (no se marca inválida)", async () => {
    const m = await mundo();
    const mock = new MockSolAuth();
    mock.fallar("5xx");
    const p = await arrancar007b({ prefijo, solAuth: mock });
    try {
      const id = await encolar(m, "credencial.verificar_sol");
      const fila = await esperarTerminal(e, id);
      expect([fila.estado, fila.motivo]).toEqual([
        "error",
        "sunat_no_responde",
      ]);
      expect(mock.llamadasDe(m.c.ruc)).toBeGreaterThan(1);
      expect(mock.llamadasDe(m.c.ruc)).toBeLessThanOrEqual(1 + REINTENTOS);
      const est = await estadoDe(m.c.id, "sol");
      expect([est?.estado, est?.estado_motivo]).toEqual(["configurada", null]);
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });

  it("sin la credencial SOL (borrada tras encolar): error/credencial_invalida sin llamar al puerto", async () => {
    const m = await mundo({ sol: false, sire: false });
    const mock = new MockSolAuth();
    const p = await arrancar007b({ prefijo, solAuth: mock });
    try {
      const id = await encolar(m, "credencial.verificar_sol");
      const fila = await esperarTerminal(e, id);
      expect([fila.estado, fila.motivo]).toEqual([
        "error",
        "credencial_invalida",
      ]);
      expect(mock.llamadas).toBe(0);
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });
});

describe("CA-5: credencial.verificar_sire", () => {
  it("con el mock en éxito: sire_api verificada, sol sin tocar, y el puerto recibe ambas credenciales", async () => {
    const m = await mundo();
    const sire = new SireAuthControlado(new MockSireAuth());
    const p = await arrancar007b({ prefijo, sireAuth: sire });
    try {
      const id = await encolar(m, "credencial.verificar_sire");
      const fila = await esperarTerminal(e, id);
      expect([fila.estado, fila.motivo]).toEqual(["completado", null]);
      const est = await estadoDe(m.c.id, "sire_api");
      expect([est?.estado, est?.estado_motivo]).toEqual(["verificada", null]);
      expect((await estadoDe(m.c.id, "sol"))?.estado).toBe("configurada");
      expect(sire.recibidas).toEqual([
        {
          clientId: m.secretos.clientId,
          clientSecret: m.secretos.clientSecret,
          usuarioSol: m.secretos.usuario,
          claveSol: m.secretos.clave,
          ruc: m.c.ruc,
        },
      ]);
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });

  it("con el centinela de client_secret errado: sire_api inválida, sol intacta, error/credencial_invalida sin reintentos", async () => {
    const m = await mundo({ clientSecret: "clave-errada" });
    const mock = new MockSireAuth();
    const p = await arrancar007b({ prefijo, sireAuth: mock });
    try {
      const id = await encolar(m, "credencial.verificar_sire");
      const fila = await esperarTerminal(e, id);
      expect([fila.estado, fila.motivo]).toEqual([
        "error",
        "credencial_invalida",
      ]);
      const est = await estadoDe(m.c.id, "sire_api");
      expect([est?.estado, est?.estado_motivo]).toEqual([
        "invalida",
        "credencial_invalida",
      ]);
      expect((await estadoDe(m.c.id, "sol"))?.estado).toBe("configurada");
      await esperarUnPoco(700);
      expect(mock.llamadasDe(m.c.ruc), "sin reintentos").toBe(1);
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });

  it("usa el puerto directo, no la caché de token: dos verificaciones seguidas = dos llamadas", async () => {
    const m = await mundo();
    const mock = new MockSireAuth();
    const p = await arrancar007b({ prefijo, sireAuth: mock });
    try {
      const id1 = await encolar(m, "credencial.verificar_sire");
      expect((await esperarTerminal(e, id1)).estado).toBe("completado");
      const id2 = await encolar(m, "credencial.verificar_sire");
      expect(id2).not.toBe(id1);
      expect((await esperarTerminal(e, id2)).estado).toBe("completado");
      expect(mock.llamadasDe(m.c.ruc)).toBe(2);
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });

  it("sin la SOL (no puede armar el token SIRE): error/credencial_invalida sin llamar al puerto y sire_api no cambia", async () => {
    const m = await mundo({ sol: false });
    const mock = new MockSireAuth();
    const p = await arrancar007b({ prefijo, sireAuth: mock });
    try {
      const id = await encolar(m, "credencial.verificar_sire");
      const fila = await esperarTerminal(e, id);
      expect([fila.estado, fila.motivo]).toEqual([
        "error",
        "credencial_invalida",
      ]);
      expect(mock.llamadas).toBe(0);
      expect((await estadoDe(m.c.id, "sire_api"))?.estado).toBe("configurada");
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });
});

describe("CA-6: una credencial inválida sí se puede verificar y los trabajos SIRE vuelven a despacharse", () => {
  it("verificar_sol sobre una SOL inválida (el despachador no cancela este tipo) la devuelve a verificada", async () => {
    const m = await mundo();
    await marcarInvalida(m.c.id, "sol");
    const p = await arrancar007b({ prefijo, solAuth: new MockSolAuth() });
    try {
      const id = await encolar(m, "credencial.verificar_sol");
      const fila = await esperarTerminal(e, id);
      expect([fila.estado, fila.motivo]).toEqual(["completado", null]);
      const est = await estadoDe(m.c.id, "sol");
      expect([est?.estado, est?.estado_motivo]).toEqual(["verificada", null]);
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });

  it("SIRE cancelada por credencial inválida -> verificar_sire -> el siguiente trabajo SIRE se despacha y completa", async () => {
    const m = await mundo();
    await marcarInvalida(m.c.id, "sire_api");
    const p = await arrancar007b({
      prefijo,
      sireAuth: new MockSireAuth(),
      procesadores: { "prueba.sire_api": async () => ({ ok: true }) },
    });
    try {
      const cancelado = await encolar(m, "prueba.sire_api");
      const f1 = await esperarTerminal(e, cancelado);
      expect([f1.estado, f1.motivo], "precondición: D23 cancela").toEqual([
        "cancelado",
        "credencial_invalida",
      ]);

      const verif = await encolar(m, "credencial.verificar_sire");
      const f2 = await esperarTerminal(e, verif);
      expect([f2.estado, f2.motivo]).toEqual(["completado", null]);
      expect((await estadoDe(m.c.id, "sire_api"))?.estado).toBe("verificada");

      const otra = await encolar(m, "prueba.sire_api");
      const f3 = await esperarTerminal(e, otra);
      expect([f3.estado, f3.motivo]).toEqual(["completado", null]);
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });

  it("si la verificación vuelve a fallar, la credencial sigue inválida y el trabajo SIRE sigue cancelándose", async () => {
    const m = await mundo({ clientSecret: "clave-errada" });
    await marcarInvalida(m.c.id, "sire_api");
    const p = await arrancar007b({
      prefijo,
      sireAuth: new MockSireAuth(),
      procesadores: { "prueba.sire_api": async () => ({ ok: true }) },
    });
    try {
      const verif = await encolar(m, "credencial.verificar_sire");
      expect((await esperarTerminal(e, verif)).motivo).toBe(
        "credencial_invalida",
      );
      expect((await estadoDe(m.c.id, "sire_api"))?.estado).toBe("invalida");
      const otra = await encolar(m, "prueba.sire_api");
      const f = await esperarTerminal(e, otra);
      expect([f.estado, f.motivo]).toEqual([
        "cancelado",
        "credencial_invalida",
      ]);
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });
});

describe("Un guardado durante la verificación no se pisa (versión de la fila)", () => {
  it("éxito del puerto con un guardado nuevo en medio: la credencial queda configurada, no verificada", async () => {
    const m = await mundo();
    const sol = new SolAuthControlado(new MockSolAuth());
    sol.pausar();
    const p = await arrancar007b({ prefijo, solAuth: sol });
    try {
      const id = await encolar(m, "credencial.verificar_sol");
      await esperarHasta(
        () => sol.recibidas.length > 0,
        "el puerto recibe la SOL",
      );
      await guardarCredencial(backend, m.T, m.c.id, "sol", {
        usuario: "USUARIONUEVO",
        clave: canario("clave_nueva"),
      });
      sol.abrir();
      await esperarTerminal(e, id);
      const est = await estadoDe(m.c.id, "sol");
      expect([est?.estado, est?.estado_motivo]).toEqual(["configurada", null]);
    } finally {
      sol.abrir();
      await p.detener({ esperaMs: 2000 });
    }
  });

  it("rechazo del puerto con un guardado nuevo en medio: la credencial nueva no se marca inválida", async () => {
    const m = await mundo({ clave: "clave-errada" });
    const sol = new SolAuthControlado(new MockSolAuth());
    sol.pausar();
    const p = await arrancar007b({ prefijo, solAuth: sol });
    try {
      const id = await encolar(m, "credencial.verificar_sol");
      await esperarHasta(
        () => sol.recibidas.length > 0,
        "el puerto recibe la SOL",
      );
      await guardarCredencial(backend, m.T, m.c.id, "sol", {
        usuario: "USUARIONUEVO",
        clave: canario("clave_nueva"),
      });
      sol.abrir();
      await esperarTerminal(e, id);
      const est = await estadoDe(m.c.id, "sol");
      expect([est?.estado, est?.estado_motivo]).toEqual(["configurada", null]);
    } finally {
      sol.abrir();
      await p.detener({ esperaMs: 2000 });
    }
  });
});

describe("Aislamiento entre clientes y estudios", () => {
  it("verificar la SOL de un cliente no toca las credenciales de otro cliente ni de otro estudio", async () => {
    const m1 = await mundo();
    const m2 = await mundo();
    const p = await arrancar007b({ prefijo, solAuth: new MockSolAuth() });
    try {
      const id = await encolar(m1, "credencial.verificar_sol");
      expect((await esperarTerminal(e, id)).estado).toBe("completado");
      expect((await estadoDe(m1.c.id, "sol"))?.estado).toBe("verificada");
      expect((await estadoDe(m2.c.id, "sol"))?.estado).toBe("configurada");
      expect((await estadoDe(m2.c.id, "sire_api"))?.estado).toBe("configurada");
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });
});

describe("Auditoría del descifrado (RNF-004)", () => {
  it("verificar_sol deja una auditoría ok con motivo credencial.verificar", async () => {
    const m = await mundo();
    const p = await arrancar007b({ prefijo, solAuth: new MockSolAuth() });
    try {
      const id = await encolar(m, "credencial.verificar_sol");
      await esperarTerminal(e, id);
      const filas = await auditoriasDe(admin, m.idSol);
      expect(filas).toHaveLength(1);
      expect(filas[0]).toMatchObject({
        tenant_id: m.T,
        credencial_id: m.idSol,
        cliente_id: m.c.id,
        tipo: "sol",
        motivo: "credencial.verificar",
        resultado: "ok",
      });
      expect(
        await auditoriasDe(admin, m.idSire),
        "la SIRE no se descifra",
      ).toHaveLength(0);
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });

  it("verificar_sire descifra sire_api y sol, y audita cada una con motivo credencial.verificar", async () => {
    const m = await mundo();
    const p = await arrancar007b({ prefijo, sireAuth: new MockSireAuth() });
    try {
      const id = await encolar(m, "credencial.verificar_sire");
      await esperarTerminal(e, id);
      for (const [cred, tipo] of [
        [m.idSire, "sire_api"],
        [m.idSol, "sol"],
      ] as const) {
        const filas = await auditoriasDe(admin, cred);
        expect(filas, `auditoría de ${tipo}`).toHaveLength(1);
        expect(filas[0]).toMatchObject({
          tenant_id: m.T,
          cliente_id: m.c.id,
          tipo,
          motivo: "credencial.verificar",
          resultado: "ok",
        });
      }
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });
});

describe("008 D6: sin transacción abierta durante la llamada al puerto", () => {
  it("mientras corre la verificación SOL el ejecutor no mantiene ninguna transacción de BD", async () => {
    const m = await mundo();
    const sol = new SolAuthControlado(new MockSolAuth());
    sol.pausar();
    const p = await arrancar007b({ prefijo, solAuth: sol });
    try {
      const id = await encolar(m, "credencial.verificar_sol");
      await esperarHasta(
        () => sol.recibidas.length > 0,
        "el puerto recibe la SOL",
      );
      expect(await minimoTx(p.dbEstado, 400)).toBe(0);
      sol.abrir();
      expect((await esperarTerminal(e, id)).estado).toBe("completado");
    } finally {
      sol.abrir();
      await p.detener({ esperaMs: 2000 });
    }
  });
});

describe("Sin fugas de secretos (RNF-004, RNF-083)", () => {
  it("la clave SOL y el client_secret descifrados no aparecen en logs, job_registro, Redis ni notificaciones, ni con errores del puerto que los contienen", async () => {
    const ok = await mundo();
    const mal = await mundo();
    const caido = await mundo();
    const secretos = [
      ok.secretos.clave,
      ok.secretos.clientSecret,
      mal.secretos.clave,
      mal.secretos.clientSecret,
      caido.secretos.clave,
      caido.secretos.clientSecret,
    ];

    // Puertos que fallan con el secreto en el mensaje, en la causa y en propiedades.
    const sucio = (s: string): Error =>
      Object.assign(new Error(`rechazo con ${s}`, { cause: new Error(s) }), {
        detail: s,
      });
    const solAuth = {
      verificar: async (c: { ruc: string; claveSol: string }) => {
        if (c.ruc === mal.c.ruc) throw new ErrorCredencial(sucio(c.claveSol));
        if (c.ruc === caido.c.ruc) throw sucio(c.claveSol); // error crudo: clasificado como transitorio
      },
    };
    const sireAuth = {
      obtenerToken: async (c: { clientSecret: string; claveSol: string }) => {
        throw new ErrorCredencial(sucio(c.clientSecret + c.claveSol));
      },
    };

    const { logger, llamadas } = loggerEspia();
    const notificador = notificadorEspia();
    const capturado: string[] = [];
    const espias = (["log", "info", "warn", "error", "debug"] as const).map(
      (n) =>
        vi
          .spyOn(console, n)
          .mockImplementation(
            (...a: unknown[]) => void capturado.push(volcado(a)),
          ),
    );
    const stdoutOrig = process.stdout.write;
    const stderrOrig = process.stderr.write;
    const capturar = (orig: typeof process.stdout.write) =>
      ((chunk: unknown, ...resto: unknown[]) => {
        capturado.push(String(chunk));
        return (orig as (...a: unknown[]) => boolean).call(
          process.stdout,
          chunk,
          ...resto,
        );
      }) as typeof process.stdout.write;
    process.stdout.write = capturar(stdoutOrig);
    process.stderr.write = capturar(stderrOrig);

    const p = await arrancar007b({
      prefijo,
      solAuth: solAuth as never,
      sireAuth: sireAuth as never,
      notificador: notificador as never,
      logger: logger as never,
    });
    try {
      const ids = [
        await encolar(ok, "credencial.verificar_sol"),
        await encolar(mal, "credencial.verificar_sol"),
        await encolar(caido, "credencial.verificar_sol"),
        await encolar(ok, "credencial.verificar_sire"),
      ];
      const filas = [];
      for (const id of ids) filas.push(await esperarTerminal(e, id, 30_000));
      expect(filas.map((f) => [f.estado, f.motivo])).toEqual([
        ["completado", null],
        ["error", "credencial_invalida"],
        ["error", "sunat_no_responde"],
        ["error", "credencial_invalida"],
      ]);

      const jobs = await e.volcarJobs();
      const todoRedis = await volcarPrefijo(redis, prefijo);
      const logs = volcado(llamadas) + "\n" + capturado.join("\n");
      const avisos = volcado(notificador.llamadas);
      for (const s of secretos)
        for (const r of rastros(s)) {
          expect(jobs, "job_registro").not.toContain(r);
          expect(todoRedis, "Redis").not.toContain(r);
          expect(logs, "logs").not.toContain(r);
          expect(avisos, "notificaciones").not.toContain(r);
        }
      expect(llamadas.length, "el worker sí registra eventos").toBeGreaterThan(
        0,
      );
    } finally {
      process.stdout.write = stdoutOrig;
      process.stderr.write = stderrOrig;
      for (const s of espias) s.mockRestore();
      await p.detener({ esperaMs: 2000 });
    }
  });
});
