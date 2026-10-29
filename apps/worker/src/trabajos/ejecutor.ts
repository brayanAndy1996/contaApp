// Ejecutor de trabajos (spec 008; D1, D2, D5, D6, D13; CA-4, CA-8, CA-9, CA-10, CA-15, CA-16).
//  (1) withTenant corto: carga la fila; si no existe en el estudio del payload, el tipo o la cola no coinciden o no
//      está `ejecutando`, termina SIN efectos (payload forjado o repetido).
//  (2) Arriendo `ejec:{jobId}`: un solo ejecutor por trabajo; si ya lo tiene otro, termina.
//  (3) Procesador SIN transacción abierta (D6), con latido que renueva ejec, cupos y lock del RUC.
//  (4) withTenant corto con el resultado (`ejecutando → …`, ganador único): completado | reintento (`en_cola`,
//      intentos + 1, backoff) | error con motivo. Clasificación con `clasificarError` (sunat) y decisión con
//      `decidirTrasError` (queue) usando la `config_sistema` VIGENTE. Con `ErrorCredencial`, en la misma transacción,
//      `marcarCredencialInvalida`.
//  (5) Tras el commit: avisa al Notificador (una vez, solo si la credencial cambió; sin esperarlo), libera cupos y
//      ejec, deja el lock del RUC con PX = espera_ruc_ms, vuelve a publicar el reintento y publica el evento. Después
//      del evento no hace nada más (Ratificaciones de T5/T6 (6)).
// Nada de lo que lanza el procesador llega a la BD, a Redis, a los eventos ni a los logs: solo códigos.
import {
  leerTrabajo,
  marcarCredencialInvalida,
  transicionar,
  type ConfigCola,
  type MotivoTrabajo,
  type TrabajoFila,
} from "@contapp/db";
import {
  CacheConfig,
  crearClaves,
  decidirTrasError,
  definicionDe,
  iniciarLatido,
  liberarArriendos,
  publicar,
  publicarEvento,
  renovarArriendos,
  soltarLockRuc,
  tomarEjecucion,
  vistaDeFila,
  type ClavesCola,
  type ClienteRedis,
  type DbCola,
  type DefinicionTrabajo,
  type NombreCola,
  type PayloadTrabajo,
  type Reloj,
} from "@contapp/queue";
import { clasificarError } from "@contapp/sunat";
import {
  camposTrabajo,
  registrar,
  type LoggerTrabajos,
  type Notificador,
} from "./registro.js";
import type { CacheTokenSire } from "./token-sire/cache-token.js";

export interface TrabajoEnCurso {
  id: string;
  tenantId: string;
  clienteId: string;
  ruc: string;
  tipo: string;
  parametros: unknown;
  intentos: number;
  creadoPor: string | null;
}

export interface ContextoProcesador {
  trabajo: TrabajoEnCurso;
  /** Usa el token SIRE del cliente del trabajo (CA-11): caché, single-flight y una renovación tras un 401. */
  conToken<T>(usar: (token: string) => Promise<T>): Promise<T>;
}

/** Lo devuelto (JSON ≤ 4 KB) queda en `job_registro.resultado`; lo lanzado se clasifica (CA-8, CA-9). */
export type Procesador = (ctx: ContextoProcesador) => Promise<unknown>;

export interface DepsEjecutor {
  db: DbCola;
  redis: ClienteRedis;
  reloj: Reloj;
  prefijo?: string;
  procesadores: Readonly<Record<string, Procesador>>;
  config: CacheConfig;
  tokens: Pick<CacheTokenSire, "conToken">;
  notificador: Notificador;
  logger: LoggerTrabajos;
  latidoMs: number;
}

/** Sin fila de configuración (no debería pasar: el worker solo atiende colas configuradas): sin reintentos ni espera. */
const CONFIG_MINIMA: Pick<
  ConfigCola,
  "reintentos" | "backoffBaseMs" | "esperaRucMs"
> = { reintentos: 0, backoffBaseMs: 5_000, esperaRucMs: 0 };

