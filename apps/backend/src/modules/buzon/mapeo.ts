// Del repositorio de la bandeja (spec 024) a los contratos de `@contapp/shared`. Sin IO. El comentario de una atención solo sale en
// el detalle y en el historial; las filas de la lista llevan únicamente quién, cuándo y el estado.
import type { AtencionVigente, DetalleAtencionBuzon, FilaBandejaBuzon } from "@contapp/db";
import type { AtencionDetalle, AtencionFila, EventoAtencion, FilaBandeja } from "@contapp/shared";

/** `usuario.nombre` es obligatorio en el contrato; un usuario sin nombre (no debería ocurrir) sale como texto vacío. */
const usuario = (u: { id: string; nombre: string | null }) => ({ id: u.id, nombre: u.nombre ?? "" });

export function aAtencionFila(a: AtencionVigente): AtencionFila {
  return {
    estado: a.estado,
    por: a.por === null ? null : usuario(a.por),
    en: a.en === null ? null : a.en.toISOString(),
  };
}

export function aAtencionDetalle(d: DetalleAtencionBuzon): AtencionDetalle {
  return { ...aAtencionFila(d), comentario: d.comentario };
}

export function aEventos(d: DetalleAtencionBuzon): EventoAtencion[] {
  return d.historial.map((e) => ({
    accion: e.accion,
    comentario: e.comentario,
    usuario: usuario(e.usuario),
    en: e.en.toISOString(),
  }));
}

export function aFilaBandeja(f: FilaBandejaBuzon): FilaBandeja {
  return {
    id: f.id,
    asunto: f.asunto,
    remitente: f.remitente,
    fecha: f.fecha.toISOString(),
    categoria: f.categoria as FilaBandeja["categoria"],
    critico: f.critico,
    motivoCritico: f.motivoCritico as FilaBandeja["motivoCritico"],
    leidoEnSunat: f.leidoEnSunat,
    contenidoObtenido: f.contenidoObtenido,
    adjuntosDeclarados: f.adjuntosDeclarados,
    cliente: { id: f.cliente.id, razonSocial: f.cliente.razonSocial, archivado: f.cliente.archivado },
    atencion: aAtencionFila(f.atencion),
  };
}
