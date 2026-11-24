# Plan 032 · Enviar a SUNAT y seguir el ticket

Supone P-1 a P-10 con la recomendación de la spec; si el usuario elige otra opción, el arquitecto ajusta este plan antes de T1. Migraciones desde la **siguiente libre al implementar** (hoy 0069; 027/028 corren en paralelo: confirmar con `ls packages/db/migrations` y el diario).

## Archivos
| Acción | Ruta | Para qué |
|---|---|---|
| modificar | `packages/sunat/src/puertos.ts` | Puerto `SireEscritura` (abajo) |
| crear | `packages/sunat/src/mock/sire-escritura.mock.ts` | Mock con guion de estados y errores, centinelas por RUC como 009 |
| crear | `packages/sunat/src/http/{tus,sire-escritura.http}.ts` | Cliente TUS 1.0 mínimo (P-3) y adaptador; reutiliza `transporte`, `ticket` y `zip-seguro` de 041 |
| crear | `packages/sunat/src/http/pruebas/servidor-tus-falso.ts` | Servidor TUS falso (creación, `PATCH`, `HEAD`, cortes programados) |
| crear | `packages/db/migrations/NNNN_envio_sire.sql` · `src/schema/envios.ts` · `src/envios/*` | `envio_sire`, `envio_sire_error`, `envio_confirmacion`, bandera por estudio, estado de periodo `enviado`, funciones acotadas |
| modificar | `packages/shared/src/{acceso/permisos,acceso/roles,auditoria/acciones}.ts` · crear `envios/{esquemas,vistas}.ts` | `sire.enviar`, acciones de auditoría, DTO |
| modificar | `packages/queue/src/catalogo.ts` | `sire.reemplazo.enviar` (sin reintento tras subir), `sire.ticket.consultar` (diferido), `sire.propuesta.aceptar`, `sire.preliminar.registrar` |
| crear | `apps/worker/src/trabajos/procesadores/{enviar-reemplazo,consultar-ticket,aceptar-propuesta,registrar-preliminar}.ts` | Procesadores |
| modificar | `apps/worker/src/adaptadores/adaptadores.module.ts` | `SIRE_ESCRITURA=off\|mock\|http` (por defecto `off`; `mock` prohibido en producción) |
| crear | `apps/backend/src/modules/envios/*` | Endpoints (abajo), guardas, auditoría |
| modificar | `apps/backend/src/modules/archivos/*`, `modules/{compras,ventas}` (reabrir) | 409 con envío no final (R-7); estado `enviado` |
| crear | `apps/frontend/components/envios/{boton-enviar,confirmar-envio,estado-envio,errores-envio}.tsx` · `lib/envios.ts` | Pantalla dentro de la del archivo de 012b |
| modificar | `apps/backend/src/modules/plataforma/*` | Bandera de escritura por estudio (super-admin) |
| crear | `tests/e2e/envio-sire.spec.ts` | CA-14 |

