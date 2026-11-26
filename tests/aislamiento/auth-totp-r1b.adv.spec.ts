// Spec 029 · T13 · Ronda adversarial 1b (caja blanca: BD y secretos). Ataques contra 0078/0079, el repositorio de `@contapp/db`, el
// cifrado (D1) y el CLI del operador (U5). Se conecta con los roles reales (`SET LOCAL ROLE contapp_*`), nunca como superusuario salvo para
// sembrar, bloquear filas o leer el "volcado". Los secretos, codigos y claves son sinteticos y se generan en cada corrida.
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthRepoError, crearTotpRepo } from "@contapp/db";
import { EscenarioTotp, PASO, SQL, abrirAdmin, abrirApp, diez, exito, hash32, llamar, nuevoToken, tenantDe } from "./auth-totp-soporte";
import { hashFalso } from "./auth-soporte";
import { cifrarSecreto, descifrarSecreto, type ClaveTotp } from "../../apps/backend/src/modules/auth/totp/cifrado";
import { generarCodigosRecuperacion, hashCodigoRecuperacion } from "../../apps/backend/src/modules/auth/totp/recuperacion";
import { codificarBase32, generarSecretoTotp } from "../../apps/backend/src/modules/auth/totp/rfc6238";

let app: Pool;
let admin: Pool;
let esc: EscenarioTotp;
beforeAll(() => {
  app = abrirApp(30);
  admin = abrirAdmin(6);
  esc = new EscenarioTotp(admin);
});
afterAll(async () => {
  await esc?.limpiar();
  await app?.end();
  await admin?.end();
});
const A = () => tenantDe("A");
const clave = (version: number): ClaveTotp => ({ version, clave: randomBytes(32) });
const ROLES_APP = ["contapp_backend", "contapp_worker", "contapp_platform", "contapp_app"] as const;
const TABLAS = ["totp", "totp_recuperacion", "cuenta_evento"] as const;

async function esperarBloqueo(patron: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const r = await admin.query(
      "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query like $1",
      [`%${patron}%`],
    );
    if (r.rows[0].n > 0) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("la sentencia no llego a esperar el bloqueo");
}

