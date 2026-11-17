import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * Códigos propios de las rutas del buzón (spec 023, D-6). `cliente_archivado` y `credencial_no_configurada` son de `AccesoError`;
 * aquí van la credencial inválida (409) y el enfriamiento de «Revisar ahora» (429, con `Retry-After`).
 */
export type CodigoBuzon = "credencial_invalida" | "captura_reciente";

const ESTADO: Record<CodigoBuzon, number> = {
  credencial_invalida: HttpStatus.CONFLICT,
  captura_reciente: HttpStatus.TOO_MANY_REQUESTS,
};

/** Error del buzón: cuerpo `{ codigo }` sin eco de la entrada ni datos del cliente; el filtro global lo responde tal cual. */
export class BuzonError extends HttpException {
  readonly codigo: CodigoBuzon;
  /** Segundos que debe esperar quien pide (solo `captura_reciente`); el controlador lo pone en `Retry-After`. */
  readonly reintentarEnSeg?: number;

  constructor(codigo: CodigoBuzon, reintentarEnSeg?: number) {
    super({ codigo }, ESTADO[codigo]);
    this.name = "BuzonError";
    this.codigo = codigo;
    if (reintentarEnSeg !== undefined) this.reintentarEnSeg = reintentarEnSeg;
  }
}
