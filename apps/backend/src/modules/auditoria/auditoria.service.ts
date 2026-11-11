import { Inject, Injectable } from "@nestjs/common";
import {
  leerClientesPorIds,
  listarAuditoria,
  MAX_PAGINA_AUDITORIA,
  resolverAutores,
  resolverUsuariosDeEntidades,
  type ContappDb,
  type FilaAuditoria as FilaBd,
} from "@contapp/db";
import { filaAuditoriaSchema, type Autor, type FilaAuditoria, type PaginaAuditoria } from "@contapp/shared";
import { DB } from "../auth/inyeccion.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { contextoDe } from "../clientes/contexto.js";
import { codificarCursor, leerConsulta } from "../notificaciones/cursor.js";

const ES_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Consulta de la auditoría del estudio (spec 017, P-2, D-6, D-12; CA-12 a CA-14). Solo lectura: la escritura la hacen los
 * triggers de la BD con el actor del contexto, nunca un dato de la petición. El permiso `auditoria.ver` lo exige
 * `PermisoGuard`. Autores y clientes se resuelven por lote (una consulta cada uno por página).
 */
@Injectable()
export class AuditoriaService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  async listar(sesion: SesionResuelta, query: unknown): Promise<PaginaAuditoria> {
    const antes = leerConsulta(query);
    return this.db.withTenant(contextoDe(sesion), async (tx) => {
      const filas = await listarAuditoria(tx, {
        ...(antes === undefined ? {} : { antes }),
        limite: MAX_PAGINA_AUDITORIA,
      });
      const ultima = filas[filas.length - 1];
      let siguiente: string | null = null;
      if (ultima !== undefined && filas.length === MAX_PAGINA_AUDITORIA) {
        const mas = await listarAuditoria(tx, { antes: { en: ultima.ocurridaEn, id: ultima.id }, limite: 1 });
        if (mas.length > 0) siguiente = codificarCursor({ en: ultima.ocurridaEn, id: ultima.id });
      }
      // P-4: el usuario afectado (miembro, asignación, invitación) se resuelve junto con los autores: UN lote por página.
      const objetivos = await this.usuariosObjetivo(tx, filas);
      const autores = await resolverAutores(tx, [
        ...filas.flatMap((f) => (f.usuarioId === null ? [] : [f.usuarioId])),
        ...objetivos.values(),
      ]);
      const clientes = await leerClientesPorIds(
        tx,
        filas.flatMap((f) => (f.clienteId === null ? [] : [f.clienteId])),
      );
      const items: FilaAuditoria[] = [];
      for (const f of filas) items.push(...this.aDto(f, autores, clientes, objetivos));
      return { items, siguiente };
    });
  }

  /**
   * Id del usuario afectado por cada fila cuyo sujeto es otro usuario (P-4), por id de fila: `miembro.*` (la membresía de
   * `entidad_id`), `asignacion.*` (`datos.usuarioId`) e `invitacion.*` (quien la aceptó). Lo que no se conoce no entra: una
   * membresía ya eliminada o una invitación sin aceptar dan `objetivo: null`. Del correo de la invitación nada se consulta (D-5).
   */
  private async usuariosObjetivo(tx: Parameters<typeof resolverAutores>[0], filas: readonly FilaBd[]): Promise<Map<string, string>> {
    const porFila = new Map<string, string>();
    const membresias: string[] = [];
    const invitaciones: string[] = [];
    for (const f of filas) {
      if (f.accion.startsWith("miembro.") && f.entidadId !== null) membresias.push(f.entidadId);
      else if (f.accion.startsWith("invitacion.") && f.entidadId !== null) invitaciones.push(f.entidadId);
      else if (f.accion.startsWith("asignacion.")) {
        const id = f.datos["usuarioId"];
        if (typeof id === "string" && ES_UUID.test(id)) porFila.set(f.id, id);
      }
    }
    if (membresias.length === 0 && invitaciones.length === 0) return porFila;
    const usuarios = await resolverUsuariosDeEntidades(tx, { membresias, invitaciones });
    for (const f of filas) {
      if (f.entidadId === null) continue;
      const id = f.accion.startsWith("miembro.")
        ? usuarios.membresias.get(f.entidadId)
        : f.accion.startsWith("invitacion.")
          ? usuarios.invitaciones.get(f.entidadId)
          : undefined;
      if (id !== undefined) porFila.set(f.id, id);
    }
    return porFila;
  }

  /** Fila de BD -> DTO de P-2: sin `tenantId` ni `usuarioId` crudo. Lo que no cumple el contrato no sale. */
  private aDto(
    f: FilaBd,
    autores: Map<string, Autor>,
    clientes: Map<string, { id: string; ruc: string; razonSocial: string }>,
    objetivos: Map<string, string>,
  ): FilaAuditoria[] {
    const idObjetivo = objetivos.get(f.id);
    const cliente = f.clienteId === null ? null : (clientes.get(f.clienteId) ?? null);
    const r = filaAuditoriaSchema.safeParse({
      id: f.id,
      ocurridaEn: f.ocurridaEn.toISOString(),
      accion: f.accion,
      actor: {
        tipo: f.actorTipo,
        autor: f.usuarioId === null ? null : (autores.get(f.usuarioId) ?? null),
        trabajoId: f.trabajoId,
      },
      cliente: cliente === null ? null : { id: cliente.id, ruc: cliente.ruc, razonSocial: cliente.razonSocial },
      entidad: f.entidad,
      entidadId: f.entidadId,
      datos: f.datos,
      objetivo: idObjetivo === undefined ? null : (autores.get(idObjetivo) ?? null),
    });
    return r.success ? [r.data] : [];
  }
}
