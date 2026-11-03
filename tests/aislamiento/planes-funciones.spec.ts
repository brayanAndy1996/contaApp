// Spec 006 (T1, rojo): comportamiento de las 11 funciones `auth.*` nuevas (registro publico, cupo de aceptacion y plataforma),
// de `auth.limite_consumir` con los tipos de registro y de las reglas CA-1, CA-2, CA-3, CA-4, CA-6, CA-7 en la BD.
// Cada prueba crea sus planes, estudios, cuentas y pendientes (EscenarioPlanes) y los borra al final; ninguna toca el seed
// (el unico cambio sobre un plan sembrado es dejar `prueba` inactivo un instante, con restauracion en finally y en afterAll).
//
// Contrato que fija (T5, migracion NNNN+2_planes_auth.sql). Todas: SECURITY DEFINER, dueño contapp_auth, EXECUTE solo
// contapp_backend. "Rechazar" = lanzar un error de PG o devolver cero filas / 'invalida' / false (la prueba admite
// cualquiera), SIN efectos. Argumentos posicionales, en este orden:
//   auth.registro_crear(correo text, estudio text, ruc text|null, nombre text, token_hash bytea) -> escalar no nulo, el MISMO
//       valor exista o no la cuenta; una fila pendiente nueva; invalida las anteriores del mismo correo; borra los pendientes
//       con vence_en de hace mas de 7 dias (D3).
//   auth.registro_vigente(token_hash bytea) -> (nombre_estudio, correo, cuenta_existe) o cero filas si esta vencido, consumido,
//       invalidado o no existe; sin efectos.
//   auth.registro_confirmar_nueva(token_hash bytea, hash text) -> text 'creado' | 'cuenta_existe' | 'invalida' | 'sin_plan'.
//       En 'creado' (una transaccion): tenant (nombre, ruc_estudio), usuario (correo, nombre del pendiente), credencial `hash`,
//       membresia `dueno`, suscripcion al plan activo `prueba` en estado 'prueba' con prueba_vence_en = now() + 14 dias; el
//       pendiente queda consumido. Bloquea el pendiente FOR UPDATE: N confirmaciones simultaneas -> un solo 'creado'.
//   auth.registro_confirmar_existente(token_hash bytea, token_hash_sesion bytea) -> (tenant_id, estudio_nombre) o cero filas.
//       Correo EXACTO de la sesion viva; crea estudio + membresia `dueno` + suscripcion 'prueba' sin tocar la contraseña.
//   auth.cupo_usuarios_aceptar(tenant_id uuid) -> boolean: activos + 1 <= max_usuarios (NULL = true); sin suscripcion -> false o error.
//   Plataforma (primer argumento p_token_hash bytea = sesion viva; el alta en admin_plataforma se revalida en CADA llamada):
//   auth.plataforma_yo(token) -> (usuario_id) una fila si es admin, cero filas si no.
//   auth.plan_listar(token) -> filas con TODAS las columnas de `plan` (incluye precios e inactivos).
//   auth.plan_crear(token, codigo, nombre, precio_mensual numeric, precio_anual numeric|null, max_rucs int, max_usuarios int|null,
//       precio_ruc_extra numeric, max_rucs_extra int, frecuencia_buzon_min int, features jsonb, activo boolean) -> la fila de plan.
//   auth.plan_editar(token, plan_id uuid, <los mismos 11 campos que plan_crear, desde codigo>) -> la fila de plan (reemplazo completo).
//   auth.estudios_listar(token) -> (id, nombre, plan_codigo, plan_nombre, estado) y NADA mas (D13, sin precios ni RUCs).
//   auth.suscripcion_asignar(token, tenant_id uuid, plan_id uuid, rucs_extra int) -> (tenant_id, plan_id, plan_codigo, plan_nombre,
//       estado, rucs_extra_contratados). Rechaza plan inactivo, plan o estudio inexistente y extra negativo o sobre el max_rucs_extra
//       del plan nuevo. Las que escriben solo tocan `plan` y `suscripcion`.
//   auth.limite_consumir('registro_ip' | 'registro_correo' | 'registro_confirmar_ip', sujeto) -> boolean: 5, 3 y 10 por hora.
//   Ajuste de 006 (T13a, D14/D15): `suscripcion_asignar` sobre un estudio SIN suscripcion ya no se rechaza, la crea (`activa`);
//   `registro_confirmar_existente` agrega `con_prueba`; `limite_consumir` admite `registro_confirmar_ip` (10 por hora). Lo nuevo
//   de D14, D15 y de la ronda adversarial esta en `planes-ronda1.spec.ts`.
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirAdmin,
  abrirApp,
  hashFalso,
  llamar,
  nuevoToken,
  type Llamada,
} from "./auth-soporte";
import { EscenarioPlanes, tokenHashNuevo } from "./planes-soporte";
import { tenantDe } from "./soporte";

let app: Pool;
let admin: Pool;
let ep: EscenarioPlanes;

beforeAll(() => {
  app = abrirApp(30);
  admin = abrirAdmin(6);
  ep = new EscenarioPlanes(admin);
});
afterAll(async () => {
  // Por si una prueba fallo con `prueba` inactivo: el seed debe quedar activo.
  await admin
    ?.query("update plan set activo = true where codigo = 'prueba'")
    .catch(() => undefined);
  await ep?.limpiar();
  await app?.end();
  await admin?.end();
});

const adm = async (sql: string, v: unknown[] = []) =>
  (await admin.query(sql, v)).rows;
// Un rechazo valido es un error de la funcion o una respuesta vacia/false/'invalida'. Un error por funcion o tabla
// inexistente (42883, 42P01, 42703, 3F000) NO es un rechazo: asi las pruebas negativas tambien fallan en rojo.
const FALTA_ESQUEMA = ["42883", "42P01", "42703", "3F000"];
const rechazada = (r: Llamada): boolean => {
  if (!r.ok && FALTA_ESQUEMA.includes(r.code))
    throw new Error(`falta el esquema o la funcion (SQLSTATE ${r.code})`);
  return (
    !r.ok ||
    r.rows.length === 0 ||
    r.rows[0]?.v === false ||
    r.rows[0]?.v === "invalida"
  );
};
const exitosa = (r: Llamada) => {
  if (!r.ok)
    throw new Error(`la funcion fallo (SQLSTATE ${r.code}): ${r.message}`);
  return r.rows;
};
const valor = async (p: Promise<Llamada>): Promise<unknown> => {
  const r = await p;
  if (!r.ok) throw new Error(`la funcion fallo (SQLSTATE ${r.code})`);
  return r.rows[0]?.v;
};
const A = () => tenantDe("A");
const B = () => tenantDe("B");

// --- envolturas SQL (fijan el contrato de nombres, tipos y orden) -----------------------------------
const SQL = {
  crear:
    "select auth.registro_crear($1::text, $2::text, $3::text, $4::text, $5::bytea) as v",
  vigente:
    "select nombre_estudio, correo, cuenta_existe from auth.registro_vigente($1::bytea)",
  nueva: "select auth.registro_confirmar_nueva($1::bytea, $2::text) as v",
  existente:
    "select tenant_id, estudio_nombre from auth.registro_confirmar_existente($1::bytea, $2::bytea)",
  cupo: "select auth.cupo_usuarios_aceptar($1::uuid) as v",
  yo: "select usuario_id from auth.plataforma_yo($1::bytea)",
  listar: "select * from auth.plan_listar($1::bytea)",
  planCrear:
    "select * from auth.plan_crear($1::bytea, $2::text, $3::text, $4::numeric, $5::numeric, $6::int, $7::int, $8::numeric, $9::int, $10::int, $11::jsonb, $12::boolean)",
  planEditar:
    "select * from auth.plan_editar($1::bytea, $2::uuid, $3::text, $4::text, $5::numeric, $6::numeric, $7::int, $8::int, $9::numeric, $10::int, $11::int, $12::jsonb, $13::boolean)",
  estudios: "select * from auth.estudios_listar($1::bytea)",
  asignar:
    "select * from auth.suscripcion_asignar($1::bytea, $2::uuid, $3::uuid, $4::int)",
  limite: "select auth.limite_consumir($1::text, $2::text) as v",
};

interface Solicitud {
  correo: string;
  estudio: string;
  ruc: string | null;
  nombre: string;
  hash: Buffer;
}
/** Pide un registro; `correo` por omision uno nuevo (sin cuenta). */
async function pedir(
  o: Partial<Solicitud> = {},
): Promise<Solicitud & { r: Llamada }> {
  const s: Solicitud = {
    correo: o.correo ?? ep.correoRegistro(),
    estudio: o.estudio ?? ep.nombreEstudio(),
    ruc: o.ruc === undefined ? "20100070970" : o.ruc,
    nombre: o.nombre ?? "Dueña de Prueba",
    hash: o.hash ?? tokenHashNuevo(),
  };
  const r = await llamar(app, SQL.crear, [
    s.correo,
    s.estudio,
    s.ruc,
    s.nombre,
    s.hash,
  ]);
  return { ...s, r };
}
const vigente = (h: Buffer) => llamar(app, SQL.vigente, [h]);
const confirmarNueva = (h: Buffer, contrasena: string = hashFalso()) =>
  llamar(app, SQL.nueva, [h, contrasena]);
