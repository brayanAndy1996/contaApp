import {
  CATEGORIAS_GND,
  categoriasClienteVistaSchema,
  diccionarioGlobalVistaSchema,
  excepcionesSchema,
  gastosEstudioVistaSchema,
  historialGlobalVistaSchema,
  palabraSchema,
  propuestaAprenderVistaSchema,
  aprenderRespuestaSchema,
  type AgregarPalabra,
  type Aprender,
  type AprenderRespuesta,
  type CategoriaGnd,
  type CategoriasCliente,
  type CategoriasClienteVista,
  type DiccionarioGlobalVista,
  type EditarGlobal,
  type GastosEstudioVista,
  type HistorialGlobalVista,
  type PropuestaAprenderVista,
} from "@contapp/shared";
import { MENSAJES } from "./acceso";
import { pedir, type Esquema, type ResultadoReglas } from "./reglas";

// Gastos no deducibles (spec 027, T13; plan, Contratos: HTTP y Frontend). Cliente HTTP y textos de las pantallas del
// diccionario del estudio, las categorías permitidas del cliente, el aprendizaje tras excluir, «Volver a evaluar» y el
// diccionario global del super-admin. Todo lo que llega se valida con `@contapp/shared`; aquí no se calcula nada de negocio
// (el puntaje y las señales vienen del servidor). Un código de error (409/400) sale en español, nunca crudo.

export type {
  AgregarPalabra,
  Aprender,
  AprenderRespuesta,
  CategoriaGnd,
  CategoriasCliente,
  CategoriasClienteVista,
  DiccionarioGlobalVista,
  EditarGlobal,
  GastosEstudioVista,
  HistorialGlobalVista,
  PropuestaAprenderVista,
};
export { CATEGORIAS_GND };

export const PERMISO_GASTOS_GESTIONAR = "reglas.gestionar";

/** Texto de cada categoría en las listas y combos (el `value` de cada opción es el código). */
export const ETIQUETA_CATEGORIA: Record<CategoriaGnd, string> = {
  "calzado-ropa": "Calzado y ropa",
  juguetes: "Juguetes",
  entretenimiento: "Entretenimiento",
  "alimentos-personales": "Alimentos y bebidas personales",
  "cuidado-personal": "Cuidado personal",
  "utiles-escolares": "Útiles escolares",
};

/** Etiqueta de una categoría; un código fuera de las seis (no debería llegar) sale tal cual, como texto. */
export const etiquetaCategoria = (codigo: string): string =>
  (ETIQUETA_CATEGORIA as Record<string, string>)[codigo] ?? codigo;

// ---------------------------------------------------------------------------------------------
// Textos (una sola fuente para las piezas y las pruebas)
// ---------------------------------------------------------------------------------------------

export const MENSAJES_GASTOS = {
  // Sección «Gastos no deducibles» de «Reglas del motor» (R-4, R-11, D-3).
  tituloSeccion: "Gastos no deducibles",
  soloLectura: "Solo un Dueño o Administrador con alcance global puede cambiar el diccionario y el umbral del estudio.",
  sinPermiso: "No tienes permiso para realizar esta acción.",
  errorCarga: "No se pudo cargar el diccionario. Inténtalo de nuevo.",
  cargando: "Cargando gastos no deducibles…",

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

  // Etiquetas de las tablas (en celular cada celda lleva la de su columna) y botones cortos.
  columnas: {
    palabra: "Palabra",
    categoria: "Categoría",
    excepciones: "Excepciones",
    estado: "Estado",
    origen: "Origen",
    autor: "Autor",
    acciones: "Acciones",
    accion: "Acción",
    fecha: "Fecha",
  },
  sinExcepciones: "Sin excepciones",
  desactivar: "Desactivar",
  reactivar: "Reactivar",
  editar: "Editar",
  activar: "Activar",

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
  cargandoCategorias: "Cargando categorías…",

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
  excepcionesSugeridas: (frases: readonly string[]) => `No aplica si el ítem dice: ${frases.join(", ")}.`,
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
  tituloPaginaDiccionario: "Diccionario de gastos no deducibles",
  enlaceEstudios: "Estudios",
  enlaceDiccionario: "Diccionario",
  cargandoPagina: "Cargando…",
} as const;

