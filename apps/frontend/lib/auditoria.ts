import {
  ACCIONES_AUDITORIA,
  MAX_ACCIONES_CONSULTA_AUDITORIA,
  cambiosClienteAuditoriaSchema,
  opcionesAuditoriaSchema,
  paginaAuditoriaSchema,
  type AccionAuditoria,
  type FilaAuditoria,
  type OpcionesAuditoria,
} from "@contapp/shared";
import { api, type RespuestaApi } from "./api";
import { ETIQUETA_ROL } from "./acceso";
import { MENSAJES_APRENDIZAJE } from "./aprendizaje";
import { etiquetaAutor } from "./autor";

// Consulta de auditoría (spec 017, P-2; CA-12, CA-14): lista paginada por fecha, sin filtros. Todo lo que llega se
// valida con `shared`; aquí solo se arma el texto en español. La acción desconocida no llega (el esquema es un enum
// cerrado): una respuesta con otra forma se trata como error de carga.

export type { FilaAuditoria, OpcionesAuditoria };

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
  // Spec 031 (CA-10; P-1 a P-3): filtros, estados y enlaces.
  enlaceHistorial: "Ver historial",
  enlaceHistorialPeriodo: "Ver historial del periodo",
  vacioFiltrado: "No hay registros para los filtros elegidos.",
  clienteNoEncontrado: "No se encontró el cliente. Puede que no exista o que no tengas acceso a él.",
  filtrosInvalidos: "Los filtros no son válidos. Revísalos e inténtalo de nuevo.",
  avisoDescifrados:
    "Los descifrados de credenciales no registran autor: al filtrar por usuario no aparecen en la lista.",
  filtros: {
    titulo: "Filtros de auditoría",
    usuario: "Usuario",
    todosUsuarios: "Todos los usuarios",
    inactivo: "(inactivo)",
    cliente: "Cliente",
    clientePlaceholder: "Busca por RUC o razón social",
    clienteSinResultados: "Ningún cliente coincide con la búsqueda.",
    clienteBuscando: "Buscando…",
    archivado: "archivado",
    listaClientes: "Clientes encontrados",
    errorOpciones: "No se pudieron cargar las opciones de los filtros.",
    acciones: "Acciones",
    limiteAcciones: `Puedes elegir hasta ${MAX_ACCIONES_CONSULTA_AUDITORIA} acciones.`,
    desde: "Desde",
    hasta: "Hasta",
    todo: "Todo el historial",
    ayudaFechas: "Fechas en hora de Lima. Sin fechas se muestran los últimos 30 días.",
    limpiar: "Quitar usuario, cliente y acciones",
  },
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
  "regla.creada": "Recordó una regla para un proveedor",
  "regla.editada": "Editó una regla de un proveedor",
  "regla.activada": "Activó una regla de un proveedor",
  "regla.desactivada": "Desactivó una regla de un proveedor",
  "regla.eliminada": "Eliminó una regla de un proveedor",
  "estudio.regla_motor": "Cambió una regla del motor del estudio",
  "estudio.aporte_catalogo": "Cambió el aporte al catálogo compartido",
  "compra.historial": "Aplicó el destino según el historial",
  "buzon.contenido_obtenido": "Obtuvo el contenido de un mensaje del buzón SOL",
  "buzon.captura_solicitada": "Pidió revisar el buzón SOL",
  "buzon.apertura_solicitada": "Pidió abrir un mensaje del buzón SOL",
  "buzon.contenido_visto": "Vio el contenido de un mensaje del buzón SOL",
  "buzon.adjunto_descargado": "Descargó un adjunto del buzón SOL",
  "buzon.atendido": "Marcó como atendido un mensaje del buzón SOL",
  "buzon.atencion_deshecha": "Deshizo la atención de un mensaje del buzón SOL",
  "regla.historial_importado": "Importó el historial de un cliente",
  "regla.candidata_descartada": "Descartó una candidata del historial",
  "prorrata.declaraciones_obtenidas": "Obtuvo las declaraciones del PDT 621 para la prorrata",
  "prorrata.mes_manual_guardado": "Ingresó a mano un mes de la prorrata",
  "prorrata.mes_manual_eliminado": "Eliminó un mes de la prorrata ingresado a mano",
  "prorrata.usada_guardada": "Guardó la prorrata usada en la declaración",
  "gnd.palabra_agregada": "Agregó una palabra al diccionario de gastos no deducibles",
  "gnd.palabra_desactivada": "Desactivó una palabra propia del diccionario de gastos no deducibles",
  "gnd.palabra_reactivada": "Reactivó una palabra propia del diccionario de gastos no deducibles",
  "gnd.palabra_aprendida": "Aprendió una palabra de gastos no deducibles al excluir una compra",
  "gnd.global_desactivada": "Desactivó una palabra global del diccionario para el estudio",
  "gnd.global_reactivada": "Reactivó una palabra global del diccionario para el estudio",
  "gnd.umbral_cambiado": "Cambió el umbral de gastos no deducibles",
  "gnd.categorias_cliente": "Cambió las categorías permitidas de un cliente en gastos no deducibles",
  "correo.preferencia_cambiada": "Cambió una preferencia de correo",
  "rol.creado": "Creó un rol propio",
  "rol.editado": "Editó un rol propio",
  "rol.eliminado": "Eliminó un rol propio",
};