const confirmarExistente = (h: Buffer, sesion: Buffer) =>
  llamar(app, SQL.existente, [h, sesion]);
const pendientes = (correo: string) =>
  adm(
    `select token_hash, nombre_estudio, ruc_estudio, nombre_usuario, creada_en, vence_en, consumida_en
       from auth.registro_pendiente where correo = $1 order by creada_en, id`,
    [correo],
  );
const alterar = (h: Buffer): Buffer => {
  const b = Buffer.from(h);
  b[31] = b[31]! ^ 0x01;
  return b;
};
const dosFilasIguales = (r1: Llamada, r2: Llamada) => {
  expect(exitosa(r1)).toEqual(exitosa(r2));
};

// =================================================================================================
describe("auth.registro_crear (CA-3, CA-4, D3)", () => {
  it("con cuenta existente y sin ella devuelve exactamente lo mismo (una fila, un escalar no nulo) y deja un pendiente en ambos casos", async () => {
    const cuenta = await ep.cuentaRegistro();
    const nuevo = await pedir();
    const existente = await pedir({ correo: cuenta.correo });
    dosFilasIguales(nuevo.r, existente.r);
    const filas = exitosa(nuevo.r);
    expect(filas).toHaveLength(1);
    expect(filas[0].v).not.toBeNull();
    for (const s of [nuevo, existente]) {
      const p = await pendientes(s.correo);
      expect(p, s.correo).toHaveLength(1);
      expect(p[0]).toMatchObject({
        nombre_estudio: s.estudio,
        ruc_estudio: "20100070970",
        nombre_usuario: "Dueña de Prueba",
        consumida_en: null,
      });
      expect(Buffer.compare(p[0].token_hash, s.hash)).toBe(0);
      expect(p[0].vence_en.getTime() - p[0].creada_en.getTime()).toBe(
        24 * 3600 * 1000,
      ); // el enlace vence a las 24 h
    }
  });

  it("pedir el registro no crea ni toca estudios, usuarios ni credenciales (solo el pendiente)", async () => {
    const cuenta = await ep.cuentaRegistro();
    const antes = await adm(
      "select (select count(*) from tenant)::int t, (select count(*) from usuario)::int u, (select count(*) from membresia)::int m, (select count(*) from suscripcion)::int s",
    );
    await pedir();
    await pedir({ correo: cuenta.correo });
    expect(
      await adm(
        "select (select count(*) from tenant)::int t, (select count(*) from usuario)::int u, (select count(*) from membresia)::int m, (select count(*) from suscripcion)::int s",
      ),
    ).toEqual(antes);
  });

  it("el RUC del estudio es opcional: sin RUC guarda NULL", async () => {
    const s = await pedir({ ruc: null });
    exitosa(s.r);
    expect((await pendientes(s.correo))[0].ruc_estudio).toBeNull();
  });

  it("una segunda solicitud del mismo correo invalida la anterior: su token ya no es vigente ni se confirma; el nuevo si", async () => {
    const correo = ep.correoRegistro();
    const primero = await pedir({ correo });
    const segundo = await pedir({ correo });
    exitosa(primero.r);
    exitosa(segundo.r);
    expect(rechazada(await vigente(primero.hash))).toBe(true);
    expect(await valor(confirmarNueva(primero.hash))).toBe("invalida");
    expect(await ep.estudiosPorNombre(primero.estudio)).toHaveLength(0);
    const vivos = await adm(
      "select count(*)::int as n from auth.registro_pendiente where correo = $1 and consumida_en is null and vence_en > now()",
      [correo],
    );
    expect(vivos[0].n).toBe(1);
    expect(exitosa(await vigente(segundo.hash))[0]).toMatchObject({
      correo,
      nombre_estudio: segundo.estudio,
    });
  });

  it("borra los pendientes vencidos hace mas de 7 dias y conserva los vencidos mas recientes y los vigentes (sin depender de 008)", async () => {
    const insertar = async (correo: string, creada: string, vence: string) => {
      const h = tokenHashNuevo();
      await adm(
        `insert into auth.registro_pendiente (correo, nombre_estudio, nombre_usuario, token_hash, creada_en, vence_en)
         values ($1, 'Estudio viejo', 'Persona', $2, now() - $3::interval, now() - $4::interval)`,
        [correo, h, creada, vence],
      );
      return h;
    };
    const viejo = await insertar(ep.correoRegistro(), "9 days", "8 days");
    const limite = await insertar(
      ep.correoRegistro(),
      "10 days",
      "7 days 1 hour",
    );
    const reciente = await insertar(ep.correoRegistro(), "3 days", "2 days");
    const vivo = await pedir();
    exitosa((await pedir()).r); // dispara la purga
    const existe = async (h: Buffer) =>
      (
        await adm(
          "select 1 from auth.registro_pendiente where token_hash = $1",
          [h],
        )
      ).length === 1;
    expect(await existe(viejo), "vencido hace 8 dias").toBe(false);
    expect(await existe(limite), "vencido hace mas de 7 dias").toBe(false);
    expect(await existe(reciente), "vencido hace 2 dias").toBe(true);
    expect(await existe(vivo.hash), "vigente").toBe(true);
  });

  it("el token solo se guarda como hash: la tabla no tiene columna con el token en claro (el valor recibido ES el hash)", async () => {
    const s = await pedir();
    const [p] = await pendientes(s.correo);
    expect((p.token_hash as Buffer).length).toBe(32);
    expect(Object.keys(p).filter((k) => /token/.test(k))).toEqual([
      "token_hash",
    ]);
  });
});

// =================================================================================================
describe("auth.registro_vigente (CA-3, CA-4: sin efectos, misma respuesta para todo lo no valido)", () => {
  it("un pendiente vigente de un correo sin cuenta devuelve estudio, correo y cuenta_existe = false", async () => {
    const s = await pedir();
    expect(exitosa(await vigente(s.hash))).toEqual([
      { nombre_estudio: s.estudio, correo: s.correo, cuenta_existe: false },
    ]);
  });

  it("si el correo ya tiene cuenta, cuenta_existe = true (tambien si la cuenta se creo despues de pedir el registro)", async () => {
    const cuenta = await ep.cuentaRegistro();
    const s = await pedir({ correo: cuenta.correo });
    expect(exitosa(await vigente(s.hash))[0].cuenta_existe).toBe(true);
    const tardia = await pedir();
    expect(exitosa(await vigente(tardia.hash))[0].cuenta_existe).toBe(false);
    await adm(
      "insert into usuario (email, nombre) values ($1, 'Cuenta tardia')",
      [tardia.correo],
    );
    expect(exitosa(await vigente(tardia.hash))[0].cuenta_existe).toBe(true);
  });

  it("consultar no consume: se puede consultar varias veces y la fila sigue sin consumir", async () => {
    const s = await pedir();
    for (let i = 0; i < 3; i++)
      expect(exitosa(await vigente(s.hash))).toHaveLength(1);
    const [p] = await pendientes(s.correo);
    expect(p.consumida_en).toBeNull();
    expect(await pendientes(s.correo)).toHaveLength(1);
  });

  it.each([
    [
      "vencido",
      (h: Buffer) =>
        adm(
          "update auth.registro_pendiente set vence_en = now() - interval '1 second' where token_hash = $1",
          [h],
        ),
    ],
    [
      "consumido",
      (h: Buffer) =>
        adm(
          "update auth.registro_pendiente set consumida_en = now() where token_hash = $1",
          [h],
        ),
    ],
  ])("un token %s da cero filas", async (_n, estropear) => {
    const s = await pedir();
    await estropear(s.hash);
    expect(rechazada(await vigente(s.hash))).toBe(true);
  });

  it("un token alterado, desconocido o de longitud incorrecta da cero filas (o error), nunca datos de otro pendiente", async () => {
    const s = await pedir();
    expect(rechazada(await vigente(alterar(s.hash)))).toBe(true);
    expect(rechazada(await vigente(tokenHashNuevo()))).toBe(true);
    expect(rechazada(await vigente(Buffer.alloc(31, 1)))).toBe(true);
    expect(rechazada(await vigente(Buffer.alloc(0)))).toBe(true);
  });
});

