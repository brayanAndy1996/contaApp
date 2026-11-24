// Soporte de las pruebas de BD de la spec 028 (T3, rojo). No es una prueba (no termina en .spec.ts).
// Cada archivo crea sus propios estudios, usuarios, clientes y trabajos con el superusuario (MIGRATIONS_DATABASE_URL) y los borra al
// final; ninguna prueba depende del seed. Las filas de `correo_*` se borran en modo `replica` (EscenarioAcceso.limpiar, de 005, ya
// descubre toda tabla con `tenant_id`; este soporte las borra ademas antes, y restaura la fila unica de `correo_programacion`).
//
// HECHOS REALES (reglas comunes de 028): los avisos se siembran por su camino real, nunca insertando filas de `correo_*`: criticos de
// buzon insertados como el worker (con `app.trabajo_id`) para que los triggers de 0056 llamen a `interno.notificar`;
// `credencial_invalida` con el UPDATE de la credencial; `plan_limite` cruzando el 90 % de RUCs; el resumen anterior con un ciclo real
// (`crear_correo_resumenes`, `correo_envio_tomar` y `correo_envio_cerrar`). Las marcas de tiempo se mueven como superusuario sobre
// filas ya creadas (ninguna prueba duerme). Lo unico que se inserta directo son envios `enviado` de relleno para el tope diario.
//
// CONTRATO DE BD QUE FIJAN LAS PRUEBAS DE T3 (lo implementa T10 en las migraciones 0073-0074; plan 028, Contratos: BD). Donde el plan deja
// una firma abierta la decision de T3 esta marcada con [T3]:
//
//  Tablas (0073), duenas de contapp_migrator:
//    correo_preferencia(tenant_id, usuario_id, tipo, activo, todos_clientes, actualizada_en)  PK (tenant_id, usuario_id, tipo); tipo en
//      buzon_critico|credencial_invalida|plan_limite|resumen; todos_clientes solo true en `resumen`. FK compuesta a membresia.
//      RLS ENABLE + FORCE: backend ve solo `usuario_id = app.user_id` del estudio; worker todas las del estudio. Solo SELECT para ambos.
//    correo_envio(id, tenant_id, usuario_id, origen aviso|resumen|pendientes, tipo, estado pendiente|enviado|omitido|fallido, motivo,
//      clave, programado_para, tomado_en, intentos, total_avisos, dia_lima, corte_hasta, creado_en, enviado_en)  unica (tenant_id, clave);
//      indice parcial unico: un `pendiente` sin tomar por (tenant_id, usuario_id, tipo) de origen `aviso`. motivo: membresia_inactiva,
//      sin_correo, preferencia_apagada, sin_plan, sin_contenido, sin_novedades, transporte. Backend SELECT (propios); worker SELECT.
//    correo_envio_aviso(tenant_id, notificacion_id, usuario_id, tipo, envio_id, diferido_en, creado_en)  PK (tenant_id, notificacion_id);
//      CHECK envio_id IS NOT NULL OR diferido_en IS NOT NULL. Worker SELECT; backend nada.
//    correo_baja_token(tenant_id, hash, usuario_id, tipo, envio_id, creado_en, vence_en)  PK (hash); hash de 32 bytes. Sin grants para la app.
//    correo_programacion  fila unica (id = 1): hora_resumen 07:00, dias_resumen {1..5}, ventana_min 10 (1..60), tope_diario 30 (1..500),
//      lote 1000, ciclo_dueno, ciclo_hasta, ultimo_ciclo_inicio, ultimo_ciclo_fin. Sin privilegios para la app. Sin tenant_id.
//    auditoria_accion_valida admite `correo.preferencia_cambiada` sin perder las anteriores.
//
//  Funciones (0074), SECURITY DEFINER, search_path = pg_catalog, pg_temp, sin EXECUTE para PUBLIC:
//    interno.notificar(uuid, uuid[], text, uuid, uuid, jsonb, text)  misma firma, dueno contapp_registrador y grants de 0043; por cada
//      notificacion NUEVA de tipo buzon_critico|credencial_invalida|plan_limite cuyo destinatario tiene la preferencia efectiva activa y
//      el plan no apaga `correo_avisos` (ausente = habilitado), inserta su `correo_envio_aviso` y la une al envio de D-2 (ventana: se suma
//      al `pendiente` sin tomar del (usuario, estudio, tipo); si no hay, crea uno con programado_para = max(ahora, programado del
//      anterior + ventana_min) y suma `total_avisos`); si el dia de Lima ya tiene `tope_diario` envios de origen `aviso` del
//      (usuario, estudio), no crea otro: la une como diferida (envio_id NULL, diferido_en = ahora). Candado por (estudio, usuario).
//    public.correo_preferencia_efectiva(uuid tenant, uuid usuario, text tipo) RETURNS boolean  sin fila: buzon_critico y credencial_invalida
//      true; plan_limite true solo con rol `dueno`; resumen false. Con fila: su `activo`. EXECUTE solo contapp_registrador.
//    public.correo_preferencias_fijar(p jsonb) RETURNS jsonb  [T3] p = {buzonCritico, credencialInvalida, planLimite, resumen,
//      todosClientes} (exactamente esas cinco claves, todas booleanas; si no, 22023). Exige app.tenant_id y app.user_id con membresia
//      activa (42501). `todosClientes: true` solo con rol dueno/admin (42501) y sin asignaciones (CA430). Crea las cuatro filas si
//      faltan; audita cada cambio REAL (comparado con la preferencia efectiva) con `correo.preferencia_cambiada`, actor usuario y datos
//      {tipo, de, a, origen: "app"} (tipo = el de la fila; `resumen_todos` para todosClientes); apagar un tipo deja `omitido`
//      (`preferencia_apagada`) los envios `pendiente` sin tomar de ese (usuario, estudio, tipo). El retorno es un objeto jsonb.
//    auth.correo_baja_aplicar(p_hash bytea) RETURNS void  dueno contapp_auth, EXECUTE solo contapp_backend; token vigente (vence_en > ahora):
//      apaga SOLO el tipo de su (estudio, usuario) y audita {tipo, de, a: false, origen: "enlace"} si cambio; idempotente; token
//      inexistente, vencido, alterado, NULL o de otra longitud: sin efecto, sin error y misma respuesta (void).
//    sistema.correo_ciclo_tomar(p_dueno text) RETURNS jsonb  [T3] NULL si otro dueno tiene el candado vigente (5 min, reloj de la BD); si
//      lo toma: {"resumenDia": "AAAA-MM-DD" | null}; resumenDia = dia de Lima si ya paso hora_resumen, el dia ISO esta en dias_resumen y
//      el ciclo de ese dia no se cerro. p_dueno NULL o vacio: 22023. EXECUTE solo contapp_worker (sin esquema `public`).
//    sistema.correo_ciclo_renovar(text) RETURNS boolean · sistema.correo_ciclo_soltar(text) RETURNS void · sistema.correo_resumen_cerrar(
//      p_dueno text, p_dia date) RETURNS void (solo el dueno con candado vigente cierra el dia) · sistema.estudios_correo() RETURNS TABLE
//      (tenant_id uuid, avisos boolean, resumen boolean): estudios con suscripcion activa o prueba vigente; avisos/resumen = features
//      `correo_avisos`/`correo_resumen` (ausente = true). Todas EXECUTE solo contapp_worker.
//    public.encolar_correo_avisos(p_limite integer) RETURNS integer  [T3] worker en `withTenant`: por cada envio `aviso` pendiente, sin
//      tomar y vencido (programado_para <= ahora) del estudio, hasta p_limite, crea el trabajo `notificacion.enviar` (cola `notificaciones`,
//      canal `ninguno`, sin cliente (cliente_id y ruc NULL: hoy NOT NULL en job_registro, T10 los relaja), sin solicitante, parametros
//      {"envioId": id}, dedupe por envio) y devuelve cuantos creo; repetirla da 0. p_limite < 1 o NULL: 22023.
//    public.crear_correo_resumenes(p_dia date) RETURNS integer  [T3] worker en `withTenant`: por cada usuario con membresia activa y
//      resumen efectivo activo crea un envio `resumen` (clave `resumen:<usuario>:<dia>`, dia_lima = p_dia, programado_para = ahora) y su
//      trabajo; por cada usuario SIN resumen activo y con avisos diferidos, un envio `pendientes` por tipo diferido (clave
//      `pendientes:<usuario>:<tipo>:<dia>`); los diferidos del usuario (y tipo) quedan unidos al envio (envio_id, conservando
//      diferido_en). ON CONFLICT DO NOTHING: devuelve cuantos envios nuevos creo. Sin suscripcion activa ni prueba vigente: 0. Con
//      `correo_resumen: false` en el plan: ningun envio `resumen`.
//    public.correo_envio_tomar(p_envio uuid) RETURNS jsonb  [T3] worker en `withTenant`: marca tomado_en = ahora, intentos + 1 y devuelve
//      {envioId, usuarioId, tipo, origen, intentos (incluido este), diaLima ("AAAA-MM-DD" | null), corteDesde (ISO | null)}; corteDesde = el
//      corte_hasta mas reciente de los envios `resumen` del usuario ya `enviado` u `omitido` por `sin_novedades` (null si no hay o si el
//      envio no es un resumen). Envio ajeno o inexistente: P0002. (Los nombres son los de `EnvioTomado` de T4: el repositorio los pasa tal cual.)
//    public.correo_envio_cerrar(p_envio uuid, p_estado text, p_motivo text, p_corte timestamptz) RETURNS void  [T3] estado enviado
//      (enviado_en = ahora), omitido (motivo de la lista, sin `transporte`) o fallido (motivo `transporte`); fija corte_hasta = p_corte.
//      Estado, motivo o combinacion invalida: 22023; envio ajeno: P0002.
//    public.correo_baja_token_crear(p_envio uuid, p_hash bytea) RETURNS void  [T3] worker en `withTenant`: guarda el hash (32 bytes, si no
//      22023) ligado al (estudio, usuario, tipo) del envio con vence_en = ahora + 90 dias; envio ajeno: P0002.
//    public.correo_purgar(p_dias integer) RETURNS integer  [T3] worker en `withTenant`: borra los envios (con sus avisos y tokens) y los
//      avisos y tokens sueltos con mas de p_dias dias del estudio; devuelve cuantos ENVIOS borro. p_dias < 1: 22023. `notificacion_purgar`
//      nunca falla por un aviso de correo (el aviso sigue a su notificacion).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { EscenarioBuzon, sqlMensaje, type ClientePrueba, type Q } from "./buzon-soporte";
import type { ContappDb } from "./soporte";

