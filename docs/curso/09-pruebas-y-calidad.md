# 09 · Pruebas y calidad: cómo se construye ContApp sin romperlo

> Módulo anterior: [08-dinero-y-dominio.md](08-dinero-y-dominio.md) · Índice: [00-indice.md](00-indice.md)

## Lo que aprenderás

- SDD: por qué nada se programa sin `spec.md` → `plan.md` → `tasks.md`.
- Los niveles de riesgo A–D y qué pruebas exige cada uno.
- TDD (rojo → verde → refactor) con un ejemplo que tú mismo puedes romper.
- Pruebas unitarias, de integración (`*.int.spec.ts` con PostgreSQL y Redis reales) y E2E.
- Pruebas adversariales (`*.adv.spec.ts`), rondas y cómo se registran los hallazgos en `ESTADO.md`.
- Cobertura ≥ 90 % por archivo con Vitest, y el CI de GitHub Actions.
- Los roles de agentes (arquitecto, backend, tester, adversario, devops).
- Dos historias reales: una prueba que "parecía flake" y era la medición, y un bug real que parecía intermitente.

---

## 1. SDD: primero el qué, luego el cómo, luego los pasos

*Spec-Driven Development* (`docs/04-metodologia.md` §1). Cada funcionalidad vive en `docs/specs/NNN-nombre/`:

| Archivo | Responde | Analogía contable |
|---|---|---|
| `spec.md` | **Qué** y **por qué**: alcance, criterios de aceptación (CA-1, CA-2…), nivel de riesgo | El contrato de servicios con el cliente |
| `plan.md` | **Cómo**: archivos, contratos (tipos, tablas, endpoints), decisiones | El programa de trabajo de auditoría |
| `tasks.md` | **Pasos**: tareas atómicas con rol, modelo, TDD/ADV y estado | Las hojas de trabajo con su responsable y check |

Estados: `borrador` → `aprobada` → `en curso` → `verificada` → `hecha`. El usuario (tú) aprueba toda spec de nivel A o B antes de implementar: es la **puerta humana**. El tablero general está en `docs/specs/ESTADO.md`.

Ejemplo real: `docs/specs/008-cola/tasks.md` tiene T1…T19: andamiaje (devops), pruebas en rojo (tester), implementación (backend, Opus en lo crítico), rondas adversariales 1a/1b/2a/2b (adversario), correcciones, verificación de CA-1 a CA-17 con evidencia, revisión final (arquitecto) y cierre.

## 2. Niveles de riesgo: cuánto probar

Cuatro preguntas (`docs/04-metodologia.md` §2.1):

1. ¿Un error produce un **monto, clasificación o archivo tributario incorrecto**?
2. ¿Puede **exponer datos o credenciales** de otro estudio, cliente o usuario?
3. ¿Sería **difícil de notar** a simple vista por el contador?
4. ¿Tiene **muchas combinaciones** de entrada o concurrencia?

| Nivel | Cuándo | Pruebas | Definición de hecho (§5) |
|---|---|---|---|
| **A · Crítico** | (1) o (2) y al menos otra | TDD + adversarial | + cobertura ≥ 90 %, rondas cerradas, revisión de Opus |
| **B · Alto** | otras combinaciones con 2+ | TDD | revisión contra la spec |
| **C · Normal** | 1 "sí" | 1 caso feliz + 1 de error por comportamiento | typecheck y lint |
| **D · Bajo** | 0 | sin pruebas dedicadas | typecheck, lint, la app levanta |

Ejemplos del tablero: 003-cifrado, 004-auth, 008-cola, 010-dominio-dinero y 011-motor-reglas son **A**; 006-planes y 007-clientes son **B**; 001-fundaciones es **D**. Es como la auditoría basada en riesgos: más pruebas sustantivas donde el error es material.

## 3. TDD: rojo → verde → refactor

