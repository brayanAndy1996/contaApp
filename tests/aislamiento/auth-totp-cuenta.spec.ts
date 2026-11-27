// Spec 029 (T1, rojo hasta 0078) · CA-4, CA-6, CA-9: desactivar (regla de exigencia en SQL con la MISMA tabla CASOS_FACTOR_EXIGIDO que el TS),
// regenerar codigos de recuperacion y restablecer del operador. Contrato en `auth-totp-soporte.ts`.
// Rojo por: auth.totp_* aun no existe (42883) / falta auth.sesion.factor.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CASOS_FACTOR_EXIGIDO } from "../../packages/shared/src/auth/factor-exigido.casos";
import {
  EscenarioTotp,
  ROLES_CON_FACTOR_EXIGIDO,
  ROLES_SIN_FACTOR_EXIGIDO,
  SQL,
  abrirAdmin,
  abrirApp,
  diez,
  exito,
  llamar,
  nuevoToken,
  tenantDe,
} from "./auth-totp-soporte";

let app: Pool;
let admin: Pool;
let esc: EscenarioTotp;
beforeAll(() => {
  app = abrirApp(10);
  admin = abrirAdmin(4);
  esc = new EscenarioTotp(admin);
});
afterAll(async () => {
  await esc?.limpiar();
  await app?.end();
  await admin?.end();
});
const A = () => tenantDe("A");

const desactivar = async (t: Buffer, paso: bigint) => (await exito(llamar(app, SQL.desactivar, [t, String(paso)])))[0].r as string;
const regenerar = async (t: Buffer, paso: bigint, hs: Buffer[]) => (await exito(llamar(app, SQL.regenerar, [t, String(paso), hs])))[0].r as boolean;

/** Usuario con TOTP activo, 10 codigos y una sesion `verificado`; con la membresia / rol de plataforma que pida el caso. */
async function cuenta(o: { rol?: string | null; plataforma?: boolean; ultimoPaso?: bigint; membresiaDesactivada?: boolean } = {}) {
  const u = o.rol ? await esc.usuarioConRol(o.rol, { desactivada: o.membresiaDesactivada }) : await esc.usuario({ estudios: [] });
  if (o.plataforma) await esc.adminPlataforma(u.id);
  await esc.totpActivo(u.id, { ultimoPaso: o.ultimoPaso ?? 0n });
  const codigos = await esc.codigos(u.id, 10);
  const s = await esc.sesionF(u.id, { factor: "verificado", tenant: o.rol ? A() : null });
  const otra = await esc.sesionF(u.id, { factor: "verificado" });
  return { u, s, otra, codigos };
}

describe("auth.totp_desactivar · regla de exigencia (CA-4) con CASOS_FACTOR_EXIGIDO", () => {
  // La BD solo tiene los 5 roles de sistema (005) y admin_plataforma: un caso con rol propio (rolSistema null y sin plataforma) no se puede
  // sembrar en SQL y lo cubre `factorExigido` en TS (seguridad.spec.ts). Aqui se ejercen todos los demas.
  const representables = CASOS_FACTOR_EXIGIDO.filter((c) => c.plataforma || c.rolSistema !== null);

  it("la tabla comun cubre en SQL al menos super-admin, Dueño, Administrador, Contador, Asistente y Lectura", () => {
    expect(representables.length).toBeGreaterThanOrEqual(8);
    expect(new Set(representables.map((c) => c.rolSistema))).toEqual(new Set(["lectura", "dueno", "admin", "contador", "asistente", null]));
  });

  it.each(representables.map((c) => [c.nombre, c] as const))("%s", async (_n, caso) => {
    const c = await cuenta({ rol: caso.rolSistema, plataforma: caso.plataforma });
    const r = await desactivar(c.s.token, 1n);
    expect(r).toBe(caso.exigido ? "exigido" : "desactivado");
    const fila = await esc.filaTotp(c.u.id);
    if (caso.exigido) {
      // sin NINGUN efecto: el secreto, los codigos, las otras sesiones y el paso quedan como estaban
      expect(fila!.activo_cifrado).not.toBeNull();
      expect(String(fila!.ultimo_paso)).toBe("0");
      expect(await esc.filasCodigos(c.u.id)).toHaveLength(10);
      expect((await esc.filaSesion(c.otra.token))!.revocada_en).toBeNull();
      expect(await esc.eventos(c.u.id)).toEqual([]);
    } else {
      expect(fila).toBeUndefined();
      expect(await esc.filasCodigos(c.u.id)).toHaveLength(0);
      expect(await esc.eventos(c.u.id)).toEqual(["totp_desactivado"]);
    }
  });

  it("la tabla local de roles de membresia (U1) coincide con la comun", () => {
    for (const r of ROLES_CON_FACTOR_EXIGIDO) expect(CASOS_FACTOR_EXIGIDO.find((c) => c.rolSistema === r && !c.plataforma)?.exigido, r).toBe(true);
    for (const r of ROLES_SIN_FACTOR_EXIGIDO) expect(CASOS_FACTOR_EXIGIDO.find((c) => c.rolSistema === r && !c.plataforma)?.exigido, r).toBe(false);
  });

  it("la regla mira TODAS las membresias vigentes: un Asistente en un estudio y Administrador en otro sigue exigido", async () => {
    const c = await cuenta({ rol: "asistente" });
    await admin.query("insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'admin')", [tenantDe("B"), c.u.id]);
    expect(await desactivar(c.s.token, 1n)).toBe("exigido");
  });

  it("una membresia DESACTIVADA de Administrador ya no exige (no hay acceso por ella)", async () => {
    const c = await cuenta({ rol: "admin", membresiaDesactivada: true });
    expect(await desactivar(c.s.token, 1n)).toBe("desactivado");
  });
});

