/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 023 · T6 (rojo): lectura mínima del buzón, GET /clientes/:clienteId/buzon/mensajes y …/mensajes/:mensajeId
// (D-8, P-1, P-9; CA-8, CA-9, CA-10, CA-13). Contrato fijado por estas pruebas (módulo `buzon` de T13):
//  - Permiso `buzon.ver` (todos los roles lo tienen; el alcance por cliente lo da `ClienteScopeGuard`); `Cache-Control: no-store`.
//  - Lista: 200 `paginaMensajesBuzonSchema` = `{ estado: { ultimaCaptura, sincronizado, revisarDesde }, mensajes, siguiente }`, orden
//    `fecha` desc y luego `id` desc; `limite` 1..100 (por omisión devuelve toda una página ≤ 100) y `cursor` opaco en base64url: lo
//    inválido es 400 `solicitud_invalida`. `siguiente` es null en la última página; recorrerla con el cursor no deja huecos ni
//    repetidos. `estado.ultimaCaptura` = `ultima_captura_en`; `sincronizado` = `sincronizado_en` no nulo; `revisarDesde` = fin del
//    enfriamiento de 10 min (último de solicitud y captura + 10 min) o null si ya pasó o nunca hubo. Un cliente sin fila de estado
//    devuelve `{ ultimaCaptura: null, sincronizado: false, revisarDesde: null }` y `mensajes: []`.
//  - Cada fila (`mensajeBuzonFilaSchema`) lleva `leidoEnSunat`, `contenidoObtenido` (hay `contenido_ruta`) y `adjuntosDeclarados`; nunca
//    `idSunat`, `tenantId`, `clienteId`, la ruta de storage ni el RUC.
//  - Detalle: 200 `detalleMensajeSchema` = `{ mensaje, contenido, adjuntos }`. `contenido` es el texto plano guardado (o null si aún no
//    se abrió); los adjuntos (`adjuntoVistaSchema`) llevan id, nombre, mime, tamaño y `omitido`, nunca ruta ni sha256. Se audita
//    `buzon.contenido_visto` (actor usuario, entidad `buzon_mensaje`, datos `{ mensajeId }`) solo cuando hay contenido.
//  - Cliente o mensaje de otro estudio, no asignado, de otro cliente o inexistente: el mismo 404 `no_encontrado`.
//  - Archivado (CA-13): la lectura sigue; «Revisar ahora» da 409.
// Rojo: el módulo `buzon` aún no existe (T13): toda ruta responde 404 de ruta inexistente.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoBuzon,
  cumple,
  MIN,
  type Actor,
  type BancoBuzon,
  type Estudio,
} from "../../../test/soporte-buzon.js";
import { capturarLogs, forma } from "../../../test/soporte.js";

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

const nuevo = (o: Parameters<BancoBuzon["cliente"]>[1] = {}, e: Estudio = E) =>
  b.cliente(e, {
    responsable: contador.id,
    colaboradores: [asistente.id, lectura.id],
    ...o,
  });
const lista = (a: Actor, c: { id: string }, query = "") =>
  b.llamar(a, "GET", `/clientes/${c.id}/buzon/mensajes${query}`);
const detalle = (a: Actor, c: { id: string }, mensajeId: string) =>
  b.llamar(a, "GET", `/clientes/${c.id}/buzon/mensajes/${mensajeId}`);
const ids = (r: { status: number; text: string; body: any }): string[] => {
  expect(r.status, r.text).toBe(200);
  return (r.body.mensajes as any[]).map((m) => m.id);
};
const dia = (n: number): string =>
  new Date(Date.UTC(2026, 10, n, 15, 0, 0)).toISOString();

