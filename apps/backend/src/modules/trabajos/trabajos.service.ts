import { Inject, Injectable } from "@nestjs/common";
import {
  clienteVisible,
  leerTrabajo,
  listarTrabajos,
  miembroActual,
  posicion,
  transicionar,
  type Alcance,
  type ContappDb,
  type FiltrosTrabajos,
  type TrabajoFila,
  type Tx,
} from "@contapp/db";
import { publicarEvento, vistaDeFila } from "@contapp/queue";
import {
  alcanceDe,
  listarTrabajosQuery,
  type Rol,
  type TrabajoVista,
} from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { AccesoError } from "../acceso/errores.js";
import { esUuid } from "../clientes/contexto.js";
import { TrabajosError } from "./errores.js";
import { RedisTrabajos } from "./redis.js";

/** Rol y alcance del usuario en el estudio de la sesión, leídos en cada petición (D3 de 005, sin caché). */
export interface Actor {
  usuarioId: string;
  rol: Rol;
  alcance: Alcance;
}

/** Contexto de `withTenant` de una sesión con estudio (los guards ya lo exigieron; falla cerrado si no). */
export function contextoSesion(s: Pick<SesionResuelta, "tenantActivo" | "usuarioId" | "estudioRevocado">): {
  tenantId: string;
  userId: string;
} {
  if (s.tenantActivo === null || s.estudioRevocado) {
    throw new AccesoError("estudio_requerido");
  }
  return { tenantId: s.tenantActivo, userId: s.usuarioId };
}

/** Membresía ACTIVA del usuario en el estudio del contexto, o null (desactivado o sin membresía). */
export async function actorDe(tx: Tx, usuarioId: string): Promise<Actor | null> {
  const m = await miembroActual(tx, usuarioId);
  if (m === null || m.usuarioId !== usuarioId) return null;
  const rol = m.rol as Rol;
  return {
    usuarioId,
    rol,
    alcance:
      alcanceDe(rol) === "global"
        ? { tipo: "global" }
        : { tipo: "asignado", usuarioId },
  };
}

/** D9: cancelan quien encoló, el Dueño y el Administrador. */
const puedeCancelar = (a: Actor, f: Pick<TrabajoFila, "creadoPor">): boolean =>
  a.rol === "dueno" || a.rol === "admin" || f.creadoPor === a.usuarioId;

const vistaDe = (f: TrabajoFila): TrabajoVista =>
  vistaDeFila(f, { estado: f.estado, motivo: f.motivo });

/** Filtros de `GET /trabajos`: `estado` inválido → 400; `clienteId` mal formado → el mismo 404 que uno no visible. */
const ESTADO = listarTrabajosQuery.shape.estado.unwrap();
const CLIENTE_ID = listarTrabajosQuery.shape.clienteId.unwrap();

/**
 * ¿Trae la query la clave en forma de arreglo u objeto (`clave[]=…`, `clave[x]=…`)? El analizador de Express la deja
 * con el nombre literal, así que sin esto el filtro se ignoraría en silencio (H-008-1a-1): cuenta como mal formada.
 */
const anidada = (query: Record<string, unknown>, clave: string): boolean =>
  Object.keys(query).some((k) => k.startsWith(`${clave}[`));

function leerFiltros(query: Record<string, unknown>): FiltrosTrabajos {
  const filtros: FiltrosTrabajos = {};
  if (anidada(query, "estado")) throw new AccesoError("solicitud_invalida");
  if (anidada(query, "clienteId")) throw new AccesoError("no_encontrado");
  if (query.estado !== undefined) {
    const e = ESTADO.safeParse(query.estado);
    if (!e.success) throw new AccesoError("solicitud_invalida");
    filtros.estado = e.data;
  }
  if (query.clienteId !== undefined) {
    const c = CLIENTE_ID.safeParse(query.clienteId);
    if (!c.success) throw new AccesoError("no_encontrado");
    filtros.clienteId = c.data;
  }
  return filtros;
}

/** Lista y cancelación de trabajos (CA-5, CA-7). El estudio sale solo de la sesión; todo dentro de `withTenant`. */
@Injectable()
export class TrabajosService {
  constructor(
    @Inject(DB) private readonly db: Pick<ContappDb, "withTenant">,
    @Inject(RedisTrabajos) private readonly redis: RedisTrabajos,
  ) {}

  /** Últimos 100 visibles, `creado_en DESC`, con la posición en la cola del estudio para los `en_cola`. */
  listar(
    sesion: SesionResuelta,
    query: Record<string, unknown>,
  ): Promise<TrabajoVista[]> {
    const filtros = leerFiltros(query);
    return this.db.withTenant(contextoSesion(sesion), async (tx) => {
      const actor = await actorDe(tx, sesion.usuarioId);
      if (actor === null) throw new AccesoError("estudio_requerido");
      if (
        filtros.clienteId !== undefined &&
        !(await clienteVisible(tx, filtros.clienteId, actor.alcance))
      ) {
        throw new AccesoError("no_encontrado");
      }
      const lista = await listarTrabajos(tx, actor.alcance, filtros);
      for (const t of lista) {
        if (t.estado === "en_cola") t.posicion = await posicion(tx, t.id);
      }
      return lista;
    });
  }

  /**
   * `en_cola → cancelado` con `cancelado_usuario` (D2: gana quien cambia la fila). Orden: no visible → 404; visible
   * sin permiso (D9) → 403; no `en_cola` o carrera perdida → 409. El evento sale después del commit.
   */
  async cancelar(
    sesion: SesionResuelta,
    trabajoId: string,
  ): Promise<TrabajoVista> {
    if (!esUuid(trabajoId)) throw new AccesoError("no_encontrado");
    const ctx = contextoSesion(sesion);
    const vista = await this.db.withTenant(ctx, async (tx) => {
      const actor = await actorDe(tx, sesion.usuarioId);
      if (actor === null) throw new AccesoError("estudio_requerido");
      const fila = await leerTrabajo(tx, trabajoId);
      if (
        fila === null ||
        !(await clienteVisible(tx, fila.clienteId, actor.alcance))
      ) {
        throw new AccesoError("no_encontrado");
      }
      if (!puedeCancelar(actor, fila)) {
        throw new AccesoError("permiso_denegado");
      }
      const gano =
        fila.estado === "en_cola" &&
        (await transicionar(tx, trabajoId, "en_cola", "cancelado", {
          motivo: "cancelado_usuario",
        }));
      if (!gano) throw new TrabajosError("trabajo_iniciado");
      const cancelada = await leerTrabajo(tx, trabajoId);
      return vistaDe(cancelada as TrabajoFila);
    });
    const redis = this.redis.publicador();
    if (redis !== null) {
      await publicarEvento(redis, ctx.tenantId, vista, {
        prefijo: this.redis.prefijo,
      });
    }
    return vista;
  }
}
