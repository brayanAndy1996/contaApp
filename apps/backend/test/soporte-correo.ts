/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD y cuerpos JSON dinámicos en pruebas */
// Soporte de las pruebas HTTP de la spec 028 (T6, rojo): preferencias de correo (`GET|PUT /cuenta/correo`) y baja pública
// (`POST|GET /correo/baja`). Encima de `soporte-acceso.ts` (estudios, miembros por rol con sesión, clientes, asignaciones). No es una
// prueba ni código de producción. Solo usa el contrato público (HTTP y las tablas/funciones del plan 028, «Contratos: BD»).
//
// CONTRATO QUE FIJA T6 (lo implementa T12 sobre las funciones de T10; donde el plan deja algo abierto, la decisión está marcada [T6]):
//  - Vista (`GET`/`PUT /cuenta/correo`): EXACTAMENTE las nueve claves de `PreferenciasCorreoVista`. `todosClientes` es la marca guardada;
//    `todosDisponible` = rol dueño o admin y sin asignaciones; `todosIgnorado` = marca guardada y no disponible [T6]. Sin filas, la
//    efectiva inicial de R-15 (planLimite solo Dueño) y `invitacionResumen: true`; cualquier `PUT` crea las cuatro filas y la apaga.
//    `GET` no escribe nada. `Cache-Control: no-store` en todas las respuestas (también en errores).
//  - `PUT`: cuerpo `preferenciasCorreoSchema` (`.strict()`, las cinco claves, booleanos): otra cosa es 400 `solicitud_invalida` y no
//    cambia nada. `todosClientes: true` con rol sin permiso es 403 `permiso_denegado`; con asignaciones, 409 `todos_clientes_no_disponible`;
//    en ambos casos el `PUT` entero se revierte (nada se guarda a medias). Cada cambio REAL (contra la efectiva) deja
//    `correo.preferencia_cambiada` con actor el usuario y `datos` exactamente `{tipo, de, a, origen}`; `tipo` es el de la fila o
//    `resumen_todos`. Apagar un tipo deja `omitido` `preferencia_apagada` sus envíos pendientes (D-7).
//  - `POST /correo/baja` con `{token}` (JSON): 200 `{}` con token válido o no (inexistente, alterado de la misma longitud, vencido, el hash
//    almacenado usado como token), misma forma exacta; 400 `solicitud_invalida` solo si el cuerpo no cumple `bajaSchema`; 429
//    `demasiados_intentos` pasado el límite por IP (sin tocar nada). Sin sesión, sin CSRF.
//  - `POST /correo/baja?t=<token>` con cuerpo `application/x-www-form-urlencoded` exacto `List-Unsubscribe=One-Click` (RFC 8058): aplica la
//    baja; con cualquier otro cuerpo, 200 `{}` sin efectos; el estado es siempre 200 `{}` (o 429). SIN `Origin` ni `Sec-Fetch-Site` (el
//    servidor del correo no los manda): la ruta queda fuera de `OrigenGuard`. Un cuerpo `application/json` es siempre la variante de la
//    página (`bajaSchema`, 400 si no es `{token}`); el contador de IP es el mismo para las dos [T6].
//  - `GET /correo/baja` (con o sin `?t=`): 405, sin efectos y sin eco del token.
//  - Hash del token [T6]: SHA-256 del TEXTO del token (43 caracteres base64url, en UTF-8), igual que `hashToken` de `auth/sesion/token.ts`
//    y que los tokens de 004; el worker genera `randomBytes(32).toString("base64url")` y guarda ese hash con `correo_baja_token_crear`.
//  - La baja audita `{tipo, de: true, a: false, origen: "enlace"}` con actor el dueño del token, solo si cambió algo; nunca activa.
//
// Hechos reales (reglas comunes de 028): los avisos se registran con `interno.notificar` (como el trigger de 0056) y el envío `fallido` se
// obtiene con las funciones del worker (`correo_envio_tomar`/`correo_envio_cerrar`); lo único que se inserta directo son los envíos
// `enviado` que dan dónde colgar un token de baja (el correo ya salió) y las preferencias iniciales de HU-40. Las marcas de tiempo se
// mueven como superusuario sobre filas ya creadas (ninguna prueba duerme).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createDb, type ContappDb } from "@contapp/db";
import type { Actor, Banco, RolSistema } from "./soporte-acceso.js";

export type Sql = <T = any>(texto: string, valores?: unknown[]) => Promise<T[]>;

export type TipoCorreo = "buzon_critico" | "credencial_invalida" | "plan_limite" | "resumen";
export const ACCION = "correo.preferencia_cambiada";
/** Las tablas del estudio de 028 con FK a `tenant` (la limpieza común las borra con `replica`). */
export const TABLAS_CORREO_ESTUDIO = ["correo_baja_token", "correo_envio_aviso", "correo_envio", "correo_preferencia"] as const;

/** Las nueve claves de `PreferenciasCorreoVista`, ordenadas. */
export const CLAVES_VISTA = [
  "buzonCritico",
  "credencialInvalida",
  "invitacionResumen",
  "planLimite",
  "resumen",
  "todosClientes",
  "todosDisponible",
  "todosIgnorado",
  "ultimoEnvioFallido",
] as const;

