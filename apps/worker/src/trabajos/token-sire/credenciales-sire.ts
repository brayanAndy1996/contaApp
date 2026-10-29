// Credenciales para pedir el token SIRE (spec 008, D14): las del cliente (`sire_api` y `sol`) descifradas con el
// servicio auditado de 003 (`descifrarCredencial`). Lo descifrado solo vive en memoria mientras se arma la
// credencial; cada Secreto se destruye al terminar. Sin alguna de las dos credenciales, el cliente no puede
// autenticarse: `ErrorCredencial` (CA-9).
import { estadoCredenciales, type ContappDb } from "@contapp/db";
import { ErrorCredencial, type CredencialSire } from "@contapp/sunat";
import { CredencialNoEncontradaError } from "../../credenciales/errores.js";
import type { ServicioCredenciales } from "../../credenciales/descifrar-credencial.js";
import type { ContextoToken, CredencialesSire } from "./cache-token.js";

export const MOTIVO_TOKEN_SIRE = "sire.token";

export interface DepsCredencialesSire {
  db: Pick<ContappDb, "withTenant">;
  servicio: ServicioCredenciales;
}

export function crearCredencialesSire(
  d: DepsCredencialesSire,
): CredencialesSire {
  return async (ctx: ContextoToken): Promise<CredencialSire> => {
    const filas = await d.db.withTenant({ tenantId: ctx.tenantId }, (tx) =>
      estadoCredenciales(tx, ctx.clienteId),
    );
    const idDe = (tipo: "sol" | "sire_api") =>
      filas.find((f) => f.tipo === tipo)?.id;
    const idSire = idDe("sire_api");
    const idSol = idDe("sol");
    if (idSire === undefined || idSol === undefined)
      throw new ErrorCredencial();
    const descifrar = async (id: string) => {
      try {
        return await d.servicio.descifrarCredencial(
          { tenantId: ctx.tenantId },
          id,
          MOTIVO_TOKEN_SIRE,
        );
      } catch (e) {
        // Borrada entre la lectura y el descifrado: igual que si no existiera.
        if (e instanceof CredencialNoEncontradaError)
          throw new ErrorCredencial();
        throw e;
      }
    };
    const sire = await descifrar(idSire);
    try {
      const sol = await descifrar(idSol);
      try {
        const api = sire.usar((v) => ({
          clientId: (v as { clientId: string }).clientId,
          clientSecret: (v as { clientSecret: string }).clientSecret,
        }));
        const s = sol.usar((v) => ({
          usuarioSol: (v as { usuario: string }).usuario,
          claveSol: (v as { clave: string }).clave,
        }));
        return { ...api, ...s, ruc: ctx.ruc };
      } finally {
        sol.destruir();
      }
    } finally {
      sire.destruir();
    }
  };
}
