import { vi } from "vitest";
import { rutaSesion, yoDe } from "./acceso";
import { clienteDe } from "./clientes";
import { trabajoDe } from "./credenciales";
import {
  instalarFetchFalso,
  type FetchFalso,
  type Manejador,
} from "./soporte";
import { eventoSse, idTrabajo } from "./trabajos";

// Soporte de las pruebas de la pantalla de ventas (spec 013, T7): textos visibles, DTO de ejemplo y un
// `fetch` simulado del contrato de rutas del plan (`/clientes/:clienteId/periodos/:periodo/ventas`).
// Son el contrato de T15 y T16: las pantallas deben mostrar estos textos exactos y los esquemas de
// `packages/shared/src/ventas` (T11) deben aceptar estas formas. Solo datos de prueba; sin lógica de
// producción. Los montos son SIEMPRE cadenas (nunca `number`).
//
// Formas de los DTO (camelCase) que el backend responde y `shared` debe validar:
//  - Página:      { filas: VentaVista[], total, pagina, tamano: number | "todas", avisos: ("todas_limitada")[] }
//  - Venta:       { id, origen: "sire"|"manual", tipo, serie, numero, fechaEmision, tipoDocContraparte|null,
//                   docContraparte, moneda: "PEN"|"USD", tipoCambio|null, baseGravada, igv, exonerada,
//                   inafecta, isc, icbper, otros, total, cuadra: boolean }  (T22b, D26: `cuadra` lo calcula el backend al leer)
//  - Resumen:     { porTipo: ({ tipo, cantidad, ...columnas })[], total: { cantidad, ...columnas },
//                   sinConvertir: { clave, moneda }[], avisos: ("usd_sin_tipo_cambio")[] }
//  - Correlat.:   { series: { tipo, serie, estado, faltantes: { desde, hasta, estado, comentario? }[],
//                   noEvaluables }[] }   (desde/hasta: enteros)
//  - Propuesta:   { id, fuente: "api"|"importacion", filasRecibidas, filasNuevas, filasIguales,
//                   filasDistintas, creadaEn }   (GET /propuestas: la más reciente primero)
//  - Diferencia:  { clave, tipo, serie, numero, origenExistente, campos: string[], valoresSire }
//  - Importación: vista previa { filas: { n, estado, motivos: string[], advertencias: string[] }[], validas, conError, conAdvertencia };
//                 confirmar 201 { propuesta: Propuesta }.

export const CLIENTE_ID = "c-1";
export const PERIODO = "202610";
export const BASE = `/api/clientes/${CLIENTE_ID}/periodos/${PERIODO}/ventas`;
export const URL_PANEL = "/trabajos";

