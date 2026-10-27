import { Inject, Injectable } from "@nestjs/common";
import {
  AccesoReglaError,
  asignar,
  asignarPorCliente,
  asignarPorUsuario,
  bloquearMiembro,
  listarAsignaciones,
  retirar,
  type AsignacionListada,
  type ContappDb,
  type MiembroEstado,
  type Tx,
} from "@contapp/db";
import {
  asignarClienteSchema,
  asignarPorClienteSchema,
  asignarPorUsuarioSchema,
  puedeSerResponsable,
  tienePermiso,
  type Rol,
} from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { AccesoError } from "../acceso/errores.js";
import { contextoDe, esUuid } from "./contexto.js";

interface Esquema<T> {
  safeParse(valor: unknown): { success: boolean; data?: T };
}

/** zod -> 400 `solicitud_invalida` sin eco de la entrada. */
function parsear<T>(esquema: Esquema<T>, cuerpo: unknown): T {
  const r = esquema.safeParse(cuerpo);
  if (!r.success) throw new AccesoError("solicitud_invalida");
  return r.data as T;
}

/** Rechazos de regla de los repositorios -> códigos del plan (409 / 400); nunca con datos de entrada. */
async function traducir<T>(accion: () => Promise<T>): Promise<T> {
  try {
    return await accion();
  } catch (e) {
    if (e instanceof AccesoReglaError) throw new AccesoError(e.motivo);
    throw e;
  }
}

function noNulo<T>(valor: T | null): T {
  if (valor === null) throw new AccesoError("no_encontrado");
  return valor;
}

/**
 * H-005-1b-4 (D3, plan Riesgos): el actor, releído y bloqueado en la transacción de la acción, sigue activo y con
 * `clientes.asignar` (los roles que lo tienen son de alcance global, así que la visibilidad del guard sigue
 * valiendo). Un actor degradado o desactivado a mitad de la petición no completa la asignación.
 */
export function exigirAsignador(actor: MiembroEstado | null): void {
  if (actor === null || !actor.activo) throw new AccesoError("estudio_requerido");
  if (!tienePermiso(actor.rol as Rol, "clientes.asignar")) throw new AccesoError("permiso_denegado");
}

/**
 * Bloquea (FOR UPDATE) al actor y, si hay, al miembro objetivo en orden de ID, como `bloquearPar` de miembros
 * (sin interbloqueo con las mutaciones de miembros), exige al actor y devuelve el objetivo (null si no lo hay o
 * no es del estudio).
 */
async function bloquearActorYObjetivo(
  tx: Tx,
  actorId: string,
  objetivoId: string | null,
): Promise<MiembroEstado | null> {
  const ids = objetivoId === null || objetivoId === actorId ? [actorId] : [actorId, objetivoId].sort();
  const filas = new Map<string, MiembroEstado | null>();
  for (const id of ids) filas.set(id, await bloquearMiembro(tx, id));
  exigirAsignador(filas.get(actorId) ?? null);
  return objetivoId === null ? null : (filas.get(objetivoId) ?? null);
}

/**
 * Asignación de clientes (RF-024, RF-025, D6, D18). El permiso y el alcance los exigen los guards; aquí se
 * valida el cuerpo, se aplica la regla D18 sobre el rol de `bloquearMiembro` (mismo bloqueo que `cambiarRol`)
 * y se traducen los rechazos de los repositorios. Todo en un solo `withTenant` por acción (todo o nada).
 */
@Injectable()
export class AsignacionesService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  listar(sesion: SesionResuelta, clienteId: string): Promise<AsignacionListada[]> {
    return this.db.withTenant(contextoDe(sesion), (tx) => listarAsignaciones(tx, clienteId));
  }

  async asignar(sesion: SesionResuelta, clienteId: string, usuarioId: string, cuerpo: unknown): Promise<AsignacionListada[]> {
    const datos = parsear(asignarClienteSchema, cuerpo);
    if (!esUuid(usuarioId)) throw new AccesoError("no_encontrado");
    return traducir(() =>
      this.db.withTenant(contextoDe(sesion), async (tx) => {
        await this.comprobarMiembro(tx, sesion.usuarioId, usuarioId, datos.tipo);
        return noNulo(
          await asignar(tx, {
            clienteId,
            usuarioId,
            tipo: datos.tipo,
            ...(datos.anterior === undefined ? {} : { anterior: datos.anterior }),
          }),
        );
      }),
    );
  }

  async retirar(sesion: SesionResuelta, clienteId: string, usuarioId: string): Promise<void> {
    if (!esUuid(usuarioId)) throw new AccesoError("no_encontrado");
    noNulo(
      await this.db.withTenant(contextoDe(sesion), async (tx) => {
        await bloquearActorYObjetivo(tx, sesion.usuarioId, null);
        return retirar(tx, { clienteId, usuarioId });
      }),
    );
  }

  async porUsuario(sesion: SesionResuelta, cuerpo: unknown): Promise<{ asignados: number }> {
    const datos = parsear(asignarPorUsuarioSchema, cuerpo);
    return traducir(() =>
      this.db.withTenant(contextoDe(sesion), async (tx) => {
        await this.comprobarMiembro(tx, sesion.usuarioId, datos.usuarioId, datos.tipo);
        return noNulo(
          await asignarPorUsuario(tx, {
            usuarioId: datos.usuarioId,
            clienteIds: datos.clienteIds,
            tipo: datos.tipo,
            ...(datos.anterior === undefined ? {} : { anterior: datos.anterior }),
          }),
        );
      }),
    );
  }

  async porCliente(sesion: SesionResuelta, cuerpo: unknown): Promise<{ asignados: number }> {
    const datos = parsear(asignarPorClienteSchema, cuerpo);
    return traducir(async () =>
      noNulo(
        await this.db.withTenant(contextoDe(sesion), async (tx) => {
          await bloquearActorYObjetivo(tx, sesion.usuarioId, null);
          return asignarPorCliente(tx, { clienteId: datos.clienteId, usuarioIds: datos.usuarioIds });
        }),
      ),
    );
  }

  /**
   * Actor releído (H-005-1b-4). El usuario debe ser miembro del estudio (si no, 404 genérico) y activo (409).
   * Para responsable exige `sire.clasificar` (D18) sobre el rol bloqueado: lectura puede ser colaborador, no
   * responsable.
   */
  private async comprobarMiembro(
    tx: Tx,
    actorId: string,
    usuarioId: string,
    tipo: "responsable" | "colaborador",
  ): Promise<void> {
    const m = noNulo(await bloquearActorYObjetivo(tx, actorId, usuarioId.toLowerCase()));
    if (!m.activo) throw new AccesoError("miembro_no_asignable");
    if (tipo === "responsable" && !puedeSerResponsable(m.rol as Rol)) throw new AccesoError("miembro_no_asignable");
  }
}
