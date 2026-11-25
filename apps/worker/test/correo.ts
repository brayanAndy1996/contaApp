// Soporte de las pruebas del worker de la spec 028 (T5, rojo): ciclo `correo.programar`, envío `notificacion.enviar` y purga.
// No es código de producción ni una prueba. Usa la BD y Redis reales de las demás pruebas de integración (PostgreSQL con 0073-0074 de T10).
//
// CONTRATO DEL WORKER QUE FIJAN ESTAS PRUEBAS (lo implementa T11; plan 028, Contratos: Worker, correo, Cola):
// - `procesadores/programar-correo.ts` exporta `programarCorreo(deps): () => Promise<ResultadoCicloCorreo>`:
//     deps = { db: Pick<ContappDb, "withSistema" | "withTenant">, redis?: RedisEncolado, prefijo?: string, logger?: LoggerTrabajos,
//              dueno?: string, lote?: number /* 1000: tope de `encolarAvisosCorreo` por estudio */ }
//     Cada llamada del resultado es un tick: `tomarCicloCorreo(dueno)` (null = otro lo tiene: `tomado: false`, sin efectos);
//     `estudiosCorreo` (solo estudios con suscripción activa o prueba vigente); por estudio, en su `withTenant`, `encolarAvisosCorreo`
//     (si `avisos`) y, si hay `resumenDia` y `resumen`, `crearResumenesCorreo(tx, resumenDia)`; tras el commit, la pista y el evento de
//     la cola de cada trabajo `notificacion.enviar` nuevo (si hay `redis`); `renovarCicloCorreo` tras cada estudio (false = perdió el
//     candado: se detiene y `perdioCandado: true`); cierra el día (`cerrarResumenCorreo`) solo si había `resumenDia` y TODOS los estudios
//     se atendieron sin fallo y no perdió el candado; `soltarCicloCorreo` en `finally`. El fallo de un estudio no tumba el ciclo y solo
//     deja en el log el estudio y un código (nunca el error). Resultado:
//     ResultadoCicloCorreo = { tomado, estudios (atendidos sin fallo), avisosEncolados, resumenesCreados, resumenDia: string | null,
//                              diaCerrado: boolean, perdioCandado: boolean }
// - `procesadores/enviar-correo.ts` exporta `enviarCorreo(deps): Procesador` (`notificacion.enviar`):
//     deps = { db: Pick<ContappDb, "withTenant">, correo: Correo, appOrigin: string, logger?, reloj?: Reloj, intentosMax?: number /* 3 */ }
//     Parámetros revalidados con `NOTIFICACION_ENVIAR.parametros` ANTES de abrir transacción (si no, lanza sin repetir lo recibido).
//     Tx 1: `tomarEnvio` (suma el intento), revalidación de R-3 y R-12 (membresía, correo, preferencia, plan/features, visibilidad de
//     cada cliente), lectura del contenido y token de baja (`randomBytes(32)` en base64url de 43 caracteres; la BD guarda el SHA-256 del
//     TEXTO del token, `crearTokenBaja`); si no queda nada: `cerrarEnvio(omitido, motivo)` y termina. Fuera de transacción:
//     `Correo.enviar` con `idMensaje = envioId` y `baja.url = <appOrigin>/…?t=<token>`; el cuerpo lleva `<appOrigin>/baja?t=<token>` y
//     `<appOrigin>/ir?estudio=<tenant>&pantalla=…`. Tx 2: `enviado` con `corte_hasta` = el instante del reloj al armar. Un fallo del
//     transporte (cualquier error) NO queda en log, error ni BD: antes del último intento (`intentos < intentosMax`) lanza
//     `CorreoNoEnviadoError` para que 008 reintente; en el último cierra `fallido` `transporte` y DEVUELVE el resultado (no lanza).
//     Resultado (solo códigos y conteos): `{estado: "enviado", avisos: N}` (avisos de aviso/pendientes) | `{estado: "enviado",
//     clientes: N}` (resumen) | `{estado: "omitido", motivo}` | `{estado: "fallido", motivo: "transporte"}`.
//     El resumen cuenta desde `corteDesde` o, si no hay, 24 h antes del instante del reloj; el periodo es el mes anterior de Lima.
//     `sin_plan` cubre tanto «sin suscripción activa ni prueba vigente» como `features` `correo_avisos`/`correo_resumen` = false.
// - `auth-purgar.ts`: `ResultadoAuthPurgar` suma `correo: number` (envíos borrados por `purgarCorreo(tx, 90)` en cada estudio).
// - `iniciarTrabajos`: `DepsTrabajos` gana `correo?: Correo` y `appOrigin?: string`; registra `notificacion.enviar` y el caso
//   `correo.programar` de `procesarSistema`; llama a `sistema.programarCorreo()` salvo `process.env.CORREO_PROGRAMADOR === "off"`.
//
// Hechos reales (reglas comunes de 028): críticos de buzón insertados como el worker (con `app.trabajo_id`) para que los triggers de
// 0056 llamen a `interno.notificar`; `credencial_invalida` con `marcarCredencialInvalida`; `plan_limite` cruzando el 90 % de RUCs;
// descargas llevadas a `completado` por la transición de 008; el resumen anterior con un ciclo real (`crear_correo_resumenes`,
// `correo_envio_tomar` y `correo_envio_cerrar`); preferencias por `correo_preferencias_fijar` como el usuario. Lo único que se inserta
// directo son mensajes de buzón no críticos y periodos (hechos), y envíos `enviado` de relleno para el tope diario. Los tiempos se
// mueven con el superusuario sobre filas ya creadas: ninguna prueba duerme.
/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD dinámicas y proxies de espionaje en pruebas */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  CorreoMemoria,
  CorreoNoEnviadoError,
  type Correo,
  type MensajeCorreo,
} from "@contapp/correo";
import {
  archivarCliente,
  desactivar,
  insertarTrabajo,
  marcarCredencialInvalida,
  retirar,
  transicionar,
  type ContappDb,
  type Tx,
} from "@contapp/db";
import type { ContextoProcesador } from "../src/trabajos/ejecutor.js";
import { EscenarioBuzon } from "./buzon.js";
import { limpiarFilas017 } from "./notificaciones.js";
import { rucNuevo, type ClientePrueba } from "./trabajos.js";

