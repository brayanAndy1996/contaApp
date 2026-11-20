/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 024 · T4 (rojo): detalle con atención e historial, `GET /clientes/:clienteId/buzon/mensajes/:mensajeId` (D-5, D-7, U-2; CA-4, CA-5).
// Contrato fijado por estas pruebas (T8): el detalle de 023 (`mensaje` con la fila de 023, `contenido`, `adjuntos`) suma
//  - `atencion`: `{ estado: "pendiente" | "atendido" | "historico", por: {id, nombre} | null, en: ISO | null, comentario: string | null }`;
//    `comentario` es el del último evento `atendido` mientras el mensaje siga atendido (null si no lo está);
//  - `historial`: todos los eventos en orden cronológico `{ accion: "atendido" | "deshecho", comentario, usuario: {id, nombre}, en }`;
//  - `mensaje` sigue siendo la fila de 023 (la atención va solo en `atencion`; así lo fija `detalleMensajeSchema` de T1).
// Se lee con `buzon.ver` (también Lectura) y se sigue leyendo en un cliente archivado (U-1). El comentario viaja como texto en un JSON.
// Rojo: el detalle de 023 aún no trae `atencion` ni `historial`, y la atención no existe.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoBandeja,
  cumple,
  FECHAS,
  type Actor,
  type BancoBandeja,
  type Estudio,
} from "../../../test/soporte-bandeja.js";
import { forma } from "../../../test/soporte.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let b: BancoBandeja;
let E: Estudio;
let F: Estudio;
let dueno: Actor;
let contador: Actor;
let asistente: Actor;
let lectura: Actor;
let cliente: { id: string };
let archivado: { id: string };
let sinAsignar: { id: string };
let deF: { id: string };

beforeAll(async () => {
  b = await abrirBancoBandeja();
  E = await b.estudio();
  F = await b.estudio();
  const p = b.v.b.c.p.b;
  dueno = E.titular;
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
  lectura = await p.miembro(E.tenantId, "lectura");
  await b.nombrar(dueno, "Dora Dueña");
  await b.nombrar(contador, "Carla Contador");
  await b.nombrar(asistente, "Aldo Asistente");
  const cs = await b.clientesMasivos(E.tenantId, 3, { prefijo: "Detalle", archivado: (i) => i === 1 });
  cliente = cs[0]!;
  archivado = cs[1]!;
  sinAsignar = cs[2]!;
  for (const u of [contador, asistente, lectura]) await b.asignarMasivo(E.tenantId, u.id, [cliente.id, archivado.id], "colaborador");
  deF = (await b.clientesMasivos(F.tenantId, 1, { prefijo: "Otro" }))[0]!;
});
afterAll(async () => {
  await b?.cerrar();
});

const nuevo = async (o: { categoria?: string; historico?: boolean; en?: { id: string }; tenantId?: string } = {}): Promise<string> =>
  (
    await b.sembrarLote(o.tenantId ?? E.tenantId, [
      {
        clienteId: (o.en ?? cliente).id,
        fecha: FECHAS[6]!,
        categoria: o.categoria ?? "otro",
        asunto: "Detalle de atención",
        ...(o.historico === undefined ? {} : { historico: o.historico }),
      },
    ])
  )[0]!;
const detalle = (a: Actor, m: string, cl: { id: string } = cliente) => b.llamar(a, "GET", `/clientes/${cl.id}/buzon/mensajes/${m}`);
const marcar = (a: Actor, m: string, comentario?: string, cl: { id: string } = cliente) =>
  b.llamar(a, "POST", `/clientes/${cl.id}/buzon/mensajes/${m}/atencion`, comentario === undefined ? { accion: "marcar" } : { accion: "marcar", comentario });
const deshacer = (a: Actor, m: string, comentario?: string) =>
  b.llamar(a, "POST", `/clientes/${cliente.id}/buzon/mensajes/${m}/atencion`, comentario === undefined ? { accion: "deshacer" } : { accion: "deshacer", comentario });