## Contratos
```ts
// @contapp/sunat — separado de SireApiClient para que la lectura nunca escriba
export interface SolicitudReemplazo { ruc: string; periodo: string; libro: LibroSire; nombreArchivo: string; zip: Uint8Array }
export interface TicketSire { numTicket: string }
export type EstadoTicketSire =
  | { estado: "en_proceso"; codigo: "01" | "02" | "05" }
  | { estado: "con_errores"; reportes: ArchivoReporteSire[] }
  | { estado: "sin_errores" }
  | { estado: "desconocido" };
export interface SireEscritura {
  reemplazarPropuesta(token: TokenSire, s: SolicitudReemplazo): Promise<TicketSire>;   // ErrorEnvioIncierto si se cortó tras crear la subida
  aceptarPropuesta(token: TokenSire, s: { ruc: string; periodo: string; libro: LibroSire }): Promise<TicketSire>;
  registrarPreliminar(token: TokenSire, s: { ruc: string; periodo: string; libro: LibroSire }): Promise<TicketSire | { requiereNoDomiciliados: true }>;
  consultarTicket(token: TokenSire, s: { periodo: string; numTicket: string }): Promise<EstadoTicketSire>;
  buscarTicketPorArchivo(token: TokenSire, s: { periodo: string; nomArchivoImportacion: string }): Promise<TicketSire | null>;
  descargarReporte(token: TokenSire, s: { periodo: string; numTicket: string; reporte: ArchivoReporteSire }): Promise<Uint8Array>;
}
export class ErrorEnvioIncierto extends ErrorTransitorio {}   // el ejecutor NO lo reintenta (decidirTrasError lo trata como final)
```
HTTP (bajo `/clientes/:clienteId/periodos/:periodo/{compras|ventas}`; `ClienteScopeGuard`, `no-store`):
| Método y ruta | Permiso | Respuesta |
|---|---|---|
| `POST …/envios/preparar` `{versionId, operacion: reemplazar\|aceptar\|preliminar}` | `sire.enviar` | 200 `{confirmacionId, expiraEn, resumen}` · 409 `escritura_apagada`/`version_no_vigente`/`formato_no_oficial`/`envio_en_curso` |
| `POST …/envios/confirmar` `{confirmacionId, sha256Zip, periodoEscrito}` | `sire.enviar` | 202 `{envioId, jobId}` · 409/422 |
| `GET …/envios` · `GET …/envios/:envioId` | `clientes.ver` | historial y estado (ticket, errores paginados ≤ 200) |
| `POST …/envios/:envioId/verificar` | `sire.enviar` | 202 (solo `incierto` o `sin_respuesta`) |
| `GET …/envios/:envioId/reporte` | `clientes.ver` | adjunto del reporte de errores |

Tabla `envio_sire`: `id`, `tenant_id`, `cliente_id`, `periodo`, `libro`, `operacion`, `archivo_id` (FK a `archivo_generado`), `sha256_zip`, `nom_archivo`, `estado` (`pendiente|subiendo|en_proceso|con_errores|sin_errores|rechazado|incierto|sin_respuesta|cancelado|requiere_no_domiciliados|estado_desconocido`), `num_ticket`, `cod_estado_sunat`, `proxima_consulta`, `creado_por`, fechas; índice único parcial «un no final por (tenant, cliente, periodo, libro)». `envio_sire_error`: `cod`, `mensaje` (≤ 500), `linea`. `envio_confirmacion`: un solo uso, 5 min. RLS `ENABLE + FORCE`; backend no escribe estados del worker; transiciones solo por funciones acotadas.

## Decisiones
- Puerto aparte y variable aparte (`SIRE_ESCRITURA`): la lectura de 041 nunca tiene camino de escritura, y apagar la escritura no apaga las descargas.
- TUS propio (P-3): `POST` creación (`Tus-Resumable: 1.0.0`, `Upload-Length`, `Upload-Metadata` = pares `clave base64` separados por coma, en el orden del manual) → `Location` validada contra el host de SUNAT → un `PATCH` (`Content-Type: application/offset+octet-stream`, `Upload-Offset: 0`); `HEAD` solo para «Verificar». El ticket sale del cuerpo o de la cabecera según el piloto (P-4).
- Como máximo una vez (R-3): el procesador marca `subiendo` en BD **antes** de la primera petición; cualquier fallo posterior es `ErrorEnvioIncierto` → `incierto`, sin reintento.
- Seguimiento diferido: `sire.ticket.consultar` con `disponible_desde = proxima_consulta` (R-6) en vez de sondear dentro del trabajo; la cola `sire` no queda ocupada.
- El worker relee el ZIP del almacenamiento (`packages/storage`) y compara SHA-256 con `archivo_generado` y con la confirmación.
- Reporte de errores: con los límites de `zip-seguro` (041); el archivo va al almacenamiento del estudio; se muestran hasta 200 errores.
- Interruptor doble (P-6): el backend lo mira en `preparar` y `confirmar`; el worker, al empezar y justo antes del `POST` TUS.

## Riesgos
- Primer envío real sin entorno de pruebas → piloto supervisado (P-4); toda la suite corre contra mock y servidores falsos.
- Formato de importación aún no oficial → 032 bloqueada por P-1; la guarda `formato_no_oficial` lo impide aunque se active el interruptor.
- Manual contradictorio (P-2) → 422 detiene y se ajusta a mano; no hay prueba automática de valores alternativos.
- Envío duplicado por doble clic o reintento → índice único parcial, `confirmacionId` de un solo uso y R-3.
