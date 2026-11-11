import { z } from "zod";

// Spec 017 (D-3, D-6). Catálogo cerrado de acciones de auditoría, con forma `entidad.hecho`.
// `credencial.descifrada` solo existe en la vista (viene de `auditoria_descifrado`); `sunat.envio` queda reservada (R2).
export const ACCIONES_AUDITORIA = [
  "sesion.ingreso",
  "invitacion.creada",
  "invitacion.revocada",
  "miembro.alta",
  "miembro.rol_cambiado",
  "miembro.desactivado",
  "miembro.reactivado",
  "asignacion.agregada",
  "asignacion.quitada",
  "cliente.creado",
  "cliente.editado",
  "cliente.archivado",
  "cliente.reactivado",
  "credencial.guardada",
  "credencial.verificada",
  "credencial.invalidada",
  "propuesta.cargada",
  "compra.operacion",
  "venta.agregada",
  "venta.excluida",
  "venta.restaurada",
  "venta.salto_justificado",
  "xml.subido",
  "periodo.estado_cambiado",
  "archivo.generado",
  "credencial.descifrada",
  "sunat.envio",
] as const;

export type AccionAuditoria = (typeof ACCIONES_AUDITORIA)[number];
export const accionAuditoriaSchema = z.enum(ACCIONES_AUDITORIA);
