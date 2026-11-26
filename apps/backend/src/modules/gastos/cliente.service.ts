import { Inject, Injectable } from "@nestjs/common";
import { fijarCategoriasCliente, leerCategoriasCliente, type Alcance, type ContappDb } from "@contapp/db";
import { categoriasClienteSchema, type CategoriasClienteVista } from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { conReintentoUnico } from "../buzon/apoyo.js";
import { exigirCliente } from "../compras/apoyo.js";
import { contextoDe } from "../clientes/contexto.js";
import { aErrorHttp, esSqlstate } from "./errores.js";
import { aCategoriasClienteVista } from "./vistas.js";

/**
 * Categorías permitidas y quitadas por cliente (spec 027, R-13, D-3, D-6; CA-5, CA-14). Leer exige `reglas.ver`; guardar, `reglas.gestionar`
 * sobre un cliente visible (el Contador asignado también). El CIIU sale de la caché del estudio: el backend nunca lo consulta. Guardar lleva
 * el compare-and-set por versión (0 = sin ajuste) y la auditoría en la función acotada de 0070; un cliente archivado no se escribe (409).
 */
@Injectable()
export class ClienteGastosService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  async leer(sesion: SesionResuelta, alcance: Alcance, clienteCrudo: string): Promise<CategoriasClienteVista> {
    const clienteId = clienteCrudo.toLowerCase();
    return this.db.withTenant(contextoDe(sesion), async (tx) => {
      await exigirCliente(tx, clienteId, alcance, false);
      const leidas = await leerCategoriasCliente(tx, clienteId);
      if (leidas === null) throw new AccesoError("no_encontrado");
      return aCategoriasClienteVista(leidas);
    });
  }

  async guardar(sesion: SesionResuelta, alcance: Alcance, clienteCrudo: string, cuerpo: unknown): Promise<{ version: number }> {
    const v = categoriasClienteSchema.safeParse(cuerpo);
    if (!v.success) throw new AccesoError("solicitud_invalida");
    const clienteId = clienteCrudo.toLowerCase();
    const ctx = contextoDe(sesion);
    try {
      const version = await conReintentoUnico(() =>
        this.db.withTenant(ctx, async (tx) => {
          await exigirCliente(tx, clienteId, alcance, true);
          return fijarCategoriasCliente(tx, {
            clienteId,
            permitidas: v.data.permitidas,
            quitadas: v.data.quitadas,
            version: v.data.version,
          });
        }),
      );
      return { version };
    } catch (e) {
      // Las listas ya eran las vigentes (22023 «sin cambios», con la versión comprobada): no se escribe nada y se responde igual.
      if (esSqlstate(e, "22023")) return { version: v.data.version };
      throw aErrorHttp(e);
    }
  }
}
