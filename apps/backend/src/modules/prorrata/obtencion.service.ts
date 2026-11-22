import { Inject, Injectable } from "@nestjs/common";
import type { Alcance } from "@contapp/db";
import { obtenerDeclaracionesSchema } from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { conReintentoUnico, exigirCredencialSol } from "../buzon/apoyo.js";
import { contextoDe } from "../clientes/contexto.js";
import { Encolador } from "../trabajos/encolador.js";
import { exigirCliente, periodoCalculable } from "./apoyo.js";

const DESCARGAR = "sol.declaraciones.descargar";

/**
 * «Obtener declaraciones» (spec 026, D-3, D-5, D-7; CA-1, CA-7). Solo encola `sol.declaraciones.descargar` (008) con `{periodo}`: el
 * backend NUNCA llama a SOL ni toca la clave; el worker lee los 12 periodos y escribe por la función acotada. Orden: cuerpo (400
 * `solicitud_invalida`) → periodo futuro en hora de Lima (400 `periodo_futuro`) → cliente del alcance (404; archivado 409) → clave SOL
 * (409 `credencial_no_configurada` / `credencial_invalida`), todo en UNA transacción con el encolado, así que nada queda a medias. El
 * dedupe de 008 por cliente y periodo hace que pedidos repetidos compartan el trabajo vivo. No audita al pedir: las cuatro acciones de 026
 * las escriben el trabajo y los guardados.
 */
@Injectable()
export class ObtencionProrrataService {
  constructor(@Inject(Encolador) private readonly encolador: Encolador) {}

  /** `trabajoId` del trabajo: el nuevo o el vivo del mismo cliente y periodo (dedupe de 008). */
  async obtener(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteCrudo: string,
    cuerpo: unknown,
  ): Promise<{ trabajoId: string }> {
    const v = obtenerDeclaracionesSchema.safeParse(cuerpo ?? {});
    if (!v.success) throw new AccesoError("solicitud_invalida");
    const periodo = periodoCalculable(v.data.periodo, Date.now(), false);
    // La guarda de alcance acepta el UUID en cualquier grafía; la clave de dedupe va con el id en minúsculas.
    const clienteId = clienteCrudo.toLowerCase();
    const ctx = contextoDe(sesion);
    const r = await conReintentoUnico(() =>
      this.encolador.encolarCon(
        ctx,
        { tipo: DESCARGAR, clienteId, parametros: { periodo }, prioridad: "interactivo", creadoPor: ctx.userId },
        async (tx) => {
          await exigirCliente(tx, clienteId, alcance, true);
          await exigirCredencialSol(tx, clienteId);
        },
      ),
    );
    return { trabajoId: r.trabajo.id };
  }
}
