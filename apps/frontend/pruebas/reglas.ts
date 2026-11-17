import { vi } from "vitest";
import {
  reglaVistaSchema,
  reglasMotorSchema,
  type ReglaVista,
  type ReglasMotor,
} from "@contapp/shared";
import { CLIENTE_ID, uuidDe } from "./compras";
import { contextoDe, type ContextoPrueba } from "./contexto-compras";

// Soporte de las pruebas de reglas aprendidas (spec 021, T6). Es el CONTRATO que fija el frontend para T13/T14:
//  - Textos visibles de `MENSAJES_REGLAS` (la implementación los define en `lib/reglas.ts` con estos mismos textos).
//  - Rutas de la API de plan 021 (Contratos: HTTP), bajo `/api`.
//  - `ContextoCompras` suma `permisos.gestionarReglas: boolean` (de `reglas.gestionar`) y
//    `reglas?: {lista: readonly ReglaVista[]; recargar: () => Promise<void>}` (las reglas del cliente que la página
//    lee UNA vez con `GET …/reglas`; `recargar` las vuelve a leer tras crear o actualizar una).
// Solo datos de prueba; los montos no intervienen.

export const RUTA_REGLAS = `/api/clientes/${CLIENTE_ID}/reglas`;
export const RUTA_RECORDAR = `POST ${RUTA_REGLAS}/recordar`;
export const RUTA_LISTA_REGLAS = `GET ${RUTA_REGLAS}`;
export const rutaRegla = (metodo: "PATCH" | "DELETE", reglaId: string) =>
  `${metodo} ${RUTA_REGLAS}/${reglaId}`;
export const RUTA_MOTOR = "GET /api/estudio/reglas-motor";
export const rutaFijarMotor = (codigo: string) => `PUT /api/estudio/reglas-motor/${codigo}`;
export const RUTA_APORTE = "PUT /api/estudio/reglas-motor/aporte";

export const MENSAJES_REGLAS = {
  // Aviso «Recordar» (CA-1). El botón se llama exactamente «Recordar» y declara `aria-keyshortcuts`.
  pregunta: "¿Recordar para este proveedor en este cliente?",
  recordar: "Recordar",
  atajo: "Alt+R",
  recordada: "Regla guardada. Se aplicará en las próximas descargas de este proveedor.",
  reglaCambiada: "La regla cambió mientras tanto. Revisa las reglas del cliente e inténtalo de nuevo.",
  proveedoresDistintos: "Las compras elegidas son de proveedores distintos. Recuerda un proveedor a la vez.",
  // Etiqueta de las filas que aplicó R-HIS y nombre de la versión `historial` en el historial de versiones.
  segunHistorial: "Según historial",
  // Botón de la lupa que 016 P-8 dejó fuera.
  recordarProveedor: "Recordar para este proveedor",

  // Pantalla de reglas del cliente (CA-7).
  tituloReglasCliente: "Reglas del cliente",
  sinReglas: "Este cliente aún no tiene reglas aprendidas.",
  columnas: {
    proveedor: "Proveedor",
    destino: "Destino",
    estado: "Estado",
    aplicada: "Aplicada",
    aceptada: "Aceptada",
    actualizada: "Actualizada",
  },
  activa: "Activa",
  inactiva: "Inactiva",
  editar: (numero: string) => `Editar regla de ${numero}`,
  desactivar: (numero: string) => `Desactivar regla de ${numero}`,
  activar: (numero: string) => `Activar regla de ${numero}`,
  eliminar: (numero: string) => `Eliminar regla de ${numero}`,
  campoDestino: "Destino",
  guardar: "Guardar",
  // Confirmar eliminar: `ConfirmarAccion` (role alertdialog, botones «Confirmar» y «Cancelar»).
  confirmar: "Confirmar",
  cancelar: "Cancelar",

  // Reglas del motor del estudio (CA-8, P-8, P-10).
  tituloReglasMotor: "Reglas del motor",
  aporte: "Aportar proveedores con RUC 20 al catálogo compartido",
  soloAlcanceGlobal: "Solo un Dueño o Administrador con alcance global puede cambiar las reglas del estudio.",
} as const;

/** Una regla aprendida válida según `shared`. Por omisión, la del proveedor por omisión de `filaDe`. */
export function reglaDe(parcial: Partial<ReglaVista> = {}): ReglaVista {
  return reglaVistaSchema.parse({
    id: uuidDe(7, 1),
    proveedor: { tipo: "6", numero: "20100070970", razonSocial: "PROVEEDOR PRUEBA S.A.C." },
    destino: "DNG",
    activa: true,
    version: 1,
    periodoAprendido: "202609",
    aplicada: 0,
    aceptada: 0,
    creadaPor: { id: uuidDe(5, 1), nombre: "Rosa Quispe", activo: true },
    creadaEn: "2026-11-13T02:30:00.000Z",
    actualizadaEn: "2026-11-13T02:30:00.000Z",
    ...parcial,
  });
}

const DESCRIPCIONES: Record<string, string> = {
  "R-ISC": "Sugiere pasar a ISC la base gravada sin IGV de proveedores con ISC.",
  "R-MIX": "Separa lo gravado de lo no gravado cuando el IGV no cuadra.",
  "R-RED": "Sugiere el redondeo de los montos en dólares.",
  "R-NEW": "Avisa de un proveedor nuevo para que elijas su destino.",
  "R-GP": "Marca posibles gastos personales según la glosa.",
  "R-HIS": "Aplica el destino que ya aprendiste para el proveedor.",
};

/** Respuesta de `GET /estudio/reglas-motor`: los seis códigos (sin prevalidación), todos encendidos por omisión. */
export function motorDe(
  apagadas: readonly string[] = [],
  aportarCatalogo = true,
): ReglasMotor {
  return reglasMotorSchema.parse({
    reglas: Object.entries(DESCRIPCIONES).map(([codigo, descripcion]) => ({
      codigo,
      descripcion,
      activa: !apagadas.includes(codigo),
    })),
    aportarCatalogo,
  });
}
export const descripcionDe = (codigo: string): string => DESCRIPCIONES[codigo]!;

export type ContextoReglasPrueba = ContextoPrueba & {
  permisos: ContextoPrueba["permisos"] & { gestionarReglas: boolean };
  reglas: { lista: readonly ReglaVista[]; recargar: ReturnType<typeof vi.fn<() => Promise<void>>> };
};

/** `contextoDe` de 015 más lo que suma 021: el permiso `reglas.gestionar` y las reglas del cliente ya leídas. */
export function contextoConReglas(
  reglas: readonly ReglaVista[] = [],
  opciones: { gestionar?: boolean } = {},
): ContextoReglasPrueba {
  const base = contextoDe();
  return {
    ...base,
    permisos: { ...base.permisos, gestionarReglas: opciones.gestionar ?? true },
    reglas: { lista: reglas, recargar: vi.fn(async () => undefined) },
  } as ContextoReglasPrueba;
}

/**
 * ¿El texto del aviso nombra ese destino? El botón «Recordar» va pegado al texto (`…cliente?DNGRecordar`), así que no
 * sirve `\b`: se quita «Recordar» y se exige que el código no sea parte de otro (DG dentro de DGNG).
 */
export function mencionaDestino(texto: string | null, destino: "DG" | "DGNG" | "DNG"): boolean {
  const sinBoton = (texto ?? "").replace(/Recordar/g, " ");
  return new RegExp(`(?<![A-Z])${destino}(?![A-Z])`).test(sinBoton);
}