describe("detalle: atención e historial", () => {
  it("un mensaje pendiente: atencion en blanco e historial vacío, y cumple el esquema ampliado", async () => {
    const m = await nuevo();
    const r = await detalle(contador, m);
    expect(r.status, r.text).toBe(200);
    expect(cumple("detalleMensajeSchema", r.body)).toBe(true);
    expect(r.body.atencion).toEqual({ estado: "pendiente", por: null, en: null, comentario: null });
    expect(r.body.historial).toEqual([]);
    expect(r.body.mensaje.id).toBe(m);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
  });

  it("mantiene el detalle de 023: mensaje, contenido y adjuntos", async () => {
    const m = await nuevo();
    const a = await b.sembrarAdjunto(E.tenantId, cliente.id, m, { nombre: "resolucion.pdf" });
    const r = await detalle(contador, m);
    expect(r.status, r.text).toBe(200);
    expect(r.body.contenido).toBeNull();
    expect(r.body.adjuntos.map((x: any) => x.id)).toEqual([a.id]);
    expect(Object.keys(r.body).sort()).toEqual(["adjuntos", "atencion", "contenido", "historial", "mensaje"]);
  });

  it("atendido con comentario: estado, quién, cuándo y el comentario vigente, con un evento en el historial", async () => {
    const m = await nuevo();
    const a = await marcar(asistente, m, "Se presentó el escrito de reclamo");
    expect(a.status, a.text).toBe(200);
    const r = await detalle(lectura, m); // Lectura también lee la atención
    expect(r.status, r.text).toBe(200);
    expect(cumple("detalleMensajeSchema", r.body)).toBe(true);
    expect(r.body.atencion).toEqual({
      estado: "atendido",
      por: { id: asistente.id, nombre: "Aldo Asistente" },
      en: expect.any(String),
      comentario: "Se presentó el escrito de reclamo",
    });
    expect(r.body.historial).toEqual([
      { accion: "atendido", comentario: "Se presentó el escrito de reclamo", usuario: { id: asistente.id, nombre: "Aldo Asistente" }, en: r.body.atencion.en },
    ]);
    expect(JSON.stringify(r.body.mensaje)).not.toContain("escrito de reclamo"); // el comentario solo va en `atencion` e `historial`
  });

  it("el historial lista todos los eventos en orden cronológico, con el nombre de cada usuario; el comentario vigente es el del último atendido", async () => {
    const m = await nuevo({ categoria: "coactiva" });
    expect((await marcar(asistente, m, "Primer intento")).status).toBe(200);
    expect((await deshacer(contador, m, "Faltó el anexo 2")).status).toBe(200);
    expect((await marcar(dueno, m, "Con el anexo 2")).status).toBe(200);
    expect((await deshacer(dueno, m)).status).toBe(200);
    expect((await marcar(contador, m, "Cerrado")).status).toBe(200);
    const r = await detalle(dueno, m);
    expect(r.status, r.text).toBe(200);
    expect(r.body.historial.map((e: any) => [e.accion, e.comentario, e.usuario.nombre])).toEqual([
      ["atendido", "Primer intento", "Aldo Asistente"],
      ["deshecho", "Faltó el anexo 2", "Carla Contador"],
      ["atendido", "Con el anexo 2", "Dora Dueña"],
      ["deshecho", null, "Dora Dueña"],
      ["atendido", "Cerrado", "Carla Contador"],
    ]);
    const instantes = r.body.historial.map((e: any) => new Date(e.en).getTime());
    expect([...instantes].sort((x, y) => x - y)).toEqual(instantes);
    expect(new Set(instantes).size).toBe(instantes.length);
    expect(r.body.atencion).toMatchObject({ estado: "atendido", por: { nombre: "Carla Contador" }, comentario: "Cerrado" });
    expect(r.body.atencion.en).toBe(r.body.historial[4].en);
    expect(cumple("detalleMensajeSchema", r.body)).toBe(true);
  });

  it("tras deshacer, el comentario vigente es null pero el historial conserva todo", async () => {
    const m = await nuevo();
    await marcar(contador, m, "Hecho");
    await deshacer(asistente, m, "Se devuelve");
    const r = await detalle(contador, m);
    expect(r.body.atencion).toEqual({ estado: "pendiente", por: null, en: null, comentario: null });
    expect(r.body.historial.map((e: any) => e.accion)).toEqual(["atendido", "deshecho"]);
    expect(r.body.historial[1].comentario).toBe("Se devuelve");
  });

  it("U-2: un histórico se ve «historico»; atendido pasa a «atendido»; al deshacer vuelve a «historico»", async () => {
    const m = await nuevo({ historico: true });
    expect((await detalle(contador, m)).body.atencion).toEqual({ estado: "historico", por: null, en: null, comentario: null });
    expect((await marcar(contador, m, "Histórico revisado")).status).toBe(200);
    expect((await detalle(contador, m)).body.atencion).toMatchObject({ estado: "atendido", comentario: "Histórico revisado" });
    expect((await deshacer(contador, m)).status).toBe(200);
    const r = await detalle(contador, m);
    expect(r.body.atencion).toEqual({ estado: "historico", por: null, en: null, comentario: null });
    expect(r.body.historial.map((e: any) => e.accion)).toEqual(["atendido", "deshecho"]);
  });

  it("el comentario hostil se devuelve como texto dentro de un JSON, sin transformar", async () => {
    const m = await nuevo();
    const hostil = `<img src=x onerror=alert(1)><script>alert(2)</script> &lt;b&gt;\nlínea 2`;
    expect((await marcar(contador, m, hostil)).status).toBe(200);
    const r = await detalle(lectura, m);
    expect(r.status, r.text).toBe(200);
    expect(String(r.headers["content-type"])).toMatch(/application\/json/);
    expect(String(r.headers["content-type"])).not.toMatch(/html/);
    expect(r.body.atencion.comentario).toBe(hostil);
    expect(r.body.historial[0].comentario).toBe(hostil);
  });

  it("un cliente archivado sigue mostrando atención e historial (solo lectura, U-1)", async () => {
    const m = await nuevo({ en: archivado });
    await b.fijarEstado([m], { atendidoPor: contador.id });
    await b.sql(
      "insert into buzon_atencion (tenant_id, cliente_id, mensaje_id, accion, comentario, usuario_id) values ($1, $2, $3, 'atendido', 'Antes de archivar', $4)",
      [E.tenantId, archivado.id, m, contador.id],
    );
    const r = await detalle(contador, m, archivado);
    expect(r.status, r.text).toBe(200);
    expect(r.body.atencion.estado).toBe("atendido");
    expect(r.body.historial).toHaveLength(1);
    expect(r.body.historial[0]).toMatchObject({ accion: "atendido", comentario: "Antes de archivar", usuario: { id: contador.id } });
  });
});

