import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  AccesoRepoError,
  bloquearMiembros,
  cambiarRol,
  desactivar,
  leerRol,
  listarMiembros,
  listarRoles,
  reactivar,
  revocarPendientesDe,
  type ContappDb,
  type MiembroEstado,
  type RolMiembro,
  type RolQueConserva,
  type Tx,
  type TxConsulta,
} from "@contapp/db";
import {
  ROLES,
  cambiarRolSchema,
  permisosEfectivos,
  puedeGestionar,
  puedeSerResponsable,
  tienePermiso,
  type Efectivo,
  type Rol,
  type RolAsignado,
} from "@contapp/shared";
import { DB } from "../auth/inyeccion.js";
import {
  destinatariosPendientes,
  NOTIFICADOR,
  type Notificador,
} from "../notificaciones/notificador.js";
import { CUPO_USUARIOS, type CupoUsuarios } from "./cupo/cupo-usuarios.js";
import { efectivoDe, releerEfectivos, tiene, type MiembroEfectivo } from "./efectivo.js";
import { idDeRuta, parsearCuerpo, traducirUltimoDueno } from "./entrada.js";
import { AccesoError } from "./errores.js";
import type { RolPropioRef } from "./yo.controller.js";

/** Quien llama: usuario de la sesión y su estudio activo (D13: el estudio sale solo de la sesión). */
export interface Llamante {
  usuarioId: string;
  tenantId: string;
}

export interface MiembroRespuesta {
  usuarioId: string;
  nombre: string;
  correo: string;
  /** Rol de sistema o `'propio'` (030). */
  rol: RolMiembro;
  activo: boolean;
  esYo: boolean;
  /** Rol propio (030): `{id, nombre}`; null con un rol de sistema. */
  rolPropio: RolPropioRef | null;
}

export type EstadoMiembro = Pick<MiembroEstado, "usuarioId" | "rol" | "activo">;

/**
 * Bloquea (FOR UPDATE) al actor y al objetivo en una sentencia por `usuario_id` (orden global de 005, plan
 * Decisiones: "Orden de bloqueo"), así dos mutaciones cruzadas (A sobre B y B sobre A) ni una mutación y un lote
 * de asignaciones se interbloquean: la segunda espera y relee los roles ya cambiados (plan: D3 y carreras).
 * 030 (D3, D4): con las filas ya bloqueadas relee los roles propios (una consulta), así ve la última edición de su rol.
 */
async function bloquearPar(
  tx: Tx,
  actorId: string,
  objetivoId: string,
): Promise<{ actor: MiembroEfectivo | null; objetivo: MiembroEfectivo | null }> {
  const filas = await releerEfectivos(tx, await bloquearMiembros(tx, [actorId, objetivoId]));
  return {
    actor: filas.get(actorId.toLowerCase()) ?? null,
    objetivo: filas.get(objetivoId.toLowerCase()) ?? null,
  };
}

/**
 * El actor, releído en la transacción de la acción, sigue activo y con `usuarios.gestionar` (D3: un actor
 * degradado a mitad de la petición no completa la acción). 030: con sus permisos efectivos (rol de sistema o propio).
 */
export function exigirGestor(actor: MiembroEfectivo | null): Efectivo {
  if (actor === null || !actor.estado.activo)
    throw new AccesoError("estudio_requerido");
  if (actor.efectivo === null || !tiene(actor.efectivo, "usuarios.gestionar"))
    throw new AccesoError("permiso_denegado");
  return actor.efectivo;
}

/**
 * Roles que `rol` puede otorgar al invitar (D8): ninguno sin `usuarios.gestionar`; si no, los que
 * `puedeGestionar(rol, null, r)` admite. Sus invitaciones pendientes de otro rol se revocan (H-005-1b-1).
 */
export function rolesQueOtorga(rol: Rol): Rol[] {
  if (!tienePermiso(rol, "usuarios.gestionar")) return [];
  return ROLES.filter((r) => puedeGestionar(rol, null, r));
}

/**
 * 030: lo que un `Efectivo` puede otorgar (roles de sistema por clave y propios por id, `puedeGestionar` por contención): ninguno sin
 * `usuarios.gestionar`. Lee los roles propios del estudio solo si hace falta.
 */
