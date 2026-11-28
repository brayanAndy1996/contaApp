/**
 * Puerto donde el adaptador HTTP guarda un ticket del SIRE que no terminó dentro del presupuesto, para retomarlo en el
 * siguiente intento sin exportar de nuevo (plan 041, P-4 c). El valor es SOLO el número de ticket. El worker lo implementa
 * sobre Redis; `AlmacenTicketsMemoria` es para pruebas.
 */
export interface AlmacenTicketsSire {
  leer(clave: string): Promise<string | null>;
  guardar(clave: string, numTicket: string, ttlMs: number): Promise<void>;
  borrar(clave: string): Promise<void>;
}

/** Almacén en memoria con TTL según el reloj inyectado (solo pruebas). */
export class AlmacenTicketsMemoria implements AlmacenTicketsSire {
  private readonly datos = new Map<string, { numTicket: string; venceEn: number }>();

  constructor(private readonly ahora: () => Date = () => new Date()) {}

  leer(clave: string): Promise<string | null> {
    const d = this.datos.get(clave);
    if (d === undefined) return Promise.resolve(null);
    if (this.ahora().getTime() >= d.venceEn) {
      this.datos.delete(clave);
      return Promise.resolve(null);
    }
    return Promise.resolve(d.numTicket);
  }

  guardar(clave: string, numTicket: string, ttlMs: number): Promise<void> {
    this.datos.set(clave, { numTicket, venceEn: this.ahora().getTime() + ttlMs });
    return Promise.resolve();
  }

  borrar(clave: string): Promise<void> {
    this.datos.delete(clave);
    return Promise.resolve();
  }
}
