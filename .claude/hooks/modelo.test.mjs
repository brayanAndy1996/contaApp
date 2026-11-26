// Spec 043 · pruebas del hook de modelo por tarea (CA-1 a CA-4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizarModelo,
  referenciaTarea,
  modeloDeFila,
  decidir,
} from './lib/modelo.mjs';

const TASKS = `# Tareas 999
| # | Tarea | Rol | Modelo | Depende de | TDD | ADV | Estado |
|---|---|---|---|---|---|---|---|
| T1 | Pruebas | tester | sonnet | — | ✓ | — | [ ] |
| T7 | Servicios | backend | opus | T1 | ✓ | — | [ ] |
| T12 | Ronda 1a | adversario | opus | T7 | — | ✓ | [ ] |
| T14 | Corregir | backend (+frontend) | opus (sonnet) | T12 | — | — | [ ] |
| T19 | Cierre | devops | haiku | T14 | — | — | [ ] |
`;
const AGENTES = {
  adversario: '---\nname: adversario\nmodel: opus\n---\n',
  arquitecto: '---\nname: arquitecto\nmodel: opus\n---\n',
  backend: '---\nname: backend\nmodel: sonnet\n---\n',
  tester: '---\nname: tester\nmodel: sonnet\n---\n',
  devops: '---\nname: devops\nmodel: haiku\n---\n',
};
const CARPETA = 'docs/specs/999-prueba';
const leer = (ruta) => {
  if (ruta === `${CARPETA}/tasks.md`) return TASKS;
  const m = /^\.claude\/agents\/([\w-]+)\.md$/.exec(ruta);
  return m ? (AGENTES[m[1]] ?? null) : null;
};
const FECHA = '2026-11-26T12:00:00.000Z';
const lanzar = (toolInput, env = {}) =>
  decidir({ toolName: 'Agent', toolInput, leer, env, fecha: FECHA });
const prompt = (t) => `Tarea: ${CARPETA}/tasks.md#${t}\nLee el Contexto de la tarea y nada más.`;

test('normaliza alias de modelo', () => {
  assert.equal(normalizarModelo('opus'), 'opus');
  assert.equal(normalizarModelo('claude-opus-5-5'), 'opus');
  assert.equal(normalizarModelo('Sonnet'), 'sonnet');
  assert.equal(normalizarModelo('claude-haiku-5-5'), 'haiku');
  assert.equal(normalizarModelo('inherit'), null);
  assert.equal(normalizarModelo(undefined), null);
});

test('referencia de tarea: válida, ausente y con ruta que escapa', () => {
  assert.deepEqual(referenciaTarea(prompt('T7')), { carpeta: CARPETA, tarea: 'T7' });
  assert.equal(referenciaTarea('haz la T7 de la 029'), null);
  assert.equal(referenciaTarea('Tarea: docs/specs/../../etc/tasks.md#T1'), null);
});

test('modelo de la fila: primera palabra, ignora el rol secundario', () => {
  assert.equal(modeloDeFila(TASKS, 'T12'), 'opus');
  assert.equal(modeloDeFila(TASKS, 'T14'), 'opus');
  assert.equal(modeloDeFila(TASKS, 'T1'), 'sonnet');
  assert.equal(modeloDeFila(TASKS, 'T99'), null);
});

// CA-1
test('CA-1: adversario con sonnet en tarea opus se bloquea', () => {
  const r = lanzar({ subagent_type: 'adversario', model: 'sonnet', prompt: prompt('T12') });
  assert.equal(r.accion, 'bloquear');
  assert.match(r.motivo, /T12/);
  assert.match(r.motivo, /opus/);
  assert.match(r.registro.linea, /\tbloqueado$/);
});

test('CA-1: adversario con opus o sin model (frontmatter opus) se permite', () => {
  assert.equal(lanzar({ subagent_type: 'adversario', model: 'opus', prompt: prompt('T12') }).accion, 'permitir');
  const r = lanzar({ subagent_type: 'adversario', prompt: prompt('T12') });
  assert.equal(r.accion, 'permitir');
  assert.match(r.registro.linea, /\tadversario\topus\t/);
});

