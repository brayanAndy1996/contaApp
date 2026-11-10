// API pública de archivos/ (spec 012b, plan, Contratos: Dominio).
export type {
  ArchivoPreparado,
  AvisoArchivo,
  CodigoAvisoArchivo,
  CompraLeidaPlana,
  EntradaCanonHuella,
  EntradaPrepararCompras,
  EntradaPrepararVentas,
  MotivoNoGenerable,
  VentaLeidaPlana,
} from "./tipos";
export { compraLeidaAFila, ventaAFila } from "./adaptadores";
export { canonHuella } from "./huella";
export { prepararArchivo } from "./preparar";
export { permiteProvisional } from "./entorno";