/** Lo que devolvió el procesador: su resultado o solo la clase del error (el error se descarta, CA-16). */
type Salida =
  | { hacia: "completado"; resultado: unknown }
  | { hacia: "fallo"; clase: string }
  | { hacia: "error"; motivo: MotivoTrabajo };

type Desenlace =
  | { hacia: "completado"; resultado: unknown }
  | { hacia: "en_cola"; intentos: number; disponibleDesde: Date }
  | { hacia: "error"; motivo: MotivoTrabajo };

interface Final {
  fila: TrabajoFila;
  credencialCambio: boolean;
}

interface EnCurso {
  fila: TrabajoFila;
  detenerLatido: () => void;
}

export class Ejecutor {
  private readonly k: ClavesCola;
  private readonly prefijo: string | undefined;
  private readonly enCurso = new Map<string, EnCurso>();
  private readonly promesas = new Set<Promise<void>>();

  constructor(private readonly d: DepsEjecutor) {
    this.prefijo = d.prefijo;
    this.k = crearClaves(d.prefijo);
  }

  /** Ejecuta el job de BullMQ. Nunca lanza: los fallos se registran con códigos. */
  ejecutar(cola: NombreCola, payload: PayloadTrabajo): Promise<void> {
    const p = this.ejecutarSeguro(cola, payload);
    this.promesas.add(p);
    void p.finally(() => this.promesas.delete(p));
    return p;
  }

  /** Espera a los trabajos en curso hasta `ms`; true si terminaron todos. */
  async esperar(ms: number): Promise<boolean> {
    let reloj: NodeJS.Timeout | undefined;
    const tope = new Promise<false>(
      (r) => (reloj = setTimeout(() => r(false), ms)),
    );
    const todos = Promise.allSettled([...this.promesas]).then(
      () => true as const,
    );
    try {
      return await Promise.race([todos, tope]);
    } finally {
      clearTimeout(reloj);
    }
  }

  /** Cierre sin esperar más: detiene los latidos y libera los arriendos de lo que sigue en curso (lo resuelve el reconciliador). */
  async soltarEnCurso(): Promise<void> {
    for (const [id, e] of [...this.enCurso]) {
      e.detenerLatido();
      this.enCurso.delete(id);
      try {
        await liberarArriendos(this.d.redis, this.k, e.fila, 0);
      } catch {
        // vence solo (≤ 30 s)
      }
    }
  }

  /** Muerte del proceso: solo detiene los latidos (no libera nada ni escribe). */
  abandonar(): void {
    for (const e of this.enCurso.values()) e.detenerLatido();
    this.enCurso.clear();
  }

  private async ejecutarSeguro(
    cola: NombreCola,
    payload: PayloadTrabajo,
  ): Promise<void> {
    const campos = {
      tenant_id: payload.tenantId,
      job_id: payload.jobId,
      tipo: payload.tipo,
    };
    try {
      await this.ejecutarJob(cola, payload);
    } catch {
      registrar(this.d.logger, "error", {
        evento: "trabajo_fallo_interno",
        ...campos,
      });
    }
  }

