import { MENSAJES as MENSAJES_ACCESO_LIB } from "../lib/acceso";
import { rutaSesion, yoDe } from "./acceso";
import type { FilaCompraVista, HallazgoVista } from "@contapp/shared";
import { CLIENTE_ID, filaDe, montosDe, uuidDe } from "./compras";
import { instalarFetchFalso, type FetchFalso, type Manejador } from "./soporte";

// Soporte de las pruebas de 025 · aprendizaje de arranque (T7, rojo). Es el CONTRATO que fija el frontend para T13:
//  - Textos visibles (`MENSAJES_APRENDIZAJE`): T13 los define en `lib/aprendizaje.ts` con estos mismos textos (como 021 hizo
//    con `pruebas/reglas.ts` y `lib/reglas.ts`).
//  - Rutas del plan 025 (Contratos: HTTP), bajo `/api`.
//  - Datos de prueba como objetos planos con la forma de `importacionVistaSchema` y `candidataVistaSchema` (plan, Contratos:
//    shared); no importan esquemas nuevos de `@contapp/shared` para que estas pruebas no dependan del orden de T9.
// Solo datos de prueba; la razón social hostil y los RUC son de ejemplo.

export const RUTA_REGLAS_025 = `/api/clientes/${CLIENTE_ID}/reglas`;
export const RUTA_IMPORTAR = `POST ${RUTA_REGLAS_025}/importaciones`;
export const RUTA_ULTIMA = `GET ${RUTA_REGLAS_025}/importaciones/ultima`;
export const RUTA_CANDIDATAS = `GET ${RUTA_REGLAS_025}/candidatas`;
export const RUTA_ACTIVAR = `POST ${RUTA_REGLAS_025}/candidatas/activar`;
export const RUTA_DESCARTAR = `POST ${RUTA_REGLAS_025}/candidatas/descartar`;
export const rutaReemplazar = (candidataId: string) =>
  `POST ${RUTA_REGLAS_025}/candidatas/${candidataId}/reemplazar`;

export const PERMISOS_GESTIONAR = ["clientes.ver", "reglas.ver", "reglas.gestionar"];
export const PERMISOS_SOLO_VER = ["clientes.ver", "reglas.ver"];

export type DestinoPrueba = "DG" | "DGNG" | "DNG";
export type GrupoCandidatas = "propuestas" | "sin_criterio" | "conflicto" | "resueltas";

export interface ImportacionPrueba {
  id: string;
  estado: "en_curso" | "completada" | "fallida";
  periodos: string[];
  solicitadaPor: { id: string; nombre: string; activo?: boolean };
  solicitadaEn: string;
  terminadaEn: string | null;
  resumen: {
    periodosLeidos: number;
    periodosSinDatos: string[];
    candidatas: number;
    sinCriterio: number;
  } | null;
  motivo: string | null;
  trabajoId: string | null;
}

export interface CandidataPrueba {
  id: string;
  proveedor: { tipo: string; numero: string; razonSocial: string | null };
  destinoPropuesto: DestinoPrueba | null;
  conteos: { DG: number; DGNG: number; DNG: number; mixto: number; total: number };
  periodosConProveedor: number;
  periodosLeidos: number;
  estado: "pendiente" | "activada" | "descartada" | "reemplazada";
  destinoElegido: DestinoPrueba | null;
  regla: { id: string; destino: DestinoPrueba; version: number } | null;
  conflicto: "ninguno" | "ya_aprendida" | "distinto";
}

export const IMPORTACION_ID = uuidDe(25, 1);
export const TRABAJO_IMPORTACION_ID = uuidDe(25, 2);
export const TIPO_TRABAJO_IMPORTAR = "reglas.historial.importar";

/** Una importación completada de 6 periodos (octubre a mayo de 2026), con un periodo sin datos. */
export function importacionDe(parcial: Partial<ImportacionPrueba> = {}): ImportacionPrueba {
  return {
    id: IMPORTACION_ID,
    estado: "completada",
    periodos: ["202610", "202609", "202608", "202607", "202606", "202605"],
    solicitadaPor: { id: uuidDe(5, 1), nombre: "Rosa Quispe", activo: true },
    solicitadaEn: "2026-11-21T15:00:00.000Z",
    terminadaEn: "2026-11-21T15:00:20.000Z",
    resumen: { periodosLeidos: 5, periodosSinDatos: ["202605"], candidatas: 14, sinCriterio: 3 },
    motivo: null,
    trabajoId: TRABAJO_IMPORTACION_ID,
    ...parcial,
  };
}

