/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 023 · T6 (rojo): GET /clientes/:clienteId/buzon/mensajes/:mensajeId/adjuntos/:adjuntoId (D-4, D-8, P-10; CA-8, CA-9, CA-10, CA-13).
// Contrato fijado por estas pruebas (módulo `buzon` de T13; errores `{codigo}`):
//  - Permiso `buzon.ver` con el alcance por cliente de `ClienteScopeGuard`. Lee el archivo del puerto de storage por la `ruta` de la fila
//    (nunca por nada que venga de la petición) y NO llama a SUNAT.
//  - 200 con los bytes del adjunto IDÉNTICOS a los guardados (mismo SHA-256 que el de la fila) y las cabeceras: `Content-Type` = el MIME
//    de la fila (el decidido por firma al guardar), `Content-Disposition: attachment; filename*=UTF-8''<nombre>` con el nombre SANEADO
//    (sin rutas, sin controles ni bidi, ≤ 120, nada que inyecte cabeceras), `X-Content-Type-Options: nosniff` y `Cache-Control: no-store`.
//  - Un adjunto omitido (sin `ruta`) es 404 `no_encontrado`: no hay archivo que dar.
//  - Cada descarga audita `buzon.adjunto_descargado` (actor usuario, entidad `buzon_adjunto`, datos `{ mensajeId, adjuntoId }`).
//  - Cliente, mensaje o adjunto de otro estudio, no asignado, de otro cliente, cruzado (el adjunto no es del mensaje de la ruta) o
//    inexistente: el mismo 404 `no_encontrado`. Archivado (CA-13): la descarga sigue.
// Rojo: el módulo `buzon` aún no existe (T13): toda ruta responde 404 de ruta inexistente.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoBuzon,
  nombreDeDisposicion,
  sha256Hex,
  type Actor,
  type BancoBuzon,
  type Estudio,
  type OpcionesAdjunto,
} from "../../../test/soporte-buzon.js";
import { capturarLogs } from "../../../test/soporte.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

let b: BancoBuzon;
let E: Estudio;
let contador: Actor;
let asistente: Actor;
let lectura: Actor;

beforeAll(async () => {
  b = await abrirBancoBuzon();
  E = await b.estudio();
  const p = b.v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
  lectura = await p.miembro(E.tenantId, "lectura");
});
afterAll(async () => {
  await b?.cerrar();
});

const ruta = (c: string, m: string, a: string): string =>
  `/clientes/${c}/buzon/mensajes/${m}/adjuntos/${a}`;
const bajar = (a: Actor, c: string, m: string, adjunto: string) =>
  b.bin(a, "GET", ruta(c, m, adjunto));
const nuevo = (o: Parameters<BancoBuzon["cliente"]>[1] = {}, e: Estudio = E) =>
  b.cliente(e, {
    responsable: contador.id,
    colaboradores: [asistente.id, lectura.id],
    ...o,
  });
/** Cliente con un mensaje abierto y un adjunto guardado. */
const conAdjunto = async (
  o: OpcionesAdjunto = {},
  cliente: Parameters<BancoBuzon["cliente"]>[1] = {},
) => {
  const c = await nuevo(cliente);
  const m = await b.sembrarMensaje(E.tenantId, c.id, {
    contenido: "Ver adjunto.",
    declarados: 1,
    critico: true,
  });
  const adj = await b.sembrarAdjunto(E.tenantId, c.id, m.id, o);
  return { c, m, adj };
};
const pdf = (n = 64 * 1024): Buffer =>
  Buffer.concat([
    Buffer.from("%PDF-1.7\n", "latin1"),
    randomBytes(n),
    Buffer.from("\n%%EOF\n", "latin1"),
  ]);
const auditoriaDescarga = async (adjuntoId: string) =>
  (await b.auditoria(E.tenantId, "buzon.adjunto_descargado")).filter(
    (f) => f.entidad_id === adjuntoId,
  );

