// Soporte de las pruebas de BD de la spec 029 (T1). No es una prueba (no termina en .spec.ts).
// Solo usa DATABASE_URL y MIGRATIONS_DATABASE_URL (superusuario: siembra y limpia). Nunca imprime URLs, contrasenas, tokens ni secretos; los
// "cifrados", hashes y codigos son bytes sinteticos (nada es un secreto real).
//
// CONTRATO DE BD que fija esta spec para la migracion 0078 (T5) y que las pruebas de T1 ejercen. El plan fija los nombres y el reparto de
// responsabilidades; las firmas exactas las fijan estas pruebas. Todas son `auth.*`, SECURITY DEFINER, dueño contapp_auth, search_path
// `pg_catalog, pg_temp`, EXECUTE solo contapp_backend (`totp_restablecer`: solo contapp_migrator), una firma por nombre.
//
//  auth.totp_leer(p_usuario_id uuid)
//    -> 0 o 1 fila: activo_cifrado bytea, activo_version int, pendiente_cifrado bytea, pendiente_version int,
//       pendiente_expira timestamptz, ultimo_paso bigint, activado_en timestamptz        (0 filas: el usuario nunca inicio el enrolamiento)
//  auth.totp_enrolar_iniciar(p_usuario_id uuid, p_cifrado bytea, p_version int) -> timestamptz (pendiente_expira = now() + 10 min)
//       Reemplaza el pendiente anterior; nunca toca el secreto activo. Lo que se guarda es el cifrado (la clave es del backend, D1).
//  auth.totp_intento_reservar(p_token_hash bytea) -> (permitido boolean, usuario_id uuid)      (0 filas: sesion no vigente)
//       Suma 1 al contador de 004 D7 (auth.intento_login, clave = sha256 del correo) bajo FOR UPDATE; al 5.º bloquea 15 min y, si la sesion
//       dada es `pendiente`, la revoca (motivo 'totp'). Con la cuenta bloqueada: permitido = false. 20 concurrentes -> exactamente 5 `true`.
//  auth.totp_verificar_exito(p_token_hash bytea, p_paso bigint, p_token_hash_nuevo bytea, p_tenant_nuevo uuid)
//    -> (sesion_id uuid, expira_absoluta timestamptz)  (0 filas y sin efectos: sesion no `pendiente`/vigente, paso reutilizado o estudio sin
//       membresia activa). D3: `UPDATE auth.totp SET ultimo_paso = p_paso WHERE ... ultimo_paso < p_paso`. Reinicia el contador, rota la
//       sesion (la vieja revocada, motivo 'rotacion') y emite una `verificado` de 12 h.
//  auth.totp_recuperacion_usar(p_token_hash bytea, p_hash bytea, p_token_hash_nuevo bytea, p_tenant_nuevo uuid)
//    -> igual que la anterior; gasta el codigo (`UPDATE ... usado_en = now() WHERE hash = p_hash AND usado_en IS NULL`, atomico) y deja el
//       evento `recuperacion_usada`.
//  auth.totp_confirmar(p_token_hash bytea, p_paso bigint, p_hashes bytea[], p_token_hash_nuevo bytea)
//    -> (sesion_id uuid, expira_absoluta timestamptz)  (0 filas y sin efectos: sesion `pendiente` o no vigente, sin pendiente o pendiente
//       vencido, paso <= ultimo_paso, o p_hashes sin exactamente 10 elementos distintos -> error 22023). El pendiente pasa a activo, se
//       guardan los 10 hashes (los anteriores se borran), evento `totp_activado`, las demas sesiones del usuario se revocan (motivo 'totp') y
//       la actual rota a `verificado` conservando creada_en, tenant_activo y expira_absoluta.
//  auth.totp_desactivar(p_token_hash bytea, p_paso bigint) -> text: 'desactivado' | 'exigido' | 'invalido'
//       'exigido': el usuario tiene TOTP exigido (U1: es admin de plataforma o tiene una membresia ACTIVA con rol dueno o admin; contador,
//       asistente y lectura no, como en CASOS_FACTOR_EXIGIDO de shared); sin NINGUN efecto (el paso no se consume).
//       'invalido': sesion no `verificado` o no vigente, sin TOTP activo, o paso reutilizado. 'desactivado': borra TOTP y codigos, deja el
//       evento `totp_desactivado` y revoca las demas sesiones (motivo 'totp').
//  auth.totp_recuperacion_regenerar(p_token_hash bytea, p_paso bigint, p_hashes bytea[]) -> boolean
//       true: sesion `verificado`, TOTP activo, paso nuevo y 10 hashes; borra los codigos anteriores (usados o no), guarda los nuevos y deja
//       `recuperacion_regenerada`. false (sin efectos) si algo falta.
//  auth.sesiones_listar(p_token_hash bytea) -> (id uuid, creada_en timestamptz, ultimo_uso timestamptz, dispositivo text, ip_red cidr,
//       actual boolean)   solo las vigentes del dueño de la sesion dada (sin `pendiente`); 0 filas si la dada no es vigente o es `pendiente`.
//  auth.sesion_revocar_id(p_token_hash bytea, p_sesion_id uuid) -> void   revoca (motivo 'revocada_usuario') solo una vigente del mismo
//       usuario; ajena, inexistente o ya revocada: misma salida y ningun efecto.
//  auth.sesiones_revocar_otras(p_token_hash bytea) -> integer   revoca las demas vigentes del usuario (motivo 'revocada_usuario'), no la actual.
//  auth.totp_restablecer(p_correo text) -> (usuario_id uuid, correo text, nombre text)  (0 filas: el correo no existe o no tenia TOTP). Borra
//       TOTP y codigos, revoca TODAS las sesiones del usuario (motivo 'totp') y deja el evento `totp_restablecido`. Solo contapp_migrator.
//  auth.login_exito(..., p_factor text DEFAULT 'sin_factor', p_dispositivo text DEFAULT NULL, p_ip_red cidr DEFAULT NULL): la de 0013 con tres
//       parametros nuevos al final (una sola firma; las llamadas de 7 argumentos siguen valiendo). Con TOTP activo la sesion nace `pendiente`
//       aunque el llamador pase otro factor; `pendiente` dura 5 min y no lleva estudio; 'verificado' no se puede pedir por aqui (22023).
//  auth.sesion_validar / auth.sesion_consultar: las mismas columnas de 0013/0019 + `factor text` al final; `pendiente` solo vale 5 min.
//  auth.sesion (0078): + factor text NOT NULL DEFAULT 'sin_factor' CHECK IN (pendiente, verificado, sin_factor), dispositivo text CHECK
//       (length <= 60), ip_red cidr; motivos + 'revocada_usuario' y 'totp'.
//  auth.totp (usuario_id PK/FK, activo_cifrado, activo_version, pendiente_cifrado, pendiente_version, pendiente_expira, ultimo_paso bigint NOT
//       NULL DEFAULT 0, activado_en), auth.totp_recuperacion (id, usuario_id, hash bytea UNIQUE, usado_en),
//       auth.cuenta_evento (id, usuario_id, tipo CHECK en 5 valores, creado_en).
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { Escenario, type Llamada, abrirAdmin, abrirApp, exito, llamar, nuevoToken } from "./auth-soporte";
import { tenantDe } from "./soporte";