export function candidataDe(parcial: Partial<CandidataPrueba> = {}): CandidataPrueba {
  return {
    id: uuidDe(26, 1),
    proveedor: { tipo: "6", numero: "20100070970", razonSocial: "PROVEEDOR PRUEBA S.A.C." },
    destinoPropuesto: "DNG",
    conteos: { DG: 0, DGNG: 0, DNG: 11, mixto: 1, total: 12 },
    periodosConProveedor: 5,
    periodosLeidos: 6,
    estado: "pendiente",
    destinoElegido: null,
    regla: null,
    conflicto: "ninguno",
    ...parcial,
  };
}

/** Propuesta DNG: 11 de 12 comprobantes (uno mixto) en 5 de 6 periodos. */
export const CAND_A = candidataDe();
/** Propuesta DG: 5 de 5 en 4 de 6 periodos. */
export const CAND_B = candidataDe({
  id: uuidDe(26, 2),
  proveedor: { tipo: "6", numero: "20700000011", razonSocial: "PRUEBA PROVEEDOR ISC S.A.C." },
  destinoPropuesto: "DG",
  conteos: { DG: 5, DGNG: 0, DNG: 0, mixto: 0, total: 5 },
  periodosConProveedor: 4,
});
/** Sin criterio claro (U-8): 2 en DG y 2 en DNG de 4. */
export const CAND_SIN = candidataDe({
  id: uuidDe(26, 3),
  proveedor: { tipo: "6", numero: "20700000045", razonSocial: "PRUEBA PROVEEDOR MIXTO S.A.C." },
  destinoPropuesto: null,
  conteos: { DG: 2, DGNG: 0, DNG: 2, mixto: 0, total: 4 },
  periodosConProveedor: 3,
});
/** Conflicto distinto: la regla vigente manda a DG y el historial propone DNG. */
export const CAND_DISTINTO = candidataDe({
  id: uuidDe(26, 4),
  proveedor: { tipo: "6", numero: "20700000053", razonSocial: "PRUEBA PROVEEDOR BOLSAS S.A.C." },
  destinoPropuesto: "DNG",
  conteos: { DG: 0, DGNG: 0, DNG: 8, mixto: 0, total: 8 },
  periodosConProveedor: 6,
  regla: { id: uuidDe(7, 40), destino: "DG", version: 3 },
  conflicto: "distinto",
});
/** Conflicto «ya aprendida»: la regla vigente ya manda al mismo destino. */
export const CAND_YA = candidataDe({
  id: uuidDe(26, 5),
  proveedor: { tipo: "6", numero: "20700000061", razonSocial: "PRUEBA PROVEEDOR USD S.A.C." },
  destinoPropuesto: "DNG",
  conteos: { DG: 0, DGNG: 0, DNG: 6, mixto: 0, total: 6 },
  periodosConProveedor: 5,
  regla: { id: uuidDe(7, 41), destino: "DNG", version: 1 },
  conflicto: "ya_aprendida",
});
/** Ya resuelta (activada). */
export const CAND_ACTIVADA = candidataDe({
  id: uuidDe(26, 6),
  proveedor: { tipo: "6", numero: "20700000070", razonSocial: "PRUEBA PROVEEDOR CALZADO S.A.C." },
  estado: "activada",
  destinoElegido: "DNG",
  regla: { id: uuidDe(7, 42), destino: "DNG", version: 1 },
});
export const CAND_DESCARTADA = candidataDe({
  id: uuidDe(26, 7),
  proveedor: { tipo: "1", numero: "12345678", razonSocial: null },
  estado: "descartada",
});

/** El grupo al que el servidor asigna una candidata (D-4 a D-6, U-8). */
export function grupoDe(c: CandidataPrueba): GrupoCandidatas {
  if (c.estado !== "pendiente") return "resueltas";
  if (c.conflicto !== "ninguno") return "conflicto";
  return c.destinoPropuesto === null ? "sin_criterio" : "propuestas";
}

export const TODAS_LAS_CANDIDATAS = [
  CAND_A,
  CAND_B,
  CAND_SIN,
  CAND_DISTINTO,
  CAND_YA,
  CAND_ACTIVADA,
  CAND_DESCARTADA,
];

const R_BASE = {
  // Textos de 021 que 025 reutiliza (se repiten aquí como las demás pruebas de reglas).
  reglaCambiada: "La regla cambió mientras tanto. Revisa las reglas del cliente e inténtalo de nuevo.",
  clienteArchivado: "El cliente está archivado: sus reglas son de solo lectura.",
} as const;

