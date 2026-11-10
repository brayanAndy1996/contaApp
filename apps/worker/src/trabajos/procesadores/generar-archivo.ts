// Procesador de `archivo.generar` (spec 012b; plan, «Cola y worker» y «Orden de bloqueo»; D2, D4, D6, D10, D12). Genera el
// TXT/ZIP del reemplazo SIRE de un periodo y libro y guarda la versión.
//
// CONTRATO (lo fijan `generar-archivo{,.int}.spec.ts` y `test/archivos.ts`):
//  - `generarArchivo({ db, storage, nodeEnv?, ahora?, logger? })` devuelve un `Procesador`. `nodeEnv` es el NODE_ENV que decide
//    `permiteProvisional` (D2); si la clave no se pasa, `process.env.NODE_ENV`. `ahora` es el reloj de `generadoEn` del ZIP.
//  - Los rechazos de negocio son `ErrorArchivo` (subclase de `ErrorDatos`, sin reintento; 008 los deja en `datos_invalidos`):
//    el código fino va en `detalle`, nunca con datos de una fila: `parametros_invalidos`, `cliente_archivado`,
//    `estado_invalido`, `resumen_cambiado`, `prevalidacion_fallida` y `formato_no_oficial`. Un rechazo no deja rastro: se lanza
//    dentro de la transacción (el estado vuelve atrás), antes de guardar nada en storage.
//  - Un fallo inesperado (p. ej. de BD tras `storage.guardar`) se propaga tal cual, tras borrar el ZIP (mejor esfuerzo; si no
//    se puede, se registra solo un código).
//  - `resultado` = exactamente `{ archivoId, version, nueva, lineas, provisional }` (D6).
//
// Secuencia, en UNA `withTenant` (D4): cliente activo -> advisory `propuesta:{libro}:{periodo}:{cliente}` -> compare-and-set del
// estado del periodo (`estadoVisto` -> `generado`, `FOR UPDATE`; si no pasa y el periodo ya está `generado` con la última versión
// de la misma huella, devuelve esa versión: reintento tras el commit) -> filas (y proveedores conocidos o justificados) ->
// `prepararArchivo` -> formato, huella y aptitud -> `generarTxt` -> TXT idéntico a la última versión (P-5): devuelve esa ->
// `empaquetar` -> `storage.guardar` -> `insertarVersion` (máx + 1; el trigger exige el periodo `generado` por quien genera).
// Nada de filas, montos, razones sociales, motivos, bytes ni rutas llega a logs, errores ni `resultado` (D10).
import { randomUUID } from "node:crypto";
import {
  bloquearPeriodoLibro,
  fijarEstadoPeriodo,
  fijarEstadoPeriodoVentas,
  insertarVersion,
  leerEstadoPeriodo,
  leerEstadoPeriodoVentas,
  leerFilasReemplazo,
  leerFilasReemplazoVentas,
  leerProveedoresConocidos,
  listarJustificados,
  ultimaVersion,
  type ContappDb,
  type Tx,
  type VersionArchivo,
} from "@contapp/db";
import {
  DICCIONARIO_GLOSAS_BASE,
  compraLeidaAFila,
  generarTxt,
  permiteProvisional,
  prepararArchivo,
  ventaAFila,
  type ArchivoPreparado,
  type AvisoArchivo,
  type CabeceraTxt,
  type ContextoReglas,
  type FilaReemplazo,
  type FilaReemplazoVenta,
  type ResumenCambios,
  type ResumenCambiosVentas,
} from "@contapp/domain";
import { ARCHIVO_GENERAR, type ParametrosGenerarArchivo } from "@contapp/queue";
import { rutaArchivo, sha256Hex, type StorageProvider } from "@contapp/storage";
import { ErrorDatos, empaquetar } from "@contapp/sunat";
import type { Procesador, TrabajoEnCurso } from "../ejecutor.js";
import { registrar, type LoggerTrabajos } from "../registro.js";

