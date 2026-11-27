// STUB de 041 · T3 (rojo): T6 lo implementa (plan 041, «sire-api-client.http.ts»). Solo existe para que las pruebas compilen.
/* eslint-disable @typescript-eslint/no-unused-vars */
import type {
  PropuestaSire,
  RegistroPresentadoSire,
  SireApiClient,
  SolicitudPropuesta,
  SolicitudRegistroPresentado,
  TokenSire,
} from "../puertos.js";
import type { OpcionesHttpSire } from "./sire-auth.http.js";

export class HttpSireApiClient implements SireApiClient {
  constructor(_o?: OpcionesHttpSire) {}
  descargarPropuesta(_token: TokenSire, _solicitud: SolicitudPropuesta): Promise<PropuestaSire> {
    return Promise.reject(new Error("no implementado: HttpSireApiClient.descargarPropuesta"));
  }
  descargarRegistroPresentado(_token: TokenSire, _solicitud: SolicitudRegistroPresentado): Promise<RegistroPresentadoSire> {
    return Promise.reject(new Error("no implementado: HttpSireApiClient.descargarRegistroPresentado"));
  }
}
