import { Inject, Injectable } from "@nestjs/common";
import {
  auditarBuzon,
  bloquearEstadoBuzon,
  fallaPorCredencialBuzon,
  elevarPrioridadBuzon,
  leerMensajeBuzon,
  marcarSolicitudBuzon,
  trabajoVivoPorClave,
  type Alcance,
} from "@contapp/db";
import { claveDedupe } from "@contapp/queue";
import type { TrabajoVista } from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { contextoDe } from "../clientes/contexto.js";
import { Encolador } from "../trabajos/encolador.js";
import { esperaDeEnfriamiento, exigirCliente, exigirCredencialSol, idDe } from "./apoyo.js";
import { BuzonError } from "./errores.js";

const REVISAR = "sol.buzon.revisar";
const ABRIR = "sol.buzon.abrir";

/** Resultado de pedir una captura o una apertura: el trabajo y si se creó ahora (202) o ya existía (200). */
export interface Solicitud {
  trabajo: TrabajoVista;
  nuevo: boolean;
}

/** Señal interna: el contenido del mensaje ya se obtuvo; no hay nada que encolar (200 `{ trabajo: null }`). */
class ContenidoYaObtenido extends Error {}

/**
 * «Revisar buzón ahora» y «Abrir» (spec 023, D-6, P-1, P-6). Solo encolan (008): el backend nunca llama a SUNAT, nunca descifra
 * la credencial y nunca escribe el contenido; eso es del worker. Toda consulta va dentro de `withTenant` (vía el `Encolador`).
 */
@Injectable()
export class SolicitudBuzonService {
  constructor(@Inject(Encolador) private readonly encolador: Encolador) {}

  /**
   * Orden del plan, en UNA transacción: cliente (404, 409 archivado) → credencial SOL (409) → estado `FOR UPDATE` (se crea si falta)
   * → captura viva (se devuelve, y si era programada se eleva a interactivo) → enfriamiento de 10 min (429) → `encolar` → solicitud
   * y auditoría. El estado se bloquea antes que el trabajo (orden de bloqueo del plan): cincuenta pedidos a la vez dejan un solo
   * trabajo. La pista de Redis se publica tras el commit, también al elevar (baja el puntaje del programado).
   */
  async revisar(sesion: SesionResuelta, alcance: Alcance, clienteCrudo: string): Promise<Solicitud> {
    // La guarda de alcance acepta el UUID en cualquier grafía; clave de dedupe y auditoría van con el id en minúsculas (H-023-1-1).
    const clienteId = clienteCrudo.toLowerCase();
    const ctx = contextoDe(sesion);
    let elevado = false;
    const r = await this.encolador.encolarCon(
      ctx,
      { tipo: REVISAR, clienteId, parametros: {}, prioridad: "interactivo", creadoPor: ctx.userId },
      async (tx) => {
        elevado = false;
        await exigirCliente(tx, clienteId, alcance, true);
        await exigirCredencialSol(tx, clienteId);
        const estado = await bloquearEstadoBuzon(tx, clienteId);
        const vivo = await trabajoVivoPorClave(tx, claveDedupe(REVISAR, clienteId, {}));
        if (vivo !== null) {
          elevado = await elevarPrioridadBuzon(tx, vivo.id);
          return;
        }
        const espera = esperaDeEnfriamiento(estado, Date.now(), await fallaPorCredencialBuzon(tx, clienteId));
        if (espera !== null) throw new BuzonError("captura_reciente", espera);
      },
      async (tx, resultado) => {
        if (!resultado.nuevo) return elevado;
        await marcarSolicitudBuzon(tx, clienteId);
        await auditarBuzon(tx, "buzon.captura_solicitada", { clienteId });
        return false;
      },
    );
    return { trabajo: r.trabajo, nuevo: r.nuevo };
  }

  /**
   * `trabajo: null` si el contenido ya se obtuvo (nada que encolar ni auditar). Sin enfriamiento: la clave de dedupe es el mensaje,
   * así que pedirlo dos veces con el trabajo vivo devuelve el mismo trabajo. El `mensajeId` sale de la ruta, nunca del cuerpo.
   */
  async abrir(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteCrudo: string,
    mensajeCrudo: string,
  ): Promise<{ trabajo: TrabajoVista | null; nuevo: boolean }> {
    const clienteId = clienteCrudo.toLowerCase();
    const mensajeId = idDe(mensajeCrudo).toLowerCase();
    const ctx = contextoDe(sesion);
    try {
      const r = await this.encolador.encolarCon(
        ctx,
        { tipo: ABRIR, clienteId, parametros: { mensajeId }, prioridad: "interactivo", creadoPor: ctx.userId },
        async (tx) => {
          await exigirCliente(tx, clienteId, alcance, true);
          // El cliente va en la consulta: el mensaje de otro cliente (o estudio) es un 404 igual que uno inexistente.
          const mensaje = await leerMensajeBuzon(tx, clienteId, mensajeId);
          if (mensaje === null) throw new AccesoError("no_encontrado");
          if (mensaje.contenidoRuta !== null) throw new ContenidoYaObtenido();
          await exigirCredencialSol(tx, clienteId);
        },
        async (tx, resultado) => {
          if (resultado.nuevo) await auditarBuzon(tx, "buzon.apertura_solicitada", { clienteId, mensajeId });
        },
      );
      return { trabajo: r.trabajo, nuevo: r.nuevo };
    } catch (e) {
      if (e instanceof ContenidoYaObtenido) return { trabajo: null, nuevo: false };
      throw e;
    }
  }
}
