import type { INestApplication } from "@nestjs/common";

// STUB de T7 (004): solo fija la firma de `crearApp` (plan.md, Contratos: Backend) para que las
// pruebas de integración compilen y fallen (rojo) por falta de implementación. T12 lo reemplaza
// con la app real (módulo auth, guards, filtro de errores) e importa los tipos `Correo` y `Hasher`
// de `infra/correo/correo` y `modules/auth/contrasena/hasher` (T10).
export interface MensajeCorreoApp {
  para: string;
  asunto: string;
  texto: string;
}
export interface CorreoApp {
  enviar(m: MensajeCorreoApp): Promise<void>;
}
export interface HasherApp {
  calcular(plano: string): Promise<string>;
  verificar(phc: string, plano: string): Promise<boolean>;
  necesitaRehash(phc: string): boolean;
  readonly hashFicticio: string;
}
export interface OpcionesApp {
  correo?: CorreoApp;
  hasher?: HasherApp;
  env?: Record<string, string | undefined>;
}

export async function crearApp(o?: OpcionesApp): Promise<INestApplication> {
  void o;
  throw new Error("crearApp no implementado (T12 de la spec 004)");
}