1. **Rojo**: el tester escribe la prueba desde el criterio de aceptación y confirma que **falla** (no hay código aún). Si pasa sin código, la prueba no prueba nada.
2. **Verde**: el backend escribe lo mínimo para que pase.
3. **Refactor**: limpia sin cambiar comportamiento; las pruebas lo vigilan.

Un detalle importante: quien prueba **no** es quien implementa (§1.3: "el tester valida contra la spec, no contra el código"). Así la prueba no hereda los supuestos del programador. En el historial de git lo ves en pares de commits: `c824033 test(008): stream sin renovar la sesión (rojo)` seguido de `6a1bc38 feat(008): stream de trabajos sin renovar la sesión`.

Un caso del dominio, `packages/domain/src/dinero/redondeo.spec.ts:47-50`:

```ts
it("2.25 × 0.18 = 0.405 → 0.41 (no 0.40)", () => {
  expect(
    redondearSunat(pen("2.25").por(Factor.desde("0.18"))).toString(),
  ).toBe("0.41");
});
```

## 4. Tipos de prueba

| Tipo | Archivo | Qué usa | Ejemplo real | Cómo se corre |
|---|---|---|---|---|
| Unitaria | `*.spec.ts` | Solo código, dobles en memoria | `packages/domain/src/dinero/money.spec.ts` | `pnpm --filter <paquete> test` |
| Integración | `*.int.spec.ts` | PostgreSQL y Redis **reales** | `packages/queue/src/despacho.int.spec.ts` | `pnpm --filter <paquete> test:int` |
| Adversarial | `*.adv.spec.ts` / `*.adv.int.spec.ts` | Lo que haga falta para romper | `packages/crypto/src/ronda1b.adv.spec.ts` | Junto con su tipo |
| E2E | `tests/e2e/` (planificado) | Playwright sobre la app completa en `mock` | Aún no existe (`docs/03-arquitectura.md`) | — |

La separación unitaria/integración está en la configuración de Vitest de cada paquete, por ejemplo `packages/queue/vitest.config.mts`:

```ts
// `vitest run`: unitarias sin BD ni Redis (*.spec.ts). `vitest run --mode int` (script test:int):
// solo *.int.spec.ts, en un hilo, con ../../.env y luego ./.env si existen.
include: integracion ? ["src/**/*.int.spec.ts"] : ["src/**/*.spec.ts"],
fileParallelism: !integracion,
```

¿Por qué pruebas de integración con PG real y no simulado? Porque RLS, los `GRANT` por columna, los índices únicos y las carreras entre transacciones **solo existen en PostgreSQL**. Un doble en memoria nunca habría encontrado el bug de la sección 8.

**Vitest** es el ejecutor de pruebas (compatible con la API de Jest, rápido, con TypeScript nativo). `describe` agrupa, `it` define un caso, `expect(...).toBe(...)` afirma. Además el dominio usa `fast-check` para pruebas de propiedades (miles de entradas aleatorias).

## 5. Pruebas adversariales: alguien intenta romperlo

`docs/04-metodologia.md` §2.3. Solo en nivel A:

- Las escribe el rol **adversario** (Opus), nunca el que implementó.
- Primero **caja negra** (solo spec e interfaz) y luego **caja blanca** (lee el código).
- Solo escribe pruebas `*.adv.spec.ts`; no toca producción.
- Máximo **2 rondas** y unas 15 pruebas por ronda; en la práctica cada ronda se parte en dos (1a caja negra, 1b caja blanca; 2a regresión, 2b ataques a las correcciones).
- Toda prueba que falla es un **hallazgo**. Las que pasan se quedan como regresión.

Es la auditoría externa después de la interna. Hay un catálogo de ataques por tipo de módulo (dinero: 0.005, notas de crédito, montos enormes; cifrado: AAD cruzada, nonce repetido, secreto en logs; cola: un estudio con 1 000 trabajos contra otro con 1).

