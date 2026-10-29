import {
  Inject,
  Injectable,
  Optional,
  type OnModuleDestroy,
} from "@nestjs/common";
import { listarClientes, type ContappDb } from "@contapp/db";
import { eventoTrabajoSchema, type EventoTrabajo } from "@contapp/shared";
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
}

export const TIEMPOS_STREAM = Symbol("TRABAJOS_TIEMPOS_STREAM");

export const TIEMPOS_POR_DEFECTO: TiemposStream = {
  latidoMs: 15_000,
  revalidacionMs: 5_000,
  duracionMs: 5 * 60_000,
  maxPorSesion: 3,
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

/** Quién ve qué: todo el estudio, o solo los clientes asignados (D5 de 005). */
type Visibilidad = { global: true } | { global: false; clientes: Set<string> };

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
}

const evento = (e: EventoTrabajo): string =>
  `event: trabajo\ndata: ${JSON.stringify(e)}\n\n`;

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
  private escuchando = false;
  private cerrado = false;

  constructor(
    @Inject(DB) private readonly db: Pick<ContappDb, "withTenant">,
    @Inject(AuthService) private readonly auth: Pick<AuthService, "resolverSesion">,
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
   * Abre el stream: 429 `streams_excedidos` al 4.º de la sesión; carga el alcance; envía las cabeceras de inmediato
   * (sin evento inicial) y se suscribe al canal del estudio.
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
    };
    res.on("close", () => this.cerrar(c));
    // El cliente pudo irse mientras se cargaba el alcance.
    if (res.writableEnded || res.socket?.destroyed === true) {
      this.cerrar(c);
      return;
    }
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    this.registrar(c);
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

  private registrar(c: Conexion): void {
    let set = this.porCanal.get(c.canal);
    if (set === undefined) {
      set = new Set();
      this.porCanal.set(c.canal, set);
      const sub = this.suscriptor();
      sub?.subscribe(c.canal).catch(() => undefined);
    }
    set.add(c);
  }

  private cerrar(c: Conexion): void {
    if (c.cerrada) return;
    c.cerrada = true;
    for (const t of c.temporizadores) clearTimeout(t);
    this.liberar(c.sesionId);
    const set = this.porCanal.get(c.canal);
    if (set?.delete(c) === true && set.size === 0) {
      this.porCanal.delete(c.canal);
      this.redis.suscriptor()?.unsubscribe(c.canal).catch(() => undefined);
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
    const r = eventoTrabajoSchema.safeParse(crudo);
    if (!r.success) return;
    const marco = evento(r.data);
    for (const c of conexiones) {
      if (!c.cerrada && ve(c.visibilidad, r.data.clienteId)) c.res.write(marco);
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
      if (actor.alcance.tipo === "global") return { global: true };
      const clientes = await listarClientes(tx, actor.alcance);
      return { global: false, clientes: new Set(clientes.map((x) => x.id)) };
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
      const v = vigente ? await this.visibilidad(c.tenantId, c.usuarioId) : null;
      if (v === null) this.cerrar(c);
      else c.visibilidad = v;
    } catch {
      this.cerrar(c);
    } finally {
      c.revalidando = false;
    }
  }
}

const ve = (v: Visibilidad, clienteId: string): boolean =>
  v.global || v.clientes.has(clienteId);