// =================================================================================================
describe("auth.registro_confirmar_nueva (CA-3: una transaccion, un solo uso, 14 dias de prueba)", () => {
  const SEGUNDOS_14_DIAS = 14 * 24 * 3600;

  it("crea estudio, usuario, credencial, membresia Dueño y suscripcion al plan Prueba a 14 dias, y consume el pendiente", async () => {
    const s = await pedir();
    const hash = hashFalso();
    expect(await valor(confirmarNueva(s.hash, hash))).toBe("creado");
    const [x] = await adm(
      "select id, nombre, ruc_estudio from tenant where nombre = $1",
      [s.estudio],
    );
    expect(x).toMatchObject({ nombre: s.estudio, ruc_estudio: "20100070970" });
    ep.ea.estudios.push(x.id);
    const [u] = await adm("select id, nombre from usuario where email = $1", [
      s.correo,
    ]);
    expect(u.nombre).toBe("Dueña de Prueba");
    expect(
      (
        await adm(
          "select hash from auth.usuario_contrasena where usuario_id = $1",
          [u.id],
        )
      )[0].hash,
    ).toBe(hash);
    expect(
      await adm(
        "select rol, desactivada_en from membresia where tenant_id = $1",
        [x.id],
      ),
    ).toEqual([{ rol: "dueno", desactivada_en: null }]);
    expect(
      await adm("select usuario_id from membresia where tenant_id = $1", [
        x.id,
      ]),
    ).toEqual([{ usuario_id: u.id }]);
    const [sus] = await adm(
      `select p.codigo, p.max_rucs, s.estado, s.rucs_extra_contratados, extract(epoch from (s.prueba_vence_en - now()))::float8 as segundos
         from suscripcion s join plan p on p.id = s.plan_id where s.tenant_id = $1`,
      [x.id],
    );
    expect(sus).toMatchObject({
      codigo: "prueba",
      max_rucs: 5,
      estado: "prueba",
      rucs_extra_contratados: 0,
    });
    expect(sus.segundos).toBeGreaterThan(SEGUNDOS_14_DIAS - 120);
    expect(sus.segundos).toBeLessThanOrEqual(SEGUNDOS_14_DIAS);
    expect((await pendientes(s.correo))[0].consumida_en).toBeInstanceOf(Date);
  });

  it("sin RUC del estudio crea el estudio con ruc_estudio NULL", async () => {
    const s = await pedir({ ruc: null });
    expect(await valor(confirmarNueva(s.hash))).toBe("creado");
    const ids = await ep.estudiosPorNombre(s.estudio);
    expect(ids).toHaveLength(1);
    expect(
      (await adm("select ruc_estudio from tenant where id = $1", [ids[0]]))[0]
        .ruc_estudio,
    ).toBeNull();
  });

  it("segundo uso del mismo token: 'invalida', un solo estudio y la credencial no cambia", async () => {
    const s = await pedir();
    expect(await valor(confirmarNueva(s.hash))).toBe("creado");
    const [u] = await adm("select id from usuario where email = $1", [
      s.correo,
    ]);
    const antes = (
      await adm(
        "select hash from auth.usuario_contrasena where usuario_id = $1",
        [u.id],
      )
    )[0].hash;
    expect(await valor(confirmarNueva(s.hash, hashFalso()))).toBe("invalida");
    expect(await ep.estudiosPorNombre(s.estudio)).toHaveLength(1);
    expect(
      (
        await adm(
          "select hash from auth.usuario_contrasena where usuario_id = $1",
          [u.id],
        )
      )[0].hash,
    ).toBe(antes);
  });

  it.each([
    [
      "vencido",
      (s: Solicitud) =>
        adm(
          "update auth.registro_pendiente set vence_en = now() - interval '1 second' where token_hash = $1",
          [s.hash],
        ),
    ],
    [
      "consumido",
      (s: Solicitud) =>
        adm(
          "update auth.registro_pendiente set consumida_en = now() where token_hash = $1",
          [s.hash],
        ),
    ],
  ])("un enlace %s da 'invalida' y no crea nada", async (_n, estropear) => {
    const s = await pedir();
    await estropear(s);
    expect(await valor(confirmarNueva(s.hash))).toBe("invalida");
    expect(await ep.estudiosPorNombre(s.estudio)).toHaveLength(0);
    expect(
      await adm("select 1 from usuario where email = $1", [s.correo]),
    ).toHaveLength(0);
  });

  it("un token alterado, desconocido o ajeno da 'invalida' (la misma respuesta que los demas casos) y no crea nada", async () => {
    const s = await pedir();
    for (const h of [
      alterar(s.hash),
      tokenHashNuevo(),
      Buffer.alloc(31, 1),
      Buffer.alloc(0),
    ]) {
      expect(rechazada(await confirmarNueva(h)), `token de ${h.length} B`).toBe(
        true,
      );
    }
    expect(await valor(confirmarNueva(tokenHashNuevo()))).toBe("invalida");
    expect(await ep.estudiosPorNombre(s.estudio)).toHaveLength(0);
    expect(exitosa(await vigente(s.hash))).toHaveLength(1); // el pendiente verdadero sigue intacto
  });

  it("si el correo ya tiene cuenta: 'cuenta_existe', sin consumir, sin tocar su contraseña y sin crear estudio", async () => {
    const cuenta = await ep.cuentaRegistro();
    const s = await pedir({ correo: cuenta.correo });
    expect(await valor(confirmarNueva(s.hash, hashFalso()))).toBe(
      "cuenta_existe",
    );
    expect(
      (
        await adm(
          "select hash from auth.usuario_contrasena where usuario_id = $1",
          [cuenta.id],
        )
      )[0].hash,
    ).toBe(cuenta.hash);
    expect(await ep.estudiosPorNombre(s.estudio)).toHaveLength(0);
    expect((await pendientes(s.correo))[0].consumida_en).toBeNull();
    expect(exitosa(await vigente(s.hash))).toHaveLength(1);
    expect(
      await adm("select 1 from membresia where usuario_id = $1", [cuenta.id]),
    ).toHaveLength(0);
  });

  it("es todo o nada: una contraseña que no es hash argon2id no deja usuario, estudio ni pendiente consumido, y el enlace sigue sirviendo", async () => {
    const s = await pedir();
    const r = await confirmarNueva(s.hash, "no-es-un-hash-argon2id");
    expect(r.ok && r.rows[0].v === "creado").toBe(false);
    expect(await ep.estudiosPorNombre(s.estudio)).toHaveLength(0);
    expect(
      await adm("select 1 from usuario where email = $1", [s.correo]),
    ).toHaveLength(0);
    expect((await pendientes(s.correo))[0].consumida_en).toBeNull();
    expect(await valor(confirmarNueva(s.hash))).toBe("creado");
  });

  it("sin plan Prueba activo: 'sin_plan', sin crear nada ni consumir el enlace; al reactivar el plan el mismo enlace funciona", async () => {
    const s = await pedir();
    await adm("update plan set activo = false where codigo = 'prueba'");
    try {
      expect(await valor(confirmarNueva(s.hash))).toBe("sin_plan");
      expect(await ep.estudiosPorNombre(s.estudio)).toHaveLength(0);
      expect(
        await adm("select 1 from usuario where email = $1", [s.correo]),
      ).toHaveLength(0);
      expect((await pendientes(s.correo))[0].consumida_en).toBeNull();
    } finally {
      await adm("update plan set activo = true where codigo = 'prueba'");
    }
    expect(await valor(confirmarNueva(s.hash))).toBe("creado");
  });

  it("el plan de la suscripcion sale de la BD: si Prueba cambia de limites, el estudio nuevo hereda el plan editado (CA-2)", async () => {
    const [orig] = await adm(
      "select max_rucs, max_rucs_extra from plan where codigo = 'prueba'",
    );
    await adm("update plan set max_rucs = 7 where codigo = 'prueba'");
    try {
      const s = await pedir();
      expect(await valor(confirmarNueva(s.hash))).toBe("creado");
      const [x] = await ep.estudiosPorNombre(s.estudio);
      expect(
        (
          await adm(
            "select p.max_rucs from suscripcion s join plan p on p.id = s.plan_id where s.tenant_id = $1",
            [x],
          )
        )[0].max_rucs,
      ).toBe(7);
    } finally {
      await adm(
        "update plan set max_rucs = $1, max_rucs_extra = $2 where codigo = 'prueba'",
        [orig.max_rucs, orig.max_rucs_extra],
      );
    }
  });

  it("cinco confirmaciones simultaneas del mismo enlace crean un solo estudio, un usuario, una membresia y una suscripcion", async () => {
    const s = await pedir();
    const r = await Promise.all(
      Array.from({ length: 5 }, () => confirmarNueva(s.hash)),
    );
    for (const q of r)
      expect(
        q.ok,
        "ninguna debe fallar con un error de PG (23505, 40P01...)",
      ).toBe(true);
    const valores = r.map((q) => (q.ok ? q.rows[0].v : null));
    expect(valores.filter((v) => v === "creado")).toHaveLength(1);
    expect(valores.filter((v) => v === "invalida")).toHaveLength(4);
    const ids = await ep.estudiosPorNombre(s.estudio);
    expect(ids).toHaveLength(1);
    expect(
      await adm("select 1 from usuario where email = $1", [s.correo]),
    ).toHaveLength(1);
    expect(
      await adm("select 1 from membresia where tenant_id = $1", [ids[0]]),
    ).toHaveLength(1);
    expect(
      await adm("select 1 from suscripcion where tenant_id = $1", [ids[0]]),
    ).toHaveLength(1);
  });

  it("dos enlaces distintos de correos distintos pueden confirmarse a la vez: dos estudios independientes", async () => {
    const [a, b] = [await pedir(), await pedir()];
    const r = await Promise.all([
      confirmarNueva(a.hash),
      confirmarNueva(b.hash),
    ]);
    expect(r.map((q) => (q.ok ? q.rows[0].v : null))).toEqual([
      "creado",
      "creado",
    ]);
    expect(
      (await ep.estudiosPorNombre(a.estudio)).concat(
        await ep.estudiosPorNombre(b.estudio),
      ),
    ).toHaveLength(2);
  });
});

