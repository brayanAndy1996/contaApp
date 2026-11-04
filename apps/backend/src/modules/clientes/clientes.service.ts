import { Inject, Injectable } from "@nestjs/common";
import {
  AccesoReglaError,
  archivarCliente,
  asignar,
  bloquearMiembros,
  ClienteArchivadoError,
  crearCliente,
  editarCliente,
  leerClienteDto,
  listarClientesFiltrado,
  reactivarCliente,
  RucDuplicadoError,
  type Alcance,
  type ContappDb,
  type MiembroEstado,
} from "@contapp/db";
import {
  clienteCrearSchema,
  clienteEditarSchema,
  filtrosClientesSchema,
  puedeSerResponsable,
  tienePermiso,
  type ClienteDto,
  type Permiso,
  type Rol,
} from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { AccesoError } from "../acceso/errores.js";
import { CUPO_RUCS, type CupoRucs } from "../planes/cupo/cupo-rucs.js";
import { Encolador } from "../trabajos/encolador.js";
import { contextoDe } from "./contexto.js";
import { encolarConsultasRuc } from "./consulta-ruc.js";

interface Esquema<T> {
  safeParse(valor: unknown): { success: boolean; data?: T };
}

/** zod -> 400 `solicitud_invalida` sin eco de la entrada. */
function parsear<T>(esquema: Esquema<T>, entrada: unknown): T {
  const r = esquema.safeParse(entrada);
  if (!r.success) throw new AccesoError("solicitud_invalida");
  return r.data as T;
}

function noNulo<T>(valor: T | null): T {
  if (valor === null) throw new AccesoError("no_encontrado");
  return valor;
}

/** Rechazos de los repositorios -> códigos de la API (409); nunca con datos de entrada. */
async function traducir<T>(accion: () => Promise<T>): Promise<T> {
  try {
    return await accion();
  } catch (e) {
    if (e instanceof RucDuplicadoError) throw new AccesoError("ruc_duplicado");
    if (e instanceof ClienteArchivadoError) throw new AccesoError("cliente_archivado");
    if (e instanceof AccesoReglaError) throw new AccesoError(e.motivo);
    throw e;
  }
}

/**
 * El actor, releído y bloqueado en la transacción, sigue activo y con el permiso de la acción (como
 * H-005-1b-4): un actor degradado o desactivado a mitad de la petición no completa el alta ni la reactivación.
 */
function exigirActor(actor: MiembroEstado | null, permiso: Permiso): void {
  if (actor === null || !actor.activo) throw new AccesoError("estudio_requerido");
  if (!tienePermiso(actor.rol as Rol, permiso)) throw new AccesoError("permiso_denegado");
}

/**
 * Clientes (RF-030 parcial, RF-036, RF-037, RF-039; spec 007a). Permiso y alcance los exigen los guards. Crear y
 * reactivar siguen el orden global de bloqueo (D4, plan 005/006): `bloquearMiembros` -> `CupoRucs.reservar` ->
 * `cliente` -> `asignacion`, todo en un solo `withTenant` (todo o nada); el alta encola la consulta de RUC después del commit. Archivar solo libera: no toma el bloqueo
 * de cupo ni toca miembros.
 */
@Injectable()
export class ClientesService {
  constructor(
    @Inject(DB) private readonly db: Pick<ContappDb, "withTenant">,
    @Inject(CUPO_RUCS) private readonly cupo: CupoRucs,
    @Inject(Encolador) private readonly encolador: Pick<Encolador, "encolarLote">,
  ) {}

  listar(sesion: SesionResuelta, alcance: Alcance, query: unknown): Promise<ClienteDto[]> {
    const f = parsear(filtrosClientesSchema, query);
    // Postgres no admite NUL en texto: sería un 500 al enlazar el parámetro. Es una entrada inválida (400).
    if (f.q?.includes("\u0000")) throw new AccesoError("solicitud_invalida");
    return this.db.withTenant(contextoDe(sesion), (tx) =>
      listarClientesFiltrado(tx, alcance, {
        ...(f.responsable === undefined ? {} : { responsable: f.responsable }),
        ...(f.credencial === undefined ? {} : { credencial: f.credencial }),
        ...(f.archivados === undefined ? {} : { archivados: f.archivados }),
        ...(f.q === undefined ? {} : { q: f.q }),
      }),
    );
  }

