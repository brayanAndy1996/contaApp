// Verificador SCRAM-SHA-256 calculado en el cliente (RFC 5802 / RFC 7677), en el formato que
// PostgreSQL guarda en pg_authid.rolpassword:
//   SCRAM-SHA-256$<iteraciones>:<sal b64>$<StoredKey b64>:<ServerKey b64>
// Así `ALTER ROLE ... PASSWORD '<verificador>'` nunca envía la contraseña en claro al servidor.
// Este módulo no registra ni devuelve la contraseña en ningún caso.
import {
  createHash,
  createHmac,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export interface OpcionesVerificador {
  /** Sal en bruto. Por defecto 16 bytes aleatorios (igual que PostgreSQL). */
  sal?: Buffer;
  /** Iteraciones de PBKDF2. Por defecto 4096 (igual que PostgreSQL). */
  iteraciones?: number;
}

const ITERACIONES_POR_DEFECTO = 4096;
const BYTES_SAL = 16;
const BYTES_CLAVE = 32;
/** Cota para no gastar CPU sin límite con un verificador manipulado. */
const MAX_ITERACIONES = 10_000_000;
const B64 = "[A-Za-z0-9+/]+={0,2}";
const FORMATO = new RegExp(`^SCRAM-SHA-256\\$(\\d{1,8}):(${B64})\\$(${B64}):(${B64})$`);

// SASLprep simplificado (RFC 4013), como hace PostgreSQL antes de derivar la clave:
// espacios no ASCII -> U+0020, se quitan los caracteres "mapeados a nada" y se normaliza NFKC.
// Una contraseña ASCII imprimible (el caso de este proyecto) queda igual.
const ESPACIOS_NO_ASCII =
  /[   -​  　]/g;
const MAPEADOS_A_NADA =
  /[­͏᠆᠋-᠍‌‍⁠︀-️﻿]/g;

function saslPrep(password: string): string {
  if (/^[\x20-\x7E]*$/.test(password)) return password;
  return password
    .replace(ESPACIOS_NO_ASCII, " ")
    .replace(MAPEADOS_A_NADA, "")
    .normalize("NFKC");
}

function claves(password: string, sal: Buffer, iteraciones: number) {
  const salted = pbkdf2Sync(
    Buffer.from(saslPrep(password), "utf8"),
    sal,
    iteraciones,
    BYTES_CLAVE,
    "sha256",
  );
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return { storedKey, serverKey };
}

function iteracionesValidas(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MAX_ITERACIONES;
}

/** Genera el verificador SCRAM-SHA-256 de `password`. Lanza con mensaje fijo si la entrada no es válida. */
export function generaVerificador(
  password: string,
  opciones: OpcionesVerificador = {},
): string {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("La contraseña para el verificador SCRAM no es válida");
  }
  const iteraciones = opciones.iteraciones ?? ITERACIONES_POR_DEFECTO;
  if (!iteracionesValidas(iteraciones)) {
    throw new Error("Número de iteraciones SCRAM no válido");
  }
  const sal = opciones.sal ?? randomBytes(BYTES_SAL);
  if (!Buffer.isBuffer(sal) || sal.length === 0) {
    throw new Error("Sal SCRAM no válida");
  }
  const { storedKey, serverKey } = claves(password, sal, iteraciones);
  return `SCRAM-SHA-256$${iteraciones}:${sal.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/** true si `password` corresponde al verificador. Nunca lanza: un verificador mal formado da false. */
export function verificaPassword(verificador: string, password: string): boolean {
  try {
    if (typeof verificador !== "string" || typeof password !== "string") return false;
    if (password.length === 0) return false;
    const m = FORMATO.exec(verificador);
    if (!m) return false;
    const iteraciones = Number(m[1]);
    if (!iteracionesValidas(iteraciones)) return false;
    const sal = Buffer.from(m[2]!, "base64");
    const storedEsperada = Buffer.from(m[3]!, "base64");
    const serverEsperada = Buffer.from(m[4]!, "base64");
    if (
      sal.length === 0 ||
      storedEsperada.length !== BYTES_CLAVE ||
      serverEsperada.length !== BYTES_CLAVE
    ) {
      return false;
    }
    const { storedKey, serverKey } = claves(password, sal, iteraciones);
    const okStored = timingSafeEqual(storedKey, storedEsperada);
    const okServer = timingSafeEqual(serverKey, serverEsperada);
    return okStored && okServer;
  } catch {
    return false;
  }
}