describe("T13 · lectura y volcado de secretos (CA-6, CA-7)", () => {
  it("ningun rol de la app lee, copia ni ve estadisticas de auth.totp, totp_recuperacion ni cuenta_evento", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    await esc.totpActivo(u.id);
    await esc.codigos(u.id);
    await admin.query("analyze auth.totp, auth.totp_recuperacion, auth.cuenta_evento");
    const salida: Record<string, string> = {};
    for (const rol of ROLES_APP) {
      for (const t of TABLAS) {
        const sel = await llamar(app, `select * from auth.${t}`, [], rol);
        const copia = await llamar(app, `copy auth.${t} to stdout`, [], rol);
        salida[`${rol}.${t}`] = `${sel.ok ? "ok" : sel.code}/${copia.ok ? "ok" : copia.code}`;
      }
      const est = await llamar(
        app,
        "select count(*)::int as n from pg_stats where schemaname = 'auth' and tablename = any($1::text[])",
        [TABLAS],
        rol,
      );
      // 0 filas visibles o sin permiso sobre pg_stats: ambas son "sin datos".
      salida[`${rol}.pg_stats`] = (est.ok && est.rows[0].n === 0) || (!est.ok && est.code === "42501") ? "sin datos" : "visible";
    }
    const esperado: Record<string, string> = {};
    for (const rol of ROLES_APP) {
      for (const t of TABLAS) esperado[`${rol}.${t}`] = "42501/42501";
      esperado[`${rol}.pg_stats`] = "sin datos";
    }
    expect(salida).toEqual(esperado);
  });

  it("un volcado completo de las filas no contiene el secreto ni permite probar codigos de recuperacion sin TOTP_CLAVE (D1)", async () => {
    const k = clave(1);
    const u = await esc.usuario({ estudios: [A()] });
    const secreto = generarSecretoTotp();
    const { cifrado, version } = cifrarSecreto({ secreto, usuarioId: u.id, clave: k });
    await exito(llamar(app, SQL.enrolarIniciar, [u.id, cifrado, version]));
    const s = await esc.sesionF(u.id, { factor: "sin_factor", tenant: A() });
    const codigos = generarCodigosRecuperacion();
    const hashes = codigos.map((c) => hashCodigoRecuperacion(c, k));
    expect(await exito(llamar(app, SQL.confirmar, [s.token, String(PASO), hashes, nuevoToken()]))).toHaveLength(1);

    const filas = [
      ...(await admin.query("select * from auth.totp where usuario_id = $1", [u.id])).rows,
      ...(await admin.query("select * from auth.totp_recuperacion where usuario_id = $1", [u.id])).rows,
      ...(await admin.query("select * from auth.cuenta_evento where usuario_id = $1", [u.id])).rows,
    ];
    const volcado = JSON.stringify(filas, (_k, v) => (v && v.type === "Buffer" ? Buffer.from(v.data).toString("hex") : v)).toLowerCase();
    expect(volcado).not.toContain(secreto.toString("hex"));
    expect(volcado).not.toContain(codificarBase32(secreto).toLowerCase());
    for (const c of codigos) {
      const sinGuion = c.replace(/-/g, "");
      expect(volcado).not.toContain(c.toLowerCase());
      expect(volcado).not.toContain(sinGuion.toLowerCase());
      expect(volcado).not.toContain(createHash("sha256").update(c).digest("hex"));
      expect(volcado).not.toContain(createHash("sha256").update(sinGuion).digest("hex"));
      // HMAC con la clave cruda (sin HKDF) ni con otra clave tampoco reproduce el hash guardado.
      expect(volcado).not.toContain(createHmac("sha256", k.clave).update(c).digest("hex"));
      expect(volcado).not.toContain(hashCodigoRecuperacion(c, clave(1)).toString("hex"));
      expect(volcado).toContain(hashCodigoRecuperacion(c, k).toString("hex"));
    }
    const leido = (await admin.query("select activo_cifrado from auth.totp where usuario_id = $1", [u.id])).rows[0].activo_cifrado as Buffer;
    expect(() => descifrarSecreto({ cifrado: leido, version: 1, usuarioId: u.id, claves: [clave(1)] })).toThrow();
    expect(descifrarSecreto({ cifrado: leido, version: 1, usuarioId: u.id, claves: [k] }).equals(secreto)).toBe(true);
  });

  it("AAD cruzada: el cifrado de A copiado a la fila de B no se descifra como secreto de B", async () => {
    const k = clave(3);
    const a = await esc.usuario({ estudios: [A()] });
    const b = await esc.usuario({ estudios: [A()] });
    const secretoA = generarSecretoTotp();
    const { cifrado } = cifrarSecreto({ secreto: secretoA, usuarioId: a.id, clave: k });
    await esc.totpActivo(b.id);
    await admin.query("update auth.totp set activo_cifrado = $2, activo_version = 3 where usuario_id = $1", [b.id, cifrado]);
    const filaB = (await exito(llamar(app, SQL.leer, [b.id])))[0];
    expect(() =>
      descifrarSecreto({ cifrado: filaB.activo_cifrado, version: filaB.activo_version, usuarioId: b.id, claves: [k] }),
    ).toThrow();
    expect(descifrarSecreto({ cifrado: filaB.activo_cifrado, version: 3, usuarioId: a.id, claves: [k] }).equals(secretoA)).toBe(true);
  });

  it("rotacion: lo cifrado/hasheado con TOTP_CLAVE_ANTERIOR solo abre con esa version; cambiar la version en la fila no lo abre", async () => {
    const vieja = clave(1);
    const nueva = clave(2);
    const u = await esc.usuario({ estudios: [A()] });
    const secreto = generarSecretoTotp();
    const { cifrado } = cifrarSecreto({ secreto, usuarioId: u.id, clave: vieja });
    await esc.totpActivo(u.id);
    await admin.query("update auth.totp set activo_cifrado = $2, activo_version = 1 where usuario_id = $1", [u.id, cifrado]);
    const fila = (await exito(llamar(app, SQL.leer, [u.id])))[0];
    expect(descifrarSecreto({ cifrado: fila.activo_cifrado, version: 1, usuarioId: u.id, claves: [nueva, vieja] }).equals(secreto)).toBe(true);
    expect(() => descifrarSecreto({ cifrado: fila.activo_cifrado, version: 1, usuarioId: u.id, claves: [nueva] })).toThrow();
    expect(() => descifrarSecreto({ cifrado: fila.activo_cifrado, version: 2, usuarioId: u.id, claves: [nueva, vieja] })).toThrow();
    // Codigo de recuperacion emitido con la clave vieja: el hash con la nueva no lo gasta; el de la vieja si, una sola vez.
    const [codigo] = generarCodigosRecuperacion();
    await admin.query("insert into auth.totp_recuperacion (usuario_id, hash) values ($1, $2)", [u.id, hashCodigoRecuperacion(codigo!, vieja)]);
    const p = await esc.sesionF(u.id, { factor: "pendiente", expiraEn: "5 minutes" });
    const conNueva = await exito(llamar(app, SQL.recuperacionUsar, [p.token, hashCodigoRecuperacion(codigo!, nueva), nuevoToken(), null]));
    expect(conNueva).toHaveLength(0);
    const conVieja = await exito(llamar(app, SQL.recuperacionUsar, [p.token, hashCodigoRecuperacion(codigo!, vieja), nuevoToken(), null]));
    expect(conVieja).toHaveLength(1);
  });

  it("los errores del repositorio no llevan el cifrado ni los hashes (canarios en errores de pg)", async () => {
    const otro = await esc.usuario({ estudios: [A()] });
    const [repetido] = await esc.codigos(otro.id, 1);
    const u = await esc.usuario({ estudios: [A()] });
    await esc.totpPendiente(u.id);
    const s = await esc.sesionF(u.id, { factor: "sin_factor" });
    const canario = Buffer.concat([Buffer.from("CANARIO-T13-"), randomBytes(300)]);
    const hashes = [repetido!, ...Array.from({ length: 9 }, hash32)];
    const errores: unknown[] = [];
    for (const accion of [
      (r: ReturnType<typeof crearTotpRepo>) => r.enrolarIniciar(u.id, canario, 1),
      (r: ReturnType<typeof crearTotpRepo>) => r.confirmar({ tokenHash: s.token, paso: PASO, hashes, tokenHashNuevo: nuevoToken() }),
    ]) {
      const c: PoolClient = await app.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL ROLE contapp_backend");
        await accion(crearTotpRepo(c as never));
        errores.push("sin error");
      } catch (e) {
        errores.push(e);
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
    }
    expect(errores.map((e) => (e instanceof AuthRepoError ? e.codigo : String(e)))).toEqual(["22023", "23505"]);
    const texto = errores
      .map((e) => [String(e), (e as Error).stack, JSON.stringify(e), JSON.stringify(Object.getOwnPropertyDescriptors(e))].join("\n"))
      .join("\n")
      .toLowerCase();
    expect(texto).not.toContain("canario");
    expect(texto).not.toContain(canario.subarray(12, 40).toString("hex"));
    expect(texto).not.toContain(repetido!.toString("hex"));
    expect(texto).not.toContain(repetido!.toString("base64").toLowerCase());
  });
});