### Cómo se registra un hallazgo

En `docs/specs/ESTADO.md`, sección "Hallazgos adversariales abiertos", una fila por hallazgo: spec, archivo:línea de la prueba, ID y severidad con la causa (`archivo:línea`), y estado con el commit que lo corrige. Ejemplo real (resumido):

| Spec | Prueba | Hallazgo | Estado |
|---|---|---|---|
| 003-cifrado | `packages/crypto/src/ronda1b.adv.spec.ts` | F1 (alta): la rotación acepta `mock` como llave activa (causa `reenvolver.ts:27`) | corregido (1e11e8d) |

Estados posibles: `corregido (<hash>)`, `aceptado por el usuario` (límite conocido, documentado en la spec) o `descartado (falso positivo…)` con la razón. Nada se borra: queda la traza, como los papeles de trabajo.

## 6. Cobertura ≥ 90 % por archivo

La cobertura mide qué líneas, ramas y funciones ejecutaron las pruebas. `packages/domain/vitest.cobertura.config.mts`:

```ts
coverage: {
  provider: "v8",
  include: ["src/dinero/**/*.ts", "src/comprobante/**/*.ts", "src/reglas/**/*.ts", "src/texto/**/*.ts"],
  thresholds: { perFile: true, lines: 90, statements: 90, functions: 90, branches: 90 },
},
```

`perFile: true` es clave: un archivo con 40 % no se esconde detrás del promedio de los demás. Ojo: 100 % de cobertura no significa 0 bugs (una línea puede ejecutarse sin que nadie verifique su resultado); significa que **no hay código que ninguna prueba toque**. Por eso se combina con adversariales.

## 7. El CI: GitHub Actions

`.github/workflows/ci.yml` corre en cada `push` y `pull_request` dos trabajos:

1. **`ci`**: instalar con `--frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build` y `pnpm cobertura:dominio`.
2. **`aislamiento`**: levanta **servicios** `postgres:17` y `redis:7` con *healthchecks*, genera una contraseña aleatoria por corrida para el rol de la app (enmascarada con `::add-mask::`), corre `pnpm ci:db` (migra **dos veces** para probar que las migraciones son repetibles, siembra, suite de aislamiento RLS, integración del worker y del backend) y las coberturas de auth, acceso, cola, db y crypto.

```yaml
services:
  postgres:
    image: postgres:17
    options: >-
      --health-cmd "pg_isready -U postgres"
  redis:
    image: redis:7
```

El CI es el revisor que nunca se cansa: si alguien olvida correr las pruebas en local, el CI las corre igual y en una máquina limpia (y con otra carga de CPU, lo que destapa problemas de tiempos).

## 8. Dos historias reales de la spec 008

### "Parecía flake", pero era la medición (CA-2, commit `8198e11`)

CA-2 exige reparto justo: si el estudio A tiene 1 000 trabajos pendientes y llega B con uno, B debe empezar tras, como mucho, un trabajo más de cada estudio. La prueba en `packages/queue/src/despacho.int.spec.ts` medía cuántos trabajos habían iniciado antes de anunciar a B **con un sondeo cada 25 ms**. Con CPU cargada o con cobertura activada, el sondeo llegaba tarde: cuando la prueba "anotaba" el conteo ya habían iniciado 7 u 8, y fallaba `iniciadosAntes <= 6`. Fallaba 2 de cada 12 corridas con carga.

¿Bug del despachador? No: midiendo bien, B empezaba ≤ 2 inicios después de ser visible. La prueba estaba midiendo con un reloj impreciso. La corrección (solo en la prueba) fue una **compuerta**:

