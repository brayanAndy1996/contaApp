/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 025 · T15 (ronda adversarial 1) por HTTP: importar en dos transacciones con la cola llena (la importación queda en curso sin
// trabajo y bloquea la siguiente hasta el autocierre de 10 min), reemplazar ∥ archivar (el 55000 del archivado sale como
// `regla_cambiada`) y permisos que cambian con la sesión viva (Contador desasignado, miembro desactivado). Las que revelan un hallazgo
// quedan en rojo (H-025-1-n en tasks.md).
import { createDb } from "@contapp/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoAprendizaje,
  base,
  rutaActivar,
  rutaCandidatas,
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
let contador2: Actor;

beforeAll(async () => {
  v = await abrirBancoAprendizaje();
  E = await v.estudio();
  contador = await v.b.c.p.b.miembro(E.tenantId, "contador");
  contador2 = await v.b.c.p.b.miembro(E.tenantId, "contador");
});
afterAll(async () => {
  await v?.b.sql("delete from job_registro where tenant_id = $1", [E?.tenantId]).catch(() => undefined);
  await v?.cerrar();
});

const doc = (n: number): string => `20750${String(n).padStart(6, "0")}`;
const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("T15 · importar con la cola sire llena (dos transacciones)", () => {
  it("ADV-6 si encolar falla, no queda una importación en curso sin trabajo que bloquee el siguiente intento", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    const otro = await v.cliente(E, { responsable: contador.id });
    const tope = Number((await v.b.sql("select max_pendientes_tenant as n from config_sistema where cola = 'sire'", []))[0].n);
    // La cola `sire` del estudio, llena con trabajos de OTRO cliente (en cola, sin despachador en esta prueba).
    await v.b.sql(
      `insert into job_registro (tenant_id, cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, creado_por, max_intentos)
       select $1, c.id, c.ruc, 'reglas.historial.importar', 'sire', 'sire', 'programado', 'en_cola', '{}'::jsonb,
              sha256(convert_to('adv-r1-' || g::text || '-' || gen_random_uuid()::text, 'UTF8')), $3, 3
         from cliente c, generate_series(1, $4::int) g where c.id = $2`,
      [E.tenantId, otro.id, E.titular.id, tope],
    );
    const r1 = await v.http(contador, "POST", rutaImportaciones(c.id), {});
    expect(r1.status, r1.text).toBe(429);
    const enCurso = (await v.importacionesBd(c.id)).filter((i: any) => i.estado === "en_curso");
    expect.soft(enCurso, "tras el error al encolar no debe quedar una importación en curso sin trabajo").toEqual([]);
    // Segundo intento (la cola sigue llena): el mismo error de cola, no 409 importacion_en_curso durante 10 minutos.
    const r2 = await v.http(contador, "POST", rutaImportaciones(c.id), {});
    expect(r2.body?.codigo, r2.text).not.toBe("importacion_en_curso");
  });
});

describe("T15 · reemplazar ∥ archivar", () => {
  it("ADV-7 archivar confirmado mientras reemplazar espera el cliente: 409 cliente_archivado (no regla_cambiada) y nada cambia", async () => {
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
      // Espera a que la función quede bloqueada en el FOR SHARE del cliente (exigirCliente ya leyó «no archivado»).
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
      const reglas = await v.reglasConOrigen(c.id);
      expect(reglas.find((x: any) => x.id === regla)).toMatchObject({ destino: "DG", version: 3 });
    } finally {
      await cx.query("rollback").catch(() => undefined);
      cx.release();
      await su.close();
    }
  });
});

