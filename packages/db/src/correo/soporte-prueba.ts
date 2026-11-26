// Soporte de las pruebas de BD de la spec 028 (T4, rojo): estudios, usuarios, clientes, avisos, descargas, periodos y mensajes
// sembrados POR SU CAMINO REAL (no insertando filas de `correo_*`), un arnés de contexto (backend con usuario, worker, sistema y
// auth), un espía de consultas, el oráculo en memoria del resumen y la traducción de errores con una `tx` falsa.
// No es una prueba (sin sufijo .spec) ni código de producción (queda fuera de `tsconfig.build.json`). Necesita DATABASE_URL (rol de
// la app) y MIGRATIONS_DATABASE_URL (superusuario: pasa por FK y CHECK, no por RLS ni grants); si faltan, la suite FALLA.
// Datos sintéticos: ningún RUC ni razón social reales.
//
// HECHOS REALES (lección de 027, T12a):
//   - Avisos: `capturarCriticos` inserta mensajes críticos como el worker (rol contapp_worker, con `app.trabajo_id`) para que los
//     triggers de 0056 llamen a `interno.notificar`; `invalidarCredencial` usa `marcarCredencialInvalida`; `llevarAlNoventaDelPlan`
//     inserta clientes hasta el 90 % del plan y deja que los triggers de 0043 llamen a `plan_aviso_recalcular`. Nunca se inserta en
//     `correo_envio`, `correo_envio_aviso` ni `correo_baja_token`.
//   - Resumen anterior: `crearResumenDelDia` usa `crearResumenesCorreo` y el cierre con `cerrarEnvio`, así `corte_hasta` es el que
//     produce el sistema. Preferencias: `fijarPreferencias`. Asignaciones, archivado y desactivación: las funciones de 005/007a.
//   - Descargas: un `sire.propuesta.descargar` llevado a `completado` por `insertarTrabajo` y `transicionar` (008).
//   - Se siembran directo (superusuario) solo los hechos sin función de escritura para esta prueba: periodos (`compra_periodo`,
//     `venta_periodo`), mensajes del resumen (con `session_replication_role = replica` para fijar `historico`, `atendido_en` y
//     `primera_captura_en` a voluntad) y la credencial cifrada de relleno. Las marcas de tiempo de lo ya creado se mueven con el
//     superusuario (ninguna prueba duerme).
//
// LIMPIEZA (lección de 026: un estudio de prueba que deja filas en una tabla con FK a `tenant` hace fallar `planes.spec.ts` en CI):
// con `session_replication_role = replica` (sin disparadores de inmutabilidad ni FK) se borra, para el estudio, TODA tabla pública con
// columna `tenant_id` (descubierta en `information_schema`: cubre `correo_preferencia`, `correo_envio`, `correo_envio_aviso` y
// `correo_baja_token` y cualquiera que se agregue después), luego su suscripción y plan propios, los usuarios y el estudio. Si el
// estudio sigue existiendo, `limpiar` lanza: una fuga se ve.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { asignar, retirar } from "../acceso/asignaciones";
import { desactivar } from "../acceso/miembros";
import { createDb, type ContappDb, type RolApp } from "../client";
import { archivarCliente } from "../clientes/repositorio";
import { marcarCredencialInvalida } from "../credenciales/estado";
import { errorPg, txFalso } from "../trabajos/soporte-prueba";
import { insertarTrabajo, transicionar } from "../trabajos/registro";
import type { Tx } from "../with-tenant";
import { CorreoRepoError } from "./errores";
import {
  cerrarEnvio,
  crearResumenesCorreo,
  fijarPreferencias,
  type ClienteResumen,
  type EstadoPeriodoResumen,
  type ParametrosResumen,
  type PreferenciasAFijar,
} from "./index";

const VARIABLES = ["DATABASE_URL", "MIGRATIONS_DATABASE_URL"] as const;

/** Falla (no salta) si faltan las URLs de la BD. */
export function exigirEntorno(): void {
  const faltan = VARIABLES.filter((v) => !process.env[v]);
  if (faltan.length > 0) {
    throw new Error(
      `Faltan variables de entorno para las pruebas de BD de correo: ${faltan.join(", ")}`,
    );
  }
}

export function abrirAdmin(): Pool {
  const p = new Pool({
    connectionString: process.env.MIGRATIONS_DATABASE_URL,
    max: 4,
  });
  p.on("error", () => undefined);
  return p;
}

export const abrirDb = (rolApp: RolApp): ContappDb =>
  createDb({ rolApp, poolMax: 4 });

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Centinelas que no deben aparecer en nada que devuelva el repositorio (R-6, R-8). */
export const ASUNTO_CANARIO = "ASUNTO-CANARIO-NO-SALE";

export type Rol = "dueno" | "admin" | "contador" | "asistente" | "lectura";
export type Libro = "compras" | "ventas";

