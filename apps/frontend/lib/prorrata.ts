import {
  LARGO_MAX_MOTIVO_PRORRATA,
  MONTO_PRORRATA_RE,
  PORCENTAJE_USADA_RE,
  guardarMesManualSchema,
  historialMesVistaSchema,
  prorrataVistaSchema,
  type CoeficienteVista,
  type GuardarMesManual,
  type GuardarProrrataUsada,
  type HistorialMesVista,
  type IgvEstimadoVista,
  type MesVista,
  type ProrrataVista,
} from "@contapp/shared";
import { MENSAJES } from "./acceso";
import { fechaHoraLima, ZONA_LIMA } from "./fechas";
import { pedir, type Esquema, type ResultadoReglas } from "./reglas";

// Prorrata e IGV estimado (spec 026, T13; plan, Contratos: HTTP y Frontend). Cliente HTTP, textos y ayudas de fecha de la
// pantalla de prorrata de un cliente. Toda respuesta con cuerpo se valida con `@contapp/shared`; los errores salen en
// español, nunca con el código. Los montos y porcentajes son cadenas del servidor: aquí solo se formatean y se validan con las
// mismas gramáticas de `shared`; ningún cálculo de negocio. Los textos son los que fijó T7 en `pruebas/prorrata.ts`.

export type { CoeficienteVista, HistorialMesVista, IgvEstimadoVista, MesVista, ProrrataVista };

export const PERMISO_PRORRATA_VER = "prorrata.ver";
export const PERMISO_PRORRATA_GESTIONAR = "prorrata.gestionar";

/** «202511» → «2025-11» (como se muestra el periodo en la pantalla). */
export const etiquetaPeriodo = (periodo: string): string => `${periodo.slice(0, 4)}-${periodo.slice(4)}`;

