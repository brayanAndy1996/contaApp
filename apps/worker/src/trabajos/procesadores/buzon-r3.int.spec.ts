/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD dinámicas y dobles mínimos en pruebas */
// Spec 023 · T25a · R-1 de la revisión final (worker; integración con PostgreSQL real y un portal doble). En rojo hasta T25b.
// Invariante: una captura SIEMPRE termina, aunque el portal entregue páginas vacías o sin ids utilizables con un `siguiente`
// que se repite, o infinitas páginas de conocidos; y lo que corta deja `cursor_pendiente` no nulo para que la siguiente continúe.
// Firma que fijan estas pruebas (T25b la implementa):
//  - `DepsRevisarBuzon.maxPaginasLectura?: number` (por omisión `MAX_PAGINAS_LECTURA` = 500 del dominio), que el procesador pasa
//    a `planificarCaptura` como `maxPaginasLectura` junto con `leidas` (páginas ya leídas en la captura, sin la actual).
//  - Con tope N el procesador pide exactamente N páginas y corta con `cursor_pendiente` no nulo y `sincronizado_en` sin tocar.
// Los portales de esta prueba se rinden (lanzan) tras `RENDIDO` llamadas: si el procesador no termina, la prueba falla rápido
// en vez de colgarse.
import { randomUUID } from "node:crypto";
import type { ContappDb } from "@contapp/db";
import type {
  CredencialSol,
  PaginaMensajesSol,
  SolPortal,
} from "@contapp/sunat";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  EscenarioBuzon,
  estadoDeCaptura,
  insertarMensajeAdmin,
  mensajesDe,
  type Mundo,
} from "../../../test/buzon.js";
import { crearDbAdmin, crearDbRol } from "../../../test/trabajos.js";
import { revisarBuzon, type ResultadoRevisarBuzon } from "./revisar-buzon.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const RENDIDO = 60;

let admin: ContappDb;
let worker: ContappDb;
let e: EscenarioBuzon;

beforeAll(() => {
  admin = crearDbAdmin();
  worker = crearDbRol("contapp_worker", 4);
  e = new EscenarioBuzon(admin);
});

afterEach(async () => {
  await e.limpiar();
  e = new EscenarioBuzon(admin);
});

afterAll(async () => {
  await Promise.all([worker?.close(), admin?.close()]);
});

async function mundo(): Promise<Mundo> {
  const T = await e.estudioConSub();
  await e.usuario(T, "dueno");
  const u = await e.usuario(T, "contador");
  const c = await e.clienteBuzon(T);
  return { T, u, c };
}

const servicio = {
  descifrarCredencial: async () => ({
    usar: <R>(f: (v: unknown) => R): R =>
      f({ usuario: "usuario-prueba", clave: "clave-prueba" }),
    destruir: () => undefined,
  }),
};

async function capturar(
  m: Mundo,
  portal: SolPortal,
  maxPaginasLectura?: number,
): Promise<ResultadoRevisarBuzon> {
  const proc = revisarBuzon({
    db: worker,
    servicio: servicio as never,
    solPortal: portal,
    ...(maxPaginasLectura !== undefined ? { maxPaginasLectura } : {}),
  } as never);
  return (await proc({
    trabajo: {
      id: randomUUID(),
      tenantId: m.T,
      clienteId: m.c.id,
      ruc: m.c.ruc,
      tipo: "sol.buzon.revisar",
      parametros: {},
      intentos: 0,
      creadoPor: null,
    },
    conToken: async (f: (t: string) => Promise<unknown>) => f("t"),
  } as never)) as ResultadoRevisarBuzon;
}

/** Portal que responde con `pagina(cursor, n)` y se rinde tras `RENDIDO` llamadas; `llamadas` cuenta las de `listarMensajes`. */
function portal(
  pagina: (cursor: string | null, n: number) => PaginaMensajesSol,
): SolPortal & { llamadas: number } {
  const p = {
    llamadas: 0,
    async listarMensajes(
      _c: CredencialSol,
      o: { cursor: string | null; limite: number },
    ): Promise<PaginaMensajesSol> {
      p.llamadas += 1;
      if (p.llamadas > RENDIDO)
        throw new Error("el procesador no termina (prueba)");
      return pagina(o.cursor, p.llamadas);
    },
    async obtenerMensaje(): Promise<never> {
      throw new Error("la captura no abre mensajes");
    },
    async obtenerDeclaraciones621(): Promise<never> {
      throw new Error("el buzón no consulta declaraciones (prueba)");
    },
  };
  return p as SolPortal & { llamadas: number };
}

const CAP_ACOTADO = 3;

