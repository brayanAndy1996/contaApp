// STUB (spec 028, T5 rojo): lo reemplaza T11. Procesador de `notificacion.enviar` (R-1, R-3, R-9, R-12; CA-3 a CA-6, CA-9 a CA-11):
// contrato en `apps/worker/test/correo.ts`.
import type { Correo } from "@contapp/correo";
import type { ContappDb } from "@contapp/db";
import type { Reloj } from "@contapp/queue";
import type { Procesador } from "../ejecutor.js";
import type { LoggerTrabajos } from "../registro.js";

export interface DepsEnviarCorreo {
  db: Pick<ContappDb, "withTenant">;
  correo: Correo;
  /** `APP_ORIGIN`: origen de los enlaces (`/ir`, `/baja`) y de la URL de `List-Unsubscribe`. */
  appOrigin: string;
  logger?: LoggerTrabajos;
  reloj?: Reloj;
  /** Intentos de transporte antes de dejar el envío `fallido` (3). */
  intentosMax?: number;
}

export type ResultadoEnvioCorreo =
  | { estado: "enviado"; avisos: number }
  | { estado: "enviado"; clientes: number }
  | { estado: "omitido"; motivo: string }
  | { estado: "fallido"; motivo: "transporte" };

export function enviarCorreo(d: DepsEnviarCorreo): Procesador {
  void d;
  throw new Error("no implementado: enviarCorreo");
}
