// La única composición del previo (spec 012b, D1, D2, D12, P-6; plan, Contratos: Dominio): la usan el
// backend (previo y `POST`) y el worker, así que lo que se ve es lo que se genera y la huella lo verifica.
// Lee la entrada una sola vez a copias congeladas y sobre ellas prevalida, resume y arma el canon.
import { analizarCorrelatividad } from "../correlatividad/index";
import type { Faltante, Justificado } from "../correlatividad/index";
import { seleccionarFormato } from "../formatos/registro";
import type { CabeceraTxt } from "../formatos/tipos";
import { invalida, leerArreglo, leerCabecera, leerFilas, leerFilasVenta, leerObjeto } from "../prevalidacion/entrada";
import type { FilaVentaCopia } from "../prevalidacion/entrada";
import type { ResultadoPrevalidacion } from "../prevalidacion/index";
import { prevalidarCopia } from "../prevalidacion/prevalidar";
import { resumirCopias, resumirCopiasVentas } from "../prevalidacion/resumen";
import type { ContextoReglas } from "../reglas/index";
import { canonDeCopias } from "./huella";
import type { ArchivoPreparado, AvisoArchivo, EntradaPrepararCompras, EntradaPrepararVentas, MotivoNoGenerable } from "./tipos";

const CLAVES = ["libro", "cabecera", "original", "vigente", "reglas", "saltos", "permitirProvisional"];
const REQUERIDAS = ["libro", "cabecera", "original", "vigente", "permitirProvisional"];

// ---------------------------------------------------------------- saltos de correlatividad (ventas, 013 D7)
/** Justificaciones leídas una vez; `desde` y `hasta` no enteros los descarta analizarCorrelatividad. */
function leerSaltos(o: unknown): Justificado[] {
  if (o === undefined) return [];
  return leerArreglo(o).map((j) => {
    if (typeof j !== "object" || j === null) invalida();
    const { tipo, serie, desde, hasta, comentario } = j as Record<string, unknown>;
    if (typeof tipo !== "string" || typeof serie !== "string") invalida();
    return { tipo, serie, desde, hasta, comentario: typeof comentario === "string" ? comentario : "" } as Justificado;
  });
}

function falta(serie: string, f: Faltante): string {
  return f.desde === f.hasta ? `Falta ${serie}-${f.desde}` : `Faltan ${serie}-${f.desde} a ${serie}-${f.hasta}`;
}

/**
 * Un aviso SALTO_CORRELATIVIDAD por hueco no justificado del todo (pendiente o parcial). Todas las filas
 * vigentes cuentan como presentes: también las agregadas y las excluidas. Nunca bloquea.
 */
function avisosDeSaltos(vigente: readonly FilaVentaCopia[], saltos: readonly Justificado[]): AvisoArchivo[] {
  const numeracion = vigente.map((f) => ({ tipo: f.comprobante.tipo, serie: f.comprobante.serie, numero: f.comprobante.numero }));
  const avisos: AvisoArchivo[] = [];
  for (const s of analizarCorrelatividad(numeracion, saltos).series) {
    for (const f of s.faltantes) {
      if (f.estado === "justificado") continue;
      avisos.push(Object.freeze({ codigo: "SALTO_CORRELATIVIDAD", filaId: null, explicacion: falta(s.serie, f) }));
    }
  }
  return avisos;
}

// ---------------------------------------------------------------- composición
function generabilidad(
  resultado: ResultadoPrevalidacion,
  permitirProvisional: boolean,
): { generable: boolean; motivo: MotivoNoGenerable | null } {
  if (!resultado.apto) return { generable: false, motivo: "prevalidacion_fallida" };
  if (!resultado.formato.oficial && !permitirProvisional) return { generable: false, motivo: "formato_no_oficial" };
  return { generable: true, motivo: null };
}

function prepararCompras(
  cabecera: CabeceraTxt,
  v: Map<string, unknown>,
): Omit<ArchivoPreparado, "generable" | "motivo"> {
  const reglas = v.get("reglas");
  if (reglas === null) invalida();
  const original = leerFilas(v.get("original"));
  const vigente = leerFilas(v.get("vigente"));
  const formato = seleccionarFormato(cabecera.libro, cabecera.periodo);
  const { resultado } = prevalidarCopia(vigente, cabecera, formato, reglas === undefined ? null : (reglas as ContextoReglas));
  const resumen = resumirCopias(original, vigente);
  const avisos = resultado.avisos.map((a): AvisoArchivo => Object.freeze({ codigo: a.codigo, filaId: a.filaId, explicacion: a.explicacion }));
  return { resultado, resumen, avisos, canon: canonDeCopias(cabecera, resultado.formato, original, vigente) };
}

function prepararVentas(
  cabecera: CabeceraTxt,
  v: Map<string, unknown>,
): Omit<ArchivoPreparado, "generable" | "motivo"> {
  const saltos = leerSaltos(v.get("saltos"));
  const original = leerFilasVenta(v.get("original"));
  const vigente = leerFilasVenta(v.get("vigente"));
  const formato = seleccionarFormato(cabecera.libro, cabecera.periodo);
  const { resultado } = prevalidarCopia(vigente, cabecera, formato, null);
  const resumen = resumirCopiasVentas(original, vigente);
  const avisos = avisosDeSaltos(vigente, saltos);
  return { resultado, resumen, avisos, canon: canonDeCopias(cabecera, resultado.formato, original, vigente) };
}

/**
 * Previo del periodo: `resultado` = prevalidar de la vigente, `resumen` = resumirCambios del libro,
 * `avisos` (R-ISC/R-NEW/R-GP en compras con `reglas`; SALTO_CORRELATIVIDAD en ventas), `generable`
 * (apto y formato oficial o `permitirProvisional`), su `motivo` y el `canon` de la huella. `libro` debe
 * ser el de la cabecera y las filas, de ese libro; ventas no lleva `reglas` ni compras `saltos`. Forma
 * imposible → EntradaPrevalidacionInvalidaError. Pura; no muta la entrada.
 */
export function prepararArchivo(e: EntradaPrepararCompras | EntradaPrepararVentas): ArchivoPreparado {
  const v = leerObjeto(e, CLAVES, REQUERIDAS);
  const cabecera = leerCabecera(v.get("cabecera"));
  const permitirProvisional = v.get("permitirProvisional");
  if (v.get("libro") !== cabecera.libro || typeof permitirProvisional !== "boolean") invalida();
  // Ventas no lleva `reglas` (sin 011) y compras no lleva `saltos` (su correlatividad no se mira).
  if (v.has(cabecera.libro === "ventas" ? "reglas" : "saltos")) invalida();
  const parte = cabecera.libro === "ventas" ? prepararVentas(cabecera, v) : prepararCompras(cabecera, v);
  return Object.freeze({ ...parte, avisos: Object.freeze(parte.avisos), ...generabilidad(parte.resultado, permitirProvisional) });
}
