// Servicio de descifrado auditado del worker (spec 003, D3; CA-1, CA-5, CA-7, CA-8, CA-9).
// withTenant(ctx) → leerSobre → descifrarSobre → registrarDescifrado(resultado). La función de la
// transacción no lanza por fallos de descifrado: devuelve el desenlace, se audita y el error se lanza
// fuera, tras el COMMIT. Si la lectura, la auditoría o el COMMIT fallan, el Secreto se destruye y no
// se entrega; si el logger falla tras el COMMIT, el Secreto también se destruye. El AAD sale de ctx.tenantId y de la fila (cliente_id, tipo). El logger recibe solo ids,
// código y resultado.
import {
  CryptoError,
  IntegridadError,
  descifrarSobre,
  type KeyUnwrapper,
  type Secreto,
  type TipoCredencial,
} from "@contapp/crypto/descifrado";
import {
  leerSobre,
  registrarDescifrado,
  type ContappDb,
  type ResultadoDescifrado,
  type TxConsulta,
} from "@contapp/db";
import {
  ArgumentoInvalidoError,
  CredencialNoEncontradaError,
  CredencialesWorkerError,
  PersistenciaCredencialError,
  esMotivo,
  esUuid,
} from "./errores.js";

/** Lo único que el servicio entrega al logger: ids, resultado y código del error. */
export interface EventoDescifrado {
  tenantId: string;
  credencialId: string;
  resultado: ResultadoDescifrado | "bd";
  codigo?: string;
}

export interface LoggerCredenciales {
  log(evento: EventoDescifrado): void;
  warn(evento: EventoDescifrado): void;
}

export interface DepsServicioCredenciales {
  db: Pick<ContappDb, "withTenant">;
  unwrapper: KeyUnwrapper;
  logger: LoggerCredenciales;
}

export interface ServicioCredenciales {
  descifrarCredencial(
    ctx: { tenantId: string },
    credencialId: string,
    motivo: string,
  ): Promise<Secreto>;
}

type ErrorTipado = CryptoError | CredencialesWorkerError;

interface Desenlace {
  resultado: ResultadoDescifrado;
  clienteId: string | null;
  tipo: TipoCredencial | null;
  secreto?: Secreto;
  error?: ErrorTipado;
}

// Resultado auditado por código de error de @contapp/crypto; cualquier otro es "integridad".
const RESULTADO_POR_CODIGO: Readonly<Record<string, ResultadoDescifrado>> = {
  sobre_invalido: "formato",
  contexto_invalido: "formato",
  key_provider: "llave",
  kek_desconocida: "llave",
  configuracion: "llave",
};

function clasificar(e: unknown): { resultado: ResultadoDescifrado; error: CryptoError } {
  const error = e instanceof CryptoError ? e : new IntegridadError();
  return { resultado: RESULTADO_POR_CODIGO[error.codigo] ?? "integridad", error };
}

export function crearServicioCredenciales(deps: DepsServicioCredenciales): ServicioCredenciales {
  const { db, unwrapper, logger } = deps;

  async function intentar(
    tx: TxConsulta,
    tenantId: string,
    credencialId: string,
  ): Promise<Desenlace> {
    const fila = await leerSobre(tx, credencialId);
    if (fila === null) {
      return {
        resultado: "no_encontrada",
        clienteId: null,
        tipo: null,
        error: new CredencialNoEncontradaError(),
      };
    }
    // Con RLS no debería ocurrir; si la fila dice ser de otro estudio no se toca la llave.
    if (fila.tenantId !== tenantId) {
      return { resultado: "integridad", clienteId: null, tipo: null, error: new IntegridadError() };
    }
    const base = { clienteId: fila.clienteId, tipo: fila.tipo };
    try {
      const secreto = await descifrarSobre(
        unwrapper,
        { tenantId, clienteId: fila.clienteId, tipo: fila.tipo },
        fila.sobre,
      );
      return { ...base, resultado: "ok", secreto };
    } catch (e) {
      return { ...base, ...clasificar(e) };
    }
  }

  async function descifrarCredencial(
    ctx: { tenantId: string },
    credencialId: string,
    motivo: string,
  ): Promise<Secreto> {
    const tenantId: unknown = (Object(ctx) as { tenantId?: unknown }).tenantId; // ctx nulo → undefined
    if (!esUuid(tenantId) || !esUuid(credencialId)) {
      throw new ArgumentoInvalidoError("tenantId o credencialId");
    }
    if (!esMotivo(motivo)) throw new ArgumentoInvalidoError("motivo");

    const enCurso: { secreto?: Secreto } = {};
    let desenlace: Desenlace;
    try {
      desenlace = await db.withTenant({ tenantId }, async (tx) => {
        const d = await intentar(tx, tenantId, credencialId);
        enCurso.secreto = d.secreto;
        await registrarDescifrado(tx, {
          credencialId,
          clienteId: d.clienteId,
          tipo: d.tipo,
          motivo,
          resultado: d.resultado,
        });
        return d;
      });
    } catch {
      // Lectura, auditoría o COMMIT fallidos: el error de la BD se descarta (puede traer valores).
      enCurso.secreto?.destruir();
      logger.warn({ tenantId, credencialId, resultado: "bd", codigo: "bd" });
      throw new PersistenciaCredencialError();
    }

    if (desenlace.secreto !== undefined) {
      try {
        logger.log({ tenantId, credencialId, resultado: "ok" });
      } catch (e) {
        // El descifrado ya quedó auditado, pero el Secreto no se entrega sin dueño: se destruye.
        desenlace.secreto.destruir();
        throw e;
      }
      return desenlace.secreto;
    }
    const error = desenlace.error as ErrorTipado;
    logger.warn({ tenantId, credencialId, resultado: desenlace.resultado, codigo: error.codigo });
    throw error;
  }

  return { descifrarCredencial };
}
