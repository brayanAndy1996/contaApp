import { Inject, Injectable } from "@nestjs/common";
import { leerEstadoPeriodo, type Alcance } from "@contapp/db";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { conReintentoUnico } from "../buzon/apoyo.js";
import { exigirCliente, periodoDe } from "../compras/apoyo.js";
import { contextoDe } from "../clientes/contexto.js";
import { Encolador } from "../trabajos/encolador.js";
import { aErrorHttp, GastosError } from "./errores.js";

const REEVALUAR = "compras.reevaluar";

/** Sin cuerpo o `{}`: el cliente y el periodo salen de la ruta y el estudio de la sesión, así que cualquier clave es 400. */
const esCuerpoVacio = (cuerpo: unknown): boolean =>
  cuerpo === undefined ||
  (typeof cuerpo === "object" && cuerpo !== null && !Array.isArray(cuerpo) && Object.keys(cuerpo).length === 0);

/**
 * «Volver a evaluar» (spec 027, U-12, R-8, R-12; CA-12). Solo encola `compras.reevaluar` (008) con `{periodo}`: el backend no evalúa nada, lo
 * hace el worker por lotes, con el contexto del momento y solo agregando evaluación a las compras cuyos hallazgos cambian. Orden: cuerpo (400
 * `solicitud_invalida`) → periodo (400) → cliente del alcance (404; archivado 409) → periodo `abierto` (409 `periodo_no_abierto`; sin fila
 * es abierto), todo en UNA transacción con el encolado, así que nada queda a medias. El dedupe de 008 por cliente y periodo hace que pedidos
 * repetidos compartan el trabajo vivo. No audita al pedir ni toca compras.
 */
@Injectable()
export class ReevaluarGastosService {
  constructor(@Inject(Encolador) private readonly encolador: Encolador) {}

  /** `trabajoId` del trabajo: el nuevo o el vivo del mismo cliente y periodo (dedupe de 008). */
  async reevaluar(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteCrudo: string,
    periodoCrudo: string,
    cuerpo: unknown,
  ): Promise<{ trabajoId: string }> {
    if (!esCuerpoVacio(cuerpo)) throw new AccesoError("solicitud_invalida");
    const periodo = periodoDe(periodoCrudo);
    // La guarda de alcance acepta el UUID en cualquier grafía; la clave de dedupe va con el id en minúsculas.
    const clienteId = clienteCrudo.toLowerCase();
    const ctx = contextoDe(sesion);
    try {
      const r = await conReintentoUnico(() =>
        this.encolador.encolarCon(
          ctx,
          { tipo: REEVALUAR, clienteId, parametros: { periodo }, prioridad: "interactivo", creadoPor: ctx.userId },
          async (tx) => {
            await exigirCliente(tx, clienteId, alcance, true);
            // Sin fila de `compra_periodo` el periodo es abierto: solo se lee, no se crea.
            if ((await leerEstadoPeriodo(tx, clienteId, periodo)).estado !== "abierto") throw new GastosError("periodo_no_abierto");
          },
        ),
      );
      return { trabajoId: r.trabajo.id };
    } catch (e) {
      throw aErrorHttp(e);
    }
  }
}
