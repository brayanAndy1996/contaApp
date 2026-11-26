#!/usr/bin/env node
// Spec 043 · hook PreToolUse de la herramienta Agent: verifica el modelo de cada
// tarea contra su tasks.md, lo registra en docs/specs/NNN-*/agentes.log y bloquea
// (salida 2) si el modelo es menor al exigido.
import { readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { decidir } from './lib/modelo.mjs';

const raiz = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const leer = (rel) => {
  try { return readFileSync(path.join(raiz, rel), 'utf8'); } catch { return null; }
};

let entrada;
try { entrada = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }

const r = decidir({
  toolName: entrada?.tool_name,
  toolInput: entrada?.tool_input,
  leer,
  env: process.env,
  fecha: new Date().toISOString(),
});

if (r.registro) {
  try { appendFileSync(path.join(raiz, r.registro.carpeta, 'agentes.log'), r.registro.linea + '\n'); } catch { /* sin registro no se frena el trabajo */ }
}
if (r.accion === 'bloquear') {
  process.stderr.write(r.motivo + '\n');
  process.exit(2);
}
process.exit(0);
