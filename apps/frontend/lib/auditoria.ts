import {
  cambiosClienteAuditoriaSchema,
  paginaAuditoriaSchema,
  type AccionAuditoria,
  type FilaAuditoria,
} from "@contapp/shared";
import { api, type RespuestaApi } from "./api";
import { ETIQUETA_ROL } from "./acceso";
import { etiquetaAutor } from "./autor";

// Consulta de auditoría (spec 017, P-2; CA-12, CA-14): lista paginada por fecha, sin filtros. Todo lo que llega se
// valida con `shared`; aquí solo se arma el texto en español. La acción desconocida no llega (el esquema es un enum
// cerrado): una respuesta con otra forma se trata como error de carga.

export type { FilaAuditoria };

export interface PaginaAuditoriaVista {
  items: FilaAuditoria[];
  siguiente: string | null;
}

export const MENSAJES_AUDITORIA = {
  titulo: "Auditoría",
  enlace: "Auditoría",
  cargando: "Cargando auditoría…",
  vacio: "Todavía no hay registros de auditoría.",
  errorCarga: "No se pudo cargar la auditoría. Inténtalo de nuevo.",
  sinPermiso: "No tienes permiso para ver la auditoría.",
  reintentar: "Reintentar",
  cargarMas: "Cargar más",
  tabla: "Registros de auditoría",
  columnas: {
    fecha: "Fecha",
    actor: "Actor",
    accion: "Acción",
    cliente: "Cliente",
    detalle: "Detalle",
  },
  actorTrabajo: "Proceso automático",
  actorTrabajoDe: (nombre: string) => `${nombre} (proceso automático)`,
  seUnio: "Se unió al estudio",
  creoEstudio: "Creó el estudio",
  sinValor: "(vacío)",
  otroCampo: "Otro dato",
  actorSistema: "Sistema",
  sinCliente: "—",
} as const;

const ACCIONES: Record<AccionAuditoria, string> = {
  "sesion.ingreso": "Inició sesión",
  "invitacion.creada": "Creó una invitación",
  "invitacion.revocada": "Revocó una invitación",
  "invitacion.modificada": "Modificó una invitación",
  "miembro.alta": "Dio de alta a un miembro",
  "miembro.rol_cambiado": "Cambió el rol de un miembro",
  "miembro.desactivado": "Desactivó a un miembro",
  "miembro.reactivado": "Reactivó a un miembro",
  "miembro.eliminado": "Eliminó a un miembro",
  "asignacion.agregada": "Asignó un cliente",
  "asignacion.quitada": "Quitó la asignación de un cliente",
  "asignacion.tipo_cambiado": "Cambió el tipo de asignación de un cliente",
  "cliente.creado": "Creó un cliente",
  "cliente.editado": "Editó un cliente",
  "cliente.archivado": "Archivó un cliente",
  "cliente.reactivado": "Reactivó un cliente",
  "cliente.eliminado": "Eliminó un cliente",
  "credencial.guardada": "Guardó una credencial",
  "credencial.verificada": "Verificó una credencial",
  "credencial.invalidada": "Marcó una credencial como inválida",
  "propuesta.cargada": "Cargó la propuesta del SIRE",
  "compra.operacion": "Modificó compras",
  "venta.agregada": "Agregó una venta",
  "venta.excluida": "Excluyó una venta",
  "venta.restaurada": "Restauró una venta",
  "venta.salto_justificado": "Justificó un salto de correlatividad",
  "xml.subido": "Subió un XML",
  "periodo.estado_cambiado": "Cambió el estado de un periodo",
  "archivo.generado": "Generó un archivo",
  "credencial.descifrada": "Descifró una credencial",
  "sunat.envio": "Envió a SUNAT",
};

/** Acción en español; una clave fuera del catálogo (no debería llegar) sale genérica, nunca el código crudo. */
export function textoAccion(
  accion: string,
  datos?: Record<string, unknown>,
): string {
  // P-4: el alta por invitación la hace quien acepta, no quien invitó: se lee «Se unió al estudio».
  if (accion === "miembro.alta") {
    if (datos?.via === "invitacion") return MENSAJES_AUDITORIA.seUnio;
    if (datos?.via === "registro") return MENSAJES_AUDITORIA.creoEstudio;
  }
  return (ACCIONES as Record<string, string>)[accion] ?? "Realizó una acción";
}

/**
 * Quién hizo el registro: el autor con nombre, el trabajo (con el nombre de quien lo lanzó, si se conoce) o el sistema.
 * P-2: un trabajo lanzado por un usuario sale «Nombre (proceso automático)», no solo «Proceso automático».
 */
