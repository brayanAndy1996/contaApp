// Spec 028 · T8: correo «Avisos pendientes» (R-14, U-17): uno por tipo, para quien tiene el resumen apagado y avisos diferidos por el tope diario.
import {
  ETIQUETA_TIPO,
  MAX_CUERPO,
  diferidos as validarDiferidos,
  enlaces as validarEnlaces,
  envolverHtml,
  lineaDiferido,
  nombreEstudio,
  objeto,
  parrafoHtml,
  pieTexto,
  soloClaves,
  type CorreoArmado,
  type EnlacesCorreo,
  type TipoAvisoCorreo,
} from "./comun";
import { ErrorCorreo } from "./errores";

export interface EntradaCorreoPendientes {
  readonly estudio: string;
  /** Al menos uno, un solo elemento por tipo, con cantidad ≥ 1. */
  readonly diferidos: readonly { readonly tipo: TipoAvisoCorreo; readonly cantidad: number }[];
  readonly enlaces: EnlacesCorreo;
}

const INTRODUCCION = "Tienes avisos que no te enviamos al momento.";

/** Arma el asunto, el texto plano y el HTML de los avisos pendientes. Lanza ante una entrada fuera de contrato. */
export function armarCorreoPendientes(entrada: EntradaCorreoPendientes): CorreoArmado {
  const o = objeto(entrada, "entrada");
  soloClaves(o, ["estudio", "diferidos", "enlaces"], "entrada");
  const estudio = nombreEstudio(o["estudio"], MAX_CUERPO);
  const diferidos = validarDiferidos(o["diferidos"], 1);
  if (diferidos.length === 0) throw new ErrorCorreo("diferidos");
  const enlaces = validarEnlaces(o["enlaces"]);
  const titulo = "Avisos pendientes";
  const etiquetaPantalla = "Abrir en ContApp";
  const etiquetaBaja = "Dejar de recibir estos avisos";
  const unico = diferidos.length === 1 ? diferidos[0] : undefined;

  const textoPlano = [
    titulo,
    "",
    INTRODUCCION,
    "",
    ...diferidos.map((d) => `- ${lineaDiferido(d)}`),
    ...pieTexto(enlaces, etiquetaPantalla, etiquetaBaja, estudio),
  ].join("\n");

  const html = envolverHtml({
    titulo,
    filas: [parrafoHtml(INTRODUCCION), ...diferidos.map((d) => parrafoHtml(lineaDiferido(d)))],
    enlaces,
    etiquetaPantalla,
    etiquetaBaja,
    estudio,
  });

  return { asunto: unico === undefined ? titulo : `${titulo} · ${ETIQUETA_TIPO[unico.tipo]}`, texto: textoPlano, html };
}
