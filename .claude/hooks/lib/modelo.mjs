// Spec 043 · lógica pura del hook que verifica el modelo de cada tarea.
// Sin IO: `leer(rutaRelativa)` devuelve el texto o null.

export const RANGO = { haiku: 1, sonnet: 2, opus: 3 };
const ROLES_CON_TAREA = new Set(['adversario', 'arquitecto']);
const HERRAMIENTAS = new Set(['Agent', 'Task']);
const FORMATO_REF = 'Tarea: docs/specs/NNN-*/tasks.md#Tn';

export function normalizarModelo(valor) {
  if (typeof valor !== 'string') return null;
  const s = valor.toLowerCase();
  for (const m of ['opus', 'sonnet', 'haiku']) if (s.includes(m)) return m;
  return null;
}

export function referenciaTarea(prompt) {
  const m = /Tarea:\s*(docs\/specs\/[\w.-]+)\/tasks\.md#(T\w+)/.exec(prompt ?? '');
  if (!m || m[1].includes('..')) return null;
  return { carpeta: m[1], tarea: m[2] };
}

function celdas(linea) {
  return linea.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

/** Filas de la tabla cuya cabecera tiene `columna`, como objetos { '#': 'T1', Rol, Modelo, ADV, … }. */
export function filasDeTabla(md, columna) {
  const filas = [];
  let cabecera = null;
  for (const linea of (md ?? '').split('\n')) {
    if (!linea.trim().startsWith('|')) { cabecera = null; continue; }
    const c = celdas(linea);
    if (!cabecera) { if (c.includes(columna)) cabecera = c; continue; }
    if (c.every((x) => /^:?-+:?$/.test(x))) continue;
    filas.push(Object.fromEntries(cabecera.map((h, i) => [h, c[i] ?? ''])));
  }
  return filas;
}

export const filasDeTareas = (tasksMd) => filasDeTabla(tasksMd, 'Modelo');

export function modeloDeFila(tasksMd, tarea) {
  const fila = filasDeTareas(tasksMd).find((f) => f['#'] === tarea);
  if (!fila) return null;
  const principal = fila.Modelo.replace(/\(.*?\)/g, '').replace(/`/g, '');
  const m = /\b(opus|sonnet|haiku)\b/.exec(principal);
  return m ? m[1] : null;
}

function modeloDeFrontmatter(md) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(md ?? '');
  const m = fm && /^model:\s*(\S+)/m.exec(fm[1]);
  return m ? normalizarModelo(m[1]) : null;
}

export function modeloEfectivo(toolInput, leer, env) {
  return (
    normalizarModelo(toolInput.model) ??
    modeloDeFrontmatter(leer(`.claude/agents/${toolInput.subagent_type}.md`)) ??
    normalizarModelo(env.CLAUDE_CODE_SUBAGENT_MODEL)
  );
}

export function decidir({ toolName, toolInput, leer, env = {}, fecha }) {
  if (!HERRAMIENTAS.has(toolName) || !toolInput || typeof toolInput !== 'object') {
    return { accion: 'permitir' };
  }
  const rol = String(toolInput.subagent_type ?? 'general-purpose');
  const ref = referenciaTarea(toolInput.prompt);
  if (!ref) {
    if (ROLES_CON_TAREA.has(rol)) {
      return {
        accion: 'bloquear',
        motivo: `043: el rol ${rol} exige la referencia «${FORMATO_REF}» en el prompt para verificar su modelo.`,
      };
    }
    return { accion: 'permitir' };
  }
  const { carpeta, tarea } = ref;
  const spec = carpeta.split('/').pop();
  const tasksMd = leer(`${carpeta}/tasks.md`);
  if (tasksMd == null) {
    return { accion: 'bloquear', motivo: `043: no encuentro ${carpeta}/tasks.md.` };
  }
  const efectivo = modeloEfectivo(toolInput, leer, env);
  const effort = toolInput.effort ? String(toolInput.effort) : '-';
  const registro = (resultado) => ({
    carpeta,
    linea: [fecha, tarea, rol, efectivo ?? '?', effort, resultado].join('\t'),
  });
  const exigido = modeloDeFila(tasksMd, tarea);
  if (!exigido) {
    return {
      accion: 'bloquear',
      motivo: `043: no encuentro la tarea ${tarea} (o su modelo) en ${spec}/tasks.md.`,
      registro: registro('bloqueado'),
    };
  }
  if (!efectivo) {
    return {
      accion: 'bloquear',
      motivo: `043: no puedo saber el modelo de ${rol} para ${tarea} de ${spec}; pasa model: "${exigido}" explícito.`,
      registro: registro('bloqueado'),
    };
  }
  if (RANGO[efectivo] < RANGO[exigido]) {
    return {
      accion: 'bloquear',
      motivo: `043: ${tarea} de ${spec} exige ${exigido}; pediste ${efectivo}. Relanza con model: "${exigido}".`,
      registro: registro('bloqueado'),
    };
  }
  return {
    accion: 'permitir',
    registro: registro(RANGO[efectivo] > RANGO[exigido] ? 'escalado' : 'permitido'),
  };
}
