// Rotación de KEK por estudio (spec 003, D6; CA-6, CA-7). En lotes ordenados por id:
//   1) withTenant: listar sobres con kek_id = desde;
//   2) fuera de la transacción: reenvolverDek (unwrap con la anterior, wrap con la activa y
//      comprobación de que la activa abre la misma DEK). No descifra el ciphertext;
//   3) withTenant: UPDATE con CAS sobre dek_envuelta y kek_id = desde por fila. Si el backend escribió entre la lectura
//      y el CAS, gana el backend y la fila se cuenta como omitida (no se reintenta en esta corrida).
// Un fallo del proveedor en el paso 2 rechaza con su error reintentable sin escribir nada del lote en
// curso; los lotes ya confirmados quedan (idempotente y reanudable). Valida todo antes de tocar la BD,
// incluido que la anterior no sea la misma llave que la activa (huella del SPKI, T17 · R2b-1).
//
// Filas corruptas (T15 · F2, decisión del usuario: opción A). Una fila cuyo sobre no abre con la
// anterior (IntegridadError/SobreInvalidoError) no aborta el estudio: queda intacta en `desde`, se
// cuenta como omitida y su id se reporta en `corruptas` (solo ids, nunca bytes). Mientras quede una,
// la KEK anterior NO se puede jubilar. Si ninguna fila abrió en toda la corrida y hubo corruptas, no se
// distingue una llave anterior equivocada de un estudio cuyas filas restantes (p. ej. en una corrida
// posterior) son todas corruptas: AnteriorNoAbreError, sin escribir.
import {
  CryptoError,
  IntegridadError,
  RotacionConMockError,
  SobreInvalidoError,
  esLlaveMock,
  reenvolverDek,
  type KeyUnwrapper,
  type KeyWrapper,
} from "@contapp/crypto/descifrado";
import { listarParaReenvolver, reemplazarDekEnvuelta, type ContappDb } from "@contapp/db";
import {
  AnteriorIgualActivaError,
  AnteriorNoAbreError,
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
  /** Filas que siguen sin re-envolver en esta corrida: ganó el backend en el CAS o están corruptas. */
  omitidas: number;
}

export interface DetalleRotacion extends ResultadoRotacion {
  /** Ids de las filas corruptas (subconjunto de `omitidas`). Si no está vacío, la KEK anterior sigue necesaria. */
  corruptas: string[];
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

/**
 * La anterior no puede tener el mismo material que la activa aunque traiga otro kek_id u otra ruta
 * (p. ej. KEK_PRIVATE_KEY_PATH sigue en la llave vieja con KEK_ID nuevo): esa "rotación" terminaría bien
 * sin sacar ninguna DEK de la llave que se quiere jubilar (T17 · R2b-1). Compara la huella del SPKI de
 * ambas; se llama antes de tocar la BD. Un proveedor sin huella (dobles de prueba) no se compara.
 */
export async function exigirLlavesDistintas(
  anterior: KeyUnwrapper,
  activa: KeyUnwrapper,
): Promise<void> {
  if (anterior.huellaPublica === undefined || activa.huellaPublica === undefined) return;
  const [a, b] = await Promise.all([anterior.huellaPublica(), activa.huellaPublica()]);
  if (a === b) throw new AnteriorIgualActivaError();
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

/** El sobre de la fila no abre (o no tiene forma válida): culpa de la fila, no del proveedor. */
function esFilaCorrupta(e: unknown): boolean {
  return e instanceof IntegridadError || e instanceof SobreInvalidoError;
}

/** Rotación con el detalle de las filas corruptas (lo usa `kek:rotar` para alertar). */
export async function rotarKekTenantDetalle(o: OpcionesRotacion): Promise<DetalleRotacion> {
  const lote = validar(o);
  const { db, anterior, activa, tenantId, desde } = o;
  await exigirLlavesDistintas(anterior, activa);
  const omitidas = new Set<string>(); // CAS perdido o corrupta: no se vuelven a pedir en esta corrida
  const corruptas: string[] = [];
  let reenvueltas = 0;
  let abiertas = 0;

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
      let nuevo: Awaited<ReturnType<typeof reenvolverDek>>;
      try {
        nuevo = await reenvolverDek(f.sobre, anterior, activa);
      } catch (e) {
        // Cualquier otro error (proveedor caído, mock…) aborta el lote en curso sin escribir.
        if (!esFilaCorrupta(e)) throw e;
        omitidas.add(f.id);
        corruptas.push(f.id);
        continue;
      }
      abiertas += 1;
      cambios.push({
        id: f.id,
        dekAnterior: f.sobre.dekEnvuelta,
        dekNueva: nuevo.dekEnvuelta,
        kekNuevo: nuevo.kekId,
        kekAnterior: desde,
      });
    }

    const aplicadas =
      cambios.length === 0
        ? []
        : await enBd(() =>
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

  if (abiertas === 0 && corruptas.length > 0) throw new AnteriorNoAbreError();
  return { reenvueltas, omitidas: omitidas.size, corruptas };
}

/** Contrato de T7: solo `{ reenvueltas, omitidas }` (las corruptas cuentan como omitidas). */
export async function rotarKekTenant(o: OpcionesRotacion): Promise<ResultadoRotacion> {
  const { reenvueltas, omitidas } = await rotarKekTenantDetalle(o);
  return { reenvueltas, omitidas };
}