export const MENSAJES_VENTAS = {
  titulo: "Ventas",
  tituloImportar: "Importar propuesta de ventas",
  // Selector de periodo (AAAAMM, mes 01 a 12); vacío o inválido no pide nada.
  etiquetaPeriodo: "Periodo (AAAAMM)",
  periodoInvalido: "Ingresa un periodo válido (AAAAMM).",
  // Descarga (D14).
  descargar: "Descargar",
  reintentar: "Reintentar",
  importar: "Importar propuesta",
  enCola: (n: number) => `En cola · posición ${n}`,
  ejecutando: "Descargando la propuesta…",
  // Resumen de la descarga y de la importación: «N nuevos, M difieren».
  resumenDescarga: (nuevos: number, difieren: number) =>
    `${nuevos} nuevos, ${difieren} difieren`,
  sinDescargas: "Aún no hay descargas de este periodo.",
  // Grilla (RF-052).
  filasPorPagina: "Filas por página",
  siguiente: "Siguiente",
  anterior: "Anterior",
  filtrar: "Filtrar",
  // `total` con puntos de miles («5.001»); el tope de 5.000 es fijo (D10).
  todasLimitada: (total: string) =>
    `Se muestran las primeras 5.000 filas de ${total}. Para ver el resto, usa la paginación.`,
  buscar: "Buscar",
  filtroTipo: "Tipo",
  filtroSerie: "Serie",
  montoMinimo: "Monto mínimo",
  montoMaximo: "Monto máximo",
  tablaVentas: "Ventas del periodo",
  // T22b (D26): marca de la fila del SIRE cuyo total no cuadra con la suma de los componentes.
  noCuadra: "No cuadra",
  // Resumen (RF-056).
  importesEnSoles: "Importes en soles",
  avisoUsdSinTipoCambio:
    "Hay ventas en USD sin tipo de cambio: no se incluyen en el resumen.",
  // Correlatividad (RF-053, HU-12).
  faltaUno: (clave: string) => `Falta ${clave}`,
  faltaRango: (desde: string, hasta: string) => `Faltan ${desde} a ${hasta}`,
  numeracionCompleta: "Numeración completa",
  noEvaluable: "No evaluable",
  justificado: "Justificado",
  justificadoEnParte: "Justificado en parte",
  porRevisar: (n: number) => `Saltos por revisar: ${n}`,
  nombreSerie: (tipo: string, serie: string) => `Tipo ${tipo} · serie ${serie}`,
  justificar: "Justificar",
  formularioJustificar: "Justificar salto",
  comentarioRequerido: "Escribe un comentario de 1 a 500 caracteres.",
  guardar: "Guardar",
  cancelar: "Cancelar",
  etiquetaComentario: "Comentario",
  justificarInvalido:
    "No se pudo justificar: revisa el comentario y el rango del salto.",
  // Agregar venta (RF-055).
  agregarVenta: "Agregar venta",
  agregarVentaManual: "Agregar venta manual",
  formularioAgregar: "Agregar venta",
  agregar: "Agregar",
  // Etiquetas del formulario (cada una con su <label>); los montos empiezan en «0.00».
  campos: {
    tipo: "Tipo",
    serie: "Serie",
    numero: "Número",
    fecha: "Fecha de emisión",
    moneda: "Moneda",
    tipoCambio: "Tipo de cambio",
    tipoDoc: "Tipo de documento",
    documento: "Documento",
    baseGravada: "Base gravada",
    igv: "IGV",
    exonerada: "Exonerada",
    inafecta: "Inafecta",
    isc: "ISC",
    icbper: "ICBPER",
    otros: "Otros",
    total: "Total",
  },
  ventaAgregada: "Venta agregada.",
  datosInvalidos: "Revisa los datos de la venta.",
  ventaDuplicada:
    "Ya existe una venta con ese tipo, serie y número en el periodo.",
  // Diferencias de la última descarga (D16).
  tituloDiferencias: "Diferencias de la última descarga",
  // Asistente de importación (D6).
  archivo: "Archivo (.xlsx, .csv o .txt)",
  revisarArchivo: "Revisar archivo",
  confirmarImportacion: "Confirmar importación",
  verVentas: "Ver ventas del periodo",
  validas: (n: number) => `Filas válidas: ${n}`,
  conError: (n: number) => `Filas con error: ${n}`,
  estadoFila: {
    valida: "Válida",
    conError: "Con error",
    // T20a (D22): una fila válida con advertencias.
    conAdvertencia: "Válida con advertencia",
  },
  // T20a (D22): advertencias de la vista previa. No bloquean: la fila se confirma y se guarda tal cual (D3).
  conAdvertencia: (n: number) => `Filas con advertencia: ${n}`,
  avisoAdvertencias:
    "Las filas con advertencia se pueden confirmar: se guardan tal cual.",
  advertencias: {
    descuadre:
      "El total no cuadra con la suma de los componentes; se guardará tal cual.",
    tipo_cambio_requerido:
      "Falta el tipo de cambio de la venta en USD; no se incluirá en el resumen.",
  },
  // T20a (D23): revertir una justificación y quitar una venta agregada a mano (ambos piden confirmación).
  revertir: "Revertir",
  quitar: "Quitar",
  confirmar: "Confirmar",
  confirmarRevertir: (clave: string) =>
    `¿Revertir la justificación del salto ${clave}? Quedará registro de quién la revirtió y cuándo.`,
  confirmarQuitar: (clave: string) =>
    `¿Quitar la venta ${clave} agregada a mano? Esta acción no se puede deshacer.`,
  justificacionRevertida: "Justificación revertida.",
  ventaQuitada: "Venta quitada.",
  errorRevertir: "No se pudo revertir la justificación.",
  errorQuitar: "No se pudo quitar la venta.",
  corregirFilas:
    "Corrige las filas con error: si alguna falla no se guarda nada.",
  layoutNoOficial:
    "La importación no está disponible: el diseño de columnas es provisional y no oficial.",
  archivoInvalido:
    "El archivo no es válido. Usa un .xlsx, .csv o .txt con el layout provisional.",
  archivoGrande: "El archivo supera el tamaño permitido.",
  propuestaGrande: "La propuesta supera las 20.000 filas permitidas.",
  // Motivos de fila de la vista previa (códigos cerrados de `validarFilaVenta`).
  motivos: {
    fecha_invalida: "La fecha no es válida.",
    monto_invalido: "Un monto no es válido.",
    tipo_cambio_invalido: "El tipo de cambio no es válido.",
    documento_invalido: "El documento de la contraparte no es válido.",
    descuadre: "El total no cuadra con la suma de los componentes.",
    tipo_cambio_requerido: "Falta el tipo de cambio de la venta en USD.",
    celda_peligrosa: "La fila contiene una fórmula o un carácter no permitido.",
  },
  // Motivos de un trabajo fallido (los del panel de 007b).
  motivosTrabajo: {
    sunat_no_responde: "SUNAT no responde",
    credencial_invalida: "Credencial inválida",
  },
} as const;

