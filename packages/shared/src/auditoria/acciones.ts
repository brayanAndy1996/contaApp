import { z } from "zod";

// Spec 017 (D-3, D-6). Catálogo cerrado de acciones de auditoría, con forma `entidad.hecho`.
// Ronda adversarial R1 (0045): `asignacion.tipo_cambiado` (H-017-1), `miembro.eliminado`, `cliente.eliminado` e
// `invitacion.modificada` (H-017-2). `credencial.descifrada` solo existe en la vista (viene de `auditoria_descifrado`);
// `sunat.envio` queda reservada (R2).
export const ACCIONES_AUDITORIA = [
  "sesion.ingreso",
  "invitacion.creada",
  "invitacion.revocada",
  "invitacion.modificada",
  "miembro.alta",
  "miembro.rol_cambiado",
  "miembro.desactivado",
  "miembro.reactivado",
  "miembro.eliminado",
  "asignacion.agregada",
  "asignacion.quitada",
  "asignacion.tipo_cambiado",
  "cliente.creado",
  "cliente.editado",
  "cliente.archivado",
  "cliente.reactivado",
  "cliente.eliminado",
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
  // Spec 021: reglas aprendidas (triggers de 0047–0049).
  "regla.creada",
  "regla.editada",
  "regla.activada",
  "regla.desactivada",
  "regla.eliminada",
  "estudio.regla_motor",
  "estudio.aporte_catalogo",
  "compra.historial",
] as const;

export type AccionAuditoria = (typeof ACCIONES_AUDITORIA)[number];
export const accionAuditoriaSchema = z.enum(ACCIONES_AUDITORIA);
