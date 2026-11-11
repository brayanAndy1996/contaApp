import { Inject, Injectable } from "@nestjs/common";
import {
  leerClientesPorIds,
  listarAuditoria,
  MAX_PAGINA_AUDITORIA,
  resolverAutores,
  type ContappDb,
  type FilaAuditoria as FilaBd,
} from "@contapp/db";
import { filaAuditoriaSchema, type Autor, type FilaAuditoria, type PaginaAuditoria } from "@contapp/shared";
import { DB } from "../auth/inyeccion.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { contextoDe } from "../clientes/contexto.js";
import { codificarCursor, leerConsulta } from "../notificaciones/cursor.js";

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
      const autores = await resolverAutores(
        tx,
        filas.flatMap((f) => (f.usuarioId === null ? [] : [f.usuarioId])),
      );
      const clientes = await leerClientesPorIds(
        tx,
        filas.flatMap((f) => (f.clienteId === null ? [] : [f.clienteId])),
      );
      const items: FilaAuditoria[] = [];
      for (const f of filas) items.push(...this.aDto(f, autores, clientes));
      return { items, siguiente };
    });
  }

  /** Fila de BD -> DTO de P-2: sin `tenantId` ni `usuarioId` crudo. Lo que no cumple el contrato no sale. */
  private aDto(
    f: FilaBd,
    autores: Map<string, Autor>,
    clientes: Map<string, { id: string; ruc: string; razonSocial: string }>,
  ): FilaAuditoria[] {
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
    });
    return r.success ? [r.data] : [];
  }
}