/** Cuerpo de `PUT /cuenta/correo` con los valores iniciales de R-15 (por rol) y los cambios dados. */
export interface Prefs {
  buzonCritico: boolean;
  credencialInvalida: boolean;
  planLimite: boolean;
  resumen: boolean;
  todosClientes: boolean;
}
export const inicial = (rol: RolSistema): Prefs => ({
  buzonCritico: true,
  credencialInvalida: true,
  planLimite: rol === "dueno",
  resumen: false,
  todosClientes: false,
});
export const prefs = (rol: RolSistema, cambios: Partial<Prefs> = {}): Prefs => ({ ...inicial(rol), ...cambios });

/** Vista que devuelve la API a quien no tiene filas ni envíos: la inicial por rol, con «todos» disponible a Dueño/Admin sin asignaciones. */
export const vistaInicial = (rol: RolSistema, sinAsignaciones = true) => ({
  ...inicial(rol),
  todosDisponible: (rol === "dueno" || rol === "admin") && sinAsignaciones,
  todosIgnorado: false,
  invitacionResumen: true,
  ultimoEnvioFallido: null,
});

/** `Cache-Control` con `no-store`. */
export const esNoStore = (valor: unknown): boolean => /no-store/.test(String(valor ?? ""));

/** Token de baja: 32 bytes en base64url (43 caracteres) y su hash (SHA-256 del texto, en UTF-8). */
export const tokenNuevo = (): string => randomBytes(32).toString("base64url");
export const hashDeToken = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();
/** Cambia un carácter del token (misma longitud, mismo alfabeto): el «alterado» de CA-8. */
export const alterar = (token: string): string => `${token.startsWith("A") ? "B" : "A"}${token.slice(1)}`;

/** Conexión del worker (rol `contapp_worker`) para ejercer las funciones reales del ciclo de envío. */
export function abrirWorker(): ContappDb {
  return createDb({ rolApp: "contapp_worker", poolMax: 2 });
}

/** Filas de `auditoria` de la preferencia de correo del estudio (de la más vieja a la más nueva). */
export const auditoriaPreferencia = (sql: Sql, tenantId: string, usuarioId?: string) =>
  sql<{ usuario_id: string | null; actor_tipo: string; datos: Record<string, unknown>; tenant_id: string }>(
    `select tenant_id, usuario_id, actor_tipo, datos from auditoria
      where tenant_id = $1 and accion = $2 and ($3::uuid is null or usuario_id = $3) order by ocurrida_en, id`,
    [tenantId, ACCION, usuarioId ?? null],
  );

/** Filas de `correo_preferencia` de un usuario en un estudio, por tipo. */
export const filasPreferencia = (sql: Sql, tenantId: string, usuarioId: string) =>
  sql<{ tipo: string; activo: boolean; todos_clientes: boolean }>(
    "select tipo, activo, todos_clientes from correo_preferencia where tenant_id = $1 and usuario_id = $2 order by tipo",
    [tenantId, usuarioId],
  );

/** Un envío `enviado` (el correo ya salió) de relleno para colgar un token de baja. Devuelve su id. */
export async function sembrarEnvio(
  sql: Sql,
  o: { tenantId: string; usuarioId: string; tipo?: TipoCorreo; estado?: "enviado" | "fallido"; hace?: string },
): Promise<string> {
  const tipo = o.tipo ?? "buzon_critico";
  const origen = tipo === "resumen" ? "resumen" : "aviso";
  const hace = o.hace ?? "1 minute";
  const f = await sql<{ id: string }>(
    `insert into correo_envio (tenant_id, usuario_id, origen, tipo, estado, motivo, clave, programado_para, intentos, total_avisos, dia_lima,
                               creado_en, enviado_en)
     values ($1, $2, $3, $4, $5, $6, $3 || ':' || $2::text || ':' || $4 || ':' || gen_random_uuid()::text,
             clock_timestamp() - $7::interval, 1, 1,
             case when $3 = 'resumen' then (clock_timestamp() at time zone 'America/Lima')::date end,
             clock_timestamp() - $7::interval,
             case when $5 = 'enviado' then clock_timestamp() - $7::interval end)
     returning id`,
    [o.tenantId, o.usuarioId, origen, tipo, o.estado ?? "enviado", o.estado === "fallido" ? "transporte" : null, hace],
  );
  return f[0]!.id;
}

