import type { ColumnaCompra, Destino } from "@contapp/domain";

export type MontosPlanos = Record<ColumnaCompra, string> & { total: string };

export interface FilaCompra {
  id: string;
  tipo: string; // 01 factura, 03 boleta, 07 NC…
  serie: string;
  numero: string;
  fecha: string; // AAAA-MM-DD
  proveedorRuc: string;
  montos: MontosPlanos; // siempre en PEN
  usd?: { montos: MontosPlanos; tipoCambio: string };
  excluida?: boolean;
  motivoExclusion?: string;
  agregada?: boolean;
}

export interface FilaVenta {
  id: string;
  tipo: string;
  serie: string;
  numero: string;
  fecha: string;
  docCliente: string;
  nombreCliente: string;
  base: string;
  igv: string;
  exonerado: string;
  total: string;
  agregada?: boolean;
}

export type Afectacion = "Gravado" | "Exonerado" | "Inafecto";

export interface XmlItem {
  descripcion: string;
  cantidad: string;
  unidad: string;
  precioUnitario: string;
  valor: string;
  afectacion: Afectacion;
  igv: string;
  isc: string;
  icbper: string;
}

export interface XmlDemo {
  moneda: "PEN" | "USD";
  tipoCambio?: string;
  items: XmlItem[];
  gravado: string;
  igv: string;
  noGravado: string;
  isc: string;
  icbper: string;
  total: string;
  /** Subido a mano por el usuario (no simulado). */
  subido?: boolean;
}

/** Estado de descarga del XML de un comprobante (RF-097 a RF-099). */
export type EstadoXml = "disponible" | "no_encontrado" | "pendiente";

export interface Proveedor {
  ruc: string;
  razonSocial: string;
  rubro: string;
  emisorIsc?: boolean;
}

export type EstadoCredencial = "valida" | "invalida" | "sin" | "verificando";

export interface Cliente {
  id: string;
  ruc: string;
  razonSocial: string;
  regimen: string;
  ubicacion: string;
  actividad: string;
  zonaSelva: boolean;
  ventasExoneradas: boolean;
  responsable: string;
  credencialSol: EstadoCredencial;
  credencialSire: EstadoCredencial;
  usuarioSol?: string;
  activo: boolean;
}

export interface PropuestaSemilla {
  compras: FilaCompra[];
  ventas: FilaVenta[];
  xml: Record<string, XmlDemo>;
  /** XML que el simulador entrega al «Reintentar descarga» (no lo encontró en el primer intento). */
  xmlReintento: Record<string, XmlDemo>;
}

export interface VersionArchivo {
  version: number;
  nombreZip: string;
  nombreTxt: string;
  sha256Txt: string;
  sha256Zip: string;
  lineas: number;
  usuario: string;
  fecha: string;
  formato: string;
  zipBase64: string;
  ticket?: { numero: string; estado: "enviado" | "procesado" | "con_errores" };
}

export interface EstadoPeriodo {
  ventasCargadas: boolean;
  comprasCargadas: boolean;
  ventas: FilaVenta[];
  comprasOriginales: FilaCompra[];
  compras: FilaCompra[];
  xmlEstado: Record<string, EstadoXml>;
  xml: Record<string, XmlDemo>;
  /** Hallazgos que el contador resolvió o descartó (clave filaId:regla:destino). */
  resueltos: string[];
  deshacer: FilaCompra[][];
  rehacer: FilaCompra[][];
  revisado: boolean;
  versiones: VersionArchivo[];
}

export interface Mensaje {
  id: string;
  clienteId: string;
  buzon: "SOL" | "Notificaciones SUNAT";
  asunto: string;
  tipo: "Notificación" | "Resolución de determinación" | "Resolución de multa" | "Cobranza coactiva" | "Requerimiento de fiscalización" | "Comunicado";
  fecha: string;
  leidoSunat: boolean;
  critico: boolean;
  contenido: string;
  adjunto?: string;
  atendido?: { usuario: string; fecha: string; comentario: string };
}

export interface MesProrrata {
  periodo: string;
  gravadas: string;
  noGravadas: string;
  origen: "Declarado (PDT 621)" | "SIRE" | "Manual";
}

export interface Aprendida {
  proveedorRuc: string;
  destino: Destino;
  aplicada: number;
  aceptada: number;
  activa: boolean;
}

export interface EventoAuditoria {
  id: string;
  fecha: string;
  usuario: string;
  accion: string;
  cliente?: string;
  detalle: string;
}

export interface Notificacion {
  id: string;
  fecha: string;
  texto: string;
  tipo: "info" | "exito" | "alerta";
  leida: boolean;
  enlace?: string;
}

export interface Trabajo {
  id: string;
  tipo: string;
  cliente?: string;
  pasos: string[];
  paso: number;
  estado: "en_cola" | "ejecutando" | "completado" | "fallido";
  inicio: string;
  detalle?: string;
}

export interface Usuario {
  id: string;
  nombre: string;
  email: string;
  rol: "Administrador" | "Contador" | "Asistente";
  activo: boolean;
}
