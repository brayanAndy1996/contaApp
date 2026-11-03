/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// 006 T12b · Ronda adversarial 1b del registro (caja blanca). Ataques leídos de 0024_planes_auth.sql,
// registro.service.ts y auth/repositorio.ts. Lo que se escribe en BD por SQL directo va en transacciones con ROLLBACK;
// lo que crea el registro por HTTP lo limpia `abrirBancoPlanes` (correos rastreados) y los contadores de límite que
// usan estas pruebas (IPs y correos propios) se borran en afterAll. Una prueba roja = hallazgo.
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claveCorreo,
  hashViejo,
  ipUnica,
  pausa,
  type Peticion,
} from "../../../test/soporte.js";
import {
  abrirBancoPlanes,
  type BancoPlanes,
} from "../../../test/soporte-planes.js";

const CONTRASENA = "Canario-t12b-registro-Zq9-ñ";
const NOMBRE = "Titular T12b";
let p: BancoPlanes;
const h = () => p.b.h;
const ips: string[] = [];
const correosLimite: string[] = [];

const ip = (): string => {
  const v = ipUnica();
  ips.push(v);
  return v;
};
const sha = (t: string): Buffer =>
  createHash("sha256").update(t, "utf8").digest();
const tokenFalso = (): string => randomBytes(32).toString("base64url");

beforeAll(async () => {
  p = await abrirBancoPlanes();
});
afterAll(async () => {
  const sujetos = [
    ...ips,
    ...correosLimite.map((c) => claveCorreo(c).toString("hex")),
  ];
  await p
    ?.sql(
      "delete from auth.limite_tasa where tipo in ('registro_ip','registro_correo','login_ip') and sujeto = any($1)",
      [sujetos],
    )
    .catch(() => undefined);
  await p?.cerrar();
});

/* ---------------------------------- utilidades ---------------------------------- */
const solicitar = (
  o: { correo: string; estudio?: string; nombre?: string },
  extra: Partial<Peticion> = {},
) => {
  correosLimite.push(o.correo);
  return h().pedir({
    ruta: "/registro",
    cuerpo: {
      estudio: o.estudio ?? `Estudio T12b ${randomBytes(3).toString("hex")}`,
      nombre: o.nombre ?? NOMBRE,
      correo: o.correo,
    },
    ip: ip(),
    ...extra,
  });
};
const confirmar = (token: string, extra: Partial<Peticion> = {}) =>
  h().pedir({
    ruta: "/registro/confirmar",
    cuerpo: { token, contrasena: CONTRASENA },
    ip: ip(),
    ...extra,
  });

async function registrar(o: { correo?: string; estudio?: string } = {}) {
  const correo = o.correo ?? p.correoRegistro();
  const antes = h().correo.para(correo).length;
  const r = await solicitar({ correo, estudio: o.estudio });
  expect(r.status).toBe(202);
  await h().correo.esperar(correo, antes + 1);
  return { correo, token: h().correo.tokenDe(correo) };
}
async function cuentaExistente() {
  const u = await h().crearUsuario({ estudios: [] });
  p.rastrearRegistro(u.correo);
  return u;
}
const entrar = (u: { correo: string; contrasena: string }) =>
  h().entrar(u, { ip: ip() });
const vivos = (correo: string) =>
  p.sql(
    "select id from auth.registro_pendiente where correo = $1 and consumida_en is null and vence_en > now()",
    [correo],
  );
const estudiosDe = (correo: string) =>
  p.sql(
    "select m.tenant_id from membresia m join usuario u on u.id = m.usuario_id where u.email = $1",
    [correo],
  );
const valorCookie = (cookie: string): string =>
  cookie.slice(cookie.indexOf("=") + 1).split(";")[0]!;

const conectar = () => h().dbBackend.pool.connect();
type PoolClient = Awaited<ReturnType<typeof conectar>>;
/** Consulta en una conexión propia; el texto llega por variable, como en soporte-planes.ts. */
const q = (c: PoolClient, texto: string, valores?: unknown[]) =>
  c.query(texto, valores);
/** Conexión propia como contapp_backend con transacción abierta (siempre termina en ROLLBACK). */
async function txBackend(): Promise<PoolClient> {
  const c = await conectar();
  await q(c, "begin");
  await q(c, "set local role contapp_backend");
  return c;
}
async function cerrarTx(c: PoolClient): Promise<void> {
  await q(c, "rollback").catch(() => undefined);
  c.release();
}

