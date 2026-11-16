// Fila de la BD -> DTO de respuesta (spec 014). Ni la clave interna, ni la propuesta, ni el usuario del estudio salen. Los montos
// son las cadenas exactas de la BD; la explicación, el destino y el dato de cada hallazgo los reconstruye el dominio.
import type {
  CompraLeida,
  CompraListada,
  DetalleCompraLeido,
  HallazgoGuardadoCompra,
  SegunHistorialCompra,
  VersionHistorialCompra,
} from "@contapp/db";
import { detallarHallazgo } from "@contapp/domain";
import { autorDe, type Autores } from "./autor.js";
import type {
  DetalleCompra,
  FilaCompraVista,
  HallazgoVista,
  SugerenciaVista,
  VersionCompraVista,
} from "@contapp/shared";

export function aHallazgoVista(h: HallazgoGuardadoCompra): HallazgoVista {
  const d = detallarHallazgo(h);
  return {
    regla: h.regla as HallazgoVista["regla"],
    destino: d.destino,
    explicacion: d.explicacion,
    sugerencia: h.sugerencia as SugerenciaVista | null,
    requiereConfirmacion: h.requiereConfirmacion,
    dato: d.dato,
    masiva: d.masiva,
  };
}

export function aFilaVista(
  c: CompraLeida,
  proveedorNuevo: boolean,
  hallazgos: HallazgoGuardadoCompra[],
  segunHistorial: SegunHistorialCompra | null,
): FilaCompraVista {
  return {
    id: c.id,
    origen: c.origen,
    tipo: c.tipoDoc,
    serie: c.serie,
    numero: c.numero,
    proveedor: { tipo: c.docTipo, numero: c.docNumero, razonSocial: c.razonSocial },
    fecha: c.fecha,
    moneda: c.moneda,
    tipoCambio: c.tipoCambio,
    version: c.version,
    montos: { ...c.montos },
    excluida: c.excluida,
    motivo: c.motivo,
    clasificada: c.clasificada,
    proveedorNuevo,
    segunHistorial: segunHistorial === null ? null : { reglaId: segunHistorial.reglaId },
    hallazgos: hallazgos.map(aHallazgoVista),
  };
}

export const aFilaListada = (l: CompraListada): FilaCompraVista => aFilaVista(l.compra, l.proveedorNuevo, l.hallazgos, l.segunHistorial);

export function aVersionVista(v: VersionHistorialCompra, autores: Autores): VersionCompraVista {
  return {
    n: v.n,
    accion: v.accion as VersionCompraVista["accion"],
    operacionId: v.operacionId,
    usuarioId: v.usuarioId,
    autor: autorDe(autores, v.usuarioId),
    creadaEn: v.creadaEn.toISOString(),
    excluida: v.excluida,
    motivo: v.motivo,
    clasificada: v.clasificada,
    montos: { ...v.montos },
  };
}

export function aDetalleVista(d: DetalleCompraLeido, autores: Autores): DetalleCompra {
  const vigente = aFilaVista(d.compra, d.proveedorNuevo, d.hallazgos, d.segunHistorial);
  const versiones = d.versiones.map((v) => aVersionVista(v, autores));
  return { original: versiones[0]!, vigente, versiones, hallazgos: vigente.hallazgos };
}
