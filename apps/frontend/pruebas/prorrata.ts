import { MENSAJES as MENSAJES_ACCESO_LIB } from "../lib/acceso";
import { fechaHoraLima } from "../lib/fechas";
import { rutaSesion, yoDe } from "./acceso";
import { anchosFijosMayoresA390, consultaDeLlamada } from "./aprendizaje";
import { uuidDe } from "./compras";
import { instalarFetchFalso, type FetchFalso, type Manejador } from "./soporte";

// Soporte de las pruebas de 026 · prorrata e IGV estimado (T7, rojo). Es el CONTRATO que fija el frontend para T13:
//  - Textos visibles (`MENSAJES_PRORRATA`): T13 los define en `lib/prorrata.ts` con estos mismos textos (como 025 hizo con
//    `pruebas/aprendizaje.ts` y `lib/aprendizaje.ts`).
//  - Rutas del plan 026 (Contratos: HTTP), bajo `/api`.
//  - Datos de prueba como objetos planos con la forma de `prorrataVistaSchema` e `historialMesVistaSchema` (plan, Contratos:
//    shared; fijadas por T2 en `packages/shared/src/prorrata/vistas-026.spec.ts`). No importan esquemas nuevos de
//    `@contapp/shared` para que estas pruebas no dependan del orden de T9.
// Formatos que T13 debe respetar (decisiones de T7, ver el resultado de la tarea):
//  - Porcentajes: «NN.NN» del servidor se muestran con coma decimal y « %» («87,34 %», «100,00 %»).
//  - Montos: la cadena del servidor tal cual, con punto decimal y signo («100000.00», «-5000.00»), como en 013 y 014.
//  - Periodos: «AAAAMM» se muestra «AAAA-MM» (`etiquetaPeriodo`).
//  - El «saldo a favor» se muestra en valor absoluto (el signo ya lo dice la etiqueta).
// Solo datos de prueba; los motivos hostiles y los nombres son de ejemplo.

export const CLIENTE_PRORRATA = "c-1";
export const PERIODO_M = "202610";
export const TRABAJO_DECLARACIONES_ID = uuidDe(26, 900);
export const TIPO_TRABAJO_DECLARACIONES = "sol.declaraciones.descargar";
/** Instante de la última obtención y su texto en hora de Lima (10:00 a. m.): sale de `lib/fechas`. */
export const OBTENIDA_EN = "2026-11-22T15:00:00.000Z";
export const OBTENIDA_EN_LIMA = fechaHoraLima(OBTENIDA_EN);

export const PERMISOS_GESTIONAR = ["clientes.ver", "prorrata.ver", "prorrata.gestionar"];
export const PERMISOS_SOLO_VER = ["clientes.ver", "prorrata.ver"];

export const rutaProrrata = (clienteId = CLIENTE_PRORRATA) => `/api/clientes/${clienteId}/prorrata`;
export const RUTA_VISTA = `GET ${rutaProrrata()}`;
export const RUTA_OBTENER = `POST ${rutaProrrata()}/declaraciones`;
export const rutaMes = (periodo: string) => `PUT ${rutaProrrata()}/meses/${periodo}`;
export const rutaEliminarMes = (periodo: string) => `POST ${rutaProrrata()}/meses/${periodo}/eliminar`;
export const rutaUsada = (periodo: string) => `PUT ${rutaProrrata()}/usada/${periodo}`;
export const rutaHistorial = (periodo: string) => `GET ${rutaProrrata()}/meses/${periodo}/historial`;

/** «202511» → «2025-11» (como se muestra el periodo en la pantalla). */
export const etiquetaPeriodo = (periodo: string): string => `${periodo.slice(0, 4)}-${periodo.slice(4)}`;

/** Los 12 periodos que terminan en `periodo`, de M−11 a M (R-1). */
export function ventanaDe(periodo: string): string[] {
  let anio = Number(periodo.slice(0, 4));
  let mes = Number(periodo.slice(4));
  const salida: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    salida.unshift(`${anio}${String(mes).padStart(2, "0")}`);
    mes -= 1;
    if (mes === 0) {
      mes = 12;
      anio -= 1;
    }
  }
  return salida;
}

