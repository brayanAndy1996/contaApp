import { Inject, Injectable } from "@nestjs/common";
import { eliminarMesManual, guardarMesManual, guardarUsada, type Alcance, type ContappDb, type Tx } from "@contapp/db";
import { eliminarMesManualSchema, guardarMesManualSchema, guardarProrrataUsadaSchema } from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { DB } from "../auth/inyeccion.js";
import { conReintentoUnico } from "../buzon/apoyo.js";
import { contextoDe } from "../clientes/contexto.js";
import { aErrorHttp, exigirCliente, periodoDeRuta } from "./apoyo.js";

/**
 * Escrituras de la prorrata (spec 026, D-4, D-5, D-6; R-5, R-8; CA-4, CA-6): guardar y eliminar el mes manual y guardar la prorrata
 * usada. Cada una valida el cuerpo con `@contapp/shared` (400 `solicitud_invalida`, antes de abrir la transacción: como 025, el cuerpo
 * inválido gana al 409 de cliente archivado), comprueba el cliente del alcance (404; archivado 409) y llama a la función acotada de 0066,
 * que lleva el compare-and-set por versión, el orden `CA412`/`CA413` antes de `CA409` y la auditoría (sin montos ni motivo, D-6, D-7). Todo
 * va dentro de `withTenant`; un interbloqueo se reintenta una vez. Responden solo `{ version }`.
 */
@Injectable()
export class EscrituraProrrataService {
  constructor(@Inject(DB) private readonly db: Pick<ContappDb, "withTenant">) {}

  /** Guarda la versión `version + 1` del mes manual. */
  async guardarMes(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteCrudo: string,
    periodoCrudo: string,
    cuerpo: unknown,
  ): Promise<{ version: number }> {
    const periodo = periodoDeRuta(periodoCrudo);
    const v = guardarMesManualSchema.safeParse(cuerpo ?? {});
    if (!v.success) throw new AccesoError("solicitud_invalida");
    const clienteId = clienteCrudo.toLowerCase();
    return this.escribir(sesion, alcance, clienteId, (tx) =>
      guardarMesManual(tx, {
        clienteId,
        periodo,
        gravadas: v.data.gravadas,
        exportaciones: v.data.exportaciones,
        noGravadas: v.data.noGravadas,
        motivo: v.data.motivo,
        version: v.data.version,
      }),
    );
  }

  /** Elimina el manual vivo (nueva versión `eliminado`). */
  async eliminarMes(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteCrudo: string,
    periodoCrudo: string,
    cuerpo: unknown,
  ): Promise<{ version: number }> {
    const periodo = periodoDeRuta(periodoCrudo);
    const v = eliminarMesManualSchema.safeParse(cuerpo ?? {});
    if (!v.success) throw new AccesoError("solicitud_invalida");
    const clienteId = clienteCrudo.toLowerCase();
    return this.escribir(sesion, alcance, clienteId, (tx) =>
      eliminarMesManual(tx, { clienteId, periodo, motivo: v.data.motivo, version: v.data.version }),
    );
  }

  /** Guarda la prorrata usada ingresada (`null` la quita). */
  async guardarUsada(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteCrudo: string,
    periodoCrudo: string,
    cuerpo: unknown,
  ): Promise<{ version: number }> {
    const periodo = periodoDeRuta(periodoCrudo);
    const v = guardarProrrataUsadaSchema.safeParse(cuerpo ?? {});
    if (!v.success) throw new AccesoError("solicitud_invalida");
    const clienteId = clienteCrudo.toLowerCase();
    return this.escribir(sesion, alcance, clienteId, (tx) =>
      guardarUsada(tx, { clienteId, periodo, porcentaje: v.data.porcentaje, version: v.data.version }),
    );
  }

  private async escribir(
    sesion: SesionResuelta,
    alcance: Alcance,
    clienteId: string,
    operacion: (tx: Tx) => Promise<number>,
  ): Promise<{ version: number }> {
    const ctx = contextoDe(sesion);
    try {
      const version = await conReintentoUnico(() =>
        this.db.withTenant(ctx, async (tx) => {
          await exigirCliente(tx, clienteId, alcance, true);
          return operacion(tx);
        }),
      );
      return { version };
    } catch (e) {
      throw aErrorHttp(e);
    }
  }
}