const codigoDe = (datos: unknown): string =>
  (datos as { codigo?: unknown } | null)?.codigo === undefined ? "" : String((datos as { codigo?: unknown }).codigo);

/** Mensaje visible de un error del backend de gastos; nunca muestra el código ni el cuerpo. */
export function mensajeDeErrorGastos(status: number, datos: unknown): string {
  const codigo = codigoDe(datos);
  if (status === 409 && Object.hasOwn(MENSAJES_GASTOS.errores, codigo)) {
    return MENSAJES_GASTOS.errores[codigo as keyof typeof MENSAJES_GASTOS.errores];
  }
  if (status === 400) return MENSAJES_GASTOS.errores.solicitud_invalida;
  if (status === 403) return MENSAJES.sinPermiso;
  if (status === 404) return MENSAJES.noEncontrado;
  return MENSAJES.errorGeneral;
}

// ---------------------------------------------------------------------------------------------
// Validación de formularios (solo comodidad: el servidor vuelve a validar con los mismos esquemas de shared)
// ---------------------------------------------------------------------------------------------

/** Texto → excepciones: separadas por coma, sin vacías y con los espacios internos reducidos a uno. */
export function excepcionesDeTexto(texto: string): string[] {
  return texto
    .split(",")
    .map((e) => e.trim().replace(/\s+/g, " "))
    .filter((e) => e !== "");
}

export type ResultadoPalabra = { ok: true; cuerpo: AgregarPalabra } | { ok: false; error: string };

/** Valida el formulario de «Agregar palabra» (estudio y super-admin) en el orden palabra, categoría y excepciones. */
export function validarPalabra(o: { palabra: string; categoria: string; excepciones: string }): ResultadoPalabra {
  const palabra = palabraSchema.safeParse(o.palabra.trim());
  if (!palabra.success) return { ok: false, error: MENSAJES_GASTOS.palabraInvalida };
  const categoria = (CATEGORIAS_GND as readonly string[]).includes(o.categoria) ? (o.categoria as CategoriaGnd) : null;
  if (categoria === null) return { ok: false, error: MENSAJES_GASTOS.categoriaRequerida };
  const excepciones = excepcionesSchema.safeParse(excepcionesDeTexto(o.excepciones));
  if (!excepciones.success) return { ok: false, error: MENSAJES_GASTOS.excepcionesInvalidas };
  return { ok: true, cuerpo: { palabra: palabra.data, categoria, excepciones: excepciones.data } };
}

export type ResultadoEdicion =
  | { ok: true; categoria: CategoriaGnd; excepciones: string[] }
  | { ok: false; error: string };

/** Valida la edición de una palabra global (la palabra no se renombra): categoría y excepciones. */
export function validarEdicionGlobal(o: { categoria: string; excepciones: string }): ResultadoEdicion {
  const categoria = (CATEGORIAS_GND as readonly string[]).includes(o.categoria) ? (o.categoria as CategoriaGnd) : null;
  if (categoria === null) return { ok: false, error: MENSAJES_GASTOS.categoriaRequerida };
  const excepciones = excepcionesSchema.safeParse(excepcionesDeTexto(o.excepciones));
  if (!excepciones.success) return { ok: false, error: MENSAJES_GASTOS.excepcionesInvalidas };
  return { ok: true, categoria, excepciones: excepciones.data };
}

/** `true` si `texto` es una palabra de 3 a 40 letras o números (término de «Aprender estas palabras»). */
export const esTerminoValido = (texto: string): boolean => palabraSchema.safeParse(texto.trim()).success;

/** Umbral entero de 1 a 20, o `null` si el texto no lo es. */
export function umbralDeTexto(texto: string): number | null {
  if (!/^\d{1,2}$/.test(texto.trim())) return null;
  const n = Number(texto);
  return n >= 1 && n <= 20 ? n : null;
}

/** Palabra sin tildes ni mayúsculas, para buscar. */
export const normalizarBusqueda = (texto: string): string =>
  texto.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

// ---------------------------------------------------------------------------------------------
// Llamadas
// ---------------------------------------------------------------------------------------------

