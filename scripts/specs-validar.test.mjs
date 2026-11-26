// Spec 043 · pruebas del validador de tasks.md (CA-5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validarSpec, specsAbiertas } from './specs-validar.mjs';

const tasks = (filas) => `| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
${filas.join('\n')}
`;
const spec = (areas) => `# Spec 999\nEstado: aprobada\nNivel de riesgo: A\n${areas === null ? '' : `Áreas críticas: ${areas}\n`}`;

test('CA-5: área crítica con ADV en sonnet falla', () => {
  const errores = validarSpec({
    nombre: '999-x',
    specMd: spec('autenticación'),
    tasksMd: tasks(['| T12 | Ronda 1 | adversario | sonnet | T7 | — | ✓ | [ ] |']),
  });
  assert.equal(errores.length, 1);
  assert.match(errores[0], /999-x.*T12.*opus/);
});

test('CA-5: revisión final del arquitecto en sonnet con área crítica falla', () => {
  const errores = validarSpec({
    nombre: '999-x',
    specMd: spec('dinero'),
    tasksMd: tasks(['| T18 | Revisión final contra la spec | arquitecto | sonnet | T17 | — | — | [ ] |']),
  });
  assert.equal(errores.length, 1);
});

test('CA-5: sin área crítica, ADV en sonnet pasa', () => {
  assert.deepEqual(validarSpec({
    nombre: '999-x',
    specMd: spec('ninguna'),
    tasksMd: tasks(['| T4 | Ronda | adversario | sonnet | T2 | — | ✓ | [ ] |']),
  }), []);
});

test('CA-5: celda de modelo inválida o falta la línea de áreas', () => {
  const e1 = validarSpec({
    nombre: '999-x',
    specMd: spec('ninguna'),
    tasksMd: tasks(['| T4 | Ronda | adversario | opus en área crítica / sonnet | T2 | — | ✓ | [ ] |']),
  });
  assert.equal(e1.length, 1); // ambigua: debe ser una sola palabra (+ rol secundario entre paréntesis)
  const e2 = validarSpec({
    nombre: '999-x',
    specMd: spec('ninguna'),
    tasksMd: tasks(['| T4 | Ronda | adversario | según área | T2 | — | ✓ | [ ] |']),
  });
  assert.equal(e2.length, 1);
  assert.match(e2[0], /T4/);
  const e3 = validarSpec({ nombre: '999-x', specMd: spec(null), tasksMd: tasks([]) });
  assert.match(e3[0], /Áreas críticas/);
});

test('specs abiertas según ESTADO.md', () => {
  const estado = `| Spec | Nivel | Estado | Tarea actual | Nota |
|---|---|---|---|---|
| 028-correo-avisos | B | hecha | — | x |
| 029-cuenta-segura | A | pendiente | — | x |
| 043-modelo | D | en curso | T1 | x |
`;
  assert.deepEqual(specsAbiertas(estado), ['029-cuenta-segura', '043-modelo']);
});
