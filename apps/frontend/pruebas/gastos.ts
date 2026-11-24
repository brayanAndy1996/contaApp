import { CLIENTE_ID, PERIODO, uuidDe } from "./compras";

// Soporte de las pruebas de 027 · gastos no deducibles (T7, rojo). Es el CONTRATO que fija el frontend para T13:
//  - Textos visibles (`MENSAJES_GASTOS`): T13 los define en `lib/gastos.ts` con estos mismos textos (como 025 con
//    `pruebas/aprendizaje.ts` y 026 con `pruebas/prorrata.ts`).
//  - Rutas del plan 027 (Contratos: HTTP), bajo `/api`.
//  - Datos de prueba como objetos planos con la forma de las vistas de `shared` (fijadas por T2 en
//    `packages/shared/src/gastos/vistas-027.spec.ts` y `compras/respuestas-027.spec.ts`). No importan esquemas nuevos de
//    `@contapp/shared` para que estas pruebas no dependan del orden de T9.
// Los montos que aparecen (ítems del XML en la lupa) usan el formato de miles de 026 (`conMiles`: «1,250.50»).
// Solo datos de prueba; las glosas, nombres y términos hostiles son de ejemplo.

export { CLIENTE_ID, PERIODO };

export const CATEGORIAS = [
  "calzado-ropa",
  "juguetes",
  "entretenimiento",
  "alimentos-personales",
  "cuidado-personal",
  "utiles-escolares",
] as const;
export type CategoriaPrueba = (typeof CATEGORIAS)[number];

/** Texto de cada categoría en las listas y combos (el `value` de cada opción es el código). */
export const ETIQUETA_CATEGORIA: Record<CategoriaPrueba, string> = {
  "calzado-ropa": "Calzado y ropa",
  juguetes: "Juguetes",
  entretenimiento: "Entretenimiento",
  "alimentos-personales": "Alimentos y bebidas personales",
  "cuidado-personal": "Cuidado personal",
  "utiles-escolares": "Útiles escolares",
};

// ---------------------------------------------------------------------------------------------
// Rutas (clave del fetch simulado: «METODO /ruta»)
// ---------------------------------------------------------------------------------------------

export const BASE_GASTOS = "/api/estudio/reglas-motor/gastos";
export const RUTA_GASTOS = `GET ${BASE_GASTOS}`;
export const RUTA_UMBRAL = `PUT ${BASE_GASTOS}/umbral`;
export const RUTA_AGREGAR_PALABRA = `POST ${BASE_GASTOS}/palabras`;
export const rutaPalabra = (id: string) => `PUT ${BASE_GASTOS}/palabras/${id}`;
export const rutaGlobal = (id: string) => `PUT ${BASE_GASTOS}/globales/${id}`;

export const BASE_CATEGORIAS = `/api/clientes/${CLIENTE_ID}/gastos/categorias`;
export const RUTA_CATEGORIAS = `GET ${BASE_CATEGORIAS}`;
export const RUTA_FIJAR_CATEGORIAS = `PUT ${BASE_CATEGORIAS}`;

const BASE_PERIODO = `/api/clientes/${CLIENTE_ID}/periodos/${PERIODO}/gastos`;
export const rutaPropuesta = (compraId: string) => `GET ${BASE_PERIODO}/aprender/${compraId}`;
export const rutaAprender = (compraId: string) => `POST ${BASE_PERIODO}/aprender/${compraId}`;
export const RUTA_REEVALUAR = `POST ${BASE_PERIODO}/reevaluar`;
export const TIPO_TRABAJO_REEVALUAR = "compras.reevaluar";
export const TRABAJO_REEVALUAR_ID = uuidDe(27, 900);

export const RUTA_PLATAFORMA_YO = "GET /api/plataforma/yo";
export const BASE_DICCIONARIO = "/api/plataforma/diccionario";
export const RUTA_DICCIONARIO = `GET ${BASE_DICCIONARIO}`;
export const RUTA_AGREGAR_GLOBAL = `POST ${BASE_DICCIONARIO}`;
export const rutaEditarGlobal = (id: string) => `PUT ${BASE_DICCIONARIO}/${id}`;
export const RUTA_HISTORIAL_GLOBAL = `GET ${BASE_DICCIONARIO}/historial`;

// ---------------------------------------------------------------------------------------------
// Textos visibles
// ---------------------------------------------------------------------------------------------

