// Spec 005 · T15: pruebas propias de las correcciones de la ronda adversarial 1 en la BD (migración 0015 y
// `revocarPendientesDe`). H-005-1b-1: una invitación vale solo mientras su invitador conserve la autoridad (activo
// y con un rol que pueda otorgar el invitado: Dueño cualquiera; Administrador cualquiera salvo `dueno`; el resto
// ninguno = `puedeGestionar` de @contapp/shared con `usuarios.gestionar`). H-005-1b-2: CHECK sin caracteres de
// control en `invitacion.correo`. H-005-1b-3: nombre válido en `invitacion_aceptar_nueva`.
import { revocarPendientesDe } from "@contapp/db";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EscenarioAcceso, sha256 } from "./acceso-soporte";
import { abrirAdmin, abrirApp, crearDb, hashFalso, llamar, nuevoToken } from "./auth-soporte";
import type { ContappDb } from "./soporte";

type Rol = "dueno" | "admin" | "contador" | "asistente" | "lectura";
const ROLES: Rol[] = ["dueno", "admin", "contador", "asistente", "lectura"];
/** Tabla esperada de D8 para invitar (misma que `puedeGestionar(invitador, null, invitado)` con `usuarios.gestionar`). */
const otorga = (invitador: Rol, invitado: Rol): boolean =>
  invitador === "dueno" || (invitador === "admin" && invitado !== "dueno");

let app: Pool;
let admin: Pool;
let ea: EscenarioAcceso;
let db: ContappDb;

beforeAll(() => {
  app = abrirApp(4);
  admin = abrirAdmin(4);
  ea = new EscenarioAcceso(admin);
  db = crearDb("contapp_backend", 2);
});
afterAll(async () => {
  await ea?.limpiar();
  await db?.close();
  await app?.end();
  await admin?.end();
});

const vigente = async (tokenHash: Buffer): Promise<number> => {
  const r = await llamar(app, "select * from auth.invitacion_vigente($1)", [tokenHash]);
  if (!r.ok) throw new Error(r.code);
  return r.rows.length;
};
const usuarios = async (correo: string): Promise<number> =>
  (await admin.query("select count(*)::int as n from usuario where email = $1", [correo])).rows[0].n;
const pendientes = async (tenantId: string, invitadoPor: string): Promise<string[]> =>
  (
    await admin.query(
      "select rol from invitacion where tenant_id = $1 and invitado_por = $2 and revocada_en is null and aceptada_en is null order by rol",
      [tenantId, invitadoPor],
    )
  ).rows.map((f) => f.rol);

describe("H-005-1b-1 · autoridad del invitador al consultar y aceptar", () => {
  it("invitacion_vigente sigue la tabla D8 para los 25 pares (rol del invitador × rol invitado)", async () => {
    const x = await ea.estudio();
    await ea.miembro(x.id, "dueno");
    const vistos: Record<string, boolean> = {};
    const esperados: Record<string, boolean> = {};
    for (const de of ROLES) {
      const invitador = await ea.miembro(x.id, de);
      for (const a of ROLES) {
        const inv = await ea.invitacion(x.id, { invitadoPor: invitador.id, rol: a });
        vistos[`${de}->${a}`] = (await vigente(inv.tokenHash)) === 1;
        esperados[`${de}->${a}`] = otorga(de, a);
      }
    }
    expect(vistos).toEqual(esperados);
  });

  it("aceptar_nueva: invitador activo con autoridad -> 'aceptada'; desactivado -> 'invalida' sin cuenta y sin consumir", async () => {
    const x = await ea.estudio();
    await ea.miembro(x.id, "dueno");
    const adm = await ea.miembro(x.id, "admin");
    const buena = await ea.invitacion(x.id, { invitadoPor: adm.id, rol: "contador" });
    const ok = await llamar(app, "select auth.invitacion_aceptar_nueva($1, $2, $3) as r", [buena.tokenHash, "Invitada T15", hashFalso()]);
    expect(ok).toMatchObject({ ok: true, rows: [{ r: "aceptada" }] });
    expect(await usuarios(buena.correo)).toBe(1);

    const mala = await ea.invitacion(x.id, { invitadoPor: adm.id, rol: "contador" });
    await admin.query("update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2", [x.id, adm.id]);
    const r = await llamar(app, "select auth.invitacion_aceptar_nueva($1, $2, $3) as r", [mala.tokenHash, "Invitada T15", hashFalso()]);
    expect(r).toMatchObject({ ok: true, rows: [{ r: "invalida" }] });
    expect(await usuarios(mala.correo)).toBe(0);
    const fila = await admin.query("select aceptada_en from invitacion where id = $1", [mala.id]);
    expect(fila.rows[0].aceptada_en).toBeNull();
  });

  it("aceptar_existente: Administrador que invitó como dueno (sin autoridad) -> cero filas; como admin -> membresía", async () => {
    const x = await ea.estudio();
    await ea.miembro(x.id, "dueno");
    const adm = await ea.miembro(x.id, "admin");
    const resultados: Record<string, number> = {};
    for (const rol of ["dueno", "admin"] as const) {
      const inv = await ea.invitacion(x.id, { invitadoPor: adm.id, rol });
      const u = await admin.query("insert into usuario (email, nombre) values ($1, 'Cuenta T15') returning id", [inv.correo]);
      const sesion = nuevoToken();
      await admin.query(
        "insert into auth.sesion (token_hash, usuario_id, tenant_activo, creada_en, ultimo_uso, expira_absoluta) values ($1, $2, null, now(), now(), now() + interval '1 hour')",
        [sha256(sesion), u.rows[0].id],
      );
      const r = await llamar(app, "select * from auth.invitacion_aceptar_existente($1, $2)", [inv.tokenHash, sha256(sesion)]);
      if (!r.ok) throw new Error(r.code);
      const m = await admin.query("select 1 from membresia where tenant_id = $1 and usuario_id = $2", [x.id, u.rows[0].id]);
      resultados[rol] = r.rows.length + m.rows.length;
    }
    expect(resultados).toEqual({ dueno: 0, admin: 2 });
  });
});

