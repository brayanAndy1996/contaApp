/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD dinámicas en pruebas */
// Spec 023 · T17 (rojo) · correcciones de la ronda 1, worker (integración con PostgreSQL, Redis y BullMQ reales, un doble de
// `SolPortal` y un storage en memoria). Una prueba normal por hallazgo, con el comportamiento que fija la spec:
//  - H-023-1-2: con ids de adjunto repetidos, `resultado.adjuntos` y `resultado.omitidos` coinciden con lo guardado en BD y con la
//    auditoría `buzon.contenido_obtenido`.
//  - H-023-1-3: un adjunto con id de SUNAT inválido (más de 64 caracteres, NUL o vacío) se descarta sin guardarse y no cuenta ni en
//    `adjuntos` ni en `omitidos`; el contenido y los demás adjuntos sí se guardan y `obtenerMensaje` se llama una sola vez (cada
//    llamada puede marcar el mensaje como leído en SUNAT, RF-126). El fallo de datos posterior a `obtenerMensaje` sin reintento está
//    en `abrir-mensaje-r1.spec.ts`.
//  - H-023-1-4: asunto, remitente, id y código de tipo del portal se limpian de NUL y caracteres de control antes de insertarse
//    (como `sanearNombreAdjunto`); un mensaje así no detiene la captura: la coactiva más antigua de la página se guarda y se avisa.
import { randomBytes } from "node:crypto";
import type { ContappDb } from "@contapp/db";
import type { AdjuntoSol } from "@contapp/sunat";
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
  arrancar007b,
  esperarTerminal,
  guardarCredencial,
  type FilaTrabajo,
} from "../../../test/procesadores-007b.js";
import {
  AlmacenControlado,
  EscenarioBuzon,
  PortalControlado,
  adjuntosDe,
  avisosBuzon,
  comun,
  critico,
  encolarAbrir,
  encolarRevisar,
  insertarMensajeAdmin,
  mensajeDe,
  mensajesDe,
  type Mundo,
  type MsgPrueba,
} from "../../../test/buzon.js";
import {
  asignarResponsable,
  auditoriaDe,
  limpiarFilas017,
} from "../../../test/notificaciones.js";
import { canario } from "../../../test/soporte.js";
import {
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
  restaurarConfig,
} from "../../../test/trabajos.js";

vi.setConfig({ testTimeout: 150_000, hookTimeout: 60_000 });

let admin: ContappDb;
let backend: ContappDb;
let worker: ContappDb;
let redis: Redis;
let e: EscenarioBuzon;
let prefijo = nuevoPrefijo();
const prefijos = [prefijo];
let entornoAnterior: string | undefined;

beforeEach(() => {
  prefijo = nuevoPrefijo();
  prefijos.push(prefijo);
});

beforeAll(async () => {
  entornoAnterior = process.env.BUZON_PROGRAMADOR;
  process.env.BUZON_PROGRAMADOR = "off";
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  worker = crearDbRol("contapp_worker");
  redis = conectarRedis();
  e = new EscenarioBuzon(admin);
  await fijarConfig(admin, "sol", {
    global: 4,
    tenant: 2,
    espera: 0,
    reintentos: 2,
    base: 100,
  });
});

afterAll(async () => {
  if (entornoAnterior === undefined) delete process.env.BUZON_PROGRAMADOR;
  else process.env.BUZON_PROGRAMADOR = entornoAnterior;
  await restaurarConfig(admin).catch(() => undefined);
  await limpiarFilas017(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  for (const x of prefijos)
    await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), worker?.close(), admin?.close()]);
});

// ---------------------------------------------------------------------------------------------------------------
// Soporte local
// ---------------------------------------------------------------------------------------------------------------

async function mundo(): Promise<Mundo> {
  const T = await e.estudio();
  await e.usuario(T, "dueno");
  const u = await e.usuario(T, "contador");
  const c = await e.cliente(T);
  await asignarResponsable(admin, T, c.id, u);
  await guardarCredencial(backend, T, c.id, "sol", {
    usuario: canario("usuario_sol"),
    clave: canario("clave_sol"),
  });
  return { T, u, c };
}

async function conWorker<T>(
  portal: PortalControlado,
  almacen: AlmacenControlado | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const w = await arrancar007b({
    prefijo,
    solPortal: portal,
    ...(almacen === undefined ? {} : { storage: almacen }),
  } as Parameters<typeof arrancar007b>[0]);
  try {
    return await fn();
  } finally {
    await w.detener({ esperaMs: 2000 });
  }
}

