# Spec 032 · Enviar a SUNAT y seguir el ticket

Estado: **aprobada** (2026-11-24), **bloqueada** por P-1 (formato oficial de importación). P-1 a P-10 resueltas por el usuario: todas con la recomendación (al final). Plan: `plan.md` · tareas: `tasks.md`.
Nivel de riesgo: **A**. Por 04 §2.1: (1) sí: reemplaza el registro real del contribuyente ante SUNAT; un archivo equivocado es una declaración equivocada; (2) sí: usa credenciales del cliente y un envío cruzado entre estudios o clientes escribiría en el RUC de otro; (3) sí: el contador no ve qué llegó a SUNAT sin entrar al portal; (4) sí: estados de ticket, reintentos, cortes de red a mitad de la subida y doble clic. **No existe entorno de pruebas de SUNAT: toda escritura afecta datos reales.**
Cubre: RF-104 · HU-27. Base: 041 (token, ticket, descarga), 012b (archivo generado), 017 (auditoría y notificaciones).

## Objetivo
Que el contador envíe desde ContApp el archivo de reemplazo ya generado y vea el ticket avanzar solo hasta «Procesado» o «Procesado con errores», con los errores de SUNAT, sin entrar al portal; y que sea muy difícil enviar algo por error.

## Alcance
- **Reemplazar propuesta** (compras 5.3, ventas 5.3): subida TUS del ZIP de la versión vigente de `archivo_generado` a `…/rvierce/receptorpropuesta/web/propuesta/upload` con metadatos en base64 (`filename`, `filetype=application/zip`, `numRuc`, `perTributario`, `codOrigenEnvio`, `codProceso`, `codTipoCorrelativo=01`, `nomArchivoImportacion`, `codLibro`) → `numTicket`.
- **Seguimiento del ticket** (`sire.ticket.consultar`, 5.31/5.16): re-encolado diferido hasta estado final; con errores (03), descarga y muestra del reporte (P-8).
- **Aceptar propuesta** y **registrar preliminar** como acciones separadas (P-7).
- Puerto nuevo `SireEscritura` (separado de `SireApiClient`) con mock y adaptador http; interruptor de apagado (P-6).
- Permiso `sire.enviar` (P-5), doble confirmación verificada en el servidor, auditoría (017) y notificación al terminar.
- Pantalla: «Enviar a SUNAT» en la pantalla del archivo de 012b, modal de confirmación, estado del envío con ticket, historial de envíos del periodo y errores.

## Fuera de alcance
- Formato oficial de **importación** (RS 112-2021/SUNAT, anexos y tabla 6 de nombres): prerrequisito (P-1); hoy `packages/domain/src/formatos/` solo tiene los provisionales `oficial: false`. El layout de **exportación** que lee 041 es otro.
- No domiciliados (5.5), ajustes posteriores, complementar, importar nuevos CP, incluir/excluir, eliminar preliminar, generar el registro final (se hace en el portal), envío masivo o programado.

## Reglas
- **R-1 · Qué se envía**: solo la versión **vigente** (la última) de `archivo_generado` del (cliente, periodo, libro), con `provisional = false` y formato `oficial: true`, periodo en estado `generado`, y cuyo `sha256_zip` coincide con el que el usuario confirmó. El worker vuelve a leer los bytes del almacenamiento y recalcula el SHA-256 antes de subir.
- **R-2 · Uno a la vez**: como máximo un envío no final por (cliente, periodo, libro); la misma versión no se reenvía salvo «Reenviar» explícito tras un estado final con errores o `rechazado`.
- **R-3 · Como máximo una vez**: la subida no se reintenta sola una vez que salió la primera petición TUS. Corte, timeout o 5xx después de ese punto → estado `incierto` (P-9). Antes de ese punto (token, lectura del archivo) sí aplican los reintentos de 008.
- **R-4 · Interruptor**: con la escritura apagada (P-6) no aparece el botón, el backend responde 409 `escritura_apagada` y el worker no construye el adaptador; el worker vuelve a mirar justo antes de subir.
- **R-5 · Doble confirmación**: (1) `preparar` devuelve el resumen (RUC, razón social, periodo, libro, versión, nombre del archivo, filas, cambios e impacto en IGV de 012b, SHA-256 abreviado) y un `confirmacionId` de un solo uso, ligado a usuario, versión y SHA-256, válido 5 min; (2) `confirmar` exige ese id, el SHA-256 y el periodo `AAAAMM` escrito por el usuario. Doble clic o id reusado → 409.
- **R-6 · Seguimiento**: consultas a los 5 s, 15 s, 30 s, 60 s y luego cada 5 min hasta 24 h; 01/02/05 = en proceso, 03 = procesado con errores, 04/06 = procesado sin errores; otro código → `estado_desconocido` y alerta. A las 24 h → `sin_respuesta` con «Consultar de nuevo».
- **R-7 · Mientras hay un envío no final** no se puede reabrir el periodo ni generar otra versión (409) (P-10).
- **R-8 · Errores de SUNAT**: 422 al subir → `rechazado` con la lista `cod` + mensaje (texto sanitizado, ≤ 500 caracteres cada uno, máx. 200); nunca se guardan cabeceras, token ni cuerpo crudo.

