import { Inject, Injectable } from "@nestjs/common";
import {
  editarRegla,
  eliminarRegla,
  listarReglas,
  recordarRegla,
  type Alcance,
  type CodigoRegla,
  type ContappDb,
  type ReglaFila,
} from "@contapp/db";
import {
  editarReglaSchema,
  eliminarReglaSchema,
  recordarReglaSchema,
  type ReglaVista,
} from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { contextoDe } from "../clientes/contexto.js";
import { exigirCliente, idDe } from "../compras/apoyo.js";
import { autoresDe } from "../compras/autor.js";
import { ReglasError } from "./errores.js";
import { aReglaVista } from "./vistas.js";

/** Un código de rechazo del repositorio es siempre un error HTTP; nada se escribió, así que lanzarlo deshace la transacción sin costo. */
function exigirRegla(r: ReglaFila | CodigoRegla | "ok"): ReglaFila | "ok" {
  if (r === "no_encontrada") throw new AccesoError("no_encontrado");
  if (r === "regla_cambiada" || r === "proveedores_distintos") throw new ReglasError(r);
  return r;
}

/**
 * Reglas aprendidas de un cliente (spec 021, D-2, D-5, P-2, P-9; CA-1, CA-5, CA-7, CA-9). Toda consulta va dentro de
 * `withTenant`. Cliente (alcance y archivado) y regla ajenos o inexistentes dan el mismo 404. «Recordar» nunca crea versiones de
 * compras (D-5): solo escribe `regla_aprendida` y, en la misma transacción, la confirmación del catálogo (P-1, P-10).
 */
@Injectable()
export class ReglasService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  listar(sesion: SesionResuelta, alcance: Alcance, clienteId: string): Promise<ReglaVista[]> {
    return this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      const filas = await listarReglas(tx, clienteId);
      const autores = await autoresDe(tx, filas.map((f) => f.creadaPor));
      return filas.map((f) => aReglaVista(f, autores));
    });
  }

  recordar(sesion: SesionResuelta, alcance: Alcance, clienteId: string, cuerpo: unknown): Promise<ReglaVista> {
    const v = recordarReglaSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    return this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirCliente(tx, clienteId, alcance, true);
      const r = exigirRegla(
        await recordarRegla(tx, {
          clienteId,
          compraIds: v.data.compraIds,
          destino: v.data.destino,
          versionBase: v.data.versionBase,
          usuarioId: sesion.usuarioId,
        }),
      ) as ReglaFila;
      return aReglaVista(r, await autoresDe(tx, [r.creadaPor]));
    });
  }

  editar(sesion: SesionResuelta, alcance: Alcance, clienteId: string, reglaCruda: string, cuerpo: unknown): Promise<ReglaVista> {
    const v = editarReglaSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    const reglaId = idDe(reglaCruda);
    return this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirCliente(tx, clienteId, alcance, true);
      const r = exigirRegla(
        await editarRegla(tx, {
          clienteId,
          reglaId,
          versionBase: v.data.versionBase,
          ...(v.data.destino === undefined ? {} : { destino: v.data.destino }),
          ...(v.data.activa === undefined ? {} : { activa: v.data.activa }),
          usuarioId: sesion.usuarioId,
        }),
      ) as ReglaFila;
      return aReglaVista(r, await autoresDe(tx, [r.creadaPor]));
    });
  }

  eliminar(sesion: SesionResuelta, alcance: Alcance, clienteId: string, reglaCruda: string, query: unknown): Promise<void> {
    const v = eliminarReglaSchema.safeParse(query);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    const reglaId = idDe(reglaCruda);
    return this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirCliente(tx, clienteId, alcance, true);
      exigirRegla(await eliminarRegla(tx, { clienteId, reglaId, versionBase: v.data.versionBase, usuarioId: sesion.usuarioId }));
    });
  }
}
