// Registro versionado de formatos TXT (D5, D10, RNF-043; plan, Ratificación 5 y 11).
// `desde` valida, copia y congela; `seleccionarFormato` elige la versión con `vigenteDesde` <=
// periodo más reciente. La marca privada (`#formatos in o`) sigue el patrón de 010.
import { esEnteroPositivo } from "../texto/entero";
import { DefinicionFormatoInvalidaError, FormatoNoVigenteError } from "./errores";
import { FORMATO_PROVISIONAL_RCE } from "./provisional-rce";
import { FORMATO_PROVISIONAL_RVIE } from "./provisional-rve";
import { TIPOS_FIJOS, valorDeCampo } from "./valores";
import type { CampoTxt, Codificacion, FinDeLinea, FormatoTxt, FuncionNombre, Libro, TipoCampo } from "./tipos";

const PERIODO = /^[0-9]{4}(0[1-9]|1[0-2])$/;
const LIBROS: readonly string[] = Object.freeze(["compras", "ventas"] satisfies Libro[]);
/** Único campo de texto de la fila que puede ser `ruc`: el documento de la contraparte (012 D23, 013 D13). */
const DOCUMENTOS_CONTRAPARTE: readonly string[] = Object.freeze(["numeroDocProveedor", "docContraparte"]);
const CODIFICACIONES: readonly string[] = Object.freeze(["ascii", "latin1", "utf8"] satisfies Codificacion[]);
const FINES_DE_LINEA: readonly string[] = Object.freeze(["\r\n", "\n"] satisfies FinDeLinea[]);
const TIPOS: readonly string[] = Object.freeze(
  ["texto", "ruc", "fecha", "monto", "tc", "codigo"] satisfies TipoCampo[],
);
/** Separador: un carácter de U+0021-U+007E que no aparezca en montos, fechas ni TC. */
const SEPARADOR = /^[!-~]$/;
const SEPARADOR_PROHIBIDO = /^[A-Za-z0-9./-]$/;

// Clave de módulo: el constructor solo se invoca desde este archivo (como en 010).
const CLAVE = Symbol("RegistroFormatos");

let leerFormatos: (r: RegistroFormatos) => readonly FormatoTxt[];
let esRegistro: (o: object) => boolean;

export class RegistroFormatos {
  readonly #formatos: readonly FormatoTxt[];

  private constructor(clave: symbol, formatos: readonly FormatoTxt[]) {
    if (clave !== CLAVE) throw new TypeError("Constructor privado: usa RegistroFormatos.desde.");
    this.#formatos = formatos;
    Object.freeze(this);
  }

  /**
   * Valida y copia las definiciones. Lanza DefinicionFormatoInvalidaError ante cualquier
   * incoherencia (Ratificación 5) y también si dos versiones del mismo libro rigen desde el mismo
   * periodo: la elección no puede depender del orden de declaración (CA-9).
   */
  static desde(formatos: readonly FormatoTxt[]): RegistroFormatos {
    if (!Array.isArray(formatos)) throw new DefinicionFormatoInvalidaError();
    const total = formatos.length;
    const copias: FormatoTxt[] = [];
    const claves = new Set<string>();
    const vigencias = new Set<string>();
    for (let i = 0; i < total; i++) {
      const f = copiarFormato(formatos[i]);
      const clave = JSON.stringify([f.id, f.version]);
      const vigencia = JSON.stringify([f.libro, f.vigenteDesde]);
      if (claves.has(clave) || vigencias.has(vigencia)) throw new DefinicionFormatoInvalidaError();
      claves.add(clave);
      vigencias.add(vigencia);
      copias.push(f);
    }
    return new RegistroFormatos(CLAVE, Object.freeze(copias));
  }

  static {
    leerFormatos = (r) => r.#formatos;
    esRegistro = (o) => #formatos in o;
  }
}
Object.freeze(RegistroFormatos);
Object.freeze(RegistroFormatos.prototype);

/** Hoy los provisionales RCE (compras) y RVIE (ventas), ambos `oficial: false` y vigentes desde 202601. */
export const REGISTRO_FORMATOS: RegistroFormatos = RegistroFormatos.desde([FORMATO_PROVISIONAL_RCE, FORMATO_PROVISIONAL_RVIE]);

/**
 * Versión de `libro` con `vigenteDesde` <= `periodo` más reciente (D5). Lanza FormatoNoVigenteError
 * si el periodo es anterior a toda versión, el libro no tiene formatos o el periodo no es AAAAMM.
 */
export function seleccionarFormato(libro: Libro, periodo: string, registro: RegistroFormatos = REGISTRO_FORMATOS): FormatoTxt {
  if (typeof registro !== "object" || registro === null || !esRegistro(registro)) {
    throw new DefinicionFormatoInvalidaError();
  }
  if (typeof periodo !== "string" || !PERIODO.test(periodo)) throw new FormatoNoVigenteError();
  let elegido: FormatoTxt | null = null;
  for (const f of leerFormatos(registro)) {
    if (f.libro === libro && f.vigenteDesde <= periodo && (elegido === null || f.vigenteDesde > elegido.vigenteDesde)) {
      elegido = f;
    }
  }
  if (elegido === null) throw new FormatoNoVigenteError();
  return elegido;
}