export const MENSAJES_GASTOS = {
  // Sección «Gastos no deducibles» de «Reglas del motor» (R-4, R-11, D-3).
  tituloSeccion: "Gastos no deducibles",
  soloLectura: "Solo un Dueño o Administrador con alcance global puede cambiar el diccionario y el umbral del estudio.",
  sinPermiso: "No tienes permiso para realizar esta acción.",
  errorCarga: "No se pudo cargar el diccionario. Inténtalo de nuevo.",

  // Umbral (R-11, CA-10).
  campoUmbral: "Umbral de sospecha",
  guardarUmbral: "Guardar umbral",
  umbralInvalido: "El umbral debe ser un número entero de 1 a 20.",
  umbralGuardado: "Umbral guardado.",

  // Palabras globales (con «Desactivar/Reactivar para el estudio»).
  tituloGlobales: "Palabras globales",
  desactivarGlobal: (palabra: string) => `Desactivar «${palabra}» para el estudio`,
  reactivarGlobal: (palabra: string) => `Reactivar «${palabra}» para el estudio`,
  globalDesactivada: "Desactivada para el estudio",
  globalCambiada: (palabra: string, activa: boolean) =>
    activa ? `«${palabra}» reactivada para el estudio.` : `«${palabra}» desactivada para el estudio.`,

  // Palabras propias: origen, autor y contador «n de 2.000».
  tituloPropias: "Palabras del estudio",
  sinPropias: "El estudio aún no tiene palabras propias.",
  contador: (n: number) => `${n} de 2.000`,
  origen: { manual: "Manual", aprendida: "Aprendida" },
  autorDe: (nombre: string) => `Por ${nombre}`,
  desactivarPropia: (palabra: string) => `Desactivar «${palabra}»`,
  reactivarPropia: (palabra: string) => `Reactivar «${palabra}»`,
  propiaInactiva: "Inactiva",
  propiaCambiada: (palabra: string, activa: boolean) =>
    activa ? `«${palabra}» reactivada.` : `«${palabra}» desactivada.`,

  // Agregar palabra (Dialog) con excepciones.
  agregarPalabra: "Agregar palabra",
  campoPalabra: "Palabra",
  campoCategoria: "Categoría",
  campoExcepciones: "Excepciones (separadas por coma)",
  guardarPalabra: "Guardar palabra",
  cancelar: "Cancelar",
  palabraAgregada: "Palabra agregada.",
  palabraInvalida: "La palabra debe ser una sola palabra de 3 a 40 letras o números.",
  excepcionesInvalidas: "Hasta 5 excepciones de 1 a 3 palabras cada una.",
  categoriaRequerida: "Elige una categoría.",

  // Búsqueda.
  campoBuscar: "Buscar palabra",
  sinCoincidencias: "Ninguna palabra coincide.",

  // Errores del servidor en español (códigos nuevos de 027 + los reutilizados).
  errores: {
    version_cambiada: "Otra persona cambió esto mientras tanto. Se recargaron los datos; revísalos e inténtalo de nuevo.",
    palabra_existente: "Esa palabra ya existe en el diccionario.",
    limite_palabras: "El estudio alcanzó el límite de 2.000 palabras propias activas.",
    compra_no_excluida: "La compra ya no está excluida.",
    compra_sin_xml: "La compra no tiene XML para aprender palabras.",
    periodo_no_abierto: "Solo se puede volver a evaluar un periodo abierto.",
    cliente_archivado: "El cliente está archivado: no se puede modificar.",
    solicitud_invalida: "Revisa los datos e inténtalo de nuevo.",
  },

  // Categorías permitidas del cliente (R-13, D-6).
  tituloCategorias: "Categorías permitidas",
  giroDe: (ciiu: string, seccion: string) => `Giro del cliente: CIIU ${ciiu} · sección ${seccion}`,
  sinCiiu: "El cliente no tiene CIIU registrado: solo cuentan las categorías que quites.",
  sinBase: "Su sección CIIU no permite ninguna categoría por defecto.",
  guardarCategorias: "Guardar categorías",
  categoriasGuardadas: "Categorías guardadas.",
  categoriasSoloLectura: "No tienes permiso para cambiar las categorías de este cliente.",

  // Chip y lupa (D-1, R-3).
  chipSinPuntaje: "Posible gasto no deducible",
  chip: (puntaje: number) => `Posible gasto no deducible · ${puntaje} puntos`,
  listaSenales: "Señales del puntaje",
  puntajeTotal: (puntaje: number) => `Puntaje: ${puntaje}`,
  puntos: (n: number) => (n > 0 ? `+${n}` : `${n}`),
  senales: {
    S1: (palabra: string, coinciden: number, total: number) => `Palabra clave: ${palabra} (${coinciden} de ${total} ítems)`,
    S2: "Rubro del proveedor no relacionado con el giro del cliente",
    S3: (categoria: string) => `Categoría no permitida para el giro: ${categoria}`,
    S4: "Emitida en fin de semana o feriado por un comercio minorista o restaurante",
    S5: "Proveedor nuevo para el cliente",
    S6: "El proveedor tiene 2 o más compras excluidas en los últimos 12 periodos",
    S7: "El proveedor tiene 3 o más compras aceptadas en los últimos 6 periodos",
  },

  // «Aprender estas palabras» (R-7, CA-9).
  tituloAprender: "Aprender estas palabras",
  introAprender: "Elige las palabras que el sistema debe marcar en próximas compras y su categoría.",
  incluirTermino: (i: number) => `Incluir el término ${i}`,
  campoTermino: (i: number) => `Término ${i}`,
  campoCategoriaTermino: (i: number) => `Categoría del término ${i}`,
  elegirCategoria: "Elige una categoría",
  aprender: "Aprender palabras",
  ahoraNo: "Ahora no",
  cerrar: "Cerrar",
  ningunaMarcada: "Marca al menos una palabra.",
  categoriaObligatoria: "Elige una categoría para cada palabra marcada.",
  terminoInvalido: "Cada término debe ser una sola palabra de 3 a 40 letras o números.",
  aprendidas: (palabras: readonly string[]) => `Palabras aprendidas: ${palabras.join(", ")}.`,
  omitidas: (palabras: readonly string[]) => `Ya existían y se omitieron: ${palabras.join(", ")}.`,

  // Volver a evaluar (R-12, CA-12).
  volverAEvaluar: "Volver a evaluar",
  reevaluando: "Volviendo a evaluar las compras del periodo…",
  reevaluada: "Compras evaluadas de nuevo.",
  reevaluarFallida: "No se pudo volver a evaluar el periodo. Inténtalo de nuevo.",

  // Super-admin: diccionario global e historial (D-2).
  tituloDiccionarioGlobal: "Diccionario global",
  sinGlobales: "Aún no hay palabras globales.",
  agregarGlobal: "Agregar palabra global",
  editarGlobal: (palabra: string) => `Editar «${palabra}»`,
  desactivarDiccionario: (palabra: string) => `Desactivar «${palabra}» en el diccionario global`,
  activarDiccionario: (palabra: string) => `Activar «${palabra}» en el diccionario global`,
  guardarCambios: "Guardar cambios",
  globalAgregada: "Palabra global agregada.",
  globalGuardada: "Palabra global guardada.",
  activa: "Activa",
  inactiva: "Inactiva",
  tituloHistorial: "Historial de cambios",
  sinHistorial: "Aún no hay cambios registrados.",
  accion: { agregada: "Agregada", editada: "Editada" },
  verMas: "Ver más",
} as const;