export const MENSAJES_APRENDIZAJE = {
  // Importar (D-4, D-10; U-5).
  importar: "Importar historial",
  tituloImportar: "Importar historial del cliente",
  campoPeriodos: "Periodos",
  periodosPorOmision: "6",
  avisoSinAplicar: "No se aplica nada hasta que actives las reglas que se propongan.",
  confirmarImportar: "Importar",
  cancelar: "Cancelar",
  enCurso: "Importando historial…",
  resumen: (r: { periodosLeidos: number; candidatas: number; sinCriterio: number }) =>
    `${r.periodosLeidos} periodos leídos · ${r.candidatas} candidatas · ${r.sinCriterio} sin criterio claro`,
  sinDatos: (periodos: readonly string[]) => `Sin datos en: ${periodos.join(", ")}`,
  fallida: "La importación falló. Inténtalo de nuevo.",
  sinImportacion: "Aún no has importado el historial de este cliente.",
  errores: {
    importacion_en_curso: "Ya hay una importación en curso para este cliente.",
    credencial_no_configurada: "Configura primero la credencial del SIRE de este cliente.",
    credencial_invalida: "SUNAT rechazó la credencial del SIRE de este cliente. Actualízala e inténtalo de nuevo.",
    cliente_archivado: R_BASE.clienteArchivado,
  },
  noEncontrado: MENSAJES_ACCESO_LIB.noEncontrado,
  sinPermiso: MENSAJES_ACCESO_LIB.sinPermiso,

  // Candidatas (D-5, D-6; U-8).
  tablaCandidatas: "Candidatas del historial",
  pestanas: {
    propuestas: "Propuestas",
    sin_criterio: "Sin criterio claro",
    conflicto: "Con conflicto",
    resueltas: "Resueltas",
  },
  seleccionar: (numero: string) => `Seleccionar candidata de ${numero}`,
  campoDestino: (numero: string) => `Destino de ${numero}`,
  elegirDestino: "Elige un destino",
  activarSeleccionadas: "Activar seleccionadas",
  descartarSeleccionadas: "Descartar seleccionadas",
  activarUna: (numero: string) => `Activar candidata de ${numero}`,
  reemplazar: (numero: string) => `Reemplazar regla de ${numero}`,
  reglaVigente: (destino: string) => `Regla vigente: ${destino}`,
  yaAprendida: "Ya aprendida: la regla vigente tiene este mismo destino.",
  estados: { activada: "Activada", descartada: "Descartada", reemplazada: "Reemplazada" },
  cargarMas: "Cargar más",
  reglasActivadas: (n: number) => (n === 1 ? "1 regla activada." : `${n} reglas activadas.`),
  candidatasDescartadas: (n: number) => (n === 1 ? "1 candidata descartada." : `${n} candidatas descartadas.`),
  reglaReemplazada: "Regla reemplazada.",
  reglaCambiada: R_BASE.reglaCambiada,
  // Activar todas (D-6, U-6).
  activarTodas: "Activar todas",
  confirmarTodas: (activar: number, sinCriterio: number) =>
    `${activar === 1 ? "Se activará 1 regla" : `Se activarán ${activar} reglas`}. Quedan fuera ${
      sinCriterio > 0 ? `${sinCriterio} sin criterio claro y ` : ""
    }las que tengan conflicto con una regla vigente.`,
  confirmar: "Confirmar",
  omitidas: (n: number, motivo: "conflicto" | "ya_aprendida" | "no_pendiente" | "sin_criterio") => {
    const etiqueta = {
      conflicto: "conflicto con una regla vigente",
      ya_aprendida: "ya estaba aprendida",
      no_pendiente: "ya no estaba pendiente",
      sin_criterio: "sin criterio claro",
    }[motivo];
    return `${n} ${n === 1 ? "omitida" : "omitidas"} · ${etiqueta}`;
  },
  avisoPeriodoCargado:
    "Las reglas rigen desde la próxima descarga. Para el periodo que ya está cargado, usa la corrección masiva filtrando por proveedor.",
  irAGrilla: "Ver compras del periodo",

  // Origen de la regla (D-5) y R-STD (D-8).
  origenImportacion: "Importado del historial",
  std: "DNG por perfil del cliente",
  filtroStd: "DNG por perfil del cliente",
  aceptarStd: "Aceptar R-STD",
} as const;

/** «11 de 12 comprobantes en DNG · en 5 de 6 periodos» y, si hay, «· 1 mixto» (los mixtos van aparte). */
export function frecuencia(c: CandidataPrueba): string {
  const d = c.destinoPropuesto!;
  const base = `${c.conteos[d]} de ${c.conteos.total} comprobantes en ${d} · en ${c.periodosConProveedor} de ${c.periodosLeidos} periodos`;
  return c.conteos.mixto > 0 ? `${base} · ${c.conteos.mixto} ${c.conteos.mixto === 1 ? "mixto" : "mixtos"}` : base;
}

