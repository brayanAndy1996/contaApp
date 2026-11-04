import { Body, Controller, Get, Header, HttpCode, Inject, Post, StreamableFile } from "@nestjs/common";
import type { InformeImportacion, VistaPrevia } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion } from "../auth/guards/decoradores.js";
import { Permiso } from "../acceso/guards/decoradores.js";
import { ImportacionService } from "./importacion.service.js";
import { generarPlantilla } from "./plantilla.js";

/**
 * Importación de clientes (spec 007b, D7–D9). El permiso base (`clientes.crear`) lo exige `PermisoGuard`; el servicio
 * exige además `credenciales.editar` si el archivo trae claves. El cuerpo es el archivo crudo (`application/octet-stream`,
 * ≤ 2 MB, analizado en `crearApp`): llega como `Buffer` y nada de él se registra ni se devuelve.
 */
@Controller("clientes/importacion")
export class ImportacionController {
  constructor(@Inject(ImportacionService) private readonly servicio: ImportacionService) {}

  /** `POST /clientes/importacion/vista-previa`: no escribe nada. */
  @Permiso("clientes.crear")
  @Post("vista-previa")
  @HttpCode(200)
  vistaPrevia(@Sesion() sesion: SesionResuelta, @Body() cuerpo: unknown): Promise<VistaPrevia> {
    return this.servicio.vistaPrevia(sesion, cuerpo);
  }

  /** `POST /clientes/importacion/confirmar`: crea las filas válidas hasta el cupo y devuelve el informe. */
  @Permiso("clientes.crear")
  @Post("confirmar")
  @HttpCode(200)
  confirmar(@Sesion() sesion: SesionResuelta, @Body() cuerpo: unknown): Promise<InformeImportacion> {
    return this.servicio.confirmar(sesion, cuerpo);
  }

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
