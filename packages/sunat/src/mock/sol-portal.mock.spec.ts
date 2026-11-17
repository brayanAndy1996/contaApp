import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  clasificarError,
  ErrorCredencial,
  ErrorDatos,
  ErrorTransitorio,
} from "../errores.js";
import type {
  CredencialSol,
  MetadatosMensajeSol,
  SolPortal,
} from "../puertos.js";
import {
  MockSolPortal,
  type MensajeFixtureSol,
} from "./sol-portal.mock.js";

// Spec 023 (D-1, D-2; CA-3, CA-4, CA-7, CA-8), RF-126. Contrato fijado por estas pruebas
// (packages/sunat/src/mock/sol-portal.mock.ts, `SOL_PORTAL=mock`):
//  - `new MockSolPortal({dirFixtures?, latenciaMs?, mensajesGenerados?})` implementa SolPortal. El buzón sale de
//    `{dirFixtures}/{ruc}.json` (forma `{mensajes: MensajeFixtureSol[]}`), de `inyectar(ruc, caso)` o, si no hay
//    ninguno, se GENERA de forma determinista por RUC (sin reloj ni azar): `mensajesGenerados` (>= 8, por defecto 12)
//    con al menos una coactiva, una RD, una RM, un requerimiento y varios comunes; adjuntos PDF, XML y uno hostil.
//  - Un adjunto de fixture es `{idSunat, nombre, base64}` (bytes reales) o `{idSunat, nombre, tamano}` (bytes
//    sintéticos deterministas que NO se materializan si superan el tope).
//  - `listarMensajes`: fecha desc, `idSunat` desc de desempate; cursor opaco y estable; `limite` entero >= 1;
//    cursor o limite inválidos -> ErrorDatos. NUNCA marca leído y no cuenta como `obtenerMensaje`.
//  - `obtenerMensaje`: cuenta la llamada, marca leído (`marcaLeido: true`, `leidosMarcados()` con `{ruc, idSunat}`
//    una vez por mensaje) y desde entonces la lista trae `leidoEnSunat: true`. Adjunto > `maxBytesAdjunto` (o que
//    pasa `maxBytesMensaje` acumulado) -> `{omitido: "tamano"}` sin bytes. Id inexistente -> ErrorDatos.
//  - `fallar("credencial" | "transitorio" | null, {veces?, despuesDe?})`: cuenta llamadas a `listarMensajes` y
//    `obtenerMensaje` desde que se arma; las primeras `despuesDe` pasan, las siguientes `veces` fallan (sin `veces`,
//    hasta `fallar(null)`). Las llamadas fallidas cuentan pero no marcan leído.
//  - `inyectar(ruc, {mensajes} | {error})`: sustituye el buzón de ese RUC, o hace fallar toda llamada de ese RUC.
//  - Centinela: `claveSol === "clave-errada"` -> ErrorCredencial (como MockSolAuth).
//  - Ningún error, registro ni resultado lleva usuario, clave ni RUC. Latencia: `latenciaMs` por llamada.
const CANARIO_USUARIO = "CANARIO-USUARIO-sol";
const CANARIO_CLAVE = "CANARIO-SOL-clave";
const RUC_A = "20100000001";
const RUC_B = "20100000002";
const cred = (ruc: string, extra: Partial<CredencialSol> = {}): CredencialSol => ({
  ruc,
  usuarioSol: CANARIO_USUARIO,
  claveSol: CANARIO_CLAVE,
  ...extra,
});
const TOPES = { maxBytesAdjunto: 20 * 1024 * 1024, maxBytesMensaje: 50 * 1024 * 1024 };

const sinTildes = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const CATEGORIAS = {
  coactiva: /coactiv/,
  determinacion: /determinacion/,
  multa: /multa/,
  requerimiento: /requerimiento/,
};
const esCritico = (m: MetadatosMensajeSol) =>
  Object.values(CATEGORIAS).some((re) => re.test(sinTildes(m.asunto)));

async function todas(
  p: SolPortal,
  c: CredencialSol,
  limite = 200,
): Promise<{ paginas: MetadatosMensajeSol[][]; mensajes: MetadatosMensajeSol[] }> {
  const paginas: MetadatosMensajeSol[][] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const r = await p.listarMensajes(c, { cursor, limite });
    paginas.push(r.mensajes);
    cursor = r.siguiente;
    if (cursor === null) break;
  }
  return { paginas, mensajes: paginas.flat() };
}

async function atrapar(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("se esperaba un error");
}

