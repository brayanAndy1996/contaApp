import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import { CONTRASENA_MAX_PUNTOS } from "@contapp/shared";
import { randomBytes } from "node:crypto";
import { ContrasenaInvalidaError } from "../errores.js";

export interface ParametrosArgon2 {
  memoriaKib: number;
  iteraciones: number;
  paralelismo: number;
}

export interface OpcionesHashArgon2 {
  algorithm: number;
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

/** Forma de `@node-rs/argon2` que usamos; se inyecta para espiar las llamadas. */
export interface LibArgon2 {
  hash(plano: string, opciones: OpcionesHashArgon2): Promise<string>;
  verify(phc: string, plano: string): Promise<boolean>;
}

export interface Hasher {
  calcular(plano: string): Promise<string>;
  verificar(phc: string, plano: string): Promise<boolean>;
  necesitaRehash(phc: string): boolean;
  readonly hashFicticio: string;
}

// `algorithm: 2` = Argon2id (el `const enum` de la librería no compila con isolatedModules).
const ARGON2ID = 2;
const PREFIJO_ARGON2ID = "$argon2id$";
const PATRON_PARAMETROS = /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/;

const libReal: LibArgon2 = { hash: argon2Hash, verify: argon2Verify };

/**
 * Una contraseña de más de 128 puntos de código nunca llega a la librería (DoS). Más de 256
 * unidades UTF-16 implican más de 128 puntos, así se evita recorrer cadenas enormes.
 */
function excedeMaximo(plano: string): boolean {
  if (plano.length > CONTRASENA_MAX_PUNTOS * 2) return true;
  return [...plano].length > CONTRASENA_MAX_PUNTOS;
}

export async function crearHasher(
  parametros: ParametrosArgon2,
  libreria: LibArgon2 = libReal,
): Promise<Hasher> {
  const opciones: OpcionesHashArgon2 = {
    algorithm: ARGON2ID,
    memoryCost: parametros.memoriaKib,
    timeCost: parametros.iteraciones,
    parallelism: parametros.paralelismo,
  };

  // D9: hash de una contraseña aleatoria que nadie conoce, con los parámetros vigentes.
  const hashFicticio = await libreria.hash(
    randomBytes(32).toString("hex"),
    opciones,
  );

  return {
    hashFicticio,

    async calcular(plano) {
      if (excedeMaximo(plano)) throw new ContrasenaInvalidaError("longitud");
      return libreria.hash(plano, opciones);
    },

    async verificar(phc, plano) {
      if (!phc.startsWith(PREFIJO_ARGON2ID) || excedeMaximo(plano))
        return false;
      try {
        return await libreria.verify(phc, plano);
      } catch {
        return false;
      }
    },

    necesitaRehash(phc) {
      const m = PATRON_PARAMETROS.exec(phc);
      if (m === null) return false;
      return (
        Number(m[1]) !== 19 ||
        Number(m[2]) < parametros.memoriaKib ||
        Number(m[3]) < parametros.iteraciones ||
        Number(m[4]) < parametros.paralelismo
      );
    },
  };
}