export {
  abrirAdmin,
  comoRol,
  conExecute,
  conSistema,
  crearDb,
  dormir,
  enTx,
  infoFuncion,
  probar,
  ROLES_EXEC,
  sqlMensaje,
  UUID,
} from "./buzon-soporte";
export type { ClientePrueba, Q } from "./buzon-soporte";
export { abrirApp, llamar } from "./auth-soporte";
export { columnasConPriv, privTabla } from "./notificaciones-soporte";

export const TIPOS_CORREO = ["buzon_critico", "credencial_invalida", "plan_limite", "resumen"] as const;
export const TIPOS_AVISO = ["buzon_critico", "credencial_invalida", "plan_limite"] as const;
export const TABLAS_CORREO_ESTUDIO = [
  "correo_preferencia",
  "correo_envio",
  "correo_envio_aviso",
  "correo_baja_token",
] as const;
export const TABLAS_CORREO = [...TABLAS_CORREO_ESTUDIO, "correo_programacion"] as const;
export const MOTIVOS_OMITIDO = [
  "membresia_inactiva",
  "sin_correo",
  "preferencia_apagada",
  "sin_plan",
  "sin_contenido",
  "sin_novedades",
] as const;
export const ACCION_PREFERENCIA = "correo.preferencia_cambiada";
export const ROLES_SIN_ACCESO = ["contapp_app", "contapp_platform", "contapp_enumerador"] as const;
export const DIA_MS = 24 * 3600 * 1000;

