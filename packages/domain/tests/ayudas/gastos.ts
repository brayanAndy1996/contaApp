// Ayudas de la spec 027 (T1, rojo): semilla del diccionario global (plan, «Semilla del diccionario global»), contexto de gastos y
// entradas del puntaje. Solo construyen datos con la API pública; no es producción. Los valores de runtime salen del índice del
// paquete: mientras `crearDiccionarioEfectivo` no exista, cualquier prueba que lo use falla por export ausente.
import { DiccionarioGlosas, crearDiccionarioEfectivo } from "../../src/index";
import type { DocProveedor } from "../../src/index";
import type { ContextoGastos } from "../../src/gastos/contexto";

export const PROV: DocProveedor = { tipo: "6", numero: "20700000070" };
export const OTRO_PROV: DocProveedor = { tipo: "6", numero: "20700000045" };
/** Proveedor por defecto de `tests/ayudas/filas-motor.ts` (las pruebas de la R-GP completa pasan por `evaluarReglas`). */
export const PROV_MOTOR: DocProveedor = { tipo: "6", numero: "20100000001" };

export interface PalabraPlana {
  readonly palabra: string;
  readonly categoria: string;
  readonly excepciones: readonly string[];
  readonly activa: boolean;
}

const p = (categoria: string, palabra: string, ...excepciones: string[]): PalabraPlana => ({
  palabra,
  categoria,
  excepciones,
  activa: true,
});

/** La semilla del plan (0069), normalizada. */
export const SEMILLA_GLOBAL: readonly PalabraPlana[] = [
  p("calzado-ropa", "zapatilla", "seguridad", "punta de acero"),
  p("calzado-ropa", "zapato", "seguridad", "punta de acero"),
  p("calzado-ropa", "sandalia"),
  p("calzado-ropa", "bota", "seguridad", "jebe", "punta de acero"),
  p("calzado-ropa", "polo", "a tierra"),
  p("calzado-ropa", "polera"),
  p("calzado-ropa", "casaca", "seguridad", "reflectiva"),
  p("calzado-ropa", "blusa"),
  p("calzado-ropa", "vestido"),
  p("calzado-ropa", "falda"),
  p("calzado-ropa", "pantalon"),
  p("calzado-ropa", "jean"),
  p("calzado-ropa", "camisa"),
  p("calzado-ropa", "chompa"),
  p("calzado-ropa", "pijama"),
  ...["juguete", "peluche", "muneca", "lego", "rompecabeza", "pelota", "triciclo", "patineta", "trompo", "sonajero"].map((w) =>
    p("juguetes", w),
  ),
  ...["videojuego", "cine", "concierto", "playstation", "nintendo", "xbox", "netflix", "spotify", "karaoke", "teatro", "boliche"].map(
    (w) => p("entretenimiento", w),
  ),
  ...["golosina", "chocolate", "helado", "cerveza", "vino", "whisky", "pisco", "ron", "vodka", "licor", "cigarro", "cigarrillo", "snack", "caramelo"].map(
    (w) => p("alimentos-personales", w),
  ),
  ...["perfume", "colonia", "maquillaje", "labial", "shampoo", "champu", "acondicionador", "desodorante", "rimel", "afeitadora", "depiladora", "cosmetico"].map(
    (w) => p("cuidado-personal", w),
  ),
  p("utiles-escolares", "lonchera"),
  p("utiles-escolares", "mochila", "fumigadora"),
  ...["plastilina", "crayola", "crayon", "tempera", "acuarela", "escolar", "cartuchera", "papelote"].map((w) =>
    p("utiles-escolares", w),
  ),
];

/** La semilla como entradas de `DiccionarioGlosas.desde` (una palabra por entrada, con sus excepciones). */
export function entradasSemilla(): { categoria: string; palabras: string[]; excepciones: string[] }[] {
  return SEMILLA_GLOBAL.map((x) => ({ categoria: x.categoria, palabras: [x.palabra], excepciones: [...x.excepciones] }));
}

export function diccionarioSemilla(propias: readonly PalabraPlana[] = []): DiccionarioGlosas {
  return crearDiccionarioEfectivo({ globales: SEMILLA_GLOBAL, desactivadas: [], propias });
}

export interface EntradaPuntaje {
  glosas: readonly string[];
  fechaEmision: string | null;
  proveedor: DocProveedor;
  esNuevo: boolean;
}

/** CA-1: «ZAPATILLA URBANA T42» emitida un miércoles por un proveedor conocido. */
export function entrada(over: Partial<EntradaPuntaje> = {}): EntradaPuntaje {
  return {
    glosas: ["ZAPATILLA URBANA T42"],
    fechaEmision: FECHA_HABIL,
    proveedor: { ...PROV },
    esNuevo: false,
    ...over,
  };
}

export interface ContextoPlano {
  diccionario: DiccionarioGlosas;
  umbral: number;
  ciiuCliente: string | null;
  ciiuProveedores: { proveedor: DocProveedor; ciiu: string | null }[];
  categoriasCliente: { permitidas: string[]; quitadas: string[] };
  historial: { proveedor: DocProveedor; aceptadas6: number; excluidas6: number; excluidas12: number }[];
}

/** CA-1: cliente ferretería (4752), proveedor de ropa (4771), sin ajuste ni historial, umbral 3, semilla global. */
export function contextoGastos(over: Partial<ContextoPlano> = {}): ContextoGastos {
  const base: ContextoPlano = {
    diccionario: diccionarioSemilla(),
    umbral: 3,
    ciiuCliente: "4752",
    ciiuProveedores: [{ proveedor: { ...PROV }, ciiu: "4771" }],
    categoriasCliente: { permitidas: [], quitadas: [] },
    historial: [],
  };
  return { ...base, ...over } as ContextoGastos;
}

/** Contexto sin CIIU ni ajuste ni historial: solo puede puntuar S1 (y S5 si la entrada es nueva). */
export function contextoNeutro(over: Partial<ContextoPlano> = {}): ContextoGastos {
  return contextoGastos({ ciiuCliente: null, ciiuProveedores: [], ...over });
}

export const FECHA_HABIL = "2026-03-11"; // miércoles
export const FECHA_SABADO = "2026-03-14";
export const FECHA_DOMINGO = "2026-03-15";
export const FECHA_FERIADO = "2026-07-28"; // martes, Fiestas Patrias

/** Congela en profundidad (el diccionario es una instancia con campo privado: se congela igual). */
export function congelar<T>(o: T): T {
  if (typeof o === "object" && o !== null && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) congelar(v);
  }
  return o;
}
