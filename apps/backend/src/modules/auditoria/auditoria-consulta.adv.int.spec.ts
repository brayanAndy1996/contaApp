/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 031 · T9 (adversario, ronda 1): ataques HTTP a `GET /auditoria` y `GET /auditoria/opciones` (D-1 a D-6, D-8; CA-4, CA-5,
// CA-7, CA-8). PG real. Caja negra (contrato HTTP de plan.md) y luego caja blanca sobre consulta.ts, el servicio y opciones.ts:
//   - `q` con un byte NUL (válido para zod, inválido para PG): debe ser 400 (CA-7), no un 500.
//   - claves de prototipo y formas raras de qs nunca convierten al asignado en global.
//   - el 404 de un cliente fuera de alcance es indistinguible del de uno inexistente o ajeno (estado, cuerpo y cabeceras), también
//     con el UUID en mayúsculas; /opciones responde igual para los tres.
//   - cursores forjados (posición de otro estudio, años límite, id en mayúsculas) no cruzan el alcance ni la RLS.
//   - fechas límite que el esquema acepta (0000-01-01, 9999-12-31) no rompen la consulta (200) ni cambian el alcance.
//   - el UUID en mayúsculas filtra igual que en minúsculas.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBancoCola, type BancoCola } from "../../../test/soporte-credenciales.js";
import { limpiarAvisosDeEstudios } from "../../../test/soporte-notificaciones.js";
import { capturarLogs } from "../../../test/soporte.js";
import {
  api,
  escenario,
  idsDe,
  ordenado,
  qs,
  referencia,
  sembrarDescifradoEn,
  sembrarEn,
  type Api,
  type Esc,
} from "../../../test/soporte-auditoria.js";

vi.setConfig({ testTimeout: 90_000 });

let b: BancoCola;
let h: Api;
const estudios: string[] = [];

beforeAll(async () => {
  b = await abrirBancoCola();
  h = api(b);
});
afterAll(async () => {
  if (b) await limpiarAvisosDeEstudios(estudios);
  await b?.cerrar();
});

const sql = <T = any>(t: string, v?: unknown[]) => b.sql<T>(t, v);
const INVALIDA = { codigo: "solicitud_invalida" };
const cursorDe = (o: unknown): string => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");

/** Estudio con un asignado a A (no a B), filas en A, B y sin cliente en las dos ramas, y un estudio ajeno con lo suyo. */
async function mundo() {
  const e: Esc = await escenario(b, estudios);
  const otro: Esc = await escenario(b, estudios);
  const asig = await e.conRolPropio("asignado");
  await b.c.p.b.asignar(e.E.tenantId, e.A.id, asig.id, "responsable");
  const t = e.E.tenantId;
  const rA = await sembrarEn(sql, { tenantId: t, en: "2026-03-10T15:00:00.000Z", usuarioId: e.dueno.id, clienteId: e.A.id, accion: "cliente.editado" });
  const rB = await sembrarEn(sql, { tenantId: t, en: "2026-03-10T16:00:00.000Z", usuarioId: e.dueno.id, clienteId: e.B.id, accion: "cliente.editado" });
  const rSin = await sembrarEn(sql, { tenantId: t, en: "2026-03-10T17:00:00.000Z", usuarioId: e.dueno.id, accion: "miembro.rol_cambiado", entidad: "membresia" });
  const dA = await sembrarDescifradoEn(sql, { tenantId: t, clienteId: e.A.id, en: "2026-03-10T18:00:00.000Z" });
  const dB = await sembrarDescifradoEn(sql, { tenantId: t, clienteId: e.B.id, en: "2026-03-10T19:00:00.000Z" });
  const oA = await sembrarEn(sql, { tenantId: otro.E.tenantId, en: "2026-03-10T15:30:00.000Z", usuarioId: otro.dueno.id, clienteId: otro.A.id, accion: "cliente.editado" });
  const odA = await sembrarDescifradoEn(sql, { tenantId: otro.E.tenantId, clienteId: otro.A.id, en: "2026-03-10T18:30:00.000Z" });
  return { e, otro, asig, rA, rB, rSin, dA, dB, oA, odA, prohibidos: [rB.id, rSin.id, dB.id, oA.id, odA.id] };
}

/* ================================ CA-7 · NUL en `q` ================================ */
describe("ADV-H1 · `q` con un byte NUL (zod lo acepta; PG no admite 0x00 en text)", () => {
  it("GET /auditoria/opciones?q=%00 y q=a%00b → 400 solicitud_invalida, no 500; sin eco en la respuesta ni en los logs", async () => {
    const e = await escenario(b, estudios);
    const { resultado, logs } = await capturarLogs(async () => [
      await h.get(e.dueno, "/auditoria/opciones?q=%00"),
      await h.get(e.dueno, `/auditoria/opciones?q=SAN%00${encodeURIComponent("MARCA-NUL-031")}`),
    ]);
    for (const r of resultado) {
      expect(r.status, r.text).toBe(400);
      expect(r.body).toEqual(INVALIDA);
    }
    expect(logs).not.toContain("MARCA-NUL-031");
  });
});

/* ================================ qs hostil · el asignado nunca pasa a global ================================ */
describe("ADV-H2 · claves de prototipo y formas raras de qs no cambian el alcance (D-3, CA-7)", () => {
  it.each([
    ["__proto__[tipo]=global"],
    ["__proto__.tipo=global"],
    ["constructor[prototype][tipo]=global"],
    ["alcance=global"],
    ["tipo=global"],
    ["accion[0]=cliente.editado&accion[1]=credencial.descifrada"],
    ["accion[]=cliente.editado"],
    ["desde[]=2026-03-01"],
    ["cursor[e]=2026-03-10T00:00:00.000Z&cursor[i]=x"],
  ])("asignado con ?%s → 400 o solo sus filas; /opciones igual", async (consulta) => {
    const m = await mundo();
    const r = await h.get(m.asig, `/auditoria?${consulta}`);
    expect([200, 400], r.text).toContain(r.status);
    if (r.status === 400) expect(r.body).toEqual(INVALIDA);
    else {
      expect(idsDe(r.body.items).filter((i: string) => m.prohibidos.includes(i))).toEqual([]);
      expect(r.body.items.every((x: any) => x.cliente?.id === m.e.A.id)).toBe(true);
    }
    const o = await h.get(m.asig, `/auditoria/opciones?${consulta}`);
    expect([200, 400], o.text).toContain(o.status);
    if (o.status === 200) expect(o.body.clientes.map((c: any) => c.id)).not.toContain(m.e.B.id);
  });
});

/* ================================ 404 sin diferencias observables ================================ */
describe("ADV-H3 · clienteId fuera de alcance = inexistente = ajeno, sin diferencias observables (D-3, CA-4)", () => {
  const VOLATILES = new Set(["date", "x-request-id", "etag", "x-response-time", "set-cookie"]);
  const huella = (r: { status: number; text: string; headers: Record<string, unknown> }) => ({
    status: r.status,
    text: r.text,
    headers: Object.fromEntries(Object.entries(r.headers).filter(([k]) => !VOLATILES.has(k.toLowerCase())).sort(([a], [z]) => (a < z ? -1 : 1))),
  });

  it("misma huella (estado, cuerpo, cabeceras) con y sin filtros/cursor, en minúsculas y MAYÚSCULAS; /opciones idéntico", async () => {
    const m = await mundo();
    const candidatos = { noAsignado: m.e.B.id, ajeno: m.otro.A.id, inexistente: randomUUID() };
    const cursor = cursorDe({ e: "2026-03-11T00:00:00.000Z", i: randomUUID() });
    for (const extra of [{}, { accion: ["cliente.editado", "credencial.descifrada"], desde: "2026-03-01", cursor }]) {
      const huellas: Record<string, unknown> = {};
      for (const [n, id] of Object.entries(candidatos)) {
        for (const forma of [id, id.toUpperCase()]) {
          const r = await h.get(m.asig, `/auditoria${qs({ clienteId: forma, ...extra })}`);
          expect(r.status, `${n} ${r.text}`).toBe(404);
          huellas[`${n}:${forma === id ? "min" : "MAY"}`] = huella(r);
        }
      }
      const unicas = new Set(Object.values(huellas).map((x) => JSON.stringify(x)));
      expect(unicas.size, JSON.stringify(huellas, null, 1)).toBe(1);
    }
    const ops = await Promise.all(Object.values(candidatos).map((id) => h.opciones(m.asig, { clienteId: id.toUpperCase() })));
    for (const o of ops) expect(o.status, o.text).toBe(200);
    expect(new Set(ops.map((o) => JSON.stringify(o.body.clientes))).size).toBe(1);
    expect(ops[0]!.body.clientes).toEqual([]);
  });
});

/* ================================ cursor forjado ================================ */
describe("ADV-H4 · cursores forjados no cruzan el alcance ni la RLS (D-1, CA-5)", () => {
  it("posición de una fila del otro estudio, años límite e id en MAYÚSCULAS: 200 y solo filas del alcance", async () => {
    const m = await mundo();
    const forjados = [
      { e: m.oA.en, i: m.oA.id },
      { e: m.odA.en, i: m.odA.id.toUpperCase() },
      { e: "9999-12-31T23:59:59.999Z", i: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
      { e: "0000-01-01T00:00:00.000Z", i: "00000000-0000-0000-0000-000000000000" },
      { e: "1970-01-01T00:00:00.000Z", i: randomUUID() },
    ];
    const visibles = await referencia(sql, m.e.E.tenantId, {}, [m.e.A.id]);
    for (const c of forjados) {
      for (const a of [m.asig, m.e.dueno]) {
        const r = await h.get(a, `/auditoria${qs({ cursor: cursorDe(c) })}`);
        expect(r.status, `${JSON.stringify(c)} ${r.text}`).toBe(200);
        const ids = idsDe(r.body.items);
        expect(ids.filter((i) => [m.oA.id, m.odA.id].includes(i)), "nada del otro estudio").toEqual([]);
        if (a === m.asig) expect(ids.filter((i) => !visibles.includes(i)), "nada fuera de A").toEqual([]);
      }
    }
    const conFuturo = await h.get(m.asig, `/auditoria${qs({ cursor: cursorDe(forjados[2]) })}`);
    expect(ordenado(idsDe(conFuturo.body.items))).toEqual(ordenado(visibles));
  });

  it.each([
    ["ISO con zona distinta de Z", { e: "2026-03-10T10:00:00.000-05:00", i: randomUUID() }],
    ["clave extra", { e: "2026-03-10T10:00:00.000Z", i: randomUUID(), t: "global" }],
    ["__proto__ como clave", JSON.parse(`{"e":"2026-03-10T10:00:00.000Z","i":"${randomUUID()}","__proto__":{"tipo":"global"}}`)],
    ["id no UUID con comilla", { e: "2026-03-10T10:00:00.000Z", i: "' or '1'='1" }],
    ["fecha imposible", { e: "2026-02-30T10:00:00.000Z", i: randomUUID() }],
  ])("cursor con %s → 400 solicitud_invalida", async (_n, c) => {
    const e = await escenario(b, estudios);
    const r = await h.get(e.dueno, `/auditoria${qs({ cursor: cursorDe(c) })}`);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual(INVALIDA);
  });
});

/* ================================ fechas límite y UUID en mayúsculas ================================ */
describe("ADV-H5 · fechas límite y UUID en mayúsculas (D-2, CA-7)", () => {
  it("desde=0000-01-01, hasta=9999-12-31 y ambos: 200 y lo mismo que sin fechas (asignado y Dueño)", async () => {
    const m = await mundo();
    for (const a of [m.asig, m.e.dueno]) {
      const base = ordenado(idsDe((await h.recorrer(a)).items));
      for (const f of [{ desde: "0000-01-01" }, { hasta: "9999-12-31" }, { desde: "0000-01-01", hasta: "9999-12-31" }, { desde: "0001-01-01", hasta: "0099-12-31" }]) {
        const r = await h.get(a, `/auditoria${qs(f)}`);
        expect(r.status, `${JSON.stringify(f)}: ${r.text}`).toBe(200);
        // Con datos de 2026, un rango que acaba en el año 99 no debe traer nada; los demás, todo.
        const esperado = f.hasta === "0099-12-31" ? [] : base;
        expect(ordenado(idsDe(r.body.items)), `${a.rol} ${JSON.stringify(f)}`).toEqual(esperado);
      }
    }
  });

  it("usuarioId y clienteId en MAYÚSCULAS filtran igual que en minúsculas (asignado); el ajeno en mayúsculas no abre nada", async () => {
    const m = await mundo();
    const min = await h.recorrer(m.asig, { usuarioId: m.e.dueno.id, clienteId: m.e.A.id });
    const may = await h.recorrer(m.asig, { usuarioId: m.e.dueno.id.toUpperCase(), clienteId: m.e.A.id.toUpperCase() });
    expect(idsDe(may.items)).toEqual(idsDe(min.items));
    expect(idsDe(min.items)).toContain(m.rA.id);
    const ajeno = await h.recorrer(m.e.dueno, { usuarioId: m.otro.dueno.id.toUpperCase() });
    expect(ajeno.items).toEqual([]);
  });
});
