// Procesadores `credencial.verificar_sol` y `credencial.verificar_sire` (spec 007b, D6; CA-5, CA-6).
//  (1) withTenant corto: ids y versión (xmin) de las credenciales necesarias. Si falta alguna, `ErrorCredencial` sin
//      llamar al puerto y sin marcar nada (no hay qué invalidar).
//  (2) Descifrado con el servicio auditado de 003 (motivo `credencial.verificar`); el secreto vive solo mientras se
//      arma la credencial del puerto y se destruye al terminar.
//  (3) Llamada al puerto SIN transacción abierta (008 D6). `verificar_sire` usa `SireAuth` directo, no la caché de token.
//  (4) withTenant corto con el resultado, solo si la fila sigue siendo la versión de (1): un guardado concurrente gana.
//      Éxito -> `verificada`; `ErrorCredencial` -> `invalida` y se relanza (el ejecutor deja `error/credencial_invalida`
//      sin reintentos); cualquier otro error sube tal cual y el estado no cambia. El catálogo declara `credencial: null`
//      (el despachador no cancela estos tipos), así que el ejecutor no marca nada: lo hace este procesador.
import type { Secreto } from "@contapp/crypto/descifrado";
import {
  destinatariosNuevos,
  estadoCredenciales,
  marcarCredencialInvalida,
  marcarCredencialVerificada,
  versionCredencial,
  type ContappDb,
  type TipoCredencial,
} from "@contapp/db";
import {
  clasificarError,
  ErrorCredencial,
  type SireAuth,
  type SolAuth,
} from "@contapp/sunat";
import type { ServicioCredenciales } from "../../credenciales/descifrar-credencial.js";
import { CredencialNoEncontradaError } from "../../credenciales/errores.js";
import type { Procesador } from "../ejecutor.js";
import type { Notificador } from "../registro.js";

export const MOTIVO_VERIFICAR = "credencial.verificar";

export interface DepsVerificarCredencial {
  db: Pick<ContappDb, "withTenant">;
  servicio: ServicioCredenciales;
  /** 017: avisa en vivo (tras el commit) a quien recibe la notificación de la credencial invalidada. Opcional. */
  notificador?: Notificador;
}

interface Ubicada {
  id: string;
  version: string;
}

type Ctx = Parameters<Procesador>[0]["trabajo"];

/** Ids y versiones de las credenciales pedidas; null en las que no existen. */
async function ubicar(
  d: DepsVerificarCredencial,
  t: Ctx,
  tipos: readonly TipoCredencial[],
): Promise<Record<TipoCredencial, Ubicada | null>> {
  return d.db.withTenant({ tenantId: t.tenantId, trabajoId: t.id }, async (tx) => {
    const filas = await estadoCredenciales(tx, t.clienteId);
    const r: Record<TipoCredencial, Ubicada | null> = {
      sol: null,
      sire_api: null,
    };
    for (const tipo of tipos) {
      const id = filas.find((f) => f.tipo === tipo)?.id;
      const version = await versionCredencial(tx, t.clienteId, tipo);
      if (id !== undefined && version !== null) r[tipo] = { id, version };
    }
    return r;
  });
}

async function descifrar(
  d: DepsVerificarCredencial,
  t: Ctx,
  id: string,
): Promise<Secreto> {
  try {
    return await d.servicio.descifrarCredencial(
      { tenantId: t.tenantId },
      id,
      MOTIVO_VERIFICAR,
    );
  } catch (e) {
    // Borrada entre la lectura y el descifrado: igual que si no existiera.
    if (e instanceof CredencialNoEncontradaError) throw new ErrorCredencial();
    throw e;
  }
}

/** Escribe el desenlace con el candado de versión; el error del puerto, si lo hubo, se relanza después. */
async function cerrar(
  d: DepsVerificarCredencial,
  t: Ctx,
  tipo: TipoCredencial,
  version: string,
  llamar: () => Promise<void>,
): Promise<{ ok: true }> {
  try {
    await llamar();
  } catch (e) {
    if (clasificarError(e).clase === "credencial") {
      const destinatarios = await d.db.withTenant(
        { tenantId: t.tenantId, trabajoId: t.id },
        async (tx) => {
          await marcarCredencialInvalida(
            tx,
            t.clienteId,
            tipo,
            "credencial_invalida",
            undefined,
            version,
          );
          // La notificación la guarda la BD en esta transacción; solo si hay a quién avisar en vivo se lee (017, D-9).
          return d.notificador === undefined ? [] : destinatariosNuevos(tx);
        },
      );
      // Tras el commit, sin esperarlo y sin que su fallo cambie el desenlace (la campana se pone al día al recargar).
      const notificador = d.notificador;
      if (notificador !== undefined && destinatarios.length > 0)
        void Promise.resolve()
          .then(() => notificador.avisar(t.tenantId, destinatarios))
          .catch(() => undefined);
    }
    throw e;
  }
  await d.db.withTenant({ tenantId: t.tenantId, trabajoId: t.id }, (tx) =>
    marcarCredencialVerificada(tx, t.clienteId, tipo, version),
  );
  return { ok: true };
}

export function verificarSol(
  d: DepsVerificarCredencial & { solAuth: SolAuth },
): Procesador {
  return async ({ trabajo: t }) => {
    const { sol } = await ubicar(d, t, ["sol"]);
    if (sol === null) throw new ErrorCredencial();
    const secreto = await descifrar(d, t, sol.id);
    try {
      const cred = secreto.usar((v) => ({
        ruc: t.ruc,
        usuarioSol: (v as { usuario: string }).usuario,
        claveSol: (v as { clave: string }).clave,
      }));
      return await cerrar(d, t, "sol", sol.version, () =>
        d.solAuth.verificar(cred),
      );
    } finally {
      secreto.destruir();
    }
  };
}

export function verificarSire(
  d: DepsVerificarCredencial & { sireAuth: SireAuth },
): Procesador {
  return async ({ trabajo: t }) => {
    const { sol, sire_api: sire } = await ubicar(d, t, ["sire_api", "sol"]);
    if (sire === null || sol === null) throw new ErrorCredencial();
    const secretoSire = await descifrar(d, t, sire.id);
    try {
      const secretoSol = await descifrar(d, t, sol.id);
      try {
        const api = secretoSire.usar((v) => ({
          clientId: (v as { clientId: string }).clientId,
          clientSecret: (v as { clientSecret: string }).clientSecret,
        }));
        const s = secretoSol.usar((v) => ({
          usuarioSol: (v as { usuario: string }).usuario,
          claveSol: (v as { clave: string }).clave,
        }));
        const cred = { ...api, ...s, ruc: t.ruc };
        return await cerrar(d, t, "sire_api", sire.version, async () => {
          await d.sireAuth.obtenerToken(cred);
        });
      } finally {
        secretoSol.destruir();
      }
    } finally {
      secretoSire.destruir();
    }
  };
}