describe("CA-8 · el adjunto se descarga idéntico, como adjunto, con nosniff y sin caché", () => {
  it("200 con los mismos bytes y el mismo SHA-256 que el guardado y que el de la fila", async () => {
    const bytes = pdf();
    const { c, m, adj } = await conAdjunto({
      bytes,
      nombre: "resolucion-coactiva.pdf",
    });
    const r = await bajar(contador, c.id, m.id, adj.id);
    expect(r.status, r.texto.slice(0, 200)).toBe(200);
    expect(r.bytes.length).toBe(bytes.length);
    expect(Buffer.compare(r.bytes, bytes)).toBe(0);
    const recibido = createHash("sha256").update(r.bytes).digest("hex");
    expect(recibido).toBe(sha256Hex(bytes));
    const fila = (
      await b.v.b.sql(
        "select encode(sha256, 'hex') as h, tamano::int as t from buzon_adjunto where id = $1",
        [adj.id],
      )
    )[0];
    expect(recibido).toBe(fila.h);
    expect(fila.t).toBe(bytes.length);
  });

  it("cabeceras: Content-Type de la fila, attachment con nombre, nosniff, no-store y longitud exacta", async () => {
    const bytes = pdf(2048);
    const { c, m, adj } = await conAdjunto({
      bytes,
      nombre: "Resolución de multa 2026.pdf",
    });
    const r = await bajar(asistente, c.id, m.id, adj.id);
    expect(r.status).toBe(200);
    expect(String(r.headers["content-type"])).toMatch(/^application\/pdf/);
    const disp = String(r.headers["content-disposition"]);
    expect(disp).toMatch(/^attachment;/);
    expect(disp).toMatch(/filename\*=UTF-8''/i);
    expect(nombreDeDisposicion(disp)).toBe("Resolución de multa 2026.pdf");
    expect(String(r.headers["x-content-type-options"]).toLowerCase()).toBe(
      "nosniff",
    );
    expect(String(r.headers["cache-control"])).toMatch(/no-store/);
    expect(Number(r.headers["content-length"])).toBe(bytes.length);
  });

  it.each([
    ["application/xml", "xml", "comprobante.xml"],
    ["image/png", "png", "captura.png"],
    ["image/jpeg", "jpg", "foto.jpg"],
    ["application/zip", "zip", "anexos.zip"],
  ])(
    "un adjunto %s sale con su MIME, attachment y nosniff",
    async (mime, ext, nombre) => {
      const bytes = Buffer.concat([
        Buffer.from("PK\u0003\u0004", "latin1"),
        randomBytes(512),
      ]);
      const { c, m, adj } = await conAdjunto({ bytes, mime, ext, nombre });
      const r = await bajar(contador, c.id, m.id, adj.id);
      expect(r.status).toBe(200);
      expect(String(r.headers["content-type"])).toMatch(
        new RegExp(`^${mime.replace("/", "\\/")}`),
      );
      expect(String(r.headers["content-disposition"])).toMatch(/^attachment;/);
      expect(String(r.headers["x-content-type-options"]).toLowerCase()).toBe(
        "nosniff",
      );
      expect(Buffer.compare(r.bytes, bytes)).toBe(0);
    },
  );

  it("un adjunto de 3 MiB llega completo e idéntico", async () => {
    const bytes = pdf(3 * 1024 * 1024);
    const { c, m, adj } = await conAdjunto({ bytes, nombre: "grande.pdf" });
    const r = await bajar(contador, c.id, m.id, adj.id);
    expect(r.status).toBe(200);
    expect(r.bytes.length).toBe(bytes.length);
    expect(createHash("sha256").update(r.bytes).digest("hex")).toBe(
      sha256Hex(bytes),
    );
  });

  it.each([
    ["../../etc/passwd"],
    ["..\\..\\windows\\system32\\config.pdf"],
    ['evil"\r\nX-Inyectado: 1\r\n\r\n<script>.pdf'],
    ["‮gnp.exe"],
    ["a\u0001b\u007Fc\u0085d.pdf"],
    ["x".repeat(200) + ".pdf"],
  ])(
    "el nombre hostil %j se sanea: sin rutas, controles, bidi ni inyección de cabeceras",
    async (nombre) => {
      const { c, m, adj } = await conAdjunto({ nombre });
      const r = await bajar(contador, c.id, m.id, adj.id);
      expect(r.status, r.texto.slice(0, 200)).toBe(200);
      expect(r.headers["x-inyectado"]).toBeUndefined();
      const disp = String(r.headers["content-disposition"]);
      expect(disp).not.toMatch(/[\r\n]/);
      const limpio = nombreDeDisposicion(disp);
      expect(limpio).not.toBeNull();
      expect(limpio!.length).toBeGreaterThan(0);
      expect(limpio!.length).toBeLessThanOrEqual(120);
      expect(limpio).not.toMatch(/[/\\]/);
      expect(limpio).not.toContain("..");
      expect(limpio).not.toMatch(/[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/);
      expect(disp).toMatch(/^attachment;/);
    },
  );

  it("audita buzon.adjunto_descargado por cada descarga: usuario, adjunto y mensaje, sin el nombre ni el RUC", async () => {
    const { c, m, adj } = await conAdjunto({
      nombre: "CANARIO-nombre-descarga.pdf",
    });
    const previas = (await auditoriaDescarga(adj.id)).length;
    expect((await bajar(lectura, c.id, m.id, adj.id)).status).toBe(200);
    const filas = await auditoriaDescarga(adj.id);
    expect(filas).toHaveLength(previas + 1);
    expect(filas.at(-1)).toMatchObject({
      actor_tipo: "usuario",
      usuario_id: lectura.id,
      entidad: "buzon_adjunto",
      cliente_id: c.id,
    });
    expect(filas.at(-1)!.datos).toEqual({ mensajeId: m.id, adjuntoId: adj.id });
    expect(JSON.stringify(filas.at(-1))).not.toContain("CANARIO");
    expect(JSON.stringify(filas.at(-1))).not.toContain(c.ruc);
    expect((await bajar(contador, c.id, m.id, adj.id)).status).toBe(200);
    expect(await auditoriaDescarga(adj.id)).toHaveLength(previas + 2);
  });

  it("no llama a SUNAT ni toca la cola: descargar no encola trabajos", async () => {
    const { c, m, adj } = await conAdjunto();
    expect((await bajar(contador, c.id, m.id, adj.id)).status).toBe(200);
    const n = (
      await b.v.b.sql(
        "select count(*)::int as n from job_registro where cliente_id = $1",
        [c.id],
      )
    )[0].n;
    expect(n).toBe(0);
  });

  it("Dueño, contador, asistente y lectura asignados descargan (buzon.ver)", async () => {
    const { c, m, adj } = await conAdjunto();
    for (const a of [E.titular, contador, asistente, lectura]) {
      const r = await bajar(a, c.id, m.id, adj.id);
      expect(r.status, `${a.rol}: ${r.texto.slice(0, 120)}`).toBe(200);
    }
  });
});

describe("CA-8 · adjunto omitido: no hay archivo que dar", () => {
  it.each(["mime", "tamano", "tope_mensaje"] as const)(
    "omitido por %s: 404 no_encontrado, sin auditoría de descarga",
    async (omitido) => {
      const c = await nuevo();
      const m = await b.sembrarMensaje(E.tenantId, c.id, {
        contenido: "Adjunto omitido.",
        declarados: 1,
      });
      const adj = await b.sembrarAdjunto(E.tenantId, c.id, m.id, {
        nombre: "omitido.bin",
        omitido,
      });
      const r = await bajar(contador, c.id, m.id, adj.id);
      expect(r.status).toBe(404);
      expect(r.json).toEqual({ codigo: "no_encontrado" });
      expect(await auditoriaDescarga(adj.id)).toHaveLength(0);
      // Sigue figurando en el detalle del mensaje con su motivo.
      const d = await b.llamar(
        contador,
        "GET",
        `/clientes/${c.id}/buzon/mensajes/${m.id}`,
      );
      expect(d.status, d.text).toBe(200);
      expect(d.body.adjuntos.find((x: any) => x.id === adj.id)).toMatchObject({
        omitido,
      });
    },
  );
});

describe("CA-9 · aislamiento: el mismo 404 para ajeno, no asignado, cruzado o inexistente", () => {
  it("el contador no asignado y el Dueño de otro estudio no reciben bytes: 404 igual que un adjunto inexistente", async () => {
    const F = await b.estudio();
    const ajeno = await b.cliente(E); // sin responsable ni colaboradores
    const m = await b.sembrarMensaje(E.tenantId, ajeno.id, {
      contenido: "Reservado.",
    });
    const adj = await b.sembrarAdjunto(E.tenantId, ajeno.id, m.id, {
      bytes: Buffer.from("%PDF-CANARIO-bytes-ajenos", "latin1"),
    });
    expect((await bajar(E.titular, ajeno.id, m.id, adj.id)).status).toBe(200); // control: la ruta existe
    const inexistente = await bajar(
      contador,
      ajeno.id,
      randomUUID(),
      randomUUID(),
    );
    for (const a of [contador, F.titular]) {
      const r = await bajar(a, ajeno.id, m.id, adj.id);
      expect(r.status, a.rol).toBe(404);
      expect(r.json).toEqual({ codigo: "no_encontrado" });
      expect(r.texto).not.toContain("CANARIO");
      expect(r.headers["content-disposition"]).toBeUndefined();
    }
    expect((await bajar(contador, ajeno.id, m.id, adj.id)).texto).toBe(
      inexistente.texto,
    );
  });

  it("ids cruzados: el adjunto de otro mensaje del mismo cliente no se da bajo este mensaje", async () => {
    const c = await nuevo();
    const m1 = await b.sembrarMensaje(E.tenantId, c.id, { contenido: "Uno." });
    const m2 = await b.sembrarMensaje(E.tenantId, c.id, { contenido: "Dos." });
    const a2 = await b.sembrarAdjunto(E.tenantId, c.id, m2.id, {
      bytes: Buffer.from("%PDF-del-mensaje-dos", "latin1"),
    });
    expect((await bajar(contador, c.id, m2.id, a2.id)).status).toBe(200); // control
    const r = await bajar(contador, c.id, m1.id, a2.id);
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ codigo: "no_encontrado" });
    expect(r.texto).not.toContain("del-mensaje-dos");
  });

  it("ids cruzados entre clientes del mismo estudio: mensaje del cliente X con adjunto del cliente Y es 404 bajo cualquiera de los dos", async () => {
    const x = await nuevo();
    const y = await nuevo();
    const mx = await b.sembrarMensaje(E.tenantId, x.id, { contenido: "X." });
    const my = await b.sembrarMensaje(E.tenantId, y.id, { contenido: "Y." });
    const ay = await b.sembrarAdjunto(E.tenantId, y.id, my.id, {
      bytes: Buffer.from("%PDF-de-Y-reservado", "latin1"),
    });
    for (const [cliente, mensaje] of [
      [x.id, mx.id],
      [y.id, mx.id],
      [x.id, my.id],
    ] as const) {
      const r = await bajar(contador, cliente, mensaje, ay.id);
      expect(r.status).toBe(404);
      expect(r.json).toEqual({ codigo: "no_encontrado" });
      expect(r.texto).not.toContain("reservado");
    }
    expect((await bajar(contador, y.id, my.id, ay.id)).status).toBe(200); // control
  });

  it("ids cruzados entre estudios: mensaje de E con adjunto de F bajo un cliente propio de F es 404", async () => {
    const F = await b.estudio();
    const cE = await nuevo();
    const cF = await b.cliente(F);
    const mE = await b.sembrarMensaje(E.tenantId, cE.id, { contenido: "E." });
    const mF = await b.sembrarMensaje(F.tenantId, cF.id, { contenido: "F." });
    const aF = await b.sembrarAdjunto(F.tenantId, cF.id, mF.id, {
      bytes: Buffer.from("%PDF-de-F-reservado", "latin1"),
    });
    expect((await bajar(F.titular, cF.id, mF.id, aF.id)).status).toBe(200); // control
    for (const r of [
      await bajar(F.titular, cF.id, mE.id, aF.id),
      await bajar(E.titular, cE.id, mE.id, aF.id),
      await bajar(E.titular, cE.id, mF.id, aF.id),
    ]) {
      expect(r.status).toBe(404);
      expect(r.json).toEqual({ codigo: "no_encontrado" });
      expect(r.texto).not.toContain("reservado");
    }
  });

  it.each([
    ["no-es-uuid"],
    ["..%2F..%2Fetc%2Fpasswd"],
    ["%2e%2e"],
    ["0"],
    ["00000000-0000-0000-0000-000000000000"],
  ])(
    "un adjuntoId «%s» es un 404 igual que un inexistente y no toca el storage",
    async (mal) => {
      const { c, m, adj } = await conAdjunto();
      expect((await bajar(contador, c.id, m.id, adj.id)).status).toBe(200); // control: la ruta existe
      const r = await bajar(contador, c.id, m.id, mal);
      expect(r.status).toBe(404);
      expect(r.json).toEqual({ codigo: "no_encontrado" });
      const otro = await bajar(contador, c.id, m.id, randomUUID());
      expect(r.texto).toBe(otro.texto);
    },
  );

  it("sin sesión: 401 y ningún byte", async () => {
    const { c, m, adj } = await conAdjunto({
      bytes: Buffer.from("%PDF-CANARIO-sin-sesion", "latin1"),
    });
    expect((await bajar(contador, c.id, m.id, adj.id)).status).toBe(200); // control: la ruta existe
    const r = await b.sinSesion("GET", ruta(c.id, m.id, adj.id));
    expect(r.status, r.text).toBe(401);
    expect(r.text).not.toContain("CANARIO");
  });
});

