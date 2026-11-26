# Cierre 020 · Deuda técnica de R1

Spec `020-deuda-r1` · nivel C · estado `hecha`. Texto de su fila de `ESTADO.md` movido sin cambios (042 B1/B6); el tablero conserva una nota corta.

## Fila de ESTADO.md

| Spec | Nivel | Estado | Tarea actual | Bloqueo / nota |
|---|---|---|---|---|
| 020-deuda-r1 | C | hecha | — | Mergeada en `main` (52c8514). Decisiones P-1 a P-7 del usuario. Pruebas de tiempo con mediana y sin comparar bajo cobertura, límites intactos, prueba de inyección de 20 ms para auth CA-8 (T1–T2); `restaurarConfig` completo; migración 0046 valida el CHECK de milisegundos de `notificacion` (T3); credenciales con «Verificando…» y motivos legibles (T4); «Cancelar» solo a quien puede y re-listado si el stream tarda (T5); panel «Generar archivo» en columna desde 1400 px (T6); horas en Lima, SHA-256 completo, `_vN` en versiones anteriores y textos de error de archivo (T7); E2E 87/87 (T8). CA-1 a CA-11 verificados (T9); CI verde en 3 corridas seguidas (dispatch 491 y 493, E2E incluido). Desvíos ratificados en `plan.md` (T10). |

## Notas para specs futuras

Texto completo, movido de `ESTADO.md` (el tablero conserva una versión corta de las abiertas; las tachadas ya están resueltas).

- [pruebas] La BD local `contapp` tiene residuo de corridas viejas (226 estudios `Estudio t005/T5 …` sin suscripción; clientes `HU40 …` y `Cliente de prueba …` en los estudios semilla A y B) que rompe ~17 pruebas de aislamiento en local. Recrearla (migrar y sembrar); el CI parte de BD vacía (020 T9).
- [pruebas] Correr varias suites completas a la vez contra una sola BD las contamina (`config_sistema`, KEK de `kek.rotar`, trabajos `en_cola`): el CI corre en serie; para pruebas de carga usar BD propias (020 T9). Con aislamiento en paralelo, `packages/queue` `recuperacion.int.spec.ts` y `revalidacion.int.spec.ts` fallaron 3/20 con 42501 (hipótesis: `alter role contapp_app` de adversariales, global al clúster); en serie 85/85.
- ~~[rendimiento] CA-13 (`generar-archivo.int.spec.ts`, 20.000 filas): mediana de compras 3,4 s frente a 5 s sin carga, el margen más corto de las pruebas de tiempo. Si falla en CI es defecto de rendimiento: no subir el límite (020 T9).~~ (cerrada por 022)
- [frontend] «Verificando…» de credenciales es estado local (020 T4): si una credencial «Inválida» se re-verifica y vuelve a fallar, la ficha sondea hasta el tope de 120 s.
- [oficial] Nombre de descarga `_vN` en versiones anteriores del archivo (020 P-6): revisarlo cuando llegue el formato oficial de SUNAT.
