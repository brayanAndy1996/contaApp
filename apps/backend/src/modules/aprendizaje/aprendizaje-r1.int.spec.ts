/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 025 · T16: correcciones de la ronda adversarial 1 por HTTP (hallazgos H-025-1-1, -2 y -4), en rojo hasta T17.
//  - H1: si encolar falla (cola `sire` llena, 429 `cola_llena`) no queda una importación `en_curso` sin trabajo: el siguiente POST,
//    con la cola ya libre, inicia (202) y no responde 409 `importacion_en_curso`.
//  - H2: un cliente archivado mientras `reemplazar` esperaba el bloqueo del cliente responde 409 `cliente_archivado`, no
//    `regla_cambiada`; la candidata que ya no está pendiente sigue siendo `regla_cambiada` (control).
//  - H4 (U-8, decidida por el usuario: «solo de una en una eligiendo el destino a mano»): el servidor rechaza con 400
//    `solicitud_invalida`, sin activar nada, un lote de `items` que activaría más de una candidata «sin criterio claro», o una sin
//    criterio junto a cualquier otra candidata (de una en una = sola en su petición). Controles que ya pasan y deben seguir pasando:
//    una sin criterio con destino sola se activa; una sin criterio SIN destino junto a otras es el parcial de siempre (se omite).
import { createDb } from "@contapp/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoAprendizaje,
  rutaActivar,
  rutaImportaciones,
  rutaReemplazar,
  type Actor,
  type BancoAprendizaje,
  type Estudio,
} from "../../../test/soporte-aprendizaje.js";

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

const doc = (n: number): string => `20751${String(n).padStart(6, "0")}`;
const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("T16 · H-025-1-1: importar con la cola llena", () => {
  it("tras el 429 `cola_llena` no queda importación en curso sin trabajo y, liberada la cola, el siguiente POST inicia", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    const otro = await v.cliente(E, { responsable: contador.id });
    const tope = Number((await v.b.sql("select max_pendientes_tenant as n from config_sistema where cola = 'sire'", []))[0].n);
    await v.b.sql(
      `insert into job_registro (tenant_id, cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, creado_por, max_intentos)
       select $1, c.id, c.ruc, 'reglas.historial.importar', 'sire', 'sire', 'programado', 'en_cola', '{}'::jsonb,
              sha256(convert_to('r1-h1-' || g::text || '-' || gen_random_uuid()::text, 'UTF8')), $3, 3
         from cliente c, generate_series(1, $4::int) g where c.id = $2`,
      [E.tenantId, otro.id, E.titular.id, tope],
    );
    const lleno = await v.http(contador, "POST", rutaImportaciones(c.id), {});
    expect(lleno.status, lleno.text).toBe(429);
    expect(lleno.body?.codigo, lleno.text).toBe("cola_llena");
    const enCurso = (await v.importacionesBd(c.id)).filter((i: any) => i.estado === "en_curso");
    expect(enCurso, "el encolado fallido no deja una importación en curso sin trabajo").toEqual([]);
    // La cola se libera: el contador reintenta y la importación arranca, sin esperar al autocierre de 10 minutos.
    await v.b.sql("delete from job_registro where tenant_id = $1 and cliente_id = $2", [E.tenantId, otro.id]);
    const otra = await v.http(contador, "POST", rutaImportaciones(c.id), {});
    expect(otra.body?.codigo, otra.text).not.toBe("importacion_en_curso");
    expect(otra.status, otra.text).toBe(202);
  });
});