// ---------------------------------------------------------------------------------------------
// Datos (formas de `gastosEstudioVistaSchema`, `categoriasClienteVistaSchema`, etc.)
// ---------------------------------------------------------------------------------------------

export const AUTOR_ROSA = { id: uuidDe(5, 1), nombre: "Rosa Quispe", activo: true };
export const AHORA_ISO = "2026-11-20T15:00:00.000Z";

export const G_ZAPATILLA = uuidDe(27, 1);
export const G_POLO = uuidDe(27, 2);
export const G_JUGUETE = uuidDe(27, 3);
export const P_AUDIFONOS = uuidDe(27, 11);
export const P_MOCHILA = uuidDe(27, 12);
export const P_PERFUME = uuidDe(27, 13);
export const COMPRA_ORIGEN = uuidDe(1, 5070);

export interface GlobalEstudioPrueba {
  id: string;
  palabra: string;
  categoria: CategoriaPrueba;
  excepciones: string[];
  desactivadaPorEstudio: boolean;
}
export interface PropiaPrueba {
  id: string;
  palabra: string;
  categoria: CategoriaPrueba;
  excepciones: string[];
  origen: "manual" | "aprendida";
  activa: boolean;
  version: number;
  autor: { id: string; nombre: string; activo: boolean };
  compraOrigenId: string | null;
  creadaEn: string;
}
export interface GastosEstudioPrueba {
  umbral: number;
  versionUmbral: number;
  activasPropias: number;
  limitePropias: 2000;
  globales: GlobalEstudioPrueba[];
  propias: PropiaPrueba[];
}