// =================================================================================================
describe("auth.registro_confirmar_existente (D3: crea el estudio para la cuenta de la sesion, sin tocar su contraseña)", () => {
  async function escenario() {
    const cuenta = await ep.cuentaRegistro();
    const sesion = await ep.ea.esc.sesion(cuenta.id, null);
    const s = await pedir({ correo: cuenta.correo });
    return { cuenta, sesion, s };
  }

  it("con la sesion viva del titular y el correo exacto crea estudio, membresia Dueño y suscripcion Prueba a 14 dias", async () => {
    const { cuenta, sesion, s } = await escenario();
    const otra = await ep.ea.estudio();
    await ep.ea.membresia(otra.id, cuenta.id, "contador"); // ya era miembro de otro estudio
    const [antes] = await adm(
      "select nombre, email, updated_at from usuario where id = $1",
      [cuenta.id],
    );
    const filas = exitosa(await confirmarExistente(s.hash, sesion));
    expect(filas).toHaveLength(1);
    expect(filas[0].estudio_nombre).toBe(s.estudio);
    ep.ea.estudios.push(filas[0].tenant_id);
    expect(
      await adm(
        "select rol, desactivada_en from membresia where tenant_id = $1 and usuario_id = $2",
        [filas[0].tenant_id, cuenta.id],
      ),
    ).toEqual([{ rol: "dueno", desactivada_en: null }]);
    expect(
      (
        await adm(
          "select rol from membresia where tenant_id = $1 and usuario_id = $2",
          [otra.id, cuenta.id],
        )
      )[0].rol,
    ).toBe("contador");
    const [sus] = await adm(
      `select p.codigo, s.estado, extract(epoch from (s.prueba_vence_en - now()))::float8 as segundos
         from suscripcion s join plan p on p.id = s.plan_id where s.tenant_id = $1`,
      [filas[0].tenant_id],
    );
    expect(sus).toMatchObject({ codigo: "prueba", estado: "prueba" });
    expect(sus.segundos).toBeGreaterThan(14 * 24 * 3600 - 120);
    expect(
      (
        await adm(
          "select hash from auth.usuario_contrasena where usuario_id = $1",
          [cuenta.id],
        )
      )[0].hash,
    ).toBe(cuenta.hash);
    expect(
      (
        await adm(
          "select nombre, email, updated_at from usuario where id = $1",
          [cuenta.id],
        )
      )[0],
    ).toEqual(antes);
    expect((await pendientes(s.correo))[0].consumida_en).toBeInstanceOf(Date);
  });

  it("otra cuenta (correo distinto) con SU sesion viva no puede usar el enlace: cero filas, sin estudio y el pendiente intacto", async () => {
    const { s } = await escenario();
    const intruso = await ep.ea.cuenta();
    const sesionIntruso = await ep.ea.esc.sesion(intruso.id, null);
    expect(rechazada(await confirmarExistente(s.hash, sesionIntruso))).toBe(
      true,
    );
    expect(await ep.estudiosPorNombre(s.estudio)).toHaveLength(0);
    expect((await pendientes(s.correo))[0].consumida_en).toBeNull();
    expect(
      await adm("select 1 from membresia where usuario_id = $1", [intruso.id]),
    ).toHaveLength(0);
  });

  it("un pendiente de un correo sin cuenta no se confirma con la sesion de otra cuenta", async () => {
    const intruso = await ep.ea.cuenta();
    const sesion = await ep.ea.esc.sesion(intruso.id, null);
    const s = await pedir();
    expect(rechazada(await confirmarExistente(s.hash, sesion))).toBe(true);
    expect(await ep.estudiosPorNombre(s.estudio)).toHaveLength(0);
  });

  it("el correo debe ser EXACTAMENTE el del pendiente: un comodin LIKE o una variante no sirve", async () => {
    const u = await ep.ea.cuenta();
    const sesion = await ep.ea.esc.sesion(u.id, null);
    const comodin = `${u.correo.slice(0, 3)}%${u.correo.slice(u.correo.indexOf("@"))}`;
    const s = await pedir({ correo: comodin });
    try {
      expect(rechazada(await confirmarExistente(s.hash, sesion))).toBe(true);
      expect(await ep.estudiosPorNombre(s.estudio)).toHaveLength(0);
    } finally {
      // Ajuste de 006: el correo comodin no pasa por ep.correoRegistro(), asi que limpiar() no borraba su pendiente.
      await adm("delete from auth.registro_pendiente where correo = $1", [comodin]);
    }
  });

  it.each([
    [
      "sesion revocada",
      (e: Awaited<ReturnType<typeof escenario>>) =>
        adm(
          "update auth.sesion set revocada_en = now(), motivo = 'logout' where token_hash = $1",
          [e.sesion],
        ),
    ],
    [
      "sesion con mas de 12 h",
      (e: Awaited<ReturnType<typeof escenario>>) =>
        adm(
          "update auth.sesion set expira_absoluta = now() - interval '1 second' where token_hash = $1",
          [e.sesion],
        ),
    ],
    [
      "sesion inactiva mas de 2 h",
      (e: Awaited<ReturnType<typeof escenario>>) =>
        adm(
          "update auth.sesion set ultimo_uso = now() - interval '121 minutes' where token_hash = $1",
          [e.sesion],
        ),
    ],
    [
      "enlace vencido",
      (e: Awaited<ReturnType<typeof escenario>>) =>
        adm(
          "update auth.registro_pendiente set vence_en = now() - interval '1 second' where token_hash = $1",
          [e.s.hash],
        ),
    ],
    [
      "enlace ya consumido",
      (e: Awaited<ReturnType<typeof escenario>>) =>
        adm(
          "update auth.registro_pendiente set consumida_en = now() where token_hash = $1",
          [e.s.hash],
        ),
    ],
  ])("%s: cero filas y sin efectos", async (_n, estropear) => {
    const e = await escenario();
    await estropear(e);
    expect(rechazada(await confirmarExistente(e.s.hash, e.sesion))).toBe(true);
    expect(await ep.estudiosPorNombre(e.s.estudio)).toHaveLength(0);
    expect(
      await adm("select 1 from membresia where usuario_id = $1", [e.cuenta.id]),
    ).toHaveLength(0);
  });

  it("token o sesion desconocidos (o alterados): cero filas", async () => {
    const { sesion, s } = await escenario();
    expect(rechazada(await confirmarExistente(alterar(s.hash), sesion))).toBe(
      true,
    );
    expect(rechazada(await confirmarExistente(tokenHashNuevo(), sesion))).toBe(
      true,
    );
    expect(rechazada(await confirmarExistente(s.hash, nuevoToken()))).toBe(
      true,
    );
    expect(await ep.estudiosPorNombre(s.estudio)).toHaveLength(0);
  });

  it("un segundo uso del mismo enlace no crea otro estudio", async () => {
    const { sesion, s } = await escenario();
    exitosa(await confirmarExistente(s.hash, sesion));
    expect(rechazada(await confirmarExistente(s.hash, sesion))).toBe(true);
    expect(await ep.estudiosPorNombre(s.estudio)).toHaveLength(1);
  });

  it("tres confirmaciones simultaneas con la misma sesion crean un solo estudio", async () => {
    const { cuenta, sesion, s } = await escenario();
    const r = await Promise.all([
      confirmarExistente(s.hash, sesion),
      confirmarExistente(s.hash, sesion),
      confirmarExistente(s.hash, sesion),
    ]);
    expect(r.filter((q) => q.ok && q.rows.length === 1)).toHaveLength(1);
    expect(await ep.estudiosPorNombre(s.estudio)).toHaveLength(1);
    expect(
      await adm("select 1 from membresia where usuario_id = $1", [cuenta.id]),
    ).toHaveLength(1);
  });

  it("sin plan Prueba activo: cero filas y sin efectos (el enlace queda vigente)", async () => {
    const { sesion, s } = await escenario();
    await adm("update plan set activo = false where codigo = 'prueba'");
    try {
      expect(rechazada(await confirmarExistente(s.hash, sesion))).toBe(true);
      expect(await ep.estudiosPorNombre(s.estudio)).toHaveLength(0);
      expect((await pendientes(s.correo))[0].consumida_en).toBeNull();
    } finally {
      await adm("update plan set activo = true where codigo = 'prueba'");
    }
  });
});

