// Spec 016 · T18 · ronda adversarial 1 sobre la subida del XML (D-1, D-4, D-8, D-11, P-5, P-6; CA-2, CA-12, CA-17).
// Caja negra (B1–B3) y caja blanca (B4, tras leer `app.ts`, `xml.service.ts`, `xml-entrada.ts` y `storage/local.ts`).
// No repite lo de T7 (`xml.int.spec.ts`). Una prueba en rojo es un hallazgo H-016-n.
import { request as pedirHttp } from "node:http";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBancoCompras, base, type Actor, type BancoCompras, type Estudio, type IdsPorNumero } from "../../../test/soporte-compras.js";
import { capturarLogs, ipUnica } from "../../../test/soporte.js";
import {
  archivosDe,
  bytes,
  cambiar,
  conTamano,
  documentosXml,
  pedirXml,
  prepararStorage,
  xmlDe,
  type NombreXml,
  type StoragePrueba,
} from "../../../test/soporte-xml.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

const MIB = 1024 * 1024;

let st: StoragePrueba;
let v: BancoCompras;
let E: Estudio;
let contador: Actor;

beforeAll(async () => {
  st = prepararStorage();
  v = await abrirBancoCompras();
  E = await v.estudio();
  contador = await v.b.c.p.b.miembro(E.tenantId, "contador");
});
afterAll(async () => {
  await v?.cerrar();
  st?.restaurar();
});

type Cliente = { id: string; ruc: string };

async function escenario(): Promise<{ c: Cliente; ids: IdsPorNumero }> {
  const c = await v.cliente(E, { responsable: contador.id });
  const ids = await v.sembrarFixture(E.tenantId, c.id, { usuarioId: E.titular.id });
  return { c, ids };
}
const rutaXml = (c: Cliente, id: string) => `${base(c.id)}/${id}/xml`;
const subir = (c: Cliente, id: string, xml: string | Uint8Array, tipo = "application/xml") =>
  pedirXml(v, contador, "POST", rutaXml(c, id), typeof xml === "string" ? bytes(xml) : xml, tipo);

interface Crudo {
  status: number;
  texto: string;
}

/**
 * POST con control total de cabeceras y del envío: `trozos` se escriben uno a uno (sin `Content-Length` el cuerpo va
 * fragmentado). Un corte de conexión por cuerpo enorme es status 0.
 */
function postCrudo(ruta: string, trozos: readonly Uint8Array[], cabeceras: Record<string, string>): Promise<Crudo> {
  const { port } = v.b.c.p.b.h.app.getHttpServer().address() as { port: number };
  return new Promise((resolver) => {
    const req = pedirHttp(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: ruta,
        headers: {
          "X-Forwarded-For": ipUnica(),
          Cookie: contador.cookie,
          "X-CSRF-Token": contador.csrf,
          "X-Estudio": contador.tenantId,
          Origin: process.env.APP_ORIGIN ?? "http://localhost:3000",
          ...cabeceras,
        },
      },
      (res) => {
        const partes: Buffer[] = [];
        res.on("data", (p: Buffer) => partes.push(p));
        res.on("end", () => resolver({ status: res.statusCode ?? 0, texto: Buffer.concat(partes).toString("utf8") }));
        res.on("error", () => resolver({ status: 0, texto: "" }));
      },
    );
    req.on("error", () => resolver({ status: 0, texto: "" }));
    for (const t of trozos) req.write(Buffer.from(t));
    req.end();
  });
}

async function nadaGuardado(c: Cliente): Promise<void> {
  expect(await documentosXml(v, c.id)).toEqual([]);
  expect(archivosDe(st.dir, E.tenantId, c.id)).toEqual([]);
}

