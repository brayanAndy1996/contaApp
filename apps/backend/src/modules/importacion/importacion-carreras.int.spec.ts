/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 007b (T4, rojo): carreras de cupo en la importación (CA-3, D8; plan: Decisiones, «Orden de bloqueo»).
// Dos o tres importaciones simultáneas del mismo estudio que juntas superan el cupo: la suma de clientes activos nunca
// excede el límite, cada una responde 200 con su informe y las filas que ya no caben salen como `cupo_rucs`; ni un 500 ni
// un `40P01` (deadlock) en respuestas ni logs. También: dos importaciones con los mismos RUC (la segunda los ve como
// `duplicado` al revalidar dentro de la transacción) y una importación contra altas por el formulario.
// Contrato: `POST /clientes/importacion/confirmar` con el archivo crudo (ver `importacion.int.spec.ts`).
// Rojo: la ruta aún no existe (T12).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirBancoCola,
  filtrados,
  pedirBin,
  type Actor,
  type BancoCola,
  type Estudio,
} from "../../../test/soporte-credenciales.js";
import { rucConPrefijo, xlsxConDatos } from "../../../test/soporte-importacion.js";
import { capturarLogs } from "../../../test/soporte.js";

const CONFIRMAR = "/clientes/importacion/confirmar";
let b: BancoCola;
let serie = 2_000_000 + (process.pid % 997) * 1000;
const rucs = (n: number) => Array.from({ length: n }, () => rucConPrefijo("20", serie++));
const archivo = (lista: string[]) => xlsxConDatos(lista.map((ruc) => ({ ruc })));
const confirmar = (a: Actor, bytes: Uint8Array) => pedirBin(b.c.p.b.h, a, "POST", CONFIRMAR, bytes);

beforeAll(async () => {
  b = await abrirBancoCola();
});
afterAll(async () => {
  await b?.cerrar();
});

/** Deja el estudio sin clientes, credenciales ni trabajos para repetir la ronda (conexión de migraciones). */
async function vaciar(t: string): Promise<void> {
  await b.sql("delete from job_registro where tenant_id = $1", [t]);
  await b.sql("delete from credencial where tenant_id = $1", [t]);
  await b.sql("delete from asignacion where tenant_id = $1", [t]);
  await b.sql("delete from cliente where tenant_id = $1", [t]);
}
const SIN_DEADLOCK = (...textos: unknown[]) => filtrados(["40P01", "deadlock", "Deadlock"], ...textos);

describe("CA-3 · importaciones simultáneas que superan el cupo", () => {
  let E: Estudio;
  let admin: Actor;
  let dueno2: Actor;
  beforeAll(async () => {
    E = await b.estudioCon(6);
    admin = await b.c.p.b.miembro(E.tenantId, "admin");
    dueno2 = await b.c.p.b.miembro(E.tenantId, "dueno");
  });

  it.each([2, 3])("%i importaciones de 5 filas válidas con 6 cupos: exactamente 6 clientes activos, el resto cupo_rucs, sin 500 ni 40P01 (10 rondas)", async (n) => {
    const actores = [E.titular, admin, dueno2];
    for (let ronda = 0; ronda < 10; ronda++) {
      await vaciar(E.tenantId);
      const lotes = Array.from({ length: n }, () => rucs(5));
      const { resultado: rs, logs } = await capturarLogs(() =>
        Promise.all(lotes.map((l, i) => confirmar(actores[i]!, archivo(l)))),
      );
      const ctx = `ronda ${ronda}: ${rs.map((r) => `${r.status}`).join(",")}`;
      for (const r of rs) {
        expect(r.status, `${ctx} ${r.texto.slice(0, 200)}`).toBe(200);
        expect(SIN_DEADLOCK(r.texto, logs), ctx).toEqual([]);
      }
      const creadas = rs.reduce((s, r) => s + r.json.creadas, 0);
      const noImportadas = rs.flatMap((r) => r.json.noImportadas);
      expect(creadas, ctx).toBe(6);
      expect(await b.c.activos(E.tenantId), ctx).toBe(6);
      expect(await b.c.total(E.tenantId), ctx).toBe(6);
      // Cada fila que no cupo se informa con su motivo; ninguna se pierde ni se duplica.
      expect(noImportadas, ctx).toHaveLength(n * 5 - 6);
      expect(new Set(noImportadas.map((x: any) => x.motivo)), ctx).toEqual(new Set(["cupo_rucs"]));
      const informados = new Set([...noImportadas.map((x: any) => x.ruc)]);
      const todas = lotes.flat();
      const existentes = new Set((await b.sql("select ruc from cliente where tenant_id = $1", [E.tenantId])).map((f) => f.ruc));
      for (const r of todas) expect(existentes.has(r) !== informados.has(r), `${ctx}: ${r} debe estar creado o informado, no ambos ni ninguno`).toBe(true);
    }
  });
});

