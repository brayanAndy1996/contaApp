// Credencial SOL del cliente de un trabajo del buzón (spec 023, 008, 003). Un `withTenant` corto ubica la credencial `sol`;
// sin ella -> `ErrorCredencial` (sin descifrar nada). Se descifra UNA vez con el servicio auditado de 003 (motivo = tipo del
// trabajo) y el secreto se destruye en cuanto se arma la credencial del puerto. Nada del secreto llega a logs ni errores.
import { estadoCredenciales, type ContappDb } from "@contapp/db";
import { ErrorCredencial, type CredencialSol } from "@contapp/sunat";
import type { ServicioCredenciales } from "../../credenciales/descifrar-credencial.js";
import { CredencialNoEncontradaError } from "../../credenciales/errores.js";
import type { TrabajoEnCurso } from "../ejecutor.js";

export interface DepsCredencialSol {
  db: Pick<ContappDb, "withTenant">;
  servicio: ServicioCredenciales;
}

/** Id de la credencial SOL del cliente del trabajo, o `null` si no tiene. */
export async function ubicarCredencialSol(
  tx: Parameters<typeof estadoCredenciales>[0],
  clienteId: string,
): Promise<string | null> {
  const filas = await estadoCredenciales(tx, clienteId);
  return filas.find((f) => f.tipo === "sol")?.id ?? null;
}

/** Descifra la credencial `id` (auditado) y arma la del puerto con el RUC del trabajo. */
export async function descifrarCredencialSol(
  d: DepsCredencialSol,
  t: Pick<TrabajoEnCurso, "tenantId" | "ruc" | "tipo">,
  id: string | null,
): Promise<CredencialSol> {
  if (id === null) throw new ErrorCredencial();
  let secreto;
  try {
    secreto = await d.servicio.descifrarCredencial(
      { tenantId: t.tenantId },
      id,
      t.tipo,
    );
  } catch (e) {
    // Borrada entre la lectura y el descifrado: igual que si no existiera.
    if (e instanceof CredencialNoEncontradaError) throw new ErrorCredencial();
    throw e;
  }
  try {
    return secreto.usar((v) => ({
      ruc: t.ruc,
      usuarioSol: (v as { usuario: string }).usuario,
      claveSol: (v as { clave: string }).clave,
    }));
  } finally {
    secreto.destruir();
  }
}