export async function rolesQueConserva(
  tx: TxConsulta,
  e: Efectivo | null,
): Promise<RolQueConserva[]> {
  if (e === null || !tiene(e, "usuarios.gestionar")) return [];
  const sistema = ROLES.filter((r) => puedeGestionar(e, null, permisosEfectivos(r)));
  const propios = (await listarRoles(tx))
    .filter((r) => {
      const ef = efectivoDe({ rol: "propio", propio: r });
      return ef !== null && puedeGestionar(e, null, ef);
    })
    .map((r) => ({ rolId: r.id }));
  return [...sistema, ...propios];
}

/** Rol a asignar ya resuelto: clave de la membresía, rol propio y su `Efectivo`. */
export interface RolResuelto {
  rol: RolMiembro;
  rolId: string | null;
  efectivo: Efectivo;
}

/**
 * Resuelve el rol pedido (`RolAsignado`, 030): uno de sistema por su matriz; uno propio por su definición actual (RLS: un rol de otro
 * estudio no se ve). Inexistente o ajeno: 404 `no_encontrado`, sin escribir nada.
 */
export async function resolverRol(tx: TxConsulta, rol: RolAsignado): Promise<RolResuelto> {
  if (typeof rol === "string") return { rol, rolId: null, efectivo: permisosEfectivos(rol) };
  const r = await leerRol(tx, rol.rolId.toLowerCase());
  const efectivo = r === null ? null : efectivoDe({ rol: "propio", propio: r });
  if (r === null || efectivo === null) throw new AccesoError("no_encontrado");
  return { rol: "propio", rolId: r.id, efectivo };
}

/**
 * D8 + U2/U4 (030): el actor gestiona si el rol actual del objetivo y el nuevo están contenidos en sus permisos y alcance efectivos. Un
 * objetivo cuyo rol no se resuelve falla cerrado. Si interviene un rol propio, 403 `escalada`; entre roles de sistema, el
 * `permiso_denegado` de 005.
 */
export function exigirContencion(
  actor: Efectivo,
  actual: { rol: RolMiembro; efectivo: Efectivo | null } | null,
  nuevo: { rol: RolMiembro; efectivo: Efectivo | null } | null,
): void {
  const ok =
    (actual === null || actual.efectivo !== null) &&
    (nuevo === null || nuevo.efectivo !== null) &&
    puedeGestionar(actor, actual?.efectivo ?? null, nuevo?.efectivo ?? null);
  if (ok) return;
  const propio = actor.rolSistema === null || actual?.rol === "propio" || nuevo?.rol === "propio";
  throw new AccesoError(propio ? "escalada" : "permiso_denegado");
}

/**
 * Errores de la BD al asignar un rol propio (030): el disparador de 0082 rechaza la escalada (42501 -> 403 `escalada`) y la FK compuesta
 * un rol borrado entretanto (23503 -> 404 `no_encontrado`). El resto, como en 005 (último Dueño -> 409).
 */
export function traducirAsignacion(e: unknown): unknown {
  if (e instanceof AccesoRepoError && e.codigo === "42501") return new AccesoError("escalada");
  if (e instanceof AccesoRepoError && e.codigo === "23503") return new AccesoError("no_encontrado");
  return traducirUltimoDueno(e);
}

const estado = (m: MiembroEstado): EstadoMiembro => ({
  usuarioId: m.usuarioId,
  rol: m.rol,
  activo: m.activo,
});

/**
 * Miembros del estudio (RF-027, D8, D9, D18, D19). Sin SQL: repos de `@contapp/db` en `withTenant`. Toda
 * mutación vuelve a leer al actor y bloquea al objetivo; el último Dueño lo protege el trigger (409).
 */
@Injectable()
export class UsuariosService {
  constructor(
    @Inject(DB) private readonly db: Pick<ContappDb, "withTenant">,
    @Inject(CUPO_USUARIOS) private readonly cupo: CupoUsuarios,
    @Optional() @Inject(NOTIFICADOR) private readonly notificador?: Notificador,
  ) {}

  async listar(l: Llamante): Promise<MiembroRespuesta[]> {
    const filas = await this.db.withTenant(
      { tenantId: l.tenantId, userId: l.usuarioId },
      (tx) => listarMiembros(tx),
    );
    return filas.map((m) => ({
      usuarioId: m.usuarioId,
      nombre: m.nombre,
      correo: m.correo,
      rol: m.rol,
      activo: m.activo,
      esYo: m.usuarioId === l.usuarioId,
      rolPropio:
        m.rol === "propio" && m.rolId !== null && m.rolNombre !== null
          ? { id: m.rolId, nombre: m.rolNombre }
          : null,
    }));
  }