```ts
// packages/queue/src/despacho.int.spec.ts (simplificado)
const compuertas: Array<() => void> = [];
a.ejecutor.comportamiento = async () => {
  if (compuertas.length < 4) await new Promise<void>((r) => compuertas.push(r)); // retiene 4
  else await dormir(250);
};
// ... con los 4 cupos retenidos, "antes de B" es exactamente 4; se anuncia B
// y se liberan los cupos de a uno.
expect(iniciadosAntes - 4).toBeLessThanOrEqual(2);
expect(iniciadosAntes).toBeLessThanOrEqual(6);
```

Las cotas **no se aflojaron**: se hizo exacta la medición. Lección: ante una prueba intermitente, la salida fácil (subir el timeout, aflojar el `<=`, reintentar) esconde problemas. Hay que reproducir con carga y decidir, con evidencia, si falla el código o la medición.

### Parecía intermitente, y era un bug real (dedupe `23505`, commit `3f73f27`)

Hallazgo H-008-1a-2, detectado en el CI e intermitente: dos `encolar` simultáneos del mismo trabajo. El código hacía "¿ya existe uno vivo? si no, inserto". Entre la consulta y el `INSERT` la otra transacción insertaba primero, y el índice único `job_registro_dedupe_vivo` lanzaba el error de PostgreSQL **`23505` (unique_violation)** al usuario, en vez de devolver el trabajo existente. Es la clásica carrera *check-then-act*.

Aquí la intermitencia **sí** era el síntoma de un bug. La corrección (`packages/queue/src/encolado.ts` y `packages/db/src/trabajos/registro.ts`) hace el `INSERT … ON CONFLICT … DO NOTHING` (atómico en la BD) y, si no insertó, relee el vivo. Evidencia del ESTADO: "32/32 corridas verdes con carga, antes 12/12 rojas". La ronda 2b encontró una variante (H-008-2b-7: el vivo termina entre el `ON CONFLICT` y la relectura) y se cerró con hasta 3 intentos.

| | CA-2 (8198e11) | Dedupe (3f73f27) |
|---|---|---|
| Síntoma | Falla a veces con carga | Falla a veces con carga |
| ¿Qué estaba mal? | La prueba (medía tarde) | El código (carrera check-then-act) |
| Qué se cambió | Solo el `*.int.spec.ts` | Producción + prueba nueva |
| Cómo se decidió | Reproducir y medir sin carrera | Reproducir: 12/12 rojas |

## 9. Roles de agentes

`.claude/agents/` y `docs/04-metodologia.md` §3.1:

| Rol | Modelo | Hace | No hace |
|---|---|---|---|
| arquitecto | Opus | spec, plan, tasks; revisión final de nivel A | código de producción |
| backend | Sonnet (Opus en lo crítico) | `apps/backend`, `apps/worker`, `packages/*` | editar pruebas del tester o del adversario |
| frontend | Sonnet | `apps/frontend` | lógica de negocio |
| tester | Sonnet | pruebas primero, integración, verificación de CA | código de producción |
| adversario | Opus | `*.adv.spec.ts` | código de producción |
| devops | Haiku | andamiaje, CI, seeds, correr checks, cierre | decisiones de diseño |

La separación de funciones es la misma idea que en contabilidad: quien registra no aprueba, quien aprueba no audita.

## Práctica

**A. Ver una prueba en rojo y volver a verde** (no dejes el cambio):

```bash
cd packages/domain
pnpm exec vitest run src/dinero/redondeo.spec.ts     # verde (solo ese archivo)
# Rompe el redondeo: en src/dinero/decimal.ts:51 cambia `dobleResto.gte(den)` por `dobleResto.gt(den)`
sed -i 's/dobleResto.gte(den)/dobleResto.gt(den)/' src/dinero/decimal.ts
pnpm exec vitest run src/dinero/redondeo.spec.ts     # rojo
#   × 2.25 × 0.18 = 0.405 → 0.41 (no 0.40)
#   × redondearSunat(MontoExacto 0.005) = 0.01 ...
git checkout src/dinero/decimal.ts                    # revierte
git status --porcelain src                            # vacío
```