function mensaje(i: number, extra: Partial<MensajeFixtureSol> = {}): MensajeFixtureSol {
  const dia = String(1 + (i % 28)).padStart(2, "0");
  return {
    idSunat: `M-${String(i).padStart(6, "0")}`,
    asunto: `Comunicado general ${i}`,
    remitente: "SUNAT PRUEBA",
    fecha: `2026-10-${dia}T09:00:00-05:00`,
    codigoTipo: null,
    leidoEnSunat: false,
    adjuntos: [],
    contenido: { formato: "texto", cuerpo: `Cuerpo ${i}` },
    ...extra,
  };
}
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

describe("MockSolPortal · buzón generado y determinista (D-2, CA-3)", () => {
  it("implementa el puerto y trae una coactiva, una RD, una RM, un requerimiento y comunes", async () => {
    const puerto: SolPortal = new MockSolPortal();
    const { mensajes } = await todas(puerto, cred(RUC_A));
    expect(mensajes.length).toBeGreaterThanOrEqual(8);
    for (const [categoria, re] of Object.entries(CATEGORIAS)) {
      expect(
        mensajes.filter((m) => re.test(sinTildes(m.asunto))).length,
        categoria,
      ).toBeGreaterThanOrEqual(1);
    }
    expect(mensajes.filter((m) => !esCritico(m)).length).toBeGreaterThanOrEqual(3);
  });

  it("es determinista por RUC: dos instancias dan lo mismo y otro RUC da otro buzón", async () => {
    const uno = await todas(new MockSolPortal(), cred(RUC_A));
    const dos = await todas(new MockSolPortal(), cred(RUC_A));
    const otro = await todas(new MockSolPortal(), cred(RUC_B));
    expect(dos.paginas).toEqual(uno.paginas);
    const idsA = new Set(uno.mensajes.map((m) => m.idSunat));
    expect(otro.mensajes.some((m) => !idsA.has(m.idSunat))).toBe(true);
  });

  it("no depende del reloj: el buzón es el mismo con otra fecha del sistema", async () => {
    const antes = await todas(new MockSolPortal(), cred(RUC_A));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2031-01-01T00:00:00Z"));
      const despues = await todas(new MockSolPortal(), cred(RUC_A));
      expect(despues.paginas).toEqual(antes.paginas);
    } finally {
      vi.useRealTimers();
    }
  });

  it("devuelve de lo reciente a lo antiguo, con ids únicos y fechas ISO con zona", async () => {
    const { mensajes } = await todas(new MockSolPortal(), cred(RUC_A));
    const ids = mensajes.map((m) => m.idSunat);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of mensajes) {
      expect(m.fecha).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
      );
      expect(Number.isNaN(Date.parse(m.fecha))).toBe(false);
      expect(m.asunto.length).toBeGreaterThan(0);
      expect(m.asunto.length).toBeLessThanOrEqual(500);
      expect(m.remitente.length).toBeLessThanOrEqual(200);
      expect(m.codigoTipo === null || typeof m.codigoTipo === "string").toBe(true);
      expect(typeof m.leidoEnSunat).toBe("boolean");
    }
    for (let i = 1; i < mensajes.length; i++) {
      const a = mensajes[i - 1]!;
      const b = mensajes[i]!;
      const ta = Date.parse(a.fecha);
      const tb = Date.parse(b.fecha);
      expect(ta >= tb).toBe(true);
      if (ta === tb) expect(a.idSunat > b.idSunat).toBe(true);
    }
  });

  it("el buzón generado trae mensajes sin leer en SUNAT", async () => {
    const { mensajes } = await todas(new MockSolPortal(), cred(RUC_A));
    expect(mensajes.some((m) => m.leidoEnSunat === false)).toBe(true);
  });

  it("450 mensajes: páginas de 200, 200 y 50 sin huecos ni duplicados, con cursor estable", async () => {
    const puerto = new MockSolPortal({ mensajesGenerados: 450 });
    const { paginas, mensajes } = await todas(puerto, cred(RUC_A), 200);
    expect(paginas.map((p) => p.length)).toEqual([200, 200, 50]);
    expect(new Set(mensajes.map((m) => m.idSunat)).size).toBe(450);
    for (const re of Object.values(CATEGORIAS)) {
      expect(mensajes.some((m) => re.test(sinTildes(m.asunto)))).toBe(true);
    }
    // cursor estable: pedir dos veces la misma página da lo mismo, y recorrer otra vez da el mismo orden.
    const p1 = await puerto.listarMensajes(cred(RUC_A), { cursor: null, limite: 200 });
    expect(p1.siguiente).not.toBeNull();
    const p2a = await puerto.listarMensajes(cred(RUC_A), { cursor: p1.siguiente, limite: 200 });
    const p2b = await puerto.listarMensajes(cred(RUC_A), { cursor: p1.siguiente, limite: 200 });
    expect(p2b).toEqual(p2a);
    const otraVez = await todas(puerto, cred(RUC_A), 200);
    expect(otraVez.mensajes.map((m) => m.idSunat)).toEqual(mensajes.map((m) => m.idSunat));
    const ids1 = new Set(p1.mensajes.map((m) => m.idSunat));
    expect(p2a.mensajes.some((m) => ids1.has(m.idSunat))).toBe(false);
  });

  it("respeta `limite` y devuelve `siguiente` nulo solo en la última página", async () => {
    const puerto = new MockSolPortal({ mensajesGenerados: 25 });
    const r = await puerto.listarMensajes(cred(RUC_A), { cursor: null, limite: 10 });
    expect(r.mensajes).toHaveLength(10);
    expect(r.siguiente).not.toBeNull();
    const { paginas } = await todas(puerto, cred(RUC_A), 10);
    expect(paginas.map((p) => p.length)).toEqual([10, 10, 5]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "limite %s -> ErrorDatos",
    async (limite) => {
      const e = await atrapar(
        new MockSolPortal().listarMensajes(cred(RUC_A), { cursor: null, limite }),
      );
      expect(e).toBeInstanceOf(ErrorDatos);
    },
  );

  it.each(["zzz", "", "../../etc/passwd", "999999999999", '{"a":1}'])(
    "cursor inválido %j -> ErrorDatos",
    async (cursor) => {
      const e = await atrapar(
        new MockSolPortal().listarMensajes(cred(RUC_A), { cursor, limite: 10 }),
      );
      expect(e).toBeInstanceOf(ErrorDatos);
    },
  );

  it.each(["", "123", "2010000000A", "../20100000001", "20100000001\u0000", "20100000001/x"])(
    "RUC %j fuera de la gramática -> ErrorDatos sin tocar el disco",
    async (ruc) => {
      const puerto = new MockSolPortal();
      expect(
        await atrapar(puerto.listarMensajes(cred(ruc), { cursor: null, limite: 10 })),
      ).toBeInstanceOf(ErrorDatos);
      expect(
        await atrapar(puerto.obtenerMensaje(cred(ruc), "M-1", TOPES)),
      ).toBeInstanceOf(ErrorDatos);
    },
  );
});