// CA-2
test('CA-2: backend sin model en tarea opus se bloquea (frontmatter sonnet)', () => {
  const r = lanzar({ subagent_type: 'backend', prompt: prompt('T7') });
  assert.equal(r.accion, 'bloquear');
  assert.match(r.motivo, /model: "opus"/);
});

test('CA-2: backend con model opus se permite; tester con opus en tarea sonnet queda como escalado', () => {
  assert.equal(lanzar({ subagent_type: 'backend', model: 'opus', prompt: prompt('T7') }).accion, 'permitir');
  const r = lanzar({ subagent_type: 'tester', model: 'claude-opus-5-5', effort: 'high', prompt: prompt('T1') });
  assert.equal(r.accion, 'permitir');
  assert.equal(r.registro.linea, `${FECHA}\tT1\ttester\topus\thigh\tescalado`);
});

test('CA-2: la variable de entorno solo cuenta si no hay model ni frontmatter', () => {
  const r = lanzar({ subagent_type: 'general-purpose', prompt: prompt('T19') }, { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' });
  assert.equal(r.accion, 'permitir');
  assert.match(r.registro.linea, /\tgeneral-purpose\thaiku\t/);
  const r2 = lanzar({ subagent_type: 'backend', prompt: prompt('T7') }, { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' });
  assert.equal(r2.accion, 'bloquear');
});

test('CA-2: con tarea y modelo indeterminable se bloquea', () => {
  const r = lanzar({ subagent_type: 'fork', prompt: prompt('T1') });
  assert.equal(r.accion, 'bloquear');
  assert.match(r.motivo, /model/);
});

// CA-3
test('CA-3: adversario o arquitecto sin tarea se bloquean', () => {
  for (const rol of ['adversario', 'arquitecto']) {
    const r = lanzar({ subagent_type: rol, model: 'opus', prompt: 'revisa la 029' });
    assert.equal(r.accion, 'bloquear');
    assert.match(r.motivo, /Tarea: docs\/specs\/NNN-\*\/tasks\.md#Tn/);
    assert.equal(r.registro, undefined);
  }
});

test('CA-3: otro rol sin tarea pasa sin registro', () => {
  const r = lanzar({ subagent_type: 'Explore', prompt: 'busca usos de withTenant' });
  assert.deepEqual(r, { accion: 'permitir' });
});

test('CA-3: tarea inexistente o tasks.md ausente se bloquea', () => {
  assert.equal(lanzar({ subagent_type: 'tester', prompt: prompt('T99') }).accion, 'bloquear');
  const r = lanzar({ subagent_type: 'tester', prompt: 'Tarea: docs/specs/998-no-existe/tasks.md#T1' });
  assert.equal(r.accion, 'bloquear');
  assert.equal(r.registro, undefined);
});

// CA-4
test('CA-4: una sola línea de registro, sin el prompt, en la carpeta de la spec', () => {
  const r = lanzar({ subagent_type: 'devops', prompt: prompt('T19') + ' SECRETO-NO-REGISTRAR' });
  assert.equal(r.registro.carpeta, CARPETA);
  assert.equal(r.registro.linea.split('\n').length, 1);
  assert.doesNotMatch(r.registro.linea, /SECRETO/);
  assert.equal(r.registro.linea, `${FECHA}\tT19\tdevops\thaiku\t-\tpermitido`);
});

test('formato desconocido o herramienta ajena: permite', () => {
  assert.equal(decidir({ toolName: 'Agent', toolInput: undefined, leer, env: {}, fecha: FECHA }).accion, 'permitir');
  assert.equal(decidir({ toolName: 'Bash', toolInput: { command: 'ls' }, leer, env: {}, fecha: FECHA }).accion, 'permitir');
});