const FUNCIONES_006 = [
  "limite_consumir",
  "registro_crear",
  "registro_vigente",
  "registro_confirmar_nueva",
  "registro_confirmar_existente",
  "cupo_usuarios_aceptar",
  "plataforma_yo",
  "plan_listar",
  "plan_crear",
  "plan_editar",
  "estudios_listar",
  "suscripcion_asignar",
];

/* ---------------------------------- ACL y search_path ---------------------------------- */
describe("T12b · ACL y search_path de las funciones y la tabla del registro", () => {
  it("las 12 funciones de 006: SECURITY DEFINER, dueño contapp_auth, search_path fijo con pg_temp al final, EXECUTE solo contapp_backend", async () => {
    const filas = await p.sql(
      `select p.proname, p.prosecdef, pg_get_userbyid(p.proowner) dueno, p.proconfig, p.proacl::text[] acl,
              (select count(*) from pg_proc q join pg_namespace m on m.oid = q.pronamespace
                where m.nspname = 'auth' and q.proname = p.proname)::int sobrecargas
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'auth' and p.proname = any($1)`,
      [FUNCIONES_006],
    );
    expect(filas.map((f: any) => f.proname).sort()).toEqual(
      [...FUNCIONES_006].sort(),
    );
    for (const f of filas) {
      expect({
        fn: f.proname,
        secdef: f.prosecdef,
        dueno: f.dueno,
        sobrecargas: f.sobrecargas,
      }).toEqual({
        fn: f.proname,
        secdef: true,
        dueno: "contapp_auth",
        sobrecargas: 1,
      });
      expect({ fn: f.proname, cfg: f.proconfig }).toEqual({
        fn: f.proname,
        cfg: ["search_path=pg_catalog, pg_temp"],
      });
      const conExecute = (f.acl as string[])
        .map((a) => a.split("=")[0])
        .filter((r) => r !== "contapp_auth")
        .sort();
      expect({ fn: f.proname, execute: conExecute }).toEqual({
        fn: f.proname,
        execute: ["contapp_backend"],
      });
    }
  });

  it("auth.registro_pendiente: RLS ENABLE+FORCE, privilegios solo de contapp_auth; contapp_backend no es miembro de contapp_auth ni la lee", async () => {
    const t = (
      await p.sql(
        `select c.relrowsecurity, c.relforcerowsecurity, c.relacl::text[] acl, pg_get_userbyid(c.relowner) dueno
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'auth' and c.relname = 'registro_pendiente'`,
      )
    )[0];
    expect(t).toMatchObject({
      relrowsecurity: true,
      relforcerowsecurity: true,
      dueno: "contapp_migrator",
    });
    const roles = (t.acl as string[])
      .map((a) => a.split("=")[0])
      .filter((r) => r !== "contapp_migrator");
    expect(roles).toEqual(["contapp_auth"]);
    const miembro = await p.sql(
      "select pg_has_role('contapp_backend', 'contapp_auth', 'MEMBER') m, pg_has_role('contapp_backend', 'contapp_auth', 'USAGE') u",
    );
    expect(miembro[0]).toEqual({ m: false, u: false });
    const c = await txBackend();
    try {
      await expect(
        q(c, "select 1 from auth.registro_pendiente limit 1"),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await cerrarTx(c);
    }
  });

  it("registro_crear no mira `usuario` (mismo trabajo exista o no la cuenta): su cuerpo no referencia usuario ni membresia", async () => {
    const src = (
      await p.sql(
        "select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'auth' and p.proname = 'registro_crear'",
      )
    )[0].prosrc as string;
    expect(src).not.toMatch(/public\.(usuario|membresia)\b/i);
  });
});

/* ---------------------------------- carreras ---------------------------------- */
describe("T12b · carreras del registro", () => {
  it("un enlace invalidado por un registro_crear posterior NO se puede confirmar desde una transacción que empezó antes (vence_en = now())", async () => {
    // registro_crear invalida con `vence_en = now()` (hora de SU transacción); confirmar compara con `now()` de la
    // suya. Si la transacción de confirmar empezó antes, re-evalúa la fila invalidada y la sigue viendo vigente.
    const { correo, token } = await registrar();
    const phc = await hashViejo(CONTRASENA);
    const c = await txBackend();
    try {
      await q(c, "select now()");
      await pausa(30);
      const r = await solicitar({ correo }); // invalida `token` y crea uno nuevo (confirmado en BD)
      expect(r.status).toBe(202);
      expect(
        (
          await p.sql(
            "select 1 from auth.registro_pendiente where token_hash = $1 and vence_en > now()",
            [sha(token)],
          )
        ).length,
      ).toBe(0);
      const vigente = await q(c, "select * from auth.registro_vigente($1)", [
        sha(token),
      ]);
      const res = await q(c, "select auth.registro_confirmar_nueva($1, $2) r", [
        sha(token),
        phc,
      ]);
      expect({ vigente: vigente.rowCount, confirmar: res.rows[0].r }).toEqual({
        vigente: 0,
        confirmar: "invalida",
      });
    } finally {
      await cerrarTx(c);
    }
  });

  it("N confirmaciones simultáneas del mismo enlace: un solo 204 y un solo estudio", async () => {
    const { correo, token } = await registrar();
    const rs = await Promise.all(
      Array.from({ length: 6 }, () => confirmar(token)),
    );
    const estados = rs.map((r) => r.status).sort();
    expect(estados.filter((s) => s === 204)).toHaveLength(1);
    expect(
      rs
        .filter((r) => r.status !== 204)
        .every((r) => r.body?.codigo === "registro_invalido"),
    ).toBe(true);
    expect(await estudiosDe(correo)).toHaveLength(1);
  });

  it("N confirmaciones simultáneas del mismo enlace no calculan N veces Argon2 (enlace de un solo uso = un hash)", async () => {
    // Sin límite por IP en /registro/confirmar y con Argon2 fuera del bloqueo del pendiente: cada petición que pasa
    // `registro_vigente` antes de que la primera consuma calcula un Argon2 completo (amplificación de CPU).
    const { token } = await registrar();
    const antes = h().hasher.calculos;
    const rs = await Promise.all(
      Array.from({ length: 8 }, () => confirmar(token)),
    );
    expect(rs.filter((r) => r.status === 204)).toHaveLength(1);
    expect(h().hasher.calculos - antes).toBeLessThanOrEqual(1);
  });

  it("confirmar y pedir otro registro del mismo correo a la vez: a lo sumo un estudio y a lo sumo un pendiente vivo", async () => {
    for (let i = 0; i < 3; i++) {
      const { correo, token } = await registrar();
      const [rc, rs] = await Promise.all([
        confirmar(token),
        solicitar({ correo }),
      ]);
      expect([204, 400]).toContain(rc.status);
      expect(rs.status).toBe(202);
      expect((await estudiosDe(correo)).length).toBeLessThanOrEqual(1);
      expect((await vivos(correo)).length).toBeLessThanOrEqual(1);
      if (rc.status === 204) {
        expect(
          (
            await p.sql(
              "select consumida_en from auth.registro_pendiente where token_hash = $1",
              [sha(token)],
            )
          )[0].consumida_en,
        ).not.toBeNull();
      }
    }
  });
});

/* ---------------------------------- purga ---------------------------------- */
describe("T12b · purga de pendientes en registro_crear", () => {
  it("la purga borra solo lo vencido hace más de 7 días: ni un pendiente vivo ni uno invalidado hace menos de 7 días", async () => {
    const a = await registrar(); // vivo
    const b = await registrar();
    await solicitar({ correo: b.correo }); // invalida el primero de b (vence_en = now())
    const viejo = await registrar();
    await p.sql(
      "update auth.registro_pendiente set creada_en = now() - interval '9 days', vence_en = now() - interval '8 days' where correo = $1",
      [viejo.correo],
    );
    await registrar(); // dispara la purga
    expect(
      (
        await p.sql(
          "select 1 from auth.registro_pendiente where token_hash = $1",
          [sha(a.token)],
        )
      ).length,
    ).toBe(1);
    expect(
      (
        await p.sql(
          "select 1 from auth.registro_pendiente where token_hash = $1",
          [sha(b.token)],
        )
      ).length,
    ).toBe(1);
    expect(
      (
        await p.sql("select 1 from auth.registro_pendiente where correo = $1", [
          viejo.correo,
        ])
      ).length,
    ).toBe(0);
    expect((await vivos(a.correo)).length).toBe(1);
  });
});

/* ---------------------------------- entradas que la BD rechaza tras pasar la app ---------------------------------- */
describe("T12b · POST /registro con entradas que pasan la app y violan un CHECK de la BD", () => {
  it("estudio de un solo punto de código fuera del BMP (length 2 en UTF-16, char_length 1 en PG): 400 solicitud_invalida, no 500", async () => {
    const correo = p.correoRegistro();
    const r = await solicitar({ correo, estudio: "\u{1F600}" });
    expect(r.status).not.toBe(500);
    expect([202, 400]).toContain(r.status);
  });

  it("nombre del titular con una letra de Unicode 16 (válida para Node, no asignada en el ICU de PG): no 500", async () => {
    const correo = p.correoRegistro();
    const r = await solicitar({ correo, nombre: "\u{10D50}" });
    expect(r.status).not.toBe(500);
    expect([202, 400]).toContain(r.status);
  });

  it("IP de cliente que no es IP y excede 200 caracteres (sujeto de limite_tasa fuera del CHECK): no 500", async () => {
    const correo = p.correoRegistro();
    const larga = `x${"a".repeat(220)}`;
    const r = await solicitar({ correo }, { ip: larga });
    expect(r.status).not.toBe(500);
    expect([202, 400, 429]).toContain(r.status);
  });
});

/* ---------------------------------- límites ---------------------------------- */
describe("T12b · límites de /registro/confirmar", () => {
  it("una misma IP no puede intentar confirmaciones sin límite (12 seguidas con enlace falso y contraseña válida: algún 429)", async () => {
    const mismaIp = ip();
    const estados: number[] = [];
    for (let i = 0; i < 12; i++)
      estados.push((await confirmar(tokenFalso(), { ip: mismaIp })).status);
    expect(estados.every((s) => s === 400 || s === 429)).toBe(true);
    expect(estados).toContain(429);
  });
});

/* ---------------------------------- confirmar-con-sesion ---------------------------------- */
describe("T12b · POST /registro/confirmar-con-sesion", () => {
  it("con la sesión revocada: 401, sin estudio y el enlace sigue vivo; la función SQL tampoco acepta el hash revocado", async () => {
    const u = await cuentaExistente();
    const estudio = `Estudio revocada ${randomBytes(3).toString("hex")}`;
    const { token } = await registrar({ correo: u.correo, estudio });
    const s = await entrar(u);
    const hashSesion = sha(valorCookie(s.cookie));
    await p.sql(
      "update auth.sesion set revocada_en = now() where token_hash = $1",
      [hashSesion],
    );
    const r = await p.como(s, "POST", "/registro/confirmar-con-sesion", {
      token,
    });
    expect(r.status).toBe(401);
    expect(await estudiosDe(u.correo)).toHaveLength(0);
    expect((await vivos(u.correo)).length).toBe(1);
    const c = await txBackend();
    try {
      const f = await q(
        c,
        "select * from auth.registro_confirmar_existente($1, $2)",
        [sha(token), hashSesion],
      );
      expect(f.rowCount).toBe(0);
    } finally {
      await cerrarTx(c);
    }
  });

  it("X-Estudio distinto del de la sesión: rechazado sin crear estudio ni consumir el enlace", async () => {
    const u = await cuentaExistente();
    const { token } = await registrar({ correo: u.correo });
    const s = await entrar(u);
    const r = await p.como(
      s,
      "POST",
      "/registro/confirmar-con-sesion",
      { token },
      { estudio: crypto.randomUUID() },
    );
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(await estudiosDe(u.correo)).toHaveLength(0);
    expect((await vivos(u.correo)).length).toBe(1);
  });
});

/* ---------------------------------- plataforma (precios) ---------------------------------- */
describe("T12b · plan_crear revalida los precios en la BD", () => {
  it("precio 'NaN' (pasa `<> round(…, 2)` y el CHECK >= 0 de PG): rechazado, no se guarda un plan con precio NaN", async () => {
    const adm = await p.superAdmin();
    const hashSesion = sha(valorCookie(adm.cookie));
    const c = await txBackend();
    try {
      const codigo = `t3_t12b_${randomBytes(3).toString("hex")}`;
      let guardado: unknown = null;
      try {
        const r = await q(
          c,
          "select precio_mensual from auth.plan_crear($1, $2, 'NaN T12b', 'NaN'::numeric, null, 5, 1, 0, 0, 1440, '{}'::jsonb, false)",
          [hashSesion, codigo],
        );
        guardado = r.rows[0]?.precio_mensual ?? null;
      } catch {
        guardado = null;
      }
      expect(guardado).toBeNull();
    } finally {
      await cerrarTx(c);
    }
  });
});
