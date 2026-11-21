import {
  candidataVistaSchema,
  importacionVistaSchema,
  respuestaActivarSchema,
  type ActivarCandidatas,
  type CandidataVista,
  type DescartarCandidatas,
  type DestinoCompra,
  type GrupoCandidatas,
  type ImportacionVista,
  type MotivoOmisionCandidata,
  type ReemplazarCandidata,
  type RespuestaActivar,
  type SolicitarImportacion,
} from "@contapp/shared";
import { MENSAJES } from "./acceso";
import {
  MENSAJES_REGLAS,
  mensajeDeErrorReglas,
  pedir,
  rutaReglas,
  type Esquema,
  type ResultadoReglas,
} from "./reglas";

// Aprendizaje de arranque (spec 025, T13; plan, Contratos: HTTP y Frontend). Cliente HTTP y textos de importar el
// historial del SIRE, revisar las candidatas y activarlas. Toda respuesta con cuerpo se valida con `@contapp/shared`; un
// 409 sale en español, nunca con el código. Los textos son los que fijó T7 en `pruebas/aprendizaje.ts`.

export type { CandidataVista, GrupoCandidatas, ImportacionVista, MotivoOmisionCandidata, RespuestaActivar };

export const PERMISO_APRENDIZAJE_GESTIONAR = "reglas.gestionar";

// ---------------------------------------------------------------------------------------------
// Textos (una sola fuente para las piezas y las pruebas)
// ---------------------------------------------------------------------------------------------

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
    cliente_archivado: MENSAJES_REGLAS.clienteArchivado,
  },
  noEncontrado: MENSAJES.noEncontrado,
  sinPermiso: MENSAJES.sinPermiso,

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
  reglaInactiva: "La regla está desactivada: no se aplica a este proveedor. Se reactiva desde la página de reglas.",
  estados: { activada: "Activada", descartada: "Descartada", reemplazada: "Reemplazada" },
  cargarMas: "Cargar más",
  reglasActivadas: (n: number) => (n === 1 ? "1 regla activada." : `${n} reglas activadas.`),
  candidatasDescartadas: (n: number) => (n === 1 ? "1 candidata descartada." : `${n} candidatas descartadas.`),
  reglaReemplazada: "Regla reemplazada.",
  reglaCambiada: MENSAJES_REGLAS.reglaCambiada,
  // Activar todas (D-6, U-6).
  activarTodas: "Activar todas",
  confirmarTodas: (activar: number, sinCriterio: number) =>
    `${activar === 1 ? "Se activará 1 regla" : `Se activarán ${activar} reglas`}. Quedan fuera ${
      sinCriterio > 0 ? `${sinCriterio} sin criterio claro y ` : ""
    }las que tengan conflicto con una regla vigente.`,
  confirmar: "Confirmar",
  omitidas: (n: number, motivo: MotivoOmisionCandidata) => {
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

  // Solo de la pantalla (no los fija T7).
  aceptarStdSinSugerencia: "Ninguna de las compras seleccionadas tiene una sugerencia R-STD para aceptar.",
  cargandoCandidatas: "Cargando candidatas…",
  sinCandidatas: "No hay candidatas en este grupo.",
  destinoPropuesto: (destino: string) => `Destino propuesto: ${destino}`,
  destinoElegido: (destino: string) => `Destino elegido: ${destino}`,
} as const;

const M = MENSAJES_APRENDIZAJE;

/** «11 de 12 comprobantes en DNG · en 5 de 6 periodos» y, si hay, «· 1 mixto» (los mixtos van aparte). */
export function frecuencia(c: CandidataVista): string {
  const d = c.destinoPropuesto;
  if (d === null) return "";
  const base = `${c.conteos[d]} de ${c.conteos.total} comprobantes en ${d} · en ${c.periodosConProveedor} de ${c.periodosLeidos} periodos`;
  return c.conteos.mixto > 0 ? `${base} · ${c.conteos.mixto} ${c.conteos.mixto === 1 ? "mixto" : "mixtos"}` : base;
}

