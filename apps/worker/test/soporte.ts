// Soporte de las pruebas del worker (spec 003, T7). No es codigo de produccion: vive fuera de `src`
// (nest build solo compila `src`) y no importa vitest. Los secretos son canarios generados al vuelo.
//
// Supuestos de contrato (los fija T7; T12 los cumple):
// - `leerSobre`/`registrarDescifrado` de @contapp/db hablan con `tx.query(text, values)`; la fila de la
//   tabla `credencial` llega con las columnas de `plan.md` (snake_case).
// - La fila de auditoria se inserta con una sentencia que nombra `auditoria_descifrado` y cuyos
//   parametros incluyen credencialId, motivo y resultado (el texto del enum de `resultado`).
import { randomBytes, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import type { Sobre, TipoCredencial } from "@contapp/crypto";

export const RESULTADOS = ["ok", "no_encontrada", "integridad", "formato", "llave"] as const;
export type Resultado = (typeof RESULTADOS)[number];

/** Entorno minimo para `mock` (fixture fijo de D1). */
export const ENV_MOCK: Record<string, string> = {
  KEY_PROVIDER: "mock",
  KEK_ID: "mock",
  NODE_ENV: "test",
};

export const uuid = (): string => randomUUID().toLowerCase();

/** Texto unico imposible de confundir con datos reales; se busca luego en logs, errores y BD. */
export const canario = (etiqueta = "x"): string => `CANARIO-${etiqueta}-${randomBytes(8).toString("hex")}`;

export type ValorSol = { usuario: string; clave: string };
export type ValorSire = { clientId: string; clientSecret: string };

export function valorDe(tipo: TipoCredencial, c: string): ValorSol | ValorSire {
  return tipo === "sol"
    ? { usuario: `u-${c}`, clave: `k-${c}` }
    : { clientId: `id-${c}`, clientSecret: `sec-${c}` };
}

// ---------- rastros: todas las formas en que un secreto o una DEK podria colarse en un texto ----------

export function rastros(secreto: string | Uint8Array): string[] {
  if (typeof secreto === "string") {
    const b = Buffer.from(secreto, "utf8");
    return [secreto, b.toString("hex"), b.toString("base64"), b.toString("base64url")];
  }
  const b = Buffer.from(secreto);
  if (b.length === 0 || b.every((x) => x === 0)) return []; // DEK ya puesta a cero: nada que buscar
  return [
    b.toString("hex"),
    b.toString("base64"),
    b.toString("base64url"),
    [...b].map((x) => x.toString(16).padStart(2, "0")).join(" "), // util.inspect de un Buffer
    [...b].join(","), // JSON.stringify([...buf])
  ];
}

/** Volcado de un valor (error, sobre, Secreto, llamadas al logger) por todas las vias de serializacion. */
export function volcado(valor: unknown, visto = new Set<unknown>()): string {
  if (valor === null || typeof valor !== "object") return String(valor);
  if (visto.has(valor)) return "";
  visto.add(valor);
  const partes: string[] = [];
  try {
    partes.push(JSON.stringify(valor, Object.getOwnPropertyNames(valor)) ?? "");
  } catch {
    partes.push("");
  }
  try {
    partes.push(JSON.stringify(valor) ?? "");
  } catch {
    partes.push("");
  }
  partes.push(inspect(valor, { depth: null, showHidden: true, maxArrayLength: null, maxStringLength: null }));
  partes.push(String(valor));
  if (valor instanceof Error) {
    partes.push(valor.message, valor.stack ?? "");
    const causa = (valor as { cause?: unknown }).cause;
    if (causa !== undefined) partes.push(volcado(causa, visto));
    const agregados = (valor as { errors?: unknown[] }).errors;
    if (Array.isArray(agregados)) for (const a of agregados) partes.push(volcado(a, visto));
  }
  for (const k of Object.getOwnPropertyNames(valor)) {
    const v = (valor as Record<string, unknown>)[k];
    if (v !== null && typeof v === "object") partes.push(volcado(v, visto));
    else partes.push(String(v));
  }
  return partes.join("\n");
}

/** Devuelve los rastros de `secretos` presentes en el volcado de `valor` (vacio = sin fuga). */
export function fugas(valor: unknown, secretos: Array<string | Uint8Array>): string[] {
  const texto = typeof valor === "string" ? valor : volcado(valor);
  const halladas: string[] = [];
  for (const s of secretos) for (const r of rastros(s)) if (r.length > 0 && texto.includes(r)) halladas.push("<rastro>");
  return halladas;
}

/** Ejecuta `fn` y devuelve el error rechazado (falla la prueba si no rechazo). */
export async function rechazo(fn: () => Promise<unknown>): Promise<Error & { codigo?: string; reintentable?: boolean }> {
  try {
    await fn();
  } catch (e) {
    return e as Error & { codigo?: string; reintentable?: boolean };
  }
  throw new Error("se esperaba un rechazo y la llamada tuvo exito (implementacion pendiente o prueba incorrecta)");
}

// ---------- logger espia: acepta cualquier metodo (log, info, warn, error, debug, ...) ----------

export interface LlamadaLogger {
  metodo: string;
  args: unknown[];
}
export function loggerEspia(): { logger: Record<string, (...a: unknown[]) => void>; llamadas: LlamadaLogger[] } {
  const llamadas: LlamadaLogger[] = [];
  const logger = new Proxy({} as Record<string, (...a: unknown[]) => void>, {
    get: (_o, metodo) => (...args: unknown[]) => {
      llamadas.push({ metodo: String(metodo), args });
    },
  });
  return { logger, llamadas };
}

// ---------- db falso (sin BD): una tabla `credencial` de una fila y la auditoria en memoria ----------

export interface FilaCredencialPg {
  id: string;
  tenant_id: string;
  cliente_id: string;
  tipo: TipoCredencial;
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  dek_envuelta: Buffer;
  kek_id: string;
  version: number;
}

export function filaPg(
  id: string,
  tenantId: string,
  clienteId: string,
  tipo: TipoCredencial,
  s: Sobre,
): FilaCredencialPg {
  return {
    id,
    tenant_id: tenantId,
    cliente_id: clienteId,
    tipo,
    ciphertext: Buffer.from(s.ciphertext),
    nonce: Buffer.from(s.nonce),
    tag: Buffer.from(s.tag),
    dek_envuelta: Buffer.from(s.dekEnvuelta),
    kek_id: s.kekId,
    version: s.version,
  };
}

export interface FallasDbFalso {
  lectura?: Error;
  auditoria?: Error;
  commit?: Error;
}
export interface Consulta {
  text: string;
  values: unknown[];
}

/** Error con la forma de uno de `pg` cuyo `detail` trae un valor sensible (peor caso para CA-9). */
export function errorPg(codigo: string, detalle: string): Error {
  return Object.assign(new Error(`falla simulada de pg: ${detalle}`), {
    name: "error",
    code: codigo,
    severity: "ERROR",
    detail: detalle,
    where: detalle,
  });
}

export function crearDbFalso(fila: FilaCredencialPg | null, fallas: FallasDbFalso = {}) {
  const consultas: Consulta[] = [];
  const auditorias: unknown[][] = [];
  let transacciones = 0;
  const db = {
    async withTenant<T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> {
      transacciones += 1;
      const tx = {
        async query(text: string, values: unknown[] = []) {
          consultas.push({ text, values });
          if (/auditoria_descifrado/i.test(text)) {
            if (fallas.auditoria) throw fallas.auditoria;
            auditorias.push(values);
            return { rows: [{ id: uuid() }], rowCount: 1 };
          }
          if (/^\s*select/i.test(text) && /\bcredencial\b/i.test(text)) {
            if (fallas.lectura) throw fallas.lectura;
            const pedida = values.find((v) => typeof v === "string") as string | undefined;
            if (fila && pedida === fila.id) {
              // Copia fresca por lectura; claves camelCase ademas de snake_case para no atar el mapeo.
              return {
                rows: [
                  {
                    ...fila,
                    ciphertext: Buffer.from(fila.ciphertext),
                    nonce: Buffer.from(fila.nonce),
                    tag: Buffer.from(fila.tag),
                    dek_envuelta: Buffer.from(fila.dek_envuelta),
                    tenantId: fila.tenant_id,
                    clienteId: fila.cliente_id,
                    dekEnvuelta: Buffer.from(fila.dek_envuelta),
                    kekId: fila.kek_id,
                  },
                ],
                rowCount: 1,
              };
            }
            return { rows: [], rowCount: 0 };
          }
          return { rows: [], rowCount: 0 };
        },
        orm: undefined,
      };
      const r = await fn(tx);
      if (fallas.commit) throw fallas.commit;
      return r;
    },
  };
  return {
    db,
    consultas,
    auditorias,
    transacciones: () => transacciones,
    /** Resultado(s) del enum presentes en los parametros de cada fila de auditoria. */
    resultados: () => auditorias.map((v) => RESULTADOS.filter((r) => v.includes(r))),
    /** Sentencias que modifican (nada debe marcar la credencial como invalida, CA-7). */
    modificaciones: () => consultas.filter((c) => /^\s*(update|delete)/i.test(c.text)),
  };
}

/** Db "prohibido": cualquier acceso falla la prueba (validaciones que deben ocurrir antes de la BD). */
export function dbProhibido() {
  let usos = 0;
  const db = {
    async withTenant(): Promise<never> {
      usos += 1;
      throw new Error("la BD no debia usarse");
    },
  };
  return { db, usos: () => usos };
}