describe("la captura termina con páginas sin mensajes utilizables (R-1)", () => {
  it("página vacía con un siguiente que se repite: termina con pocas llamadas y relleno pendiente", async () => {
    const m = await mundo();
    const p = portal(() => ({ mensajes: [], siguiente: "p2" }));
    const r = await capturar(m, p);
    expect(p.llamadas).toBeLessThanOrEqual(CAP_ACOTADO);
    expect(r.pendientes).toBe(true);
    const est = await estadoDeCaptura(admin, m.c.id);
    expect(est?.cursor_pendiente).not.toBeNull();
    expect(est?.sincronizado_en).toBeNull();
  });

  it("páginas vacías con un siguiente distinto cada vez: también termina de inmediato", async () => {
    const m = await mundo();
    const p = portal((_c, n) => ({ mensajes: [], siguiente: `p${n + 1}` }));
    await capturar(m, p);
    expect(p.llamadas).toBeLessThanOrEqual(CAP_ACOTADO);
    expect((await estadoDeCaptura(admin, m.c.id))?.cursor_pendiente).not.toBeNull();
  });

  it("página con todos los ids inválidos (vacío, NUL, de 65 caracteres) y un siguiente que se repite: termina y no guarda nada", async () => {
    const m = await mundo();
    const malo = (id: string) => ({
      idSunat: id,
      asunto: "Boletín",
      remitente: "SUNAT",
      fecha: new Date().toISOString(),
      codigoTipo: null,
      leidoEnSunat: false,
      adjuntos: [],
    });
    const p = portal(() => ({
      mensajes: [malo(""), malo("\u0000"), malo("x".repeat(65))],
      siguiente: "p2",
    }));
    const r = await capturar(m, p);
    expect(p.llamadas).toBeLessThanOrEqual(CAP_ACOTADO);
    expect(r.nuevos).toBe(0);
    expect(r.pendientes).toBe(true);
    expect(await mensajesDe(admin, m.c.id)).toHaveLength(0);
    const est = await estadoDeCaptura(admin, m.c.id);
    expect(est?.cursor_pendiente).not.toBeNull();
    expect(est?.sincronizado_en).toBeNull();
  });
});

describe("tope de páginas leídas inyectable (R-1)", () => {
  it("infinitas páginas de conocidos distintos: pide exactamente el tope y deja el relleno pendiente", async () => {
    const m = await mundo();
    for (let i = 1; i <= RENDIDO; i++)
      await insertarMensajeAdmin(admin, m.T, m.c.id, { idSunat: `K-${i}` });
    const p = portal((_c, n) => ({
      mensajes: [
        {
          idSunat: `K-${n}`,
          asunto: "Boletín",
          remitente: "SUNAT",
          fecha: new Date().toISOString(),
          codigoTipo: null,
          leidoEnSunat: false,
          adjuntos: [],
        },
      ],
      siguiente: `p${n + 1}`,
    }));
    const r = await capturar(m, p, 4);
    expect(p.llamadas).toBe(4);
    expect(r.pendientes).toBe(true);
    const est = await estadoDeCaptura(admin, m.c.id);
    expect(est?.cursor_pendiente).not.toBeNull();
    expect(est?.sincronizado_en).toBeNull();
  });

  it("el corte no pierde mensajes: la captura siguiente (sin el tope bajo) completa el buzón sin duplicar", async () => {
    const m = await mundo();
    const TOTAL = 9;
    const PAGINA = 2;
    const ahora = Date.now();
    const buzon = Array.from({ length: TOTAL }, (_, k) => ({
      idSunat: `N-${String(k + 1).padStart(3, "0")}`,
      asunto: `Boletín informativo ${k + 1}`,
      remitente: "SUNAT",
      fecha: new Date(ahora - (k + 1) * 60_000).toISOString(),
      codigoTipo: null,
      leidoEnSunat: false,
      adjuntos: [] as { idSunat: string; nombre: string }[],
    }));
    const servir = (cursor: string | null): PaginaMensajesSol => {
      const desde = cursor === null ? 0 : Number(cursor.slice(1)) * PAGINA;
      const mensajes = buzon.slice(desde, desde + PAGINA);
      const sig = desde + PAGINA;
      return {
        mensajes,
        siguiente: sig < TOTAL ? `p${sig / PAGINA}` : null,
      };
    };

    // Captura 1: tope de 2 páginas → guarda las 4 más recientes y deja el resto pendiente.
    const p1 = portal((c) => servir(c));
    const r1 = await capturar(m, p1, 2);
    expect(p1.llamadas).toBe(2);
    expect(r1.nuevos).toBe(4);
    expect(r1.pendientes).toBe(true);
    let est = await estadoDeCaptura(admin, m.c.id);
    expect(est?.cursor_pendiente).not.toBeNull();
    expect(est?.sincronizado_en).toBeNull();
    expect(await mensajesDe(admin, m.c.id)).toHaveLength(4);

    // Captura 2: tope por omisión (500) → rellena lo que faltaba, sin duplicados y sincroniza.
    const p2 = portal((c) => servir(c));
    const r2 = await capturar(m, p2);
    expect(r2.nuevos).toBe(TOTAL - 4);
    expect(r2.pendientes).toBe(false);
    const filas = await mensajesDe(admin, m.c.id);
    expect(filas).toHaveLength(TOTAL);
    expect(new Set(filas.map((f: any) => f.id_sunat)).size).toBe(TOTAL);
    est = await estadoDeCaptura(admin, m.c.id);
    expect(est?.cursor_pendiente).toBeNull();
    expect(est?.sincronizado_en).not.toBeNull();
  });
});
