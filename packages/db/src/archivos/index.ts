// Repositorios de archivos generados (spec 012b). `packages/db` no depende de `domain` ni de `storage`.
export { ArchivosRepoError } from "./errores";
export { insertarVersion, ultimaVersion } from "./versiones";
export type { LibroArchivo, NuevaVersionArchivo, VersionArchivo } from "./versiones";
export { leerVersion, listarVersiones } from "./lectura";
