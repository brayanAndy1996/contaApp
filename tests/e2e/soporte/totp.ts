// TOTP calculado por la prueba (spec 029, T11): hace de aplicación autenticadora. RFC 6238 (HMAC-SHA-1, 6 dígitos, 30 s)
// con `node:crypto`, sin importar nada del backend: la prueba verifica el contrato, no reutiliza su implementación.
// El servidor rechaza un paso ya usado (replay, D3) y acepta ±1 paso: `Autenticador` lleva el último paso que entregó y
// pide el siguiente; solo espera (hasta ~30 s) si ya agotó la ventana, así que un flujo corto no se detiene.
import { createHmac } from "node:crypto";

const PASO_MS = 30_000;
const ALFABETO = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32 de RFC 4648 (mayúsculas, con o sin relleno) a bytes. Lanza con un carácter fuera del alfabeto. */
export function decodificarBase32(texto: string): Buffer {
  let bits = 0;
  let acumulado = 0;
  const bytes: number[] = [];
  for (const c of texto.replace(/=+$/, "").toUpperCase()) {
    const v = ALFABETO.indexOf(c);
    if (v < 0) throw new Error("El secreto no es base32.");
    acumulado = (acumulado << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bytes.push((acumulado >>> (bits - 8)) & 0xff);
      bits -= 8;
      acumulado &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes);
}

/** El secreto (base32) del URI `otpauth://totp/...?secret=...`, tal cual viene en el URI. */
export function secretoBase32DeUri(uri: string): string {
  const url = new URL(uri);
  if (url.protocol !== "otpauth:") throw new Error("El URI no es otpauth://.");
  const secreto = url.searchParams.get("secret");
  if (secreto === null || secreto === "")
    throw new Error("El URI no trae el secreto.");
  return secreto;
}

/** Código de 6 dígitos del `paso` (RFC 4226 §5.3). */
export function codigoDelPaso(secreto: Buffer, paso: number): string {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(paso));
  const h = createHmac("sha1", secreto).update(contador).digest();
  const o = (h[h.length - 1] ?? 0) & 0x0f;
  const n =
    (((h[o] ?? 0) & 0x7f) << 24) |
    ((h[o + 1] ?? 0) << 16) |
    ((h[o + 2] ?? 0) << 8) |
    (h[o + 3] ?? 0);
  return String(n % 1_000_000).padStart(6, "0");
}

const pasoDe = (ms: number): number => Math.floor(ms / PASO_MS);
const dormir = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export class Autenticador {
  readonly secreto: Buffer;
  /** El secreto en base32 tal como lo muestra el URI: la prueba lo busca en correos, logs y BD (CA-6). */
  readonly secretoBase32: string;
  private ultimo = -1;
  private readonly usados: string[] = [];

  constructor(uri: string) {
    this.secretoBase32 = secretoBase32DeUri(uri);
    this.secreto = decodificarBase32(this.secretoBase32);
  }

  /**
   * Un código válido que el servidor aún no vio: el del paso actual o, si ya se usó, el siguiente (cabe en ±1). Si la
   * ventana ya se agotó, espera a que avance el reloj.
   */
  async siguiente(): Promise<string> {
    const candidato = Math.max(this.ultimo + 1, pasoDe(Date.now()));
    if (candidato > pasoDe(Date.now()) + 1) {
      await dormir((candidato - 1) * PASO_MS - Date.now() + 1_000);
    }
    this.ultimo = candidato;
    const codigo = codigoDelPaso(this.secreto, candidato);
    this.usados.push(codigo);
    return codigo;
  }

  /** El último código entregado: el servidor ya lo usó, así que debe rechazarlo (replay). */
  repetido(): string {
    if (this.ultimo < 0) throw new Error("Aún no se entregó ningún código.");
    return codigoDelPaso(this.secreto, this.ultimo);
  }

  /** Un código de un paso muy lejano (fuera de ±1): nunca es válido. */
  fueraDeVentana(): string {
    return codigoDelPaso(this.secreto, pasoDe(Date.now()) + 50);
  }

  /** Los códigos que entregó esta aplicación: la prueba comprueba que no salieron en correos, logs ni BD (CA-6). */
  get entregados(): readonly string[] {
    return this.usados;
  }
}