describe("MockSolPortal · no marca leídos y registra las aperturas (RF-126, CA-4)", () => {
  it("listar todas las páginas no marca nada ni cuenta como obtenerMensaje", async () => {
    const puerto = new MockSolPortal({ mensajesGenerados: 450 });
    await todas(puerto, cred(RUC_A), 200);
    expect(puerto.leidosMarcados()).toEqual([]);
    expect(puerto.llamadasObtener()).toBe(0);
    expect(puerto.llamadasListar()).toBe(3);
  });

  it("obtenerMensaje cuenta la llamada, marca leído y lo registra con su RUC", async () => {
    const puerto = new MockSolPortal();
    const { mensajes } = await todas(puerto, cred(RUC_A));
    const objetivo = mensajes.find((m) => !m.leidoEnSunat)!;
    const r = await puerto.obtenerMensaje(cred(RUC_A), objetivo.idSunat, TOPES);
    expect(r.idSunat).toBe(objetivo.idSunat);
    expect(r.marcaLeido).toBe(true);
    expect(typeof r.contenido.cuerpo).toBe("string");
    expect(["texto", "html"]).toContain(r.contenido.formato);
    expect(puerto.llamadasObtener()).toBe(1);
    expect(puerto.llamadasObtenerDe(objetivo.idSunat)).toBe(1);
    expect(puerto.leidosMarcados()).toEqual([{ ruc: RUC_A, idSunat: objetivo.idSunat }]);
  });

  it("pedirlo dos veces cuenta dos llamadas y registra un solo marcado", async () => {
    const puerto = new MockSolPortal();
    const { mensajes } = await todas(puerto, cred(RUC_A));
    const id = mensajes[0]!.idSunat;
    await puerto.obtenerMensaje(cred(RUC_A), id, TOPES);
    await puerto.obtenerMensaje(cred(RUC_A), id, TOPES);
    expect(puerto.llamadasObtener()).toBe(2);
    expect(puerto.llamadasObtenerDe(id)).toBe(2);
    expect(puerto.leidosMarcados()).toHaveLength(1);
  });

  it("después de abrirlo, la lista lo trae leído y los demás siguen igual", async () => {
    const puerto = new MockSolPortal();
    const antes = (await todas(puerto, cred(RUC_A))).mensajes;
    const objetivo = antes.find((m) => !m.leidoEnSunat)!;
    await puerto.obtenerMensaje(cred(RUC_A), objetivo.idSunat, TOPES);
    const despues = (await todas(puerto, cred(RUC_A))).mensajes;
    expect(despues.find((m) => m.idSunat === objetivo.idSunat)!.leidoEnSunat).toBe(true);
    for (const m of despues.filter((x) => x.idSunat !== objetivo.idSunat)) {
      expect(m.leidoEnSunat).toBe(antes.find((a) => a.idSunat === m.idSunat)!.leidoEnSunat);
    }
  });

  it("el registro es por RUC: abrir en un buzón no marca el de otro RUC", async () => {
    const puerto = new MockSolPortal();
    const a = (await todas(puerto, cred(RUC_A))).mensajes[0]!;
    await puerto.obtenerMensaje(cred(RUC_A), a.idSunat, TOPES);
    const deB = (await todas(puerto, cred(RUC_B))).mensajes;
    expect(deB.filter((m) => m.leidoEnSunat === false).length).toBeGreaterThan(0);
    expect(puerto.leidosMarcados().every((x) => x.ruc === RUC_A)).toBe(true);
  });

  it("id inexistente -> ErrorDatos; la llamada cuenta y no marca nada", async () => {
    const puerto = new MockSolPortal();
    expect(
      await atrapar(puerto.obtenerMensaje(cred(RUC_A), "NO-EXISTE", TOPES)),
    ).toBeInstanceOf(ErrorDatos);
    expect(puerto.llamadasObtener()).toBe(1);
    expect(puerto.leidosMarcados()).toEqual([]);
  });

  it("leidosMarcados() devuelve una copia y no guarda credenciales", async () => {
    const puerto = new MockSolPortal();
    const id = (await todas(puerto, cred(RUC_A))).mensajes[0]!.idSunat;
    await puerto.obtenerMensaje(cred(RUC_A), id, TOPES);
    const copia = puerto.leidosMarcados() as { ruc: string; idSunat: string }[];
    try {
      copia.push({ ruc: "x", idSunat: "x" });
    } catch {
      /* si es de solo lectura, también vale */
    }
    expect(puerto.leidosMarcados()).toHaveLength(1);
    expect(JSON.stringify(puerto.leidosMarcados())).not.toContain("CANARIO");
  });
});

