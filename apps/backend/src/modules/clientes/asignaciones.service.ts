import { Inject, Injectable } from "@nestjs/common";
import {
  AccesoReglaError,
  asignar,
  asignarPorCliente,
  asignarPorUsuario,
  bloquearMiembros,
  ClienteArchivadoError,
  listarAsignaciones,
  listarClientes,
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
  type Efectivo,
} from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { efectivoDe, releerEfectivos, tiene, type MiembroEfectivo } from "../acceso/efectivo.js";
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

/** Rechazos de regla de los repositorios (y cliente archivado, 007a D5) -> códigos del plan (409 / 400); nunca con datos de entrada. */
async function traducir<T>(accion: () => Promise<T>): Promise<T> {
  try {
    return await accion();
  } catch (e) {
    if (e instanceof AccesoReglaError) throw new AccesoError(e.motivo);
    if (e instanceof ClienteArchivadoError) throw new AccesoError("cliente_archivado");
    throw e;
  }
}

function noNulo<T>(valor: T | null): T {
  if (valor === null) throw new AccesoError("no_encontrado");
  return valor;
}

/**
 * H-005-1b-4 (D3, plan Riesgos): el actor, releído y bloqueado en la transacción de la acción, sigue activo y con
 * `clientes.asignar`. Un actor degradado o desactivado a mitad de la petición no completa la asignación. Desde 030 un rol
 * propio de alcance asignado puede tenerlo: el alcance de las rutas masivas lo exige `exigirClientesVisibles`.
 */
export function exigirAsignador(actor: MiembroEstado | null, efectivo: Efectivo | null = efectivoDe(actor)): void {
  if (actor === null || !actor.activo) throw new AccesoError("estudio_requerido");
  // 030 (D3): con los permisos efectivos (rol de sistema o propio, releído con su fila bloqueada).
  if (!tiene(efectivo, "clientes.asignar")) throw new AccesoError("permiso_denegado");
}

/**
 * 030 (T13, hallazgo de la ronda 1a): con roles propios, `clientes.asignar` ya no implica alcance global. Las rutas masivas no
 * tienen `:clienteId`, así que `ClienteScopeGuard` no las cubre: aquí se exige que TODOS los clientes del cuerpo sean visibles con el
 * alcance EFECTIVO del actor releído y bloqueado (falla cerrado: lo que no es `global` cuenta como asignado). Fuera de alcance,
 * inexistente o ajeno dan el mismo 404 `no_encontrado` que el `PUT` individual. Una sola consulta (los clientes del actor) y sin
 * bloqueos de cliente, así se respeta el orden de bloqueo.
 */
async function exigirClientesVisibles(
  tx: Tx,
  actorId: string,
  efectivo: Efectivo | null,
  clienteIds: readonly string[],
): Promise<void> {
  if (efectivo === null) throw new AccesoError("permiso_denegado");
  if (efectivo.alcance === "global") return;
  const visibles = new Set(
    (await listarClientes(tx, { tipo: "asignado", usuarioId: actorId })).map((c) => c.id.toLowerCase()),
  );
  if (!clienteIds.every((id) => visibles.has(id.toLowerCase()))) throw new AccesoError("no_encontrado");
}

/**
 * Orden global de bloqueo (plan, Decisiones: "Orden de bloqueo"; H-005-2a-1, H-005-2b-1): el actor y TODOS los
 * miembros que la acción toca se bloquean juntos (FOR UPDATE, una sentencia, por `usuario_id`) antes que
 * cualquier cliente; así ninguna acción de 005 espera una membresía teniendo ya un cliente. Exige al actor y
 * devuelve los bloqueados (por ID en minúsculas; falta quien no es del estudio).
 */
async function bloquearActorYMiembros(
  tx: Tx,
  actorId: string,
  usuarioIds: readonly string[],
  clienteIds: readonly string[] | null = null,
): Promise<Map<string, MiembroEfectivo>> {
  const filas = await releerEfectivos(tx, await bloquearMiembros(tx, [actorId, ...usuarioIds]));
  const actor = filas.get(actorId.toLowerCase()) ?? null;
  exigirAsignador(actor?.estado ?? null, actor?.efectivo ?? null);
  if (clienteIds !== null) await exigirClientesVisibles(tx, actorId, actor?.efectivo ?? null, clienteIds);
  return filas;
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
        await bloquearActorYMiembros(tx, sesion.usuarioId, [usuarioId]);
        return retirar(tx, { clienteId, usuarioId });
      }),
    );
  }

  async porUsuario(sesion: SesionResuelta, cuerpo: unknown): Promise<{ asignados: number }> {
    const datos = parsear(asignarPorUsuarioSchema, cuerpo);
    return traducir(() =>
      this.db.withTenant(contextoDe(sesion), async (tx) => {
        await this.comprobarMiembro(tx, sesion.usuarioId, datos.usuarioId, datos.tipo, datos.clienteIds);
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
          await bloquearActorYMiembros(tx, sesion.usuarioId, datos.usuarioIds, [datos.clienteId]);
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
    clienteIds: readonly string[] | null = null,
  ): Promise<void> {
    const id = usuarioId.toLowerCase();
    const m = noNulo((await bloquearActorYMiembros(tx, actorId, [id], clienteIds)).get(id) ?? null);
    if (!m.estado.activo) throw new AccesoError("miembro_no_asignable");
    // D18 (030: también un rol propio): responsable solo con `sire.clasificar` efectivo.
    if (tipo === "responsable" && (m.efectivo === null || !puedeSerResponsable(m.efectivo)))
      throw new AccesoError("miembro_no_asignable");
  }
}