describe("lista: forma, orden y estado de captura", () => {
  it("sin mensajes ni estado: 200 con la página vacía y el estado en blanco", async () => {
    const c = await nuevo();
    const r = await lista(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(cumple("paginaMensajesBuzonSchema", r.body)).toBe(true);
    expect(r.body).toEqual({
      estado: { ultimaCaptura: null, sincronizado: false, revisarDesde: null },
      mensajes: [],
      siguiente: null,
    });
    expect(r.headers["cache-control"]).toMatch(/no-store/);
  });

  it("devuelve la fila pública de cada mensaje y nada interno", async () => {
    const c = await nuevo();
    const m = await b.sembrarMensaje(E.tenantId, c.id, {
      idSunat: "CANARIO-idsunat-0001",
      asunto: "Resolución de Intendencia N° 0150140012345",
      remitente: "SUNAT - Notificaciones",
      fecha: dia(12),
      critico: true,
      categoria: "resolucion_determinacion",
      motivo: "asunto",
      leido: true,
      declarados: 2,
    });
    const r = await lista(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(cumple("paginaMensajesBuzonSchema", r.body)).toBe(true);
    // Spec 024 (P-9, D-10): la fila de la lista lleva además `cliente` (id, razón social, archivado) y `atencion` (sin comentario).
    expect(r.body.mensajes).toEqual([
      {
        id: m.id,
        asunto: "Resolución de Intendencia N° 0150140012345",
        remitente: "SUNAT - Notificaciones",
        fecha: dia(12),
        categoria: "resolucion_determinacion",
        critico: true,
        motivoCritico: "asunto",
        leidoEnSunat: true,
        contenidoObtenido: false,
        adjuntosDeclarados: 2,
        cliente: { id: c.id, razonSocial: expect.any(String), archivado: false },
        atencion: { estado: "pendiente", por: null, en: null },
      },
    ]);
    for (const interno of [
      E.tenantId,
      c.ruc,
      "CANARIO-idsunat-0001",
      "buzon/",
      "id_sunat",
      "idSunat",
    ]) {
      expect(r.text).not.toContain(interno);
    }
  });

  it("contenidoObtenido es verdadero solo con el contenido ya guardado", async () => {
    const c = await nuevo();
    const sin = await b.sembrarMensaje(E.tenantId, c.id, { fecha: dia(10) });
    const con = await b.sembrarMensaje(E.tenantId, c.id, {
      fecha: dia(11),
      contenido: "Texto del mensaje.",
    });
    const r = await lista(contador, c);
    expect(r.status, r.text).toBe(200);
    const por = new Map(
      (r.body.mensajes as any[]).map((m) => [m.id, m.contenidoObtenido]),
    );
    expect(por.get(sin.id)).toBe(false);
    expect(por.get(con.id)).toBe(true);
  });

  it("orden fecha descendente y, con la misma fecha, id descendente", async () => {
    const c = await nuevo();
    const mismo = dia(8);
    const ordenados = [
      await b.sembrarMensaje(E.tenantId, c.id, {
        id: "00000000-0000-4000-8000-0000000000a1",
        fecha: dia(5),
      }),
      await b.sembrarMensaje(E.tenantId, c.id, {
        id: "00000000-0000-4000-8000-0000000000b2",
        fecha: mismo,
      }),
      await b.sembrarMensaje(E.tenantId, c.id, {
        id: "00000000-0000-4000-8000-0000000000c3",
        fecha: mismo,
      }),
      await b.sembrarMensaje(E.tenantId, c.id, {
        id: "00000000-0000-4000-8000-0000000000d4",
        fecha: dia(14),
      }),
    ].map((m) => m.id);
    const r = await lista(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(ids(r)).toEqual([
      ordenados[3],
      ordenados[2],
      ordenados[1],
      ordenados[0],
    ]);
  });

  it("el estado refleja la última captura, el cliente sincronizado y el fin del enfriamiento", async () => {
    const c = await nuevo();
    await b.sembrarEstado(E.tenantId, c.id, {
      capturaHace: 3,
      sincronizadoHace: 120,
    });
    const r = await lista(contador, c);
    expect(r.status, r.text).toBe(200);
    const { ultimaCaptura, sincronizado, revisarDesde } = r.body.estado;
    expect(sincronizado).toBe(true);
    expect(
      Math.abs(Date.now() - 3 * MIN - new Date(ultimaCaptura).getTime()),
    ).toBeLessThan(30_000);
    expect(
      Math.abs(Date.now() + 7 * MIN - new Date(revisarDesde).getTime()),
    ).toBeLessThan(30_000);
  });

  it("pasados los 10 min del enfriamiento revisarDesde vuelve a null; sin sincronizar, sincronizado es falso", async () => {
    const c = await nuevo();
    await b.sembrarEstado(E.tenantId, c.id, {
      capturaHace: 30,
      solicitudHace: 20,
    });
    const r = await lista(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(r.body.estado.revisarDesde).toBeNull();
    expect(r.body.estado.sincronizado).toBe(false);
    expect(r.body.estado.ultimaCaptura).not.toBeNull();
  });

  it("una solicitud bajo demanda reciente también fija revisarDesde", async () => {
    const c = await nuevo();
    await b.sembrarEstado(E.tenantId, c.id, { solicitudHace: 1 });
    const r = await lista(contador, c);
    expect(r.status, r.text).toBe(200);
    expect(new Date(r.body.estado.revisarDesde).getTime()).toBeGreaterThan(
      Date.now() + 5 * MIN,
    );
  });

  it("solo ve los mensajes de su cliente (otro cliente del mismo estudio no se mezcla)", async () => {
    const c1 = await nuevo();
    const c2 = await nuevo();
    const m1 = await b.sembrarMensaje(E.tenantId, c1.id);
    const m2 = await b.sembrarMensaje(E.tenantId, c2.id);
    expect(ids(await lista(contador, c1))).toEqual([m1.id]);
    expect(ids(await lista(contador, c2))).toEqual([m2.id]);
  });

  it("Dueño, contador, asistente y lectura asignados leen (buzon.ver)", async () => {
    const c = await nuevo();
    await b.sembrarMensaje(E.tenantId, c.id);
    for (const a of [E.titular, contador, asistente, lectura]) {
      const r = await lista(a, c);
      expect(r.status, `${a.rol}: ${r.text}`).toBe(200);
      expect(r.body.mensajes).toHaveLength(1);
    }
  });
});

describe("lista: cursor y límite", () => {
  it("recorrer con limite=2 y el cursor trae todos los mensajes sin huecos ni repetidos, en el mismo orden que una sola página", async () => {
    const c = await nuevo();
    for (let i = 1; i <= 7; i++)
      await b.sembrarMensaje(E.tenantId, c.id, { fecha: dia(i) });
    const entera = ids(await lista(contador, c));
    expect(entera).toHaveLength(7);
    const recorrido: string[] = [];
    let cursor: string | null = null;
    let paginas = 0;
    do {
      const r: any = await lista(
        contador,
        c,
        `?limite=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      expect(r.status, r.text).toBe(200);
      expect(cumple("paginaMensajesBuzonSchema", r.body)).toBe(true);
      expect(r.body.mensajes.length).toBeLessThanOrEqual(2);
      recorrido.push(...ids(r));
      cursor = r.body.siguiente;
      paginas++;
    } while (cursor !== null && paginas < 10);
    expect(paginas).toBe(4);
    expect(recorrido).toEqual(entera);
  });

  it("con fechas repetidas el cursor no salta ni repite (desempate por id)", async () => {
    const c = await nuevo();
    const f = dia(9);
    for (let i = 0; i < 5; i++)
      await b.sembrarMensaje(E.tenantId, c.id, { fecha: f });
    const entera = ids(await lista(contador, c));
    const recorrido: string[] = [];
    let cursor: string | null = null;
    do {
      const r: any = await lista(
        contador,
        c,
        `?limite=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      recorrido.push(...ids(r));
      cursor = r.body.siguiente;
    } while (cursor !== null && recorrido.length < 20);
    expect(recorrido).toEqual(entera);
    expect(new Set(recorrido).size).toBe(5);
  });

  it("la última página trae siguiente null; limite=100 con 3 mensajes los trae todos", async () => {
    const c = await nuevo();
    for (let i = 1; i <= 3; i++)
      await b.sembrarMensaje(E.tenantId, c.id, { fecha: dia(i) });
    const r = await lista(contador, c, "?limite=100");
    expect(ids(r)).toHaveLength(3);
    expect(r.body.siguiente).toBeNull();
  });

  it("101 mensajes: sin limite no se pasa de 100 y la página trae siguiente; con limite=100, igual", async () => {
    const c = await nuevo();
    for (let i = 0; i < 101; i++)
      await b.sembrarMensaje(E.tenantId, c.id, {
        fecha: new Date(Date.UTC(2026, 9, 1) + i * 3_600_000).toISOString(),
      });
    const sin = await lista(contador, c);
    expect(sin.status, sin.text).toBe(200);
    expect(ids(sin).length).toBeLessThanOrEqual(100);
    expect(sin.body.siguiente).not.toBeNull();
    const con = await lista(contador, c, "?limite=100");
    expect(ids(con)).toHaveLength(100);
    const resto = await lista(
      contador,
      c,
      `?limite=100&cursor=${encodeURIComponent(con.body.siguiente)}`,
    );
    expect(ids(resto)).toHaveLength(1);
    expect(resto.body.siguiente).toBeNull();
  });

  it.each([
    "limite=0",
    "limite=101",
    "limite=-1",
    "limite=abc",
    "limite=1.5",
    "limite=",
    "limite=1e2",
  ])("%s es 400 solicitud_invalida", async (query) => {
    const c = await nuevo();
    const r = await lista(contador, c, `?${query}`);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
  });

  // Spec 024 (D-4): un cursor que no es una posición válida es 400 `cursor_invalido` (antes `solicitud_invalida`); el vacío y el de
  // más de 256 caracteres los rechaza la validación de parámetros.
  it.each([
    "cursor=%%%",
    "cursor=no-es-un-cursor",
    "cursor=e30",
  ])("un cursor inválido (%s) es 400 cursor_invalido", async (query) => {
    const c = await nuevo();
    const r = await lista(contador, c, `?${query}`);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "cursor_invalido" });
  });

  it.each(["cursor=", `cursor=${"a".repeat(600)}`])(
    "un cursor vacío o de más de 256 caracteres (%s) es 400",
    async (query) => {
      const c = await nuevo();
      const r = await lista(contador, c, `?${query}`);
      expect(r.status, r.text).toBe(400);
      expect(["solicitud_invalida", "cursor_invalido"]).toContain(r.body.codigo);
    },
  );

  it("un cursor de otro cliente no filtra sus mensajes: o es 400 o solo trae los del cliente pedido", async () => {
    const a = await nuevo();
    const otro = await nuevo();
    for (let i = 1; i <= 3; i++)
      await b.sembrarMensaje(E.tenantId, a.id, { fecha: dia(i) });
    const propios = [
      await b.sembrarMensaje(E.tenantId, otro.id, { fecha: dia(1) }),
    ].map((m) => m.id);
    const pagina = await lista(contador, a, "?limite=1");
    expect(pagina.status, pagina.text).toBe(200);
    expect(pagina.body.siguiente).not.toBeNull();
    const r = await lista(
      contador,
      otro,
      `?limite=1&cursor=${encodeURIComponent(pagina.body.siguiente)}`,
    );
    if (r.status === 200)
      for (const id of ids(r)) expect(propios).toContain(id);
    else expect(r.status).toBe(400);
  });

  it("las claves de la query que no son del contrato (clienteId, tenantId) no cambian el alcance", async () => {
    const a = await nuevo();
    const otro = await nuevo();
    await b.sembrarMensaje(E.tenantId, otro.id);
    const r = await lista(
      contador,
      a,
      `?clienteId=${otro.id}&tenantId=${randomUUID()}`,
    );
    expect(r.status, r.text).toBe(200);
    expect(r.body.mensajes).toEqual([]);
  });
});

describe("detalle: contenido en texto plano y adjuntos", () => {
  it("sin contenido: contenido null, contenidoObtenido falso y NO se audita contenido_visto", async () => {
    const c = await nuevo();
    const m = await b.sembrarMensaje(E.tenantId, c.id, { fecha: dia(3) });
    const antes = (await b.auditoria(E.tenantId, "buzon.contenido_visto"))
      .length;
    const r = await detalle(contador, c, m.id);
    expect(r.status, r.text).toBe(200);
    expect(cumple("detalleMensajeSchema", r.body)).toBe(true);
    expect(r.body.contenido).toBeNull();
    expect(r.body.mensaje).toMatchObject({
      id: m.id,
      contenidoObtenido: false,
    });
    expect(r.body.adjuntos).toEqual([]);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(
      (await b.auditoria(E.tenantId, "buzon.contenido_visto")).length,
    ).toBe(antes);
  });

  it("con contenido: devuelve el texto tal cual y audita contenido_visto por cada lectura (usuario, mensaje)", async () => {
    const c = await nuevo();
    const texto =
      "Se le notifica la Resolución N° 123-2026.\nPlazo: 7 días hábiles.\nÁ é ñ — «comillas».";
    const m = await b.sembrarMensaje(E.tenantId, c.id, {
      fecha: dia(3),
      contenido: texto,
    });
    const previas = (
      await b.auditoria(E.tenantId, "buzon.contenido_visto")
    ).filter((f) => f.entidad_id === m.id).length;
    const r = await detalle(asistente, c, m.id);
    expect(r.status, r.text).toBe(200);
    expect(cumple("detalleMensajeSchema", r.body)).toBe(true);
    expect(r.body.contenido).toBe(texto);
    expect(r.body.mensaje).toMatchObject({ id: m.id, contenidoObtenido: true });
    expect(String(r.headers["content-type"])).toMatch(/application\/json/);
    const filas = (
      await b.auditoria(E.tenantId, "buzon.contenido_visto")
    ).filter((f) => f.entidad_id === m.id);
    expect(filas).toHaveLength(previas + 1);
    expect(filas.at(-1)).toMatchObject({
      actor_tipo: "usuario",
      usuario_id: asistente.id,
      entidad: "buzon_mensaje",
      cliente_id: c.id,
    });
    expect(filas.at(-1)!.datos).toEqual({ mensajeId: m.id });
    await detalle(contador, c, m.id);
    expect(
      (await b.auditoria(E.tenantId, "buzon.contenido_visto")).filter(
        (f) => f.entidad_id === m.id,
      ),
    ).toHaveLength(previas + 2);
  });

  it("el contenido se devuelve como texto: <script> y atributos on* llegan literales dentro del JSON, sin ejecutarse ni transformarse", async () => {
    const c = await nuevo();
    const hostil = `Hola <script>alert(1)</script><img src=x onerror=alert(2)> &lt;b&gt;`;
    const m = await b.sembrarMensaje(E.tenantId, c.id, { contenido: hostil });
    const r = await detalle(contador, c, m.id);
    expect(r.status, r.text).toBe(200);
    expect(r.body.contenido).toBe(hostil);
    expect(String(r.headers["content-type"])).toMatch(/application\/json/);
    expect(String(r.headers["content-type"])).not.toMatch(/html/);
  });

  it("los adjuntos salen como vista pública: id, nombre, mime, tamaño y motivo de omisión; nunca ruta ni sha256", async () => {
    const c = await nuevo();
    const m = await b.sembrarMensaje(E.tenantId, c.id, {
      contenido: "Ver adjuntos.",
      declarados: 2,
    });
    const bytes = Buffer.from("%PDF-1.7 contenido de prueba %%EOF", "latin1");
    const ok = await b.sembrarAdjunto(E.tenantId, c.id, m.id, {
      nombre: "resolucion.pdf",
      bytes,
    });
    const omitido = await b.sembrarAdjunto(E.tenantId, c.id, m.id, {
      nombre: "grande.zip",
      omitido: "tamano",
    });
    const r = await detalle(contador, c, m.id);
    expect(r.status, r.text).toBe(200);
    expect(cumple("detalleMensajeSchema", r.body)).toBe(true);
    const por = new Map((r.body.adjuntos as any[]).map((a) => [a.id, a]));
    expect(por.size).toBe(2);
    expect(Object.keys(por.get(ok.id)).sort()).toEqual([
      "id",
      "mime",
      "nombre",
      "omitido",
      "tamano",
    ]);
    expect(por.get(ok.id)).toEqual({
      id: ok.id,
      nombre: "resolucion.pdf",
      mime: "application/pdf",
      tamano: bytes.length,
      omitido: null,
    });
    expect(por.get(omitido.id)).toMatchObject({
      id: omitido.id,
      nombre: "grande.zip",
      omitido: "tamano",
    });
    for (const interno of [E.tenantId, c.id, "buzon/", ok.sha256!])
      expect(r.text).not.toContain(interno);
  });

  it("el mensaje de otro cliente del mismo estudio es un 404 bajo este cliente (no se cruza de cliente)", async () => {
    const a = await nuevo();
    const otro = await nuevo();
    const m = await b.sembrarMensaje(E.tenantId, otro.id, {
      contenido: "Reservado.",
    });
    expect((await detalle(contador, otro, m.id)).status).toBe(200); // control: bajo su cliente sí
    const r = await detalle(contador, a, m.id);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(forma(r)).toEqual(forma(await detalle(contador, a, randomUUID())));
    expect(r.text).not.toContain("Reservado");
  });

  it("un mensajeId mal formado es un 404 igual que uno inexistente", async () => {
    const c = await nuevo();
    expect((await lista(contador, c)).status).toBe(200); // control: la ruta existe
    for (const mal of ["no-es-uuid", "..%2F..%2Fetc%2Fpasswd", "0"]) {
      const r = await detalle(contador, c, mal);
      expect(r.status, mal).toBe(404);
      expect(r.body).toEqual({ codigo: "no_encontrado" });
    }
  });
});

describe("CA-9 · aislamiento: el mismo 404 para ajeno, no asignado e inexistente", () => {
  it("el contador no asignado, en lista y detalle, recibe lo mismo que ante un cliente inexistente y no ve el contenido", async () => {
    const ajeno = await b.cliente(E); // sin responsable ni colaboradores
    const m = await b.sembrarMensaje(E.tenantId, ajeno.id, {
      asunto: "CANARIO-asunto-ajeno",
      contenido: "CANARIO-contenido-ajeno",
    });
    expect((await lista(E.titular, ajeno)).status).toBe(200); // control: la ruta existe
    const l = await lista(contador, ajeno);
    expect(l.status).toBe(404);
    expect(l.body).toEqual({ codigo: "no_encontrado" });
    expect(forma(l)).toEqual(
      forma(await lista(contador, { id: randomUUID() })),
    );
    const d = await detalle(contador, ajeno, m.id);
    expect(d.status).toBe(404);
    expect(forma(d)).toEqual(
      forma(await detalle(contador, { id: randomUUID() }, randomUUID())),
    );
    expect(l.text + d.text).not.toContain("CANARIO");
  });

  it("otro estudio: el Dueño de F no lee ni la lista ni el detalle de un cliente de E", async () => {
    const F = await b.estudio();
    const c = await nuevo();
    const m = await b.sembrarMensaje(E.tenantId, c.id, {
      asunto: "CANARIO-asunto-E",
      contenido: "CANARIO-contenido-E",
    });
    expect((await lista(E.titular, c)).status).toBe(200); // control: la ruta existe
    expect((await detalle(E.titular, c, m.id)).status).toBe(200);
    const vistos = async () =>
      (await b.auditoria(E.tenantId, "buzon.contenido_visto")).filter(
        (f) => f.entidad_id === m.id,
      ).length;
    const antes = await vistos(); // los controles del Dueño de E ya auditaron su lectura
    const l = await lista(F.titular, c);
    const d = await detalle(F.titular, c, m.id);
    for (const r of [l, d]) {
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ codigo: "no_encontrado" });
      expect(r.text).not.toContain("CANARIO");
    }
    expect(forma(l)).toEqual(
      forma(await lista(F.titular, { id: randomUUID() })),
    );
    expect(forma(d)).toEqual(
      forma(await detalle(F.titular, { id: randomUUID() }, randomUUID())),
    );
    expect(await vistos()).toBe(antes); // la lectura ajena no audita nada (+0)
  });

  it("ids cruzados entre estudios: el mensaje de E bajo un cliente propio de F es un 404", async () => {
    const F = await b.estudio();
    const cE = await nuevo();
    const cF = await b.cliente(F);
    const m = await b.sembrarMensaje(E.tenantId, cE.id, {
      contenido: "CANARIO-cruzado",
    });
    expect((await detalle(E.titular, cE, m.id)).status).toBe(200); // control: bajo su cliente sí
    const r = await detalle(F.titular, cF, m.id);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(r.text).not.toContain("CANARIO");
  });

  it("sin sesión: 401 en la lista y el detalle", async () => {
    const c = await nuevo();
    const m = await b.sembrarMensaje(E.tenantId, c.id);
    expect((await lista(contador, c)).status).toBe(200); // control: la ruta existe
    expect(
      (await b.sinSesion("GET", `/clientes/${c.id}/buzon/mensajes`)).status,
    ).toBe(401);
    expect(
      (await b.sinSesion("GET", `/clientes/${c.id}/buzon/mensajes/${m.id}`))
        .status,
    ).toBe(401);
  });
});

describe("CA-13 · cliente archivado: la lectura sigue y «Revisar ahora» no", () => {
  it("lista y detalle (con contenido y adjuntos) siguen respondiendo 200; revisar es 409 y no encola", async () => {
    const c = await nuevo({ archivado: true });
    const m = await b.sembrarMensaje(E.tenantId, c.id, {
      contenido: "Texto conservado.",
      critico: true,
      declarados: 1,
    });
    await b.sembrarAdjunto(E.tenantId, c.id, m.id, {
      nombre: "conservado.pdf",
    });
    const l = await lista(contador, c);
    expect(l.status, l.text).toBe(200);
    expect(ids(l)).toEqual([m.id]);
    const d = await detalle(contador, c, m.id);
    expect(d.status, d.text).toBe(200);
    expect(d.body.contenido).toBe("Texto conservado.");
    expect(d.body.adjuntos).toHaveLength(1);
    const r = await b.llamar(
      contador,
      "POST",
      `/clientes/${c.id}/buzon/revisar`,
    );
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
    expect(await b.trabajos(c.id, "sol.buzon.revisar")).toHaveLength(0);
  });
});

describe("CA-10 · lo del buzón no sale por logs, auditoría ni trabajos", () => {
  it("con canarios en asunto, contenido, nombre de adjunto y razón social, ningún log ni fila de auditoría ni trabajo los contiene", async () => {
    const c = await nuevo({ razonSocial: "CANARIO-razon-lectura" });
    const asunto = "CANARIO-asunto-lectura";
    const contenido = "CANARIO-contenido-lectura";
    const nombre = "CANARIO-nombre-lectura.pdf";
    const m = await b.sembrarMensaje(E.tenantId, c.id, {
      asunto,
      contenido,
      declarados: 1,
      critico: true,
    });
    const a = await b.sembrarAdjunto(E.tenantId, c.id, m.id, { nombre });
    // «abrir» solo encola (202) si el contenido aún no se obtuvo; con contenido responde 200 { trabajo: null } (abrir.int.spec).
    const sinContenido = await b.sembrarMensaje(E.tenantId, c.id, { asunto });
    const { resultado: estados, logs } = await capturarLogs(async () => {
      const respuestas = [
        await lista(contador, c),
        await detalle(contador, c, m.id),
        await b.bin(
          contador,
          "GET",
          `/clientes/${c.id}/buzon/mensajes/${m.id}/adjuntos/${a.id}`,
        ),
        await b.llamar(
          asistente,
          "POST",
          `/clientes/${c.id}/buzon/mensajes/${sinContenido.id}/abrir`,
        ),
        await b.llamar(contador, "POST", `/clientes/${c.id}/buzon/revisar`),
      ];
      return respuestas.map((r) => r.status);
    });
    expect(estados).toEqual([200, 200, 200, 202, 202]);
    const buscados = [
      asunto,
      contenido,
      nombre,
      "CANARIO-razon-lectura",
      c.ruc,
    ];
    for (const x of buscados) expect(logs, `log con ${x}`).not.toContain(x);
    const auditoria = JSON.stringify(await b.auditoriaTodas(E.tenantId));
    for (const x of buscados)
      expect(auditoria, `auditoría con ${x}`).not.toContain(x);
    const trabajos = await b.v.b.sql(
      "select tipo, parametros, resultado, motivo from job_registro where cliente_id = $1",
      [c.id],
    );
    for (const x of buscados.slice(0, 3))
      expect(JSON.stringify(trabajos), `trabajo con ${x}`).not.toContain(x);
  });
});