  /**
   * D8: nadie cambia su propio rol (el ID de la ruta llega normalizado: H-005-1a-1); solo se otorga lo que se
   * tiene; D18 al perder `sire.clasificar`. 030: el rol puede ser propio (`{ rolId }`): ajeno o inexistente 404; el actual y el nuevo
   * deben estar contenidos en los permisos y el alcance efectivos del actor (U2, U4).
   */
  async cambiarRol(
    l: Llamante,
    idRuta: string | undefined,
    cuerpo: unknown,
  ): Promise<EstadoMiembro> {
    const objetivoId = idDeRuta(idRuta);
    const { rol } = parsearCuerpo(cambiarRolSchema, cuerpo);
    if (objetivoId === l.usuarioId) throw new AccesoError("permiso_denegado");
    return this.mutar(l, objetivoId, async (tx, actor, objetivo) => {
      const nuevo = await resolverRol(tx, rol);
      exigirContencion(actor, { rol: objetivo.estado.rol, efectivo: objetivo.efectivo }, nuevo);
      const m = (await cambiarRol(
        tx,
        objetivoId,
        nuevo.rol,
        !puedeSerResponsable(nuevo.efectivo),
        nuevo.rolId,
      )) as MiembroEstado;
      // H-005-1b-1: sus invitaciones pendientes que el rol nuevo ya no puede otorgar mueren con él.
      await revocarPendientesDe(tx, objetivoId, await rolesQueConserva(tx, nuevo.efectivo));
      return m;
    });
  }

  /** RF-027, D9, D19: nadie se desactiva a sí mismo; solo un Dueño desactiva a un Dueño. */
  async desactivar(
    l: Llamante,
    idRuta: string | undefined,
  ): Promise<EstadoMiembro> {
    const objetivoId = idDeRuta(idRuta);
    if (objetivoId === l.usuarioId) throw new AccesoError("permiso_denegado");
    return this.mutar(l, objetivoId, async (tx, actor, objetivo) => {
      exigirContencion(actor, { rol: objetivo.estado.rol, efectivo: objetivo.efectivo }, null);
      const m = (await desactivar(tx, objetivoId)) as MiembroEstado;
      // H-005-1b-1: desactivado no puede otorgar nada; todas sus invitaciones pendientes quedan revocadas.
      await revocarPendientesDe(tx, objetivoId, []);
      return m;
    });
  }

  /** Conserva el rol, no devuelve asignaciones (D19) y consulta `CupoUsuarios` en la misma transacción (D11). */
  async reactivar(
    l: Llamante,
    idRuta: string | undefined,
  ): Promise<EstadoMiembro> {
    // Sin chequeo de "uno mismo": quien llama está activo, así que reactivarse no cambia nada.
    const objetivoId = idDeRuta(idRuta);
    let avisar: string[] = [];
    const estadoNuevo = await this.mutar(l, objetivoId, async (tx, actor, objetivo) => {
      const actual = { rol: objetivo.estado.rol, efectivo: objetivo.efectivo };
      exigirContencion(actor, actual, actual);
      if (objetivo.estado.activo) return objetivo.estado;
      await this.cupo.alReactivar(tx, l.tenantId);
      const reactivado = (await reactivar(tx, objetivoId)) as MiembroEstado;
      avisar = await destinatariosPendientes(this.notificador, tx);
      return reactivado;
    });
    // Spec 017 (D-9): aviso en vivo tras el commit (el 90 % o el 100 % de usuarios que cruzó la reactivación).
    await this.notificador?.avisar(l.tenantId, avisar);
    return estadoNuevo;
  }

  /**
   * Transacción común: bloquea actor y objetivo, exige gestor, 404 si el objetivo no es del estudio. La fila
   * del objetivo queda bloqueada en esta transacción, así que la acción siempre la encuentra (de ahí el `as`).
   */
  private async mutar(
    l: Llamante,
    objetivoId: string,
    accion: (
      tx: Tx,
      actor: Efectivo,
      objetivo: MiembroEfectivo,
    ) => Promise<MiembroEstado>,
  ): Promise<EstadoMiembro> {
    let resultado: MiembroEstado;
    try {
      resultado = await this.db.withTenant(
        { tenantId: l.tenantId, userId: l.usuarioId },
        async (tx) => {
          const { actor, objetivo } = await bloquearPar(
            tx,
            l.usuarioId,
            objetivoId,
          );
          const efectivo = exigirGestor(actor);
          if (objetivo === null) throw new AccesoError("no_encontrado");
          return accion(tx, efectivo, objetivo);
        },
      );
    } catch (e) {
      throw traducirAsignacion(e);
    }
    return estado(resultado);
  }
}