/** Permisos de prueba. */
export const PERMISOS = {
  todos: ["clientes.ver", "sire.descargar", "sire.clasificar"],
  lectura: ["clientes.ver"],
  soloDescargar: ["clientes.ver", "sire.descargar"],
  soloClasificar: ["clientes.ver", "sire.clasificar"],
} as const;

// ---------------------------------------------------------------------------------------------
// DTO de ejemplo
// ---------------------------------------------------------------------------------------------

/** UUID válido y determinista (los esquemas de `shared` exigen `z.uuid()`). */
export function uuidDe(prefijo: number, n: number): string {
  return `${String(prefijo).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export interface VentaVista {
  id: string;
  origen: "sire" | "manual";
  tipo: string;
  serie: string;
  numero: string;
  fechaEmision: string;
  tipoDocContraparte: string | null;
  docContraparte: string;
  moneda: "PEN" | "USD";
  tipoCambio: string | null;
  baseGravada: string;
  igv: string;
  exonerada: string;
  inafecta: string;
  isc: string;
  icbper: string;
  otros: string;
  total: string;
  /** T22b (D26): el backend lo calcula al leer; `false` si Σ de las siete columnas no es el total. */
  cuadra: boolean;
}

let contadorVentas = 0;
export function ventaDe(parcial: Partial<VentaVista> = {}): VentaVista {
  contadorVentas += 1;
  return {
    id: parcial.id ?? uuidDe(10, contadorVentas),
    origen: "sire",
    tipo: "03",
    serie: "B001",
    numero: "290",
    fechaEmision: "2026-10-05",
    tipoDocContraparte: null,
    docContraparte: "-",
    moneda: "PEN",
    tipoCambio: null,
    baseGravada: "100.00",
    igv: "18.00",
    exonerada: "0.00",
    inafecta: "0.00",
    isc: "0.00",
    icbper: "0.00",
    otros: "0.00",
    total: "118.00",
    cuadra: true,
    ...parcial,
  };
}

/** El caso real: B001-290 y B001-292 (falta la 291). Montos con ceros finales que `number` perdería. */
export const V290 = ventaDe({ numero: "290" });
export const V292 = ventaDe({
  numero: "292",
  baseGravada: "0.10",
  igv: "0.02",
  total: "0.12",
});
export const V_NC = ventaDe({
  tipo: "07",
  serie: "FC01",
  numero: "1",
  baseGravada: "-50.00",
  igv: "-9.00",
  total: "-59.00",
});
export const V_USD_SIN_TC = ventaDe({
  tipo: "01",
  serie: "F001",
  numero: "5",
  moneda: "USD",
  tipoCambio: null,
  baseGravada: "1000.00",
  igv: "180.00",
  total: "1180.00",
});
/** T22b: venta del SIRE guardada tal cual aunque el total no cuadre (100.00 + 18.00 ≠ 118.01). */
export const V_DESCUADRADA = ventaDe({
  numero: "294",
  total: "118.01",
  cuadra: false,
});
export const V_MANUAL = ventaDe({
  origen: "manual",
  numero: "291",
  baseGravada: "10.50",
  igv: "1.89",
  total: "12.39",
});

/** Texto del SIRE hostil: la pantalla debe mostrarlo como texto, jamás interpretarlo. */
export const TEXTO_HOSTIL = `<img src="x" onerror="window.__xss=1">`;
export const V_HOSTIL = ventaDe({
  numero: "293",
  tipoDocContraparte: "6",
  docContraparte: TEXTO_HOSTIL,
});

export function paginaDe(
  filas: VentaVista[],
  parcial: Partial<{
    total: number;
    pagina: number;
    tamano: number | "todas";
    avisos: string[];
  }> = {},
) {
  return {
    filas,
    total: parcial.total ?? filas.length,
    pagina: parcial.pagina ?? 1,
    tamano: parcial.tamano ?? 25,
    avisos: parcial.avisos ?? [],
  };
}

const COLUMNAS_CERO = {
  baseGravada: "0.00",
  igv: "0.00",
  exonerada: "0.00",
  inafecta: "0.00",
  isc: "0.00",
  icbper: "0.00",
  otros: "0.00",
  total: "0.00",
};

export type ResumenTipo = typeof COLUMNAS_CERO & {
  tipo: string;
  cantidad: number;
};

export function resumenTipoDe(
  tipo: string,
  cantidad: number,
  columnas: Partial<typeof COLUMNAS_CERO>,
): ResumenTipo {
  return { tipo, cantidad, ...COLUMNAS_CERO, ...columnas };
}

export function resumenDe(
  porTipo: ResumenTipo[],
  total: Partial<typeof COLUMNAS_CERO> & { cantidad?: number },
  extra: {
    sinConvertir?: { clave: string; moneda: string }[];
    avisos?: string[];
  } = {},
) {
  return {
    porTipo,
    total: {
      cantidad: total.cantidad ?? porTipo.reduce((a, t) => a + t.cantidad, 0),
      ...COLUMNAS_CERO,
      ...total,
    },
    sinConvertir: extra.sinConvertir ?? [],
    avisos: extra.avisos ?? [],
  };
}

/** Boletas (2 + la NC): consistente. */
export const RESUMEN_BASE = resumenDe(
  [
    resumenTipoDe("03", 2, {
      baseGravada: "100.10",
      igv: "18.02",
      total: "118.12",
    }),
    resumenTipoDe("07", 1, {
      baseGravada: "-50.00",
      igv: "-9.00",
      total: "-59.00",
    }),
  ],
  { baseGravada: "50.10", igv: "9.02", total: "59.12" },
);

/** 0.10 + 0.20 con `number` da 0.30000000000000004: el total debe ser la cadena del servidor. */
export const RESUMEN_FLOTANTE = resumenDe(
  [
    resumenTipoDe("03", 1, { baseGravada: "0.10", total: "0.10" }),
    resumenTipoDe("01", 1, { baseGravada: "0.20", total: "0.20" }),
  ],
  { baseGravada: "0.30", total: "0.30" },
);

export const RESUMEN_CON_USD_SIN_TC = resumenDe(
  [resumenTipoDe("03", 2, { baseGravada: "100.10", total: "118.12" })],
  { baseGravada: "100.10", total: "118.12" },
  {
    sinConvertir: [{ clave: "01|F001|5", moneda: "USD" }],
    avisos: ["usd_sin_tipo_cambio"],
  },
);

export interface FaltanteVista {
  desde: number;
  hasta: number;
  estado: "pendiente" | "justificado" | "parcial";
  comentario?: string;
  /** Solo en un salto justificado por una única justificación vigente (T13). */
  justificacionId?: string;
}

export interface SerieVista {
  tipo: string;
  serie: string;
  estado: "completa" | "con_faltantes" | "no_evaluable";
  faltantes: FaltanteVista[];
  noEvaluables: number;
}

export function serieDe(
  tipo: string,
  serie: string,
  faltantes: FaltanteVista[] = [],
  parcial: Partial<SerieVista> = {},
): SerieVista {
  return {
    tipo,
    serie,
    estado: faltantes.length > 0 ? "con_faltantes" : "completa",
    faltantes,
    noEvaluables: 0,
    ...parcial,
  };
}

export const COMENTARIO_JUSTIFICADO = "Boleta anulada en caja";

/** B001 sin la 291, F001 completa, B003 con el salto 402 a 404 y F002 no evaluable. */
export const CORRELATIVIDAD_BASE = {
  series: [
    serieDe("03", "B001", [{ desde: 291, hasta: 291, estado: "pendiente" }]),
    serieDe("01", "F001"),
    serieDe("03", "B003", [{ desde: 402, hasta: 404, estado: "pendiente" }]),
    serieDe("01", "F002", [], { estado: "no_evaluable", noEvaluables: 2 }),
  ],
};

/** La misma, con la 291 ya justificada. */
export const CORRELATIVIDAD_JUSTIFICADA = {
  series: [
    serieDe("03", "B001", [
      {
        desde: 291,
        hasta: 291,
        estado: "justificado",
        comentario: COMENTARIO_JUSTIFICADO,
      },
    ]),
    serieDe("01", "F001"),
    serieDe("03", "B003", [{ desde: 402, hasta: 404, estado: "pendiente" }]),
    serieDe("01", "F002", [], { estado: "no_evaluable", noEvaluables: 2 }),
  ],
};

/** Id de la justificación vigente de la 291 (el servidor lo entrega en `justificacionId`, T13). */
export const JUSTIFICACION_ID = uuidDe(30, 1);

/** Como `CORRELATIVIDAD_JUSTIFICADA`, con el `justificacionId` que permite revertir (T20a, D23). */
export const CORRELATIVIDAD_JUSTIFICADA_CON_ID = {
  series: [
    serieDe("03", "B001", [
      {
        desde: 291,
        hasta: 291,
        estado: "justificado",
        comentario: COMENTARIO_JUSTIFICADO,
        justificacionId: JUSTIFICACION_ID,
      } as FaltanteVista,
    ]),
    serieDe("01", "F001"),
    serieDe("03", "B003", [{ desde: 402, hasta: 404, estado: "pendiente" }]),
    serieDe("01", "F002", [], { estado: "no_evaluable", noEvaluables: 2 }),
  ],
};

/** B001 completa tras agregar la 291. */
export const CORRELATIVIDAD_CON_291 = {
  series: [
    serieDe("03", "B001"),
    serieDe("01", "F001"),
    serieDe("03", "B003", [{ desde: 402, hasta: 404, estado: "pendiente" }]),
    serieDe("01", "F002", [], { estado: "no_evaluable", noEvaluables: 2 }),
  ],
};

export const CORRELATIVIDAD_PARCIAL = {
  series: [
    serieDe("03", "B001", [
      {
        desde: 291,
        hasta: 295,
        estado: "parcial",
        comentario: COMENTARIO_JUSTIFICADO,
      },
    ]),
  ],
};

/** Un salto de 99 999 997 números: la pantalla no puede expandirlo. */
export const CORRELATIVIDAD_ENORME = {
  series: [
    serieDe("03", "B009", [{ desde: 2, hasta: 99999998, estado: "pendiente" }]),
  ],
};

export const CORRELATIVIDAD_VACIA = { series: [] };

export function propuestaDe(
  n: number,
  parcial: Partial<{
    fuente: "api" | "importacion";
    filasRecibidas: number;
    filasNuevas: number;
    filasIguales: number;
    filasDistintas: number;
    creadaEn: string;
  }> = {},
) {
  const nuevas = parcial.filasNuevas ?? 2;
  const iguales = parcial.filasIguales ?? 1;
  const distintas = parcial.filasDistintas ?? 1;
  return {
    id: uuidDe(20, n),
    fuente: parcial.fuente ?? "api",
    filasRecibidas: parcial.filasRecibidas ?? nuevas + iguales + distintas,
    filasNuevas: nuevas,
    filasIguales: iguales,
    filasDistintas: distintas,
    creadaEn: parcial.creadaEn ?? "2026-11-04T10:00:05.000Z",
  };
}

export type PropuestaPrueba = ReturnType<typeof propuestaDe>;

/** La 290 vino del SIRE con otro total (D16, CA-11). */
export const DIFERENCIA_290 = {
  clave: "03|B001|290",
  tipo: "03",
  serie: "B001",
  numero: "290",
  origenExistente: "sire",
  campos: ["total"],
  valoresSire: { total: "236.00" },
};

/** `TrabajoVista` de una descarga de ventas. */
export function trabajoDescarga(
  n: number,
  estado: "en_cola" | "ejecutando" | "completado" | "error" | "cancelado",
  parcial: { posicion?: number; motivo?: string | null } = {},
) {
  const terminal = ["completado", "error", "cancelado"].includes(estado);
  return trabajoDe({
    id: idTrabajo(n),
    tipo: "sire.propuesta.descargar",
    estado,
    posicion: estado === "en_cola" ? (parcial.posicion ?? 1) : null,
    intentos: terminal ? 1 : 0,
    motivo: parcial.motivo ?? null,
    iniciadoEn: estado === "en_cola" ? null : "2026-11-04T10:00:01.000Z",
    terminadoEn: terminal ? "2026-11-04T10:00:05.000Z" : null,
  });
}

export type TrabajoDescarga = ReturnType<typeof trabajoDescarga>;

// --- Importación -----------------------------------------------------------------------------

export type MotivoFilaVenta = keyof typeof MENSAJES_VENTAS.motivos;

export type AdvertenciaFilaVenta = keyof typeof MENSAJES_VENTAS.advertencias;

/** T20a (D22): cada fila trae `advertencias` (lista, vacía si no hay); un error no se evalúa y no lleva ninguna. */
export function filaImportadaDe(
  n: number,
  motivos: MotivoFilaVenta[] = [],
  advertencias: AdvertenciaFilaVenta[] = [],
) {
  return {
    n,
    estado: motivos.length > 0 ? "error" : "valida",
    motivos,
    advertencias: motivos.length > 0 ? [] : advertencias,
  };
}

export function vistaPreviaVentasDe(
  filas: ReturnType<typeof filaImportadaDe>[],
) {
  const validas = filas.filter((f) => f.estado === "valida").length;
  const conAdvertencia = filas.filter((f) => f.advertencias.length > 0).length;
  return { filas, validas, conError: filas.length - validas, conAdvertencia };
}

/** Archivo con una celda de fórmula: su contenido jamás debe verse en pantalla. */
export const CANARIO_ARCHIVO_VENTAS = "CANARIO-VENTAS-ARCHIVO-8e41";
export const CSV_VENTAS = [
  "tipo,serie,numero,fecha,total",
  `03,B001,290,2026-10-05,${CANARIO_ARCHIVO_VENTAS}`,
].join("\n");

// ---------------------------------------------------------------------------------------------
// fetch simulado
// ---------------------------------------------------------------------------------------------

/** Lo que el backend simulado responde; las pruebas lo mutan para simular el avance. */
export interface EstadoVentas {
  pagina: unknown;
  resumen: unknown;
  correlatividad: unknown;
  /** La más reciente primero. */
  propuestas: unknown[];
  /** Por `propuestaId`; hay que declarar de antemano las claves que se pedirán. */
  diferencias: Record<string, unknown[]>;
  /** Respuesta de `GET /api/trabajos` y estado de los eventos del stream. */
  trabajos: unknown[];
}

export interface OpcionesVentas {
  permisos?: readonly string[];
  estado?: Partial<EstadoVentas>;
  /**
   * Manejadores propios (ganan sobre los de ventas): `"POST /api/…": { status, cuerpo }`. Con una función,
   * recibe el `estado` vivo para cambiarlo al responder (p. ej. una justificación cambia la correlatividad).
   */
  extra?:
    | Record<string, Manejador>
    | ((estado: EstadoVentas) => Record<string, Manejador>);
}

export interface FetchVentas extends FetchFalso {
  estado: EstadoVentas;
  /** Cambia el trabajo (lista y stream abiertos). Si ya existe uno con ese id, lo reemplaza. */
  emitir(trabajo: TrabajoDescarga): void;
  /** Llamadas a `GET <BASE><sufijo>` (con o sin query). */
  lecturas(sufijo?: string): FetchFalso["llamadas"];
}

/**
 * Instala `fetch`: sesión, permisos, cliente, las rutas de ventas del plan y el panel de trabajos
 * (lista y stream SSE). Las respuestas salen de `estado`, que la prueba puede cambiar en caliente.
 */
export function instalarFetchVentas(opciones: OpcionesVentas = {}): FetchVentas {
  const estado: EstadoVentas = {
    pagina: paginaDe([]),
    resumen: resumenDe([], {}),
    correlatividad: CORRELATIVIDAD_VACIA,
    propuestas: [],
    diferencias: {},
    trabajos: [],
    ...opciones.estado,
  };
  const permisos = [...(opciones.permisos ?? PERMISOS.todos)];
  const rutas: Record<string, Manejador> = {
    ...rutaSesion(),
    "GET /api/acceso/yo": { status: 200, cuerpo: yoDe("dueno", permisos) },
    [`GET /api/clientes/${CLIENTE_ID}`]: {
      status: 200,
      cuerpo: clienteDe({ id: CLIENTE_ID }),
    },
    [`GET ${BASE}`]: () => ({ status: 200, cuerpo: estado.pagina }),
    [`GET ${BASE}/resumen`]: () => ({ status: 200, cuerpo: estado.resumen }),
    [`GET ${BASE}/correlatividad`]: () => ({
      status: 200,
      cuerpo: estado.correlatividad,
    }),
    [`GET ${BASE}/propuestas`]: () => ({
      status: 200,
      cuerpo: estado.propuestas,
    }),
    "GET /api/trabajos": () => ({ status: 200, cuerpo: estado.trabajos }),
    "GET /api/trabajos/resumen": { status: 404, cuerpo: { codigo: "no_encontrado" } },
  };
  for (const id of Object.keys(estado.diferencias)) {
    rutas[`GET ${BASE}/propuestas/${id}/diferencias`] = () => ({
      status: 200,
      cuerpo: estado.diferencias[id] ?? [],
    });
  }
  Object.assign(
    rutas,
    typeof opciones.extra === "function"
      ? opciones.extra(estado)
      : opciones.extra,
  );

  const base = instalarFetchFalso(rutas);
  const delegado = globalThis.fetch;
  const conexiones: ReadableStreamDefaultController<Uint8Array>[] = [];
  const codificador = new TextEncoder();

  const envuelto = vi.fn(
    async (entrada: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof entrada === "string"
          ? entrada
          : entrada instanceof URL
            ? entrada.pathname + entrada.search
            : entrada.url;
      const metodo = (init?.method ?? "GET").toUpperCase();
      if (metodo === "GET" && url.split("?")[0] === "/api/trabajos/stream") {
        const cuerpo = new ReadableStream<Uint8Array>({
          start(c) {
            conexiones.push(c);
          },
        });
        init?.signal?.addEventListener("abort", () => {
          try {
            conexiones.forEach((c) =>
              c.error(new DOMException("aborted", "AbortError")),
            );
          } catch {
            // El lector ya canceló el stream.
          }
        });
        return new Response(cuerpo, {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      }
      return delegado(entrada, init);
    },
  );
  vi.stubGlobal("fetch", envuelto);

  return {
    llamadas: base.llamadas,
    de: base.de,
    estado,
    emitir(trabajo) {
      const lista = estado.trabajos as { id: string }[];
      const i = lista.findIndex((t) => t.id === trabajo.id);
      if (i === -1) lista.push(trabajo);
      else lista[i] = trabajo;
      for (const c of conexiones) {
        try {
          c.enqueue(codificador.encode(eventoSse(trabajo as never)));
        } catch {
          // Conexión cerrada.
        }
      }
    },
    lecturas: (sufijo = "") => base.de(`GET ${BASE}${sufijo}`),
  };
}

/** Parámetros de consulta de una llamada (`?pagina=1&tamano=25&…`). */
export function consultaDe(url: string): URLSearchParams {
  const i = url.indexOf("?");
  return new URLSearchParams(i === -1 ? "" : url.slice(i + 1));
}
