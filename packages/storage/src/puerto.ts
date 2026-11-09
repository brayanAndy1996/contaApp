/** Puerto de almacenamiento de archivos (spec 016). Las rutas se construyen con `rutaXml`. */
export interface StorageProvider {
  guardar(ruta: string, bytes: Uint8Array): Promise<void>;
  leer(ruta: string): Promise<Uint8Array>;
  eliminar(ruta: string): Promise<void>;
}