/**
 * Funciones nuevas de 0074 (plan 028, Contratos: BD): firma como la escribe `regprocedure::text`, los roles de la app que las ejecutan
 * (el dueño aparte) y una llamada con argumentos de relleno para probar el rechazo por privilegio (42501 llega antes que cualquier otro error).
 * `interno.notificar` (misma firma que en 0043) y `auth.correo_baja_aplicar` se verifican aparte: su dueño no es contapp_migrator.
 */
export const FUNCIONES_CORREO: { firma: string; ejecuta: string[]; llamada: string }[] = [
  { firma: "correo_preferencia_efectiva(uuid,uuid,text)", ejecuta: [], llamada: "select correo_preferencia_efectiva(gen_random_uuid(), gen_random_uuid(), 'resumen')" },
  { firma: "correo_preferencias_fijar(jsonb)", ejecuta: ["contapp_backend"], llamada: "select correo_preferencias_fijar('{}'::jsonb)" },
  { firma: "sistema.correo_ciclo_tomar(text)", ejecuta: ["contapp_worker"], llamada: "select sistema.correo_ciclo_tomar('x')" },
  { firma: "sistema.correo_ciclo_renovar(text)", ejecuta: ["contapp_worker"], llamada: "select sistema.correo_ciclo_renovar('x')" },
  { firma: "sistema.correo_ciclo_soltar(text)", ejecuta: ["contapp_worker"], llamada: "select sistema.correo_ciclo_soltar('x')" },
  { firma: "sistema.correo_resumen_cerrar(text,date)", ejecuta: ["contapp_worker"], llamada: "select sistema.correo_resumen_cerrar('x', current_date)" },
  { firma: "sistema.estudios_correo()", ejecuta: ["contapp_worker"], llamada: "select * from sistema.estudios_correo()" },
  { firma: "encolar_correo_avisos(integer)", ejecuta: ["contapp_worker"], llamada: "select encolar_correo_avisos(1)" },
  { firma: "crear_correo_resumenes(date)", ejecuta: ["contapp_worker"], llamada: "select crear_correo_resumenes(current_date)" },
  { firma: "correo_envio_tomar(uuid)", ejecuta: ["contapp_worker"], llamada: "select correo_envio_tomar(gen_random_uuid())" },
  {
    firma: "correo_envio_cerrar(uuid,text,text,timestamp with time zone)",
    ejecuta: ["contapp_worker"],
    llamada: "select correo_envio_cerrar(gen_random_uuid(), 'enviado', null, null)",
  },
  {
    firma: "correo_baja_token_crear(uuid,bytea)",
    ejecuta: ["contapp_worker"],
    llamada: "select correo_baja_token_crear(gen_random_uuid(), decode(repeat('00', 32), 'hex'))",
  },
  { firma: "correo_purgar(integer)", ejecuta: ["contapp_worker"], llamada: "select correo_purgar(90)" },
];