describe("T16 · H-025-1-2: reemplazar ∥ archivar", () => {
  it("cliente archivado confirmado mientras reemplazar espera el cliente: 409 cliente_archivado y la regla no cambia", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    const imp = await v.sembrarImportacion(E.tenantId, c.id, { usuarioId: E.titular.id, solicitadaHace: "1 hour" });
    const [regla] = await v.sembrarReglasVivas(E.tenantId, c.id, [{ docNumero: doc(1), destino: "DG", version: 3 }], E.titular.id);
    const [cand] = await v.sembrarCandidatas(E.tenantId, c.id, imp, [{ docNumero: doc(1), destinoPropuesto: "DNG" }], E.titular.id);
    const url = process.env.MIGRATIONS_DATABASE_URL;
    if (!url) throw new Error("falta MIGRATIONS_DATABASE_URL");
    const su = createDb({ rolApp: "contapp_backend", url, poolMax: 1 });
    const cx = await su.pool.connect();
    try {
      await cx.query("begin");
      await cx.query("update cliente set archivado_at = now() where id = $1", [c.id]);
      const pedido = v.http(contador, "POST", rutaReemplazar(c.id, cand!.id), { versionRegla: 3 });
      // Espera a que la función quede bloqueada en el FOR SHARE del cliente (la lectura previa aún lo vio sin archivar).
      let esperando = false;
      for (let i = 0; i < 100 && !esperando; i++) {
        const w = await v.b.sql("select count(*)::int as n from pg_locks where not granted", []);
        esperando = Number(w[0].n) > 0;
        if (!esperando) await dormir(50);
      }
      await cx.query("commit");
      const r = await pedido;
      expect(esperando, "la petición llegó a esperar el bloqueo del cliente").toBe(true);
      expect(r.status, r.text).toBe(409);
      expect(r.body).toEqual({ codigo: "cliente_archivado" });
      expect((await v.reglasConOrigen(c.id)).find((x: any) => x.id === regla)).toMatchObject({ destino: "DG", version: 3 });
      expect((await v.candidataBd(cand!.id)).estado).toBe("pendiente");
    } finally {
      await cx.query("rollback").catch(() => undefined);
      cx.release();
      await su.close();
    }
  });

  it("control: una candidata que ya no está pendiente sigue dando 409 regla_cambiada (no se confunde con el archivado)", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    const imp = await v.sembrarImportacion(E.tenantId, c.id, { usuarioId: E.titular.id, solicitadaHace: "1 hour" });
    await v.sembrarReglasVivas(E.tenantId, c.id, [{ docNumero: doc(2), destino: "DG", version: 3 }], E.titular.id);
    const [cand] = await v.sembrarCandidatas(
      E.tenantId,
      c.id,
      imp,
      [{ docNumero: doc(2), destinoPropuesto: "DNG", estado: "descartada" }],
      E.titular.id,
    );
    const r = await v.http(contador, "POST", rutaReemplazar(c.id, cand!.id), { versionRegla: 3 });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "regla_cambiada" });
  });
});

describe("T16 · H-025-1-4: «sin criterio claro» solo de una en una (U-8)", () => {
  async function escenario() {
    const c = await v.cliente(E, { responsable: contador.id });
    const imp = await v.sembrarImportacion(E.tenantId, c.id, { usuarioId: E.titular.id, solicitadaHace: "1 hour" });
    const [s1, s2, p1] = await v.sembrarCandidatas(
      E.tenantId,
      c.id,
      imp,
      [
        { docNumero: doc(11), destinoPropuesto: null },
        { docNumero: doc(12), destinoPropuesto: null },
        { docNumero: doc(13), destinoPropuesto: "DNG" },
      ],
      E.titular.id,
    );
    return { c, s1: s1!, s2: s2!, p1: p1! };
  }
  const intacto = async (e: Awaited<ReturnType<typeof escenario>>) => {
    expect(await v.reglasConOrigen(e.c.id)).toEqual([]);
    for (const k of [e.s1, e.s2, e.p1]) expect((await v.candidataBd(k.id)).estado).toBe("pendiente");
  };

  it("dos sin criterio, cada una con destino, en un lote: 400 solicitud_invalida y no se activa ninguna", async () => {
    const e = await escenario();
    const r = await v.http(contador, "POST", rutaActivar(e.c.id), {
      items: [
        { id: e.s1.id, destino: "DG" },
        { id: e.s2.id, destino: "DGNG" },
      ],
    });
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    await intacto(e);
  });

  it("una sin criterio con destino junto a una propuesta en el mismo lote: 400 solicitud_invalida (de una en una = sola)", async () => {
    const e = await escenario();
    const r = await v.http(contador, "POST", rutaActivar(e.c.id), { items: [{ id: e.s1.id, destino: "DG" }, { id: e.p1.id }] });
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    await intacto(e);
  });

  it("control: una sin criterio con destino elegido, sola, se activa con ese destino", async () => {
    const e = await escenario();
    const r = await v.http(contador, "POST", rutaActivar(e.c.id), { items: [{ id: e.s1.id, destino: "DGNG" }] });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ activadas: [e.s1.id], omitidas: [] });
    expect((await v.candidataBd(e.s1.id)).estado).toBe("activada");
    expect((await v.candidataBd(e.s2.id)).estado).toBe("pendiente");
  });

  it("control: una sin criterio SIN destino junto a una propuesta es el parcial de siempre (se omite como sin_criterio)", async () => {
    const e = await escenario();
    const r = await v.http(contador, "POST", rutaActivar(e.c.id), { items: [{ id: e.s1.id }, { id: e.p1.id }] });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ activadas: [e.p1.id], omitidas: [{ id: e.s1.id, motivo: "sin_criterio" }] });
  });
});