export const VENTANA_M = ventanaDe(PERIODO_M);

export type OrigenMesPrueba = "declarado" | "manual" | "sire" | "falta";
export type AvisoMesPrueba = "usd_sin_tipo_cambio" | "sire_sin_exportaciones" | "manual_reemplazado";
export type AvisoCoeficientePrueba = "numerador_cero" | "exportaciones_en_sire";

export interface MesPrueba {
  periodo: string;
  origen: OrigenMesPrueba;
  gravadas: string;
  exportaciones: string;
  noGravadas: string;
  total: string;
  avisos: AvisoMesPrueba[];
  declaracion: {
    numeroOrden: string;
    fechaPresentacion: string;
    tipo: "original" | "rectificatoria";
    presentaciones: number;
  } | null;
  manual: { motivo: string; autor: { id: string; nombre: string }; guardadoEn: string } | null;
  versionManual: number;
  sireCargado: boolean;
}

/** Mes declarado (PDT 621 original) con 100000.00 gravadas y 20000.00 no gravadas. */
export function mesDe(periodo: string, parcial: Partial<MesPrueba> = {}): MesPrueba {
  return {
    periodo,
    origen: "declarado",
    gravadas: "100000.00",
    exportaciones: "0.00",
    noGravadas: "20000.00",
    total: "120000.00",
    avisos: [],
    declaracion: { numeroOrden: "7654321", fechaPresentacion: "2026-11-10", tipo: "original", presentaciones: 1 },
    manual: null,
    versionManual: 0,
    sireCargado: false,
    ...parcial,
  };
}

export const AUTOR_MANUAL = { id: uuidDe(5, 1), nombre: "Rosa Quispe" };
export const MOTIVO_MANUAL = "Libro de ventas físico, mes sin PDT";

/** Mes ingresado a mano (versión 2) con los mismos montos que `mesDe`. */
export const mesManualDe = (periodo: string, parcial: Partial<MesPrueba> = {}): MesPrueba =>
  mesDe(periodo, {
    origen: "manual",
    declaracion: null,
    manual: { motivo: MOTIVO_MANUAL, autor: AUTOR_MANUAL, guardadoEn: "2026-11-20T15:30:00.000Z" },
    versionManual: 2,
    ...parcial,
  });

/** Mes tomado de las ventas del SIRE (013): exportaciones 0 y su aviso. */
export const mesSireDe = (periodo: string, parcial: Partial<MesPrueba> = {}): MesPrueba =>
  mesDe(periodo, { origen: "sire", declaracion: null, sireCargado: true, avisos: ["sire_sin_exportaciones"], ...parcial });

/** Mes sin ningún origen: montos en «0.00». */
export const mesFaltaDe = (periodo: string, parcial: Partial<MesPrueba> = {}): MesPrueba =>
  mesDe(periodo, {
    origen: "falta",
    gravadas: "0.00",
    exportaciones: "0.00",
    noGravadas: "0.00",
    total: "0.00",
    declaracion: null,
    ...parcial,
  });

export interface ProrrataVistaPrueba {
  periodo: string;
  ventana: MesPrueba[];
  coeficiente: Record<string, unknown>;
  igvEstimado: Record<string, unknown>;
  diferencia: { diferencia: string; alerta: boolean } | null;
  ultimaObtencion: { obtenidaEn: string; periodosSinDeclaracion: string[] } | null;
  prorrataUsada: { valor: string; origen: "declarada" | "ingresada" } | null;
  versionUsada: number;
}

export const coeficienteDe = (parcial: Record<string, unknown> = {}): Record<string, unknown> => ({
  estado: "calculado",
  porcentaje: "83.33",
  numerador: "1200000.00",
  total: "1440000.00",
  provisional: false,
  avisos: [],
  ...parcial,
});

export const igvDe = (parcial: Record<string, unknown> = {}): Record<string, unknown> => ({
  estado: "calculado",
  igvVentas: "18000.00",
  creditoDg: "9000.00",
  igvDgng: "3600.00",
  creditoDgng: "3000.00",
  igvDng: "180.00",
  resultado: "6000.00",
  situacion: "a_pagar",
  estadoPeriodoCompras: "revisado",
  ...parcial,
});

