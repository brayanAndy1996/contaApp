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
  // Spec 023: buzón SOL. `contenido_obtenido` la registra un trigger (actor trabajo); las otras cuatro, el backend.
  "buzon.contenido_obtenido",
  "buzon.captura_solicitada",
  "buzon.apertura_solicitada",
  "buzon.contenido_visto",
  "buzon.adjunto_descargado",
  // Spec 024: atención de mensajes (la registra la función acotada en la misma transacción).
  "buzon.atendido",
  "buzon.atencion_deshecha",
  // Spec 025: aprendizaje de arranque (las registran las funciones acotadas de 0062 en la misma transacción).
  "regla.historial_importado",
  "regla.candidata_descartada",
  // Spec 026: prorrata. `declaraciones_obtenidas` (actor trabajo) la registra la función del worker; las otras tres, las del backend.
  "prorrata.declaraciones_obtenidas",
  "prorrata.mes_manual_guardado",
  "prorrata.mes_manual_eliminado",
  "prorrata.usada_guardada",
  // Spec 027: diccionario de gastos no deducibles (las registran las funciones acotadas de 0070 en la misma transacción).
  // Los cambios del super-admin no son acciones: quedan en `gnd_global_historial`.
  "gnd.palabra_agregada",
  "gnd.palabra_desactivada",
  "gnd.palabra_reactivada",
  "gnd.palabra_aprendida",
  "gnd.global_desactivada",
  "gnd.global_reactivada",
  "gnd.umbral_cambiado",
  "gnd.categorias_cliente",
  // Spec 028: preferencias de correo (la registran `correo_preferencias_fijar` y `auth.correo_baja_aplicar`; los envíos no se auditan uno por uno).
  "correo.preferencia_cambiada",
] as const;

export type AccionAuditoria = (typeof ACCIONES_AUDITORIA)[number];
export const accionAuditoriaSchema = z.enum(ACCIONES_AUDITORIA);