Con `gt` el medio céntimo exacto ya no sube: pasaste de *half-up* a *half-down*. Varias pruebas te lo dicen con el caso exacto.

**B. Leer un reporte de cobertura**:

```bash
pnpm cobertura:dominio
```

Verás una tabla `File | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s` y la fila `All files` (hoy ≈ 98–99 %). Busca la columna `Uncovered Line #s`: son las líneas que ninguna prueba ejecuta. Si un archivo baja de 90 % en cualquiera de las cuatro columnas, el comando termina con error y el CI se pone rojo.

**C. (Opcional) Pruebas de integración** con PG y Redis locales: `pnpm --filter @contapp/queue test:int`. Necesitan `.env` con `DATABASE_URL` y `REDIS_URL` (ver `.env.example`; no copies valores reales a ningún sitio).

## Impacto en ContApp

- Las specs A (cifrado, auth, cola, dinero, reglas) acumulan decenas de hallazgos corregidos **antes** de llegar a un contador; ninguno quedó "abierto" sin decisión.
- El CI con PG 17 y Redis 7 reales prueba lo que de verdad protege los datos: RLS, permisos, carreras.
- La traza spec → tarea → commit → hallazgo permite responder "¿por qué el código hace esto?" meses después.

## Errores comunes

- Escribir la prueba después y "a la medida" del código: confirma el bug en vez de detectarlo.
- Marcar una prueba como *flaky* y reintentarla sin investigar (podría ser el 3f73f27).
- Aflojar una aserción para que pase (lo contrario de lo que hizo 8198e11).
- Probar detalles internos: cada refactor rompe pruebas que no protegían nada.
- Creer que 90 % de cobertura = calidad: sin aserciones buenas, la cobertura es decorativa.
- Correr todo el monorepo mientras trabajas: corre solo el paquete afectado (`CLAUDE.md`).

## Ejercicios

1. Una spec de "exportar el reporte de clientes a Excel" (sin montos, solo nombres y RUC del propio estudio). Responde las 4 preguntas y asigna nivel.
2. ¿Por qué el adversario no puede ser el mismo agente que implementó?
3. Una prueba de integración falla 1 de cada 20 veces en el CI. Enumera los pasos antes de tocar código.
4. ¿Qué diferencia hay entre `pnpm --filter @contapp/queue test` y `test:int`?
5. ¿Por qué `pnpm ci:db` ejecuta `db:migrate` dos veces?

<details><summary>Soluciones</summary>

1. (1) no (sin montos); (2) sí: un error podría mezclar clientes de otro estudio; (3) probablemente sí: el contador no nota en su Excel una fila ajena; (4) no. Con (2) y otra más es **A**. Si se responde (3) = no, sería **C** (un solo "sí"). Lo importante es dejar la justificación escrita en la spec.
2. Porque compartiría los mismos supuestos y puntos ciegos. La metodología exige otro agente y otra sesión.
3. Reproducir con carga (repetir N veces, con cobertura o CPU ocupada), aislar si la falla está en la medición o en el código, revisar carreras *check-then-act*, decidir con evidencia (como 8198e11 vs 3f73f27) y registrar en ESTADO si es un hallazgo.
4. `test` corre solo `*.spec.ts` sin BD ni Redis; `test:int` corre solo `*.int.spec.ts` contra PG y Redis reales, en un hilo (`fileParallelism: false`).
5. Para probar que las migraciones son repetibles (idempotentes): una segunda corrida no debe fallar ni cambiar nada.

</details>

## Para profundizar

- Vitest, guía y cobertura: https://vitest.dev/guide/ · https://vitest.dev/guide/coverage
- GitHub Actions, contenedores de servicio: https://docs.github.com/en/actions/use-cases-and-examples/using-containerized-services/about-service-containers
- PostgreSQL, códigos de error (`23505`): https://www.postgresql.org/docs/17/errcodes-appendix.html