/** Vista de CA-1: 12 meses declarados, coeficiente 83,33 %, IGV a pagar, sin prorrata usada ni diferencia. */
export function vistaDe(parcial: Partial<ProrrataVistaPrueba> = {}): ProrrataVistaPrueba {
  const periodo = parcial.periodo ?? PERIODO_M;
  return {
    periodo,
    ventana: ventanaDe(periodo).map((p) => mesDe(p)),
    coeficiente: coeficienteDe(),
    igvEstimado: igvDe(),
    diferencia: null,
    ultimaObtencion: { obtenidaEn: OBTENIDA_EN, periodosSinDeclaracion: [] },
    prorrataUsada: null,
    versionUsada: 0,
    ...parcial,
  };
}

/** Reemplaza un mes de la ventana (por periodo) dejando los demás. */
export const conMes = (vista: ProrrataVistaPrueba, mes: MesPrueba): ProrrataVistaPrueba => ({
  ...vista,
  ventana: vista.ventana.map((m) => (m.periodo === mes.periodo ? mes : m)),
});

/** Los cuatro orígenes (CA-3): falta 2025-11, manual 2025-12, SIRE 2026-01, rectificatoria 2026-02, el resto declarado. */
export function ventanaMixta(): MesPrueba[] {
  return ventanaDe(PERIODO_M).map((p) => {
    if (p === "202511") return mesFaltaDe(p);
    if (p === "202512") return mesManualDe(p);
    if (p === "202601") return mesSireDe(p);
    if (p === "202602")
      return mesDe(p, {
        declaracion: { numeroOrden: "7654399", fechaPresentacion: "2026-11-12", tipo: "rectificatoria", presentaciones: 2 },
      });
    return mesDe(p);
  });
}

export interface HistorialPrueba {
  declaraciones: Array<{
    numeroOrden: string;
    fechaPresentacion: string;
    tipo: "original" | "rectificatoria";
    gravadas: string;
    exportaciones: string;
    noGravadas: string;
    prorrataUsada: string | null;
    obtenidaEn: string;
  }>;
  manual: Array<{
    version: number;
    accion: "guardado" | "eliminado";
    montos: { gravadas: string; exportaciones: string; noGravadas: string } | null;
    motivo: string;
    autor: { id: string; nombre: string };
    en: string;
  }>;
}

export const historialDe = (parcial: Partial<HistorialPrueba> = {}): HistorialPrueba => ({
  declaraciones: [],
  manual: [],
  ...parcial,
});