describe("detalle: aislamiento del historial", () => {
  it("mensaje de otro estudio, de un cliente no visible o cruzado: el mismo 404 de un inexistente y sin historial", async () => {
    const delOtro = await nuevo({ tenantId: F.tenantId, en: deF });
    const delNoVisible = await nuevo({ en: sinAsignar });
    const propio = await nuevo();
    await marcar(dueno, delNoVisible, "CANARIO-historial-ajeno", sinAsignar);
    const inexistente = await detalle(contador, randomUUID(), { id: randomUUID() });
    expect(inexistente.status).toBe(404);
    for (const r of [
      await detalle(contador, delOtro, deF),
      await detalle(contador, delOtro),
      await detalle(contador, delNoVisible, sinAsignar),
      await detalle(contador, delNoVisible),
      await detalle(F.titular, propio),
      await detalle(contador, propio, archivado),
    ]) {
      expect(r.status, r.text).toBe(404);
      expect(forma(r)).toEqual(forma(inexistente));
      expect(r.text).not.toContain("CANARIO");
    }
    expect((await detalle(dueno, delNoVisible, sinAsignar)).body.historial[0].comentario).toBe("CANARIO-historial-ajeno"); // control
  });

  it("sin sesión: 401", async () => {
    const m = await nuevo();
    expect((await b.sinSesion("GET", `/clientes/${cliente.id}/buzon/mensajes/${m}`)).status).toBe(401);
  });
});