// ---- Estudio, usuarios y clientes -----------------------------------------------------------------------------------------
export interface UsuarioSembrado {
  id: string;
  email: string;
  nombre: string;
  rol: Rol;
}

export interface ClienteSembrado {
  id: string;
  ruc: string;
  razonSocial: string;
}

export interface OpcionesEstudio {
  /** Límite de RUC del plan propio del estudio (por omisión 100000: ningún aviso de plan). */
  maxRucs?: number;
  /** `plan.features` (R-12: ausente = habilitado). */
  features?: Record<string, unknown>;
  /** Suscripción: `activa` (por omisión), `prueba` (vigente), `prueba_vencida` o `null` (sin suscripción). */
  suscripcion?: "activa" | "prueba" | "prueba_vencida" | null;
}

export interface Estudio {
  tenantId: string;
  nombre: string;
  dueno: UsuarioSembrado;
  contador: UsuarioSembrado;
  /** Usuario nuevo con membresía en este estudio (activa, salvo `desactivada`). */
  nuevoUsuario(
    rol: Rol,
    o?: { desactivada?: boolean },
  ): Promise<UsuarioSembrado>;
  /** Da al usuario (de otro estudio) una membresía activa en este. */
  unir(u: UsuarioSembrado, rol: Rol): Promise<void>;
  /** Cliente nuevo del estudio (cada prueba usa el suyo). */
  nuevoCliente(o?: { razonSocial?: string }): Promise<ClienteSembrado>;
  limpiar(): Promise<void>;
}

const IDENTIFICADOR = /^[a-z_][a-z0-9_]*$/;

export async function sembrarEstudio(
  admin: Pool,
  o: OpcionesEstudio = {},
): Promise<Estudio> {
  const marca = randomBytes(3).toString("hex");
  const tenantId = randomUUID();
  const nombre = `Estudio T4 028 ${marca}`;
  const prefijo = String(parseInt(marca, 16) % 100_000).padStart(5, "0");
  const usuarios: string[] = [];
  let planId: string | null = null;
  let secuencia = 0;

  const crearUsuario = async (
    rol: Rol,
    desactivada: boolean,
  ): Promise<UsuarioSembrado> => {
    const n = ++secuencia;
    const u: UsuarioSembrado = {
      id: randomUUID(),
      email: `t4-${marca}-${n}-${rol}@ejemplo.test`,
      nombre: `${rol} T4 ${marca}-${n}`,
      rol,
    };
    await admin.query(
      "insert into usuario (id, email, nombre) values ($1, $2, $3)",
      [u.id, u.email, u.nombre],
    );
    usuarios.push(u.id);
    await admin.query(
      `insert into membresia (tenant_id, usuario_id, rol, desactivada_en)
       values ($1, $2, $3, case when $4::boolean then now() else null end)`,
      [tenantId, u.id, rol, desactivada],
    );
    return u;
  };

  const limpiar = async (): Promise<void> => {
    const c = await admin.connect();
    try {
      await c.query("SET session_replication_role = replica");
      const tablas = await c.query(
        `select c.table_name from information_schema.columns c
           join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
          where c.table_schema = 'public' and c.column_name = 'tenant_id' and t.table_type = 'BASE TABLE'
          order by c.table_name`,
      );
      for (const { table_name: tabla } of tablas.rows as Array<{
        table_name: string;
      }>) {
        if (!IDENTIFICADOR.test(tabla)) continue;
        // eslint-disable-next-line sql-crudo/sin-sql-crudo -- identificador de information_schema validado con IDENTIFICADOR; solo en la limpieza de la prueba
        await c.query(`delete from public."${tabla}" where tenant_id = $1`, [
          tenantId,
        ]);
      }
      if (planId !== null)
        await c.query("delete from plan where id = $1", [planId]);
      await c.query("delete from usuario where id = any($1::uuid[])", [
        usuarios,
      ]);
      await c.query("delete from tenant where id = $1", [tenantId]);
      const quedan = await c.query("select 1 from tenant where id = $1", [
        tenantId,
      ]);
      if (quedan.rowCount !== 0)
        throw new Error("la limpieza no pudo borrar el estudio de la prueba");
    } finally {
      c.release(true); // la conexión con session_replication_role = replica no vuelve al pool
    }
  };

  try {
    await admin.query("insert into tenant (id, nombre) values ($1, $2)", [
      tenantId,
      nombre,
    ]);
    const estado = o.suscripcion === undefined ? "activa" : o.suscripcion;
    if (estado !== null) {
      planId = randomUUID();
      await admin.query(
        `insert into plan (id, codigo, nombre, precio_mensual, max_rucs, max_usuarios, precio_ruc_extra, max_rucs_extra,
                           frecuencia_buzon_min, features, activo)
         values ($1, $2, $3, '10.00', $4, 1000, '0', 0, 1440, $5::jsonb, true)`,
        [
          planId,
          `t4_${marca}`,
          `Plan T4 ${marca}`,
          o.maxRucs ?? 100_000,
          JSON.stringify(o.features ?? {}),
        ],
      );
      await admin.query(
        `insert into suscripcion (tenant_id, plan_id, estado, prueba_vence_en)
         values ($1, $2, $3, case $4 when 'activa' then null when 'prueba' then now() + interval '30 days'
                                     else now() - interval '1 day' end)`,
        [tenantId, planId, estado === "activa" ? "activa" : "prueba", estado],
      );
    }
    const dueno = await crearUsuario("dueno", false);
    const contador = await crearUsuario("contador", false);
    return {
      tenantId,
      nombre,
      dueno,
      contador,
      nuevoUsuario: (rol, op = {}) =>
        crearUsuario(rol, op.desactivada === true),
      unir: async (u, rol) => {
        await admin.query(
          "insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, $3)",
          [tenantId, u.id, rol],
        );
        usuarios.push(u.id);
      },
      nuevoCliente: async (op = {}) => {
        const cliente: ClienteSembrado = {
          id: randomUUID(),
          ruc: `3${prefijo}${String(++secuencia).padStart(5, "0")}`,
          razonSocial: op.razonSocial ?? `Cliente T4 ${marca}-${secuencia}`,
        };
        await admin.query(
          "insert into cliente (id, tenant_id, ruc, razon_social) values ($1, $2, $3, $4)",
          [cliente.id, tenantId, cliente.ruc, cliente.razonSocial],
        );
        return cliente;
      },
      limpiar,
    };
  } catch (e) {
    await limpiar().catch(() => undefined);
    throw e;
  }
}