// =================================================================================================
describe("auth.cupo_usuarios_aceptar (CA-6, CA-7, D7: la invitacion ya estaba contada; solo exige activos + 1 <= max)", () => {
  const cupo = (t: string) => llamar(app, SQL.cupo, [t]);
  const plan = (max: number | null) => ep.plan({ maxUsuarios: max });

  it.each([
    ["1 activo de 3", 1, 3, true],
    ["2 activos de 3 (queda justo un cupo)", 2, 3, true],
    ["3 activos de 3 (lleno)", 3, 3, false],
    ["4 activos con max 3 (plan bajado: excede)", 4, 3, false],
    ["1 activo de 1", 1, 1, false],
  ])("%s -> %s", async (_n, activos, max, esperado) => {
    const { x } = await ep.estudioConUsuarios((await plan(max)).id, {
      activos,
    });
    expect(await valor(cupo(x.id))).toBe(esperado);
  });

  it("max_usuarios NULL no limita (12 activos aceptan otro)", async () => {
    const { x } = await ep.estudioConUsuarios((await plan(null)).id, {
      activos: 12,
    });
    expect(await valor(cupo(x.id))).toBe(true);
  });

  it("las membresias desactivadas no cuentan", async () => {
    const { x } = await ep.estudioConUsuarios((await plan(3)).id, {
      activos: 2,
      desactivados: 5,
    });
    expect(await valor(cupo(x.id))).toBe(true);
  });

  it("las invitaciones pendientes NO cuentan al aceptar (ya estaban contadas al invitar, D7)", async () => {
    const { x } = await ep.estudioConUsuarios((await plan(3)).id, {
      activos: 2,
      pendientes: 5,
      vencidas: 2,
    });
    expect(await valor(cupo(x.id))).toBe(true);
  });

  it("no consume ni cambia nada: llamarla varias veces da lo mismo y no escribe", async () => {
    const { x } = await ep.estudioConUsuarios((await plan(3)).id, {
      activos: 2,
      pendientes: 1,
    });
    const antes = await adm(
      "select (select count(*) from membresia where tenant_id = $1)::int m, (select count(*) from invitacion where tenant_id = $1)::int i",
      [x.id],
    );
    for (let i = 0; i < 3; i++) expect(await valor(cupo(x.id))).toBe(true);
    expect(
      await adm(
        "select (select count(*) from membresia where tenant_id = $1)::int m, (select count(*) from invitacion where tenant_id = $1)::int i",
        [x.id],
      ),
    ).toEqual(antes);
  });

  it("falla cerrado: un estudio sin suscripcion o inexistente se rechaza (false o error), nunca 'sin limite'", async () => {
    const { x } = await ep.estudioConUsuarios(null, { activos: 1 });
    expect(rechazada(await cupo(x.id))).toBe(true);
    expect(rechazada(await cupo(randomUUID()))).toBe(true);
  });

  it("CA-2: cambiar el plan en BD cambia el resultado sin reiniciar (limite sale de plan + suscripcion)", async () => {
    const p = await plan(3);
    const { x } = await ep.estudioConUsuarios(p.id, { activos: 3 });
    expect(await valor(cupo(x.id))).toBe(false);
    await adm("update plan set max_usuarios = 4 where id = $1", [p.id]);
    expect(await valor(cupo(x.id))).toBe(true);
    await adm("update plan set max_usuarios = null where id = $1", [p.id]);
    expect(await valor(cupo(x.id))).toBe(true);
    await adm("update plan set max_usuarios = 2 where id = $1", [p.id]);
    expect(await valor(cupo(x.id))).toBe(false);
    const otro = await plan(10);
    await adm("update suscripcion set plan_id = $2 where tenant_id = $1", [
      x.id,
      otro.id,
    ]);
    expect(await valor(cupo(x.id))).toBe(true);
  });

  it("CA-7: bajar el plan por debajo del uso no borra ni desactiva a nadie; solo se rechaza aceptar", async () => {
    const p = await plan(5);
    const { x } = await ep.estudioConUsuarios(p.id, { activos: 4 });
    await adm("update plan set max_usuarios = 2 where id = $1", [p.id]);
    expect(await valor(cupo(x.id))).toBe(false);
    expect(
      (
        await adm(
          "select count(*)::int n from membresia where tenant_id = $1 and desactivada_en is null",
          [x.id],
        )
      )[0].n,
    ).toBe(4);
  });
});

// =================================================================================================
describe("funciones de plataforma: solo un admin con sesion viva (D5, CA-1)", () => {
  /** Una llamada valida por funcion; con una sesion no admin todas deben rechazarse sin efectos. */
  type Objetivo = {
    plan: { id: string; codigo: string };
    estudio: { id: string };
    otroPlan: { id: string };
    codigoNuevo: string;
  };
  async function crearObjetivo(): Promise<Objetivo> {
    const plan = await ep.plan({
      maxRucs: 10,
      maxRucsExtra: 2,
      maxUsuarios: 5,
    });
    return {
      plan,
      estudio: await ep.estudioConPlan(plan.id, { rucsExtra: 1 }),
      otroPlan: await ep.plan({ maxRucsExtra: 2 }),
      codigoNuevo: ep.codigoNuevo(),
    };
  }
  let objetivoMemo: Promise<Objetivo> | undefined;
  const objetivoCompartido = () => (objetivoMemo ??= crearObjetivo());

  const args = (c: Objetivo) => ({
    yo: [SQL.yo, (t: Buffer) => [t]] as const,
    listar: [SQL.listar, (t: Buffer) => [t]] as const,
    crear: [
      SQL.planCrear,
      (t: Buffer) => [
        t,
        c.codigoNuevo,
        "Plan nuevo",
        "50.00",
        null,
        10,
        3,
        "2.00",
        2,
        60,
        "{}",
        true,
      ],
    ] as const,
    editar: [
      SQL.planEditar,
      (t: Buffer) => [
        t,
        c.plan.id,
        c.plan.codigo,
        "Plan editado",
        "70.00",
        null,
        99,
        99,
        "3.00",
        5,
        30,
        "{}",
        false,
      ],
    ] as const,
    estudios: [SQL.estudios, (t: Buffer) => [t]] as const,
    asignar: [
      SQL.asignar,
      (t: Buffer) => [t, c.estudio.id, c.otroPlan.id, 2],
    ] as const,
  });

  async function sesionesNoValidas() {
    const dueno = await ep.ea.miembro(
      (await ep.estudioConPlan((await objetivoCompartido()).otroPlan.id)).id,
      "dueno",
    );
    const sinAlta = await ep.ea.cuenta();
    const revocada = await ep.administrador();
    await adm(
      "update auth.sesion set revocada_en = now(), motivo = 'logout' where token_hash = $1",
      [revocada.sesion],
    );
    const inactiva = await ep.administrador();
    await adm(
      "update auth.sesion set ultimo_uso = now() - interval '121 minutes' where token_hash = $1",
      [inactiva.sesion],
    );
    const absoluta = await ep.administrador();
    await adm(
      "update auth.sesion set expira_absoluta = now() - interval '1 second' where token_hash = $1",
      [absoluta.sesion],
    );
    const baja = await ep.administrador();
    await adm("delete from admin_plataforma where usuario_id = $1", [
      baja.usuario.id,
    ]);
    return [
      [
        "Dueño de un estudio (no admin)",
        await ep.ea.esc.sesion(dueno.id, null),
      ],
      [
        "cuenta con sesion viva y sin alta",
        await ep.ea.esc.sesion(sinAlta.id, null),
      ],
      ["admin con sesion revocada", revocada.sesion],
      ["admin con sesion inactiva mas de 2 h", inactiva.sesion],
      ["admin con sesion de mas de 12 h", absoluta.sesion],
      ["ex admin (alta eliminada) con sesion viva", baja.sesion],
      ["token de sesion desconocido", nuevoToken()],
    ] as [string, Buffer][];
  }

  it("las 6 funciones rechazan a quien no es admin vivo, con la misma respuesta generica por funcion y sin efectos", async () => {
    const objetivo = await objetivoCompartido();
    const [antesPlan] = await adm(
      "select nombre, max_rucs, activo from plan where id = $1",
      [objetivo.plan.id],
    );
    const [antesSus] = await adm(
      "select plan_id, rucs_extra_contratados from suscripcion where tenant_id = $1",
      [objetivo.estudio.id],
    );
    const mensajes = new Map<string, Set<string>>();
    for (const [nombreSesion, token] of await sesionesNoValidas()) {
      for (const [fn, [sql, params]] of Object.entries(args(objetivo))) {
        const r = await llamar(app, sql, params(token));
        expect(rechazada(r), `${fn} con ${nombreSesion}`).toBe(true);
        if (!r.ok) {
          const set = mensajes.get(fn) ?? new Set<string>();
          set.add(r.message);
          mensajes.set(fn, set);
        }
      }
    }
    for (const [fn, set] of mensajes)
      expect(
        set.size,
        `${fn}: el mensaje de error no distingue los motivos`,
      ).toBe(1);
    expect(
      await adm("select 1 from plan where codigo = $1", [objetivo.codigoNuevo]),
    ).toHaveLength(0);
    expect(
      (
        await adm("select nombre, max_rucs, activo from plan where id = $1", [
          objetivo.plan.id,
        ])
      )[0],
    ).toEqual(antesPlan);
    expect(
      (
        await adm(
          "select plan_id, rucs_extra_contratados from suscripcion where tenant_id = $1",
          [objetivo.estudio.id],
        )
      )[0],
    ).toEqual(antesSus);
  });

  it("control: con un admin vivo las MISMAS 6 llamadas (mismos argumentos validos) tienen exito, asi que los rechazos de arriba son por la sesion", async () => {
    const a = await ep.administrador();
    const o = await crearObjetivo();
    for (const [fn, [sql, params]] of Object.entries(args(o))) {
      const r = await llamar(app, sql, params(a.sesion));
      expect(rechazada(r), `${fn} con un admin vivo`).toBe(false);
    }
    expect(
      await adm("select 1 from plan where codigo = $1", [o.codigoNuevo]),
    ).toHaveLength(1);
    expect(
      (await adm("select activo from plan where id = $1", [o.plan.id]))[0]
        .activo,
    ).toBe(false);
    expect(
      (
        await adm("select plan_id from suscripcion where tenant_id = $1", [
          o.estudio.id,
        ])
      )[0].plan_id,
    ).toBe(o.otroPlan.id);
  });

  it("plataforma_yo con un admin sin membresias (ni estudio activo) devuelve su usuario_id", async () => {
    const a = await ep.administrador();
    expect(exitosa(await llamar(app, SQL.yo, [a.sesion]))).toEqual([
      { usuario_id: a.usuario.id },
    ]);
    expect(
      await adm("select 1 from membresia where usuario_id = $1", [
        a.usuario.id,
      ]),
    ).toHaveLength(0);
  });

  it("el alta se revalida en cada llamada: al borrar el alta, la misma sesion deja de servir", async () => {
    const a = await ep.administrador();
    exitosa(await llamar(app, SQL.listar, [a.sesion]));
    await adm("delete from admin_plataforma where usuario_id = $1", [
      a.usuario.id,
    ]);
    expect(rechazada(await llamar(app, SQL.listar, [a.sesion]))).toBe(true);
    expect(rechazada(await llamar(app, SQL.yo, [a.sesion]))).toBe(true);
  });
});

