// Spec 028 · T8: resumen diario (R-13, D-5, D-6; CA-4, CA-7). La función ordena (críticos nuevos ↓, nuevos ↓, razón social con
// `localeCompare("es")`), muestra 50 clientes como máximo y agrega «y N clientes más». Sin RUC, sin asuntos ni contenido de mensajes.
import {
  MAX_ASUNTO,
  MAX_CUERPO,
  diaLegible,
  diferidos as validarDiferidos,
  enlaces as validarEnlaces,
  entero,
  envolverHtml,
  filaHtml,
  lineaDiferido,
  lista,
  nombreEstudio,
  objeto,
  parrafoHtml,
  periodoLegible,
  pieTexto,
  plural,
  soloClaves,
  texto,
  type CorreoArmado,
  type DiferidoCorreo,
  type EnlacesCorreo,
  type TipoAvisoCorreo,
} from "./comun";
import { ErrorCorreo } from "./errores";
import { escaparHtml, limpiarLinea, lineaUsuario } from "./texto";

/** Estado de un libro del periodo pendiente; un libro `generado` no es pendiente y llega como `null`. */
export type EstadoPendiente = "sin_descargar" | "abierto" | "revisado";

export interface ClienteResumen {
  readonly razonSocial: string;
  readonly nuevos: number;
  readonly criticosNuevos: number;
  readonly pendientesAtender: number;
  readonly compras: EstadoPendiente | null;
  readonly ventas: EstadoPendiente | null;
}

export interface EntradaCorreoResumen {
  readonly estudio: string;
  /** «AAAA-MM-DD» (lo que devuelve `diaLima`). */
  readonly dia: string;
  readonly clientes: readonly ClienteResumen[];
  /** Clientes que el llamador dejó fuera de `clientes`; se suman a los que pasen de 50. */
  readonly clientesMas: number;
  /** «AAAAMM» (lo que devuelve `periodoAnteriorLima`); se muestra «AAAA-MM». */
  readonly periodo: string;
  readonly diferidos: readonly { readonly tipo: TipoAvisoCorreo; readonly cantidad: number }[];
  readonly enlaces: EnlacesCorreo;
}

const MAX_CLIENTES = 50;
const ESTADOS: Readonly<Record<EstadoPendiente, string>> = { sin_descargar: "sin descargar", abierto: "abierto", revisado: "revisado" };

interface ClienteValido {
  readonly razon: string;
  readonly nuevos: number;
  readonly criticos: number;
  readonly pendientes: number;
  readonly compras: EstadoPendiente | null;
  readonly ventas: EstadoPendiente | null;
}

interface EntradaValida {
  readonly estudio: string;
  readonly dia: string;
  readonly periodo: string;
  readonly clientes: readonly ClienteValido[];
  readonly clientesMas: number;
  readonly diferidos: readonly DiferidoCorreo[];
  readonly enlaces: EnlacesCorreo;
}

function estado(v: unknown): EstadoPendiente | null {
  if (v === null) return null;
  if (typeof v !== "string" || !Object.hasOwn(ESTADOS, v)) throw new ErrorCorreo("clientes");
  return v as EstadoPendiente;
}

function validarCliente(v: unknown): ClienteValido {
  const o = objeto(v, "clientes");
  soloClaves(o, ["razonSocial", "nuevos", "criticosNuevos", "pendientesAtender", "compras", "ventas"], "clientes");
  return {
    razon: lineaUsuario(texto(o["razonSocial"], "clientes"), MAX_CUERPO) || "Cliente sin nombre",
    nuevos: entero(o["nuevos"], 0, "clientes"),
    criticos: entero(o["criticosNuevos"], 0, "clientes"),
    pendientes: entero(o["pendientesAtender"], 0, "clientes"),
    compras: estado(o["compras"]),
    ventas: estado(o["ventas"]),
  };
}

function validar(entrada: unknown): EntradaValida {
  const o = objeto(entrada, "entrada");
  soloClaves(o, ["estudio", "dia", "clientes", "clientesMas", "periodo", "diferidos", "enlaces"], "entrada");
  diaLegible(o["dia"]);
  periodoLegible(o["periodo"]);
  return {
    estudio: nombreEstudio(o["estudio"], MAX_CUERPO),
    dia: o["dia"] as string,
    periodo: o["periodo"] as string,
    clientes: lista(o["clientes"], "clientes").map(validarCliente),
    clientesMas: entero(o["clientesMas"], 0, "clientesMas"),
    diferidos: validarDiferidos(o["diferidos"], 0),
    enlaces: validarEnlaces(o["enlaces"]),
  };
}