describe("T13 · funciones SECURITY DEFINER (CA-7)", () => {
  const NUEVAS = [
    "intento_acierto",
    "sesion_revocar_id",
    "sesiones_listar",
    "sesiones_revocar_otras",
    "totp_confirmar",
    "totp_desactivar",
    "totp_enrolar_iniciar",
    "totp_intento_reservar",
    "totp_leer",
    "totp_recuperacion_regenerar",
    "totp_recuperacion_usar",
    "totp_restablecer",
    "totp_verificar_exito",
    "login_exito",
    "sesion_validar",
    "sesion_consultar",
    "sesion_rotar",
    "contrasena_cambiar",
  ];

  it("una firma por nombre, definer de contapp_auth con search_path fijo, sin EXECUTE para PUBLIC ni otros roles; auth sin CREATE", async () => {
    const r = await admin.query(
      `select p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as dueno,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       where a.grantee = 0 and a.privilege_type = 'EXECUTE') as publico,
              has_function_privilege('contapp_backend', p.oid, 'EXECUTE') as backend,
              has_function_privilege('contapp_worker', p.oid, 'EXECUTE') as worker,
              has_function_privilege('contapp_platform', p.oid, 'EXECUTE') as platform,
              has_function_privilege('contapp_app', p.oid, 'EXECUTE') as app
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'auth' and p.proname = any($1::text[]) order by p.proname`,
      [NUEVAS],
    );
    const real = r.rows.map((f) => ({ ...f, proconfig: f.proconfig }));
    const esperado = [...NUEVAS].sort().map((proname) => ({
      proname,
      prosecdef: true,
      proconfig: ["search_path=pg_catalog, pg_temp"],
      dueno: "contapp_auth",
      publico: false,
      backend: proname !== "totp_restablecer",
      worker: false,
      platform: false,
      app: false,
    }));
    expect(real).toEqual(esperado);
    const crear = await admin.query(
      `select r as rol, has_schema_privilege(r, 'auth', 'CREATE') as crea
         from unnest(array['contapp_backend','contapp_worker','contapp_platform','contapp_app']) r`,
    );
    expect(crear.rows.filter((f) => f.crea)).toEqual([]);
  });

  it("auth.cuenta_evento es de solo agregar: ni contapp_auth la edita/borra/trunca, ni el backend la borra en cascada", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    await admin.query("insert into auth.cuenta_evento (usuario_id, tipo) values ($1, 'totp_activado')", [u.id]);
    const upd = await llamar(admin, "update auth.cuenta_evento set tipo = 'totp_desactivado' where usuario_id = $1", [u.id], "contapp_auth");
    const del = await llamar(admin, "delete from auth.cuenta_evento where usuario_id = $1", [u.id], "contapp_auth");
    const tru = await llamar(admin, "truncate auth.cuenta_evento", [], "contapp_auth");
    await llamar(app, "delete from usuario where id = $1", [u.id], "contapp_backend");
    expect([upd, del, tru].map((x) => (x.ok ? "ok" : x.code))).toEqual(["42501", "42501", "42501"]);
    expect(await esc.eventos(u.id)).toEqual(["totp_activado"]);
  });

  it("D3: 8 verificaciones y 2 regeneraciones concurrentes con el MISMO paso consumen el paso una sola vez", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    await esc.totpActivo(u.id, { ultimoPaso: 0n });
    await esc.codigos(u.id);
    const pend = await Promise.all(Array.from({ length: 8 }, () => esc.sesionF(u.id, { factor: "pendiente", expiraEn: "5 minutes" })));
    const ver = await Promise.all(Array.from({ length: 2 }, () => esc.sesionF(u.id, { factor: "verificado" })));
    const r = await Promise.all([
      ...pend.map((p) => llamar(app, SQL.verificarExito, [p.token, String(PASO), nuevoToken(), A()])),
      ...ver.map((v) => llamar(app, SQL.regenerar, [v.token, String(PASO), diez()])),
    ]);
    const exitos = r.filter((x) => x.ok && (x.rows[0]?.sesion_id !== undefined || x.rows[0]?.r === true));
    expect(r.filter((x) => !x.ok)).toEqual([]);
    expect(exitos).toHaveLength(1);
    expect(BigInt((await esc.filaTotp(u.id))!.ultimo_paso)).toBe(PASO);
  });
});