export const sha256 = (b: Buffer): Buffer => createHash("sha256").update(b).digest();
/** Par token en claro (solo dentro de la prueba) y su hash de 32 bytes, que es lo unico que guarda la BD. */
export const tokenNuevo = (): { token: Buffer; hash: Buffer } => {
  const token = randomBytes(32);
  return { token, hash: sha256(token) };
};

export interface FilaEnvio {
  id: string;
  tenant_id: string;
  usuario_id: string;
  origen: string;
  tipo: string;
  estado: string;
  motivo: string | null;
  clave: string;
  programado_para: Date;
  tomado_en: Date | null;
  intentos: number;
  total_avisos: number;
  dia_lima: string | Date | null;
  corte_hasta: Date | null;
  creado_en: Date;
  enviado_en: Date | null;
}

export interface FilaAviso {
  tenant_id: string;
  notificacion_id: string;
  usuario_id: string;
  tipo: string;
  envio_id: string | null;
  diferido_en: Date | null;
  creado_en: Date;
}

export interface OpcionesEstudioPlan {
  estado?: "activa" | "prueba" | null;
  venceEn?: string;
  features?: Record<string, unknown>;
}

/** Escenario de 028: extiende el del buzon (estudios con suscripcion, usuarios, clientes, trabajos y mensajes). */
export class EscenarioCorreo extends EscenarioBuzon {
  private progCorreo: Record<string, unknown> | undefined;

