// Serialización del secreto en claro (D8): JSON canónico con orden fijo, cada campo de 1 a 256 B
// UTF-8 bien formado (sin sustitutos sueltos, sin normalizar) y total ≤ 1024 B.
import { SecretoInvalidoError } from "./errores";
import type { TipoCredencial, ValorDe } from "./sobre";

const CAMPOS: Record<TipoCredencial, readonly [string, string]> = {
  sol: ["usuario", "clave"],
  sire_api: ["clientId", "clientSecret"],
};
const MAX_CAMPO = 256;
const MAX_TOTAL = 1024;

function campoValido(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const bytes = Buffer.from(v, "utf8");
  // Un sustituto suelto se convierte en U+FFFD al codificar: la ida y vuelta lo delata.
  return (
    bytes.length >= 1 &&
    bytes.length <= MAX_CAMPO &&
    bytes.toString("utf8") === v
  );
}

/** Devuelve el JSON canónico en un búfer propio (el llamador lo pone a cero). */
export function serializarSecreto(tipo: TipoCredencial, valor: unknown): Buffer {
  const campos = CAMPOS[tipo];
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) {
    throw new SecretoInvalidoError();
  }
  const registro = valor as Record<string, unknown>;
  const claves = Object.keys(registro);
  if (
    claves.length !== 2 ||
    !campos.every((c) => claves.includes(c) && campoValido(registro[c]))
  ) {
    throw new SecretoInvalidoError();
  }
  const canonico = JSON.stringify({
    [campos[0]]: registro[campos[0]],
    [campos[1]]: registro[campos[1]],
  });
  const plano = Buffer.from(canonico, "utf8");
  if (plano.length > MAX_TOTAL) {
    plano.fill(0);
    throw new SecretoInvalidoError();
  }
  return plano;
}

/** Interpreta un plano; null si no es exactamente la forma canónica del tipo. */
export function parsearSecreto<T extends TipoCredencial>(
  tipo: T,
  plano: Buffer,
): ValorDe<T> | null {
  try {
    const valor: unknown = JSON.parse(plano.toString("utf8"));
    const re = serializarSecreto(tipo, valor);
    const igual = re.equals(plano);
    re.fill(0);
    return igual ? (valor as ValorDe<T>) : null;
  } catch {
    return null;
  }
}
