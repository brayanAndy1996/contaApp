import {
  Inject,
  Injectable,
  Optional,
  type OnModuleDestroy,
} from "@nestjs/common";
import { listarClientes, type ContappDb } from "@contapp/db";
import {
  avisoNotificacionSchema,
  eventoTrabajoSchema,
  type EventoTrabajo,
} from "@contapp/shared";
import { AuthService, type SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { AccesoError } from "../acceso/errores.js";
import { TrabajosError } from "./errores.js";
import { RedisTrabajos } from "./redis.js";
import { actorDe, contextoSesion } from "./trabajos.service.js";

/** Tiempos del stream (plan 008: HTTP; CA-6). Las pruebas unitarias los acortan. */
export interface TiemposStream {
  /** Latido (comentario SSE) para que proxies y navegador no corten la conexión. */
  latidoMs: number;
  /** Revalidación de sesión, estudio, rol y asignaciones (caché ≤ 10 s, CA-6). */
  revalidacionMs: number;
  /** Cierre para que el cliente reconecte (y vuelva a pasar por los guards). */
  duracionMs: number;
  /** Streams abiertos por sesión (CA-6). */
  maxPorSesion: number;
  /** Espera máxima de la confirmación de SUBSCRIBE antes del primer byte (Redis caído: se abre igual). */
  suscripcionMs: number;
}

export const TIEMPOS_STREAM = Symbol("TRABAJOS_TIEMPOS_STREAM");

export const TIEMPOS_POR_DEFECTO: TiemposStream = {
  latidoMs: 15_000,
  revalidacionMs: 5_000,
  duracionMs: 5 * 60_000,
  maxPorSesion: 3,
  suscripcionMs: 3_000,
};

/** Lo mínimo de la respuesta HTTP (Express) que usa el stream. */
export interface RespuestaSse {
  status(n: number): unknown;
  setHeader(nombre: string, valor: string): unknown;
  flushHeaders(): void;
  write(trozo: string): unknown;
  end(): unknown;
  on(evento: "close", f: () => void): unknown;
  readonly writableEnded: boolean;
  readonly socket?: { readonly destroyed: boolean } | null;
}

/**
 * Clientes cuyos eventos ve el usuario: todos los del estudio (alcance global) o solo los asignados (D5 de 005). Con
 * alcance global también es una lista: un evento del canal con un `clienteId` que no es del estudio no se reenvía
 * (H-008-1b-8, defensa en profundidad de CA-5). Se recarga en cada revalidación (≤ 5 s).
 */
type Visibilidad = { clientes: Set<string> };

interface Conexion {
  sesionId: string;
  usuarioId: string;
  tenantId: string;
  canal: string;
  /** Cabecera Cookie original (solo en memoria, para revalidar la sesión; nunca se registra). */
  cookie: string | undefined;
  visibilidad: Visibilidad;
  res: RespuestaSse;
  temporizadores: ReturnType<typeof setTimeout>[];
  revalidando: boolean;
  cerrada: boolean;
  /**
   * Eventos de clientes que no estaban en la lista, en orden, mientras se recarga la lista (H-008-2a-6); null si no
   * hay nada pendiente.
   */
  cola: Promise<void> | null;
  /** Clientes con eventos en `cola`: los siguientes de esos clientes también esperan (orden por trabajo). */
  esperando: Set<string>;
  /** Clientes ya consultados y no visibles desde la última recarga: no se vuelven a consultar hasta la siguiente. */
  consultados: Set<string>;
}

const evento = (e: EventoTrabajo): string =>
  `event: trabajo\ndata: ${JSON.stringify(e)}\n\n`;

/** Spec 017 (D-9): el aviso de notificación nueva viaja SIN contenido; el cliente pide el conteo y la lista por HTTP. */
const MARCO_NOTIFICACION = "event: notificacion\ndata: {}\n\n";

/**
 * SSE de `/trabajos/stream` (CA-6): un suscriptor Redis por proceso, suscrito a `eventos:{tenantId}` mientras haya
 * streams de ese estudio. Cada mensaje se valida con `eventoTrabajoSchema` (sale solo con las claves de la vista; lo
 * inválido se descarta en silencio) y se envía a los streams cuyo usuario ve el cliente. Cada 5 s se revalida la
 * sesión (vigente y con el mismo estudio) y la membresía (rol, activa, asignaciones); si ya no vale, se cierra.
 */
@Injectable()
export class StreamService implements OnModuleDestroy {
  private readonly tiempos: TiemposStream;
  private readonly porCanal = new Map<string, Set<Conexion>>();
  private readonly porSesion = new Map<string, number>();
  /** SUBSCRIBE en curso por canal, compartido por las conexiones que se unen mientras Redis lo confirma. */
  private readonly suscribiendo = new Map<string, Promise<void>>();
  /** Cola de SUBSCRIBE/UNSUBSCRIBE por canal: se envían a Redis en el orden en que se pidieron. */
  private readonly cadena = new Map<string, Promise<void>>();
  private escuchando = false;
  private cerrado = false;

  constructor(
    @Inject(DB) private readonly db: Pick<ContappDb, "withTenant">,
    @Inject(AuthService)
    private readonly auth: Pick<AuthService, "resolverSesion">,
    @Inject(RedisTrabajos) private readonly redis: RedisTrabajos,
    @Optional() @Inject(TIEMPOS_STREAM) tiempos?: Partial<TiemposStream>,
  ) {
    this.tiempos = { ...TIEMPOS_POR_DEFECTO, ...tiempos };
  }

  /** Streams abiertos (para pruebas y diagnóstico; sin datos). */
  get abiertos(): number {
    let n = 0;
    for (const s of this.porCanal.values()) n += s.size;
    return n;
  }

  /**
   * Abre el stream: 429 `streams_excedidos` al 4.º de la sesión; carga el alcance; registra la conexión y espera la
   * confirmación de Redis de la suscripción al canal del estudio; solo entonces envía las cabeceras y el primer byte
   * (`: conectado`, sin evento inicial). Contrato (018 T11e): cuando el cliente ve el primer byte, la conexión ya está
   * registrada y SUBSCRIBE ya está confirmado, así que ningún evento publicado desde ese instante se pierde.
   */
  async abrir(
    sesion: SesionResuelta,
    cookie: string | undefined,
    res: RespuestaSse,
  ): Promise<void> {
    const ctx = contextoSesion(sesion);
    const enUso = this.porSesion.get(sesion.sesionId) ?? 0;
    if (this.cerrado || enUso >= this.tiempos.maxPorSesion) {
      throw new TrabajosError("streams_excedidos");
    }
    // Se reserva antes de cualquier await: dos aperturas simultáneas no pasan juntas el límite.
    this.porSesion.set(sesion.sesionId, enUso + 1);
    let visibilidad: Visibilidad | null;
    try {
      visibilidad = await this.visibilidad(ctx.tenantId, sesion.usuarioId);
    } catch (e) {
      this.liberar(sesion.sesionId);
      throw e;
    }
    if (visibilidad === null) {
      this.liberar(sesion.sesionId);
      throw new AccesoError("estudio_requerido");
    }

    const c: Conexion = {
      sesionId: sesion.sesionId,
      usuarioId: sesion.usuarioId,
      tenantId: ctx.tenantId,
      canal: this.redis.claves.eventos(ctx.tenantId),
      cookie,
      visibilidad,
      res,
      temporizadores: [],
      revalidando: false,
      cerrada: false,
      cola: null,
      esperando: new Set(),
      consultados: new Set(),
    };
    res.on("close", () => this.cerrar(c));
    // El cliente pudo irse mientras se cargaba el alcance.
    if (res.writableEnded || res.socket?.destroyed === true) {
      this.cerrar(c);
      return;
    }
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    // 007b D10: `no-transform` impide que un proxy (el rewrite de Next) recomprima o reordene el flujo.
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    // Primero se registra y se espera la suscripción; las cabeceras y el primer byte salen después (018 T11e).
    await this.esperar(this.registrar(c), this.tiempos.suscripcionMs);
    // El cliente pudo irse (o el módulo apagarse) durante la espera: `cerrar` ya liberó cupo y canal.
    if (c.cerrada) return;
    if (clienteSeFue(res)) {
      this.cerrar(c);
      return;
    }
    res.flushHeaders();
    // 007b D-2: el rewrite de Next no entrega las cabeceras hasta el primer byte del cuerpo; sin esto el cliente
    // esperaba al primer latido (~15 s). Es un comentario SSE: el lector del panel lo ignora.
    res.write(": conectado\n\n");

    c.temporizadores.push(
      setInterval(() => {
        if (!c.cerrada) c.res.write(": latido\n\n");
      }, this.tiempos.latidoMs),
      setInterval(() => void this.revalidar(c), this.tiempos.revalidacionMs),
      setTimeout(() => this.cerrar(c), this.tiempos.duracionMs),
    );
  }

  /** Cierre ordenado al apagar: termina cada stream y deja el canal; luego `RedisTrabajos` cierra las conexiones. */
  onModuleDestroy(): void {
    this.cerrado = true;
    const todas = [...this.porCanal.values()].flatMap((s) => [...s]);
    for (const c of todas) this.cerrar(c);
  }

  private liberar(sesionId: string): void {
    const n = (this.porSesion.get(sesionId) ?? 1) - 1;
    if (n <= 0) this.porSesion.delete(sesionId);
    else this.porSesion.set(sesionId, n);
  }

  /**
   * Añade la conexión al canal y devuelve la promesa de su suscripción (compartida por las conexiones del canal
   * mientras Redis la confirma; ya resuelta si el canal ya estaba suscrito). Nunca rechaza: un SUBSCRIBE fallido se
   * tolera (el stream se abre igual y el evento `ready` vuelve a suscribir al recuperarse Redis).
   */
  private registrar(c: Conexion): Promise<void> {
    let set = this.porCanal.get(c.canal);
    if (set !== undefined) {
      set.add(c);
      return this.suscribiendo.get(c.canal) ?? Promise.resolve();
    }
    set = new Set([c]);
    this.porCanal.set(c.canal, set);
    const sub = this.suscriptor(); // instala el manejador de mensajes antes de pedir el canal
    const p = this.encadenar(c.canal, async () => {
      await sub?.subscribe(c.canal);
    });
    this.suscribiendo.set(c.canal, p);
    void p.then(() => {
      if (this.suscribiendo.get(c.canal) === p) this.suscribiendo.delete(c.canal);
    });
    return p;
  }

  /**
   * Encola una operación de suscripción del canal tras las anteriores si hay una en curso: un UNSUBSCRIBE de la última conexión nunca
   * se adelanta ni pisa al SUBSCRIBE pendiente de una conexión nueva. Los fallos se tragan.
   */
  private encadenar(canal: string, op: () => Promise<void>): Promise<void> {
    const previa = this.cadena.get(canal);
    // Sin operación en curso se envía en el acto (Redis ya ordena los comandos de una misma conexión).
    const sig = (previa === undefined ? op() : previa.then(op)).then(
      () => undefined,
      () => undefined,
    );
    this.cadena.set(canal, sig);
    void sig.then(() => {
      if (this.cadena.get(canal) === sig) this.cadena.delete(canal);
    });
    return sig;
  }

  /** Espera la promesa como máximo `ms` (Redis sin responder no deja el stream colgado). */
  private async esperar(p: Promise<void>, ms: number): Promise<void> {
    let t: ReturnType<typeof setTimeout> | undefined;
    const limite = new Promise<void>((ok) => {
      t = setTimeout(ok, ms);
    });
    try {
      await Promise.race([p, limite]);
    } finally {
      clearTimeout(t);
    }
  }

  private cerrar(c: Conexion): void {
    if (c.cerrada) return;
    c.cerrada = true;
    for (const t of c.temporizadores) clearTimeout(t);
    this.liberar(c.sesionId);
    const set = this.porCanal.get(c.canal);
    if (set?.delete(c) === true && set.size === 0) {
      this.porCanal.delete(c.canal);
      const sub = this.redis.suscriptor();
      if (sub !== null) {
        // Tras el SUBSCRIBE pendiente; y se omite si otra conexión volvió a tomar el canal entre tanto.
        void this.encadenar(c.canal, async () => {
          if (!this.porCanal.has(c.canal)) await sub.unsubscribe(c.canal);
        });
      }
    }
    if (!c.res.writableEnded) c.res.end();
  }

  /** El suscriptor del proceso, con su manejador instalado una sola vez. */
  private suscriptor() {
    const sub = this.redis.suscriptor();
    if (sub !== null && !this.escuchando) {
      this.escuchando = true;
      sub.on("message", (canal: string, texto: string) =>
        this.recibir(canal, texto),
      );
      // Tras una caída, vuelve a pedir los canales vigentes (los SUBSCRIBE fallidos no se reintentan solos).
      sub.on("ready", () => {
        for (const canal of this.porCanal.keys()) {
          sub.subscribe(canal).catch(() => undefined);
        }
      });
    }
    return sub;
  }

  private recibir(canal: string, texto: string): void {
    const conexiones = this.porCanal.get(canal);
    if (conexiones === undefined) return;
    let crudo: unknown;
    try {
      crudo = JSON.parse(texto);
    } catch {
      return;
    }
    // Spec 017: aviso de notificación nueva, solo a las conexiones de los destinatarios (nunca por visibilidad de cliente).
    const aviso = avisoNotificacionSchema.safeParse(crudo);
    if (aviso.success) {
      const destinatarios = new Set(aviso.data.destinatarios.map((d) => d.toLowerCase()));
      for (const c of conexiones) {
        if (!c.cerrada && destinatarios.has(c.usuarioId.toLowerCase())) c.res.write(MARCO_NOTIFICACION);
      }
      return;
    }
    const r = eventoTrabajoSchema.safeParse(crudo);
    if (!r.success) return;
    const marco = evento(r.data);
    for (const c of conexiones) this.entregar(c, r.data.clienteId, marco);
  }

  /**
   * Envía el evento si el usuario ve el cliente. Un cliente que no está en la lista (p. ej. creado con el stream
   * abierto, o recién asignado) no se descarta a ciegas hasta la revalidación de los 5 s (CA-6, H-008-2a-6): se
   * recarga la lista una vez por cliente desconocido y revalidación. Los eventos de clientes desconocidos esperan en
   * orden detrás de esa recarga; los de clientes visibles salen enseguida (un trabajo es de un solo cliente, así que el
   * orden de cada trabajo se conserva: lo encolado se entrega en microtareas apenas termina la recarga, antes del
   * siguiente mensaje de Redis).
   */
  private entregar(c: Conexion, clienteId: string, marco: string): void {
    if (c.cerrada) return;
    if (ve(c.visibilidad, clienteId) && !c.esperando.has(clienteId)) {
      c.res.write(marco);
      return;
    }
    if (c.cola === null && c.consultados.has(clienteId)) return;
    c.esperando.add(clienteId); // los siguientes de este cliente van detrás, aunque ya sea visible
    const turno = (c.cola ?? Promise.resolve())
      .then(async () => {
        if (c.cerrada) return;
        if (!ve(c.visibilidad, clienteId) && !c.consultados.has(clienteId)) {
          c.consultados.add(clienteId);
          await this.recargar(c);
        }
        if (!c.cerrada && ve(c.visibilidad, clienteId)) c.res.write(marco);
      })
      .catch(() => undefined);
    c.cola = turno;
    void turno.then(() => {
      if (c.cola === turno) {
        c.cola = null;
        c.esperando.clear();
      }
    });
  }

  /** Recarga la lista de clientes visibles; si ya no es miembro activo, cierra. Un fallo deja la lista anterior. */
  private async recargar(c: Conexion): Promise<void> {
    try {
      const v = await this.visibilidad(c.tenantId, c.usuarioId);
      if (v === null) this.cerrar(c);
      else c.visibilidad = v;
    } catch {
      // La revalidación periódica decide (y cierra si la BD sigue fallando).
    }
  }

  /** Rol y asignaciones vigentes del usuario en el estudio, o null si ya no es miembro activo. */
  private visibilidad(
    tenantId: string,
    usuarioId: string,
  ): Promise<Visibilidad | null> {
    return this.db.withTenant({ tenantId, userId: usuarioId }, async (tx) => {
      const actor = await actorDe(tx, usuarioId);
      if (actor === null) return null;
      const clientes = await listarClientes(tx, actor.alcance);
      return { clientes: new Set(clientes.map((x) => x.id)) };
    });
  }

  /** CA-6: sesión vigente con el mismo estudio y membresía activa; si no, se cierra (también si la BD falla). */
  private async revalidar(c: Conexion): Promise<void> {
    if (c.cerrada || c.revalidando) return;
    c.revalidando = true;
    try {
      const s = await this.auth.resolverSesion(c.cookie, { renovar: false }); // D22: no cuenta como actividad
      const vigente =
        s !== null &&
        s.sesionId === c.sesionId &&
        s.usuarioId === c.usuarioId &&
        s.tenantActivo === c.tenantId &&
        !s.estudioRevocado;
      const v = vigente
        ? await this.visibilidad(c.tenantId, c.usuarioId)
        : null;
      if (v === null) this.cerrar(c);
      else {
        c.visibilidad = v;
        c.consultados.clear();
      }
    } catch {
      this.cerrar(c);
    } finally {
      c.revalidando = false;
    }
  }
}

/** Función aparte: el estado de `res` cambia entre awaits y TypeScript no debe darlo por fijo. */
const clienteSeFue = (res: RespuestaSse): boolean =>
  res.writableEnded || res.socket?.destroyed === true;

const ve = (v: Visibilidad, clienteId: string): boolean =>
  v.clientes.has(clienteId);
