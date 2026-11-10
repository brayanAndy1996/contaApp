// El previo de un archivo SIRE (spec 012b, D1, D2, D12; plan, Contratos: HTTP y Dominio). Lo comparten `GET …/previo` y el `POST`:
// una sola composición (`prepararArchivo` de `domain`, la misma del worker) para que lo que se ve sea lo que se genera, y la huella
// lo verifica. Solo lee; el que llama decide la transacción (`foto: true` en ambos casos). Nada de la petición entra a `prepararArchivo`:
// ni `registro` ni `permitirProvisional` (D2), y el `NODE_ENV` se lee en cada llamada.
import {
  leerClienteDto,
  leerEstadoPeriodo,
  leerEstadoPeriodoVentas,
  leerExcluidasVentas,
  leerFilasReemplazo,
  leerFilasReemplazoVentas,
  leerProveedoresConocidos,
  listarJustificados,
  ultimaVersion,
  type Alcance,
  type LibroArchivo,
  type Tx,
  type VentaFila,
} from "@contapp/db";
import {
  compraLeidaAFila,
  DICCIONARIO_GLOSAS_BASE,
  DineroError,
  erroresDeFilaVenta,
  permiteProvisional,
  prepararArchivo,
  ventaAFila,
  type ArchivoPreparado,
  type AvisoArchivo,
  type CabeceraTxt,
  type ErrorPrevalidacion,
  type FilaReemplazo,
  type FilaReemplazoVenta,
} from "@contapp/domain";
import {
  MAX_ITEMS_PREVIO,
  type AvisoPrevioDto,
  type ErrorPrevioDto,
  type EstadoPeriodoRespuesta,
  type ExcluidaPrevioDto,
  type PrevioArchivoDto,
  type ResumenArchivoDto,
} from "@contapp/shared";
import { sha256Hex } from "@contapp/storage";
import { exigirCliente } from "../compras/apoyo.js";
import { ComprasError } from "../compras/errores.js";
import { exigir } from "../compras/escritura.js";
import { aRespuestaEstado } from "../compras/periodo.service.js";

/** Lo que un previo necesita de la petición: el alcance del actor y el cliente, periodo y libro de la ruta. */
export interface EntradaPrevio {
  alcance: Alcance;
  clienteId: string;
  periodo: string;
  libro: LibroArchivo;
  /** `NODE_ENV` del servidor, leído por quien llama en cada petición; nunca de la petición. */
  nodeEnv: string | undefined;
}

/** El previo y los datos que el `POST` necesita para sus comprobaciones en orden. */
export interface PrevioCalculado {
  dto: PrevioArchivoDto;
  archivado: boolean;
  /** `true` si solo hay formatos provisionales y el entorno no los permite (D2). */
  formatoNoOficial: boolean;
}

/** Lo que se sabe del cliente y del periodo antes de leer las filas (para que el `POST` rechace barato). */
export interface ContextoPrevio {
  archivado: boolean;
  estado: EstadoPeriodoRespuesta;
}

const comprobante = (serie: string, numero: string): string => `${serie}-${numero}`;

function aResumenDto(r: ArchivoPreparado["resumen"]): ResumenArchivoDto {
  const i = r.impactoIgv;
  return {
    modificadas: r.modificadas,
    excluidas: r.excluidas,
    agregadas: r.agregadas,
    impactoIgv:
      "DG" in i
        ? { DG: i.DG.toString(), DGNG: i.DGNG.toString(), DNG: i.DNG.toString(), total: i.total.toString() }
        : { DG: null, DGNG: null, DNG: null, total: i.total.toString() },
    filasSinConvertir: [...r.filasSinConvertir],
  };
}

function aErrorDto(e: ErrorPrevalidacion, excluible: boolean): ErrorPrevioDto {
  return {
    filaId: e.filaId,
    codigo: e.codigo,
    campo: e.campo,
    destino: e.destino,
    explicacion: e.explicacion,
    diferencia: e.diferencia === null ? null : e.diferencia.toString(),
    excluible,
  };
}

const aAvisoDto = (a: AvisoArchivo): AvisoPrevioDto => ({ filaId: a.filaId, codigo: a.codigo, explicacion: a.explicacion });

/** Lo que `packages/db` entrega de una venta → fila de ventas del dominio (`excluida` = exclusión vigente). */
const filaDeVenta = (v: VentaFila): FilaReemplazoVenta => ventaAFila({ ...v, excluida: v.exclusion !== null });

interface Filas {
  preparado: ArchivoPreparado;
  /** Avisos del adaptador (razón social recortada) de las filas que van al TXT. */
  avisosAdaptador: AvisoArchivo[];
  /** Por id de fila: si el error de esa fila se puede excluir (solo ventas; D12). */
  excluible: (filaId: string | null) => boolean;
  excluidas: ExcluidaPrevioDto[];
  excluidasOmitidas: number;
}

async function prepararCompras(tx: Tx, e: EntradaPrevio, cabecera: CabeceraTxt, permitir: boolean): Promise<Filas> {
  const porFila = new Map<string, AvisoArchivo[]>();
  const { original, vigente } = await leerFilasReemplazo(tx, e.clienteId, e.periodo, (c) => {
    const r = compraLeidaAFila(c);
    if (r.avisos.length > 0) porFila.set(r.fila.id, r.avisos);
    return r.fila;
  });
  // Un aviso por razón social recortada, solo de las filas que van al TXT (las excluidas no).
  const avisosAdaptador = vigente.filter((f: FilaReemplazo) => f.estado !== "excluida").flatMap((f) => porFila.get(f.id) ?? []);
  const conocidos = await leerProveedoresConocidos(tx, e.clienteId, e.periodo);
  const preparado = prepararArchivo({
    libro: "compras",
    cabecera,
    original,
    vigente,
    reglas: { proveedoresConocidos: conocidos, proveedoresIsc: [], diccionario: DICCIONARIO_GLOSAS_BASE },
    permitirProvisional: permitir,
  });
  // En compras nada se excluye por error (la zapatilla cuenta en `resumen.excluidas`): D12 es solo de ventas del SIRE.
  return { preparado, avisosAdaptador, excluible: () => false, excluidas: [], excluidasOmitidas: 0 };
}