describe("CA-3 · los mismos RUC en dos importaciones simultáneas", () => {
  it("se crean una sola vez; la otra los ve como duplicado al revalidar (200, nunca 500 por la unicidad)", async () => {
    const E = await b.estudioCon(20);
    const admin = await b.c.p.b.miembro(E.tenantId, "admin");
    for (let ronda = 0; ronda < 8; ronda++) {
      await vaciar(E.tenantId);
      const mismos = rucs(3);
      const { resultado: rs, logs } = await capturarLogs(() =>
        Promise.all([confirmar(E.titular, archivo(mismos)), confirmar(admin, archivo(mismos))]),
      );
      const ctx = `ronda ${ronda}: ${rs.map((r) => r.status).join(",")} ${rs.map((r) => r.texto.slice(0, 120)).join(" | ")}`;
      expect(rs.map((r) => r.status), ctx).toEqual([200, 200]);
      expect(SIN_DEADLOCK(...rs.map((r) => r.texto), logs), ctx).toEqual([]);
      expect(rs.reduce((s, r) => s + r.json.creadas, 0), ctx).toBe(3);
      const rechazadas = rs.flatMap((r) => r.json.noImportadas);
      expect(rechazadas, ctx).toHaveLength(3);
      expect(new Set(rechazadas.map((x: any) => x.motivo)), ctx).toEqual(new Set(["duplicado"]));
      expect(await b.c.total(E.tenantId), ctx).toBe(3);
    }
  });
});

describe("CA-3 · una importación contra altas por el formulario", () => {
  it("el total de activos no pasa del límite; las altas que no caben dan 409 cupo_rucs y la importación informa cupo_rucs", async () => {
    const E = await b.estudioCon(5);
    const admin = await b.c.p.b.miembro(E.tenantId, "admin");
    for (let ronda = 0; ronda < 8; ronda++) {
      await vaciar(E.tenantId);
      await b.c.sembrar(E.tenantId); // 1 de 5: quedan 4
      const { resultado: rs, logs } = await capturarLogs(() =>
        Promise.all([
          confirmar(E.titular, archivo(rucs(4))),
          b.c.crear(admin, { ruc: rucs(1)[0] }),
          b.c.crear(admin, { ruc: rucs(1)[0] }),
          b.c.crear(E.titular, { ruc: rucs(1)[0] }),
        ]),
      );
      const [imp, ...altas] = rs as [any, ...any[]];
      const ctx = `ronda ${ronda}: ${rs.map((r: any) => r.status).join(",")}`;
      expect(imp.status, ctx).toBe(200);
      for (const a of altas) {
        expect([201, 409], `${ctx} ${a.text}`).toContain(a.status);
        if (a.status === 409) expect(a.body, ctx).toEqual({ codigo: "cupo_rucs" });
      }
      expect(SIN_DEADLOCK(imp.texto, ...altas.map((a: any) => a.text), logs), ctx).toEqual([]);
      const activos = await b.c.activos(E.tenantId);
      expect(activos, ctx).toBe(5); // demanda 7 > 4 libres: el cupo se llena exactamente y no se excede
      const altasOk = altas.filter((a: any) => a.status === 201).length;
      expect(1 + imp.json.creadas + altasOk, ctx).toBe(5);
    }
  });
});