describe("MockSolPortal · contenido y adjuntos (D-2, CA-8)", () => {
  it("el buzón generado trae contenido en texto y en HTML, con adjuntos PDF, XML y uno hostil", async () => {
    const puerto = new MockSolPortal({ mensajesGenerados: 40 });
    const { mensajes } = await todas(puerto, cred(RUC_A));
    const formatos = new Set<string>();
    const adjuntos: { nombre: string; bytes?: Uint8Array; omitido?: string }[] = [];
    for (const m of mensajes) {
      const r = await puerto.obtenerMensaje(cred(RUC_A), m.idSunat, TOPES);
      formatos.add(r.contenido.formato);
      expect(r.adjuntos.map((a) => a.idSunat)).toEqual(m.adjuntos.map((a) => a.idSunat));
      expect(r.adjuntos.map((a) => a.nombre)).toEqual(m.adjuntos.map((a) => a.nombre));
      for (const a of r.adjuntos) adjuntos.push(a as never);
    }
    expect(formatos).toEqual(new Set(["texto", "html"]));
    const pdf = adjuntos.find((a) => /\.pdf$/i.test(a.nombre) && a.bytes);
    expect(pdf).toBeDefined();
    expect(Buffer.from(pdf!.bytes!).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const xml = adjuntos.find((a) => /\.xml$/i.test(a.nombre) && a.bytes);
    expect(xml).toBeDefined();
    expect(Buffer.from(xml!.bytes!).toString("utf8").trimStart().startsWith("<")).toBe(true);
    expect(
      adjuntos.some((a) =>
        /\.\.[\\/]|[\\/]|\u0000|[\u0001-\u001f‪-‮⁦-⁩]/u.test(a.nombre),
      ),
    ).toBe(true);
  });

  it("los bytes de un adjunto del fixture salen idénticos a los declarados", async () => {
    const original = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3, 250, 251, 252]);
    const puerto = new MockSolPortal();
    puerto.inyectar(RUC_A, {
      mensajes: [
        mensaje(1, { adjuntos: [{ idSunat: "A1", nombre: "a.pdf", base64: b64(original) }] }),
      ],
    });
    const r = await puerto.obtenerMensaje(cred(RUC_A), "M-000001", TOPES);
    const adj = r.adjuntos[0]!;
    expect("bytes" in adj).toBe(true);
    expect(Array.from((adj as { bytes: Uint8Array }).bytes)).toEqual(Array.from(original));
  });

  it("un adjunto mayor que el tope sale omitido por tamaño, sin leerlo ni materializarlo entero", async () => {
    const puerto = new MockSolPortal();
    puerto.inyectar(RUC_A, {
      mensajes: [
        mensaje(1, {
          adjuntos: [{ idSunat: "A1", nombre: "enorme.zip", tamano: 5 * 1024 ** 4 }],
        }),
      ],
    });
    const t0 = Date.now();
    const r = await puerto.obtenerMensaje(cred(RUC_A), "M-000001", TOPES);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.adjuntos).toEqual([{ idSunat: "A1", nombre: "enorme.zip", omitido: "tamano" }]);
    expect("bytes" in r.adjuntos[0]!).toBe(false);
  });

  it("frontera del tope: igual al tope pasa, un byte más se omite", async () => {
    const puerto = new MockSolPortal();
    puerto.inyectar(RUC_A, {
      mensajes: [
        mensaje(1, {
          adjuntos: [
            { idSunat: "A1", nombre: "justo.bin", tamano: 100 },
            { idSunat: "A2", nombre: "pasado.bin", tamano: 101 },
          ],
        }),
      ],
    });
    const r = await puerto.obtenerMensaje(cred(RUC_A), "M-000001", {
      maxBytesAdjunto: 100,
      maxBytesMensaje: 10_000,
    });
    const [justo, pasado] = r.adjuntos;
    expect((justo as { bytes: Uint8Array }).bytes).toHaveLength(100);
    expect(pasado).toEqual({ idSunat: "A2", nombre: "pasado.bin", omitido: "tamano" });
  });

  it("el tope del mensaje es acumulado: el adjunto que lo hace pasar sale omitido", async () => {
    const puerto = new MockSolPortal();
    puerto.inyectar(RUC_A, {
      mensajes: [
        mensaje(1, {
          adjuntos: [
            { idSunat: "A1", nombre: "uno.bin", tamano: 600 },
            { idSunat: "A2", nombre: "dos.bin", tamano: 600 },
          ],
        }),
      ],
    });
    const r = await puerto.obtenerMensaje(cred(RUC_A), "M-000001", {
      maxBytesAdjunto: 1000,
      maxBytesMensaje: 1000,
    });
    expect("bytes" in r.adjuntos[0]!).toBe(true);
    expect(r.adjuntos[1]).toEqual({ idSunat: "A2", nombre: "dos.bin", omitido: "tamano" });
  });

  it("los bytes sintéticos por `tamano` son deterministas", async () => {
    const puerto = new MockSolPortal();
    puerto.inyectar(RUC_A, {
      mensajes: [mensaje(1, { adjuntos: [{ idSunat: "A1", nombre: "x.bin", tamano: 2048 }] })],
    });
    const a = await puerto.obtenerMensaje(cred(RUC_A), "M-000001", TOPES);
    const b = await puerto.obtenerMensaje(cred(RUC_A), "M-000001", TOPES);
    const ba = (a.adjuntos[0] as { bytes: Uint8Array }).bytes;
    expect(ba).toHaveLength(2048);
    expect(
      Buffer.from(ba).equals(Buffer.from((b.adjuntos[0] as { bytes: Uint8Array }).bytes)),
    ).toBe(true);
  });
});