export type ResultadoGastos<T> = ResultadoReglas<T>;

const llamar = <T>(ruta: string, esquema: Esquema<T> | null, opciones: { method?: string; body?: unknown } = {}) =>
  pedir<T>(ruta, esquema, opciones, mensajeDeErrorGastos);

const BASE_ESTUDIO = "/estudio/reglas-motor/gastos";

export const leerGastosEstudio = () => llamar(BASE_ESTUDIO, gastosEstudioVistaSchema);

export const fijarUmbral = (umbral: number, version: number) =>
  llamar<undefined>(`${BASE_ESTUDIO}/umbral`, null, { method: "PUT", body: { umbral, version } });

export const agregarPalabra = (cuerpo: AgregarPalabra) =>
  llamar<undefined>(`${BASE_ESTUDIO}/palabras`, null, { method: "POST", body: cuerpo });

export const fijarEstadoPalabra = (id: string, activa: boolean, version: number) =>
  llamar<undefined>(`${BASE_ESTUDIO}/palabras/${encodeURIComponent(id)}`, null, {
    method: "PUT",
    body: { activa, version },
  });

export const fijarEstadoGlobal = (id: string, activa: boolean) =>
  llamar<undefined>(`${BASE_ESTUDIO}/globales/${encodeURIComponent(id)}`, null, { method: "PUT", body: { activa } });

const baseCategorias = (clienteId: string): string => `/clientes/${encodeURIComponent(clienteId)}/gastos/categorias`;

export const leerCategoriasCliente = (clienteId: string) =>
  llamar(baseCategorias(clienteId), categoriasClienteVistaSchema);

export const fijarCategoriasCliente = (clienteId: string, cuerpo: CategoriasCliente) =>
  llamar<undefined>(baseCategorias(clienteId), null, { method: "PUT", body: cuerpo });

const basePeriodo = (clienteId: string, periodo: string): string =>
  `/clientes/${encodeURIComponent(clienteId)}/periodos/${encodeURIComponent(periodo)}/gastos`;

export const leerPropuestaAprender = (clienteId: string, periodo: string, compraId: string) =>
  llamar(`${basePeriodo(clienteId, periodo)}/aprender/${encodeURIComponent(compraId)}`, propuestaAprenderVistaSchema);

export const aprenderPalabras = (clienteId: string, periodo: string, compraId: string, cuerpo: Aprender) =>
  llamar(`${basePeriodo(clienteId, periodo)}/aprender/${encodeURIComponent(compraId)}`, aprenderRespuestaSchema, {
    method: "POST",
    body: cuerpo,
  });

const esquemaAceptada: Esquema<{ trabajoId: string }> = {
  safeParse(valor) {
    const id = (valor as { trabajoId?: unknown } | null)?.trabajoId;
    return typeof id === "string" && id !== "" ? { success: true, data: { trabajoId: id } } : { success: false };
  },
};

/** `POST …/gastos/reevaluar`: 202 `{trabajoId}`. */
export const reevaluarPeriodo = (clienteId: string, periodo: string) =>
  llamar(`${basePeriodo(clienteId, periodo)}/reevaluar`, esquemaAceptada, { method: "POST", body: {} });

// Super-admin (sin estudio activo).
const BASE_GLOBAL = "/plataforma/diccionario";

export const leerDiccionarioGlobal = () => llamar(BASE_GLOBAL, diccionarioGlobalVistaSchema);

export const leerHistorialGlobal = (antes?: string) =>
  llamar(
    antes === undefined ? `${BASE_GLOBAL}/historial` : `${BASE_GLOBAL}/historial?antes=${encodeURIComponent(antes)}`,
    historialGlobalVistaSchema,
  );

export const agregarPalabraGlobal = (cuerpo: AgregarPalabra) =>
  llamar<undefined>(BASE_GLOBAL, null, { method: "POST", body: cuerpo });

export const editarPalabraGlobal = (id: string, cuerpo: EditarGlobal) =>
  llamar<undefined>(`${BASE_GLOBAL}/${encodeURIComponent(id)}`, null, { method: "PUT", body: cuerpo });