// =================================================================================================
describe("plan_listar, plan_crear y plan_editar (CA-1, CA-2, CA-7, D10, D11)", () => {
  // Sesion de administrador creada al primer uso (no en beforeAll): asi, sin esquema, cada prueba falla por si sola.
  let adminMemo:
    Promise<{ usuario: { id: string }; sesion: Buffer }> | undefined;
  const comoAdmin = () => (adminMemo ??= ep.administrador());
  const listar = async () =>
    exitosa(await llamar(app, SQL.listar, [(await comoAdmin()).sesion]));
  const crear = async (
    c: Partial<{
      codigo: string;
      nombre: string;
      pm: string;
      pa: string | null;
      rucs: number;
      usu: number | null;
      pre: string;
      extra: number;
      buzon: number;
      features: string;
      activo: boolean;
    }> = {},
  ) =>
    llamar(app, SQL.planCrear, [
      (await comoAdmin()).sesion,
      c.codigo ?? ep.codigoNuevo(),
      c.nombre ?? "Plan creado",
      c.pm ?? "99.50",
      c.pa === undefined ? "990.00" : c.pa,
      c.rucs ?? 30,
      c.usu === undefined ? 2 : c.usu,
      c.pre ?? "4.00",
      c.extra ?? 6,
      c.buzon ?? 1440,
      c.features ?? '{"modulo":"x"}',
      c.activo ?? true,
    ]);
  const editar = async (
    id: string,
    codigoPlan: string,
    c: Partial<{
      nombre: string;
      pm: string;
      pa: string | null;
      rucs: number;
      usu: number | null;
      pre: string;
      extra: number;
      buzon: number;
      features: string;
      activo: boolean;
    }> = {},
  ) =>
    llamar(app, SQL.planEditar, [
      (await comoAdmin()).sesion,
      id,
      codigoPlan,
      c.nombre ?? "Plan editado",
      c.pm ?? "120.00",
      c.pa === undefined ? null : c.pa,
      c.rucs ?? 40,
      c.usu === undefined ? 3 : c.usu,
      c.pre ?? "5.00",
      c.extra ?? 8,
      c.buzon ?? 720,
      c.features ?? '{"modulo":"y"}',
      c.activo ?? true,
    ]);
  const fila = async (id: string) =>
    (await adm("select * from plan where id = $1", [id]))[0];

  it("plan_listar devuelve los 5 planes del seed con sus precios (el admin si ve precios) e incluye los inactivos", async () => {
    const inactivo = await ep.plan({ activo: false });
    const filas = await listar();
    const por = Object.fromEntries(filas.map((p) => [p.codigo, p]));
    expect(por.independiente).toMatchObject({
      precio_mensual: "99.00",
      precio_anual: "990.00",
      max_rucs: 30,
      max_usuarios: 2,
      max_rucs_extra: 6,
    });
    expect(por.corporativo).toMatchObject({
      max_rucs: 600,
      max_usuarios: null,
    });
    for (const c of [
      "prueba",
      "independiente",
      "estudio",
      "estudio_pro",
      "corporativo",
    ])
      expect(por[c], c).toBeDefined();
    expect(por[inactivo.codigo]).toMatchObject({ activo: false });
    for (const c of [
      "id",
      "codigo",
      "nombre",
      "precio_mensual",
      "precio_anual",
      "max_rucs",
      "max_usuarios",
      "precio_ruc_extra",
      "max_rucs_extra",
      "frecuencia_buzon_min",
      "features",
      "activo",
    ]) {
      expect(Object.keys(filas[0]), c).toContain(c);
    }
  });

  it("plan_crear crea el plan con todos sus campos (precios exactos a 2 decimales, max_usuarios y precio_anual opcionales) y lo devuelve", async () => {
    const r = exitosa(await crear({ pm: "99.50", pa: "990.00", usu: 2 }));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      nombre: "Plan creado",
      precio_mensual: "99.50",
      precio_anual: "990.00",
      max_rucs: 30,
      max_usuarios: 2,
      precio_ruc_extra: "4.00",
      max_rucs_extra: 6,
      frecuencia_buzon_min: 1440,
      features: { modulo: "x" },
      activo: true,
    });
    const f = await fila(r[0].id);
    expect(f).toMatchObject({ codigo: r[0].codigo, precio_mensual: "99.50" });
    await adm("delete from plan where id = $1", [r[0].id]);
  });

  it("plan_crear admite max_usuarios NULL (ilimitado) y precio_anual NULL", async () => {
    const r = exitosa(await crear({ usu: null, pa: null }));
    expect(r[0]).toMatchObject({ max_usuarios: null, precio_anual: null });
  });

  it("un plan creado queda disponible al instante para planes_listar y para asignarlo (CA-1)", async () => {
    const r = exitosa(await crear());
    expect((await listar()).some((p) => p.id === r[0].id)).toBe(true);
  });

  it("no se puede repetir el codigo (ni el de un plan sembrado) y el plan existente no cambia", async () => {
    const r = exitosa(await crear());
    expect(
      rechazada(await crear({ codigo: r[0].codigo, nombre: "Duplicado" })),
    ).toBe(true);
    expect(
      rechazada(await crear({ codigo: "prueba", nombre: "Duplicado" })),
    ).toBe(true);
    expect((await fila(r[0].id)).nombre).toBe("Plan creado");
    expect(
      (await adm("select count(*)::int n from plan where codigo = 'prueba'"))[0]
        .n,
    ).toBe(1);
    expect(
      (await adm("select nombre from plan where codigo = 'prueba'"))[0].nombre,
    ).not.toBe("Duplicado");
  });

  it.each([
    ["precio_mensual negativo", { pm: "-1.00" }],
    ["precio_anual negativo", { pa: "-1.00" }],
    ["precio_ruc_extra negativo", { pre: "-0.50" }],
    ["max_rucs en 0", { rucs: 0, extra: 0 }],
    ["max_rucs negativo", { rucs: -3, extra: 0 }],
    ["max_usuarios en 0", { usu: 0 }],
    ["max_usuarios negativo", { usu: -2 }],
    ["tope extra sobre el 20 % (7 de 30)", { rucs: 30, extra: 7 }],
    ["max_rucs_extra negativo", { extra: -1 }],
    ["frecuencia_buzon_min en 0", { buzon: 0 }],
    ["features que no es un objeto", { features: "[1,2]" }],
  ])("plan_crear rechaza %s y no crea nada", async (_n, cambios) => {
    const codigoNuevo = ep.codigoNuevo();
    expect(rechazada(await crear({ codigo: codigoNuevo, ...cambios }))).toBe(
      true,
    );
    expect(
      await adm("select 1 from plan where codigo = $1", [codigoNuevo]),
    ).toHaveLength(0);
  });

  it("plan_editar reemplaza el plan en sitio (incluye activo) y devuelve la fila editada", async () => {
    const p = await ep.plan({
      precioMensual: "10.00",
      maxRucs: 10,
      maxUsuarios: 5,
    });
    const r = exitosa(
      await editar(p.id, p.codigo, {
        nombre: "Renombrado",
        pm: "120.00",
        rucs: 40,
        usu: null,
        extra: 8,
        activo: false,
      }),
    );
    expect(r[0]).toMatchObject({
      id: p.id,
      codigo: p.codigo,
      nombre: "Renombrado",
      precio_mensual: "120.00",
      max_rucs: 40,
      max_usuarios: null,
      max_rucs_extra: 8,
      activo: false,
    });
    expect(await fila(p.id)).toMatchObject({
      nombre: "Renombrado",
      max_rucs: 40,
      max_usuarios: null,
      activo: false,
    });
    expect(r[0].id).toBe(p.id);
  });

  it("plan_editar de un plan inexistente se rechaza sin crear nada; el codigo de otro plan se rechaza sin cambiar nada", async () => {
    expect(rechazada(await editar(randomUUID(), "t1_inexistente"))).toBe(true);
    expect(
      await adm("select 1 from plan where codigo = 't1_inexistente'"),
    ).toHaveLength(0);
    const p = await ep.plan();
    const otro = await ep.plan();
    const antes = await fila(p.id);
    expect(rechazada(await editar(p.id, otro.codigo))).toBe(true);
    expect(await fila(p.id)).toEqual(antes);
  });

  it.each([
    ["precio_mensual negativo", { pm: "-1.00" }],
    ["max_rucs en 0", { rucs: 0, extra: 0 }],
    ["max_usuarios en 0", { usu: 0 }],
    ["tope extra sobre el 20 %", { rucs: 10, extra: 3 }],
    ["frecuencia_buzon_min en 0", { buzon: 0 }],
    ["features que no es un objeto", { features: "[]" }],
  ])("plan_editar rechaza %s y el plan queda intacto", async (_n, cambios) => {
    const p = await ep.plan();
    const antes = await fila(p.id);
    expect(rechazada(await editar(p.id, p.codigo, cambios))).toBe(true);
    expect(await fila(p.id)).toEqual(antes);
  });

  it("desactivar un plan no toca a quienes ya lo usan: su suscripcion lo conserva (CA-1)", async () => {
    const p = await ep.plan();
    const x = await ep.estudioConPlan(p.id, { rucsExtra: 1 });
    exitosa(await editar(p.id, p.codigo, { activo: false }));
    expect(
      (
        await adm(
          "select plan_id, rucs_extra_contratados from suscripcion where tenant_id = $1",
          [x.id],
        )
      )[0],
    ).toEqual({ plan_id: p.id, rucs_extra_contratados: 1 });
  });

  it("D11/CA-2: editar el plan vale al instante para todos sus estudios (cupo_usuarios_aceptar cambia sin reiniciar)", async () => {
    const p = await ep.plan({ maxUsuarios: 3 });
    const { x } = await ep.estudioConUsuarios(p.id, { activos: 3 });
    const cupo = async () =>
      (exitosa(await llamar(app, SQL.cupo, [x.id])) as { v: boolean }[])[0]!.v;
    expect(await cupo()).toBe(false);
    exitosa(await editar(p.id, p.codigo, { usu: 4, rucs: 10, extra: 2 }));
    expect(await cupo()).toBe(true);
    exitosa(await editar(p.id, p.codigo, { usu: 1, rucs: 10, extra: 2 }));
    expect(await cupo()).toBe(false);
    expect(
      (
        await adm(
          "select count(*)::int n from membresia where tenant_id = $1 and desactivada_en is null",
          [x.id],
        )
      )[0].n,
    ).toBe(3); // CA-7: nadie desactivado
  });

  it("CA-7/D10: bajar el tope de adicionales del plan no cambia lo contratado (el limite efectivo usa min en la aplicacion)", async () => {
    const p = await ep.plan({ maxRucs: 20, maxRucsExtra: 4 });
    const x = await ep.estudioConPlan(p.id, { rucsExtra: 4 });
    exitosa(await editar(p.id, p.codigo, { rucs: 20, extra: 1 }));
    expect(
      (
        await adm(
          "select rucs_extra_contratados from suscripcion where tenant_id = $1",
          [x.id],
        )
      )[0].rucs_extra_contratados,
    ).toBe(4);
  });

  it("plan_crear, plan_editar y suscripcion_asignar solo tocan plan y suscripcion (nada de tenant, usuario, membresia, invitacion, cliente ni credenciales)", async () => {
    const huella = async () =>
      (
        await adm(
          `select
             (select md5(coalesce(string_agg(t::text, ',' order by t::text), '')) from tenant t) tenant,
             (select md5(coalesce(string_agg(t::text, ',' order by t::text), '')) from usuario t) usuario,
             (select md5(coalesce(string_agg(t::text, ',' order by t::text), '')) from membresia t) membresia,
             (select md5(coalesce(string_agg(t::text, ',' order by t::text), '')) from invitacion t) invitacion,
             (select md5(coalesce(string_agg(t::text, ',' order by t::text), '')) from cliente t) cliente,
             (select md5(coalesce(string_agg(t::text, ',' order by t::text), '')) from admin_plataforma t) admin_plataforma,
             (select md5(coalesce(string_agg(t::text, ',' order by t::text), '')) from auth.usuario_contrasena t) contrasena,
             (select md5(coalesce(string_agg(t::text, ',' order by t::text), '')) from auth.registro_pendiente t) pendientes`,
        )
      )[0];
    const p = await ep.plan();
    const q = await ep.plan({ maxRucsExtra: 2 });
    const x = await ep.estudioConPlan(p.id);
    const antes = await huella();
    exitosa(await crear());
    exitosa(await editar(p.id, p.codigo, { rucs: 10, extra: 2 }));
    exitosa(
      await llamar(app, SQL.asignar, [
        (await comoAdmin()).sesion,
        x.id,
        q.id,
        1,
      ]),
    );
    expect(await huella()).toEqual(antes);
  });
});