export type DetalleErrorArchivo =
  | "parametros_invalidos"
  | "cliente_archivado"
  | "estado_invalido"
  | "resumen_cambiado"
  | "prevalidacion_fallida"
  | "formato_no_oficial";

export class ErrorArchivo extends ErrorDatos {
  constructor(readonly detalle: DetalleErrorArchivo) {
    super();
  }
}

export interface DepsGenerarArchivo {
  db: Pick<ContappDb, "withTenant">;
  storage: StorageProvider;
  /** NODE_ENV para `permiteProvisional` (D2). Sin la clave, `process.env.NODE_ENV`. */
  nodeEnv?: string | undefined;
  /** Reloj de la fecha del ZIP; por defecto `new Date()`. */
  ahora?: () => Date;
  /** Donde se registra (solo un código, nunca datos ni rutas) el borrado fallido de un ZIP huérfano. */
  logger?: LoggerTrabajos;
}

/** Forma del `resultado` del trabajo (D6): solo estos cinco campos. */
export interface ResultadoGenerarArchivo {
  archivoId: string;
  version: number;
  nueva: boolean;
  lineas: number;
  provisional: boolean;
}

// El cliente sigue activo (no archivado) en el estudio de la transacción; RLS deja fuera a los de otro estudio.
const SQL_CLIENTE_ACTIVO = "select archivado_at is null as activo from cliente where id = $1::uuid";

const resultadoDe = (v: VersionArchivo, nueva: boolean): ResultadoGenerarArchivo => ({
  archivoId: v.id,
  version: v.version,
  nueva,
  lineas: v.lineas,
  provisional: v.provisional,
});

// Mismo filtro que el historial de las reglas de 014 (`proveedoresValidos` del dominio): un documento guardado fuera de
// gramática no entra al contexto (ahí lanzaría) y solo deja de servir para R-NEW.
const TIPO_DOC = /^[0-9A-Z]$/;
const NUMERO_DOC = /^[0-9A-Z-]{1,15}$/;
function contextoReglas(conocidos: readonly { tipo: string; numero: string }[]): ContextoReglas {
  const vistos = new Set<string>();
  const validos: { tipo: string; numero: string }[] = [];
  for (const c of conocidos) {
    const numero = c.numero.replace(/\s/g, "").replace(/[a-z]/g, (x) => x.toUpperCase());
    const clave = `${c.tipo}:${numero}`;
    if (!TIPO_DOC.test(c.tipo) || !NUMERO_DOC.test(numero) || vistos.has(clave)) continue;
    vistos.add(clave);
    validos.push({ tipo: c.tipo, numero });
  }
  return { proveedoresConocidos: validos, proveedoresIsc: [], diccionario: DICCIONARIO_GLOSAS_BASE };
}

/** Conteos por código (lo que guarda `archivo_generado.avisos`); la lista por fila solo se ve en el previo. */
function conteos(avisos: readonly AvisoArchivo[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const a of avisos) c[a.codigo] = (c[a.codigo] ?? 0) + 1;
  return c;
}

interface Preparado {
  preparado: ArchivoPreparado;
  vigente: readonly FilaReemplazo[] | readonly FilaReemplazoVenta[];
  /** Avisos de los adaptadores (D7: razón social recortada) de las filas que van al TXT. */
  avisosFilas: AvisoArchivo[];
}

async function prepararCompras(
  tx: Tx,
  t: TrabajoEnCurso,
  cabecera: CabeceraTxt,
  permitirProvisional: boolean,
): Promise<Preparado> {
  const filas = await leerFilasReemplazo(tx, t.clienteId, cabecera.periodo, compraLeidaAFila);
  const reglas = contextoReglas(await leerProveedoresConocidos(tx, t.clienteId, cabecera.periodo));
  const vigente = filas.vigente.map((f) => f.fila);
  const preparado = prepararArchivo({
    libro: "compras",
    cabecera,
    original: filas.original.map((f) => f.fila),
    vigente,
    reglas,
    permitirProvisional,
  });
  const avisosFilas = filas.vigente.filter((f) => f.fila.estado !== "excluida").flatMap((f) => f.avisos);
  return { preparado, vigente, avisosFilas };
}