function ordenar(clientes: readonly ClienteValido[]): ClienteValido[] {
  return [...clientes].sort((a, b) => b.criticos - a.criticos || b.nuevos - a.nuevos || a.razon.localeCompare(b.razon, "es"));
}

function lineaConteos(c: ClienteValido): string {
  return `${plural(c.nuevos, "nuevo", "nuevos")}, ${plural(c.criticos, "crítico", "críticos")}, ${plural(c.pendientes, "pendiente", "pendientes")} de atender`;
}

function lineaLibros(c: ClienteValido): string | null {
  const partes = [
    ...(c.compras === null ? [] : [`Compras: ${ESTADOS[c.compras]}`]),
    ...(c.ventas === null ? [] : [`Ventas: ${ESTADOS[c.ventas]}`]),
  ];
  return partes.length === 0 ? null : partes.join(" · ");
}

/** El resumen no se envía si no hay mensajes nuevos, periodos pendientes ni avisos diferidos (R-13, U-7). Los pendientes de atender solos no cuentan. */
export function resumenVacio(entrada: EntradaCorreoResumen): boolean {
  const v = validar(entrada);
  return (
    v.clientesMas === 0 &&
    v.diferidos.every((d) => d.cantidad === 0) &&
    v.clientes.every((c) => c.nuevos === 0 && c.compras === null && c.ventas === null)
  );
}

/** Arma el asunto, el texto plano y el HTML del resumen diario. Lanza ante una entrada fuera de contrato. */
export function armarCorreoResumen(entrada: EntradaCorreoResumen): CorreoArmado {
  const v = validar(entrada);
  const dia = diaLegible(v.dia);
  const periodo = periodoLegible(v.periodo);
  const ordenados = ordenar(v.clientes);
  const mostrados = ordenados.slice(0, MAX_CLIENTES);
  const omitidos = v.clientesMas + (ordenados.length - mostrados.length);
  const mas = omitidos > 0 ? `y ${plural(omitidos, "cliente", "clientes")} más` : null;
  const diferidos = v.diferidos.filter((d) => d.cantidad > 0);
  const titulo = `Resumen del ${dia}`;
  const encabezadoClientes = `Clientes · periodo ${periodo}`;
  const encabezadoDiferidos = "Avisos que no te enviamos al momento";
  const etiquetaPantalla = "Abrir en ContApp";
  const etiquetaBaja = "Dejar de recibir este resumen";

  const bloques = mostrados.map((c) => ({ razon: c.razon, lineas: [lineaConteos(c), ...(lineaLibros(c) === null ? [] : [lineaLibros(c) ?? ""])] }));

  const textoPlano = [
    titulo,
    ...(bloques.length === 0 && mas === null ? [] : ["", encabezadoClientes]),
    ...bloques.flatMap((b) => [`- ${b.razon}`, ...b.lineas.map((l) => `  ${l}`)]),
    ...(mas === null ? [] : [mas]),
    ...(diferidos.length === 0 ? [] : ["", encabezadoDiferidos, ...diferidos.map((d) => `- ${lineaDiferido(d)}`)]),
    ...pieTexto(v.enlaces, etiquetaPantalla, etiquetaBaja, v.estudio),
  ].join("\n");

  const html = envolverHtml({
    titulo,
    filas: [
      ...(bloques.length === 0 && mas === null ? [] : [filaHtml(`<strong>${escaparHtml(encabezadoClientes)}</strong>`)]),
      ...bloques.map((b) =>
        filaHtml([`<strong>${escaparHtml(b.razon)}</strong>`, ...b.lineas.map(escaparHtml)].join("<br>"), "border-top:1px solid #e5e7eb;"),
      ),
      ...(mas === null ? [] : [parrafoHtml(mas)]),
      ...(diferidos.length === 0
        ? []
        : [
            filaHtml(`<strong>${escaparHtml(encabezadoDiferidos)}</strong>`, "padding-top:16px;"),
            ...diferidos.map((d) => parrafoHtml(lineaDiferido(d))),
          ]),
    ],
    enlaces: v.enlaces,
    etiquetaPantalla,
    etiquetaBaja,
    estudio: v.estudio,
  });

  return { asunto: `Resumen diario · ${limpiarLinea(v.estudio, MAX_ASUNTO)} · ${dia}`, texto: textoPlano, html };
}