// =================================================================================================
describe("estudios_listar y suscripcion_asignar (D5, D6, D13, CA-1, CA-7)", () => {
  let adminMemo:
    Promise<{ usuario: { id: string }; sesion: Buffer }> | undefined;
  const comoAdmin = () => (adminMemo ??= ep.administrador());
  const asignar = async (tenantId: string, planId: string, extra: number) =>
    llamar(app, SQL.asignar, [
      (await comoAdmin()).sesion,
      tenantId,
      planId,
      extra,
    ]);
  const sus = async (t: string) =>
    (
      await adm(
        "select plan_id, estado, rucs_extra_contratados, prueba_vence_en from suscripcion where tenant_id = $1",
        [t],
      )
    )[0];

  it("estudios_listar devuelve id, nombre, plan y estado de cada estudio y NADA mas (sin precios, RUCs ni uso)", async () => {
    const p = await ep.plan();
    const x = await ep.estudioConPlan(p.id, { estado: "prueba" });
    const filas = exitosa(
      await llamar(app, SQL.estudios, [(await comoAdmin()).sesion]),
    );
    expect(Object.keys(filas[0]).sort()).toEqual([
      "estado",
      "id",
      "nombre",
      "plan_codigo",
      "plan_nombre",
    ]);
    const mio = filas.find((f) => f.id === x.id);
    expect(mio).toEqual({
      id: x.id,
      nombre: x.nombre,
      plan_codigo: p.codigo,
      plan_nombre: `Plan T1 ${p.codigo}`,
      estado: "prueba",
    });
    for (const t of [A(), B()])
      expect(
        filas.find((f) => f.id === t),
        t,
      ).toMatchObject({ plan_codigo: "corporativo", estado: "activa" });
  });

  it("asigna plan y RUCs adicionales a un estudio y devuelve la suscripcion resultante", async () => {
    const p = await ep.plan();
    const q = await ep.plan({ maxRucs: 20, maxRucsExtra: 4 });
    const x = await ep.estudioConPlan(p.id);
    const r = exitosa(await asignar(x.id, q.id, 3));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      tenant_id: x.id,
      plan_id: q.id,
      plan_codigo: q.codigo,
      rucs_extra_contratados: 3,
    });
    expect(["prueba", "activa"]).toContain(r[0].estado);
    expect(await sus(x.id)).toMatchObject({
      plan_id: q.id,
      rucs_extra_contratados: 3,
    });
  });

  it("el tope de adicionales es el del plan NUEVO: el borde entra y uno mas se rechaza sin cambios (D6, D10)", async () => {
    const p = await ep.plan({ maxRucs: 100, maxRucsExtra: 20 });
    const q = await ep.plan({ maxRucs: 10, maxRucsExtra: 2 });
    const x = await ep.estudioConPlan(p.id, { rucsExtra: 5 });
    const antes = await sus(x.id);
    expect(rechazada(await asignar(x.id, q.id, 3))).toBe(true);
    expect(await sus(x.id)).toEqual(antes);
    exitosa(await asignar(x.id, q.id, 2));
    expect(await sus(x.id)).toMatchObject({
      plan_id: q.id,
      rucs_extra_contratados: 2,
    });
    exitosa(await asignar(x.id, q.id, 0));
    expect((await sus(x.id)).rucs_extra_contratados).toBe(0);
  });

  it.each([
    ["extra negativo", async (x: string, q: string) => asignar(x, q, -1)],
    ["plan inexistente", async (x: string) => asignar(x, randomUUID(), 0)],
  ])("rechaza %s y la suscripcion queda intacta", async (_n, llamada) => {
    const p = await ep.plan();
    const q = await ep.plan({ maxRucsExtra: 2 });
    const x = await ep.estudioConPlan(p.id, { rucsExtra: 1 });
    const antes = await sus(x.id);
    expect(rechazada(await llamada(x.id, q.id))).toBe(true);
    expect(await sus(x.id)).toEqual(antes);
  });

  it("un plan inactivo no se asigna (y el estudio conserva el suyo); un plan inactivo que ya tenia se conserva (CA-1)", async () => {
    const p = await ep.plan();
    const inactivo = await ep.plan({ activo: false });
    const x = await ep.estudioConPlan(p.id);
    expect(rechazada(await asignar(x.id, inactivo.id, 0))).toBe(true);
    expect((await sus(x.id)).plan_id).toBe(p.id);
    const y = await ep.estudioConPlan(inactivo.id); // lo tenia desde antes
    expect((await sus(y.id)).plan_id).toBe(inactivo.id);
    exitosa(await asignar(y.id, p.id, 0)); // y puede salir de el hacia uno activo
  });

  it("un estudio inexistente se rechaza y no se crea ninguna suscripcion para ese id", async () => {
    const q = await ep.plan();
    const fantasma = randomUUID();
    expect(rechazada(await asignar(fantasma, q.id, 0))).toBe(true);
    expect(
      await adm("select 1 from suscripcion where tenant_id = $1", [fantasma]),
    ).toHaveLength(0);
  });

  // Ajuste de 006 (T13a): D14 REVIERTE la ratificacion de T1/T3 (antes: un estudio existente SIN suscripcion no la recibia por
  // asignacion). Ahora un estudio sin plan (la cuenta ya uso su prueba) recibe su suscripcion `activa` del super-admin.
  // Mas casos (carrera, validaciones, no-admin) en planes-ronda1.spec.ts.
  it("D14 · estudio existente sin suscripcion: asignar la crea `activa`; estudios_listar lo mostraba sin plan y no falla", async () => {
    const q = await ep.plan();
    const sin = await ep.ea.estudio(); // tenant sin suscripcion
    const antes = await adm("select count(*)::int n from suscripcion");
    const filas0 = exitosa(
      await llamar(app, SQL.estudios, [(await comoAdmin()).sesion]),
    );
    const f0 = filas0.find((x) => x.id === sin.id);
    expect(f0, "el estudio sin suscripcion se lista").toBeDefined();
    expect(f0.plan_codigo ?? null).toBeNull();
    expect(f0.estado ?? null).toBeNull();
    const r = exitosa(await asignar(sin.id, q.id, 0));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      tenant_id: sin.id,
      plan_id: q.id,
      estado: "activa",
      rucs_extra_contratados: 0,
    });
    expect(
      await adm(
        "select estado, prueba_vence_en from suscripcion where tenant_id = $1",
        [sin.id],
      ),
    ).toEqual([{ estado: "activa", prueba_vence_en: null }]);
    expect(await adm("select count(*)::int n from suscripcion")).toEqual([
      { n: antes[0].n + 1 },
    ]);
  });

  it("solo cambia la suscripcion del estudio indicado: la de otro estudio con el mismo plan no se toca", async () => {
    const p = await ep.plan();
    const q = await ep.plan({ maxRucsExtra: 2 });
    const x = await ep.estudioConPlan(p.id, { rucsExtra: 1 });
    const y = await ep.estudioConPlan(p.id, { rucsExtra: 2 });
    const antesY = await sus(y.id);
    const antesA = await sus(A());
    exitosa(await asignar(x.id, q.id, 1));
    expect(await sus(y.id)).toEqual(antesY);
    expect(await sus(A())).toEqual(antesA);
  });

  it("CA-7: pasar a un plan menor que el uso actual no borra ni desactiva nada (miembros ni clientes)", async () => {
    const grande = await ep.plan({
      maxRucs: 100,
      maxUsuarios: 10,
      maxRucsExtra: 20,
    });
    const chico = await ep.plan({
      maxRucs: 1,
      maxUsuarios: 1,
      maxRucsExtra: 0,
    });
    const { x } = await ep.estudioConUsuarios(grande.id, {
      activos: 4,
      pendientes: 2,
    });
    await ep.ea.clientes(x.id, 6);
    exitosa(await asignar(x.id, chico.id, 0));
    const [n] = await adm(
      `select (select count(*) from membresia where tenant_id = $1 and desactivada_en is null)::int miembros,
              (select count(*) from invitacion where tenant_id = $1 and revocada_en is null and aceptada_en is null)::int pendientes,
              (select count(*) from cliente where tenant_id = $1)::int clientes`,
      [x.id],
    );
    expect(n).toEqual({ miembros: 4, pendientes: 2, clientes: 6 });
    expect(await valorCupo(x.id)).toBe(false); // y aceptar queda bloqueado hasta regularizar
  });

  async function valorCupo(t: string) {
    return valor(llamar(app, SQL.cupo, [t]));
  }
});