## Criterios de aceptación
- [ ] CA-1: Con `sire.enviar`, cliente visible, interruptor encendido y una versión que cumple R-1, `preparar` → `confirmar` encola `sire.reemplazo.enviar` y responde 202 con `envioId`; el estado pasa `pendiente → subiendo → en_proceso` y se ve el `numTicket`.
- [ ] CA-2: Versión provisional, no vigente, periodo no `generado`, SHA-256 distinto, periodo escrito distinto, `confirmacionId` vencido, ajeno o reusado → 409/422 con código, sin encolar. Sin permiso → 403; cliente de otro estudio o no visible → 404.
- [ ] CA-3: Interruptor apagado (cualquiera de los dos de P-6) → sin botón, 409 `escritura_apagada` y, si se apagó después de encolar, el trabajo termina `cancelado` sin llamar a SUNAT.
- [ ] CA-4: TUS contra el servidor falso: `POST` de creación con `Tus-Resumable: 1.0.0`, `Upload-Length` y `Upload-Metadata` con los 9 metadatos en base64 y los valores de P-2; `PATCH` con `Upload-Offset: 0`; el ticket se toma de la respuesta. El cuerpo enviado es byte a byte el ZIP guardado.
- [ ] CA-5: Corte de red o timeout después del `POST` de creación → `incierto`, sin reintento automático; «Verificar en SUNAT» consulta los tickets del periodo y empareja por `nomArchivoImportacion` → `en_proceso` con ticket, o sigue `incierto` y permite «Reenviar» con nueva confirmación.
- [ ] CA-6: Seguimiento: el ticket avanza 01 → 02 → 04 en el servidor falso y la pantalla lo muestra por SSE sin recargar; 03 → «Procesado con errores» con la lista de errores de P-8; 06 → «Procesado»; código desconocido → `estado_desconocido`.
- [ ] CA-7: 422 de SUNAT (p. ej. 1024 «previamente enviado», 1044 nombre) → `rechazado` con `cod` y mensaje; 401 → renovación única del token (008); 403 → credencial inválida.
- [ ] CA-8: Dos `confirmar` simultáneos del mismo (cliente, periodo, libro) → un solo envío; el otro 409. Reabrir o generar mientras hay envío no final → 409 (R-7).
- [ ] CA-9: Aceptar propuesta solo con 0 cambios en el resumen de 012b; registrar preliminar solo tras un ticket sin errores del mismo periodo y libro; ambos con su doble confirmación. Respuesta «debe completar no domiciliados» → `requiere_no_domiciliados` con aviso.
- [ ] CA-10: Auditoría (017) de preparar, confirmar, ticket recibido, estado final, incierto, verificación, aceptar, registrar preliminar y cambio de interruptor; notificación al creador al llegar a un estado final.
- [ ] CA-11: Secretos: canarios en clave SOL, `client_secret` y token no aparecen en logs, errores, `resultado`, eventos, auditoría ni en la tabla de envíos.
- [ ] CA-12: Aislamiento: un usuario de A no ve, prepara, confirma, verifica ni descarga envíos de B (RLS y 404); `envio_sire` con RLS `ENABLE + FORCE`.
- [ ] CA-13: Mock por defecto: `SIRE_ESCRITURA` ausente = `off`; `mock` para desarrollo y E2E; con `NODE_ENV=production` el valor `mock` no arranca.
- [ ] CA-14: E2E con mock: generar (012b) → enviar → ver ticket «Procesado con errores» con 2 errores → reenviar tras regenerar → «Procesado».
- [ ] Casos reales aplicables: ninguno nuevo (032 envía los bytes que generó 012b, donde ya se prueban; CA-4 comprueba que son idénticos).

