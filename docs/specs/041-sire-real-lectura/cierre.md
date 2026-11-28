# Cierre · 041 SIRE real de solo lectura

Estado: **verificada** (2026-11-28). Nivel A. Rama `claude/bold-gauss-nzljd6` sin mergear, sin PR, sin migraciones. CA → evidencia: `resultados.md` (T17).

## Qué entregó
- SIRE real de solo lectura con `SIRE_CLIENT=http`; `SIRE_CLIENT=mock` sigue por defecto.
- `HttpSireAuth` y `HttpSireApiClient`: propuesta de compras (RCE 5.34), ventas (RVIE 5.18) y registro presentado (5.51).
- Lector seguro de ZIP y TXT (`zip-seguro`, `txt/*`): columnas por nombre de encabezado y topes de CA-10.
- Tickets reanudables en Redis (`AlmacenTicketsRedis`), con clave por estudio, cliente, libro y periodo.
- Servidor SUNAT falso (`src/http/pruebas/`) y prueba de contrato manual `sire.contrato.spec.ts`, apagada sin `SIRE_CONTRATO=1`.

## Decisiones del usuario
- P-1 a P-8 aprobadas el 2026-11-24 con la recomendación; P-3, P-5 y P-6 cerradas el 2026-11-28 con la corrida real.
- CA-10: 64 MiB descomprimidos por parte y 256 MiB acumulados entre partes (2026-11-27).

## Evidencia real (2 RUC, 2026-11-28/29; solo formas)
- 5.51 es el servicio correcto. `codProceso` 70 fijo (00, 01 y 02 dan 1026); `codMoneda` obligatorio (1061 si falta) pero no filtra: una sola solicitud 70 + PEN.
- ZIP real de 3 entradas (`.txt` en carpeta, entrada vacía y carpeta), prefijo `PK\x07\x08`, sin descriptor: legible. Propuestas de 80 y 40 columnas; token de 3600 s.
- P-5: notas de crédito negativas, USD con tipo de cambio y boletas sin documento verificados. **Notas de débito sin verificar.** P-6: 0 errores de codificación.

## Rondas adversariales (todas corregidas)
- Ronda 1: 3 hallazgos (`c49186c`). Ronda 2: 8 (`3427d67`, `6995bdd`). Ronda 3 del ZIP: 8 (`61b820af`).
- Revisión final del arquitecto: 3 (H-1 media; H-2 y H-3 bajas; `5a10c23`).

## Cobertura y CI
- `src/http/` 96,31 % sentencias y 93,95 % ramas; `src/http/txt/` 97,91 % y 94,17 %; agregado `src/http/**` 96,64 % y 94,00 %.
- `test:cobertura` de `packages/sunat` (paso `cobertura:sunat` del job `ci`) mide `src/http/` con 90 % agregado en sentencias y ramas (`995237a6`). Sin paso de CI nuevo.

## Desvíos y avisos
- Rama `claude/bold-gauss-nzljd6` en vez de `spec/041-sire-real-lectura` (restricción del entorno). CI de GitHub sin ejecutar y sin PR (solo si el usuario lo pide).
- Dependencias: `zod ^4.6.7` en `packages/sunat`; el lector ZIP usa `node:zlib` en lugar de `fflate` Unzip.
- Umbral de `src/http` agregado por módulo, como pide la spec: por archivo fallaría `almacen-tickets.ts` (80 % de ramas; almacén en memoria de pruebas). Decisión abierta.
- T11 y T14 omitidas: las pruebas del adversario cubren los hallazgos. Pruebas de corrección de backend (`correcciones-r1.spec.ts`, `zip-seguro-r3.spec.ts`) revisadas por el tester.

## Notas futuras
- [real] Notas de débito sin verificar con datos reales (P-5).
- [real] SIRE 5.51: `codProceso` 70 y `codMoneda` obligatorio sin efecto de filtro.
- [041] El tope de 24 h de `expires_in` no está en la spec: debe fijarlo la del token (008).
- [041] 256 MiB acumulados de TXT son objetos fila que ocupan varias veces ese tamaño: vigilar el heap del worker.
- [pruebas] `obtener-xml-027.int.spec.ts` (worker) inestable bajo carga: ajena a 041, pasa aparte; comparar con la base en la CI.