export { Escenario, abrirAdmin, abrirApp, exito, llamar, nuevoToken, tenantDe };
export type { Llamada };

export type Factor = "pendiente" | "verificado" | "sin_factor";
export const TIPOS_EVENTO = [
  "totp_activado",
  "totp_desactivado",
  "recuperacion_usada",
  "recuperacion_regenerada",
  "totp_restablecido",
] as const;

/** U1: de los roles de sistema de membresia (005) solo Dueño y Administrador lo exigen (U2 alcanza a roles PROPIOS, que la BD aun no tiene). */
export const ROLES_CON_FACTOR_EXIGIDO = ["dueno", "admin"] as const;
export const ROLES_SIN_FACTOR_EXIGIDO = ["contador", "asistente", "lectura"] as const;

export const SQL = {
  leer: "select * from auth.totp_leer($1::uuid)",
  enrolarIniciar: "select auth.totp_enrolar_iniciar($1::uuid, $2::bytea, $3::int) as pendiente_expira",
  reservar: "select * from auth.totp_intento_reservar($1::bytea)",
  verificarExito: "select * from auth.totp_verificar_exito($1::bytea, $2::bigint, $3::bytea, $4::uuid)",
  recuperacionUsar: "select * from auth.totp_recuperacion_usar($1::bytea, $2::bytea, $3::bytea, $4::uuid)",
  confirmar: "select * from auth.totp_confirmar($1::bytea, $2::bigint, $3::bytea[], $4::bytea)",
  desactivar: "select auth.totp_desactivar($1::bytea, $2::bigint) as r",
  regenerar: "select auth.totp_recuperacion_regenerar($1::bytea, $2::bigint, $3::bytea[]) as r",
  listar: "select * from auth.sesiones_listar($1::bytea)",
  revocarId: "select * from auth.sesion_revocar_id($1::bytea, $2::uuid)",
  revocarOtras: "select auth.sesiones_revocar_otras($1::bytea) as n",
  restablecer: "select * from auth.totp_restablecer($1::text)",
  validar: "select * from auth.sesion_validar($1::bytea)",
  consultar: "select * from auth.sesion_consultar($1::bytea)",
  loginExito:
    "select * from auth.login_exito($1::bytea, $2::uuid, $3::text, $4::bytea, $5::uuid, $6::text, $7::bytea, $8::text, $9::text, $10::cidr)",
  loginExito7: "select * from auth.login_exito($1::bytea, $2::uuid, $3::text, $4::bytea, $5::uuid, $6::text, $7::bytea)",
} as const;