/** Lee cada propiedad una vez, valida y devuelve una copia congelada. */
function copiarFormato(entrada: unknown): FormatoTxt {
  if (typeof entrada !== "object" || entrada === null) throw new DefinicionFormatoInvalidaError();
  const f = entrada as Record<string, unknown>;
  const id = f.id;
  const libro = f.libro;
  const version = f.version;
  const vigenteDesde = f.vigenteDesde;
  const oficial = f.oficial;
  const codificacion = f.codificacion;
  const separador = f.separador;
  const finDeLinea = f.finDeLinea;
  const campos = f.campos;
  const incluyeExcluidas = f.incluyeExcluidas;
  const nombre = f.nombre;
  if (
    !esTextoNoVacio(id) ||
    !esTextoNoVacio(version) ||
    !esUno(libro, LIBROS) ||
    typeof vigenteDesde !== "string" ||
    !PERIODO.test(vigenteDesde) ||
    typeof oficial !== "boolean" ||
    typeof incluyeExcluidas !== "boolean" ||
    typeof nombre !== "function" ||
    !esUno(codificacion, CODIFICACIONES) ||
    !esUno(finDeLinea, FINES_DE_LINEA) ||
    typeof separador !== "string" ||
    !SEPARADOR.test(separador) ||
    SEPARADOR_PROHIBIDO.test(separador)
  ) {
    throw new DefinicionFormatoInvalidaError();
  }
  return Object.freeze({
    id,
    libro: libro as Libro,
    version,
    vigenteDesde,
    oficial,
    codificacion: codificacion as Codificacion,
    separador,
    finDeLinea: finDeLinea as FinDeLinea,
    campos: copiarCampos(campos, separador, libro as Libro),
    incluyeExcluidas,
    nombre: nombre as FuncionNombre,
  });
}

function copiarCampos(entrada: unknown, separador: string, libro: Libro): readonly CampoTxt[] {
  if (!Array.isArray(entrada) || entrada.length === 0) throw new DefinicionFormatoInvalidaError();
  const total = entrada.length;
  const nombres = new Set<string>();
  const copias: CampoTxt[] = [];
  for (let i = 0; i < total; i++) {
    const c = copiarCampo(entrada[i], separador, libro);
    if (nombres.has(c.nombre)) throw new DefinicionFormatoInvalidaError();
    nombres.add(c.nombre);
    copias.push(c);
  }
  return Object.freeze(copias);
}

function copiarCampo(entrada: unknown, separador: string, libro: Libro): CampoTxt {
  if (typeof entrada !== "object" || entrada === null) throw new DefinicionFormatoInvalidaError();
  const c = entrada as Record<string, unknown>;
  const nombre = c.nombre;
  const obligatorio = c.obligatorio;
  const longitudMax = c.longitudMax;
  const tipo = c.tipo;
  // Solo el patrón propio: uno heredado (p. ej. de Object.prototype) no entra en la copia (H-012-25).
  const patron = Object.hasOwn(c, "patron") ? c.patron : undefined;
  if (
    !esTextoNoVacio(nombre) ||
    typeof obligatorio !== "boolean" ||
    !esEnteroPositivo(longitudMax) ||
    !esUno(tipo, TIPOS)
  ) {
    throw new DefinicionFormatoInvalidaError();
  }
  // Solo campos que generarTxt sabe escribir: así «apto» siempre quiere decir «genera» (D21, H-012-24).
  valorDeCampo(nombre, libro);
  // Solo el documento de la contraparte puede ser `ruc`: en la serie, el número o la razón social haría
  // fallar toda fila con un error que nadie puede corregir (012 D23, 013 D13).
  if (tipo === "ruc" && !DOCUMENTOS_CONTRAPARTE.includes(nombre)) throw new DefinicionFormatoInvalidaError();
  // Un campo de valor fijo solo admite el tipo de ese valor (H-012-61).
  const fijo = TIPOS_FIJOS.get(nombre);
  if (fijo !== undefined && fijo !== tipo) throw new DefinicionFormatoInvalidaError();
  const base = { nombre, obligatorio, longitudMax, tipo: tipo as TipoCampo };
  if (patron === undefined) return Object.freeze(base);
  if (!(patron instanceof RegExp)) throw new DefinicionFormatoInvalidaError();
  const fuente = patron.source;
  const banderas = patron.flags;
  if (banderas.includes("g") || banderas.includes("y") || new RegExp(fuente, banderas).test(separador)) {
    throw new DefinicionFormatoInvalidaError();
  }
  // Un getter que da una RegExp nueva en cada lectura: mutar la que se obtuvo (p. ej. con
  // `compile`) no cambia el campo registrado.
  return Object.freeze(
    Object.defineProperty(base, "patron", { enumerable: true, get: () => new RegExp(fuente, banderas) }),
  );
}

function esTextoNoVacio(x: unknown): x is string {
  return typeof x === "string" && x.length > 0;
}

function esUno(x: unknown, lista: readonly string[]): boolean {
  return typeof x === "string" && lista.includes(x);
}