/** Textos visibles de la pantalla (T13 los define en `lib/prorrata.ts`). */
export const MENSAJES_PRORRATA = {
  titulo: "Prorrata e IGV estimado",
  campoPeriodo: "Mes de cálculo",
  /** El selector ofrece el mes en curso (Lima) y los 23 anteriores, del más reciente al más antiguo. */
  mesesOfrecidos: 24,
  obtener: "Obtener declaraciones",
  obteniendo: "Obteniendo declaraciones…",
  obtencionFallida: "No se pudieron obtener las declaraciones. Inténtalo de nuevo.",
  /** Con espacios normalizados: la hora de Lima trae un espacio fino (U+202F) que `testing-library` normaliza en el DOM. */
  ultimaObtencion: (iso: string) => `Última obtención: ${fechaHoraLima(iso)}`.replace(/\s+/g, " "),
  sinObtencion: "Aún no se obtuvieron declaraciones de este cliente.",
  sinDeclaracion: (periodos: readonly string[]) => `Sin declaración en: ${periodos.map(etiquetaPeriodo).join(", ")}`,
  noEncontrado: MENSAJES_ACCESO_LIB.noEncontrado,
  sinPermiso: MENSAJES_ACCESO_LIB.sinPermiso,
  errorCarga: "No se pudo cargar la prorrata. Inténtalo de nuevo.",
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
  origen: {
    declarado: "Declarado",
    rectificatoria: "Rectificatoria",
    manual: "Manual",
    sire: "SIRE",
    falta: "Falta",
  },
  ingresarAMano: (periodo: string) => `Ingresar a mano ${etiquetaPeriodo(periodo)}`,
  historial: (periodo: string) => `Historial ${etiquetaPeriodo(periodo)}`,
  avisosMes: {
    usd_sin_tipo_cambio: "Hay ventas en USD sin tipo de cambio: no se incluyen en este mes.",
    sire_sin_exportaciones:
      "El SIRE no separa exportaciones: si el cliente exportó este mes, ingrésalo a mano",
    manual_reemplazado: "Reemplazado por la declaración",
  },

  // Gráfico (D-8)
  tituloGrafico: "Ventas gravadas y exportaciones frente a no gravadas, por mes",
  tablaGrafico: "Datos del gráfico",
  columnasGrafico: { mes: "Mes", gravadasMasExportaciones: "Gravadas más exportaciones", noGravadas: "No gravadas" },

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
  noEstimable: {
    coeficiente: "No se puede estimar el IGV: primero hay que determinar el coeficiente de prorrata.",
    sin_ventas: "No se puede estimar el IGV: falta cargar las ventas del periodo.",
    sin_compras: "No se puede estimar el IGV: falta cargar las compras del periodo.",
  },

  // Mes manual (R-5, U-4)
  tituloManual: (periodo: string) => `Ingresar mes ${etiquetaPeriodo(periodo)} a mano`,
  campos: {
    gravadas: "Ventas gravadas",
    exportaciones: "Exportaciones",
    noGravadas: "Ventas no gravadas",
    motivo: "Motivo",
  },
  guardar: "Guardar",
  cancelar: "Cancelar",
  eliminarManual: "Eliminar mes manual",
  confirmarEliminar: "Confirmar eliminación",
  montoInvalido: "Escribe el monto con hasta 2 decimales, por ejemplo 1234.50.",
  motivoObligatorio: "Escribe el motivo.",
  motivoLargo: "El motivo admite hasta 500 caracteres.",

  // Historial (D-4)
  tituloHistorial: (periodo: string) => `Historial de ${etiquetaPeriodo(periodo)}`,
  tablaDeclaraciones: "Declaraciones del mes",
  tablaVersiones: "Versiones manuales del mes",
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

/** Valor (`<dd>`) del `<dt>` con ese texto exacto: el contrato del IGV estimado es una lista de definiciones. */
export function valorDe(etiqueta: string, raiz: ParentNode = document.body): string {
  const dt = [...raiz.querySelectorAll("dt")].find((d) => d.textContent?.trim() === etiqueta);
  if (!dt) throw new Error(`no hay <dt> «${etiqueta}»`);
  const dd = dt.nextElementSibling;
  if (!dd || dd.tagName !== "DD") throw new Error(`el <dt> «${etiqueta}» no va seguido de <dd>`);
  return dd.textContent?.trim() ?? "";
}

export interface OpcionesProrrata {
  /** Una vista fija o una función del periodo pedido (`?periodo=AAAAMM`). */
  vista?: ProrrataVistaPrueba | ((periodo: string | null) => ProrrataVistaPrueba);
  permisos?: string[];
  extra?: Record<string, Manejador>;
}

/** `fetch` simulado de las rutas de 026: sesión, permisos y la lectura. Las escrituras las declara cada prueba en `extra`. */
export function instalarFetchProrrata(o: OpcionesProrrata = {}): FetchFalso {
  const vista = o.vista ?? vistaDe();
  return instalarFetchFalso({
    ...rutaSesion(),
    "GET /api/acceso/yo": {
      status: 200,
      cuerpo: yoDe("contador", o.permisos ?? PERMISOS_GESTIONAR),
    },
    [RUTA_VISTA]: (llamada) => ({
      status: 200,
      cuerpo: typeof vista === "function" ? vista(consultaDeLlamada(llamada.url).get("periodo")) : vista,
    }),
    ...o.extra,
  });
}

export { anchosFijosMayoresA390, consultaDeLlamada };