/** Un paso de 30 s nuevo y grande: los de prueba son numeros fijos (el reloj es del backend; la BD solo compara). */
export const PASO = 59_000_000n;

export const hash32 = (): Buffer => randomBytes(32);
export const diez = (): Buffer[] => Array.from({ length: 10 }, hash32);

/** Escenario con lo de la cuenta segura: sesiones con factor, TOTP activo o pendiente, codigos de recuperacion y membresias con rol. */
export class EscenarioTotp extends Escenario {
  private readonly admins: string[] = [];

  /** Sesion con factor, dispositivo, red y tiempos a medida; devuelve el token y el id. */
  async sesionF(
    usuarioId: string,
    o: {
      factor?: Factor;
      tenant?: string | null;
      dispositivo?: string | null;
      ipRed?: string | null;
      ultimoUsoHace?: string; // intervalo SQL, p. ej. '10 minutes'
      creadaHace?: string;
      expiraEn?: string; // intervalo SQL desde ahora; por omision 12 hours
    } = {},
  ): Promise<{ token: Buffer; id: string }> {
    const token = nuevoToken();
    const r = await this.admin.query(
      `insert into auth.sesion (token_hash, usuario_id, tenant_activo, creada_en, ultimo_uso, expira_absoluta, factor, dispositivo, ip_red)
       values ($1, $2, $3, now() - $4::interval, now() - $5::interval, now() + $6::interval, $7, $8, $9::cidr) returning id`,
      [
        token,
        usuarioId,
        o.tenant ?? null,
        o.creadaHace ?? "0 seconds",
        o.ultimoUsoHace ?? "0 seconds",
        o.expiraEn ?? "12 hours",
        o.factor ?? "sin_factor",
        o.dispositivo ?? null,
        o.ipRed ?? null,
      ],
    );
    return { token, id: r.rows[0].id as string };
  }

  /** TOTP activo con un "cifrado" sintetico (la BD nunca lo interpreta). */
  async totpActivo(usuarioId: string, o: { ultimoPaso?: bigint; version?: number } = {}): Promise<Buffer> {
    const cifrado = randomBytes(48);
    await this.admin.query(
      `insert into auth.totp (usuario_id, activo_cifrado, activo_version, ultimo_paso, activado_en)
       values ($1, $2, $3, $4, now())`,
      [usuarioId, cifrado, o.version ?? 1, String(o.ultimoPaso ?? 0n)],
    );
    return cifrado;
  }

  /** Enrolamiento a medias: pendiente vigente (o vencido con `venceHace`). */
  async totpPendiente(usuarioId: string, o: { venceHace?: string; conActivo?: boolean } = {}): Promise<Buffer> {
    const cifrado = randomBytes(48);
    const expira = o.venceHace !== undefined ? `now() - interval '${o.venceHace}'` : "now() + interval '10 minutes'";
    if (o.conActivo) {
      await this.admin.query(
        `update auth.totp set pendiente_cifrado = $2, pendiente_version = 1, pendiente_expira = ${expira} where usuario_id = $1`,
        [usuarioId, cifrado],
      );
    } else {
      await this.admin.query(
        `insert into auth.totp (usuario_id, pendiente_cifrado, pendiente_version, pendiente_expira) values ($1, $2, 1, ${expira})`,
        [usuarioId, cifrado],
      );
    }
    return cifrado;
  }

  async codigos(usuarioId: string, n = 10): Promise<Buffer[]> {
    const hs = Array.from({ length: n }, hash32);
    for (const h of hs) await this.admin.query("insert into auth.totp_recuperacion (usuario_id, hash) values ($1, $2)", [usuarioId, h]);
    return hs;
  }