export const MENSAJES_PRORRATA = {
  titulo: "Prorrata e IGV estimado",
  enlaceProrrata: "Prorrata",
  volverCliente: "Volver al cliente",
  cargando: "Cargando prorrata…",
  reintentar: "Reintentar",
  campoPeriodo: "Mes de cálculo",
  /** El selector ofrece el mes en curso (Lima) y los 23 anteriores, del más reciente al más antiguo. */
  mesesOfrecidos: 24,
  obtener: "Obtener declaraciones",
  obteniendo: "Obteniendo declaraciones…",
  obtencionFallida: "No se pudieron obtener las declaraciones. Inténtalo de nuevo.",
  /** Con espacios normalizados: la hora de Lima trae un espacio fino (U+202F). */
  ultimaObtencion: (iso: string) => `Última obtención: ${fechaHoraLima(iso)}`.replace(/\s+/g, " "),
  sinObtencion: "Aún no se obtuvieron declaraciones de este cliente.",
  sinDeclaracion: (periodos: readonly string[]) => `Sin declaración en: ${periodos.map(etiquetaPeriodo).join(", ")}`,
  noEncontrado: MENSAJES.noEncontrado,
  sinPermiso: MENSAJES.sinPermiso,
  errorCarga: "No se pudo cargar la prorrata. Inténtalo de nuevo.",
  solicitudInvalida: "Revisa los datos ingresados e inténtalo de nuevo.",
  /** D-2: aviso propio de la tarjeta de prorrata usada cuando otra persona cambió el valor mientras se editaba. */
  usadaCambiada: "La prorrata usada cambió mientras la editabas. Se muestra el valor vigente: revísalo e inténtalo de nuevo.",
  errores: {
    cliente_archivado: "El cliente está archivado: la prorrata es de solo lectura.",
    credencial_no_configurada: "Primero guarda la clave SOL del cliente.",
    credencial_invalida: "La clave SOL fue rechazada por SUNAT. Actualízala para obtener las declaraciones.",
    periodo_futuro: "El mes no puede ser posterior al mes en curso.",
    mes_cambiado: "El mes cambió mientras lo editabas. Cierra el diálogo, revisa los montos vigentes e inténtalo de nuevo.",
    mes_declarado: "Este mes ya tiene una declaración (PDT 621): no se puede ingresar a mano.",
    prorrata_declarada: "La prorrata usada ya viene en el PDT 621: no se puede ingresar a mano.",
  },

  // Tabla de meses (D-8, R-5)
  tablaMeses: "Meses de la ventana de prorrata",
  columnas: {
    mes: "Mes",
    gravadas: "Ventas gravadas",
    exportaciones: "Exportaciones",
    noGravadas: "Ventas no gravadas",
    total: "Total",
    origen: "Origen",
  },
  columnaAcciones: "Acciones",
  origen: {
    declarado: "Declarado",
    rectificatoria: "Rectificatoria",
    manual: "Manual",
    sire: "SIRE",
    falta: "Falta",
  },
  detalleDeclaracion: (numeroOrden: string, fecha: string, presentaciones: number) =>
    `N.º de orden ${numeroOrden}, presentada el ${fecha}${presentaciones > 1 ? ` (${presentaciones} presentaciones)` : ""}`,
  detalleManual: (autor: string, cuando: string) => `Ingresado por ${autor} el ${cuando}`,
  botonIngresar: "Ingresar a mano",
  botonHistorial: "Historial",
  ingresarAMano: (periodo: string) => `Ingresar a mano ${etiquetaPeriodo(periodo)}`,
  historial: (periodo: string) => `Historial ${etiquetaPeriodo(periodo)}`,
  avisosMes: {
    usd_sin_tipo_cambio: "Hay ventas en USD sin tipo de cambio: no se incluyen en este mes.",
    sire_sin_exportaciones: "El SIRE no separa exportaciones: si el cliente exportó este mes, ingrésalo a mano",
    manual_reemplazado: "Reemplazado por la declaración",
  },

  // Gráfico (D-8)
  tituloGrafico: "Ventas gravadas y exportaciones frente a no gravadas, por mes",
  tablaGrafico: "Datos del gráfico",
  columnasGrafico: { mes: "Mes", gravadasMasExportaciones: "Gravadas más exportaciones", noGravadas: "No gravadas" },
  leyendaNegativo: "Las barras con borde marcado son meses con total negativo (más notas de crédito que ventas).",

  // Coeficiente (R-3, R-4, R-6)
  tituloCoeficiente: "Coeficiente de prorrata",
  porcentaje: (n: string) => `${n.replace(".", ",")} %`,
  provisional: "Provisional",
  avisosCoeficiente: {
    numerador_cero: "Ninguna venta es gravada ni exportación: el coeficiente es 0,00 %. Revisa si esas compras son DNG.",
    exportaciones_en_sire: "Este cliente declaró exportaciones: revisa los meses SIRE",
  },
  faltanMeses: "Faltan meses para calcular el coeficiente. Ingrésalos a mano (con montos en 0 si no hubo operaciones):",
  ingresarFaltante: (periodo: string) => `Ingresar el mes ${etiquetaPeriodo(periodo)}`,
  noDeterminable: {
    total_cero: "No determinable: las ventas de la ventana suman cero.",
    acumulado_invalido:
      "No determinable: los montos acumulados de la ventana son inconsistentes. Revisa los meses con notas de crédito o ingresados a mano.",
    montos_fuera_de_rango:
      "No determinable: los montos de la ventana superan el máximo que se puede calcular. Revisa los meses con montos muy grandes.",
  },

  // IGV estimado (R-7, U-8)
  tituloIgv: "IGV estimado del mes",
  componentes: {
    igvVentas: "IGV de ventas",
    creditoDg: "Crédito fiscal de compras DG",
    igvDgng: "IGV de compras DGNG",
    creditoDgng: "Crédito de compras DGNG (por la prorrata)",
    igvDng: "IGV de compras DNG (sin crédito)",
  },
  situacion: { a_pagar: "A pagar", saldo_a_favor: "Saldo a favor", cero: "Cero" },
  estadoCompras: {
    abierto: "Periodo de compras abierto",
    revisado: "Periodo de compras revisado",
    generado: "Periodo de compras generado",
  },
  notaEstimado: "Estimado: no incluye saldo a favor anterior, percepciones ni retenciones",
  avisosIgv: { ventas_usd_sin_tipo_cambio: "Hay ventas en USD sin tipo de cambio; no se incluyeron" },
  noEstimable: {
    coeficiente: "No se puede estimar el IGV: primero hay que determinar el coeficiente de prorrata.",
    sin_ventas: "No se puede estimar el IGV: falta cargar las ventas del periodo.",
    sin_compras: "No se puede estimar el IGV: falta cargar las compras del periodo.",
  },

  // Mes manual (R-5, U-4)
  tituloManual: (periodo: string) => `Ingresar mes ${etiquetaPeriodo(periodo)} a mano`,
  descripcionManual: "Montos del mes completo, en soles, con hasta 2 decimales. Escribe 0 si no hubo operaciones.",
  descripcionEliminar: "Se eliminará el mes ingresado a mano. Queda en el historial con el motivo que escribas.",
  campos: {
    gravadas: "Ventas gravadas",
    exportaciones: "Exportaciones",
    noGravadas: "Ventas no gravadas",
    motivo: "Motivo",
  },
  guardar: "Guardar",
  guardando: "Guardando…",
  cancelar: "Cancelar",
  eliminarManual: "Eliminar mes manual",
  confirmarEliminar: "Confirmar eliminación",
  montoInvalido: "Escribe el monto con hasta 2 decimales, por ejemplo 1234.50.",
  motivoObligatorio: "Escribe el motivo.",
  motivoLargo: "El motivo admite hasta 500 caracteres.",
  motivoInvalido: "El motivo no admite saltos de línea ni caracteres de control.",

  // Historial (D-4)
  tituloHistorial: (periodo: string) => `Historial de ${etiquetaPeriodo(periodo)}`,
  descripcionHistorial: "Presentaciones del PDT 621 y versiones del mes ingresado a mano.",
  cargandoHistorial: "Cargando historial…",
  tablaDeclaraciones: "Declaraciones del mes",
  tablaVersiones: "Versiones manuales del mes",
  columnasHistorial: {
    numeroOrden: "N.º de orden",
    tipo: "Tipo",
    fecha: "Presentada",
    prorrataUsada: "Prorrata usada",
    obtenida: "Obtenida",
    version: "Versión",
    accion: "Acción",
    motivo: "Motivo",
    autor: "Autor",
    en: "Fecha",
  },
  tipoDeclaracion: { original: "Original", rectificatoria: "Rectificatoria" },
  accionManual: { guardado: "Guardado", eliminado: "Eliminado" },
  sinHistorial: "Este mes no tiene declaraciones ni versiones manuales.",
  cerrar: "Cerrar",

  // Prorrata usada (R-8, U-9, U-10)
  tituloUsada: "Prorrata usada en la declaración",
  origenUsada: { declarada: "Declarada en el PDT 621", ingresada: "Ingresada por el contador" },
  sinUsada: "No hay prorrata usada registrada para este mes.",
  campoUsada: "Prorrata usada (%)",
  guardarUsada: "Guardar prorrata usada",
  quitarUsada: "Quitar prorrata ingresada",
  porcentajeInvalido: "Escribe un porcentaje entre 0 y 100 con hasta 2 decimales.",
  alertaDiferencia: (calculada: string, usada: string, origen: "declarada" | "ingresada", diferencia: string) =>
    `La prorrata calculada (${calculada.replace(".", ",")} %) no coincide con la usada (${usada.replace(".", ",")} %, ${
      origen === "declarada" ? "declarada en el PDT 621" : "ingresada por el contador"
    }). Diferencia: ${diferencia.replace(".", ",")} puntos.`,
} as const;

