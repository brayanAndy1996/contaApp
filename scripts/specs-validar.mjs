#!/usr/bin/env node
// Spec 043 · valida los tasks.md de las specs abiertas (según ESTADO.md):
// celda «Modelo» de una palabra y Opus obligatorio en áreas críticas.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { filasDeTabla, filasDeTareas } from '../.claude/hooks/lib/modelo.mjs';

const CELDA = /^(opus|sonnet|haiku)(\s*\((opus|sonnet|haiku)\))?$/;

export function specsAbiertas(estadoMd) {
  return filasDeTabla(estadoMd, 'Spec')
    .filter((f) => f.Estado && f.Estado !== 'hecha')
    .map((f) => f.Spec);
}

export function validarSpec({ nombre, specMd, tasksMd }) {
  const errores = [];
  const areas = /^Áreas críticas:\s*(.+)$/m.exec(specMd ?? '');
  if (!areas) errores.push(`${nombre}: spec.md no tiene la línea «Áreas críticas: …» (o «ninguna»).`);
  const critica = areas && !/^ninguna\b/i.test(areas[1].trim());
  for (const f of filasDeTareas(tasksMd)) {
    if (!/^T\w+$/.test(f['#'] ?? '')) continue;
    const celda = (f.Modelo ?? '').replace(/`/g, '').trim();
    if (!CELDA.test(celda)) {
      errores.push(`${nombre}: ${f['#']} tiene el modelo «${celda}»; usa opus, sonnet o haiku (rol secundario entre paréntesis).`);
      continue;
    }
    const principal = celda.split(/\s|\(/)[0];
    const esAdv = (f.ADV ?? '').includes('✓');
    const esRevision = /arquitecto/.test(f.Rol ?? '') && /revisi[oó]n final/i.test(f.Tarea ?? '');
    if (critica && (esAdv || esRevision) && principal !== 'opus') {
      errores.push(`${nombre}: ${f['#']} toca un área crítica (${areas[1].trim()}) y debe ser opus, no ${principal}.`);
    }
  }
  return errores;
}

function main() {
  const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dirSpecs = path.join(raiz, 'docs/specs');
  const errores = [];
  let revisadas = 0;
  for (const nombre of specsAbiertas(readFileSync(path.join(dirSpecs, 'ESTADO.md'), 'utf8'))) {
    const tasks = path.join(dirSpecs, nombre, 'tasks.md');
    if (!existsSync(tasks)) continue;
    revisadas++;
    errores.push(...validarSpec({
      nombre,
      specMd: readFileSync(path.join(dirSpecs, nombre, 'spec.md'), 'utf8'),
      tasksMd: readFileSync(tasks, 'utf8'),
    }));
  }
  if (errores.length) {
    console.error(errores.join('\n'));
    process.exit(1);
  }
  console.log(`specs:validar · ${revisadas} spec(s) abierta(s) con tasks.md, sin errores.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