describe("T13 · sesiones vivas tras activar, restablecer o recuperar (U3, U5, CA-4, CA-9)", () => {
  it("CA-1: con TOTP ya activo, totp_confirmar no reemplaza el secreto activo sin un codigo del vigente (re-enrolar)", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const activo = await esc.totpActivo(u.id, { ultimoPaso: 0n });
    const s = await esc.sesionF(u.id, { factor: "verificado", tenant: A() });
    // El backend (o una inyeccion con su rol) deja un pendiente aunque haya activo: la BD lo acepta.
    await exito(llamar(app, SQL.enrolarIniciar, [u.id, randomBytes(48), 1]));
    const r = await exito(llamar(app, SQL.confirmar, [s.token, String(PASO), diez(), nuevoToken()]));
    expect(r).toHaveLength(0);
    expect(((await esc.filaTotp(u.id))!.activo_cifrado as Buffer).equals(activo)).toBe(true);
  });

  it("U3: un login con contrasena concurrente con la activacion no deja una sesion `sin_factor` viva con el TOTP ya activo", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    await esc.totpPendiente(u.id);
    const s1 = await esc.sesionF(u.id, { factor: "sin_factor", tenant: A() });
    await esc.sembrarFallos(u.correo, 0);
    const k = esc.clave(u.correo);
    const tokenLogin = nuevoToken();
    const x = await admin.connect();
    try {
      await x.query("BEGIN");
      await x.query("select 1 from auth.intento_login where clave = $1 for update", [k]);
      // login_exito ya evaluo "sin TOTP activo" y espera la fila del contador para reiniciarlo.
      const login = llamar(app, SQL.loginExito7, [k, u.id, u.hash, tokenLogin, A(), null, null]);
      await esperarBloqueo("auth.login_exito");
      const conf = await exito(llamar(app, SQL.confirmar, [s1.token, String(PASO), diez(), nuevoToken()]));
      expect(conf).toHaveLength(1);
      await x.query("COMMIT");
      await login;
    } finally {
      await x.query("ROLLBACK").catch(() => undefined);
      x.release();
    }
    expect((await esc.filaTotp(u.id))!.activo_cifrado).not.toBeNull();
    const vivas = (await esc.sesionesDe(u.id)).filter((f) => f.revocada_en === null && f.factor === "sin_factor");
    expect(vivas.map((f) => ({ factor: f.factor, tenant: f.tenant_activo }))).toEqual([]);
  });

  it("U5: totp_restablecer (operador) revoca TODAS las sesiones vivas del usuario (pendiente, verificado, sin_factor) y nada ajeno", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    await esc.totpActivo(u.id);
    await esc.totpPendiente(u.id, { conActivo: true });
    await esc.codigos(u.id);
    const ses = [
      await esc.sesionF(u.id, { factor: "pendiente", expiraEn: "5 minutes" }),
      await esc.sesionF(u.id, { factor: "verificado", tenant: A() }),
      await esc.sesionF(u.id, { factor: "sin_factor", tenant: A() }),
    ];
    const b = await esc.usuario({ estudios: [A()] });
    await esc.totpActivo(b.id);
    const sb = await esc.sesionF(b.id, { factor: "verificado", tenant: A() });

    const desdeBackend = await llamar(app, SQL.restablecer, [u.correo], "contapp_backend");
    expect(desdeBackend.ok ? "ok" : desdeBackend.code).toBe("42501");
    expect(await exito(llamar(admin, SQL.restablecer, [u.correo], "contapp_migrator"))).toHaveLength(1);

    for (const s of ses) expect(await exito(llamar(app, SQL.validar, [s.token]))).toHaveLength(0);
    expect((await esc.sesionesDe(u.id)).filter((f) => f.revocada_en === null)).toEqual([]);
    expect(await esc.filaTotp(u.id)).toBeUndefined();
    expect(await esc.filasCodigos(u.id)).toEqual([]);
    expect(await esc.eventos(u.id)).toEqual(["totp_restablecido"]);
    expect(await exito(llamar(app, SQL.validar, [sb.token]))).toHaveLength(1);
    expect(await esc.filaTotp(b.id)).toBeDefined();
    expect(await exito(llamar(admin, SQL.restablecer, [u.correo], "contapp_migrator"))).toHaveLength(0);
  });

  it("CA-4: restablecer la contrasena con sesiones vivas las revoca, conserva TOTP y codigos y el siguiente login nace `pendiente`", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const activo = await esc.totpActivo(u.id);
    await esc.codigos(u.id);
    const v = await esc.sesionF(u.id, { factor: "verificado", tenant: A() });
    const t = await esc.tokenRecuperacion(u.id);
    const nuevo = hashFalso();
    expect(await exito(llamar(app, "select * from auth.recuperacion_consumir($1::bytea, $2::text)", [t, nuevo]))).toHaveLength(1);
    expect(await exito(llamar(app, SQL.validar, [v.token]))).toHaveLength(0);
    expect(((await esc.filaTotp(u.id))!.activo_cifrado as Buffer).equals(activo)).toBe(true);
    expect((await esc.filasCodigos(u.id)).filter((c) => c.usado_en === null)).toHaveLength(10);
    const tok = nuevoToken();
    await exito(llamar(app, SQL.loginExito7, [esc.clave(u.correo), u.id, nuevo, tok, A(), null, null]));
    expect((await exito(llamar(app, SQL.validar, [tok])))[0]?.factor).toBe("pendiente");
  });

  it("CA-3/CA-4: restablecer la contrasena no levanta el bloqueo de 15 min que dejaron 5 codigos TOTP erroneos", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    await esc.totpActivo(u.id);
    const p = await esc.sesionF(u.id, { factor: "pendiente", expiraEn: "5 minutes" });
    for (let i = 0; i < 5; i++) await exito(llamar(app, SQL.reservar, [p.token])); // 5 codigos erroneos: bloqueo
    expect(await esc.intentos(u.correo)).toEqual({ fallos: 5, bloqueado: true });
    const t = await esc.tokenRecuperacion(u.id);
    const nuevo = hashFalso();
    await exito(llamar(app, "select * from auth.recuperacion_consumir($1::bytea, $2::text)", [t, nuevo]));
    // Con el correo en su poder, el atacante fija otra contrasena, entra a `pendiente` y vuelve a probar codigos.
    const tok = nuevoToken();
    await exito(llamar(app, SQL.loginExito7, [esc.clave(u.correo), u.id, nuevo, tok, null, null, null]));
    const r = await exito(llamar(app, SQL.reservar, [tok]));
    expect(r[0]?.permitido ?? false).toBe(false);
  });

  it("una sesion `pendiente` no sirve para las funciones heredadas: cerrar todas ni identificarse como admin de plataforma", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    await esc.adminPlataforma(u.id);
    await esc.totpActivo(u.id);
    const v = await esc.sesionF(u.id, { factor: "verificado" });
    const p = await esc.sesionF(u.id, { factor: "pendiente", expiraEn: "5 minutes" });
    const yo = await exito(llamar(app, "select * from auth.plataforma_yo($1::bytea)", [p.token]));
    const cerradas = await exito(llamar(app, "select auth.sesiones_cerrar_todas($1::bytea) as n", [p.token]));
    const vViva = (await exito(llamar(app, SQL.validar, [v.token]))).length === 1;
    expect({ plataformaYo: yo.length, cerradas: Number(cerradas[0].n), verificadoViva: vViva }).toEqual({
      plataformaYo: 0,
      cerradas: 0,
      verificadoViva: true,
    });
  });

  it("0079: intento_acierto sin una reserva previa no descuenta fallos ajenos ni levanta un bloqueo", async () => {
    const u = await esc.usuario({ estudios: [A()] });
    const s = await esc.sesionF(u.id, { factor: "sin_factor", tenant: A() });
    // 5 contrasenas erroneas de un atacante: cuenta bloqueada 15 min.
    await esc.sembrarFallos(u.correo, 5);
    await admin.query("update auth.intento_login set bloqueado_hasta = now() + interval '15 minutes' where clave = $1", [esc.clave(u.correo)]);
    for (let i = 0; i < 5; i++) await exito(llamar(app, "select auth.intento_acierto($1::bytea)", [s.token]));
    expect(await esc.intentos(u.correo)).toEqual({ fallos: 5, bloqueado: true });
  });
});