const M = MENSAJES_PRORRATA;

// ---------------------------------------------------------------------------------------------
// Mes de cálculo (R-1): el mes en curso y el periodo por omisión, en hora de Lima
// ---------------------------------------------------------------------------------------------

const AAAA_MM_LIMA = new Intl.DateTimeFormat("en-CA", { timeZone: ZONA_LIMA, year: "numeric", month: "2-digit" });

/** Mes en curso en hora de Lima («AAAAMM»), con reloj inyectable. */
export function mesEnCursoLima(ahora: Date = new Date()): string {
  const partes = AAAA_MM_LIMA.formatToParts(ahora);
  const anio = partes.find((p) => p.type === "year")?.value ?? "";
  const mes = partes.find((p) => p.type === "month")?.value ?? "";
  return `${anio}${mes}`;
}

/** Retrocede `n` meses desde un periodo «AAAAMM» (aritmética de calendario, no de dinero). */
export function restarMeses(periodo: string, n: number): string {
  const total = Number(periodo.slice(0, 4)) * 12 + (Number(periodo.slice(4)) - 1) - n;
  const anio = Math.floor(total / 12);
  const mes = (total % 12) + 1;
  return `${anio}${String(mes).padStart(2, "0")}`;
}

/** Los 24 meses del selector: el en curso y los 23 anteriores, del más reciente al más antiguo. */
export const mesesOfrecidos = (enCurso: string): string[] =>
  Array.from({ length: M.mesesOfrecidos }, (_, i) => restarMeses(enCurso, i));