describe("CA-13 · cliente archivado: la descarga sigue", () => {
  it("un adjunto de un cliente archivado se descarga idéntico", async () => {
    const bytes = pdf(4096);
    const { c, m, adj } = await conAdjunto(
      { bytes, nombre: "conservado.pdf" },
      { archivado: true },
    );
    const r = await bajar(contador, c.id, m.id, adj.id);
    expect(r.status, r.texto.slice(0, 200)).toBe(200);
    expect(Buffer.compare(r.bytes, bytes)).toBe(0);
  });
});

describe("CA-10 · la descarga no deja datos del buzón en logs ni en la respuesta de error", () => {
  it("los logs de una descarga y de sus 404 no contienen el nombre del adjunto, la ruta de storage ni el RUC", async () => {
    const { c, m, adj } = await conAdjunto({
      nombre: "CANARIO-nombre-log.pdf",
    });
    const ajena = await b.estudio();
    const { resultado: estados, logs } = await capturarLogs(async () => [
      (await bajar(contador, c.id, m.id, adj.id)).status,
      (await bajar(ajena.titular, c.id, m.id, adj.id)).status,
      (await bajar(contador, c.id, m.id, randomUUID())).status,
    ]);
    expect(estados).toEqual([200, 404, 404]);
    for (const x of ["CANARIO-nombre-log", adj.ruta!, c.ruc])
      expect(logs, `log con ${x}`).not.toContain(x);
  });
});
