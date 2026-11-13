// Catálogo de reglas del motor (021, RF-089) y RUC aportable (P-10). Stub de T1 (rojo): la implementación es de T7.
import type { CodigoReglaMotor, DocProveedor } from "./tipos";

export interface ReglaMotorCatalogo {
  readonly codigo: CodigoReglaMotor;
  readonly descripcion: string;
}

export const CATALOGO_REGLAS_MOTOR: readonly ReglaMotorCatalogo[] = [];

export function esRucAportable(doc: DocProveedor): boolean {
  void doc;
  throw new Error("no implementado");
}