  private async ejecutarJob(
    cola: NombreCola,
    payload: PayloadTrabajo,
  ): Promise<void> {
    const { db, redis, logger } = this.d;
    // (1) Carga y validación (CA-15).
    const fila = await db.withTenant({ tenantId: payload.tenantId }, (tx) =>
      leerTrabajo(tx, payload.jobId),
    );
    if (
      fila === null ||
      fila.tenantId !== payload.tenantId ||
      fila.tipo !== payload.tipo ||
      fila.cola !== cola ||
      fila.estado !== "ejecutando"
    ) {
      registrar(logger, "warn", {
        evento: "trabajo_descartado",
        tenant_id: payload.tenantId,
        job_id: payload.jobId,
        tipo: payload.tipo,
      });
      return;
    }
    const campos = camposTrabajo(fila);
    // (2) Un solo ejecutor por trabajo.
    if (!(await tomarEjecucion(redis, this.k, fila.id))) {
      registrar(logger, "warn", { evento: "trabajo_ya_en_curso", ...campos });
      return;
    }
    // (3) Procesador sin transacción abierta (D6), con latido.
    const detenerLatido = iniciarLatido(
      () =>
        renovarArriendos(redis, this.k, fila, this.d.reloj.ahora().getTime()),
      this.d.latidoMs,
    );
    this.enCurso.set(fila.id, { fila, detenerLatido });
    registrar(logger, "info", {
      evento: "trabajo_iniciado",
      ...campos,
      intentos: fila.intentos,
    });
    let salida: Salida;
    let def: DefinicionTrabajo | null = null;
    try {
      def = definicionDe(fila.tipo);
      salida = await this.procesar(fila);
    } catch {
      salida = { hacia: "error", motivo: "error_interno" }; // tipo sin definición
    } finally {
      detenerLatido();
    }
    if (!this.enCurso.delete(fila.id)) return; // abandonado (muerte o cierre agotado): sin efectos

    // (4) Resultado, con la configuración vigente.
    const cfg = (await this.d.config.obtener()).get(fila.cola) ?? CONFIG_MINIMA;
    const decidido = this.decidir(salida, fila, cfg);
    // El procesador ya terminó: el lock del RUC pasa a durar solo la espera (D20) desde ya, para que nadie vea el estado
    // final con el arriendo largo. Con espera 0 se conserva hasta después del commit (lo suelta liberarArriendos): así
    // el siguiente del mismo RUC no se despacha antes de que la credencial quede marcada (CA-9).
    if (cfg.esperaRucMs > 0) {
      await soltarLockRuc(redis, this.k, fila, cfg.esperaRucMs).catch(
        () => undefined,
      );
    }
    let final: Final | null;
    try {
      final = await this.cerrar(fila, decidido, def);
    } catch {
      // Ni el resultado ni error_interno se pudieron escribir: se sueltan los arriendos y lo resuelve el reconciliador.
      await liberarArriendos(redis, this.k, fila, cfg.esperaRucMs);
      throw new Error("transición final fallida");
    }
    if (final === null) {
      registrar(logger, "warn", {
        evento: "trabajo_transicion_perdida",
        ...campos,
      });
      return;
    }
    // (5) Tras el commit. El aviso sale en cuanto la credencial quedó marcada, sin esperarlo: un canal lento o caído
    // no retiene el lock ni los cupos, y su fallo solo se registra (el trabajo ya quedó en error).
    if (final.credencialCambio && def?.credencial) {
      this.avisar(
        {
          tenantId: fila.tenantId,
          clienteId: fila.clienteId,
          tipo: def.credencial,
          trabajoId: fila.id,
        },
        campos,
      );
    }
    await liberarArriendos(redis, this.k, fila, cfg.esperaRucMs);
    if (final.fila.estado === "en_cola") {
      await publicar(
        redis,
        [
          {
            id: fila.id,
            tenantId: fila.tenantId,
            cola: fila.cola,
            prioridad: fila.prioridad,
            creadoEn: fila.creadoEn,
          },
        ],
        {
          prefijo: this.prefijo,
        },
      );
    }
    const f = final.fila;
    if (f.estado === "completado")
      registrar(logger, "info", { evento: "trabajo_completado", ...campos });
    else if (f.estado === "en_cola")
      registrar(logger, "warn", {
        evento: "trabajo_reintento",
        ...campos,
        codigo: "sunat_no_responde",
        intentos: f.intentos,
      });
    else
      registrar(logger, "warn", {
        evento: "trabajo_error",
        ...campos,
        codigo: f.motivo ?? "error_interno",
      });
    await publicarEvento(
      redis,
      fila.tenantId,
      vistaDeFila(f, { estado: f.estado, motivo: f.motivo }),
      { prefijo: this.prefijo },
    );
  }