  /** Estudio con plan propio (features dadas) y suscripcion `activa` (por omision), `prueba` o ninguna (`estado: null`). */
  async estudioPlan(o: OpcionesEstudioPlan = {}): Promise<string> {
    const x = await this.estudio();
    if (o.estado !== null) {
      const plan = await this.ep.plan({ features: o.features ?? {}, maxRucs: 100, maxUsuarios: null });
      await this.ep.suscribir(x.id, plan.id, {
        estado: o.estado ?? "activa",
        ...(o.venceEn !== undefined ? { venceEn: o.venceEn } : {}),
      });
    }
    return x.id;
  }

  /** Foto de la fila unica de `correo_programacion` para restaurarla en `limpiar` (no falla si la tabla aun no existe: rojo). */
  async guardarProgramacionCorreo(): Promise<void> {
    if (this.progCorreo) return;
    try {
      this.progCorreo = (await this.admin.query("select * from correo_programacion")).rows[0];
    } catch {
      /* rojo: la tabla aun no existe */
    }
  }

  /** Devuelve la fila unica a su foto (o a los valores por omision si no hay foto): borra el cierre de dia y el candado del ciclo. */
  async restaurarProgramacionCorreo(c: Q = this.admin): Promise<void> {
    const foto = this.progCorreo;
    if (!foto) return;
    await c.query("delete from correo_programacion");
    await c.query("insert into correo_programacion select * from json_populate_record(null::correo_programacion, $1::json)", [
      JSON.stringify(foto),
    ]);
  }

  async fijarProgramacionCorreo(cambios: Record<string, unknown>, c: Q = this.admin): Promise<void> {
    const cols = Object.keys(cambios);
    if (!cols.every((k) => /^[a-z_]+$/.test(k))) throw new Error("columna invalida");
    await c.query(`update correo_programacion set ${cols.map((k, i) => `${k} = $${i + 1}`).join(", ")}`, Object.values(cambios));
  }

  async programacionCorreo(): Promise<Record<string, any>> {
    return (await this.admin.query("select * from correo_programacion")).rows[0];
  }

  /** Dia de Lima (AAAA-MM-DD) y dia ISO de la semana segun el reloj de la BD. */
  async hoyLima(): Promise<{ dia: string; isodow: number }> {
    const r = await this.admin.query(
      `select to_char(clock_timestamp() at time zone 'America/Lima', 'YYYY-MM-DD') as dia,
              extract(isodow from clock_timestamp() at time zone 'America/Lima')::int as isodow`,
    );
    return { dia: r.rows[0].dia as string, isodow: r.rows[0].isodow as number };
  }

  /** Preferencia insertada directo (superusuario) solo para armar el estado previo; lo que se prueba entra por la funcion acotada. */
  async preferencia(tenantId: string, usuarioId: string, tipo: string, activo: boolean, todos = false): Promise<void> {
    await this.admin.query(
      `insert into correo_preferencia (tenant_id, usuario_id, tipo, activo, todos_clientes) values ($1, $2, $3, $4, $5)
       on conflict (tenant_id, usuario_id, tipo) do update set activo = excluded.activo, todos_clientes = excluded.todos_clientes`,
      [tenantId, usuarioId, tipo, activo, todos],
    );
  }

  async efectiva(tenantId: string, usuarioId: string, tipo: string): Promise<boolean> {
    return (await this.admin.query("select correo_preferencia_efectiva($1::uuid, $2::uuid, $3::text) as v", [tenantId, usuarioId, tipo]))
      .rows[0].v as boolean;
  }

  async envios(tenantId: string, f: { usuarioId?: string; tipo?: string; origen?: string; estado?: string } = {}): Promise<FilaEnvio[]> {
    const r = await this.admin.query(
      `select * from correo_envio
        where tenant_id = $1 and ($2::uuid is null or usuario_id = $2) and ($3::text is null or tipo = $3)
          and ($4::text is null or origen = $4) and ($5::text is null or estado = $5)
        order by creado_en, id`,
      [tenantId, f.usuarioId ?? null, f.tipo ?? null, f.origen ?? null, f.estado ?? null],
    );
    return r.rows as FilaEnvio[];
  }

