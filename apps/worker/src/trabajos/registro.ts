// Logs y avisos del worker de trabajos (spec 008, CA-16, RNF-004/083). El logger recibe SOLO objetos planos con
// códigos e ids: nunca un `Error`, su `message`, su `stack` ni sus propiedades (pueden traer secretos del adaptador).
// Todo evento que menciona un trabajo lleva los tres campos `tenant_id`, `job_id` y `tipo`.

export type ValorLog = string | number | boolean | null;

export interface EventoLog {
  evento: string;
  tenant_id?: string;
  job_id?: string;
  tipo?: string;
  codigo?: string;
  [campo: string]: ValorLog | undefined;
}

export interface LoggerTrabajos {
  debug?(e: EventoLog): void;
  info(e: EventoLog): void;
  warn(e: EventoLog): void;
  error(e: EventoLog): void;
}

type Nivel = "debug" | "info" | "warn" | "error";

/** Logger por defecto: una línea JSON por evento en la consola. */
export const loggerConsola: LoggerTrabajos = {
  debug: (e) => console.debug(JSON.stringify(e)),
  info: (e) => console.info(JSON.stringify(e)),
  warn: (e) => console.warn(JSON.stringify(e)),
  error: (e) => console.error(JSON.stringify(e)),
};

/** Registra sin dejar que un logger defectuoso tumbe el flujo del trabajo. */
export function registrar(
  logger: LoggerTrabajos,
  nivel: Nivel,
  e: EventoLog,
): void {
  try {
    const f = logger[nivel];
    if (typeof f === "function") f.call(logger, e);
  } catch {
    // el logger falló: el trabajo sigue igual
  }
}

/** Campos de log de un trabajo: siempre los tres juntos (CA-16). */
export function camposTrabajo(t: {
  tenantId: string;
  id: string;
  tipo: string;
}): Pick<EventoLog, "tenant_id" | "job_id" | "tipo"> {
  return { tenant_id: t.tenantId, job_id: t.id, tipo: t.tipo };
}

/** Aviso de credencial rechazada por SUNAT (CA-9). El canal real llega en 017. */
export interface AvisoCredencialInvalida {
  tenantId: string;
  clienteId: string;
  tipo: "sol" | "sire_api";
  trabajoId: string;
}

export interface Notificador {
  credencialInvalida(aviso: AvisoCredencialInvalida): Promise<void>;
}

/** Adaptador hasta 017: log estructurado sin secretos (solo ids y el tipo de credencial). */
export class NotificadorLog implements Notificador {
  constructor(private readonly logger: LoggerTrabajos = loggerConsola) {}

  async credencialInvalida(a: AvisoCredencialInvalida): Promise<void> {
    registrar(this.logger, "warn", {
      evento: "aviso_credencial_invalida",
      cliente_id: a.clienteId,
      credencial: a.tipo,
      trabajo_id: a.trabajoId,
    });
  }
}