/** Para «sin criterio claro»: «2 en DG, 2 en DNG de 4 comprobantes». */
export function conteosSinCriterio(c: CandidataPrueba): string {
  const partes = (["DG", "DGNG", "DNG"] as const)
    .filter((d) => c.conteos[d] > 0)
    .map((d) => `${c.conteos[d]} en ${d}`);
  return `${partes.join(", ")} de ${c.conteos.total} comprobantes`;
}

/** URL de la grilla de compras del periodo (con el proveedor si se filtra por él). */
export const rutaGrilla = (periodo: string, numeroProveedor?: string): string =>
  `/clientes/${CLIENTE_ID}/compras?periodo=${periodo}` +
  (numeroProveedor === undefined ? "" : `&q=${numeroProveedor}`);

/** Consulta de una llamada ya registrada. */
export const consultaDeLlamada = (url: string): URLSearchParams =>
  new URL(url, "http://prueba.local").searchParams;

export interface OpcionesAprendizaje {
  importacion?: ImportacionPrueba | null;
  candidatas?: CandidataPrueba[];
  permisos?: string[];
  extra?: Record<string, Manejador>;
}

/**
 * `fetch` simulado de las rutas de 025: sesión, permisos, última importación y candidatas por grupo con cursor (índice).
 * Las escrituras no tienen respuesta por omisión: cada prueba declara las que usa en `extra`.
 */
export function instalarFetchAprendizaje(o: OpcionesAprendizaje = {}): FetchFalso {
  const importacion = o.importacion === undefined ? importacionDe() : o.importacion;
  const candidatas = o.candidatas ?? TODAS_LAS_CANDIDATAS;
  return instalarFetchFalso({
    ...rutaSesion(),
    "GET /api/acceso/yo": {
      status: 200,
      cuerpo: yoDe("contador", o.permisos ?? PERMISOS_GESTIONAR),
    },
    [RUTA_ULTIMA]: { status: 200, cuerpo: { importacion } },
    [RUTA_CANDIDATAS]: (llamada) => {
      const consulta = consultaDeLlamada(llamada.url);
      const grupo = consulta.get("grupo") ?? "propuestas";
      const limite = Number(consulta.get("limite") ?? "100");
      const desde = Number(consulta.get("cursor") ?? "0");
      const lista = candidatas.filter((c) => grupoDe(c) === grupo);
      const hasta = desde + limite;
      return {
        status: 200,
        cuerpo: {
          candidatas: lista.slice(desde, hasta),
          siguiente: hasta < lista.length ? String(hasta) : null,
        },
      };
    },
    ...o.extra,
  });
}

/** Ancho fijo en px (clases `w-[Npx]` o `min-w-[Npx]`) de cualquier elemento bajo `raiz` que no cabe en 390 px. */
export function anchosFijosMayoresA390(raiz: ParentNode): string[] {
  const hallazgos: string[] = [];
  for (const el of raiz.querySelectorAll<HTMLElement>("[class]")) {
    const clases = String(el.getAttribute("class") ?? "");
    for (const m of clases.matchAll(/(?:^|\s)(?:min-w|w)-\[(\d+)px\]/g)) {
      if (Number(m[1]) >= 390) hallazgos.push(`${el.tagName.toLowerCase()}.${m[0].trim()}`);
    }
    if (/(?:^|\s)overflow-x-auto(?:\s|$)/.test(clases)) hallazgos.push(`${el.tagName.toLowerCase()}.overflow-x-auto`);
  }
  return hallazgos;
}

// ---------------------------------------------------------------------------------------------
// R-STD en la grilla (D-8, U-3): hallazgo y fila de ejemplo. `HallazgoVista.regla` aún no admite «R-STD» en `shared` (T9).
// ---------------------------------------------------------------------------------------------

export const HALLAZGO_STD = {
  regla: "R-STD",
  destino: "DNG",
  explicacion: "DNG por perfil del cliente",
  sugerencia: { tipo: "clasificar" },
  requiereConfirmacion: false,
  dato: null,
  masiva: true,
} as unknown as HallazgoVista;

/** Compra sin clasificar de un proveedor sin regla, con base gravada en DG, en un cliente de la Amazonía (U-4). */
export const FILA_STD: FilaCompraVista = filaDe({
  id: uuidDe(1, 6001),
  numero: "6001",
  proveedor: { tipo: "6", numero: "20700000088", razonSocial: "PRUEBA PROVEEDOR AMAZONIA S.A.C." },
  fecha: "2026-10-20",
  montos: montosDe({ biDg: "100.00", igvDg: "18.00" }),
  clasificada: false,
  hallazgos: [HALLAZGO_STD],
});