/** La vista de «Reglas del motor» del estudio: 3 globales (una desactivada por el estudio) y 3 propias (una inactiva). */
export function gastosEstudioDe(parcial: Partial<GastosEstudioPrueba> = {}): GastosEstudioPrueba {
  return {
    umbral: 3,
    versionUmbral: 0,
    activasPropias: 2,
    limitePropias: 2000,
    globales: [
      { id: G_ZAPATILLA, palabra: "zapatilla", categoria: "calzado-ropa", excepciones: ["seguridad", "punta de acero"], desactivadaPorEstudio: false },
      { id: G_POLO, palabra: "polo", categoria: "calzado-ropa", excepciones: ["a tierra"], desactivadaPorEstudio: true },
      { id: G_JUGUETE, palabra: "juguete", categoria: "juguetes", excepciones: [], desactivadaPorEstudio: false },
    ],
    propias: [
      {
        id: P_AUDIFONOS,
        palabra: "audifonos",
        categoria: "entretenimiento",
        excepciones: [],
        origen: "aprendida",
        activa: true,
        version: 1,
        autor: AUTOR_ROSA,
        compraOrigenId: COMPRA_ORIGEN,
        creadaEn: AHORA_ISO,
      },
      {
        id: P_MOCHILA,
        palabra: "mochila",
        categoria: "utiles-escolares",
        excepciones: ["fumigadora"],
        origen: "manual",
        activa: true,
        version: 2,
        autor: { id: uuidDe(5, 2), nombre: "Luis Ramos", activo: true },
        compraOrigenId: null,
        creadaEn: AHORA_ISO,
      },
      {
        id: P_PERFUME,
        palabra: "perfume",
        categoria: "cuidado-personal",
        excepciones: [],
        origen: "manual",
        activa: false,
        version: 3,
        autor: AUTOR_ROSA,
        compraOrigenId: null,
        creadaEn: AHORA_ISO,
      },
    ],
    ...parcial,
  };
}

export interface CategoriasClientePrueba {
  ciiu: string | null;
  seccion: string | null;
  base: CategoriaPrueba[];
  permitidas: CategoriaPrueba[];
  quitadas: CategoriaPrueba[];
  efectivas: CategoriaPrueba[];
  version: number;
}

/** Ferretería (CIIU 4752, sección G): la base no permite ninguna categoría (D-6). */
export function categoriasDe(parcial: Partial<CategoriasClientePrueba> = {}): CategoriasClientePrueba {
  return { ciiu: "4752", seccion: "G", base: [], permitidas: [], quitadas: [], efectivas: [], version: 0, ...parcial };
}
/** Restaurante (CIIU 5611, sección I): la base permite «alimentos-personales». */
export const categoriasRestaurante = (parcial: Partial<CategoriasClientePrueba> = {}): CategoriasClientePrueba =>
  categoriasDe({
    ciiu: "5611",
    seccion: "I",
    base: ["alimentos-personales"],
    efectivas: ["alimentos-personales"],
    version: 2,
    ...parcial,
  });

export interface SenalPrueba {
  codigo: "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7";
  puntos: number;
  palabra?: string;
  categoria?: string;
  items?: { coinciden: number; total: number };
}

/** CA-1: ferretería y compra de una tienda de ropa con glosa «ZAPATILLA URBANA T42»: S1 + S2 + S3 = 8. */
export const SENALES_CA1: readonly SenalPrueba[] = [
  { codigo: "S1", puntos: 3, palabra: "zapatilla", categoria: "calzado-ropa", items: { coinciden: 1, total: 1 } },
  { codigo: "S2", puntos: 3 },
  { codigo: "S3", puntos: 2, categoria: "calzado-ropa" },
];
/** Todas las señales: puntos con S7 negativo (S6 y S7 nunca van juntas; aquí se prueban los textos por separado). */
export const SENALES_S4_S5_S6: readonly SenalPrueba[] = [
  { codigo: "S4", puntos: 1 },
  { codigo: "S5", puntos: 1 },
  { codigo: "S6", puntos: 4 },
];
export const SENALES_S7: readonly SenalPrueba[] = [
  { codigo: "S1", puntos: 3, palabra: "zapatilla", categoria: "calzado-ropa", items: { coinciden: 1, total: 2 } },
  { codigo: "S7", puntos: -4 },
];

