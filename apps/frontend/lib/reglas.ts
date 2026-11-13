import {
  reglaVistaSchema,
  reglasMotorSchema,
  type CodigoReglaMotor,
  type DestinoCompra,
  type EditarRegla,
  type RecordarRegla,
  type ReglaVista,
  type ReglasMotor,
} from "@contapp/shared";
import { MENSAJES } from "./acceso";
import { api } from "./api";

// Reglas aprendidas (spec 021, T13; plan, Contratos: HTTP). Cliente HTTP y textos de las pantallas de reglas del
// cliente, del aviso «Recordar» y de las reglas del motor del estudio. Toda respuesta con cuerpo se valida con
// `@contapp/shared`; un 409 `regla_cambiada` o un 422 `proveedores_distintos` salen en español, nunca con el código.

export type { CodigoReglaMotor, DestinoCompra, ReglaVista, ReglasMotor };

export const PERMISO_REGLAS_GESTIONAR = "reglas.gestionar";
export const PERMISO_REGLAS_VER = "reglas.ver";

// ---------------------------------------------------------------------------------------------
// Textos (una sola fuente para las piezas y las pruebas)
// ---------------------------------------------------------------------------------------------

export const MENSAJES_REGLAS = {
  // Aviso «Recordar» (CA-1). El botón se llama exactamente «Recordar» y declara `aria-keyshortcuts`.
  pregunta: "¿Recordar para este proveedor en este cliente?",
  recordar: "Recordar",
  atajo: "Alt+R",
  recordada: "Regla guardada. Se aplicará en las próximas descargas de este proveedor.",
  reglaCambiada: "La regla cambió mientras tanto. Revisa las reglas del cliente e inténtalo de nuevo.",
  proveedoresDistintos: "Las compras elegidas son de proveedores distintos. Recuerda un proveedor a la vez.",
  clienteArchivado: "El cliente está archivado: sus reglas son de solo lectura.",
  datosInvalidos: "Revisa los datos de la regla.",
  // Etiqueta de las filas que aplicó R-HIS y nombre de la versión `historial` en el historial de versiones.
  segunHistorial: "Según historial",
  // Botón de la lupa que 016 P-8 dejó fuera.
  recordarProveedor: "Recordar para este proveedor",

  // Pantalla de reglas del cliente (CA-7).
  enlaceReglasCliente: "Reglas aprendidas",
  tituloReglasCliente: "Reglas del cliente",
  cargando: "Cargando reglas…",
  sinReglas: "Este cliente aún no tiene reglas aprendidas.",
  tablaReglas: "Reglas aprendidas del cliente",
  columnas: {
    proveedor: "Proveedor",
    destino: "Destino",
    estado: "Estado",
    aplicada: "Aplicada",
    aceptada: "Aceptada",
    actualizada: "Actualizada",
  },
  columnaAcciones: "Acciones",
  activa: "Activa",
  inactiva: "Inactiva",
  editar: (numero: string) => `Editar regla de ${numero}`,
  desactivar: (numero: string) => `Desactivar regla de ${numero}`,
  activar: (numero: string) => `Activar regla de ${numero}`,
  eliminar: (numero: string) => `Eliminar regla de ${numero}`,
  confirmarEliminar: (numero: string) =>
    `¿Eliminar la regla de ${numero}? Las próximas descargas ya no moverán sus compras al destino aprendido; lo ya clasificado no cambia.`,
  campoDestino: "Destino",
  guardar: "Guardar",
  cancelarEdicion: "Cancelar",
  // Confirmar eliminar: `ConfirmarAccion` (role alertdialog, botones «Confirmar» y «Cancelar»).
  confirmar: "Confirmar",
  cancelar: "Cancelar",

  // Reglas del motor del estudio (CA-8, P-8, P-10).
  enlaceReglasMotor: "Reglas del motor",
  tituloReglasMotor: "Reglas del motor",
  introMotor: "Enciende o apaga las reglas que revisan las compras de todo el estudio.",
  cargandoMotor: "Cargando reglas del motor…",
  aporte: "Aportar proveedores con RUC 20 al catálogo compartido",
  soloAlcanceGlobal: "Solo un Dueño o Administrador con alcance global puede cambiar las reglas del estudio.",
} as const;


const codigoDe = (datos: unknown): string =>
  (datos as { codigo?: unknown } | null)?.codigo === undefined
    ? ""
    : String((datos as { codigo?: unknown }).codigo);

/** Mensaje visible de un error del backend de reglas; nunca muestra el código ni el cuerpo. */
export function mensajeDeErrorReglas(status: number, datos: unknown): string {
  const codigo = codigoDe(datos);
  if (status === 409 && codigo === "regla_cambiada") return MENSAJES_REGLAS.reglaCambiada;
  if (status === 409 && codigo === "cliente_archivado") return MENSAJES_REGLAS.clienteArchivado;
  if (status === 422 && codigo === "proveedores_distintos") return MENSAJES_REGLAS.proveedoresDistintos;
  if (status === 403) return MENSAJES.sinPermiso;
  if (status === 404) return MENSAJES.noEncontrado;
  return MENSAJES.errorGeneral;
}