describe("MockSolPortal · fixture en disco e `inyectar` (D-2)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sol-portal-"));
    writeFileSync(
      join(dir, `${RUC_A}.json`),
      JSON.stringify({
        mensajes: [
          mensaje(1, { asunto: "Aviso de fixture uno", fecha: "2026-10-02T10:00:00-05:00" }),
          mensaje(2, {
            asunto: "Aviso de fixture dos",
            fecha: "2026-10-03T10:00:00-05:00",
            leidoEnSunat: true,
          }),
        ],
      }),
    );
    writeFileSync(join(dir, `${RUC_B}.json`), "{ esto no es json");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("usa {ruc}.json de la carpeta de fixtures en lugar del buzón generado, de lo reciente a lo antiguo", async () => {
    const puerto = new MockSolPortal({ dirFixtures: dir });
    const { mensajes } = await todas(puerto, cred(RUC_A));
    expect(mensajes.map((m) => m.asunto)).toEqual(["Aviso de fixture dos", "Aviso de fixture uno"]);
    expect(mensajes[0]!.leidoEnSunat).toBe(true);
    const r = await puerto.obtenerMensaje(cred(RUC_A), "M-000001", TOPES);
    expect(r.contenido).toEqual({ formato: "texto", cuerpo: "Cuerpo 1" });
  });

  it("fixture ilegible -> ErrorDatos con mensaje fijo, sin RUC ni ruta", async () => {
    const puerto = new MockSolPortal({ dirFixtures: dir });
    const e = await atrapar(puerto.listarMensajes(cred(RUC_B), { cursor: null, limite: 10 }));
    expect(e).toBeInstanceOf(ErrorDatos);
    const texto = `${String(e)} ${JSON.stringify(e)} ${(e as Error).stack}`;
    expect(texto).not.toContain(RUC_B);
    expect(texto).not.toContain(dir);
  });

  it("`inyectar` con mensajes sustituye el buzón de ese RUC y deja intacto el de otro", async () => {
    const puerto = new MockSolPortal({ dirFixtures: dir });
    puerto.inyectar(RUC_A, { mensajes: [mensaje(7, { asunto: "Solo este" })] });
    expect((await todas(puerto, cred(RUC_A))).mensajes.map((m) => m.asunto)).toEqual(["Solo este"]);
    const otro = await todas(new MockSolPortal({ dirFixtures: dir }), cred("20100000003"));
    expect(otro.mensajes.length).toBeGreaterThanOrEqual(8);
  });

  it("`inyectar` con error lo lanza tal cual en ambas operaciones, solo para ese RUC", async () => {
    const puerto = new MockSolPortal();
    const mio = new ErrorTransitorio();
    puerto.inyectar(RUC_A, { error: mio });
    expect(await atrapar(puerto.listarMensajes(cred(RUC_A), { cursor: null, limite: 5 }))).toBe(mio);
    expect(await atrapar(puerto.obtenerMensaje(cred(RUC_A), "M-1", TOPES))).toBe(mio);
    await expect(
      puerto.listarMensajes(cred(RUC_B), { cursor: null, limite: 5 }),
    ).resolves.toBeDefined();
  });
});