/** Hallazgo R-GP con la forma nueva de D-1 (`puntaje` y `senales`). */
export function hallazgoGastoDe(puntaje = 8, senales: readonly SenalPrueba[] = SENALES_CA1) {
  return {
    regla: "R-GP",
    destino: null,
    explicacion: "Posible gasto no deducible",
    sugerencia: { tipo: "excluir", palabra: "zapatilla", categoria: "calzado-ropa", puntaje, senales },
    requiereConfirmacion: true,
    dato: null,
    masiva: false,
  };
}
/** Hallazgo R-GP guardado por 011, sin puntaje: se sigue leyendo (D-1). */
export const HALLAZGO_GASTO_VIEJO = {
  regla: "R-GP",
  destino: null,
  explicacion: "La glosa menciona «zapatillas»: podría ser un gasto personal.",
  sugerencia: { tipo: "excluir", palabra: "zapatillas", categoria: "personal" },
  requiereConfirmacion: true,
  dato: null,
  masiva: false,
};

export const GLOSA_ONERROR = "<img src=x onerror=alert(1)> ZAPATILLA URBANA T42";

export interface GlobalPrueba {
  id: string;
  palabra: string;
  categoria: CategoriaPrueba;
  excepciones: string[];
  activa: boolean;
  version: number;
  actualizadaEn: string;
}
export const DG_ZAPATILLA = uuidDe(27, 21);
export const DG_POLO = uuidDe(27, 22);
export const DG_BOTA = uuidDe(27, 23);

/** `diccionarioGlobalVistaSchema`: 3 palabras globales, «bota» inactiva. */
export function diccionarioGlobalDe(palabras?: GlobalPrueba[]): { palabras: GlobalPrueba[] } {
  return {
    palabras: palabras ?? [
      { id: DG_ZAPATILLA, palabra: "zapatilla", categoria: "calzado-ropa", excepciones: ["seguridad", "punta de acero"], activa: true, version: 1, actualizadaEn: AHORA_ISO },
      { id: DG_POLO, palabra: "polo", categoria: "calzado-ropa", excepciones: ["a tierra"], activa: true, version: 2, actualizadaEn: AHORA_ISO },
      { id: DG_BOTA, palabra: "bota", categoria: "calzado-ropa", excepciones: ["seguridad", "jebe", "punta de acero"], activa: false, version: 3, actualizadaEn: AHORA_ISO },
    ],
  };
}

export interface HistorialItemPrueba {
  id: string;
  palabraGlobalId: string;
  palabra: string;
  accion: "agregada" | "editada";
  antes: Record<string, unknown> | null;
  despues: Record<string, unknown>;
  autor: { id: string; nombre: string; activo: boolean };
  ocurridaEn: string;
}
/** `historialGlobalVistaSchema`: dos cambios (el más reciente primero) y una página siguiente. */
export function historialGlobalDe(
  items?: HistorialItemPrueba[],
  siguiente: string | null = null,
): { items: HistorialItemPrueba[]; siguiente: string | null } {
  return {
    items: items ?? [
      {
        id: uuidDe(27, 31),
        palabraGlobalId: DG_BOTA,
        palabra: "bota",
        accion: "editada",
        antes: { activa: true },
        despues: { activa: false },
        autor: { id: uuidDe(5, 9), nombre: "Admin Plataforma", activo: true },
        ocurridaEn: "2026-11-21T14:00:00.000Z",
      },
      {
        id: uuidDe(27, 32),
        palabraGlobalId: DG_POLO,
        palabra: "polo",
        accion: "agregada",
        antes: null,
        despues: { categoria: "calzado-ropa" },
        autor: { id: uuidDe(5, 9), nombre: "Admin Plataforma", activo: true },
        ocurridaEn: "2026-11-20T14:00:00.000Z",
      },
    ],
    siguiente,
  };
}

/** `propuestaAprenderVistaSchema` de CA-9: «AUDIFONOS BLUETOOTH JBL X2 UND 2.00». */
export const PROPUESTA_CA9 = { terminos: ["audifonos", "bluetooth", "jbl"] };
