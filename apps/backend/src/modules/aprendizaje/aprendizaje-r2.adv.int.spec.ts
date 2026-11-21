/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 025 · T18 (ronda adversarial 2) por HTTP: la importación en UNA transacción con `encolarCon` (corrección de H-025-1-1).
// Dos POST simultáneos del mismo cliente: uno gana (202) y el otro recibe 409 `importacion_en_curso`, sin dejar un segundo trabajo
// ni una importación sin trabajo; y la cola llena tras el autocierre de una importación colgada no la da por cerrada (todo o nada).
// Las que revelan un hallazgo quedan en rojo (H-025-2-n en tasks.md).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abrirBancoAprendizaje, rutaImportaciones, type Actor, type BancoAprendizaje, type Estudio } from "../../../test/soporte-aprendizaje.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let v: BancoAprendizaje;
let E: Estudio;
let contador: Actor;

beforeAll(async () => {
  v = await abrirBancoAprendizaje();
  E = await v.estudio();
  contador = await v.b.c.p.b.miembro(E.tenantId, "contador");
});
afterAll(async () => {
  await v?.b.sql("delete from job_registro where tenant_id = $1", [E?.tenantId]).catch(() => undefined);
  await v?.cerrar();
});

describe("T18 · importar en una transacción (H-025-1-1)", () => {
  it("ADV2-12 dos POST simultáneos: un 202 y un 409 importacion_en_curso; una importación en curso con UN trabajo que es el suyo", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    const rs = await Promise.all([
      v.http(contador, "POST", rutaImportaciones(c.id), { periodos: 3 }),
      v.http(contador, "POST", rutaImportaciones(c.id), { periodos: 6 }),
      v.http(contador, "POST", rutaImportaciones(c.id), {}),
    ]);
    const estados = rs.map((r) => r.status).sort();
    expect(estados, rs.map((r) => r.text).join(" | ")).toEqual([202, 409, 409]);
    for (const r of rs.filter((x) => x.status === 409)) expect(r.body).toEqual({ codigo: "importacion_en_curso" });
    const ok = rs.find((r) => r.status === 202)!;
    const imps = await v.importacionesBd(c.id);
    expect(imps, "una sola importación (las perdedoras no dejan fila)").toHaveLength(1);
    const trabajos = await v.trabajosImportar(E.tenantId, c.id);
    expect(trabajos, "un solo trabajo (los perdedores no dejan trabajo huérfano)").toHaveLength(1);
    expect(imps[0].estado).toBe("en_curso");
    expect(imps[0].trabajo_id).toBe(trabajos[0].id);
    expect(ok.body.trabajoId).toBe(trabajos[0].id);
    expect(trabajos[0].parametros).toEqual({ importacionId: imps[0].id });
  });

  it("ADV2-13 importación colgada (trabajo en error) y cola llena: 429 y la colgada NO queda cerrada a medias; liberada la cola, 202", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    const otro = await v.cliente(E, { responsable: contador.id });
    const colgadaTrabajo = await v.sembrarTrabajoImportar(E.tenantId, c.id, "error", E.titular.id);
    const colgada = await v.sembrarImportacion(E.tenantId, c.id, {
      usuarioId: E.titular.id,
      estado: "en_curso",
      trabajoId: colgadaTrabajo,
      solicitadaHace: "1 hour",
    });
    const tope = Number((await v.b.sql("select max_pendientes_tenant as n from config_sistema where cola = 'sire'", []))[0].n);
    await v.b.sql(
      `insert into job_registro (tenant_id, cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, creado_por, max_intentos)
       select $1, c.id, c.ruc, 'reglas.historial.importar', 'sire', 'sire', 'programado', 'en_cola', '{}'::jsonb,
              sha256(convert_to('adv-r2-' || g::text || '-' || gen_random_uuid()::text, 'UTF8')), $3, 3
         from cliente c, generate_series(1, $4::int) g where c.id = $2`,
      [E.tenantId, otro.id, E.titular.id, tope],
    );
    const r1 = await v.http(contador, "POST", rutaImportaciones(c.id), {});
    expect(r1.status, r1.text).toBe(429);
    const tras = await v.importacionesBd(c.id);
    expect(tras.map((i: any) => [i.id, i.estado]), "nada se confirmó: la colgada sigue igual y no hay otra").toEqual([[colgada, "en_curso"]]);
    await v.b.sql("delete from job_registro where tenant_id = $1 and cliente_id = $2", [E.tenantId, otro.id]);
    const r2 = await v.http(contador, "POST", rutaImportaciones(c.id), {});
    expect(r2.status, r2.text).toBe(202);
    const fin = await v.importacionesBd(c.id);
    expect(fin.find((i: any) => i.id === colgada)).toMatchObject({ estado: "fallida", motivo: "interrumpido" });
    expect(fin.filter((i: any) => i.estado === "en_curso")).toHaveLength(1);
  });
});
