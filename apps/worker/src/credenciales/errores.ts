// Errores propios del worker para credenciales (spec 003). Mensajes fijos: nunca llevan valores,
// secretos, material de llave, detalle de `pg` ni `cause` (CA-9). Los fallos criptográficos se
// propagan con las clases de @contapp/crypto (también con `codigo` y `reintentable`).

/** Validación de entradas que se ejecuta antes de tocar la BD o las llaves. */
const VALIDACIONES = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  motivo: /^[A-Za-z0-9._:-]{1,120}$/,
  kekId: /^[a-z0-9][a-z0-9-]{0,62}$/,
} as const;

export function esUuid(v: unknown): v is string {
  return typeof v === "string" && VALIDACIONES.uuid.test(v);
}

export function esMotivo(v: unknown): v is string {
  return typeof v === "string" && VALIDACIONES.motivo.test(v);
}

export function esKekId(v: unknown): v is string {
  return typeof v === "string" && VALIDACIONES.kekId.test(v);
}

export class CredencialesWorkerError extends Error {
  readonly codigo: string;
  readonly reintentable: boolean;
  constructor(codigo: string, reintentable: boolean, mensaje: string) {
    super(mensaje);
    this.name = new.target.name;
    this.codigo = codigo;
    this.reintentable = reintentable;
  }
}

/** Argumento inválido; `campo` es siempre un nombre fijo del código, nunca el valor recibido. */
export class ArgumentoInvalidoError extends CredencialesWorkerError {
  readonly campo: string;
  constructor(campo: string) {
    super("argumento_invalido", false, `Argumento inválido: ${campo}`);
    this.campo = campo;
  }
}

/** La credencial no existe en el estudio del contexto (o es de otro estudio). */
export class CredencialNoEncontradaError extends CredencialesWorkerError {
  constructor() {
    super("no_encontrada", false, "Credencial no encontrada");
  }
}

/**
 * Rotación: hubo filas que no abrieron con la llave anterior y ninguna sí lo hizo. No se puede
 * distinguir una llave anterior equivocada (o una activa defectuosa) de un estudio con todas sus filas
 * corruptas, así que se falla cerrado sin escribir nada.
 */
export class AnteriorNoAbreError extends CredencialesWorkerError {
  constructor(
    codigo = "anterior_no_abre",
    mensaje = "Ninguna DEK abrió con la llave anterior (llave equivocada o todas las filas corruptas)",
  ) {
    super(codigo, false, mensaje);
  }
}

/**
 * Rotación: la llave anterior tiene el mismo material que la activa (huella del SPKI), aunque traiga otro
 * kek_id u otra ruta. Re-envolver así no sacaría ninguna DEK de la llave que se quiere jubilar
 * (T17 · R2b-1). Es un caso de AnteriorNoAbreError: la llave de `desde` real sigue siendo necesaria.
 */
export class AnteriorIgualActivaError extends AnteriorNoAbreError {
  constructor() {
    super(
      "anterior_igual_activa",
      "La llave anterior tiene el mismo material que la activa: la rotación no jubilaría ninguna llave",
    );
  }
}

/** Fallo de la BD (lectura, auditoría o COMMIT). El error de `pg` se descarta. */
export class PersistenciaCredencialError extends CredencialesWorkerError {
  constructor() {
    super("bd", false, "Fallo de base de datos en credenciales");
  }
}