describe("auth.totp_desactivar · efectos y rechazos", () => {
  it("desactiva: borra TOTP y codigos, deja el evento y revoca las demas sesiones (motivo totp) pero no la actual ni las ajenas", async () => {
    const c = await cuenta({ rol: "lectura" });
    const ajena = await esc.sesionF((await esc.usuario({ estudios: [A()] })).id);
    expect(await desactivar(c.s.token, 1n)).toBe("desactivado");
    expect(await esc.filaSesion(c.otra.token)).toMatchObject({ motivo: "totp" });
    expect((await esc.filaSesion(c.s.token))!.revocada_en).toBeNull();
    expect((await esc.filaSesion(ajena.token))!.revocada_en).toBeNull();
  });

  it("D3: un paso <= ultimo_paso (replay del codigo) es `invalido` y no desactiva", async () => {
    const c = await cuenta({ rol: "lectura", ultimoPaso: 40n });
    expect(await desactivar(c.s.token, 40n)).toBe("invalido");
    expect(await desactivar(c.s.token, 39n)).toBe("invalido");
    expect((await esc.filaTotp(c.u.id))!.activo_cifrado).not.toBeNull();
    expect(await desactivar(c.s.token, 41n)).toBe("desactivado");
  });

  it("solo una sesion `verificado` vigente desactiva: `sin_factor`, `pendiente`, revocada o inexistente dan `invalido`", async () => {
    const c = await cuenta({ rol: "lectura" });
    for (const factor of ["sin_factor", "pendiente"] as const) {
      const s = await esc.sesionF(c.u.id, { factor, expiraEn: "5 minutes" });
      expect(await desactivar(s.token, 2n), factor).toBe("invalido");
    }
    expect(await desactivar(nuevoToken(), 2n)).toBe("invalido");
    await admin.query("update auth.sesion set revocada_en = now() where id = $1", [c.s.id]);
    expect(await desactivar(c.s.token, 2n)).toBe("invalido");
    expect((await esc.filaTotp(c.u.id))!.activo_cifrado).not.toBeNull();
  });

  it("sin TOTP activo: `invalido`", async () => {
    const u = await esc.usuario({ estudios: [] });
    const s = await esc.sesionF(u.id, { factor: "verificado" });
    expect(await desactivar(s.token, 1n)).toBe("invalido");
  });
});

describe("auth.totp_recuperacion_regenerar (U4, CA-9)", () => {
  it("regenerar invalida TODOS los anteriores (usados o no), guarda 10 nuevos, deja el evento y consume el paso", async () => {
    const c = await cuenta({ rol: "dueno", ultimoPaso: 5n });
    await admin.query("update auth.totp_recuperacion set usado_en = now() where id = (select id from auth.totp_recuperacion where usuario_id = $1 limit 1)", [c.u.id]);
    const nuevos = diez();
    expect(await regenerar(c.s.token, 6n, nuevos)).toBe(true);
    const filas = await esc.filasCodigos(c.u.id);
    expect(filas).toHaveLength(10);
    expect(filas.every((f) => f.usado_en === null)).toBe(true);
    const hex = filas.map((f) => f.hash.toString("hex")).sort();
    expect(hex).toEqual(nuevos.map((h) => h.toString("hex")).sort());
    expect(await esc.eventos(c.u.id)).toEqual(["recuperacion_regenerada"]);
    expect(String((await esc.filaTotp(c.u.id))!.ultimo_paso)).toBe("6");
  });

  it("un codigo anterior ya no sirve para iniciar sesion (totp_recuperacion_usar da cero filas)", async () => {
    const c = await cuenta({ rol: "dueno" });
    await regenerar(c.s.token, 1n, diez());
    const p = await esc.sesionF(c.u.id, { factor: "pendiente", expiraEn: "5 minutes" });
    const r = await exito(llamar(app, SQL.recuperacionUsar, [p.token, c.codigos[0], nuevoToken(), A()]));
    expect(r).toHaveLength(0);
  });

  it("replay del paso, 9 o 11 hashes, sesion no `verificado` o sin TOTP: false (o 22023) y nada cambia", async () => {
    const c = await cuenta({ rol: "dueno", ultimoPaso: 20n });
    expect(await regenerar(c.s.token, 20n, diez())).toBe(false);
    const r9 = await llamar(app, SQL.regenerar, [c.s.token, "21", diez().slice(0, 9)]);
    expect(r9.ok ? "ok" : r9.code).toBe("22023");
    const sf = await esc.sesionF(c.u.id, { factor: "sin_factor" });
    expect(await regenerar(sf.token, 21n, diez())).toBe(false);
    const filas = await esc.filasCodigos(c.u.id);
    expect(filas.map((f) => f.hash.toString("hex")).sort()).toEqual(c.codigos.map((h) => h.toString("hex")).sort());
    const sinTotp = await esc.usuario({ estudios: [] });
    const s2 = await esc.sesionF(sinTotp.id, { factor: "verificado" });
    expect(await regenerar(s2.token, 1n, diez())).toBe(false);
  });
});