describe("T15 · permisos que cambian con la sesión viva (D-10)", () => {
  it("ADV-8 Contador desasignado y miembro desactivado, ambos con sesión viva: activar no crea reglas", async () => {
    const c = await v.cliente(E, { responsable: E.titular.id, colaboradores: [contador.id, contador2.id] });
    const imp = await v.sembrarImportacion(E.tenantId, c.id, { usuarioId: E.titular.id, solicitadaHace: "1 hour" });
    const [k1, k2] = await v.sembrarCandidatas(
      E.tenantId,
      c.id,
      imp,
      [
        { docNumero: doc(11), destinoPropuesto: "DNG" },
        { docNumero: doc(12), destinoPropuesto: "DNG" },
      ],
      E.titular.id,
    );
    // Las dos sesiones están vivas y ven al cliente.
    expect((await v.http(contador, "GET", rutaCandidatas(c.id))).status).toBe(200);
    expect((await v.http(contador2, "GET", rutaCandidatas(c.id))).status).toBe(200);
    await v.b.sql("delete from asignacion where cliente_id = $1 and usuario_id = $2", [c.id, contador.id]);
    await v.b.sql("update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2", [E.tenantId, contador2.id]);
    const r1 = await v.http(contador, "POST", rutaActivar(c.id), { items: [{ id: k1!.id }] });
    const r2 = await v.http(contador2, "POST", rutaActivar(c.id), { items: [{ id: k2!.id }] });
    expect(r1.status, r1.text).toBe(404);
    expect([401, 403, 404], r2.text).toContain(r2.status);
    expect(await v.reglasConOrigen(c.id)).toEqual([]);
    expect((await v.candidataBd(k1!.id)).estado).toBe("pendiente");
    expect((await v.candidataBd(k2!.id)).estado).toBe("pendiente");
  });
});

describe("T15 · R-STD guardada y regla importada activada después (T8/T12)", () => {
  it("ADV-11 activar la candidata del proveedor tras evaluar: aceptar R-STD (una y en masa) pide revisar de nuevo y no pasa a DNG", async () => {
    const c = await v.cliente(E, { responsable: contador.id });
    await v.b.sql("update cliente set zona = 'amazonia', ventas_exoneradas = true, ventas_mixtas = false where id = $1", [c.id]);
    const numero = doc(21);
    const alta = async (n: number) => {
      const r = await v.llamar(contador, "POST", base(c.id), {
        tipo: "01",
        serie: "F078",
        numero: String(n),
        proveedor: { tipo: "6", numero, razonSocial: "PROVEEDOR ADV R1 SAC" },
        fecha: "2026-10-15",
        moneda: "PEN",
        montos: { biDg: "100.00", igvDg: "18.00" },
      });
      expect(r.status, r.text).toBe(201);
      expect((r.body.fila.hallazgos as any[]).map((h) => h.regla), "control: R-STD guardada").toContain("R-STD");
      return r.body.fila.id as string;
    };
    const una = await alta(1);
    const masa = await alta(2);
    // Después de evaluar: el contador activa la candidata importada del proveedor en DG (regla activa, origen importación).
    const imp = await v.sembrarImportacion(E.tenantId, c.id, { usuarioId: E.titular.id, solicitadaHace: "1 hour" });
    const [k] = await v.sembrarCandidatas(E.tenantId, c.id, imp, [{ docNumero: numero, destinoPropuesto: "DG" }], E.titular.id);
    const act = await v.http(contador, "POST", rutaActivar(c.id), { items: [{ id: k!.id }] });
    expect(act.body?.activadas, act.text).toEqual([k!.id]);
    const antes = await v.foto(c.id);
    const r1 = await v.llamar(contador, "POST", `${base(c.id)}/${una}/sugerencias/aceptar`, { versionBase: 1, regla: "R-STD" });
    expect(r1.status, r1.text).toBe(409);
    expect(r1.body).toEqual({ codigo: "revisar_de_nuevo" });
    const m = await v.llamar(contador, "POST", `${base(c.id)}/masivas/aceptar`, { items: [{ compraId: masa, versionBase: 1 }], regla: "R-STD" });
    expect(m.status, m.text).toBe(200);
    expect(m.body.aplicadas).toBe(0);
    expect(await v.foto(c.id)).toEqual(antes);
  });
});