export function textoActor(actor: FilaAuditoria["actor"]): string {
  if (actor.tipo === "usuario") return etiquetaAutor(actor.autor);
  if (actor.tipo === "trabajo") {
    return actor.autor
      ? MENSAJES_AUDITORIA.actorTrabajoDe(etiquetaAutor(actor.autor))
      : MENSAJES_AUDITORIA.actorTrabajo;
  }
  return MENSAJES_AUDITORIA.actorSistema;
}

// ---------------------------------------------------------------------------------------------
// Detalle (P-3, P-4): los códigos de `datos` se traducen; uno que no se conoce da un texto genérico, nunca el código.
// ---------------------------------------------------------------------------------------------

const ESTADOS_PERIODO: Record<string, string> = {
  abierto: "Abierto",
  revisado: "Revisado",
  generado: "Generado",
};

const LIBROS: Record<string, string> = {
  compras: "Compras",
  ventas: "Ventas",
};

const CREDENCIALES: Record<string, string> = {
  sol: "Clave SOL",
  sire_api: "Credencial de la API del SIRE",
};

const TIPOS_ASIGNACION: Record<string, string> = {
  responsable: "Responsable",
  colaborador: "Colaborador",
};

const OPERACIONES_COMPRAS: Record<string, string> = {
  agregada: "Agregar una compra",
  clasificar: "Clasificación",
  editar: "Edición",
  sugerencia: "Aceptar una sugerencia",
  excluir: "Exclusión",
  restaurar: "Restauración",
  descartar: "Descarte",
  deshacer: "Deshacer",
  rehacer: "Rehacer",
};

/** Motivos de una credencial inválida y tipos de trabajo (a veces el motivo guarda el trabajo que la verificó). */
const MOTIVOS: Record<string, string> = {
  credencial_invalida: "SUNAT rechazó la credencial",
  "sire.token": "SUNAT rechazó el token del SIRE",
  "credencial.verificar": "Verificación de la credencial",
  "credencial.verificar_sol": "Verificación de la clave SOL",
  "credencial.verificar_sire": "Verificación de la credencial del SIRE",
  "cliente.consultar_ruc": "Consulta de datos del RUC",
  "sire.propuesta.descargar": "Descarga de la propuesta del SIRE",
  "archivo.generar": "Generación del archivo",
  sunat_no_responde: "SUNAT no responde",
  datos_invalidos: "Datos inválidos",
  portal_cambio: "El portal de SUNAT cambió",
  interrumpido: "Se interrumpió",
  acceso_retirado: "Se retiró el acceso",
  cancelado_usuario: "Lo canceló un usuario",
  error_interno: "Error interno",
};

const CAMPOS_CLIENTE: Record<string, string> = {
  ruc: "RUC",
  razon_social: "Razón social",
  estado_contribuyente: "Estado del contribuyente",
  condicion_contribuyente: "Condición del contribuyente",
  regimen: "Régimen",
  zona: "Zona",
  ventas_exoneradas: "Ventas exoneradas",
  ventas_mixtas: "Ventas mixtas",
  moneda_habitual: "Moneda habitual",
};

const REGIMENES: Record<string, string> = {
  rg: "Régimen General (RG)",
  rmt: "Régimen MYPE Tributario (RMT)",
  rer: "Régimen Especial (RER)",
  nrus: "Nuevo RUS (NRUS)",
};

const ZONAS: Record<string, string> = { general: "General", amazonia: "Amazonía" };
const MONEDAS: Record<string, string> = { PEN: "Soles (PEN)", USD: "Dólares (USD)" };

/** Valor traducido de un código; uno desconocido da `generico`, nunca el código. */
function traducir(
  mapa: Record<string, string>,
  valor: unknown,
  generico: string,
): string {
  return typeof valor === "string" && Object.hasOwn(mapa, valor)
    ? mapa[valor]!
    : generico;
}

const rolEn = (v: unknown) => traducir(ETIQUETA_ROL, v, "Otro rol");

/** Valores de un antes → después de `cliente.editado`: texto, sí/no o vacío. */
function valorCambio(columna: string, v: string | boolean | null): string {
  if (v === null || v === "") return MENSAJES_AUDITORIA.sinValor;
  if (typeof v === "boolean") return v ? "Sí" : "No";
  if (columna === "regimen") return traducir(REGIMENES, v, "Otro régimen");
  if (columna === "zona") return traducir(ZONAS, v, "Otra zona");
  if (columna === "moneda_habitual") return traducir(MONEDAS, v, "Otra moneda");
  return v;
}

/** Líneas «Campo: antes → después» de `datos.cambios` (P-4c); `[]` si no tiene la forma esperada. */
function lineasCambiosCliente(datos: Record<string, unknown>): string[] {
  const p = cambiosClienteAuditoriaSchema.safeParse(datos.cambios);
  if (!p.success) return [];
  return Object.entries(p.data).map(([columna, [antes, despues]]) => {
    const campo = Object.hasOwn(CAMPOS_CLIENTE, columna)
      ? CAMPOS_CLIENTE[columna]!
      : MENSAJES_AUDITORIA.otroCampo;
    return `${campo}: ${valorCambio(columna, antes)} → ${valorCambio(columna, despues)}`;
  });
}