/** Para «sin criterio claro»: «2 en DG, 2 en DNG de 4 comprobantes». */
export function conteosSinCriterio(c: CandidataVista): string {
  const partes = (["DG", "DGNG", "DNG"] as const).filter((d) => c.conteos[d] > 0).map((d) => `${c.conteos[d]} en ${d}`);
  return `${partes.join(", ")} de ${c.conteos.total} comprobantes`;
}

/** URL de la grilla de compras del periodo, con el proveedor (RUC) si se filtra por él (U-6). */
export const rutaGrilla = (clienteId: string, periodo: string, numeroProveedor?: string): string =>
  `/clientes/${encodeURIComponent(clienteId)}/compras?periodo=${encodeURIComponent(periodo)}` +
  (numeroProveedor === undefined ? "" : `&q=${encodeURIComponent(numeroProveedor)}`);

/**
 * El periodo de la grilla al que enlaza el aviso de U-6: el siguiente al más reciente de los importados (la importación
 * va del mes anterior hacia atrás). Sin periodos válidos, `null`.
 */
export function periodoDespuesDe(periodos: readonly string[]): string | null {
  const validos = periodos.filter((p) => /^[0-9]{4}(0[1-9]|1[0-2])$/.test(p));
  if (validos.length === 0) return null;
  const ultimo = [...validos].sort().at(-1)!;
  const anio = Number(ultimo.slice(0, 4));
  const mes = Number(ultimo.slice(4));
  return mes === 12 ? `${anio + 1}01` : `${anio}${String(mes + 1).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------------------------

const codigoDe = (datos: unknown): string => {
  const codigo = (datos as { codigo?: unknown } | null)?.codigo;
  return typeof codigo === "string" ? codigo : "";
};

/** Mensaje visible de un error del backend del aprendizaje; nunca muestra el código ni el cuerpo. */
export function mensajeDeErrorAprendizaje(status: number, datos: unknown): string {
  const codigo = codigoDe(datos);
  if (status === 409 && Object.hasOwn(M.errores, codigo)) {
    return M.errores[codigo as keyof typeof M.errores];
  }
  return mensajeDeErrorReglas(status, datos);
}

// ---------------------------------------------------------------------------------------------
// Llamadas
// ---------------------------------------------------------------------------------------------

export type ResultadoAprendizaje<T> = ResultadoReglas<T>;

const lista = <T>(v: unknown, analizar: (x: unknown) => T | null): T[] | null => {
  if (!Array.isArray(v)) return null;
  const salida: T[] = [];
  for (const x of v as unknown[]) {
    const p = analizar(x);
    if (p === null) return null;
    salida.push(p);
  }
  return salida;
};

const esquemaUltima: Esquema<{ importacion: ImportacionVista | null }> = {
  safeParse(valor) {
    const crudo = (valor as { importacion?: unknown } | null)?.importacion;
    if (crudo === null) return { success: true, data: { importacion: null } };
    const p = importacionVistaSchema.safeParse(crudo);
    return p.success ? { success: true, data: { importacion: p.data } } : { success: false };
  },
};

const esquemaSolicitada: Esquema<{ importacion: ImportacionVista; trabajoId: string }> = {
  safeParse(valor) {
    const v = valor as { importacion?: unknown; trabajoId?: unknown } | null;
    const p = importacionVistaSchema.safeParse(v?.importacion);
    if (!p.success || typeof v?.trabajoId !== "string" || v.trabajoId === "") return { success: false };
    return { success: true, data: { importacion: p.data, trabajoId: v.trabajoId } };
  },
};

export interface PaginaCandidatas {
  candidatas: CandidataVista[];
  siguiente: string | null;
}

const esquemaCandidatas: Esquema<PaginaCandidatas> = {
  safeParse(valor) {
    const v = valor as { candidatas?: unknown; siguiente?: unknown } | null;
    const candidatas = lista<CandidataVista>(v?.candidatas, (x) => {
      const p = candidataVistaSchema.safeParse(x);
      return p.success ? p.data : null;
    });
    if (candidatas === null) return { success: false };
    if (v?.siguiente !== null && typeof v?.siguiente !== "string") return { success: false };
    return { success: true, data: { candidatas, siguiente: v.siguiente } };
  },
};

const esquemaActivar: Esquema<RespuestaActivar> = respuestaActivarSchema;

export interface RespuestaDescartar {
  descartadas: string[];
  omitidas: Array<{ id: string; motivo: string }>;
}

// `shared` no trae el esquema de la respuesta de descartar (plan: `{descartadas, omitidas}`): se valida su forma aquí.
const esquemaDescartar: Esquema<RespuestaDescartar> = {
  safeParse(valor) {
    const v = valor as { descartadas?: unknown; omitidas?: unknown } | null;
    const descartadas = lista<string>(v?.descartadas, (x) => (typeof x === "string" ? x : null));
    const omitidas = lista<{ id: string; motivo: string }>(v?.omitidas, (x) => {
      const o = x as { id?: unknown; motivo?: unknown } | null;
      return typeof o?.id === "string" && typeof o.motivo === "string" ? { id: o.id, motivo: o.motivo } : null;
    });
    if (descartadas === null || omitidas === null) return { success: false };
    return { success: true, data: { descartadas, omitidas } };
  },
};

const esquemaReemplazo: Esquema<{ regla: { id: string; destino: DestinoCompra; version: number } }> = {
  safeParse(valor) {
    const r = (valor as { regla?: { id?: unknown; destino?: unknown; version?: unknown } } | null)?.regla;
    if (typeof r?.id !== "string" || typeof r.destino !== "string" || typeof r.version !== "number") {
      return { success: false };
    }
    return { success: true, data: { regla: { id: r.id, destino: r.destino as DestinoCompra, version: r.version } } };
  },
};

const ruta = (clienteId: string, resto: string): string => `${rutaReglas(clienteId)}${resto}`;

export const ultimaImportacion = (clienteId: string) =>
  pedir(ruta(clienteId, "/importaciones/ultima"), esquemaUltima, {}, mensajeDeErrorAprendizaje);

export const solicitarImportacion = (clienteId: string, cuerpo: SolicitarImportacion) =>
  pedir(ruta(clienteId, "/importaciones"), esquemaSolicitada, { method: "POST", body: cuerpo }, mensajeDeErrorAprendizaje);

export const listarCandidatas = (
  clienteId: string,
  filtros: { grupo: GrupoCandidatas; cursor?: string; limite?: number },
) => {
  const q = new URLSearchParams({ grupo: filtros.grupo, limite: String(filtros.limite ?? 100) });
  if (filtros.cursor !== undefined) q.set("cursor", filtros.cursor);
  return pedir(ruta(clienteId, `/candidatas?${q.toString()}`), esquemaCandidatas, {}, mensajeDeErrorAprendizaje);
};

export const activarCandidatas = (clienteId: string, cuerpo: ActivarCandidatas) =>
  pedir(ruta(clienteId, "/candidatas/activar"), esquemaActivar, { method: "POST", body: cuerpo }, mensajeDeErrorAprendizaje);

export const descartarCandidatas = (clienteId: string, cuerpo: DescartarCandidatas) =>
  pedir(ruta(clienteId, "/candidatas/descartar"), esquemaDescartar, { method: "POST", body: cuerpo }, mensajeDeErrorAprendizaje);

export const reemplazarCandidata = (clienteId: string, candidataId: string, cuerpo: ReemplazarCandidata) =>
  pedir(
    ruta(clienteId, `/candidatas/${encodeURIComponent(candidataId)}/reemplazar`),
    esquemaReemplazo,
    { method: "POST", body: cuerpo },
    mensajeDeErrorAprendizaje,
  );