// ---------------------------------------------------------------------------------------------------------- caja negra
describe("T18 · caja negra · saltar el tope de 1 MiB (CA-2)", () => {
  it("B1 · Content-Encoding gzip, deflate o br de 1 MiB + 1 descomprimido, y el cuerpo fragmentado sin Content-Length: 413 y nada guardado", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-2056"]!;
    const grande = conTamano(xmlDe("2056", c.ruc), MIB + 1);
    const comprimidos: [string, Uint8Array][] = [
      ["gzip", gzipSync(grande)],
      ["deflate", deflateSync(grande)],
      ["br", brotliCompressSync(grande)],
    ];
    for (const [codificacion, cuerpo] of comprimidos) {
      expect(cuerpo.length).toBeLessThan(64 * 1024); // pasa el tope comprimido, no descomprimido
      const r = await postCrudo(rutaXml(c, id), [cuerpo], {
        "Content-Type": "application/xml",
        "Content-Encoding": codificacion,
        "Content-Length": String(cuerpo.length),
      });
      expect([413, 415], `${codificacion}: ${r.status} ${r.texto.slice(0, 120)}`).toContain(r.status);
    }
    // Fragmentado: 17 trozos de 64 KiB (1 MiB + 64 KiB) sin Content-Length.
    const trozo = new Uint8Array(64 * 1024).fill(0x20);
    trozo.set(bytes(xmlDe("2056", c.ruc)));
    const r = await postCrudo(rutaXml(c, id), Array.from({ length: 17 }, () => trozo), {
      "Content-Type": "application/xml",
      "Transfer-Encoding": "chunked",
    });
    expect([0, 413], `fragmentado: ${r.status}`).toContain(r.status);
    await nadaGuardado(c);
  });

  it("B2 · tipos de contenido raros con un XML válido nunca dan 5xx, y lo que se guarda son los bytes enviados", async () => {
    const { c, ids } = await escenario();
    const casos: [NombreXml, string | null][] = [
      ["2056", null],
      ["1040", "multipart/form-data; boundary=----x"],
      ["3064", "application/x-www-form-urlencoded"],
      ["5070", "text/plain; charset=utf-16"],
      ["4062", "image/svg+xml"],
    ];
    for (const [nombre, tipo] of casos) {
      const cuerpo = bytes(xmlDe(nombre, c.ruc));
      const r = await postCrudo(rutaXml(c, ids[`F001-${nombre}`]!), [cuerpo], {
        ...(tipo === null ? {} : { "Content-Type": tipo }),
        "Content-Length": String(cuerpo.length),
      });
      expect(r.status, `${tipo}: ${r.texto.slice(0, 120)}`).toBeLessThan(500);
      const docs = (await documentosXml(v, c.id)).filter((d) => d.numero === nombre);
      if (r.status === 200) {
        expect(docs.length, String(tipo)).toBe(1);
        expect(docs[0]!.tamano, String(tipo)).toBe(cuerpo.length);
      } else {
        expect(docs, String(tipo)).toEqual([]);
      }
    }
  });

  it("B3 · dos subidas simultáneas del mismo XML (P-6): una 200 y otra 409, una sola fila y un solo archivo, sin canarios en logs", async () => {
    const { c, ids } = await escenario();
    const id = ids["F001-2056"]!;
    const marcado = cambiar(xmlDe("2056", c.ruc), "Producto gravado de prueba (PRUEBA)", "CANARIO-ADV-016-GLOSA");
    const { resultado, logs } = await capturarLogs(() => Promise.all([subir(c, id, marcado), subir(c, id, marcado), subir(c, id, marcado)]));
    const estados = resultado.map((r) => r.status).sort();
    expect(estados, resultado.map((r) => r.texto.slice(0, 80)).join(" | ")).toEqual([200, 409, 409]);
    for (const r of resultado.filter((x) => x.status === 409)) expect(r.json).toEqual({ codigo: "xml_existente" });
    expect((await documentosXml(v, c.id)).length).toBe(1);
    expect(archivosDe(st.dir, E.tenantId, c.id).length).toBe(1);
    expect(logs).not.toContain("CANARIO-ADV-016");
    expect(logs).not.toMatch(/xml\/[0-9a-f-]{36}\//);
  });
});

// ---------------------------------------------------------------------------------------------------------- caja blanca
describe("T18 · caja blanca · ruta de storage manipulada", () => {
  it("B4 · una fila documento_xml cuya ruta apunta al archivo de otro cliente no sirve esos bytes (GET xml → 404)", async () => {
    // xml.service.ts `descargar` lee `ruta` de la fila y la pasa al storage sin comprobar que es `xml/{tenant}/{cliente}/…`;
    // el CHECK de 0035 solo valida la gramática. Se simula una fila corrupta (o mal escrita) con la conexión de migraciones.
    const propio = await escenario();
    const ajeno = await escenario();
    const idPropio = propio.ids["F001-2056"]!;
    const xmlAjeno = cambiar(xmlDe("2056", ajeno.c.ruc), "Producto gravado de prueba (PRUEBA)", "CANARIO-ADV-016-AJENO");
    expect((await subir(ajeno.c, ajeno.ids["F001-2056"]!, xmlAjeno)).status).toBe(200);
    expect((await subir(propio.c, idPropio, xmlDe("2056", propio.c.ruc))).status).toBe(200);
    const [docAjeno] = await documentosXml(v, ajeno.c.id);
    const [docPropio] = await documentosXml(v, propio.c.id);
    await v.b.sql("update documento_xml set ruta = $2 where id = $1", [docPropio!.id, docAjeno!.ruta]);

    const r = await pedirXml(v, contador, "GET", rutaXml(propio.c, idPropio));
    expect(r.texto).not.toContain("CANARIO-ADV-016-AJENO");
    expect(r.status).toBe(404);
  });
});
