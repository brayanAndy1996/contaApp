// Spec 028 · T8: correo de aviso inmediato (R-6, R-7, R-14; CA-7, CA-9). Hasta 20 líneas y «y N avisos más». Solo datos del contrato:
// nunca RUC, asunto ni contenido de los mensajes. Todo texto de usuario pasa por `limpiarLinea` y, en el HTML, por `escaparHtml`.
import {
  ETIQUETA_TIPO,
  MAX_ASUNTO,
  MAX_CUERPO,
  enlaces as validarEnlaces,
  entero,
  envolverHtml,
  filaHtml,
  lista,
  nombreEstudio,
  objeto,
  parrafoHtml,
  pieTexto,
  plural,
  soloClaves,
  texto,
  textoONulo,
  tipoAviso,
  type CorreoArmado,
  type EnlacesCorreo,
  type TipoAvisoCorreo,
} from "./comun";
import { ErrorCorreo } from "./errores";
import { fechaHoraLima } from "./tiempo";
import { escaparHtml, limpiarLinea } from "./texto";

/** Un aviso a listar. `categoria` y `recurso` llegan ya como texto para mostrar («Coactiva», «clientes»). */
export interface AvisoCorreo {
  readonly razonSocial: string | null;
  readonly categoria: string | null;
  readonly recurso?: string;
  readonly porcentaje?: number;
  readonly fecha: Date;
}

export interface EntradaCorreoAviso {
  readonly tipo: TipoAvisoCorreo;
  readonly estudio: string;
  /** Al menos uno; se listan los 20 primeros en el orden recibido. */
  readonly avisos: readonly AvisoCorreo[];
  /** Total de avisos del envío (≥ los recibidos); lo que pase de 20 sale como «y N avisos más». */
  readonly total: number;
  readonly enlaces: EnlacesCorreo;
}

const MAX_LINEAS = 20;
const SIN_NOMBRE = "Cliente sin nombre";

const PREFIJO_ASUNTO: Readonly<Record<Exclude<TipoAvisoCorreo, "plan_limite">, string>> = {
  buzon_critico: "Coactiva y avisos críticos del buzón",
  credencial_invalida: "Clave SOL inválida",
};

const INTRODUCCION: Readonly<Record<TipoAvisoCorreo, string>> = {
  buzon_critico: "Hay avisos críticos y coactivas nuevos en el buzón de tus clientes.",
  credencial_invalida: "No pudimos ingresar con la clave SOL de estos clientes.",
  plan_limite: "Tu estudio se acerca al límite de su plan.",
};

interface AvisoValido {
  readonly razon: string;
  readonly categoria: string;
  readonly recurso: string;
  readonly porcentaje: number | null;
  readonly fecha: string;
}

function validarAviso(v: unknown, tipo: TipoAvisoCorreo): AvisoValido {
  const o = objeto(v, "avisos");
  soloClaves(o, ["razonSocial", "categoria", "recurso", "porcentaje", "fecha"], "avisos");
  const razon = textoONulo(o["razonSocial"], "avisos");
  const categoria = textoONulo(o["categoria"], "avisos");
  const recurso = o["recurso"] === undefined ? "" : texto(o["recurso"], "avisos");
  const porcentaje = o["porcentaje"] === undefined ? null : entero(o["porcentaje"], 0, "avisos");
  if (porcentaje !== null && porcentaje > 100) throw new ErrorCorreo("avisos");
  if (tipo === "plan_limite" && porcentaje === null) throw new ErrorCorreo("avisos");
  return {
    razon: limpiarLinea(razon ?? "", MAX_CUERPO) || SIN_NOMBRE,
    categoria: limpiarLinea(categoria ?? "", MAX_CUERPO),
    recurso: limpiarLinea(recurso, MAX_CUERPO),
    porcentaje,
    fecha: fechaHoraLima(o["fecha"] as Date),
  };
}

function lineaAviso(a: AvisoValido, tipo: TipoAvisoCorreo): string {
  if (tipo === "plan_limite") return `${a.recurso || "Recursos del plan"}: ${a.porcentaje ?? 0} % del límite · ${a.fecha}`;
  return [a.razon, a.categoria, a.fecha].filter((p) => p !== "").join(" · ");
}

function asuntoAviso(tipo: TipoAvisoCorreo, listados: readonly AvisoValido[]): string {
  if (tipo === "plan_limite") {
    const mayor = listados.reduce((m, a) => ((a.porcentaje ?? 0) > (m.porcentaje ?? 0) ? a : m), listados[0] as AvisoValido);
    const recurso = limpiarLinea(mayor.recurso, MAX_ASUNTO) || "tu plan";
    return `Tu estudio llegó al ${mayor.porcentaje ?? 0} % de ${recurso}`;
  }
  const clientes = new Set(listados.map((a) => a.razon));
  const quien = clientes.size === 1 ? limpiarLinea(listados[0]?.razon ?? "", MAX_ASUNTO) : `${clientes.size} clientes`;
  return `${PREFIJO_ASUNTO[tipo]} · ${quien}`;
}

/** Arma el asunto, el texto plano y el HTML de un aviso inmediato. Lanza ante una entrada fuera de contrato. */
export function armarCorreoAviso(entrada: EntradaCorreoAviso): CorreoArmado {
  const o = objeto(entrada, "entrada");
  soloClaves(o, ["tipo", "estudio", "avisos", "total", "enlaces"], "entrada");
  const tipo = tipoAviso(o["tipo"], "tipo");
  const estudio = nombreEstudio(o["estudio"], MAX_CUERPO);
  const crudos = lista(o["avisos"], "avisos");
  if (crudos.length === 0) throw new ErrorCorreo("avisos");
  const total = entero(o["total"], 1, "total");
  if (total < crudos.length) throw new ErrorCorreo("total");
  const enlaces = validarEnlaces(o["enlaces"]);
  const validos = crudos.map((a) => validarAviso(a, tipo));

  const listados = validos.slice(0, MAX_LINEAS);
  const lineas = listados.map((a) => lineaAviso(a, tipo));
  const restantes = total > MAX_LINEAS ? total - MAX_LINEAS : 0;
  const mas = restantes > 0 ? `y ${plural(restantes, "aviso", "avisos")} más` : null;
  const titulo = ETIQUETA_TIPO[tipo];
  const etiquetaPantalla = "Abrir en ContApp";
  const etiquetaBaja = "Dejar de recibir estos avisos";

  const textoPlano = [
    titulo,
    "",
    INTRODUCCION[tipo],
    "",
    ...lineas.map((l) => `- ${l}`),
    ...(mas === null ? [] : [mas]),
    ...pieTexto(enlaces, etiquetaPantalla, etiquetaBaja, estudio),
  ].join("\n");

  const html = envolverHtml({
    titulo,
    filas: [
      parrafoHtml(INTRODUCCION[tipo]),
      ...lineas.map((l) => filaHtml(escaparHtml(l), "border-top:1px solid #e5e7eb;")),
      ...(mas === null ? [] : [parrafoHtml(mas)]),
    ],
    enlaces,
    etiquetaPantalla,
    etiquetaBaja,
    estudio,
  });

  return { asunto: asuntoAviso(tipo, listados), texto: textoPlano, html };
}
