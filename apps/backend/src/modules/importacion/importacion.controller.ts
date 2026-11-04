import { Controller, Get, Header, StreamableFile } from "@nestjs/common";
import { Permiso } from "../acceso/guards/decoradores.js";
import { generarPlantilla } from "./plantilla.js";

/**
 * Importación de clientes (spec 007b, D7–D9). Hoy solo la plantilla; T12 añade la vista previa y la confirmación
 * (`clientes/importacion/vista-previa` y `.../confirmar`). El permiso lo exige `PermisoGuard`.
 */
@Controller("clientes/importacion")
export class ImportacionController {
  /** `GET /clientes/importacion/plantilla`: `.xlsx` en memoria, sin datos de ningún estudio (D7). */
  @Permiso("clientes.crear")
  @Header("Cache-Control", "no-store")
  @Get("plantilla")
  plantilla(): StreamableFile {
    const datos = generarPlantilla();
    return new StreamableFile(datos, {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      disposition: 'attachment; filename="plantilla-clientes.xlsx"',
      length: datos.length,
    });
  }
}
