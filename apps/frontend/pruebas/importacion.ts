import type { Mock } from "vitest";

// Soporte de las pruebas del asistente de importación (spec 007b, T6): mensajes visibles, cuerpos de
// ejemplo de `VistaPrevia` e `Informe` y lectura del cuerpo crudo enviado. Son el contrato de T14: la
// pantalla debe mostrar estos textos exactos. Solo datos de prueba (canarios); sin lógica de producción.

export const MENSAJES_IMPORTACION = {
  titulo: "Importar clientes",
  plantilla: "Descargar plantilla",
  // 400 archivo_invalido (ni .xlsx ni .csv legible, vacío, no zip…).
  archivoInvalido:
    "El archivo no es válido. Usa la plantilla (.xlsx) o un .csv.",
  // 400 columnas_faltantes (la cabecera de la plantilla es obligatoria).
  columnasFaltantes:
    "Faltan columnas en la cabecera. Descarga la plantilla y úsala.",
  // 400 demasiadas_filas (> 1.000).
  demasiadasFilas: "El archivo supera las 1.000 filas permitidas.",
  // 413 (> 2 MB).
  archivoGrande: "El archivo supera los 2 MB permitidos.",
  estadoFila: { valida: "Válida", conError: "Con error" },
  // Motivos de fila (vista previa e informe).
  motivos: {
    ruc_invalido: "El RUC no es válido.",
    duplicado_en_archivo: "RUC repetido en el archivo.",
    duplicado: "Ya existe un cliente con ese RUC.",
    duplicadoArchivado:
      "Ya existe un cliente archivado con ese RUC. Reactívalo desde su ficha.",
    responsable_inexistente: "El responsable no existe en el estudio.",
    responsable_no_asignable: "El responsable no puede ser asignado a clientes.",
    credencial_incompleta: "La credencial está incompleta.",
    celda_peligrosa: "La fila contiene una fórmula o un carácter no permitido.",
    cupo_rucs: "No cabe en el cupo de RUCs de tu plan.",
  },
  // Resumen de la vista previa (D7).
  validas: (n: number) => `Filas válidas: ${n}`,
  conError: (n: number) => `Filas con error: ${n}`,
  cupoLibre: (n: number) => `Cupo de RUCs disponible: ${n}`,
  excedentes: (n: number) => `Excedentes que no caben: ${n}`,
  // Informe tras confirmar.
  creadas: (n: number) => `Clientes creados: ${n}`,
  consultasEncoladas: (n: number) => `Consultas de RUC encoladas: ${n}`,
  consultasOmitidas: (n: number) => `Consultas de RUC omitidas: ${n}`,
} as const;

/** Canario: clave que va dentro del archivo y no debe aparecer jamás en pantalla ni almacenamiento. */
export const CANARIO_CLAVE_ARCHIVO = "CLAVE-ARCHIVO-CANARIO-61ad";

export const MASCARA_CLAVE = "••••";

/** CSV de ejemplo (con el canario como clave SOL). */
export const CSV_CON_CLAVE = [
  "RUC,usuario SOL,clave SOL,client_id,client_secret,responsable",
  `20100000009,USUARIO1,${CANARIO_CLAVE_ARCHIVO},,,ana@ejemplo.test`,
].join("\n");

/** `File` de prueba (el de jsdom, apto para `userEvent.upload`). */
export function archivoDe(
  nombre: string,
  contenido: string | Uint8Array,
  tipo = "text/csv",
): File {
  return new File([contenido as BlobPart], nombre, { type: tipo });
}

/** Bytes de un `.xlsx` mínimo (cabecera de zip): el contenido no importa, solo se reenvía crudo. */
export const BYTES_XLSX = Uint8Array.from([
  0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0xde, 0xad, 0xbe,
  0xef, 0x00, 0xff, 0x10, 0x20,
]);

export type MotivoFila =
  | "ruc_invalido"
  | "duplicado_en_archivo"
  | "duplicado"
  | "responsable_inexistente"
  | "responsable_no_asignable"
  | "credencial_incompleta"
  | "celda_peligrosa"
  | "cupo_rucs";

