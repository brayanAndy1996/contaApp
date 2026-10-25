// Rotación de KEK por estudio (spec 003, D6; CA-6, CA-7). En lotes ordenados por id:
//   1) withTenant: listar sobres con kek_id = desde;
//   2) fuera de la transacción: reenvolverDek (unwrap con la anterior, wrap con la activa y
//      comprobación de que la activa abre la misma DEK). No descifra el ciphertext;
//   3) withTenant: UPDATE con CAS sobre dek_envuelta y kek_id = desde por fila. Si el backend escribió entre la lectura
//      y el CAS, gana el backend y la fila se cuenta como omitida (no se reintenta en esta corrida).
// Un fallo del proveedor en el paso 2 rechaza con su error reintentable sin escribir nada del lote en
// curso; los lotes ya confirmados quedan (idempotente y reanudable). Valida todo antes de tocar la BD.
import {
  CryptoError,
  RotacionConMockError,
  esLlaveMock,
  reenvolverDek,
  type KeyUnwrapper,
  type KeyWrapper,
} from "@contapp/crypto/descifrado";
import { listarParaReenvolver, reemplazarDekEnvuelta, type ContappDb } from "@contapp/db";
import {
  ArgumentoInvalidoError,
  PersistenciaCredencialError,
  esKekId,
  esUuid,
} from "./errores.js";

export const LOTE_POR_DEFECTO = 100;

export interface OpcionesRotacion {
  db: Pick<ContappDb, "withTenant">;
  anterior: KeyUnwrapper;
  activa: KeyUnwrapper & KeyWrapper;
  tenantId: string;
  desde: string;
  lote?: number;
}

export interface ResultadoRotacion {
  reenvueltas: number;
  omitidas: number;
}

interface Reenvoltura {
  id: string;
  dekAnterior: Buffer;
  dekNueva: Buffer;
  kekNuevo: string;
  kekAnterior: string;
}

function validar(o: OpcionesRotacion): number {
  const lote = o.lote ?? LOTE_POR_DEFECTO;
  // La llave `mock` (privada en el repo) nunca participa en una rotación real: ni activa ni anterior.
  if (esLlaveMock(o.activa) || esLlaveMock(o.anterior)) throw new RotacionConMockError();
  if (!esKekId(o.desde)) throw new ArgumentoInvalidoError("desde");
  if (o.desde === o.activa.kekId) throw new ArgumentoInvalidoError("desde (es la KEK activa)");
  if (o.desde !== o.anterior.kekId) {
    throw new ArgumentoInvalidoError("desde (no coincide con la llave anterior)");
  }
  if (!esUuid(o.tenantId)) throw new ArgumentoInvalidoError("tenant");
  if (!Number.isSafeInteger(lote) || lote < 1) throw new ArgumentoInvalidoError("lote");
  return lote;
}

/** Errores de la BD se reducen a uno fijo; los de @contapp/crypto pasan tal cual (ya son seguros). */
async function enBd<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CryptoError) throw e;
    throw new PersistenciaCredencialError();
  }
}

export async function rotarKekTenant(o: OpcionesRotacion): Promise<ResultadoRotacion> {
  const lote = validar(o);
  const { db, anterior, activa, tenantId, desde } = o;
  const omitidas = new Set<string>();
  let reenvueltas = 0;

  for (;;) {
    // Se piden `lote` filas además de las ya omitidas (siguen con kek_id = desde) para no atascarse en ellas.
    const filas = (
      await enBd(() =>
        db.withTenant({ tenantId }, (tx) =>
          listarParaReenvolver(tx, desde, lote + omitidas.size),
        ),
      )
    )
      .filter((f) => !omitidas.has(f.id))
      .slice(0, lote);
    if (filas.length === 0) break;

    const cambios: Reenvoltura[] = [];
    for (const f of filas) {
      const nuevo = await reenvolverDek(f.sobre, anterior, activa);
      cambios.push({
        id: f.id,
        dekAnterior: f.sobre.dekEnvuelta,
        dekNueva: nuevo.dekEnvuelta,
        kekNuevo: nuevo.kekId,
        kekAnterior: desde,
      });
    }

    const aplicadas = await enBd(() =>
      db.withTenant({ tenantId }, async (tx) => {
        const r: boolean[] = [];
        for (const c of cambios) r.push(await reemplazarDekEnvuelta(tx, c));
        return r;
      }),
    );
    aplicadas.forEach((ok, i) => {
      if (ok) reenvueltas += 1;
      else omitidas.add(cambios[i]!.id);
    });

    if (filas.length < lote) break;
  }

  return { reenvueltas, omitidas: omitidas.size };
}