/** Periodo por omisión: el mes anterior al en curso. */
export const periodoPorOmision = (enCurso: string): string => restarMeses(enCurso, 1);

// ---------------------------------------------------------------------------------------------
// Medidas del gráfico
// ---------------------------------------------------------------------------------------------

/**
 * Céntimos exactos de un monto del servidor («-1234.5» → -123450n), por lectura del texto: sin `Number` ni `Decimal`.
 * Solo sirve para dar proporciones a las barras; un texto que no es monto vale 0.
 */
export function centimos(monto: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(monto);
  if (!m) return BigInt(0);
  const valor = BigInt(m[2] ?? "0") * BigInt(100) + BigInt((m[3] ?? "").padEnd(2, "0") || "0");
  return m[1] ? -valor : valor;
}

// ---------------------------------------------------------------------------------------------
// Validación local de los formularios (las mismas gramáticas de `shared`; el servidor valida de todos modos)
// ---------------------------------------------------------------------------------------------

export const montoValido = (texto: string): boolean => MONTO_PRORRATA_RE.test(texto);
export const porcentajeUsadaValido = (texto: string): boolean => PORCENTAJE_USADA_RE.test(texto);

export type ErrorMotivo = "obligatorio" | "largo" | "invalido";

/** Motivo ya recortado: obligatorio, hasta 500 caracteres y sin controles ni bidi (como `motivoProrrataSchema`). */
export function errorDeMotivo(motivo: string): ErrorMotivo | null {
  if (motivo === "") return "obligatorio";
  if (motivo.length > LARGO_MAX_MOTIVO_PRORRATA) return "largo";
  const cuerpo = guardarMesManualSchema.shape.motivo.safeParse(motivo);
  return cuerpo.success ? null : "invalido";
}

export const textoErrorMotivo: Record<ErrorMotivo, string> = {
  obligatorio: M.motivoObligatorio,
  largo: M.motivoLargo,
  invalido: M.motivoInvalido,
};

// ---------------------------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------------------------

const codigoDe = (datos: unknown): string => {
  const codigo = (datos as { codigo?: unknown } | null)?.codigo;
  return typeof codigo === "string" ? codigo : "";
};

/** Texto de un error de las escrituras de prorrata; nunca muestra el código, los montos ni el motivo. */
export function mensajeDeErrorProrrata(status: number, datos: unknown): string {
  if (status === 403) return M.sinPermiso;
  if (status === 404) return M.noEncontrado;
  const codigo = codigoDe(datos);
  if ((status === 409 || status === 400) && Object.hasOwn(M.errores, codigo)) {
    return M.errores[codigo as keyof typeof M.errores];
  }
  if (status === 400) return M.solicitudInvalida;
  return MENSAJES.errorGeneral;
}