const adj = (idSunat: string, nombre: string, bytes: Buffer): AdjuntoSol => ({
  idSunat,
  nombre,
  bytes,
});
const pdf = (extra = 1500): Buffer =>
  Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(extra)]);

interface Abierto {
  m: Mundo;
  mensajeId: string;
  portal: PortalControlado;
  almacen: AlmacenControlado;
  f: FilaTrabajo;
}

/** Un mensaje ya capturado (sin contenido) que el portal abre con `contenido` y `adjuntos`; encola «Abrir» y espera el fin. */
async function abrirCon(o: {
  contenido?: { formato: "texto" | "html"; cuerpo: string };
  adjuntos?: AdjuntoSol[];
}): Promise<Abierto> {
  const m = await mundo();
  const adjuntos = o.adjuntos ?? [];
  const mensajeId = await insertarMensajeAdmin(admin, m.T, m.c.id, {
    idSunat: "AB-1",
    adjuntosDeclarados: adjuntos.length,
  });
  const portal = new PortalControlado().buzon(m.c.ruc, [
    comun("AB-1", 1, {
      contenido: o.contenido ?? { formato: "texto", cuerpo: "Cuerpo" },
      adjuntos: adjuntos.map((a) => ({ idSunat: a.idSunat, nombre: a.nombre })),
      adjuntosBytes: adjuntos,
    }),
  ]);
  const almacen = new AlmacenControlado();
  const f = await conWorker(portal, almacen, async () => {
    const { id } = await encolarAbrir(backend, redis, prefijo, m, mensajeId);
    return esperarTerminal(e, id, 60_000);
  });
  return { m, mensajeId, portal, almacen, f };
}

const resultadoDe = (f: FilaTrabajo): Record<string, unknown> =>
  (f as { resultado?: Record<string, unknown> }).resultado ?? {};

const reRuta = (m: Mundo, ext: string): RegExp =>
  new RegExp(
    `^buzon/${m.T}/${m.c.id}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.${ext}$`,
  );

// ---------------------------------------------------------------------------------------------------------------
// H-023-1-2: el `resultado` de «Abrir» cuenta lo que guardó
// ---------------------------------------------------------------------------------------------------------------