describe("H-005-1b-3 · nombre en invitacion_aceptar_nueva", () => {
  it("vacío, en blanco, con control o de 201 caracteres -> 'invalida' y el token sigue vivo; 200 caracteres -> 'aceptada'", async () => {
    const x = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const casos: Record<string, string> = { vacio: "", blanco: "  ", tab: "Ana\tT15", del: "Ana\u007fT15", largo: "a".repeat(201) };
    const vistos: Record<string, string> = {};
    for (const [k, nombre] of Object.entries(casos)) {
      const inv = await ea.invitacion(x.id, { invitadoPor: d.id, rol: "lectura" });
      const r = await llamar(app, "select auth.invitacion_aceptar_nueva($1, $2, $3) as r", [inv.tokenHash, nombre, hashFalso()]);
      vistos[k] = `${r.ok ? r.rows[0].r : "error"}/${await usuarios(inv.correo)}/${await vigente(inv.tokenHash)}`;
    }
    expect(vistos).toEqual(Object.fromEntries(Object.keys(casos).map((k) => [k, "invalida/0/1"])));

    const inv = await ea.invitacion(x.id, { invitadoPor: d.id, rol: "lectura" });
    const ok = await llamar(app, "select auth.invitacion_aceptar_nueva($1, $2, $3) as r", [inv.tokenHash, "b".repeat(200), hashFalso()]);
    expect(ok).toMatchObject({ ok: true, rows: [{ r: "aceptada" }] });
  });
});

describe("H-005-1b-2 · CHECK invitacion_correo_sin_control", () => {
  it("rechaza BEL, ESC y DEL en el correo (23514) y admite un correo normal", async () => {
    const x = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const ins = (correo: string) =>
      admin
        .query(
          "insert into invitacion (tenant_id, correo, rol, invitado_por, token_hash, vence_en) values ($1, $2, 'lectura', $3, $4, now() + interval '1 hour')",
          [x.id, correo, d.id, nuevoToken()],
        )
        .then(
          () => "ok",
          (e: { code?: string }) => String(e.code),
        );
    const vistos = [];
    for (const ctl of ["\u0007", "\u001b", "\u007f"]) vistos.push(await ins(`t15${ctl}x@t15.contapp.test`));
    expect(vistos).toEqual(["23514", "23514", "23514"]);
    const correo = `t15-${Date.now()}@t15.contapp.test`;
    ea.recordarCorreo(correo);
    expect(await ins(correo)).toBe("ok");
  });
});

describe("revocarPendientesDe (H-005-1b-1, con contapp_backend y RLS)", () => {
  it("revoca solo las pendientes del invitador fuera de los roles que conserva; no toca otras ni otros estudios", async () => {
    const x = await ea.estudio();
    const y = await ea.estudio();
    const d = await ea.miembro(x.id, "dueno");
    const otro = await ea.miembro(x.id, "dueno");
    const dy = await ea.miembro(y.id, "dueno");
    // El mismo usuario es Dueño en y (invitaciones de y no se tocan desde x).
    await admin.query("insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'dueno')", [y.id, d.id]);
    for (const rol of ["dueno", "admin", "lectura"] as const) await ea.invitacion(x.id, { invitadoPor: d.id, rol });
    await ea.invitacion(x.id, { invitadoPor: d.id, rol: "dueno", vencida: true });
    await ea.invitacion(x.id, { invitadoPor: d.id, rol: "dueno", aceptada: true });
    await ea.invitacion(x.id, { invitadoPor: otro.id, rol: "dueno" });
    await ea.invitacion(y.id, { invitadoPor: d.id, rol: "dueno" });
    await ea.invitacion(y.id, { invitadoPor: dy.id, rol: "dueno" });

    const n = await db.withTenant({ tenantId: x.id }, (tx) =>
      revocarPendientesDe(tx, d.id, ["admin", "contador", "asistente", "lectura"]),
    );
    expect(n).toBe(2); // la viva y la vencida de rol dueno
    expect(await pendientes(x.id, d.id)).toEqual(["admin", "lectura"]);
    expect(await pendientes(x.id, otro.id)).toEqual(["dueno"]);
    expect(await pendientes(y.id, d.id)).toEqual(["dueno"]);

    const todas = await db.withTenant({ tenantId: x.id }, (tx) => revocarPendientesDe(tx, d.id, []));
    expect(todas).toBe(2);
    expect(await pendientes(x.id, d.id)).toEqual([]);
    expect(await db.withTenant({ tenantId: x.id }, (tx) => revocarPendientesDe(tx, d.id, []))).toBe(0);
  });
});
