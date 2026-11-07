import { HttpException, HttpStatus } from "@nestjs/common";

/** Códigos de error propios de las rutas de compras (spec 014). Los de acceso (404, 400, 409 archivado) son de `AccesoError`. */
export type CodigoCompras =
  | "periodo_revisado"
  | "periodo_generado"
  | "resumen_fuera_de_rango"
  | "version_obsoleta"
  | "fila_excluida"
  | "no_excluida"
  | "no_descartable"
  | "duplicado"
  | "fila_cambiada"
  | "nada_que_deshacer"
  | "nada_que_rehacer"
  | "revisar_de_nuevo"
  | "requiere_dato"
  | "requiere_confirmacion"
  | "estado_invalido";

const ESTADO: Record<CodigoCompras, number> = {
  // D-9: el periodo está revisado y quien escribe no tiene `sire.aprobar_generar`.
  periodo_revisado: HttpStatus.FORBIDDEN,
  // D-9: el periodo ya generó su archivo; nadie escribe hasta reabrirlo.
  periodo_generado: HttpStatus.CONFLICT,
  // D-8: una suma excede NUMERIC(14,2) (`MontoFueraDeRangoError` del dominio): error controlado, nunca un 500.
  resumen_fuera_de_rango: HttpStatus.UNPROCESSABLE_ENTITY,
  // D-2: la versión base ya no es la vigente (el cuerpo trae `versionVigente`).
  version_obsoleta: HttpStatus.CONFLICT,
  // D-6: una excluida no se edita; restaurar exige una excluida.
  fila_excluida: HttpStatus.CONFLICT,
  no_excluida: HttpStatus.CONFLICT,
  // D-7: solo las agregadas se descartan.
  no_descartable: HttpStatus.CONFLICT,
  // D-7: la clave ya existe entre las filas vivas (el cuerpo trae el `id` de la existente).
  duplicado: HttpStatus.CONFLICT,
  // D-14: alguien cambió una fila de la operación (el cuerpo trae los `ids`).
  fila_cambiada: HttpStatus.CONFLICT,
  nada_que_deshacer: HttpStatus.CONFLICT,
  nada_que_rehacer: HttpStatus.CONFLICT,
  // D-4: la sugerencia guardada ya no describe la fila.
  revisar_de_nuevo: HttpStatus.CONFLICT,
  // D-4: la sugerencia pide un dato (`gravado` o `destino`) o la confirmación del contador.
  requiere_dato: HttpStatus.UNPROCESSABLE_ENTITY,
  requiere_confirmacion: HttpStatus.UNPROCESSABLE_ENTITY,
  // D-9: el estado esperado del periodo no es el vigente (revisar desde algo que no es `abierto`, reabrir un `abierto`).
  estado_invalido: HttpStatus.CONFLICT,
};

/** Lo único que un error de compras agrega a `{ codigo }`: la versión vigente, el dato pedido y los ids implicados. */
export interface DetalleCompras {
  versionVigente?: number;
  dato?: "gravado" | "destino";
  id?: string;
  ids?: readonly string[];
}

/**
 * Error de compras: cuerpo `{ codigo }` más, según el código, `versionVigente`, `dato`, `id` o `ids` (nunca eco de la entrada,
 * montos ni mensajes crudos) y el estado del contrato. El filtro global responde `cuerpo` tal cual.
 */
export class ComprasError extends HttpException {
  readonly codigo: CodigoCompras;
  readonly cuerpo: { codigo: CodigoCompras } & DetalleCompras;

  constructor(codigo: CodigoCompras, detalle: DetalleCompras = {}) {
    const cuerpo: { codigo: CodigoCompras } & DetalleCompras = { codigo };
    if (detalle.versionVigente !== undefined) cuerpo.versionVigente = detalle.versionVigente;
    if (detalle.dato !== undefined) cuerpo.dato = detalle.dato;
    if (detalle.id !== undefined) cuerpo.id = detalle.id;
    if (detalle.ids !== undefined) cuerpo.ids = [...detalle.ids];
    super(cuerpo, ESTADO[codigo]);
    this.name = "ComprasError";
    this.codigo = codigo;
    this.cuerpo = cuerpo;
  }
}
