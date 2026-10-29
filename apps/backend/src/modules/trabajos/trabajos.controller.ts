import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { TrabajoVista } from "@contapp/shared";
import type { SesionResuelta } from "../auth/auth.service.js";
import { Sesion, SinRenovarSesion } from "../auth/guards/decoradores.js";
import { SoloEstudio } from "../acceso/guards/decoradores.js";
import { StreamService, type RespuestaSse } from "./stream.service.js";
import { TrabajosService } from "./trabajos.service.js";

/**
 * Estado de los trabajos (D11, CA-5 a CA-7). Las tres rutas son `@SoloEstudio`: el alcance (005) lo aplica el servicio
 * con el rol de la membresía activa, y cancelar decide 404/403/409 con el rol y el creador (D9). Sin `:clienteId`.
 */
@Controller("trabajos")
export class TrabajosController {
  constructor(
    @Inject(TrabajosService) private readonly trabajos: TrabajosService,
    @Inject(StreamService) private readonly streams: StreamService,
  ) {}

  @SoloEstudio()
  @Get()
  listar(
    @Sesion() sesion: SesionResuelta,
    @Query() query: Record<string, unknown>,
  ): Promise<TrabajoVista[]> {
    return this.trabajos.listar(sesion, query);
  }

  /** D22: ni la apertura ni la revalidación renuevan la sesión (el stream no cuenta como actividad). */
  @SoloEstudio()
  @SinRenovarSesion()
  @Get("stream")
  stream(
    @Sesion() sesion: SesionResuelta,
    @Req() req: { headers: { cookie?: string } },
    @Res() res: RespuestaSse,
  ): Promise<void> {
    return this.streams.abrir(sesion, req.headers.cookie, res);
  }

  @SoloEstudio()
  @Post(":trabajoId/cancelar")
  @HttpCode(200)
  cancelar(
    @Sesion() sesion: SesionResuelta,
    @Param("trabajoId") trabajoId: string,
  ): Promise<TrabajoVista> {
    return this.trabajos.cancelar(sesion, trabajoId);
  }
}