async function prepararVentas(
  tx: Tx,
  t: TrabajoEnCurso,
  cabecera: CabeceraTxt,
  permitirProvisional: boolean,
): Promise<Preparado> {
  const filas = await leerFilasReemplazoVentas(tx, t.clienteId, cabecera.periodo, (v) =>
    ventaAFila({ ...v, excluida: v.exclusion !== null }),
  );
  const saltos = (await listarJustificados(tx, t.clienteId, cabecera.periodo)).map((j) => ({
    tipo: j.tipo,
    serie: j.serie,
    desde: j.desde,
    hasta: j.hasta,
    comentario: j.comentario,
  }));
  const preparado = prepararArchivo({
    libro: "ventas",
    cabecera,
    original: filas.original,
    vigente: filas.vigente,
    saltos,
    permitirProvisional,
  });
  return { preparado, vigente: filas.vigente, avisosFilas: [] };
}

/** Impacto en IGV de la versión: por destino solo en compras (en ventas los tres son NULL). */
function impactos(
  libro: ParametrosGenerarArchivo["libro"],
  resumen: ResumenCambios | ResumenCambiosVentas,
): Pick<VersionArchivo, "impactoIgvDg" | "impactoIgvDgng" | "impactoIgvDng" | "impactoIgvTotal"> {
  if (libro === "compras") {
    const i = (resumen as ResumenCambios).impactoIgv;
    return {
      impactoIgvDg: i.DG.toString(),
      impactoIgvDgng: i.DGNG.toString(),
      impactoIgvDng: i.DNG.toString(),
      impactoIgvTotal: i.total.toString(),
    };
  }
  return {
    impactoIgvDg: null,
    impactoIgvDgng: null,
    impactoIgvDng: null,
    impactoIgvTotal: resumen.impactoIgv.total.toString(),
  };
}