// ---- Arnés común de las suites ---------------------------------------------------------------------------------------------
export interface Arnes {
  admin: Pool;
  backend: ContappDb;
  worker: ContappDb;
  /** Estudios de las pruebas (con suscripción activa) y un tercero para usuarios en dos estudios. */
  A: Estudio;
  B: Estudio;
  nuevoEstudio(o?: OpcionesEstudio): Promise<Estudio>;
  /** Backend con `u` como usuario (cualquier rol) en el estudio `e`. */
  comoUsuario<T>(
    e: Estudio,
    u: UsuarioSembrado,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T>;
  /** Backend sin usuario en el contexto. */
  sinUsuario<T>(e: Estudio, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Worker en el estudio `e` (con `trabajoId`, el trabajo del contexto de 017). */
  comoWorker<T>(
    e: Estudio,
    fn: (tx: Tx) => Promise<T>,
    trabajoId?: string,
  ): Promise<T>;
  /** Worker sin estudio (`sistema.*`). */
  sistema<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  cerrar(): Promise<void>;
}

export async function abrirArnes(): Promise<Arnes> {
  exigirEntorno();
  const admin = abrirAdmin();
  const backend = abrirDb("contapp_backend");
  const worker = abrirDb("contapp_worker");
  const limpiezas: Array<() => Promise<void>> = [];
  const cerrarTodo = async (): Promise<unknown[]> => {
    const errores: unknown[] = [];
    for (const l of limpiezas) await l().catch((x: unknown) => errores.push(x));
    await backend.close();
    await worker.close();
    await admin.end();
    return errores;
  };
  const nuevo = async (o?: OpcionesEstudio): Promise<Estudio> => {
    const e = await sembrarEstudio(admin, o);
    limpiezas.push(e.limpiar);
    return e;
  };
  try {
    const A = await nuevo();
    const B = await nuevo();
    return {
      admin,
      backend,
      worker,
      A,
      B,
      nuevoEstudio: nuevo,
      comoUsuario: (e, u, fn) =>
        backend.withTenant({ tenantId: e.tenantId, userId: u.id }, fn),
      sinUsuario: (e, fn) => backend.withTenant({ tenantId: e.tenantId }, fn),
      comoWorker: (e, fn, trabajoId) =>
        worker.withTenant(
          {
            tenantId: e.tenantId,
            ...(trabajoId === undefined ? {} : { trabajoId }),
          },
          fn,
        ),
      sistema: (fn) => worker.withSistema(fn),
      cerrar: async () => {
        const errores = await cerrarTodo();
        if (errores.length > 0) throw errores[0];
      },
    };
  } catch (x) {
    await cerrarTodo();
    throw x;
  }
}

/** Cuenta las consultas que pasan por `tx` (la `tx` real sigue ejecutándolas). */
export function espiar(tx: Tx): { tx: Tx; consultas: () => number } {
  let n = 0;
  const original = tx.query.bind(tx);
  const envuelta = new Proxy(tx, {
    get(destino, prop, receptor) {
      if (prop === "query")
        return (...args: unknown[]) => {
          n++;
          return (original as (...a: unknown[]) => unknown)(...args);
        };
      return Reflect.get(destino, prop, receptor) as unknown;
    },
  });
  return { tx: envuelta, consultas: () => n };
}

// ---- Acciones del estudio por sus funciones de 005 / 007a -----------------------------------------------------------------
export async function asignarCliente(
  h: Arnes,
  e: Estudio,
  c: ClienteSembrado,
  u: UsuarioSembrado,
  tipo: "responsable" | "colaborador",
): Promise<void> {
  await h.comoUsuario(e, e.dueno, (tx) =>
    asignar(tx, { clienteId: c.id, usuarioId: u.id, tipo }),
  );
}

export async function retirarAsignacion(
  h: Arnes,
  e: Estudio,
  c: ClienteSembrado,
  u: UsuarioSembrado,
): Promise<void> {
  await h.comoUsuario(e, e.dueno, (tx) =>
    retirar(tx, { clienteId: c.id, usuarioId: u.id }),
  );
}

export async function archivar(
  h: Arnes,
  e: Estudio,
  c: ClienteSembrado,
): Promise<void> {
  await h.comoUsuario(e, e.dueno, (tx) => archivarCliente(tx, c.id));
}

export async function desactivarMiembro(
  h: Arnes,
  e: Estudio,
  u: UsuarioSembrado,
): Promise<void> {
  await h.comoUsuario(e, e.dueno, (tx) => desactivar(tx, u.id));
}

/** Preferencias por su función real (`correo_preferencias_fijar`). */
export async function fijar(
  h: Arnes,
  e: Estudio,
  u: UsuarioSembrado,
  p: Partial<PreferenciasAFijar>,
): Promise<void> {
  const base: PreferenciasAFijar = {
    buzonCritico: true,
    credencialInvalida: true,
    planLimite: u.rol === "dueno",
    resumen: false,
    todosClientes: false,
  };
  await h.comoUsuario(e, u, (tx) => fijarPreferencias(tx, { ...base, ...p }));
}

// ---- Avisos por su camino real ------------------------------------------------------------------------------------------------
/** Trabajo `sol.buzon.revisar` en ejecución del cliente (el contexto `app.trabajo_id` del worker que captura). */
export async function trabajoBuzon(
  h: Arnes,
  e: Estudio,
  c: ClienteSembrado,
): Promise<string> {
  const id = randomUUID();
  await h.admin.query(
    `insert into job_registro (id, tenant_id, cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe,
                               max_intentos, iniciado_en)
     values ($1, $2, $3, $4, 'sol.buzon.revisar', 'sol', 'sol', 'programado', 'ejecutando', '{}'::jsonb, $5, 3, now())`,
    [id, e.tenantId, c.id, c.ruc, randomBytes(32)],
  );
  return id;
}

/**
 * `n` mensajes críticos nuevos del cliente, insertados como el worker (con `app.trabajo_id`): los triggers de 0056 llaman a
 * `interno.notificar`. Devuelve los ids de los mensajes y la fecha del mensaje (por omisión hace 3 días, en milisegundos).
 */
export async function capturarCriticos(
  h: Arnes,
  e: Estudio,
  c: ClienteSembrado,
  n = 1,
  o: { fecha?: Date } = {},
): Promise<{ ids: string[]; fecha: Date }> {
  const fecha =
    o.fecha ?? new Date(Math.floor(Date.now() / 1000) * 1000 - 3 * 86_400_000);
  const trabajoId = await trabajoBuzon(h, e, c);
  const ids = await h.comoWorker(
    e,
    async (tx) => {
      const r = await tx.query(
        `insert into buzon_mensaje (cliente_id, id_sunat, asunto, remitente, fecha, categoria, critico, motivo_critico,
                                    version_catalogo, avisado)
         select $1::uuid, 'T4-' || gen_random_uuid()::text, $2, 'SUNAT', $3::timestamptz, 'coactiva', true, 'codigo', 1, true
           from generate_series(1, $4::int)
         returning id`,
        [c.id, ASUNTO_CANARIO, fecha, n],
      );
      return r.rows.map((f) => String(f.id));
    },
    trabajoId,
  );
  return { ids, fecha };
}

/** Credencial SOL del cliente marcada inválida con `marcarCredencialInvalida` (aviso `credencial_invalida`). */
export async function invalidarCredencial(
  h: Arnes,
  e: Estudio,
  c: ClienteSembrado,
): Promise<void> {
  await h.admin.query(
    `insert into credencial (tenant_id, cliente_id, tipo, ciphertext, nonce, tag, dek_envuelta, kek_id, estado)
     values ($1, $2, 'sol', $3, $4, $5, $6, 't4-kek', 'verificada')`,
    [
      e.tenantId,
      c.id,
      randomBytes(32),
      randomBytes(12),
      randomBytes(16),
      randomBytes(48),
    ],
  );
  const marcada = await h.comoWorker(e, (tx) =>
    marcarCredencialInvalida(tx, c.id, "sol"),
  );
  if (!marcada) throw new Error("la credencial no pasó a inválida");
}

/** Estudio con `maxRucs: 10`: inserta clientes hasta 9 de 10 (90 %) y los triggers de 0043 avisan a los Dueños (`plan_limite`). */
export async function llevarAlNoventaDelPlan(
  h: Arnes,
  e: Estudio,
): Promise<void> {
  const { rows } = await h.admin.query(
    "select count(*)::int as n from cliente where tenant_id = $1 and archivado_at is null",
    [e.tenantId],
  );
  const faltan = 9 - Number(rows[0].n);
  if (faltan < 1) throw new Error("el estudio ya pasó del 90 % del plan");
  const marca = randomBytes(3).toString("hex");
  const base = (Date.now() % 100_000) * 100;
  await h.admin.query(
    `insert into cliente (tenant_id, ruc, razon_social)
     select $1, '4' || lpad(($2::bigint + g)::text, 10, '0'), 'Relleno T4 ' || $3 || '-' || g
       from generate_series(1, $4::int) g`,
    [e.tenantId, base, marca, faltan],
  );
}

/** Id del envío de avisos del usuario por tipo que sigue pendiente y sin tomar (el que arma D-2); lanza si no hay exactamente uno. */
export async function envioPendiente(
  h: Arnes,
  e: Estudio,
  u: UsuarioSembrado,
  tipo: "buzon_critico" | "credencial_invalida" | "plan_limite",
): Promise<string> {
  const { rows } = await h.admin.query(
    `select id from correo_envio
      where tenant_id = $1 and usuario_id = $2 and origen = 'aviso' and tipo = $3 and estado = 'pendiente' and tomado_en is null`,
    [e.tenantId, u.id, tipo],
  );
  if (rows.length !== 1)
    throw new Error(
      `se esperaba un envío pendiente de ${tipo} y hay ${rows.length}`,
    );
  return String(rows[0].id);
}

/** Notificación del usuario creada por el mensaje de buzón (clave de dedupe de 0056). */
export async function notificacionDeMensaje(
  h: Arnes,
  e: Estudio,
  u: UsuarioSembrado,
  mensajeId: string,
): Promise<string> {
  const { rows } = await h.admin.query(
    "select id from notificacion where tenant_id = $1 and usuario_id = $2 and clave_dedupe = $3",
    [e.tenantId, u.id, `buzon_critico:${mensajeId}`],
  );
  if (rows.length !== 1)
    throw new Error(`no hay notificación de ${mensajeId} para el usuario`);
  return String(rows[0].id);
}

/** Cierra un envío como lo haría el worker: lo toma y lo cierra. */
export async function cerrarComoWorker(
  h: Arnes,
  e: Estudio,
  envioId: string,
  cierre: Parameters<typeof cerrarEnvio>[2],
): Promise<void> {
  await h.comoWorker(e, (tx) => cerrarEnvio(tx, envioId, cierre));
}

/** Día de Lima de hoy menos `k` días (AAAA-MM-DD), con el reloj de la BD. */
export async function diaLima(h: Arnes, k = 0): Promise<string> {
  const { rows } = await h.admin.query(
    "select to_char((clock_timestamp() at time zone 'America/Lima')::date - $1::int, 'YYYY-MM-DD') as d",
    [k],
  );
  return String(rows[0].d);
}

/** Resumen del día para los usuarios con resumen activo, por `crear_correo_resumenes`; devuelve el id de cada usuario. */
export async function crearResumenDelDia(
  h: Arnes,
  e: Estudio,
  dia: string,
  u: UsuarioSembrado,
): Promise<string> {
  await h.comoWorker(e, (tx) => crearResumenesCorreo(tx, dia));
  const { rows } = await h.admin.query(
    `select id from correo_envio where tenant_id = $1 and usuario_id = $2 and origen = 'resumen' and dia_lima = $3::date`,
    [e.tenantId, u.id, dia],
  );
  if (rows.length !== 1)
    throw new Error(`no se creó el resumen de ${dia} para el usuario`);
  return String(rows[0].id);
}

/** SHA-256 del token y su hex (lo que guarda la BD y lo que recibe `aplicarBaja`). */
export function tokenDeBaja(): { token: string; hash: Buffer; hex: string } {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest();
  return { token, hash, hex: hash.toString("hex") };
}

// ---- Descargas y periodos --------------------------------------------------------------------------------------------------
export type EstadoDescarga =
  "completado" | "error" | "en_cola" | "ejecutando" | "cancelado";

/** `sire.propuesta.descargar` del cliente, libro y periodo, llevado a `estado` por las transiciones de 008. */
export async function descarga(
  h: Arnes,
  e: Estudio,
  c: ClienteSembrado,
  libro: Libro,
  periodo: string,
  estado: EstadoDescarga,
): Promise<string> {
  const vista = await h.comoUsuario(e, e.dueno, (tx) =>
    insertarTrabajo(tx, {
      clienteId: c.id,
      ruc: c.ruc,
      tipo: "sire.propuesta.descargar",
      cola: "sire",
      canal: "sire",
      prioridad: "interactivo",
      parametros: { periodo, libro },
      claveDedupe: randomBytes(32),
      creadoPor: e.dueno.id,
      maxIntentos: 3,
    }),
  );
  const id = vista.id;
  const pasos = (tx: Tx): Promise<boolean> => {
    switch (estado) {
      case "en_cola":
        return Promise.resolve(true);
      case "cancelado":
        return transicionar(tx, id, "en_cola", "cancelado", {
          motivo: "cancelado_usuario",
        });
      default:
        return transicionar(tx, id, "en_cola", "ejecutando");
    }
  };
  const finales = async (tx: Tx): Promise<void> => {
    if (estado === "completado")
      await transicionar(tx, id, "ejecutando", "completado");
    if (estado === "error")
      await transicionar(tx, id, "ejecutando", "error", {
        motivo: "error_interno",
      });
  };
  await h.comoWorker(e, async (tx) => {
    await pasos(tx);
    await finales(tx);
  });
  return id;
}

/** Estado del periodo (compras o ventas) del cliente; sin fila equivale a `abierto`. */
export async function periodoEstado(
  h: Arnes,
  e: Estudio,
  c: ClienteSembrado,
  libro: Libro,
  periodo: string,
  estado: "abierto" | "revisado" | "generado",
): Promise<void> {
  const sentencia =
    libro === "compras"
      ? `insert into compra_periodo (tenant_id, cliente_id, periodo, estado) values ($1, $2, $3, $4)
         on conflict (tenant_id, cliente_id, periodo) do update set estado = excluded.estado`
      : `insert into venta_periodo (tenant_id, cliente_id, periodo, estado) values ($1, $2, $3, $4)
         on conflict (tenant_id, cliente_id, periodo) do update set estado = excluded.estado`;
  await h.admin.query(sentencia, [e.tenantId, c.id, periodo, estado]);
}

// ---- Mensajes del resumen ----------------------------------------------------------------------------------------------------
export interface MensajeFila {
  clienteId: string;
  critico: boolean;
  historico: boolean;
  atendido: boolean;
  /** `primera_captura_en` en milisegundos. */
  capturadoEn: Date;
}

/** Inserta mensajes con el estado exacto dado (`replica`: sin los triggers de aviso ni de histórico; así no nace ningún aviso). */
export async function sembrarMensajes(
  admin: Pool,
  e: Estudio,
  atiende: UsuarioSembrado,
  filas: MensajeFila[],
): Promise<void> {
  if (filas.length === 0) return;
  const c = await admin.connect();
  try {
    await c.query("SET session_replication_role = replica");
    for (let i = 0; i < filas.length; i += 5000) {
      await c.query(
        `insert into buzon_mensaje (tenant_id, cliente_id, id_sunat, asunto, remitente, fecha, categoria, critico, motivo_critico,
                                    version_catalogo, avisado, historico, atendido_en, atendido_por, primera_captura_en, ultima_captura_en)
         select $1, x.c, 'T4-' || gen_random_uuid()::text, 'Asunto T4', 'SUNAT', x.cap::timestamptz,
                case when x.cr then 'coactiva' else 'otro' end, x.cr, case when x.cr then 'codigo' else null end, 1, false,
                x.hi, case when x.aten then x.cap::timestamptz else null end, case when x.aten then $2::uuid else null end,
                x.cap::timestamptz, x.cap::timestamptz
           from jsonb_to_recordset($3::jsonb) as x(c uuid, cr boolean, hi boolean, aten boolean, cap text)`,
        [
          e.tenantId,
          atiende.id,
          JSON.stringify(
            filas.slice(i, i + 5000).map((f) => ({
              c: f.clienteId,
              cr: f.critico,
              hi: f.historico,
              aten: f.atendido,
              cap: f.capturadoEn.toISOString(),
            })),
          ),
        ],
      );
    }
  } finally {
    c.release(true); // la conexión con session_replication_role = replica no vuelve al pool
  }
}

// ---- Oráculo del resumen ---------------------------------------------------------------------------------------------------------
export interface DatosResumen {
  clientes: Array<{ id: string; razonSocial: string; archivado: boolean }>;
  /** Usuario -> clientes con cualquier asignación (responsable o colaborador), archivados incluidos. */
  asignados: Map<string, Set<string>>;
  roles: Map<string, Rol>;
  mensajes: MensajeFila[];
  /** `${libro}|${clienteId}|${periodo}` -> estado guardado (sin entrada = abierto). */
  periodos: Map<string, "abierto" | "revisado" | "generado">;
  /** `${libro}|${clienteId}|${periodo}` con un `sire.propuesta.descargar` completado. */
  descargas: Set<string>;
}

export const claveLibro = (l: Libro, c: string, p: string): string =>
  `${l}|${c}|${p}`;

/** Lo que debe devolver `leerResumen` (R-13, D-6), calculado en memoria; ordenado por `clienteId`. */
export function oraculoResumen(
  d: DatosResumen,
  p: ParametrosResumen,
): ClienteResumen[] {
  const rol = d.roles.get(p.usuarioId);
  const propios = d.asignados.get(p.usuarioId) ?? new Set<string>();
  const todosRige =
    p.todos && (rol === "dueno" || rol === "admin") && propios.size === 0;
  const estado = (l: Libro, c: string): EstadoPeriodoResumen | null => {
    const k = claveLibro(l, c, p.periodo);
    const guardado = d.periodos.get(k) ?? "abierto";
    if (guardado === "generado") return null;
    if (guardado === "revisado") return "revisado";
    return d.descargas.has(k) ? "abierto" : "sin_descargar";
  };
  const salida: ClienteResumen[] = [];
  for (const c of d.clientes) {
    if (c.archivado) continue;
    if (!todosRige && !propios.has(c.id)) continue;
    const suyos = d.mensajes.filter(
      (m) => m.clienteId === c.id && !m.historico,
    );
    const nuevos = suyos.filter(
      (m) => m.capturadoEn.getTime() > p.desde.getTime(),
    );
    const r: ClienteResumen = {
      clienteId: c.id,
      razonSocial: c.razonSocial,
      nuevos: nuevos.length,
      criticosNuevos: nuevos.filter((m) => m.critico).length,
      pendientesAtender: suyos.filter((m) => !m.atendido).length,
      compras: estado("compras", c.id),
      ventas: estado("ventas", c.id),
    };
    if (r.nuevos > 0 || r.compras !== null || r.ventas !== null) salida.push(r);
  }
  return salida.sort((a, b) => a.clienteId.localeCompare(b.clienteId));
}

/** Ordena por `clienteId` (el repositorio no fija orden). */
export const porCliente = (filas: ClienteResumen[]): ClienteResumen[] =>
  [...filas].sort((a, b) => a.clienteId.localeCompare(b.clienteId));

function mulberry32(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Corte de las pruebas del resumen y periodo evaluado. */
export const DESDE = new Date("2026-11-20T12:00:00.000Z");
export const PERIODO = "202610";

export interface EscenarioResumen {
  e: Estudio;
  usuarios: Record<
    "dueno" | "admin1" | "admin2" | "contador1" | "contador2" | "contador3",
    UsuarioSembrado
  >;
  datos: DatosResumen;
}

/**
 * Estudio con 24 clientes (4 archivados por `archivarCliente`), asignaciones por `asignar` (admin1 y contador1; el Dueño, admin2,
 * contador2 y contador3 sin ninguna), de 0 a 10 mensajes por cliente (críticos, históricos, atendidos, y varios en el borde exacto
 * del corte: igual, +1 ms, -1 ms), periodos de compras y ventas de `PERIODO` y de los meses vecinos, y descargas en todos los
 * estados (más descargas de otro periodo y otro libro que no cuentan). `revisado` siempre con su descarga completada.
 */
export async function sembrarEscenarioResumen(
  h: Arnes,
  semilla: number,
): Promise<EscenarioResumen> {
  const r = mulberry32(semilla);
  const e = await h.nuevoEstudio();
  const admin1 = await e.nuevoUsuario("admin");
  const admin2 = await e.nuevoUsuario("admin");
  const contador1 = await e.nuevoUsuario("contador");
  const contador2 = await e.nuevoUsuario("contador");
  const usuarios = {
    dueno: e.dueno,
    admin1,
    admin2,
    contador1,
    contador2,
    contador3: e.contador,
  };
  const datos: DatosResumen = {
    clientes: [],
    asignados: new Map([
      [admin1.id, new Set<string>()],
      [contador1.id, new Set<string>()],
    ]),
    roles: new Map(Object.values(usuarios).map((u) => [u.id, u.rol])),
    mensajes: [],
    periodos: new Map(),
    descargas: new Set(),
  };
  const clientes: ClienteSembrado[] = [];
  for (let i = 0; i < 24; i++) {
    const c = await e.nuevoCliente();
    clientes.push(c);
    datos.clientes.push({
      id: c.id,
      razonSocial: c.razonSocial,
      archivado: false,
    });
  }
  // Asignaciones por su función real: un responsable (admin1, contador1 o ninguno) y colaboradores al azar.
  for (const [i, c] of clientes.entries()) {
    const ocupado = new Set<string>();
    const sorteo = r();
    const responsable = sorteo < 0.3 ? admin1 : sorteo < 0.6 ? contador1 : null;
    if (responsable !== null) {
      await asignarCliente(h, e, c, responsable, "responsable");
      datos.asignados.get(responsable.id)!.add(c.id);
      ocupado.add(responsable.id);
    }
    for (const u of [admin1, contador1]) {
      if (ocupado.has(u.id) || r() >= 0.25) continue;
      await asignarCliente(h, e, c, u, "colaborador");
      datos.asignados.get(u.id)!.add(c.id);
    }
    if (i % 6 === 5) {
      await archivar(h, e, c);
      datos.clientes[i]!.archivado = true;
    }
  }
  // Mensajes.
  const filas: MensajeFila[] = [];
  const borde = [DESDE.getTime(), DESDE.getTime() + 1, DESDE.getTime() - 1];
  for (const c of clientes) {
    const n = Math.floor(r() * 11);
    for (let k = 0; k < n; k++) {
      const especial = r() < 0.12;
      const t = especial
        ? borde[Math.floor(r() * 3)]!
        : DESDE.getTime() +
          Math.floor((r() * 8 - 6) * 86_400_000) +
          Math.floor(r() * 1000);
      filas.push({
        clienteId: c.id,
        critico: r() < 0.3,
        historico: r() < 0.2,
        atendido: r() < 0.35,
        capturadoEn: new Date(t),
      });
    }
  }
  datos.mensajes = filas;
  await sembrarMensajes(h.admin, e, e.dueno, filas);
  // Periodos y descargas.
  const vecinos = ["202609", "202611"];
  for (const c of clientes) {
    for (const libro of ["compras", "ventas"] as const) {
      const k = claveLibro(libro, c.id, PERIODO);
      const guardado = r();
      const estado =
        guardado < 0.2
          ? null
          : guardado < 0.45
            ? "abierto"
            : guardado < 0.7
              ? "revisado"
              : "generado";
      if (estado !== null) {
        await periodoEstado(h, e, c, libro, PERIODO, estado);
        datos.periodos.set(k, estado);
      }
      const trabajo = r();
      const final: EstadoDescarga | null =
        estado === "revisado" || trabajo < 0.35
          ? "completado"
          : trabajo < 0.5
            ? "error"
            : trabajo < 0.62
              ? "en_cola"
              : trabajo < 0.7
                ? "cancelado"
                : null;
      if (final !== null) {
        await descarga(h, e, c, libro, PERIODO, final);
        if (final === "completado") datos.descargas.add(k);
      }
      // Señuelos: una descarga completada de otro periodo (no debe contar; el otro libro ya es independiente arriba).
      if (r() < 0.3) {
        const otro = vecinos[Math.floor(r() * 2)]!;
        await descarga(h, e, c, libro, otro, "completado");
        if (r() < 0.5) await periodoEstado(h, e, c, libro, otro, "generado");
      }
    }
  }
  return { e, usuarios, datos };
}

// ---- Traducción de errores con una tx falsa -------------------------------------------------------------------------------
/**
 * De todo error de `pg` solo queda el SQLSTATE, nunca el mensaje, el detalle, la tabla, la columna ni el canario (correo, razón
 * social, token o asunto); un error sin SQLSTATE sale como «desconocido».
 */
export function pruebasTraduccion(
  llamadas: Array<[string, (tx: never) => Promise<unknown>]>,
): void {
  const CANARIO = "CANARIO-correo-ana@ejemplo.test-RAZON-SOCIAL-TOKEN-ABC123";
  describe.each(llamadas)("traducción de errores: %s", (_nombre, llamar) => {
    it.each(["P0002", "CA430", "22023", "42501", "55000", "40P01"])(
      "conserva solo el SQLSTATE %s",
      async (codigo) => {
        const { tx } = txFalso(errorPg(codigo, CANARIO));
        const e = await llamar(tx).then(
          () => null,
          (x: unknown) => x,
        );
        if (!(e instanceof CorreoRepoError)) throw e ?? new Error("no falló");
        expect(e.codigo).toBe(codigo);
        expect(e.message).not.toContain(CANARIO);
        expect(
          JSON.stringify({ ...e, message: e.message, stack: undefined }),
        ).not.toContain(CANARIO);
        expect(
          Object.keys(e).filter((k) =>
            [
              "detail",
              "where",
              "constraint",
              "table",
              "column",
              "cause",
            ].includes(k),
          ),
        ).toEqual([]);
      },
    );

    it("un error sin SQLSTATE sale como «desconocido», sin filtrar el mensaje", async () => {
      const { tx } = txFalso(new Error(`fallo con ${CANARIO}`));
      const e = await llamar(tx).then(
        () => null,
        (x: unknown) => x,
      );
      if (!(e instanceof CorreoRepoError)) throw e ?? new Error("no falló");
      expect(e.codigo).toBe("desconocido");
      expect(e.message).not.toContain(CANARIO);
    });
  });
}

/** Espera un CorreoRepoError; si el repositorio lanza otra cosa (p. ej. «no implementado»), la deja subir tal cual. */
export async function falla(p: Promise<unknown>): Promise<CorreoRepoError> {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof CorreoRepoError)) throw e;
    return e;
  }
  throw new Error("se esperaba un CorreoRepoError y no falló");
}