/** Rótulo del usuario afectado según el tipo de acción (P-4b). */
function rotuloObjetivo(accion: string): string | null {
  if (accion.startsWith("miembro.")) return "Miembro";
  if (accion.startsWith("asignacion.")) return "Usuario";
  if (accion === "invitacion.modificada") return null;
  if (accion.startsWith("invitacion.")) return "Aceptada por";
  return null;
}

interface FilaDetalle {
  accion: string;
  datos: Record<string, unknown>;
  objetivo?: FilaAuditoria["objetivo"];
}

/**
 * Líneas del detalle de una fila, en español y sin códigos: el usuario afectado (`objetivo`), el antes → después de
 * un cliente editado y los valores simples de `datos` con su rótulo (rol, estado, credencial, motivo…).
 */
export function lineasDetalle(fila: FilaDetalle): string[] {
  const { accion, datos } = fila;
  const lineas: string[] = [];
  const unioPorInvitacion =
    accion === "miembro.alta" && datos.via === "invitacion";

  // A quién se refiere la acción. Quien se une por invitación ya es el actor: no se repite.
  const rotulo = rotuloObjetivo(accion);
  if (rotulo && fila.objetivo && !unioPorInvitacion) {
    lineas.push(`${rotulo}: ${etiquetaAutor(fila.objetivo)}`);
  }

  if (accion === "cliente.editado") lineas.push(...lineasCambiosCliente(datos));

  const simple = (v: unknown): v is string | number | boolean =>
    typeof v === "string" || typeof v === "number" || typeof v === "boolean";
  const parte = (rotuloCampo: string, texto: string) =>
    lineas.push(`${rotuloCampo}: ${texto}`);

  if (simple(datos.libro)) parte("Libro", traducir(LIBROS, datos.libro, "Otro libro"));
  if (typeof datos.periodo === "string" && /^\d{6}$/.test(datos.periodo)) {
    parte("Periodo", datos.periodo);
  }

  // `de` / `a` y `rol`: el cambio se lee con el rótulo de lo que cambió.
  const de = datos.de;
  const a = datos.a;
  if (accion === "periodo.estado_cambiado") {
    const hasta = traducir(ESTADOS_PERIODO, a, "Otro estado");
    parte(
      "Estado",
      typeof de === "string" ? `${traducir(ESTADOS_PERIODO, de, "Otro estado")} → ${hasta}` : hasta,
    );
  } else if (accion === "asignacion.tipo_cambiado") {
    parte(
      "Tipo",
      `${traducir(TIPOS_ASIGNACION, de, "Otro tipo")} → ${traducir(TIPOS_ASIGNACION, a, "Otro tipo")}`,
    );
  } else if (
    (accion === "miembro.rol_cambiado" || accion === "invitacion.modificada") &&
    simple(de) &&
    simple(a)
  ) {
    // Cambio de rol (miembro o invitación).
    parte("Rol", `${rolEn(de)} → ${rolEn(a)}`);
  } else if (simple(datos.rol)) {
    parte("Rol", rolEn(datos.rol));
  }

  if (simple(datos.tipo)) {
    if (accion.startsWith("credencial.")) {
      parte("Credencial", traducir(CREDENCIALES, datos.tipo, "Otra credencial"));
    } else if (accion === "compra.operacion") {
      parte("Operación", traducir(OPERACIONES_COMPRAS, datos.tipo, "Otra operación"));
    } else if (accion.startsWith("asignacion.")) {
      parte("Tipo", traducir(TIPOS_ASIGNACION, datos.tipo, "Otro tipo"));
    }
  }
  if (typeof datos.filas === "number") parte("Filas", String(datos.filas));
  if (typeof datos.version === "number") parte("Versión", String(datos.version));
  if (simple(datos.motivo)) parte("Motivo", traducir(MOTIVOS, datos.motivo, "Otro motivo"));
  return lineas;
}

/** Detalle en una sola línea, separado por « · ». */
export function textoDetalle(fila: FilaDetalle): string {
  return lineasDetalle(fila).join(" · ");
}

export async function listarAuditoria(
  cursor?: string | null,
): Promise<RespuestaApi<PaginaAuditoriaVista>> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const r = await api<unknown>(`/auditoria${query}`);
  if (!r.ok) return { ok: false, status: r.status, datos: null };
  const p = paginaAuditoriaSchema.safeParse(r.datos);
  return {
    ok: p.success,
    status: r.status,
    datos: p.success ? p.data : null,
  };
}