  private avisar(
    aviso: Parameters<Notificador["credencialInvalida"]>[0],
    campos: ReturnType<typeof camposTrabajo>,
  ): void {
    const fallo = () =>
      registrar(this.d.logger, "warn", {
        evento: "notificador_fallo",
        ...campos,
        codigo: "credencial_invalida",
      });
    try {
      void this.d.notificador.credencialInvalida(aviso).catch(fallo);
    } catch {
      fallo();
    }
  }

  private async procesar(fila: TrabajoFila): Promise<Salida> {
    const procesador = Object.hasOwn(this.d.procesadores, fila.tipo)
      ? this.d.procesadores[fila.tipo]
      : undefined;
    if (typeof procesador !== "function")
      return { hacia: "error", motivo: "error_interno" };
    const trabajo: TrabajoEnCurso = {
      id: fila.id,
      tenantId: fila.tenantId,
      clienteId: fila.clienteId,
      ruc: fila.ruc,
      tipo: fila.tipo,
      parametros: fila.parametros,
      intentos: fila.intentos,
      creadoPor: fila.creadoPor,
    };
    const ctxToken = {
      tenantId: fila.tenantId,
      clienteId: fila.clienteId,
      ruc: fila.ruc,
    };
    try {
      const resultado = await procesador({
        trabajo,
        conToken: (usar) => this.d.tokens.conToken(ctxToken, usar),
      });
      return { hacia: "completado", resultado };
    } catch (e) {
      // Solo la clase del error cuenta; el error (y su mensaje, causa o propiedades) se descarta aquí (CA-16).
      return { hacia: "fallo", clase: clasificarError(e).clase };
    }
  }

  /** Aplica `decidirTrasError` a un fallo del procesador; lo demás pasa tal cual. */
  private decidir(
    s: Salida,
    fila: TrabajoFila,
    cfg: Pick<ConfigCola, "reintentos" | "backoffBaseMs">,
  ): Desenlace {
    if (s.hacia !== "fallo") return s;
    const r = decidirTrasError(
      { clase: s.clase, motivo: s.clase },
      {
        intentos: fila.intentos,
        reintentos: cfg.reintentos,
        baseMs: cfg.backoffBaseMs,
        ahora: this.d.reloj.ahora(),
      },
    );
    return r.accion === "reintentar"
      ? {
          hacia: "en_cola",
          intentos: r.intentos,
          disponibleDesde: r.disponibleDesde,
        }
      : { hacia: "error", motivo: r.motivo };
  }

  /** Transacción final; si falla (p. ej. resultado fuera del CHECK), deja el trabajo en error/error_interno. */
  private async cerrar(
    fila: TrabajoFila,
    d: Desenlace,
    def: DefinicionTrabajo | null,
  ): Promise<Final | null> {
    try {
      return await this.transicionFinal(fila, d, def);
    } catch (e) {
      if (d.hacia === "error" && d.motivo === "error_interno") throw e;
      return this.transicionFinal(
        fila,
        { hacia: "error", motivo: "error_interno" },
        null,
      );
    }
  }

  private transicionFinal(
    fila: TrabajoFila,
    d: Desenlace,
    def: DefinicionTrabajo | null,
  ): Promise<Final | null> {
    return this.d.db.withTenant({ tenantId: fila.tenantId }, async (tx) => {
      const campos =
        d.hacia === "completado"
          ? { resultado: d.resultado ?? null }
          : d.hacia === "en_cola"
            ? { intentos: d.intentos, disponibleDesde: d.disponibleDesde }
            : { motivo: d.motivo };
      if (!(await transicionar(tx, fila.id, "ejecutando", d.hacia, campos)))
        return null;
      let credencialCambio = false;
      if (
        d.hacia === "error" &&
        d.motivo === "credencial_invalida" &&
        def?.credencial
      ) {
        credencialCambio = await marcarCredencialInvalida(
          tx,
          fila.clienteId,
          def.credencial,
        );
      }
      const actual = await leerTrabajo(tx, fila.id);
      return actual === null ? null : { fila: actual, credencialCambio };
    });
  }
}