/** Como `mensajeDeErrorProrrata`, pero el choque de versión de la prorrata usada tiene su propio aviso (no habla de diálogos ni de meses). */
export function mensajeDeErrorUsada(status: number, datos: unknown): string {
  if (status === 409 && codigoDe(datos) === "mes_cambiado") return M.usadaCambiada;
  return mensajeDeErrorProrrata(status, datos);
}

/** Texto de un error de lectura (la vista o el historial). */
export function mensajeDeErrorLectura(status: number): string {
  if (status === 403) return M.sinPermiso;
  if (status === 404) return M.noEncontrado;
  return M.errorCarga;
}

// ---------------------------------------------------------------------------------------------
// Llamadas
// ---------------------------------------------------------------------------------------------

export type ResultadoProrrata<T> = ResultadoReglas<T>;

const esquemaVersion: Esquema<{ version: number }> = {
  safeParse(valor) {
    const version = (valor as { version?: unknown } | null)?.version;
    return typeof version === "number" && Number.isInteger(version) && version >= 0
      ? { success: true, data: { version } }
      : { success: false };
  },
};

const esquemaAceptada: Esquema<{ trabajoId: string }> = {
  safeParse(valor) {
    const id = (valor as { trabajoId?: unknown } | null)?.trabajoId;
    return typeof id === "string" && id !== "" ? { success: true, data: { trabajoId: id } } : { success: false };
  },
};

const base = (clienteId: string): string => `/clientes/${encodeURIComponent(clienteId)}/prorrata`;

/** `GET …/prorrata?periodo=AAAAMM`. */
export const leerProrrata = (clienteId: string, periodo: string) =>
  pedir<ProrrataVista>(`${base(clienteId)}?periodo=${encodeURIComponent(periodo)}`, prorrataVistaSchema, {}, (status) =>
    mensajeDeErrorLectura(status),
  );

/** `GET …/prorrata/meses/:periodo/historial`. */
export const leerHistorialMes = (clienteId: string, periodo: string) =>
  pedir<HistorialMesVista>(
    `${base(clienteId)}/meses/${encodeURIComponent(periodo)}/historial`,
    historialMesVistaSchema,
    {},
    (status) => mensajeDeErrorLectura(status),
  );

/** `POST …/prorrata/declaraciones`: 202 `{trabajoId}`. */
export const obtenerDeclaraciones = (clienteId: string, periodo: string) =>
  pedir(`${base(clienteId)}/declaraciones`, esquemaAceptada, { method: "POST", body: { periodo } }, mensajeDeErrorProrrata);

/** `PUT …/prorrata/meses/:periodo`. */
export const guardarMesManual = (clienteId: string, periodo: string, cuerpo: GuardarMesManual) =>
  pedir(`${base(clienteId)}/meses/${encodeURIComponent(periodo)}`, esquemaVersion, { method: "PUT", body: cuerpo }, mensajeDeErrorProrrata);

/** `POST …/prorrata/meses/:periodo/eliminar`. */
export const eliminarMesManual = (clienteId: string, periodo: string, cuerpo: { motivo: string; version: number }) =>
  pedir(
    `${base(clienteId)}/meses/${encodeURIComponent(periodo)}/eliminar`,
    esquemaVersion,
    { method: "POST", body: cuerpo },
    mensajeDeErrorProrrata,
  );

/** `PUT …/prorrata/usada/:periodo`. */
export const guardarProrrataUsada = (clienteId: string, periodo: string, cuerpo: GuardarProrrataUsada) =>
  pedir(`${base(clienteId)}/usada/${encodeURIComponent(periodo)}`, esquemaVersion, { method: "PUT", body: cuerpo }, mensajeDeErrorUsada);