export interface FilaVistaPrevia {
  n: number;
  ruc: string;
  estado: "valida" | "error";
  motivos: MotivoFila[];
  /** Solo con `duplicado`: el existente está archivado (sugerencia de reactivar). */
  archivado?: boolean;
  tieneSol: boolean;
  tieneSire: boolean;
}

export function filaDe(
  n: number,
  ruc: string,
  parcial: Partial<Omit<FilaVistaPrevia, "n" | "ruc">> = {},
): FilaVistaPrevia {
  return {
    n,
    ruc,
    estado: parcial.estado ?? (parcial.motivos?.length ? "error" : "valida"),
    motivos: parcial.motivos ?? [],
    ...(parcial.archivado === undefined ? {} : { archivado: parcial.archivado }),
    tieneSol: parcial.tieneSol ?? false,
    tieneSire: parcial.tieneSire ?? false,
  };
}

/** Cuerpo de `POST /clientes/importacion/vista-previa` (`VistaPrevia` del plan). */
export function vistaPreviaDe(
  filas: FilaVistaPrevia[],
  parcial: Partial<{
    validas: number;
    conError: number;
    cupoLibre: number;
    excedentes: number;
  }> = {},
) {
  const validas = filas.filter((f) => f.estado === "valida").length;
  return {
    filas,
    validas: parcial.validas ?? validas,
    conError: parcial.conError ?? filas.length - validas,
    cupoLibre: parcial.cupoLibre ?? 100,
    excedentes: parcial.excedentes ?? 0,
  };
}

export interface NoImportada {
  n: number;
  ruc: string;
  motivo: MotivoFila;
  /** Solo con `duplicado`: el existente está archivado. */
  archivado?: boolean;
}

/** Cuerpo de `POST /clientes/importacion/confirmar` (`Informe` del plan). */
export function informeDe(
  parcial: Partial<{
    creadas: number;
    noImportadas: NoImportada[];
    consultasEncoladas: number;
    consultasOmitidas: number;
  }> = {},
) {
  return {
    creadas: parcial.creadas ?? 0,
    noImportadas: parcial.noImportadas ?? [],
    consultasEncoladas: parcial.consultasEncoladas ?? parcial.creadas ?? 0,
    consultasOmitidas: parcial.consultasOmitidas ?? 0,
  };
}

interface LlamadaCruda {
  url: string;
  method: string;
  init: RequestInit;
}

/** Llamadas reales a `fetch` (con `init.body` sin parsear), para leer cuerpos crudos y señales. */
export function llamadasCrudas(metodo: string, ruta: string): LlamadaCruda[] {
  const falso = globalThis.fetch as unknown as Mock;
  return (falso.mock.calls as [RequestInfo | URL, RequestInit | undefined][])
    .map(([entrada, init]) => ({
      url:
        typeof entrada === "string"
          ? entrada
          : entrada instanceof URL
            ? entrada.pathname + entrada.search
            : entrada.url,
      method: (init?.method ?? "GET").toUpperCase(),
      init: init ?? {},
    }))
    .filter((l) => l.method === metodo && l.url.split("?")[0] === ruta);
}

/** Bytes de un cuerpo de petición crudo (`Blob`/`File`, `ArrayBuffer` o vista); falla con cualquier otro. */
export async function bytesDe(cuerpo: unknown): Promise<Uint8Array> {
  if (cuerpo instanceof Uint8Array) return cuerpo;
  if (ArrayBuffer.isView(cuerpo)) {
    return new Uint8Array(cuerpo.buffer, cuerpo.byteOffset, cuerpo.byteLength);
  }
  if (cuerpo instanceof ArrayBuffer) return new Uint8Array(cuerpo);
  if (typeof Blob !== "undefined" && cuerpo instanceof Blob) {
    return new Promise<Uint8Array>((resolver, rechazar) => {
      const lector = new FileReader();
      lector.onload = () => resolver(new Uint8Array(lector.result as ArrayBuffer));
      lector.onerror = () => rechazar(lector.error);
      lector.readAsArrayBuffer(cuerpo);
    });
  }
  throw new Error(`el cuerpo no es crudo: ${Object.prototype.toString.call(cuerpo)}`);
}