export function generarArchivo(d: DepsGenerarArchivo): Procesador {
  const ahora = d.ahora ?? (() => new Date());
  return async ({ trabajo: t }) => {
    // Defensa en profundidad: el catálogo ya validó al encolar. Sin repetir lo recibido.
    const p = ARCHIVO_GENERAR.parametros.safeParse(t.parametros);
    if (!p.success || t.creadoPor === null) throw new ErrorArchivo("parametros_invalidos");
    const { periodo, libro, estadoVisto, huella } = p.data;
    const usuario = t.creadoPor;
    const nodeEnv = "nodeEnv" in d ? d.nodeEnv : process.env.NODE_ENV;
    const permitirProvisional = permiteProvisional(nodeEnv);
    const cabecera: CabeceraTxt = { rucDeclarante: t.ruc, periodo, libro };

    let guardada: string | null = null;
    try {
      return await d.db.withTenant({ tenantId: t.tenantId }, async (tx): Promise<ResultadoGenerarArchivo> => {
        // (1) Cliente activo.
        const cliente = await tx.query<{ activo: boolean }>(SQL_CLIENTE_ACTIVO, [t.clienteId]);
        if (cliente.rows[0]?.activo !== true) throw new ErrorArchivo("cliente_archivado");

        // (2) Advisory del periodo y libro: serializa con descargas, escrituras de ventas y otros `archivo.generar`.
        await bloquearPeriodoLibro(tx, t.clienteId, periodo, libro);

        // (3) Estado: compare-and-set `estadoVisto` -> `generado` (FOR UPDATE), ANTES de leer las filas.
        const fijado =
          libro === "compras"
            ? await fijarEstadoPeriodo(tx, t.clienteId, periodo, estadoVisto, "generado", usuario)
            : await fijarEstadoPeriodoVentas(tx, t.clienteId, periodo, estadoVisto, "generado", usuario);
        if (fijado === null) {
          // D6: reintento tras un commit sin acuse (o el segundo de dos trabajos con el mismo previo).
          const estado =
            libro === "compras"
              ? await leerEstadoPeriodo(tx, t.clienteId, periodo)
              : await leerEstadoPeriodoVentas(tx, t.clienteId, periodo);
          const ultima = estado.estado === "generado" ? await ultimaVersion(tx, t.clienteId, periodo, libro) : null;
          if (ultima !== null && ultima.huella === huella) return resultadoDe(ultima, false);
          throw new ErrorArchivo("estado_invalido");
        }

        // (4) Filas y el mismo armado del previo que el backend.
        const { preparado, vigente, avisosFilas } =
          libro === "compras"
            ? await prepararCompras(tx, t, cabecera, permitirProvisional)
            : await prepararVentas(tx, t, cabecera, permitirProvisional);

        // (5) Formato (D2), huella (P-2; antes que la prevalidación, como el 409 antes del 422) y aptitud.
        if (!preparado.resultado.formato.oficial && !permitirProvisional) throw new ErrorArchivo("formato_no_oficial");
        if (sha256Hex(preparado.canon) !== huella) throw new ErrorArchivo("resumen_cambiado");
        if (!preparado.resultado.apto) throw new ErrorArchivo("prevalidacion_fallida");
        if (!preparado.generable) throw new ErrorArchivo(preparado.motivo ?? "prevalidacion_fallida");

        // (6) TXT. Si sale idéntico a la última versión (mismo formato), no hay versión nueva (P-5).
        const txt =
          libro === "compras"
            ? generarTxt(vigente as readonly FilaReemplazo[], cabecera, { permitirProvisional })
            : generarTxt(vigente as readonly FilaReemplazoVenta[], cabecera, { permitirProvisional });
        const sha256Txt = sha256Hex(txt.bytes);
        const ultima = await ultimaVersion(tx, t.clienteId, periodo, libro);
        if (
          ultima !== null &&
          ultima.sha256Txt === sha256Txt &&
          ultima.formatoId === txt.formato.id &&
          ultima.formatoVersion === txt.formato.version
        ) {
          return resultadoDe(ultima, false);
        }

        // (7) ZIP -> storage -> versión. Si algo falla desde aquí, el `catch` de afuera borra el ZIP.
        const id = randomUUID();
        const ruta = rutaArchivo(t.tenantId, t.clienteId, id);
        const paquete = empaquetar(txt.bytes, { nombreTxt: txt.nombreTxt, nombreZip: txt.nombreZip }, ahora());
        guardada = ruta;
        await d.storage.guardar(ruta, paquete.zip);
        const resumen = preparado.resumen;
        const version = await insertarVersion(tx, {
          id,
          clienteId: t.clienteId,
          periodo,
          libro,
          version: (ultima?.version ?? 0) + 1,
          formatoId: txt.formato.id,
          formatoVersion: txt.formato.version,
          provisional: txt.provisional,
          nombreTxt: txt.nombreTxt,
          nombreZip: paquete.nombreZip,
          sha256Txt: paquete.sha256Txt,
          sha256Zip: paquete.sha256Zip,
          bytesZip: paquete.zip.length,
          lineas: txt.lineas,
          huella,
          modificadas: resumen.modificadas,
          excluidas: resumen.excluidas,
          agregadas: resumen.agregadas,
          ...impactos(libro, resumen),
          avisos: conteos([...preparado.avisos, ...avisosFilas]),
          ruta,
          trabajoId: t.id,
          generadoPor: usuario,
        });
        return resultadoDe(version, true);
      });
    } catch (e) {
      const huerfano = guardada as string | null;
      if (huerfano !== null) {
        await d.storage.eliminar(huerfano).catch(() => {
          // Queda sin fila que lo apunte: nadie lo ve. Solo el código, nunca la ruta.
          if (d.logger !== undefined)
            registrar(d.logger, "warn", { evento: "archivo_huerfano", codigo: "zip_no_borrado" });
        });
      }
      throw e;
    }
  };
}