  /** Un usuario con una membresia (activa) del rol dado en el estudio A. */
  async usuarioConRol(rol: string, o: { desactivada?: boolean } = {}): Promise<{ id: string; correo: string }> {
    const u = await this.usuario({ estudios: [] });
    await this.admin.query("insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, $3)", [tenantDe("A"), u.id, rol]);
    if (o.desactivada) await this.admin.query("update membresia set desactivada_en = now() where usuario_id = $1", [u.id]);
    return { id: u.id, correo: u.correo };
  }

  async adminPlataforma(usuarioId: string): Promise<void> {
    await this.admin.query("insert into admin_plataforma (usuario_id) values ($1)", [usuarioId]);
    this.admins.push(usuarioId);
  }

  async filaTotp(usuarioId: string): Promise<Record<string, any> | undefined> {
    return (await this.admin.query("select * from auth.totp where usuario_id = $1", [usuarioId])).rows[0];
  }
  async filasCodigos(usuarioId: string): Promise<Array<{ hash: Buffer; usado_en: Date | null }>> {
    return (await this.admin.query("select hash, usado_en from auth.totp_recuperacion where usuario_id = $1 order by id", [usuarioId])).rows;
  }
  async eventos(usuarioId: string): Promise<string[]> {
    return (await this.admin.query("select tipo from auth.cuenta_evento where usuario_id = $1 order by creado_en, id", [usuarioId])).rows.map(
      (r) => r.tipo as string,
    );
  }
  async filaSesion(token: Buffer): Promise<Record<string, any> | undefined> {
    return (await this.admin.query("select * from auth.sesion where token_hash = $1", [token])).rows[0];
  }
  async sesionesDe(usuarioId: string): Promise<Array<Record<string, any>>> {
    return (await this.admin.query("select * from auth.sesion where usuario_id = $1 order by creada_en, id", [usuarioId])).rows;
  }
  /** Contador de 004 D7 del correo (clave = sha256 del correo): fallos y bloqueo. */
  async intentos(correo: string): Promise<{ fallos: number; bloqueado: boolean } | undefined> {
    const r = await this.admin.query(
      "select fallos, (bloqueado_hasta is not null and bloqueado_hasta > now()) as bloqueado from auth.intento_login where clave = $1",
      [this.clave(correo)],
    );
    return r.rows[0] === undefined ? undefined : { fallos: Number(r.rows[0].fallos), bloqueado: r.rows[0].bloqueado as boolean };
  }
  async sembrarFallos(correo: string, fallos: number): Promise<void> {
    await this.admin.query(
      `insert into auth.intento_login (clave, fallos, ventana_inicio) values ($1, $2, now())
       on conflict (clave) do update set fallos = excluded.fallos, ventana_inicio = now(), bloqueado_hasta = null`,
      [this.clave(correo), fallos],
    );
  }

  override async limpiar(): Promise<void> {
    // Los usuarios propios del escenario ya estan registrados en la clase base (no se exponen): se borran por correo con la marca.
    const marca = `t5-${this.marca}-%@auth.test`;
    await this.admin
      .query("delete from admin_plataforma where usuario_id in (select id from usuario where email like $1)", [marca])
      .catch(() => undefined);
    await super.limpiar();
  }
}

/** Lo que fija el rojo: una funcion que no existe sale como 42883 y esa es "la razon correcta" del rojo de las pruebas de BD. */
export const FALTA_FUNCION = "42883";

/** Variante async de `medirEscala` (packages/domain/tests/ayudas/rendimiento.ts): tiempo de pared, minimo de varias corridas. */
export async function minimoDe(corridas: number, f: () => Promise<unknown>): Promise<number> {
  await f(); // calentamiento
  let min = Infinity;
  for (let i = 0; i < corridas; i++) {
    const t0 = performance.now();
    await f();
    min = Math.min(min, performance.now() - t0);
  }
  return min;
}

export async function insertarSesionesAjenas(admin: Pool, n: number): Promise<string> {
  // n sesiones de un usuario ajeno sintetico por lote (generate_series): ruido que la consulta de OTRO usuario no debe pagar.
  const marca = randomUUID().slice(0, 8);
  const u = await admin.query(`insert into usuario (email, nombre) values ($1, 'Ruido T1') returning id`, [`t1-ruido-${marca}@auth.test`]);
  await admin.query(
    `insert into auth.sesion (token_hash, usuario_id, creada_en, ultimo_uso, expira_absoluta)
     select sha256(convert_to($2::text || g::text, 'UTF8')), $1, now(), now(), now() + interval '12 hours' from generate_series(1, $3::int) g`,
    [u.rows[0].id, `ruido-${marca}-`, n],
  );
  return u.rows[0].id as string;
}
