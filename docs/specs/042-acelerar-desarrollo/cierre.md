# Cierre 042 · Acelerar el desarrollo

- **Merge**: `main` b3255e5 (PR brayanAndy1996/contaApp#2), 2026-11-25. Nivel D. Decisiones del usuario 2026-11-24: P-1 a P-6 (todas las recomendaciones).
- **CI**: una `vitest.cobertura.config.mts` por app (backend y worker) en lugar de 21 por spec, mismos 377/228 archivos de prueba y umbrales del 90 % por archivo (T4, `linea-base/`); jobs paralelos con su PostgreSQL y Redis (aislamiento, cobertura backend, worker y paquetes, cierre, E2E); `paths-ignore` de docs; `concurrency` que cancela salvo en `main`; en push a `spec/**` solo lint, tipos, build y unitarias (sin `@contapp/db`, en serie).
- **Medidas**: completa 2 h 46 min → 27–31 min (PR y dos corridas en `main`); nivel 1 en `spec/*` 6–7 min.
- **Método**: 1 ronda adversarial por defecto, Opus solo en áreas críticas, una corrida en verde, topes de tamaño, `resultados.md`, reporter `dot`, regla A6 (una spec agrega globs a la config única, no pasos de CI). Detalle en `resultados.md`.
- **ESTADO**: 15.128 → 2.555 palabras; detalle por spec en `docs/specs/NNN-*/cierre.md` y hallazgos cerrados en `docs/specs/HALLAZGOS.md` (comprobado con script).
- **Notas**: `puntaje.rendimiento.spec.ts` pasó a tiempo de CPU (fallaba por reloj de pared al entrar las unitarias al CI). Para cerrar una spec: PR `spec/*` → `main` (la suite completa corre en el PR). Un PR sin cambios fuera de docs no dispara el CI. Los `cobertura:<spec>` de `packages/*` (domain, sunat, db…) siguen por spec en el job de paquetes; unirlos queda para otra spec si hace falta.