describe("MockSolPortal · fallar() (D-9, CA-7)", () => {
  it("credencial: ambas operaciones lanzan ErrorCredencial hasta fallar(null)", async () => {
    const puerto = new MockSolPortal();
    const id = (await todas(puerto, cred(RUC_A))).mensajes[0]!.idSunat;
    puerto.fallar("credencial");
    expect(
      await atrapar(puerto.listarMensajes(cred(RUC_A), { cursor: null, limite: 10 })),
    ).toBeInstanceOf(ErrorCredencial);
    expect(await atrapar(puerto.obtenerMensaje(cred(RUC_A), id, TOPES))).toBeInstanceOf(
      ErrorCredencial,
    );
    puerto.fallar(null);
    await expect(
      puerto.listarMensajes(cred(RUC_A), { cursor: null, limite: 10 }),
    ).resolves.toBeDefined();
  });

  it("transitorio: ErrorTransitorio con su clase", async () => {
    const puerto = new MockSolPortal();
    puerto.fallar("transitorio");
    const e = await atrapar(puerto.listarMensajes(cred(RUC_A), { cursor: null, limite: 10 }));
    expect(e).toBeInstanceOf(ErrorTransitorio);
    expect(clasificarError(e).clase).toBe("transitorio");
  });

  it("falla antes del login: la primera llamada falla y no entrega ninguna página", async () => {
    const puerto = new MockSolPortal({ mensajesGenerados: 450 });
    puerto.fallar("credencial");
    const e = await atrapar(puerto.listarMensajes(cred(RUC_A), { cursor: null, limite: 200 }));
    expect(e).toBeInstanceOf(ErrorCredencial);
  });

  it("despuesDe: 1 deja pasar la página 1 y falla la 2 (credencial a mitad de la captura)", async () => {
    const puerto = new MockSolPortal({ mensajesGenerados: 450 });
    puerto.fallar("credencial", { despuesDe: 1 });
    const p1 = await puerto.listarMensajes(cred(RUC_A), { cursor: null, limite: 200 });
    expect(p1.mensajes).toHaveLength(200);
    expect(p1.siguiente).not.toBeNull();
    for (let i = 0; i < 2; i++) {
      expect(
        await atrapar(
          puerto.listarMensajes(cred(RUC_A), { cursor: p1.siguiente, limite: 200 }),
        ),
      ).toBeInstanceOf(ErrorCredencial);
    }
    puerto.fallar(null);
    const p2 = await puerto.listarMensajes(cred(RUC_A), { cursor: p1.siguiente, limite: 200 });
    expect(p2.mensajes).toHaveLength(200);
  });

  it("transitorio con veces y despuesDe: falla n llamadas y luego se recupera con el mismo cursor", async () => {
    const puerto = new MockSolPortal({ mensajesGenerados: 450 });
    puerto.fallar("transitorio", { veces: 2, despuesDe: 1 });
    const p1 = await puerto.listarMensajes(cred(RUC_A), { cursor: null, limite: 200 });
    for (let i = 0; i < 2; i++) {
      expect(
        await atrapar(
          puerto.listarMensajes(cred(RUC_A), { cursor: p1.siguiente, limite: 200 }),
        ),
      ).toBeInstanceOf(ErrorTransitorio);
    }
    const p2 = await puerto.listarMensajes(cred(RUC_A), { cursor: p1.siguiente, limite: 200 });
    expect(p2.mensajes).toHaveLength(200);
    const sinFallo = await todas(new MockSolPortal({ mensajesGenerados: 450 }), cred(RUC_A), 200);
    expect([...p1.mensajes, ...p2.mensajes].map((m) => m.idSunat)).toEqual(
      sinFallo.mensajes.slice(0, 400).map((m) => m.idSunat),
    );
  });

  it("el contador cuenta páginas y mensajes: despuesDe: 2 permite listar y abrir y falla la tercera llamada", async () => {
    const puerto = new MockSolPortal();
    const id = (await todas(puerto, cred(RUC_A))).mensajes[0]!.idSunat;
    puerto.fallar("transitorio", { despuesDe: 2, veces: 1 });
    await puerto.listarMensajes(cred(RUC_A), { cursor: null, limite: 5 });
    await puerto.obtenerMensaje(cred(RUC_A), id, TOPES);
    expect(
      await atrapar(puerto.listarMensajes(cred(RUC_A), { cursor: null, limite: 5 })),
    ).toBeInstanceOf(ErrorTransitorio);
    await expect(
      puerto.listarMensajes(cred(RUC_A), { cursor: null, limite: 5 }),
    ).resolves.toBeDefined();
  });

  it("volver a armar fallar() reinicia la cuenta de despuesDe", async () => {
    const puerto = new MockSolPortal();
    puerto.fallar("transitorio", { despuesDe: 1, veces: 1 });
    await puerto.listarMensajes(cred(RUC_A), { cursor: null, limite: 5 });
    puerto.fallar("transitorio", { despuesDe: 1, veces: 1 });
    await expect(
      puerto.listarMensajes(cred(RUC_A), { cursor: null, limite: 5 }),
    ).resolves.toBeDefined();
    expect(
      await atrapar(puerto.listarMensajes(cred(RUC_A), { cursor: null, limite: 5 })),
    ).toBeInstanceOf(ErrorTransitorio);
  });

  it("una apertura que falla cuenta como llamada pero no marca leído", async () => {
    const puerto = new MockSolPortal();
    const id = (await todas(puerto, cred(RUC_A))).mensajes[0]!.idSunat;
    puerto.fallar("transitorio", { veces: 1 });
    expect(await atrapar(puerto.obtenerMensaje(cred(RUC_A), id, TOPES))).toBeInstanceOf(
      ErrorTransitorio,
    );
    expect(puerto.llamadasObtener()).toBe(1);
    expect(puerto.leidosMarcados()).toEqual([]);
    const r = await puerto.obtenerMensaje(cred(RUC_A), id, TOPES);
    expect(r.marcaLeido).toBe(true);
    expect(puerto.leidosMarcados()).toHaveLength(1);
  });

  it("clave centinela «clave-errada» -> ErrorCredencial en ambas operaciones, antes de cualquier dato", async () => {
    const puerto = new MockSolPortal();
    const mala = cred(RUC_A, { claveSol: "clave-errada" });
    expect(
      await atrapar(puerto.listarMensajes(mala, { cursor: null, limite: 10 })),
    ).toBeInstanceOf(ErrorCredencial);
    expect(await atrapar(puerto.obtenerMensaje(mala, "M-1", TOPES))).toBeInstanceOf(
      ErrorCredencial,
    );
    expect(puerto.leidosMarcados()).toEqual([]);
    await expect(
      puerto.listarMensajes(cred(RUC_A), { cursor: null, limite: 10 }),
    ).resolves.toBeDefined();
  });
});

