# ContApp

SaaS multitenant para contadores en Perú: SIRE (compras/ventas), correcciones automáticas, buzones SOL, prorrata.

## Documentos (leer solo la sección necesaria)
- `docs/01-definiciones-base.md` — tenancy, planes, credenciales, reglas de negocio de los videos
- `docs/02-requerimientos.md` — RF, RNF, historias de usuario (referenciar por ID)
- `docs/03-arquitectura.md` — procesos, capas, adaptadores, colas, carpetas
- `docs/04-metodologia.md` — SDD, niveles de riesgo A–D, TDD/adversarial, modelos, eficiencia de tokens
- `docs/specs/NNN-*/` — spec, plan y tareas de cada funcionalidad · `docs/specs/ESTADO.md` — tablero
- `docs/prompt-orquestador.md` — prompt para iniciar/retomar el desarrollo

## Roles (subagentes en `.claude/agents/`)
arquitecto (opus) · backend (sonnet) · frontend (sonnet) · tester (sonnet) · adversario (opus) · devops (haiku). El modelo efectivo de cada tarea es el de su `tasks.md`. Si eres un subagente: haz solo tu tarea y responde corto.

## Reglas
- Nada se implementa sin spec aprobada. Trabaja solo la tarea asignada y lee solo su "Contexto".
- Monorepo pnpm: `apps/frontend` (Next.js), `apps/backend` (NestJS), `apps/worker` (NestJS + BullMQ), `packages/*`.
- `apps/frontend` solo depende de `packages/shared`. `apps/backend` nunca llama a SUNAT ni descifra credenciales.
- Lógica de negocio pura en `packages/domain` (sin IO). Todo lo externo detrás de un puerto (`packages/sunat/src/puertos.ts`).
- Montos: `Money`/`decimal.js` y `NUMERIC(14,2)`. Nunca `number` para dinero.
- Toda consulta de negocio va dentro de `withTenant()` (RLS). Nunca desactivar RLS.
- Nunca registrar, devolver ni exportar secretos (claves SOL, client_secret, tokens).
- Adaptadores en `mock` por defecto (`XML_PROVIDER=mock`, etc.). La fuente XML real la entrega el equipo después.
- Dominio en español, términos técnicos estándar en inglés. Conventional Commits, rama `spec/NNN-nombre`.
- Pruebas: `*.spec.ts`, adversariales `*.adv.spec.ts`. Corre solo las del paquete afectado mientras trabajas.
