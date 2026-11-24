# Spec 042 · Acelerar el desarrollo: CI más rápido y método más liviano en tokens

Estado: borrador (pedida por el usuario 2026-11-24; preguntas P-1 a P-6 abiertas).
Nivel de riesgo: D — no toca código de producción ni datos. Riesgo indirecto: que una prueba deje de correr sin que nadie lo note. Se cubre con CA-2 (mismas pruebas y mismos umbrales) y CA-3.
Cubre: `docs/04-metodologia.md` §2.3 y §7, `.github/workflows/ci.yml`, configuraciones de cobertura de `apps/backend` y `apps/worker`, `docs/specs/ESTADO.md` y `docs/specs/_plantilla/`.

## Objetivo
El desarrollo se volvió lento y caro. El CI tarda unas 2 horas por corrida, también en commits de solo documentación. Los documentos que los agentes leen en cada spec crecieron muy por encima de los topes del propio método. Esta spec reduce el tiempo de espera y los tokens **sin quitar pruebas ni bajar umbrales**.

## Diagnóstico (medido el 2026-11-24)
- **CI**: la corrida 45445781487 (un commit de docs) tardó 2 h. 97 min se fueron en 14 pasos «Cobertura de NNN» que **vuelven a correr las mismas suites con base de datos**, en serie, para medir distintos archivos. Hay 10 configuraciones de cobertura en el backend y 9 en el worker, y cada spec nueva agrega otra.
- **Disparos innecesarios**: el CI corre completo en todo push, incluidos los commits de docs y los «en rojo» del TDD (028 acumula más de 25 corridas en un día). No se cancelan las corridas viejas de la misma rama.
- **Documentos**: `ESTADO.md` tiene 14.900 palabras (filas de más de 2.000 caracteres). Las specs 021 y 025 tienen `spec.md` de unas 2.500 palabras, `plan.md` de 2.400 y `tasks.md` de 9.000 y 13.900, frente al tope de «~1 página» del método (§7 regla 3).
- **Proceso**: dos rondas adversariales fijas en nivel A, todas con Opus; en algunas specs, «3 corridas de CI seguidas en verde» (unas 6 h de espera).

## Alcance

**Parte A · CI**
- A1. **Una corrida de cobertura por app**: una configuración para el backend y otra para el worker que unen todos los `include` actuales y fijan los mismos umbrales del 90 % por archivo con umbrales por glob. Reemplazan las 19 configuraciones por spec. Las de `packages/*` se mantienen.
- A2. **Jobs en paralelo**, cada uno con su propio PostgreSQL y Redis: aislamiento (`ci:db`), cobertura del backend, cobertura del worker y cobertura de `packages/db` y `crypto`, y pruebas de cierre de 008.
- A3. **No correr en commits de solo documentación** (`paths-ignore`: `docs/**`, `**/*.md`), salvo `workflow_dispatch`.
- A4. **Cancelar la corrida anterior** de la misma rama (`concurrency` con `cancel-in-progress`), excepto en `main`.
- A5. **Dos niveles** (P-2): en las ramas `spec/*`, lint, tipos, build y pruebas unitarias (unos 10 min); la suite completa, en pull requests, en push a `main` y a mano.
- A6. **Regla para specs futuras**: una spec nueva no agrega un paso de CI; agrega sus globs a la configuración única de su app.

**Parte B · Tokens y método**
- B1. **`ESTADO.md` liviano**: una línea por spec (spec, nivel, estado, tarea actual y nota de hasta 200 caracteres). El detalle de cada spec cerrada pasa a `docs/specs/NNN-*/cierre.md`. Los hallazgos cerrados pasan a `docs/specs/HALLAZGOS.md`; en `ESTADO.md` quedan solo los abiertos.
- B2. **Topes de tamaño**: `spec.md` y `plan.md` de hasta unas 900 palabras cada uno. En `tasks.md`, cada tarea con «Contexto, Hacer, Hecho cuando» en 6 líneas o menos. Los resultados y evidencias van a `docs/specs/NNN-*/resultados.md`, que los agentes no leen al trabajar. Se actualiza `_plantilla/`.
- B3. **Adversarial según riesgo** (P-3): 1 ronda por defecto; la segunda solo si la primera deja hallazgos de severidad media o alta. Opus solo en aislamiento, cifrado, autenticación, dinero y archivo SUNAT; Sonnet en el resto.
- B4. **Una corrida en verde** basta para cerrar una spec (P-4). La repetición queda solo para pruebas de tiempo con antecedentes de fallos intermitentes.
- B5. **Salida compacta de pruebas**: reporter `dot` y solo los fallos, en local y en el CI. Los agentes leen el resumen de fallos, no el registro completo.
- B6. **Migrar lo existente** (P-5): reescribir `ESTADO.md` con B1, moviendo su detalle actual a los `cierre.md`, sin perder información.

## Fuera de alcance
- Quitar pruebas o bajar umbrales de cobertura (D1).
- Cambiar código de producción.
- Reescribir specs ya cerradas (solo se mueve su texto en B6).

## Decisiones
- D1 **Las mismas pruebas y los mismos umbrales**: la optimización es de orquestación. Si al unir configuraciones un archivo queda por debajo del 90 %, se informa y se decide; no se baja el umbral en silencio.
- D2 **El aislamiento entre estudios (RLS) corre siempre** en la suite completa, sin excepciones.

## Criterios de aceptación
- [ ] CA-1: Una corrida completa del CI en `main` tarda **45 min o menos** (hoy unas 2 h), medida en dos corridas.
- [ ] CA-2: La suite completa ejecuta el mismo conjunto de archivos de prueba que antes, con el mismo resultado, y los umbrales por archivo son los mismos. Se comprueba comparando la lista de archivos de prueba y la tabla de cobertura antes y después.
- [ ] CA-3: Un push de solo documentación no dispara el CI. Un segundo push a la misma rama `spec/*` cancela la corrida anterior. En `main` nada se cancela.
- [ ] CA-4: En una rama `spec/*` el CI responde en **15 min o menos** (si P-2 = sí).
- [ ] CA-5: `ESTADO.md` queda por debajo de **3.000 palabras**, y toda la información anterior está en `cierre.md` o en `HALLAZGOS.md`.
- [ ] CA-6: `04-metodologia.md` y `_plantilla/` reflejan B2 a B5, y `prompt-orquestador.md` lo menciona.

## Dependencias
- Coordinación con la conversación que desarrolla las specs: la Parte A modifica `ci.yml` y las configuraciones de cobertura, que cada spec en curso también modifica. Se aplica **justo después de fusionar la spec en curso (028)**, y las siguientes adoptan A6.

## Preguntas abiertas (para el usuario)
- P-1 ¿Se aprueba la Parte A completa? *Recomendado: sí.*
- P-2 ¿CI de dos niveles (rápido en `spec/*`, completo en PR y `main`)? *Recomendado: sí.* Riesgo: una rama puede llegar al merge con una prueba de integración rota, aunque el CI completo la detecta antes de fusionar si se trabaja con PR.
- P-3 ¿Adversarial de 1 ronda por defecto y Opus solo en las áreas críticas? *Recomendado: sí.*
- P-4 ¿Basta 1 corrida en verde para cerrar una spec? *Recomendado: sí.*
- P-5 ¿Se migra ahora el `ESTADO.md` actual (B6), o solo se aplica el formato nuevo de aquí en adelante? *Recomendado: migrar ahora.*
- P-6 ¿Se pasa a trabajar con pull requests (`spec/*` → `main`) para que el CI completo corra antes de fusionar? *Recomendado: sí, si se aprueba P-2.*