describe("H-023-1-2 · ids de adjunto repetidos por el portal (D-10, CA-8)", () => {
  it("resultado.adjuntos y resultado.omitidos coinciden con lo guardado en BD y con la auditoría buzon.contenido_obtenido", async () => {
    const r = await abrirCon({
      adjuntos: [
        adj("D1", "uno.pdf", pdf()),
        adj("D1", "uno-copia.pdf", pdf()),
        adj("D2", "falso.pdf", Buffer.from("MZ ejecutable")),
        adj("D2", "bueno.pdf", pdf()),
        adj("D3", "falso-3.pdf", Buffer.from("MZ ejecutable")),
        adj("D3", "falso-3-bis.pdf", Buffer.from("MZ ejecutable")),
      ],
    });
    expect([r.f.estado, r.f.motivo]).toEqual(["completado", null]);
    const filas = await adjuntosDe(admin, r.mensajeId);
    const enBd = {
      adjuntos: filas.filter((x) => x.ruta !== null).length,
      omitidos: filas.filter((x) => x.omitido !== null).length,
    };
    // Un registro por id de SUNAT: dos guardados (D1, D2) y uno omitido (D3).
    expect(enBd).toEqual({ adjuntos: 2, omitidos: 1 });
    const aud = (
      await auditoriaDe(admin, r.m.T, "buzon.contenido_obtenido")
    ).find((a: any) => a.entidad_id === r.mensajeId) as any;
    expect(aud?.datos).toMatchObject(enBd);
    const res = resultadoDe(r.f);
    expect({ adjuntos: res.adjuntos, omitidos: res.omitidos }).toEqual(enBd);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// H-023-1-3: un adjunto con id de SUNAT inválido se descarta; la apertura sigue
// ---------------------------------------------------------------------------------------------------------------

describe("H-023-1-3 · id de adjunto inválido (CA-4, CA-8, D-4)", () => {
  it("un id de 65 caracteres, con NUL o vacío se descarta sin contar; el contenido y los demás adjuntos se guardan y el portal se llama una vez", async () => {
    const r = await abrirCon({
      contenido: {
        formato: "texto",
        cuerpo: "Resolución coactiva: pague en 7 días.",
      },
      adjuntos: [
        adj("OK-1", "resolucion.pdf", pdf()),
        adj("OK-2", "falso.pdf", Buffer.from("MZ ejecutable")),
        adj("X".repeat(65), "largo.pdf", pdf()),
        adj("N\u0000UL", "nul.pdf", pdf()),
        adj("", "vacio.pdf", pdf()),
        adj("Y".repeat(65), "largo-falso.pdf", Buffer.from("MZ ejecutable")),
      ],
    });
    // Cada llamada puede marcar el mensaje como leído en SUNAT (RF-126): una sola, sin reintentos.
    expect(r.portal.llamadasObtenerDe("AB-1")).toBe(1);
    expect([r.f.estado, r.f.motivo]).toEqual(["completado", null]);
    const fila = await mensajeDe(admin, r.m.c.id, "AB-1");
    expect(fila.contenido_ruta).not.toBeNull();
    const texto = Buffer.from(
      await r.almacen.leer(fila.contenido_ruta!),
    ).toString("utf8");
    expect(texto).toBe("Resolución coactiva: pague en 7 días.");
    // Solo quedan los de id válido: uno guardado y uno omitido por firma.
    const filas = await adjuntosDe(admin, r.mensajeId);
    expect(filas.map((x) => x.id_sunat)).toEqual(["OK-1", "OK-2"]);
    expect(filas[0]!.ruta).toMatch(reRuta(r.m, "pdf"));
    expect(filas[1]!.omitido).toBe("mime");
    // No cuentan ni en adjuntos ni en omitidos: ni en el resultado ni en la auditoría.
    const res = resultadoDe(r.f);
    expect({ adjuntos: res.adjuntos, omitidos: res.omitidos }).toEqual({
      adjuntos: 1,
      omitidos: 1,
    });
    const aud = (
      await auditoriaDe(admin, r.m.T, "buzon.contenido_obtenido")
    ).find((a: any) => a.entidad_id === r.mensajeId) as any;
    expect(aud?.datos).toMatchObject({ adjuntos: 1, omitidos: 1 });
    // Contenido y un adjunto en el storage; nada de los descartados.
    expect(r.almacen.rutas()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// H-023-1-4: los datos del listado se limpian antes de insertarse; la captura sigue
// ---------------------------------------------------------------------------------------------------------------

describe("H-023-1-4 · mensaje con NUL y controles en el listado (CA-3, CA-6, D-9)", () => {
  it("asunto, remitente, id y código de tipo se guardan limpios y la coactiva más antigua de la página se guarda y se avisa", async () => {
    const m = await mundo();
    const buzon: MsgPrueba[] = [
      comun("H-NUEVO", 1),
      comun("H-N\u0000U\u0007L", 2, {
        asunto: "Boletín\u0000 informativo\u0007 de mayo",
        remitente: "SU\u0000NAT\u001f",
        codigoTipo: "CT\u0000-9",
      }),
      critico("H-COAC", "coactiva", 3),
    ];
    const portal = new PortalControlado().buzon(m.c.ruc, buzon);
    const f = await conWorker(portal, undefined, async () => {
      const id = await encolarRevisar(backend, redis, prefijo, m);
      return esperarTerminal(e, id, 60_000);
    });
    expect([f.estado, f.motivo]).toEqual(["completado", null]);
    const filas = (await mensajesDe(admin, m.c.id)) as any[];
    expect(filas.map((x) => x.id_sunat).sort()).toEqual([
      "H-COAC",
      "H-NUEVO",
      "H-NUL",
    ]);
    const limpio = filas.find((x) => x.id_sunat === "H-NUL");
    expect(limpio.asunto).toBe("Boletín informativo de mayo");
    expect(limpio.remitente).toBe("SUNAT");
    expect(limpio.codigo_tipo).toBe("CT-9");
    for (const campo of ["id_sunat", "asunto", "remitente", "codigo_tipo"])
      for (const fila of filas)
        expect(
          /[\p{Cc}\p{Cf}]/u.test(String(fila[campo] ?? "")),
          `${campo} sin controles`,
        ).toBe(false);
    // La coactiva más antigua se guardó y se avisó.
    expect(filas.find((x) => x.id_sunat === "H-COAC")?.critico).toBe(true);
    expect((await avisosBuzon(admin, m.T, m.c.id)).length).toBeGreaterThan(0);
  });
});