// =================================================================================================
describe("auth.limite_consumir con los tipos de registro (CA-4: limite por IP y por correo)", () => {
  const consumir = (tipo: string, sujeto: string) =>
    valor(llamar(app, SQL.limite, [tipo, sujeto]));

  it.each([
    ["registro_ip", 5],
    ["registro_correo", 3],
    // Ajuste de 006 (T13a, D15): 0025 redefine limite_consumir con el tipo del limite al confirmar.
    ["registro_confirmar_ip", 10],
  ])(
    "%s admite %i consumos por hora y rechaza el siguiente",
    async (tipo, max) => {
      const s = ep.ea.esc.sujeto(tipo);
      for (let i = 1; i <= max; i++)
        expect(await consumir(tipo, s), `consumo ${i}`).toBe(true);
      expect(await consumir(tipo, s)).toBe(false);
      expect(await consumir(tipo, s)).toBe(false);
    },
  );

  it("los sujetos y los tipos tienen contadores independientes (agotar uno no afecta a otro)", async () => {
    const s1 = ep.ea.esc.sujeto("registro_correo");
    const s2 = ep.ea.esc.sujeto("registro_correo");
    for (let i = 0; i < 3; i++) await consumir("registro_correo", s1);
    expect(await consumir("registro_correo", s1)).toBe(false);
    expect(await consumir("registro_correo", s2)).toBe(true);
    expect(await consumir("registro_ip", s1)).toBe(true);
  });

  it("al vencer la ventana de 1 hora el contador vuelve a admitir consumos", async () => {
    const s = ep.ea.esc.sujeto("registro_correo");
    for (let i = 0; i < 3; i++) await consumir("registro_correo", s);
    expect(await consumir("registro_correo", s)).toBe(false);
    await adm(
      "update auth.limite_tasa set ventana_inicio = now() - interval '61 minutes' where tipo = 'registro_correo' and sujeto = $1",
      [s],
    );
    expect(await consumir("registro_correo", s)).toBe(true);
  });

  it("los tipos de 004 conservan su comportamiento (control: recup_correo admite 3)", async () => {
    const s = ep.ea.esc.sujeto("recup_correo");
    for (let i = 1; i <= 3; i++)
      expect(await consumir("recup_correo", s), `consumo ${i}`).toBe(true);
    expect(await consumir("recup_correo", s)).toBe(false);
  });

  it("un tipo desconocido no concede el consumo", async () => {
    const r = await llamar(app, SQL.limite, [
      "registro_otro",
      ep.ea.esc.sujeto("otro"),
    ]);
    expect(!r.ok || r.rows[0].v === false).toBe(true);
  });
});