  async avisosDe(tenantId: string, f: { usuarioId?: string; tipo?: string; envioId?: string } = {}): Promise<FilaAviso[]> {
    const r = await this.admin.query(
      `select * from correo_envio_aviso
        where tenant_id = $1 and ($2::uuid is null or usuario_id = $2) and ($3::text is null or tipo = $3)
          and ($4::uuid is null or envio_id = $4)
        order by creado_en, notificacion_id`,
      [tenantId, f.usuarioId ?? null, f.tipo ?? null, f.envioId ?? null],
    );
    return r.rows as FilaAviso[];
  }

  async diferidosDe(tenantId: string, usuarioId: string): Promise<FilaAviso[]> {
    return (await this.avisosDe(tenantId, { usuarioId })).filter((a) => a.diferido_en !== null);
  }

  /** Filas de auditoria de la preferencia de correo del estudio (de la mas vieja a la mas nueva). */
  async auditoriaPreferencia(tenantId: string, usuarioId?: string): Promise<any[]> {
    return (
      await this.admin.query(
        `select * from auditoria where tenant_id = $1 and accion = $2 and ($3::uuid is null or usuario_id = $3) order by ocurrida_en, id`,
        [tenantId, ACCION_PREFERENCIA, usuarioId ?? null],
      )
    ).rows;
  }

  /**
   * `n` envios `enviado` de relleno del tope diario (no son avisos: son su resultado). Por omision de origen `aviso`, de hoy y del tipo
   * `buzon_critico`; `hace` (intervalo SQL, p. ej. '1 day') los mueve al pasado.
   */
  async sembrarEnviados(
    tenantId: string,
    usuarioId: string,
    n: number,
    o: { tipo?: string; origen?: string; hace?: string } = {},
  ): Promise<void> {
    const origen = o.origen ?? "aviso";
    await this.admin.query(
      `insert into correo_envio (tenant_id, usuario_id, origen, tipo, estado, clave, programado_para, intentos, total_avisos, creado_en, enviado_en)
       select $1::uuid, $2::uuid, $5::text, $3::text, 'enviado', $5::text || ':' || $2::text || ':' || $3::text || ':' || gen_random_uuid()::text,
              clock_timestamp() - $6::interval, 1, 1, clock_timestamp() - $6::interval, clock_timestamp() - $6::interval
         from generate_series(1, $4::int)`,
      [tenantId, usuarioId, o.tipo ?? "buzon_critico", n, origen, o.hace ?? "0 seconds"],
    );
  }

  /** Marca como tomados todos los envios `pendiente` de un usuario (como haria el worker) sin cambiar nada mas. */
  async tomarPendientes(tenantId: string, usuarioId: string): Promise<void> {
    await this.admin.query(
      "update correo_envio set tomado_en = clock_timestamp(), intentos = intentos + 1 where tenant_id = $1 and usuario_id = $2 and estado = 'pendiente' and tomado_en is null",
      [tenantId, usuarioId],
    );
  }

  /**
   * Hace pasar `dias` para lo de `correo_*` de un estudio (de un solo usuario si se da `usuarioId`): envios, avisos y tokens. Modo replica:
   * ningun disparador de inmutabilidad ni FK corre y se resta un intervalo entero. Sirve para la purga a 90 dias sin esperar. Conexion
   * propia que se destruye al terminar.
   */
  async envejecerCorreo(tenantId: string, dias: number, usuarioId?: string): Promise<void> {
    const c = await this.admin.connect();
    try {
      await c.query("SET session_replication_role = replica");
      const d = `make_interval(days => $2::int)`;
      const filtro = `tenant_id = $1 and ($3::uuid is null or usuario_id = $3)`;
      const v = [tenantId, dias, usuarioId ?? null];
      await c.query(`update correo_envio set creado_en = creado_en - ${d}, programado_para = programado_para - ${d} where ${filtro}`, v);
      await c.query(`update correo_envio_aviso set creado_en = creado_en - ${d} where ${filtro}`, v);
      await c.query(`update correo_baja_token set creado_en = creado_en - ${d}, vence_en = vence_en - ${d} where ${filtro}`, v);
    } finally {
      c.release(true);
    }
  }