// ---------------------------------------------------------------------------------------------
// Llamadas
// ---------------------------------------------------------------------------------------------

export type ResultadoReglas<T> =
  | { ok: true; status: number; datos: T }
  | { ok: false; status: number; codigo: string; mensaje: string };

const fallo = (status: number, datos: unknown): ResultadoReglas<never> => ({
  ok: false,
  status,
  codigo: codigoDe(datos),
  mensaje: mensajeDeErrorReglas(status, datos),
});

const respuestaInvalida = (status: number): ResultadoReglas<never> => ({
  ok: false,
  status,
  codigo: "respuesta_invalida",
  mensaje: MENSAJES.errorGeneral,
});

interface Esquema<T> {
  safeParse(valor: unknown): { success: boolean; data?: T };
}

async function pedir<T>(
  ruta: string,
  esquema: Esquema<T> | null,
  opciones: { method?: string; body?: unknown } = {},
): Promise<ResultadoReglas<T>> {
  let r;
  try {
    r = await api<unknown>(ruta, opciones);
  } catch {
    return respuestaInvalida(0);
  }
  if (!r.ok) return fallo(r.status, r.datos);
  if (esquema === null) return { ok: true, status: r.status, datos: undefined as T };
  const analizado = esquema.safeParse(r.datos);
  if (!analizado.success || analizado.data === undefined) return respuestaInvalida(r.status);
  return { ok: true, status: r.status, datos: analizado.data };
}

const rutaReglas = (clienteId: string): string => `/clientes/${encodeURIComponent(clienteId)}/reglas`;

const esquemaLista: Esquema<ReglaVista[]> = {
  safeParse(valor) {
    if (!Array.isArray(valor)) return { success: false };
    const datos: ReglaVista[] = [];
    for (const elemento of valor as unknown[]) {
      const p = reglaVistaSchema.safeParse(elemento);
      if (!p.success) return { success: false };
      datos.push(p.data);
    }
    return { success: true, data: datos };
  },
};

export const listarReglas = (clienteId: string) => pedir(rutaReglas(clienteId), esquemaLista);

export const recordarRegla = (clienteId: string, datos: RecordarRegla) =>
  pedir(`${rutaReglas(clienteId)}/recordar`, reglaVistaSchema, { method: "POST", body: datos });

export const editarRegla = (clienteId: string, reglaId: string, datos: EditarRegla) =>
  pedir(`${rutaReglas(clienteId)}/${encodeURIComponent(reglaId)}`, reglaVistaSchema, {
    method: "PATCH",
    body: datos,
  });

export const eliminarRegla = (clienteId: string, reglaId: string, versionBase: number) =>
  pedir<undefined>(
    `${rutaReglas(clienteId)}/${encodeURIComponent(reglaId)}?versionBase=${encodeURIComponent(String(versionBase))}`,
    null,
    { method: "DELETE" },
  );

export const leerReglasMotor = () => pedir("/estudio/reglas-motor", reglasMotorSchema);

export const fijarReglaMotor = (codigo: CodigoReglaMotor, activa: boolean) =>
  pedir<undefined>(`/estudio/reglas-motor/${encodeURIComponent(codigo)}`, null, {
    method: "PUT",
    body: { activa },
  });

export const fijarAporteCatalogo = (aportar: boolean) =>
  pedir<undefined>("/estudio/reglas-motor/aporte", null, { method: "PUT", body: { aportar } });

// ---------------------------------------------------------------------------------------------
// Lógica de presentación del aviso «Recordar» (solo decide qué mostrar; el backend valida)
// ---------------------------------------------------------------------------------------------

export interface ProveedorRegla {
  tipo: string;
  numero: string;
}

/** La regla viva (sin eliminar) de ese proveedor, si hay. */
export const reglaDelProveedor = (
  reglas: readonly ReglaVista[],
  proveedor: ProveedorRegla,
): ReglaVista | undefined =>
  reglas.find((r) => r.proveedor.tipo === proveedor.tipo && r.proveedor.numero === proveedor.numero);

/** ¿Se ofrece «Recordar»? Con `reglas.gestionar` y sin una regla activa del proveedor con ese destino (P-3). */
export function ofreceRecordar(
  reglas: readonly ReglaVista[],
  proveedor: ProveedorRegla,
  destino: DestinoCompra,
  puedeGestionar: boolean,
): boolean {
  if (!puedeGestionar) return false;
  const regla = reglaDelProveedor(reglas, proveedor);
  return !(regla !== undefined && regla.activa && regla.destino === destino);
}
