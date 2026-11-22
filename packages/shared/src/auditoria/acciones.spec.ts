import { describe, expect, it } from "vitest";
import { ACCIONES_AUDITORIA, accionAuditoriaSchema } from "./acciones.js";

// Spec 017 · T1 (rojo). Catálogo cerrado de acciones de auditoría (D-3, CA-1; plan, 0041).
// Contrato fijado por estas pruebas (packages/shared/src/auditoria/acciones.ts):
//  ACCIONES_AUDITORIA = las 25 acciones de D-3 + las 4 de la ronda adversarial R1 (T16: H-017-1 y H-017-2) + `credencial.descifrada`
//  (solo para la vista, D-6) + `sunat.envio` (reservada R2)
//  accionAuditoriaSchema = z.enum(ACCIONES_AUDITORIA)
const CATALOGO_D3 = [
  // Sesión
  "sesion.ingreso",
  // Acceso (005)
  "invitacion.creada",
  "invitacion.revocada",
  "miembro.alta",
  "miembro.rol_cambiado",
  "miembro.desactivado",
  "miembro.reactivado",
  "asignacion.agregada",
  "asignacion.quitada",
  // Clientes (007a)
  "cliente.creado",
  "cliente.editado",
  "cliente.archivado",
  "cliente.reactivado",
  // Credenciales (007b/008)
  "credencial.guardada",
  "credencial.verificada",
  "credencial.invalidada",
  // Libros (013/014/016/012b)
  "propuesta.cargada",
  "compra.operacion",
  "venta.agregada",
  "venta.excluida",
  "venta.restaurada",
  "venta.salto_justificado",
  "xml.subido",
  "periodo.estado_cambiado",
  "archivo.generado",
];
// Ronda adversarial R1 (T16): cambio de tipo de asignación (H-017-1) y escrituras que los grants permiten, ahora auditadas (H-017-2).
const RONDA_R1 = ["asignacion.tipo_cambiado", "miembro.eliminado", "cliente.eliminado", "invitacion.modificada"];
const EXTRAS = ["credencial.descifrada", "sunat.envio"];
// Spec 021 (T8): 8 acciones de reglas aprendidas (31 + 8 = 39).
const REGLAS_021 = ["regla.creada", "regla.editada", "regla.activada", "regla.desactivada", "regla.eliminada", "estudio.regla_motor", "estudio.aporte_catalogo", "compra.historial"];
// Spec 023 (T9): 5 acciones del buzón SOL (39 + 5 = 44).
// Spec 024 (T6): 2 acciones de atención (44 + 2 = 46).
// Spec 025 (T2): 2 acciones del aprendizaje de arranque (46 + 2 = 48).
const REGLAS_025 = ["regla.historial_importado", "regla.candidata_descartada"];
const BUZON_024 = ["buzon.atendido", "buzon.atencion_deshecha"];
// Spec 026 (T2): 4 acciones de la prorrata (48 + 4 = 52).
const PRORRATA_026 = ["prorrata.declaraciones_obtenidas", "prorrata.mes_manual_guardado", "prorrata.mes_manual_eliminado", "prorrata.usada_guardada"];
// Spec 027 (T2): 8 acciones del diccionario de gastos no deducibles (52 + 8 = 60).
const GND_027 = ["gnd.palabra_agregada", "gnd.palabra_desactivada", "gnd.palabra_reactivada", "gnd.palabra_aprendida", "gnd.global_desactivada", "gnd.global_reactivada", "gnd.umbral_cambiado", "gnd.categorias_cliente"];
const BUZON_023 = ["buzon.contenido_obtenido", "buzon.captura_solicitada", "buzon.apertura_solicitada", "buzon.contenido_visto", "buzon.adjunto_descargado"];

describe("ACCIONES_AUDITORIA", () => {
  it("es exactamente el catálogo de D-3, las 4 de la ronda R1, credencial.descifrada, sunat.envio y las 8 de 021, las 5 de 023, las 2 de 024, las 2 de 025, las 4 de 026 y las 8 de 027", () => {
    expect([...ACCIONES_AUDITORIA].sort()).toEqual([...CATALOGO_D3, ...RONDA_R1, ...EXTRAS, ...REGLAS_021, ...BUZON_023, ...BUZON_024, ...REGLAS_025, ...PRORRATA_026, ...GND_027].sort());
  });

  it("no repite acciones", () => {
    expect(new Set(ACCIONES_AUDITORIA).size).toBe(ACCIONES_AUDITORIA.length);
    expect(ACCIONES_AUDITORIA).toHaveLength(60);
  });

  it("todas son minúsculas con forma entidad.hecho", () => {
    for (const a of ACCIONES_AUDITORIA) expect(a).toMatch(/^[a-z]+\.[a-z_]+$/);
  });
});

describe("accionAuditoriaSchema", () => {
  it.each([...CATALOGO_D3, ...RONDA_R1, ...EXTRAS])("acepta %s", (a) => {
    expect(accionAuditoriaSchema.safeParse(a).success).toBe(true);
  });

  it.each(["cliente.borrado", "Cliente.creado", "cliente.creado ", "", "sunat", null, 1, undefined])("rechaza %j", (a) => {
    expect(accionAuditoriaSchema.safeParse(a).success).toBe(false);
  });
});