  /**
   * Un critico de buzon nuevo por captura, insertado como el worker (con `app.trabajo_id` de un `sol.buzon.revisar` ejecutando) para que el
   * trigger de 0056 llame a `interno.notificar`. `n` criticos en UNA transaccion; devuelve los ids de los mensajes.
   */
  async capturar(
    worker: ContappDb,
    tenantId: string,
    c: ClientePrueba,
    n = 1,
    o: { categoria?: string; asunto?: string; remitente?: string } = {},
  ): Promise<string[]> {
    const trabajo = await this.et.job(tenantId, c, { estado: "ejecutando", tipo: "sol.buzon.revisar", cola: "sol", canal: "sol" });
    return worker.withTenant({ tenantId, trabajoId: trabajo }, async (tx) => {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const m = sqlMensaje(tenantId, c.id, {
          critico: true,
          avisado: true,
          categoria: o.categoria ?? "coactiva",
          ...(o.asunto ? { asunto: o.asunto } : {}),
          ...(o.remitente ? { remitente: o.remitente } : {}),
        });
        ids.push((await tx.query(m.text, m.values)).rows[0].id as string);
      }
      return ids;
    });
  }

  /** `n` criticos de un cliente en UNA sentencia (para el rendimiento: el trigger por fila llama a `interno.notificar` n veces). */
  async capturarLote(tenantId: string, c: ClientePrueba, n: number, q: Q): Promise<void> {
    await q.query(
      `insert into buzon_mensaje
         (tenant_id, cliente_id, id_sunat, asunto, remitente, fecha, categoria, critico, motivo_critico, version_catalogo, avisado,
          leido_sunat, primera_captura_en, ultima_captura_en, adjuntos_declarados)
       select $1, $2, 'L-' || gen_random_uuid()::text, 'Asunto de prueba', 'SUNAT', now() - interval '1 day', 'coactiva', true, 'codigo', 1, true,
              false, now(), now(), 0
         from generate_series(1, $3::int)`,
      [tenantId, c.id, n],
    );
  }

  /** `interno.notificar` directo (superusuario): cada llamada con su propia clave de dedupe. Devuelve la clave usada. */
  async notificarDirecto(
    q: Q,
    tenantId: string,
    usuarios: string[],
    tipo: string,
    o: { clave?: string; clienteId?: string | null; params?: Record<string, unknown> } = {},
  ): Promise<string> {
    const clave = o.clave ?? `${tipo}:t3:${randomUUID()}`;
    const params =
      o.params ??
      (tipo === "plan_limite"
        ? { recurso: "rucs", umbral: 90, usado: 9, limite: 10 }
        : tipo === "credencial_invalida"
          ? { credencial: "sol" }
          : { categoria: "coactiva", mensajeId: randomUUID() });
    await q.query("select interno.notificar($1::uuid, $2::uuid[], $3::text, $4::uuid, null, $5::jsonb, $6::text)", [
      tenantId,
      usuarios,
      tipo,
      o.clienteId ?? null,
      JSON.stringify(params),
      clave,
    ]);
    return clave;
  }

  /** Borra, antes de las limpiezas de los demas escenarios, las filas de `correo_*` de estos estudios y restaura la programacion. */
  override async limpiar(): Promise<void> {
    const c = await this.admin.connect();
    try {
      await c.query("SET session_replication_role = replica");
      for (const tabla of TABLAS_CORREO_ESTUDIO) {
        await c.query(`delete from ${tabla} where tenant_id = any($1::uuid[])`, [this.estudios]).catch(() => undefined);
      }
      await c.query("delete from job_registro where tenant_id = any($1::uuid[]) and tipo = 'notificacion.enviar'", [this.estudios]).catch(
        () => undefined,
      );
    } catch {
      /* limpieza de mejor esfuerzo */
    } finally {
      c.release(true);
    }
    await this.restaurarProgramacionCorreo().catch(() => undefined);
    await super.limpiar();
  }
}

/** Conexion con `session_replication_role = replica` para armar estados que los disparadores impedirian; el llamador la libera. */
export async function conReplica(admin: Pool): Promise<PoolClient> {
  const c = await admin.connect();
  await c.query("SET session_replication_role = replica");
  return c;
}