// El ciclo de correo es global en la BD (atiende a todos los estudios): salvo que una suite lo pida, el repetible no corre.
process.env.CORREO_PROGRAMADOR ??= "off";

export type { ClientePrueba };
export { CorreoMemoria, CorreoNoEnviadoError };
export type { Correo, MensajeCorreo };

export const APP_ORIGIN = "https://app.contapp.test";
export const DIA_MS = 86_400_000;
export const TIPOS_AVISO = [
  "buzon_critico",
  "credencial_invalida",
  "plan_limite",
] as const;
export type TipoAviso = (typeof TIPOS_AVISO)[number];
export type Rol = "dueno" | "admin" | "contador" | "asistente" | "lectura";
export type Libro = "compras" | "ventas";

export const sha256Texto = (t: string): Buffer =>
  createHash("sha256").update(t, "utf8").digest();

/** `?t=` de la URL de baja (o del texto dado). Lanza si no hay token de 43 caracteres base64url. */
export function tokenDe(textoOUrl: string): string {
  const m = /[?&]t=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/.exec(textoOUrl);
  if (!m) throw new Error("el mensaje no trae un token de baja de 43 caracteres");
  return m[1]!;
}

/** `dd/mm/aaaa hh:mm` en hora de Lima: como lo muestra `fechaHoraLima` de domain. */
export function fechaLima(d: Date): string {
  const p = new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const g = (t: string): string => p.find((x) => x.type === t)!.value;
  return `${g("day")}/${g("month")}/${g("year")} ${g("hour")}:${g("minute")}`;
}

export const contar = (texto: string, parte: string | RegExp): number =>
  typeof parte === "string"
    ? texto.split(parte).length - 1
    : (texto.match(new RegExp(parte.source, "g")) ?? []).length;

// ---------------------------------------------------------------------------------------------------------------
// Dobles del puerto `Correo`
// ---------------------------------------------------------------------------------------------------------------

/** Transporte que falla `veces` veces (con el error dado) y luego entrega como `CorreoMemoria`. */
export class CorreoQueFalla extends CorreoMemoria {
  intentos = 0;
  constructor(
    private readonly veces: number,
    private readonly error: () => unknown = () => new CorreoNoEnviadoError(),
  ) {
    super();
  }
  override async enviar(m: MensajeCorreo): Promise<void> {
    this.intentos += 1;
    if (this.intentos <= this.veces) throw this.error();
    await super.enviar(m);
  }
}

/**
 * «Proceso cortado» en el envío: `enviar` se cuelga y nunca devuelve. Con `entrega: "antes"` se cuelga sin entregar; con `"despues"`
 * entrega (queda en `enviados`) y luego se cuelga. `enEnvio` se cumple cuando el procesador ya está dentro de `enviar`; la prueba
 * abandona la promesa del procesador (el proceso murió) y vuelve a ejecutar el trabajo con otro `Correo`.
 */
export class CorreoQueMuere extends CorreoMemoria {
  readonly enEnvio: Promise<void>;
  private entrar!: () => void;
  constructor(private readonly entrega: "antes" | "despues") {
    super();
    this.enEnvio = new Promise<void>((r) => {
      this.entrar = r;
    });
  }
  override async enviar(m: MensajeCorreo): Promise<void> {
    if (this.entrega === "despues") await super.enviar(m);
    this.entrar();
    await new Promise<never>(() => undefined);
  }
}