describe("MockSolPortal · credencial y secretos (D-1, D-10)", () => {
  it("los errores no llevan usuario, clave ni RUC (canario en message, String, JSON y stack)", async () => {
    const puerto = new MockSolPortal();
    const errores: unknown[] = [];
    errores.push(
      await atrapar(
        puerto.listarMensajes(cred(RUC_A, { claveSol: "clave-errada" }), {
          cursor: null,
          limite: 5,
        }),
      ),
    );
    errores.push(await atrapar(puerto.listarMensajes(cred(RUC_A), { cursor: "no", limite: 5 })));
    errores.push(await atrapar(puerto.obtenerMensaje(cred(RUC_A), "NO-EXISTE", TOPES)));
    for (const modo of ["credencial", "transitorio"] as const) {
      puerto.fallar(modo);
      errores.push(await atrapar(puerto.listarMensajes(cred(RUC_A), { cursor: null, limite: 5 })));
      errores.push(await atrapar(puerto.obtenerMensaje(cred(RUC_A), "M-1", TOPES)));
    }
    puerto.fallar(null);
    errores.push(await atrapar(puerto.listarMensajes(cred("../x"), { cursor: null, limite: 5 })));
    for (const e of errores) {
      expect(e).toBeInstanceOf(Error);
      const texto = `${(e as Error).message} ${String(e)} ${JSON.stringify(e)} ${(e as Error).stack}`;
      expect(texto).not.toContain("CANARIO");
      expect(texto).not.toContain("clave-errada");
      expect(texto).not.toContain(RUC_A);
    }
  });

  it("las respuestas no hacen eco de la credencial", async () => {
    const puerto = new MockSolPortal();
    const pagina = await puerto.listarMensajes(cred(RUC_A), { cursor: null, limite: 200 });
    const id = pagina.mensajes[0]!.idSunat;
    const msg = await puerto.obtenerMensaje(cred(RUC_A), id, TOPES);
    const volcado =
      JSON.stringify(pagina) +
      JSON.stringify({ ...msg, adjuntos: msg.adjuntos.map((a) => a.nombre) });
    expect(volcado).not.toContain("CANARIO");
  });

  it("no conserva la credencial: mutar el objeto después no cambia lo ya devuelto ni la siguiente llamada", async () => {
    const puerto = new MockSolPortal();
    const c = cred(RUC_A);
    const antes = await puerto.listarMensajes(c, { cursor: null, limite: 200 });
    c.ruc = RUC_B;
    const otra = await puerto.listarMensajes(cred(RUC_A), { cursor: null, limite: 200 });
    expect(otra).toEqual(antes);
  });
});

describe("MockSolPortal · latencia (SOL_MOCK_LATENCIA_MS)", () => {
  afterEach(() => vi.useRealTimers());

  it("con latenciaMs, cada llamada espera antes de resolver", async () => {
    vi.useFakeTimers();
    const puerto = new MockSolPortal({ latenciaMs: 500 });
    let listo = false;
    const p = puerto.listarMensajes(cred(RUC_A), { cursor: null, limite: 5 }).then((r) => {
      listo = true;
      return r;
    });
    p.catch(() => undefined); // evita un rechazo sin manejar si el mock aún no está implementado
    await vi.advanceTimersByTimeAsync(499);
    expect(listo).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBeDefined();
    expect(listo).toBe(true);

    let abierto = false;
    const q = puerto.obtenerMensaje(cred(RUC_A), "M-NO-IMPORTA", TOPES).catch(() => {
      abierto = true;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(abierto).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await q;
    expect(abierto).toBe(true);
  });

  it("sin latencia responde sin esperar", async () => {
    const t0 = Date.now();
    await new MockSolPortal().listarMensajes(cred(RUC_A), { cursor: null, limite: 5 });
    expect(Date.now() - t0).toBeLessThan(100);
  });
});
