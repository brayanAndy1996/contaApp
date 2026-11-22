// Errores del dominio de la prorrata (spec 026). Mensajes fijos: nunca incluyen el valor recibido
// (D-6, D-7). Internos de packages/domain: quien llama valida antes con los esquemas de `shared`,
// así que un error aquí es un defecto de programación, no una entrada del usuario.

export type CodigoErrorProrrata =
  | "PERIODO_INVALIDO"
  | "ENTRADA_INVALIDA"
  | "FUERA_DE_DOMINIO"
  | "PRORRATA_USADA_INVALIDA";

const MENSAJES: Readonly<Record<CodigoErrorProrrata, string>> = {
  PERIODO_INVALIDO: "Periodo inválido: se espera AAAAMM con mes 01 a 12.",
  ENTRADA_INVALIDA: "Entrada de prorrata inválida.",
  FUERA_DE_DOMINIO: "El porcentaje solo se calcula con 0 ≤ numerador ≤ total y total > 0.",
  PRORRATA_USADA_INVALIDA: "Prorrata usada inválida: se espera 0 a 100 con hasta 2 decimales.",
};

export class ProrrataError extends Error {
  readonly codigo: CodigoErrorProrrata;

  constructor(codigo: CodigoErrorProrrata) {
    super(MENSAJES[codigo]);
    this.name = "ProrrataError";
    this.codigo = codigo;
  }
}
