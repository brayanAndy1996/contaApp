import { Inject, Injectable } from "@nestjs/common";
import {
  bloquearMiembro,
  cambiarRol,
  desactivar,
  listarMiembros,
  reactivar,
  revocarPendientesDe,
  type ContappDb,
  type MiembroEstado,
  type Tx,
} from "@contapp/db";
import {
  ROLES,
  cambiarRolSchema,
  puedeGestionar,
  puedeSerResponsable,
  tienePermiso,
  type Rol,
} from "@contapp/shared";
import { DB } from "../auth/inyeccion.js";
import { CUPO_USUARIOS, type CupoUsuarios } from "./cupo/cupo-usuarios.js";
import { idDeRuta, parsearCuerpo, traducirUltimoDueno } from "./entrada.js";
import { AccesoError } from "./errores.js";

/** Quien llama: usuario de la sesión y su estudio activo (D13: el estudio sale solo de la sesión). */
export interface Llamante {
  usuarioId: string;
  tenantId: string;
}

export interface MiembroRespuesta {
  usuarioId: string;
  nombre: string;
  correo: string;
  rol: Rol;
  activo: boolean;
  esYo: boolean;
}

export type EstadoMiembro = Pick<MiembroEstado, "usuarioId" | "rol" | "activo">;

/**
 * Bloquea (FOR UPDATE) al actor y al objetivo en orden de ID, así dos mutaciones cruzadas (A sobre B y B
 * sobre A) no se interbloquean: la segunda espera y relee los roles ya cambiados (plan: D3 y carreras).
 */
async function bloquearPar(
  tx: Tx,
  actorId: string,
  objetivoId: string,
): Promise<{ actor: MiembroEstado | null; objetivo: MiembroEstado | null }> {
  const [primero, segundo] =
    actorId < objetivoId ? [actorId, objetivoId] : [objetivoId, actorId];
  const a = await bloquearMiembro(tx, primero);
  const b = await bloquearMiembro(tx, segundo);
  return primero === actorId
    ? { actor: a, objetivo: b }
    : { actor: b, objetivo: a };
}

/**
 * El actor, releído en la transacción de la acción, sigue activo y con `usuarios.gestionar` (D3: un actor
 * degradado a mitad de la petición no completa la acción).
 */
export function exigirGestor(actor: MiembroEstado | null): Rol {
  if (actor === null || !actor.activo)
    throw new AccesoError("estudio_requerido");
  const rol = actor.rol as Rol;
  if (!tienePermiso(rol, "usuarios.gestionar"))
    throw new AccesoError("permiso_denegado");
  return rol;
}

/**
 * Roles que `rol` puede otorgar al invitar (D8): ninguno sin `usuarios.gestionar`; si no, los que
 * `puedeGestionar(rol, null, r)` admite. Sus invitaciones pendientes de otro rol se revocan (H-005-1b-1).
 */
export function rolesQueOtorga(rol: Rol): Rol[] {
  if (!tienePermiso(rol, "usuarios.gestionar")) return [];
  return ROLES.filter((r) => puedeGestionar(rol, null, r));
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
    }));
  }

  /**
   * D8: nadie cambia su propio rol (el ID de la ruta llega normalizado: H-005-1a-1); solo se otorga lo que se
   * tiene; D18 al perder `sire.clasificar`.
   */
  async cambiarRol(
    l: Llamante,
    idRuta: string | undefined,
    cuerpo: unknown,
  ): Promise<EstadoMiembro> {
    const objetivoId = idDeRuta(idRuta);
    const { rol } = parsearCuerpo(cambiarRolSchema, cuerpo);
    if (objetivoId === l.usuarioId) throw new AccesoError("permiso_denegado");
    return this.mutar(l, objetivoId, async (tx, actorRol, objetivo) => {
      if (!puedeGestionar(actorRol, objetivo.rol as Rol, rol))
        throw new AccesoError("permiso_denegado");
      const m = (await cambiarRol(
        tx,
        objetivoId,
        rol,
        !puedeSerResponsable(rol),
      )) as MiembroEstado;
      // H-005-1b-1: sus invitaciones pendientes que el rol nuevo ya no puede otorgar mueren con él.
      await revocarPendientesDe(tx, objetivoId, rolesQueOtorga(rol));
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
    return this.mutar(l, objetivoId, async (tx, actorRol, objetivo) => {
      if (!puedeGestionar(actorRol, objetivo.rol as Rol, null))
        throw new AccesoError("permiso_denegado");
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
    return this.mutar(l, objetivoId, async (tx, actorRol, objetivo) => {
      const rolObjetivo = objetivo.rol as Rol;
      if (!puedeGestionar(actorRol, rolObjetivo, rolObjetivo))
        throw new AccesoError("permiso_denegado");
      if (objetivo.activo) return objetivo;
      await this.cupo.alReactivar(tx, l.tenantId);
      return (await reactivar(tx, objetivoId)) as MiembroEstado;
    });
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
      actorRol: Rol,
      objetivo: MiembroEstado,
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
          const actorRol = exigirGestor(actor);
          if (objetivo === null) throw new AccesoError("no_encontrado");
          return accion(tx, actorRol, objetivo);
        },
      );
    } catch (e) {
      throw traducirUltimoDueno(e);
    }
    return estado(resultado);
  }
}
