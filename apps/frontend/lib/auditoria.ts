import {
  paginaAuditoriaSchema,
  type AccionAuditoria,
  type FilaAuditoria,
} from "@contapp/shared";
import { api, type RespuestaApi } from "./api";
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
  actorSistema: "Sistema",
  sinCliente: "—",
} as const;

const ACCIONES: Record<AccionAuditoria, string> = {
  "sesion.ingreso": "Inició sesión",
  "invitacion.creada": "Creó una invitación",
  "invitacion.revocada": "Revocó una invitación",
  "miembro.alta": "Dio de alta a un miembro",
  "miembro.rol_cambiado": "Cambió el rol de un miembro",
  "miembro.desactivado": "Desactivó a un miembro",
  "miembro.reactivado": "Reactivó a un miembro",
  "asignacion.agregada": "Asignó un cliente",
  "asignacion.quitada": "Quitó la asignación de un cliente",
  "cliente.creado": "Creó un cliente",
  "cliente.editado": "Editó un cliente",
  "cliente.archivado": "Archivó un cliente",
  "cliente.reactivado": "Reactivó un cliente",
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
export function textoAccion(accion: string): string {
  return (ACCIONES as Record<string, string>)[accion] ?? "Realizó una acción";
}

/** Quién hizo el registro: el autor con nombre, el proceso automático o el sistema. */
export function textoActor(actor: FilaAuditoria["actor"]): string {
  if (actor.tipo === "usuario") return etiquetaAutor(actor.autor);
  return actor.tipo === "trabajo"
    ? MENSAJES_AUDITORIA.actorTrabajo
    : MENSAJES_AUDITORIA.actorSistema;
}

const ROTULOS_DATOS: Record<string, string> = {
  libro: "Libro",
  periodo: "Periodo",
  tipo: "Tipo",
  rol: "Rol",
  de: "De",
  a: "A",
  filas: "Filas",
  version: "Versión",
  motivo: "Motivo",
};

/** Detalle corto: solo valores simples de `datos` con rótulo conocido, como texto («Rol: admin · Periodo: 202610»). */
export function textoDetalle(datos: Record<string, unknown>): string {
  const partes: string[] = [];
  for (const [clave, rotulo] of Object.entries(ROTULOS_DATOS)) {
    const v = datos[clave];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      partes.push(`${rotulo}: ${String(v)}`);
    }
  }
  return partes.join(" · ");
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