## Dependencias
- Specs: **041** (hecha), **formatos oficiales de importación** (P-1), 012b, 017, 008.
- Externas: anexos de la RS 112-2021/SUNAT (estructura y tabla 6); un RUC y periodo piloto del usuario (P-4).

## Preguntas abiertas (recomendación entre corchetes)

**Decisión del usuario (2026-11-24): se aprueban P-1 a P-10 con la recomendación indicada. Por P-1, 032 queda bloqueada hasta que exista la spec del formato oficial de importación (anexo RS 112-2021/SUNAT).**
- **P-1 · Formato oficial de importación**: no está en el repo y es distinto al de exportación (041). ¿Quién entrega el anexo y dónde se implementa? [Spec aparte de nivel A «formatos oficiales RCE/RVIE de importación» antes de 032, con el anexo que entregue el equipo; 032 queda bloqueada mientras el formato vigente sea `oficial: false`. Nombre según los ejemplos del manual: `LE{RUC}{AAAAMM}00{libro}02{OIM}2.zip`, a confirmar con la tabla 6: el ejemplo de compras del manual trae un nombre y `codLibro` de ventas.]
- **P-2 · Metadatos contradictorios del manual**: compras dice `codProceso` 61 pero el ejemplo usa 87; ventas usa 3; `codOrigenEnvio` dice 2 pero los ejemplos usan 1; el ejemplo de compras trae `codLibro` 140000. [Usar lo de las tablas: compras 61, ventas 3, `codOrigenEnvio` 2, `codLibro` 080000/140000; confirmarlo en el piloto; ante 422 1026/1139 detener, nunca probar otros valores solo.]
- **P-3 · Cliente TUS**: el manual pide Java (`tus-java-client` 0.5.0). Opciones: (a) `tus-js-client` en Node; (b) cliente TUS 1.0 mínimo propio sobre `fetch` (creación + un `PATCH` + `HEAD`); (c) servicio Java aparte. [(b): el ZIP es chico, no suma dependencia ni JVM y se prueba contra un servidor TUS falso con las mismas cabeceras que el cliente Java.]
- **P-4 · Primer envío real**: no hay entorno de pruebas. [Piloto supervisado: interruptor encendido solo para el estudio del usuario, su propio RUC y un periodo cuyo reemplazo sea el que de todos modos quiere presentar; tarea manual con el usuario presente; recién después se habilita a otros estudios.]
- **P-5 · Permiso**: nuevo `sire.enviar` o reutilizar `sire.aprobar_generar`. [Nuevo `sire.enviar`, por defecto solo en el rol titular; asignable a otros roles.]
- **P-6 · Interruptor**: [Doble: `SIRE_ESCRITURA=off|mock|http` en el worker (por defecto `off`) y bandera por estudio en BD que solo cambia el super-admin (por defecto apagada). Ambos deben estar encendidos.]
- **P-7 · Aceptar propuesta y registrar preliminar**: ¿entran en 032? [Sí, como acciones separadas con su propia confirmación (CA-9); el registro final sigue en el portal.]
- **P-8 · Errores del ticket 03**: el manual no describe el formato del reporte. [Descargarlo con 041 (mismos límites), guardarlo como adjunto descargable y mostrar hasta 200 errores si se puede leer por encabezado; confirmar el formato en el piloto.]
- **P-9 · Envío incierto**: [Nunca reintentar solo (R-3); «Verificar en SUNAT» empareja por `nomArchivoImportacion`; si no aparece, el contador decide reenviar con nueva confirmación.]
- **P-10 · Periodo tras enviar**: [Con ticket sin errores el periodo queda `enviado`; reabrirlo pide confirmación y avisa que SUNAT ya tiene esa versión. Cambia los estados de 012b: se ajusta en este plan.]