  async leer(sesion: SesionResuelta, clienteId: string): Promise<ClienteDto> {
    return noNulo(await this.db.withTenant(contextoDe(sesion), (tx) => leerClienteDto(tx, clienteId)));
  }

  async crear(sesion: SesionResuelta, cuerpo: unknown): Promise<ClienteDto> {
    const datos = parsear(clienteCrearSchema, cuerpo);
    const ctx = contextoDe(sesion);
    const dto = await traducir(() =>
      this.db.withTenant(ctx, async (tx) => {
        const bloqueados = await bloquearMiembros(tx, [
          sesion.usuarioId,
          ...(datos.responsableId === undefined ? [] : [datos.responsableId]),
        ]);
        exigirActor(bloqueados.get(sesion.usuarioId.toLowerCase()) ?? null, "clientes.crear");
        if (datos.responsableId !== undefined) {
          const m = noNulo(bloqueados.get(datos.responsableId.toLowerCase()) ?? null);
          if (!m.activo || !puedeSerResponsable(m.rol as Rol)) throw new AccesoError("miembro_no_asignable");
        }
        await this.cupo.reservar(tx, ctx.tenantId, 1);
        const id = await crearCliente(tx, ctx.tenantId, {
          ruc: datos.ruc,
          ...(datos.razonSocial === undefined ? {} : { razonSocial: datos.razonSocial }),
          ...(datos.perfil === undefined ? {} : { perfil: datos.perfil }),
        });
        if (datos.responsableId !== undefined) {
          noNulo(await asignar(tx, { clienteId: id, usuarioId: datos.responsableId, tipo: "responsable" }));
        }
        return noNulo(await leerClienteDto(tx, id));
      }),
    );
    // Tras el commit y sin propagar su fallo (D1): si no se encola, el cliente queda con la razón social provisional.
    await encolarConsultasRuc(this.encolador, ctx, [dto.id]);
    return dto;
  }

  async editar(sesion: SesionResuelta, clienteId: string, cuerpo: unknown): Promise<ClienteDto> {
    const datos = parsear(clienteEditarSchema, cuerpo);
    // Solo espacios no es una razón social (el CHECK de la BD exige 1-200 tras recortar): 400, no 500.
    if (datos.razonSocial !== undefined && datos.razonSocial.trim() === "") throw new AccesoError("solicitud_invalida");
    return traducir(() =>
      this.db.withTenant(contextoDe(sesion), async (tx) => {
        const hecho = await editarCliente(tx, clienteId, {
          ...(datos.razonSocial === undefined ? {} : { razonSocial: datos.razonSocial }),
          ...(datos.perfil === undefined ? {} : { perfil: datos.perfil }),
        });
        if (!hecho) throw new AccesoError("no_encontrado");
        return noNulo(await leerClienteDto(tx, clienteId));
      }),
    );
  }

  /** Idempotente; libera cupo sin pedirlo (D4). */
  async archivar(sesion: SesionResuelta, clienteId: string): Promise<ClienteDto> {
    return noNulo(
      await this.db.withTenant(contextoDe(sesion), async (tx) => {
        await archivarCliente(tx, clienteId);
        return leerClienteDto(tx, clienteId);
      }),
    );
  }

  /**
   * Reactivar pasa por el cupo (D4). Un cliente que ya está activo no consume cupo: responde su estado actual
   * (idempotente) sin bloquear nada.
   */
  async reactivar(sesion: SesionResuelta, clienteId: string): Promise<ClienteDto> {
    const ctx = contextoDe(sesion);
    return traducir(() =>
      this.db.withTenant(ctx, async (tx) => {
        const bloqueados = await bloquearMiembros(tx, [sesion.usuarioId]);
        exigirActor(bloqueados.get(sesion.usuarioId.toLowerCase()) ?? null, "clientes.archivar");
        const actual = noNulo(await leerClienteDto(tx, clienteId));
        if (!actual.archivado) return actual;
        await this.cupo.reservar(tx, ctx.tenantId, 1);
        await reactivarCliente(tx, clienteId);
        return noNulo(await leerClienteDto(tx, clienteId));
      }),
    );
  }
}