/** Contexto que el ejecutor de 008 le da al procesador de `notificacion.enviar` (sin cliente ni solicitante). */
export function ctxEnvio(
  tenantId: string,
  envioId: string,
  intentos = 1,
): ContextoProcesador {
  return {
    trabajo: {
      id: randomUUID(),
      tenantId,
      clienteId: null as unknown as string,
      ruc: null as unknown as string,
      tipo: "notificacion.enviar",
      parametros: { envioId },
      intentos,
      creadoPor: null,
    },
    conToken: () => {
      throw new Error("notificacion.enviar no usa el token SIRE");
    },
  };
}

/**
 * Las suites con BD comparten la base: `sistema.estudios_correo()` devuelve los estudios de TODAS. El programador de la prueba solo
 * atiende los que sembró esta prueba, así que sus conteos no dependen de lo que haya en la base. Todo lo demás pasa tal cual.
 */
export function soloMisEstudios(
  base: ContappDb,
  mios: () => readonly string[],
): ContappDb {
  const propios = (tx: Tx): Tx =>
    new Proxy(tx, {
      get(t, p, r) {
        if (p === "query")
          return async (texto: unknown, ...resto: unknown[]) => {
            const res = await (
              t.query as unknown as (...a: unknown[]) => Promise<{
                rows: { tenant_id?: unknown; tenantId?: unknown }[];
              }>
            )(texto, ...resto);
            if (typeof texto !== "string" || !texto.includes("estudios_correo"))
              return res;
            const set = new Set(mios());
            return {
              ...res,
              rows: res.rows.filter((f) =>
                set.has(String(f.tenant_id ?? f.tenantId)),
              ),
            };
          };
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  return new Proxy(base, {
    get(t, p, r) {
      if (p === "withSistema")
        return <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
          t.withSistema((tx) => fn(propios(tx)));
      const v = Reflect.get(t, p, r);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Fila única `correo_programacion`
// ---------------------------------------------------------------------------------------------------------------

/** Guarda y restaura la fila única de `correo_programacion` (las pruebas la cambian sin transacción). */
export class ProgramacionCorreo {
  private foto: Record<string, unknown> | undefined;
  constructor(private readonly admin: ContappDb) {}

  async guardar(): Promise<void> {
    if (this.foto) return;
    try {
      this.foto = (
        await this.admin.pool.query("select * from correo_programacion")
      ).rows[0];
    } catch {
      /* rojo: la tabla aún no existe */
    }
  }

  /** Devuelve la fila a su foto: borra también el cierre del día y el candado del ciclo. */
  async restaurar(): Promise<void> {
    if (!this.foto) return;
    await this.admin.pool
      .query("delete from correo_programacion")
      .catch(() => undefined);
    await this.admin.pool
      .query(
        "insert into correo_programacion select * from json_populate_record(null::correo_programacion, $1::json)",
        [JSON.stringify(this.foto)],
      )
      .catch(() => undefined);
  }

  /** Hora y días del resumen (lo no dado queda como está). */
  async fijarResumen(hora?: string, dias?: number[]): Promise<void> {
    await this.admin.pool.query(
      `update correo_programacion set hora_resumen = coalesce($1::time, hora_resumen),
              dias_resumen = coalesce($2::smallint[], dias_resumen)`,
      [hora ?? null, dias ?? null],
    );
  }

  /** Candado y marca del ciclo anterior, tal cual se dan (nulos incluidos). */
  async fijarCiclo(dueno: string | null, hasta: Date | null, ultimoInicio: Date): Promise<void> {
    await this.admin.pool.query(
      "update correo_programacion set ciclo_dueno = $1, ciclo_hasta = $2, ultimo_ciclo_inicio = $3",
      [dueno, hasta, ultimoInicio],
    );
  }

  async leer(): Promise<Record<string, any>> {
    return (await this.admin.pool.query("select * from correo_programacion"))
      .rows[0];
  }

  /** Candado libre y ciclo anterior hace una hora: el siguiente tick puede tomarlo. NO toca el cierre del día. */
  async listoParaTomar(): Promise<void> {
    await this.fijarCiclo(null, null, new Date(Date.now() - 3_600_000));
  }

  /** La hora del resumen ya pasó hoy y hoy es día de resumen (hora 00:00, todos los días ISO). */
  async resumenYaToca(): Promise<void> {
    await this.fijarResumen("00:00:00", [1, 2, 3, 4, 5, 6, 7]);
  }

  /** Hoy no es día de resumen (el día ISO de hoy sale de `dias_resumen`). */
  async hoyNoEsDiaDeResumen(isodow: number): Promise<void> {
    await this.fijarResumen(
      "00:00:00",
      [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== isodow),
    );
  }

  /** La hora del resumen todavía no llega hoy (23:59:59). */
  async antesDeLaHora(): Promise<void> {
    await this.fijarResumen("23:59:59", [1, 2, 3, 4, 5, 6, 7]);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Escenario
// ---------------------------------------------------------------------------------------------------------------

export interface OpcionesEstudioPlan {
  estado?: "activa" | "prueba" | null;
  /** Intervalo SQL desde ahora de `prueba_vence_en` (`'-1 day'` = prueba vencida). */
  venceEn?: string;
  features?: Record<string, unknown>;
  maxRucs?: number;
}

export interface MensajeFila {
  clienteId: string;
  critico: boolean;
  historico: boolean;
  atendido: boolean;
  capturadoEn: Date;
}

export interface FilaEnvio {
  id: string;
  tenant_id: string;
  usuario_id: string;
  origen: "aviso" | "resumen" | "pendientes";
  tipo: string;
  estado: "pendiente" | "enviado" | "omitido" | "fallido";
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

const PREFERENCIAS_INICIALES = (rol: Rol) => ({
  buzonCritico: true,
  credencialInvalida: true,
  planLimite: rol === "dueno",
  resumen: false,
  todosClientes: false,
});

export class EscenarioCorreo extends EscenarioBuzon {
  private readonly roles = new Map<string, Rol>();
  private readonly usuariosCorreo: string[] = [];
  private readonly planesCorreo: string[] = [];

  constructor(
    admin: ContappDb,
    readonly backend: ContappDb,
    readonly worker: ContappDb,
  ) {
    super(admin);
  }

  override async usuario(
    tenantId: string,
    rol: Rol = "contador",
    o: { desactivada?: boolean } = {},
  ): Promise<string> {
    const id = await super.usuario(tenantId, rol, o);
    this.roles.set(`${tenantId}:${id}`, rol);
    this.usuariosCorreo.push(id);
    return id;
  }

  /** Estudio con un plan propio (con `features` y `maxRucs`) y suscripción `activa` (por omisión), `prueba` o ninguna (`null`). */
  async estudioPlan(o: OpcionesEstudioPlan = {}): Promise<string> {
    const T = await this.estudio();
    if (o.estado === null) return T;
    const estado = o.estado ?? "activa";
    const codigo = `w028_${randomBytes(5).toString("hex")}`;
    const plan = await this.admin.pool.query(
      `insert into plan (codigo, nombre, precio_mensual, precio_anual, max_rucs, max_usuarios, precio_ruc_extra,
                         max_rucs_extra, frecuencia_buzon_min, features, activo)
       values ($1, $2, '10.00', null, $3, 1000, '1.00', 0, 1440, $4::jsonb, true) returning id`,
      [codigo, `Plan ${codigo}`, o.maxRucs ?? 100_000, JSON.stringify(o.features ?? {})],
    );
    this.planesCorreo.push(codigo);
    const vence =
      o.venceEn ?? (estado === "prueba" ? "14 days" : null);
    await this.admin.pool.query(
      `insert into suscripcion (tenant_id, plan_id, estado, prueba_vence_en, rucs_extra_contratados)
       values ($1, $2, $3, case when $4::interval is null then null else now() + $4::interval end, 0)`,
      [T, plan.rows[0].id, estado, vence],
    );
    return T;
  }

  /** Cliente con la razón social dada (los canarios entran por aquí). */
  async clienteCon(
    T: string,
    razonSocial: string,
    ruc: string = rucNuevo(),
  ): Promise<ClientePrueba> {
    const r = await this.admin.pool.query(
      "insert into cliente (tenant_id, ruc, razon_social) values ($1, $2, $3) returning id",
      [T, ruc, razonSocial],
    );
    return { id: r.rows[0].id as string, ruc };
  }

  async emailDe(usuarioId: string): Promise<string> {
    return (
      await this.admin.pool.query("select email from usuario where id = $1", [
        usuarioId,
      ])
    ).rows[0].email as string;
  }

  async nombreEstudio(T: string): Promise<string> {
    return (
      await this.admin.pool.query("select nombre from tenant where id = $1", [
        T,
      ])
    ).rows[0].nombre as string;
  }

  /** Responsable del cliente (a él va el aviso de crítico y de credencial inválida). */
  async responsable(T: string, c: ClientePrueba, u: string): Promise<void> {
    await this.admin.pool.query(
      "insert into asignacion (tenant_id, cliente_id, usuario_id, tipo) values ($1, $2, $3, 'responsable')",
      [T, c.id, u],
    );
  }

  // ---- Preferencias y alcance: por las funciones reales como el usuario --------------------------------------------------

  /** `correo_preferencias_fijar` como el usuario (sesión del backend en el estudio): lo no dado queda en su valor inicial por rol. */
  async fijar(
    T: string,
    usuarioId: string,
    p: Partial<ReturnType<typeof PREFERENCIAS_INICIALES>> = {},
  ): Promise<void> {
    const rol = this.roles.get(`${T}:${usuarioId}`) ?? "contador";
    await this.backend.withTenant({ tenantId: T, userId: usuarioId }, (tx) =>
      tx.query("select correo_preferencias_fijar($1::jsonb)", [
        JSON.stringify({ ...PREFERENCIAS_INICIALES(rol), ...p }),
      ]),
    );
  }

  /** Quita la asignación del usuario al cliente por la función de 005, como el Dueño (`dueno`) del estudio. */
  async desasignar(
    T: string,
    dueno: string,
    c: ClientePrueba,
    usuarioId: string,
  ): Promise<void> {
    await this.backend.withTenant({ tenantId: T, userId: dueno }, (tx) =>
      retirar(tx, { clienteId: c.id, usuarioId }),
    );
  }

  /** Archiva el cliente por la función de 007a, como el Dueño del estudio. */
  async archivar(T: string, dueno: string, c: ClientePrueba): Promise<void> {
    await this.backend.withTenant({ tenantId: T, userId: dueno }, (tx) =>
      archivarCliente(tx, c.id),
    );
  }

  /** Desactiva la membresía por la función de 005, como el Dueño del estudio. */
  async desactivarMembresia(
    T: string,
    dueno: string,
    usuarioId: string,
  ): Promise<void> {
    await this.backend.withTenant({ tenantId: T, userId: dueno }, (tx) =>
      desactivar(tx, usuarioId),
    );
  }

  // ---- Avisos por su camino real -------------------------------------------------------------------------------------------

  /** Trabajo `sol.buzon.revisar` en ejecución (el contexto `app.trabajo_id` del worker que captura). */
  async trabajoBuzon(T: string, c: ClientePrueba): Promise<string> {
    const id = randomUUID();
    await this.admin.pool.query(
      `insert into job_registro (id, tenant_id, cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe,
                                 max_intentos, iniciado_en)
       values ($1, $2, $3, $4, 'sol.buzon.revisar', 'sol', 'sol', 'programado', 'ejecutando', '{}'::jsonb, $5, 3, now())`,
      [id, T, c.id, c.ruc, randomBytes(32)],
    );
    return id;
  }

  /**
   * `n` críticos nuevos del cliente en UNA transacción, insertados como el worker (con `app.trabajo_id`): los triggers de 0056
   * llaman a `interno.notificar`. Devuelve los ids de los mensajes y la fecha del mensaje (por omisión hace 3 días, en segundos).
   */
  async capturar(
    T: string,
    c: ClientePrueba,
    n = 1,
    o: { fecha?: Date; asunto?: string; remitente?: string; categoria?: string } = {},
  ): Promise<{ ids: string[]; fecha: Date }> {
    const fecha =
      o.fecha ?? new Date(Math.floor(Date.now() / 1000) * 1000 - 3 * DIA_MS);
    const trabajoId = await this.trabajoBuzon(T, c);
    const ids = await this.worker.withTenant(
      { tenantId: T, trabajoId },
      async (tx) => {
        const r = await tx.query(
          `insert into buzon_mensaje (cliente_id, id_sunat, asunto, remitente, fecha, categoria, critico, motivo_critico,
                                      version_catalogo, avisado)
           select $1::uuid, 'T5-' || gen_random_uuid()::text, $2, $3, $4::timestamptz, $5, true, 'codigo', 1, true
             from generate_series(1, $6::int)
           returning id`,
          [
            c.id,
            o.asunto ?? "Asunto de prueba",
            o.remitente ?? "SUNAT",
            fecha,
            o.categoria ?? "coactiva",
            n,
          ],
        );
        return r.rows.map((f: { id: unknown }) => String(f.id));
      },
    );
    return { ids, fecha };
  }

  /** Credencial SOL del cliente creada y marcada inválida con `marcarCredencialInvalida` (aviso `credencial_invalida`). */
  async invalidarCredencial(T: string, c: ClientePrueba): Promise<void> {
    await this.credencial(T, c.id, "sol");
    await this.admin.pool.query(
      "update credencial set estado = 'verificada' where tenant_id = $1 and cliente_id = $2 and tipo = 'sol'",
      [T, c.id],
    );
    const marcada = await this.worker.withTenant({ tenantId: T }, (tx) =>
      marcarCredencialInvalida(tx, c.id, "sol", "credencial_invalida"),
    );
    if (!marcada) throw new Error("la credencial no pasó a inválida");
  }

  /** Estudio con `maxRucs: 10`: lleva los clientes a 9 de 10 (90 %); los triggers de 0043 avisan a los Dueños (`plan_limite`). */
  async llevarAl90(T: string): Promise<void> {
    const { rows } = await this.admin.pool.query(
      "select count(*)::int as n from cliente where tenant_id = $1 and archivado_at is null",
      [T],
    );
    const faltan = 9 - Number(rows[0].n);
    if (faltan < 1) throw new Error("el estudio ya pasó del 90 % del plan");
    const marca = randomBytes(3).toString("hex");
    const base = (Date.now() % 100_000) * 100;
    await this.admin.pool.query(
      `insert into cliente (tenant_id, ruc, razon_social)
       select $1, '4' || lpad(($2::bigint + g)::text, 10, '0'), 'Relleno T5 ' || $3 || '-' || g
         from generate_series(1, $4::int) g`,
      [T, base, marca, faltan],
    );
  }

  // ---- Envíos y avisos (lectura con el superusuario) ----------------------------------------------------------------------

  async envios(
    T: string,
    f: { usuarioId?: string; tipo?: string; origen?: string; estado?: string } = {},
  ): Promise<FilaEnvio[]> {
    const r = await this.admin.pool.query(
      `select * from correo_envio
        where tenant_id = $1 and ($2::uuid is null or usuario_id = $2) and ($3::text is null or tipo = $3)
          and ($4::text is null or origen = $4) and ($5::text is null or estado = $5)
        order by creado_en, id`,
      [T, f.usuarioId ?? null, f.tipo ?? null, f.origen ?? null, f.estado ?? null],
    );
    return r.rows as FilaEnvio[];
  }

  /** El único envío que cumple el filtro; lanza si hay 0 o más de 1. */
  async envioDe(
    T: string,
    f: { usuarioId?: string; tipo?: string; origen?: string; estado?: string },
  ): Promise<FilaEnvio> {
    const filas = await this.envios(T, f);
    if (filas.length !== 1)
      throw new Error(`se esperaba 1 envío y hay ${filas.length}`);
    return filas[0]!;
  }

  async envio(id: string): Promise<FilaEnvio> {
    return (
      await this.admin.pool.query("select * from correo_envio where id = $1", [
        id,
      ])
    ).rows[0] as FilaEnvio;
  }

  async avisosDe(
    T: string,
    f: { usuarioId?: string; envioId?: string } = {},
  ): Promise<any[]> {
    return (
      await this.admin.pool.query(
        `select * from correo_envio_aviso
          where tenant_id = $1 and ($2::uuid is null or usuario_id = $2) and ($3::uuid is null or envio_id = $3)
          order by creado_en, notificacion_id`,
        [T, f.usuarioId ?? null, f.envioId ?? null],
      )
    ).rows;
  }

  async tokensDe(envioId: string): Promise<{ hash: Buffer; vence_en: Date; creado_en: Date; usuario_id: string; tipo: string }[]> {
    return (
      await this.admin.pool.query(
        "select * from correo_baja_token where envio_id = $1",
        [envioId],
      )
    ).rows;
  }

  /** Trabajos `notificacion.enviar` del estudio (job_registro), del más viejo al más nuevo. */
  async trabajosEnviar(T: string): Promise<any[]> {
    return (
      await this.admin.pool.query(
        "select * from job_registro where tenant_id = $1 and tipo = 'notificacion.enviar' order by creado_en, id",
        [T],
      )
    ).rows;
  }

  /** Mueve `programado_para` del envío (intervalo SQL desde ahora, p. ej. `'10 minutes'` o `'-1 minute'`). */
  async programarPara(envioId: string, desdeAhora: string): Promise<void> {
    await this.admin.pool.query(
      "update correo_envio set programado_para = clock_timestamp() + $2::interval where id = $1",
      [envioId, desdeAhora],
    );
  }

  /** Día de Lima (AAAA-MM-DD) y día ISO de la semana, con el reloj de la BD. */
  async hoyLima(): Promise<{ dia: string; isodow: number }> {
    const r = await this.admin.pool.query(
      `select to_char(clock_timestamp() at time zone 'America/Lima', 'YYYY-MM-DD') as dia,
              extract(isodow from clock_timestamp() at time zone 'America/Lima')::int as isodow`,
    );
    return { dia: r.rows[0].dia as string, isodow: r.rows[0].isodow as number };
  }

  /** Día de Lima de hoy menos `k` días (AAAA-MM-DD). */
  async diaLima(k = 0): Promise<string> {
    return (
      await this.admin.pool.query(
        "select to_char((clock_timestamp() at time zone 'America/Lima')::date - $1::int, 'YYYY-MM-DD') as d",
        [k],
      )
    ).rows[0].d as string;
  }

  /** AAAAMM del mes anterior en Lima (el periodo del resumen). */
  async periodoAnterior(): Promise<string> {
    return (
      await this.admin.pool.query(
        "select to_char(date_trunc('month', clock_timestamp() at time zone 'America/Lima') - interval '1 month', 'YYYYMM') as p",
      )
    ).rows[0].p as string;
  }

  /** `crear_correo_resumenes(dia)` como el worker del estudio; devuelve cuántos envíos creó. */
  async crearResumenes(T: string, dia: string): Promise<number> {
    const r = await this.worker.withTenant({ tenantId: T }, (tx) =>
      tx.query("select crear_correo_resumenes($1::date) as n", [dia]),
    );
    return Number(r.rows[0].n);
  }

  /**
   * Resumen anterior de un usuario con un ciclo real: lo crea para `dia` (pasado), lo toma y lo cierra como `enviado` con el
   * `corte_hasta` dado, para que ese corte sea el que produce el sistema. El usuario debe tener el resumen activo.
   */
  async resumenAnterior(
    T: string,
    usuarioId: string,
    dia: string,
    corte: Date,
  ): Promise<string> {
    await this.crearResumenes(T, dia);
    const e = await this.envioDe(T, { usuarioId, origen: "resumen" });
    await this.worker.withTenant({ tenantId: T }, async (tx) => {
      await tx.query("select correo_envio_tomar($1::uuid)", [e.id]);
      await tx.query(
        "select correo_envio_cerrar($1::uuid, 'enviado', null, $2::timestamptz)",
        [e.id, corte],
      );
    });
    return e.id;
  }

  /**
   * `n` envíos `enviado` de relleno del tope diario (no son avisos: son su resultado), de hoy y de origen `aviso`. Es lo único de
   * `correo_envio` que se inserta directo.
   */
  async sembrarEnviados(
    T: string,
    usuarioId: string,
    n: number,
    tipo: TipoAviso = "buzon_critico",
  ): Promise<void> {
    await this.admin.pool.query(
      `insert into correo_envio (tenant_id, usuario_id, origen, tipo, estado, clave, programado_para, intentos, total_avisos, creado_en, enviado_en)
       select $1::uuid, $2::uuid, 'aviso', $3::text, 'enviado', 'aviso:' || $2::text || ':' || $3::text || ':' || gen_random_uuid()::text,
              clock_timestamp(), 1, 1, clock_timestamp(), clock_timestamp()
         from generate_series(1, $4::int)`,
      [T, usuarioId, tipo, n],
    );
  }

  /** Hace pasar `dias` para los envíos dados (o todo `correo_*` del estudio): modo replica, conexión descartable. */
  async envejecer(T: string, dias: number, soloEnvios?: string[]): Promise<void> {
    const c = await this.admin.pool.connect();
    try {
      await c.query("SET session_replication_role = replica");
      await c.query(
        `update correo_envio set creado_en = creado_en - make_interval(days => $2::int),
                programado_para = programado_para - make_interval(days => $2::int)
          where tenant_id = $1 and ($3::uuid[] is null or id = any($3))`,
        [T, dias, soloEnvios ?? null],
      );
      await c.query(
        `update correo_envio_aviso set creado_en = creado_en - make_interval(days => $2::int)
          where tenant_id = $1 and ($3::uuid[] is null or envio_id = any($3))`,
        [T, dias, soloEnvios ?? null],
      );
      await c.query(
        `update correo_baja_token set creado_en = creado_en - make_interval(days => $2::int),
                vence_en = vence_en - make_interval(days => $2::int)
          where tenant_id = $1 and ($3::uuid[] is null or envio_id = any($3))`,
        [T, dias, soloEnvios ?? null],
      );
    } finally {
      c.release(true);
    }
  }

  // ---- Descargas, periodos y mensajes del resumen ------------------------------------------------------------------------

  /** `sire.propuesta.descargar` del cliente, libro y periodo, llevado a `completado` por las transiciones del registro de 008. */
  async descarga(
    T: string,
    c: ClientePrueba,
    libro: Libro,
    periodo: string,
    creadoPor: string,
  ): Promise<string> {
    const vista = await this.backend.withTenant(
      { tenantId: T, userId: creadoPor },
      (tx) =>
        insertarTrabajo(tx, {
          clienteId: c.id,
          ruc: c.ruc,
          tipo: "sire.propuesta.descargar",
          cola: "sire",
          canal: "sire",
          prioridad: "interactivo",
          parametros: { periodo, libro },
          claveDedupe: randomBytes(32),
          creadoPor,
          maxIntentos: 3,
        }),
    );
    await this.worker.withTenant({ tenantId: T }, async (tx) => {
      await transicionar(tx, vista.id, "en_cola", "ejecutando");
      await transicionar(tx, vista.id, "ejecutando", "completado");
    });
    return vista.id;
  }

  /** Estado guardado del periodo del libro (sin fila equivale a `abierto`). */
  async periodo(
    T: string,
    c: ClientePrueba,
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
    await this.admin.pool.query(sentencia, [T, c.id, periodo, estado]);
  }

  /** Mensajes con el estado exacto dado (`replica`: sin los triggers de aviso ni de histórico; así no nace ningún aviso). */
  async sembrarMensajes(
    T: string,
    atiende: string,
    filas: MensajeFila[],
  ): Promise<void> {
    if (filas.length === 0) return;
    const c = await this.admin.pool.connect();
    try {
      await c.query("SET session_replication_role = replica");
      await c.query(
        `insert into buzon_mensaje (tenant_id, cliente_id, id_sunat, asunto, remitente, fecha, categoria, critico, motivo_critico,
                                    version_catalogo, avisado, historico, atendido_en, atendido_por, primera_captura_en, ultima_captura_en)
         select $1, x.c, 'T5-' || gen_random_uuid()::text, 'Asunto T5', 'SUNAT', x.cap::timestamptz,
                case when x.cr then 'coactiva' else 'otro' end, x.cr, case when x.cr then 'codigo' else null end, 1, false,
                x.hi, case when x.aten then x.cap::timestamptz else null end, case when x.aten then $2::uuid else null end,
                x.cap::timestamptz, x.cap::timestamptz
           from jsonb_to_recordset($3::jsonb) as x(c uuid, cr boolean, hi boolean, aten boolean, cap text)`,
        [
          T,
          atiende,
          JSON.stringify(
            filas.map((f) => ({
              c: f.clienteId,
              cr: f.critico,
              hi: f.historico,
              aten: f.atendido,
              cap: f.capturadoEn.toISOString(),
            })),
          ),
        ],
      );
    } finally {
      c.release(true);
    }
  }

  /** Volcado en texto de todo lo que dejan los envíos en la BD (correo_*, job_registro, notificación, auditoría) para buscar canarios. */
  async volcar(estudios: string[] = this.estudios): Promise<string> {
    const r = await this.admin.pool.query(
      `select t from (
         select to_jsonb(x)::text as t from correo_envio x where tenant_id = any($1::uuid[])
         union all select to_jsonb(x)::text from correo_envio_aviso x where tenant_id = any($1::uuid[])
         union all select to_jsonb(x)::text from correo_baja_token x where tenant_id = any($1::uuid[])
         union all select to_jsonb(x)::text from correo_preferencia x where tenant_id = any($1::uuid[])
         union all select to_jsonb(j)::text from job_registro j where tenant_id = any($1::uuid[]) and tipo = 'notificacion.enviar'
         union all select to_jsonb(n)::text from notificacion n where tenant_id = any($1::uuid[])
         union all select to_jsonb(a)::text from auditoria a where tenant_id = any($1::uuid[])
       ) y`,
      [estudios],
    );
    return (r.rows as { t: string }[]).map((f) => f.t).join("\n");
  }

  /**
   * Limpieza (lección de 026/027): en modo `replica` y antes de borrar el estudio, TODA tabla con `tenant_id` (descubierta en
   * `information_schema`, así entran `correo_preferencia`, `correo_envio`, `correo_envio_aviso`, `correo_baja_token` y las que vengan);
   * después planes, usuarios y estudios; lanza si algún estudio queda (si no, `tests/aislamiento/planes.spec.ts` falla en CI).
   */
  override async limpiar(): Promise<void> {
    await limpiarFilas017(this.admin, this.estudios).catch(() => undefined);
    const c = await this.admin.pool.connect();
    let quedan = 0;
    try {
      await c.query("SET session_replication_role = replica");
      const tablas = await c.query(
        `select c.table_name from information_schema.columns c
           join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
          where c.table_schema = 'public' and c.column_name = 'tenant_id' and t.table_type = 'BASE TABLE'
          order by c.table_name`,
      );
      for (const { table_name: tabla } of tablas.rows as { table_name: string }[]) {
        if (!/^[a-z_][a-z0-9_]*$/.test(tabla)) continue;
        // eslint-disable-next-line sql-crudo/sin-sql-crudo -- identificador de information_schema validado; solo en la limpieza
        await c.query(`delete from public."${tabla}" where tenant_id = any($1::uuid[])`, [this.estudios]);
      }
      if (this.planesCorreo.length > 0)
        await c.query("delete from plan where codigo = any($1::text[])", [this.planesCorreo]);
      await c.query("delete from usuario where id = any($1::uuid[])", [this.usuariosCorreo]);
      await c.query("delete from tenant where id = any($1::uuid[])", [this.estudios]);
      quedan = Number(
        (await c.query("select count(*)::int as n from tenant where id = any($1::uuid[])", [this.estudios])).rows[0].n,
      );
    } finally {
      c.release(true); // la conexión con session_replication_role = replica no vuelve al pool
    }
    await super.limpiar(); // los planes y usuarios que el escenario del buzón conozca (ya sin estudios)
    if (quedan > 0) throw new Error("la limpieza no pudo borrar el estudio de la prueba");
  }
}
