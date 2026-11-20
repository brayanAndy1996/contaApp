/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 023 · T17 (rojo) · correcciones de la ronda 1, backend. Fija el comportamiento esperado de H-023-1-1 (media):
// «Revisar ahora» y «Abrir» deben dar el mismo resultado con el UUID en mayúsculas o en minúsculas. Una sola captura viva por
// cliente (CA-2, D-6) y un solo trabajo y una sola auditoría `buzon.apertura_solicitada` por mensaje (CA-4). La clave de dedupe se
// calcula con el id normalizado a minúsculas (la misma que usa el programador en SQL). Falla hoy porque `claveDedupe(...)` usa el
// `clienteId` tal como llega en la ruta.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoBuzon,
  type Actor,
  type BancoBuzon,
  type Estudio,
} from "../../../test/soporte-buzon.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const REVISAR = "sol.buzon.revisar";
const ABRIR = "sol.buzon.abrir";

let b: BancoBuzon;
let E: Estudio;
let contador: Actor;
let asistente: Actor;

beforeAll(async () => {
  b = await abrirBancoBuzon();
  E = await b.estudio();
  const p = b.v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
});
afterAll(async () => {
  await b?.cerrar();
});

const nuevo = () =>
  b.cliente(E, { responsable: contador.id, colaboradores: [asistente.id] });
const vivos = async (clienteId: string, tipo: string) =>
  (await b.trabajos(clienteId, tipo)).filter((t: any) =>
    ["en_cola", "ejecutando"].includes(t.estado),
  );
/** Clave de dedupe del catálogo: SHA-256 del JSON de [tipo, cliente, parámetros] con el cliente en minúsculas. */
const clave = (tipo: string, clienteId: string, parametros: object): Buffer =>
  createHash("sha256")
    .update(JSON.stringify([tipo, clienteId.toLowerCase(), parametros]), "utf8")
    .digest();
const rutaRevisar = (clienteId: string) =>
  `/clientes/${clienteId}/buzon/revisar`;
const rutaAbrir = (clienteId: string, mensajeId: string) =>
  `/clientes/${clienteId}/buzon/mensajes/${mensajeId}/abrir`;

describe("H-023-1-1 · «Revisar ahora» con el UUID del cliente en cualquier grafía (CA-2, D-6)", () => {
  it.each([
    [
      "mayúsculas y luego minúsculas",
      (id: string) => id.toUpperCase(),
      (id: string) => id,
    ],
    [
      "minúsculas y luego mayúsculas",
      (id: string) => id,
      (id: string) => id.toUpperCase(),
    ],
  ])(
    "%s: 202 y luego 200 con el mismo trabajo; una sola captura viva con la clave del id en minúsculas y una sola auditoría",
    async (_nombre, primera, segunda) => {
      const c = await nuevo();
      const r1 = await b.llamar(contador, "POST", rutaRevisar(primera(c.id)));
      expect(r1.status, JSON.stringify(r1.body)).toBe(202);
      const r2 = await b.llamar(contador, "POST", rutaRevisar(segunda(c.id)));
      expect(r2.status, JSON.stringify(r2.body)).toBe(200);
      expect(r2.body.trabajo.id).toBe(r1.body.trabajo.id);
      const v = await vivos(c.id, REVISAR);
      expect(v).toHaveLength(1);
      expect(
        Buffer.from(v[0].clave_dedupe).equals(clave(REVISAR, c.id, {})),
      ).toBe(true);
      const aud = (
        await b.auditoria(E.tenantId, "buzon.captura_solicitada")
      ).filter((f: any) => f.cliente_id === c.id);
      expect(aud).toHaveLength(1);
    },
  );

  it("con el id en mayúsculas y una captura programada en cola: devuelve la viva elevada a interactivo (200), no crea otra", async () => {
    const c = await nuevo();
    const programada = await b.sembrarRevisarVivo(E.tenantId, c.id, {
      prioridad: "programado",
    });
    const r = await b.llamar(contador, "POST", rutaRevisar(c.id.toUpperCase()));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.trabajo.id).toBe(programada);
    const v = await vivos(c.id, REVISAR);
    expect(v).toHaveLength(1);
    expect(v[0].prioridad).toBe("interactivo");
  });
});

describe("H-023-1-1 · «Abrir» con el UUID del cliente y del mensaje en cualquier grafía (CA-4, D-6)", () => {
  it("las cuatro combinaciones de mayúsculas y minúsculas: un solo trabajo con la clave del id en minúsculas y una sola auditoría apertura_solicitada", async () => {
    const c = await nuevo();
    const m = await b.sembrarMensaje(E.tenantId, c.id, { critico: true });
    const combinaciones: [string, string][] = [
      [c.id, m.id],
      [c.id.toUpperCase(), m.id],
      [c.id, m.id.toUpperCase()],
      [c.id.toUpperCase(), m.id.toUpperCase()],
    ];
    const respuestas = [];
    for (const [cid, mid] of combinaciones)
      respuestas.push(await b.llamar(contador, "POST", rutaAbrir(cid, mid)));
    expect(respuestas.map((r) => r.status)).toEqual([202, 200, 200, 200]);
    const id = respuestas[0]!.body.trabajo.id;
    for (const r of respuestas.slice(1)) expect(r.body.trabajo.id).toBe(id);
    const v = await vivos(c.id, ABRIR);
    expect(v).toHaveLength(1);
    expect(v[0].parametros).toEqual({ mensajeId: m.id });
    expect(
      Buffer.from(v[0].clave_dedupe).equals(
        clave(ABRIR, c.id, { mensajeId: m.id }),
      ),
    ).toBe(true);
    const aud = (
      await b.auditoria(E.tenantId, "buzon.apertura_solicitada")
    ).filter((f: any) => f.entidad_id === m.id);
    expect(aud).toHaveLength(1);
  });

  it("empezar por el id del cliente en mayúsculas da el mismo trabajo único al repetir en minúsculas", async () => {
    const c = await nuevo();
    const m = await b.sembrarMensaje(E.tenantId, c.id, { critico: true });
    const r1 = await b.llamar(
      contador,
      "POST",
      rutaAbrir(c.id.toUpperCase(), m.id),
    );
    expect(r1.status, JSON.stringify(r1.body)).toBe(202);
    const r2 = await b.llamar(contador, "POST", rutaAbrir(c.id, m.id));
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.trabajo.id).toBe(r1.body.trabajo.id);
    expect(await vivos(c.id, ABRIR)).toHaveLength(1);
  });
});