/** Spec 025 (D-5): una regla creada al activar una candidata del historial no se lee como «Recordó una regla». */
const ACCION_REGLA_IMPORTADA = "Activó una regla del historial para un proveedor";

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
  if (accion === "regla.creada" && datos?.origen === "importacion") return ACCION_REGLA_IMPORTADA;
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
  // Spec 025: solo valores simples; nunca el id de la importación ni de la candidata.
  if (accion === "regla.creada" && datos.origen === "importacion") {
    parte("Origen", MENSAJES_APRENDIZAJE.origenImportacion);
  }
  if (accion === "regla.historial_importado" && typeof datos.periodos === "number") {
    parte("Periodos", String(datos.periodos));
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

// ---------------------------------------------------------------------------------------------
// Filtros (spec 031, D-2, P-2): viven en la URL con los mismos nombres de la API más `todo=1`. Aquí solo se leen,
// se normalizan y se arma la consulta; la validación real es del backend (400) y los cálculos de rango también.
// ---------------------------------------------------------------------------------------------

/** Acciones del catálogo con su texto en español, en el orden del catálogo de `shared`. */
export const ACCIONES_FILTRABLES: { valor: AccionAuditoria; texto: string }[] = ACCIONES_AUDITORIA.map((valor) => ({
  valor,
  texto: ACCIONES[valor],
}));

export const MAX_ACCIONES_FILTRO = MAX_ACCIONES_CONSULTA_AUDITORIA;

/** Filtros vigentes; «» = sin filtro. `desde`/`hasta` ya traen los últimos 30 días cuando la URL no dice nada. */
export interface FiltrosAuditoria {
  usuarioId: string;
  clienteId: string;
  acciones: string[];
  desde: string;
  hasta: string;
  todo: boolean;
}

const MS_HORA = 3_600_000;
const MS_DIA = 24 * MS_HORA;
/** Perú: UTC−05:00 fijo, sin horario de verano. */
const HORAS_LIMA = 5;
/** Días que abarca la ventana por defecto: hoy y los 29 anteriores. */
const DIAS_VENTANA = 29;

const aFechaPura = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** «Hoy» en Lima como `AAAA-MM-DD`. */
export function hoyLima(ahora: Date = new Date()): string {
  return aFechaPura(ahora.getTime() - HORAS_LIMA * MS_HORA);
}

/** Ventana por defecto (P-2): hoy Lima − 29 → hoy Lima. */
export function ventanaPorDefecto(ahora: Date = new Date()): { desde: string; hasta: string } {
  const hoy = hoyLima(ahora);
  return { desde: aFechaPura(Date.parse(`${hoy}T00:00:00.000Z`) - DIAS_VENTANA * MS_DIA), hasta: hoy };
}

/** Filtros de la URL. Sin `desde`/`hasta` ni `todo=1` aplica la ventana por defecto; `todo=1` quita ambas fechas. */
export function filtrosDeUrl(p: URLSearchParams, ahora: Date = new Date()): FiltrosAuditoria {
  const todo = p.get("todo") === "1";
  let desde = todo ? "" : (p.get("desde") ?? "");
  let hasta = todo ? "" : (p.get("hasta") ?? "");
  if (!todo && !desde && !hasta) ({ desde, hasta } = ventanaPorDefecto(ahora));
  return {
    usuarioId: p.get("usuarioId") ?? "",
    clienteId: p.get("clienteId") ?? "",
    acciones: p.getAll("accion"),
    desde,
    hasta,
    todo,
  };
}

/**
 * Cambia filtros y devuelve la URL nueva. Tocar una fecha materializa la otra (la que se veía) y apaga `todo`;
 * marcar `todo` quita las fechas; desmarcarlo las deja en blanco para que vuelva la ventana por defecto.
 */
export function urlDeFiltros(actual: FiltrosAuditoria, cambio: Partial<FiltrosAuditoria>): URLSearchParams {
  const n: FiltrosAuditoria = { ...actual, ...cambio };
  if ("todo" in cambio) {
    n.desde = "";
    n.hasta = "";
  } else if ("desde" in cambio || "hasta" in cambio) {
    n.todo = false;
  }
  const p = new URLSearchParams();
  if (n.usuarioId) p.set("usuarioId", n.usuarioId);
  if (n.clienteId) p.set("clienteId", n.clienteId);
  for (const a of n.acciones) p.append("accion", a);
  if (n.todo) p.set("todo", "1");
  else {
    if (n.desde) p.set("desde", n.desde);
    if (n.hasta) p.set("hasta", n.hasta);
  }
  return p;
}

/** Consulta a `GET /auditoria` (sin cursor): los mismos nombres que la API. */
export function consultaDeFiltros(f: FiltrosAuditoria): URLSearchParams {
  const q = new URLSearchParams();
  if (f.usuarioId) q.set("usuarioId", f.usuarioId);
  if (f.clienteId) q.set("clienteId", f.clienteId);
  for (const a of f.acciones) q.append("accion", a);
  if (f.desde) q.set("desde", f.desde);
  if (f.hasta) q.set("hasta", f.hasta);
  return q;
}

/** ¿Hay algo que acote la lista? Solo «todo el historial» sin más filtros es la lista completa. */
export function hayFiltros(f: FiltrosAuditoria): boolean {
  return Boolean(f.usuarioId || f.clienteId || f.acciones.length > 0 || !f.todo);
}

/** `consulta` es el texto de `consultaDeFiltros(...)`; el cursor solo vale con los mismos filtros. */
export async function listarAuditoria(
  cursor?: string | null,
  consulta: string = "",
): Promise<RespuestaApi<PaginaAuditoriaVista>> {
  const q = new URLSearchParams(consulta);
  if (cursor) q.set("cursor", cursor);
  const texto = q.toString();
  const r = await api<unknown>(`/auditoria${texto ? `?${texto}` : ""}`);
  if (!r.ok) return { ok: false, status: r.status, datos: null };
  const p = paginaAuditoriaSchema.safeParse(r.datos);
  return {
    ok: p.success,
    status: r.status,
    datos: p.success ? p.data : null,
  };
}

/** `GET /auditoria/opciones`: miembros y clientes visibles para los selectores (`q` busca; `clienteId` lo agrega). */
export async function opcionesAuditoria(
  filtro: { q?: string; clienteId?: string } = {},
): Promise<RespuestaApi<OpcionesAuditoria>> {
  const q = new URLSearchParams();
  if (filtro.q) q.set("q", filtro.q);
  if (filtro.clienteId) q.set("clienteId", filtro.clienteId);
  const texto = q.toString();
  const r = await api<unknown>(`/auditoria/opciones${texto ? `?${texto}` : ""}`);
  if (!r.ok) return { ok: false, status: r.status, datos: null };
  const p = opcionesAuditoriaSchema.safeParse(r.datos);
  return { ok: p.success, status: r.status, datos: p.success ? p.data : null };
}