async function prepararVentas(tx: Tx, e: EntradaPrevio, cabecera: CabeceraTxt, permitir: boolean): Promise<Filas> {
  const { original, vigente } = await leerFilasReemplazoVentas(tx, e.clienteId, e.periodo, filaDeVenta);
  const saltos = (await listarJustificados(tx, e.clienteId, e.periodo)).map((j) => ({
    tipo: j.tipo,
    serie: j.serie,
    desde: j.desde,
    hasta: j.hasta,
    comentario: j.comentario,
  }));
  const preparado = prepararArchivo({ libro: "ventas", cabecera, original, vigente, saltos, permitirProvisional: permitir });
  const filas = new Map(vigente.map((f) => [f.id, f] as const));
  // D12: es excluible la venta del SIRE (no manual, no excluida) que tiene algún error de su propia fila, la misma regla con la
  // que `excluir` decide; así la pantalla no ofrece «Excluir» donde la API respondería 409 `no_excluible`.
  const memo = new Map<string, boolean>();
  const excluible = (filaId: string | null): boolean => {
    if (filaId === null) return false;
    let r = memo.get(filaId);
    if (r === undefined) {
      const f = filas.get(filaId);
      r = f !== undefined && f.estado === "original" && erroresDeFilaVenta(cabecera, f).length > 0;
      memo.set(filaId, r);
    }
    return r;
  };
  const excluidas = await leerExcluidasVentas(tx, e.clienteId, e.periodo);
  return {
    preparado,
    avisosAdaptador: [],
    excluible,
    excluidas: excluidas
      .slice(0, MAX_ITEMS_PREVIO)
      .map((x) => ({ filaId: x.ventaId, comprobante: comprobante(x.serie, x.numero), motivo: x.motivo })),
    excluidasOmitidas: Math.max(0, excluidas.length - MAX_ITEMS_PREVIO),
  };
}

/**
 * Calcula el previo de (cliente, periodo, libro) dentro de la transacción dada. 404 si el cliente no es del alcance. `antes` se
 * llama con el cliente y el estado ANTES de leer las filas: si lanza, el cálculo pesado no se hace (rechazos baratos del `POST`).
 * Orden de `motivo` (el del `POST`): cliente archivado, periodo generado, formato no oficial, prevalidación fallida.
 */
export async function calcularPrevio(
  tx: Tx,
  e: EntradaPrevio,
  antes?: (c: ContextoPrevio) => void,
): Promise<PrevioCalculado> {
  await exigirCliente(tx, e.clienteId, e.alcance, false);
  const cliente = exigir(await leerClienteDto(tx, e.clienteId));
  const periodoEstado =
    e.libro === "compras" ? await leerEstadoPeriodo(tx, e.clienteId, e.periodo) : await leerEstadoPeriodoVentas(tx, e.clienteId, e.periodo);
  const estado = aRespuestaEstado(periodoEstado);
  antes?.({ archivado: cliente.archivado, estado });

  const cabecera: CabeceraTxt = { rucDeclarante: cliente.ruc, periodo: e.periodo, libro: e.libro };
  const permitir = permiteProvisional(e.nodeEnv);
  let filas: Filas;
  try {
    filas = e.libro === "compras" ? await prepararCompras(tx, e, cabecera, permitir) : await prepararVentas(tx, e, cabecera, permitir);
  } catch (err) {
    // Una suma que no cabe en NUMERIC(14,2) es un error controlado (como en el resumen de 014), nunca un 500.
    if (err instanceof DineroError) throw new ComprasError("resumen_fuera_de_rango");
    throw err;
  }
  const { preparado } = filas;
  const { resultado } = preparado;
  const formatoNoOficial = !resultado.formato.oficial && !permitir;

  let motivo: PrevioArchivoDto["motivo"] = null;
  if (cliente.archivado) motivo = "cliente_archivado";
  else if (estado.estado === "generado") motivo = "periodo_generado";
  else if (formatoNoOficial) motivo = "formato_no_oficial";
  else if (!resultado.apto) motivo = "prevalidacion_fallida";

  const ultima = await ultimaVersion(tx, e.clienteId, e.periodo, e.libro);
  const dto: PrevioArchivoDto = {
    apto: resultado.apto,
    generable: motivo === null,
    motivo,
    errores: resultado.errores.slice(0, MAX_ITEMS_PREVIO).map((x) => aErrorDto(x, filas.excluible(x.filaId))),
    erroresOmitidos: Math.max(0, resultado.errores.length - MAX_ITEMS_PREVIO),
    avisos: [...preparado.avisos, ...filas.avisosAdaptador].map(aAvisoDto),
    resumen: aResumenDto(preparado.resumen),
    excluidas: filas.excluidas,
    excluidasOmitidas: filas.excluidasOmitidas,
    formato: { id: resultado.formato.id, version: resultado.formato.version, oficial: resultado.formato.oficial },
    estado,
    huella: sha256Hex(preparado.canon),
    ultimaVersion: ultima === null ? null : { version: ultima.version, generadoEn: ultima.generadoEn.toISOString() },
    reabiertoTrasUltima: ultima !== null && estado.estado !== "generado",
  };
  return { dto, archivado: cliente.archivado, formatoNoOficial };
}