describe("auth.totp_restablecer (U5, CA-9): solo el operador (contapp_migrator)", () => {
  const restablecer = (correo: string) => llamar(admin, SQL.restablecer, [correo], "contapp_migrator");

  it("borra TOTP y codigos, revoca TODAS las sesiones (motivo totp, tambien la `pendiente`), deja el evento y devuelve usuario, correo y nombre", async () => {
    const c = await cuenta({ rol: "dueno" });
    const pend = await esc.sesionF(c.u.id, { factor: "pendiente", expiraEn: "5 minutes" });
    const r = await exito(restablecer(c.u.correo));
    expect(r).toEqual([{ usuario_id: c.u.id, correo: c.u.correo, nombre: "Usuario T5" }]);
    expect(await esc.filaTotp(c.u.id)).toBeUndefined();
    expect(await esc.filasCodigos(c.u.id)).toHaveLength(0);
    expect(await esc.eventos(c.u.id)).toEqual(["totp_restablecido"]);
    for (const s of [c.s, c.otra, pend]) {
      const f = await esc.filaSesion(s.token);
      expect(f!.revocada_en, "sesion revocada").toBeInstanceOf(Date);
      expect(f!.motivo).toBe("totp");
    }
  });

  it("no toca a otros usuarios ni la contrasena del usuario", async () => {
    const c = await cuenta({ rol: "dueno" });
    const otro = await cuenta({ rol: "dueno" });
    const hashAntes = (await admin.query("select hash from auth.usuario_contrasena where usuario_id = $1", [c.u.id])).rows[0].hash;
    await exito(restablecer(c.u.correo));
    expect(await esc.filaTotp(otro.u.id)).toBeDefined();
    expect(await esc.filasCodigos(otro.u.id)).toHaveLength(10);
    expect((await esc.filaSesion(otro.s.token))!.revocada_en).toBeNull();
    expect((await admin.query("select hash from auth.usuario_contrasena where usuario_id = $1", [c.u.id])).rows[0].hash).toBe(hashAntes);
  });

  it("correo inexistente o usuario sin TOTP: cero filas y no deja evento ni revoca sesiones", async () => {
    expect(await exito(restablecer(esc.correoNuevo()))).toHaveLength(0);
    const u = await esc.usuario({ estudios: [A()] });
    const s = await esc.sesionF(u.id);
    expect(await exito(restablecer(u.correo))).toHaveLength(0);
    expect(await esc.eventos(u.id)).toEqual([]);
    expect((await esc.filaSesion(s.token))!.revocada_en).toBeNull();
  });

  it("es idempotente: la segunda vez no encuentra TOTP y no duplica el evento", async () => {
    const c = await cuenta({ rol: "dueno" });
    expect(await exito(restablecer(c.u.correo))).toHaveLength(1);
    expect(await exito(restablecer(c.u.correo))).toHaveLength(0);
    expect(await esc.eventos(c.u.id)).toEqual(["totp_restablecido"]);
  });

  it.each(["contapp_backend", "contapp_worker", "contapp_platform", "contapp_app"])("%s no puede ejecutarla (42501)", async (rol) => {
    const r = await llamar(admin, SQL.restablecer, [esc.correoNuevo()], rol);
    expect(r.ok ? "ok" : r.code).toBe("42501");
  });
});

describe("CA-7: contapp_backend ejecuta las funciones nuevas, y la salida de una funcion fallida no filtra datos (CA-6)", () => {
  it("una llamada con argumentos invalidos da un error sin el contenido del cifrado ni de los hashes", async () => {
    const u = await esc.usuario({ estudios: [] });
    const canario = Buffer.from("CANARIO-SECRETO-029-xyz");
    const s = await esc.sesionF(u.id, { factor: "verificado" });
    const r = await llamar(app, SQL.confirmar, [s.token, "1", [canario], nuevoToken()]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).not.toContain("CANARIO");
      expect(r.message).not.toContain(canario.toString("hex"));
    }
  });
});