export interface TokenSembrado {
  token: string;
  hash: Buffer;
  envioId: string;
  tenantId: string;
  usuarioId: string;
  tipo: TipoCorreo;
}
/** Token de baja de (estudio, usuario, tipo) colgado de un envío propio, vigente 90 días (`venceEn: "vencido"` lo deja vencido). */
export async function sembrarToken(
  sql: Sql,
  o: { tenantId: string; usuarioId: string; tipo?: TipoCorreo; venceEn?: "vigente" | "vencido"; envioId?: string },
): Promise<TokenSembrado> {
  const tipo = o.tipo ?? "buzon_critico";
  const envioId = o.envioId ?? (await sembrarEnvio(sql, { tenantId: o.tenantId, usuarioId: o.usuarioId, tipo, hace: "100 days" }));
  const token = tokenNuevo();
  const hash = hashDeToken(token);
  await sql(
    `insert into correo_baja_token (tenant_id, hash, usuario_id, tipo, envio_id, creado_en, vence_en)
     values ($1, $2, $3, $4, $5,
             case when $6 = 'vencido' then clock_timestamp() - interval '91 days' else clock_timestamp() - interval '1 minute' end,
             case when $6 = 'vencido' then clock_timestamp() - interval '1 day' else clock_timestamp() + interval '90 days' end)`,
    [o.tenantId, hash, o.usuarioId, tipo, envioId, o.venceEn ?? "vigente"],
  );
  return { token, hash, envioId, tenantId: o.tenantId, usuarioId: o.usuarioId, tipo };
}

/** Devuelve un token vencido a vigente (prueba de que fallaba por vencido y no por otra cosa). */
export const vigentear = (sql: Sql, t: TokenSembrado) =>
  sql("update correo_baja_token set creado_en = clock_timestamp() - interval '1 minute', vence_en = clock_timestamp() + interval '90 days' where hash = $1", [t.hash]);

/** Un aviso real: `interno.notificar` (como los triggers de 0056) para los destinatarios; crea la notificación y registra el aviso de correo. */
export async function notificarAviso(
  sql: Sql,
  o: { tenantId: string; usuarios: string[]; tipo: Exclude<TipoCorreo, "resumen">; clienteId?: string | null },
): Promise<void> {
  const params =
    o.tipo === "plan_limite"
      ? { recurso: "rucs", umbral: 90, usado: 9, limite: 10 }
      : o.tipo === "credencial_invalida"
        ? { credencial: "sol" }
        : { categoria: "coactiva", mensajeId: randomUUID() };
  await sql("select interno.notificar($1::uuid, $2::uuid[], $3::text, $4::uuid, null, $5::jsonb, $6::text)", [
    o.tenantId,
    o.usuarios,
    o.tipo,
    o.tipo === "plan_limite" ? null : (o.clienteId ?? null),
    JSON.stringify(params),
    `${o.tipo}:t6:${randomUUID()}`,
  ]);
}

/** El envío más reciente de (estudio, usuario, tipo) y su estado. */
export const ultimoEnvio = async (sql: Sql, tenantId: string, usuarioId: string, tipo: TipoCorreo) =>
  (
    await sql<{ id: string; estado: string; motivo: string | null }>(
      "select id, estado, motivo from correo_envio where tenant_id = $1 and usuario_id = $2 and tipo = $3 order by creado_en desc, id desc limit 1",
      [tenantId, usuarioId, tipo],
    )
  )[0];

/** Un envío `fallido` REAL: aviso registrado por `interno.notificar` y cerrado por las funciones del worker (3 intentos, `transporte`). */
export async function provocarFallido(
  sql: Sql,
  worker: ContappDb,
  o: { tenantId: string; usuarioId: string; clienteId: string },
): Promise<string> {
  await notificarAviso(sql, { tenantId: o.tenantId, usuarios: [o.usuarioId], tipo: "credencial_invalida", clienteId: o.clienteId });
  const e = await ultimoEnvio(sql, o.tenantId, o.usuarioId, "credencial_invalida");
  if (!e || e.estado !== "pendiente") throw new Error("el aviso real no dejó un envío pendiente");
  await cerrarEnvio(worker, o.tenantId, e.id, "fallido", "transporte", 3);
  return e.id;
}

/** Cierra un envío como lo haría el worker: tomarlo (suma un intento) `intentos` veces y `correo_envio_cerrar`. */
export async function cerrarEnvio(
  worker: ContappDb,
  tenantId: string,
  envioId: string,
  estado: "enviado" | "fallido",
  motivo: string | null,
  intentos = 1,
): Promise<void> {
  await worker.withTenant({ tenantId }, async (tx) => {
    for (let i = 0; i < intentos; i++) await tx.query("select correo_envio_tomar($1::uuid)", [envioId]);
    await tx.query("select correo_envio_cerrar($1::uuid, $2::text, $3::text, null)", [envioId, estado, motivo]);
  });
}

/** El mismo usuario también miembro de otro estudio, con su sesión en él (para «dos estudios»: R-4, CA-5). */
export async function tambienEn(b: Banco, a: Actor, tenantId: string, rol: RolSistema): Promise<Actor> {
  await b.sql("insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, $3)", [tenantId, a.id, rol]);
  const s = await b.sesion({ id: a.id, correo: a.correo, contrasena: a.contrasena }, tenantId);
  return { ...a, rol, tenantId, ...s };
}

/** Borra por estudio las filas de las cuatro tablas de 028 (para los estudios del seed, que no se pueden borrar enteros). */
export async function borrarCorreoDeEstudios(sql: Sql, tenantIds: readonly string[]): Promise<void> {
  for (const t of TABLAS_CORREO_ESTUDIO)
    await sql(`delete from ${t} where tenant_id = any($1::uuid[])`, [[...tenantIds]]).catch(() => undefined);
}
