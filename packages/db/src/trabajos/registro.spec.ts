// Spec 008 (T3, rojo): repositorio de `job_registro` sin BD (tx falsa). Fija el mapeo de filas, que el SQL sea estatico y
// parametrizado (los datos de entrada van como $n, nunca en el texto), que los errores de pg salgan como TrabajosRepoError
// con solo el SQLSTATE y las reglas de cada funcion. El comportamiento con BD real y las firmas completas estan en
// tests/aislamiento/trabajos-repos.spec.ts. Formas alineadas con packages/queue/src/soporte-pruebas/bd-falsa.ts (T4):
// insertarTrabajo, trabajoVivoPorClave y listarTrabajos devuelven TrabajoVista; leerTrabajo y siguienteDisponible, la fila.
import { describe, expect, it } from "vitest";
import { TrabajosRepoError } from "./errores";
import {
  contarPendientes,
  insertarTrabajo,
  leerTrabajo,
  listarTrabajos,
  posicion,
  purgarTerminados,
  revalidarEncolado,
  siguienteDisponible,
  trabajoVivoPorClave,
  transicionar,
} from "./registro";
import { errorPg, FILA, txFalso } from "./soporte-prueba";

const CANARIO = "CANARIO-TOKEN-777";

/** TrabajoVista de shared: fechas como string ISO, posicion null (la calcula `posicion`), creadoPor { usuarioId }. */
const VISTA = {
  id: FILA.id,
  tipo: "prueba.eco",
  clienteId: FILA.cliente_id,
  estado: "en_cola",
  posicion: null,
  intentos: 0,
  motivo: null,
  creadoEn: FILA.creado_en.toISOString(),
  iniciadoEn: null,
  terminadoEn: null,
  creadoPor: { usuarioId: FILA.creado_por },
};

/** Fila completa en camelCase (leerTrabajo; siguienteDisponible entrega al menos los campos de TrabajoDespacho). */
const FILA_TS = {
  id: FILA.id,
  tenantId: FILA.tenant_id,
  clienteId: FILA.cliente_id,
  ruc: FILA.ruc,
  tipo: "prueba.eco",
  cola: "sire",
  canal: "sire",
  prioridad: "interactivo",
  estado: "en_cola",
  parametros: { n: 1 },
  creadoPor: FILA.creado_por,
  intentos: 0,
  maxIntentos: 3,
  motivo: null,
  resultado: null,
  disponibleDesde: FILA.disponible_desde,
  creadoEn: FILA.creado_en,
  iniciadoEn: null,
  terminadoEn: null,
  actualizadoEn: FILA.actualizado_en,
};
const DESPACHO = {
  id: FILA.id,
  tenantId: FILA.tenant_id,
  clienteId: FILA.cliente_id,
  ruc: FILA.ruc,
  tipo: "prueba.eco",
  cola: "sire",
  canal: "sire",
  prioridad: "interactivo",
  creadoPor: FILA.creado_por,
  creadoEn: FILA.creado_en,
  intentos: 0,
};

const nuevo = {
  clienteId: FILA.cliente_id,
  ruc: FILA.ruc,
  tipo: "prueba.eco",
  cola: "sire",
  canal: "sire",
  prioridad: "interactivo",
  parametros: { token: CANARIO },
  claveDedupe: Buffer.alloc(32, 9),
  creadoPor: FILA.creado_por,
  maxIntentos: 3,
} as const;

describe("insertarTrabajo", () => {
  it("devuelve la TrabajoVista (fechas ISO, posicion null, creadoPor { usuarioId }) y no filtra ruc, tenant ni clave", async () => {
    const { tx } = txFalso({ rows: [FILA] });
    const t = await insertarTrabajo(tx, nuevo);
    expect(t).toMatchObject(VISTA);
    for (const k of ["ruc", "tenantId", "claveDedupe", "parametros", "resultado", "maxIntentos"]) expect(t).not.toHaveProperty(k);
  });

  it("SQL estatico: los datos van como parametros (ni el canario ni el RUC aparecen en el texto) y el estado inicial es en_cola", async () => {
    const { tx, llamadas } = txFalso({ rows: [FILA] });
    await insertarTrabajo(tx, nuevo);
    expect(llamadas).toHaveLength(1);
    const { texto, valores } = llamadas[0]!;
    expect(texto).toMatch(/insert into job_registro/i);
    expect(texto).not.toContain(CANARIO);
    expect(texto).not.toContain(FILA.ruc);
    expect(texto).not.toContain(FILA.cliente_id);
    expect(texto).not.toMatch(/\btenant_id\b\s*[,)]/i); // lo pone el contexto (DEFAULT), nunca el llamador
    for (const v of [FILA.cliente_id, FILA.ruc, "prueba.eco", "sire", "interactivo", FILA.creado_por, 3]) expect(valores).toContain(v);
    expect(valores.some((v) => Buffer.isBuffer(v) && Buffer.compare(v, Buffer.alloc(32, 9)) === 0)).toBe(true);
    // parametros viaja como valor (objeto o JSON), nunca en el texto
    expect(valores.some((v) => (typeof v === "string" ? v.includes(CANARIO) : typeof v === "object" && JSON.stringify(v).includes(CANARIO)))).toBe(true);
  });

  it("creadoPor null viaja como null y la vista lo devuelve null", async () => {
    const { tx, llamadas } = txFalso({ rows: [{ ...FILA, creado_por: null }] });
    const t = await insertarTrabajo(tx, { ...nuevo, creadoPor: null });
    expect(t.creadoPor).toBeNull();
    expect(llamadas[0]!.valores).toContain(null);
  });

  it("un error de pg sale como TrabajosRepoError con solo el SQLSTATE", async () => {
    const { tx } = txFalso(errorPg("23505"));
    const e = await insertarTrabajo(tx, nuevo).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TrabajosRepoError);
    expect((e as TrabajosRepoError).codigo).toBe("23505");
    expect(JSON.stringify(e) + String((e as Error).message)).not.toContain("CANARIO-SOL-123");
  });
});

describe("lecturas: trabajoVivoPorClave, leerTrabajo, contarPendientes", () => {
  it("trabajoVivoPorClave devuelve la TrabajoVista o null, pasando la clave como parametro y solo en_cola/ejecutando", async () => {
    const hallada = txFalso({ rows: [FILA] });
    const clave = Buffer.alloc(32, 3);
    expect(await trabajoVivoPorClave(hallada.tx, clave)).toMatchObject(VISTA);
    expect(hallada.llamadas[0]!.valores.some((v) => Buffer.isBuffer(v) && Buffer.compare(v, clave) === 0)).toBe(true);
    expect(hallada.llamadas[0]!.texto).toMatch(/en_cola/);
    expect(hallada.llamadas[0]!.texto).toMatch(/ejecutando/);
    expect(await trabajoVivoPorClave(txFalso({ rows: [] }).tx, clave)).toBeNull();
  });

  it("leerTrabajo devuelve la fila completa en camelCase o null", async () => {
    const { tx, llamadas } = txFalso({ rows: [FILA] });
    const t = await leerTrabajo(tx, FILA.id);
    expect(t).toMatchObject(FILA_TS);
    expect(Buffer.isBuffer(t!.claveDedupe)).toBe(true);
    expect(llamadas[0]!.valores).toContain(FILA.id);
    expect(await leerTrabajo(txFalso({ rows: [] }).tx, FILA.id)).toBeNull();
  });

  it("leerTrabajo propaga un id mal formado como TrabajosRepoError 22P02", async () => {
    const e = await leerTrabajo(txFalso(errorPg("22P02")).tx, "no-es-uuid").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TrabajosRepoError);
    expect((e as TrabajosRepoError).codigo).toBe("22P02");
  });

  it.each([
    ["numero", { n: 5 }, 5],
    ["texto (count de pg viene como string)", { n: "12" }, 12],
    ["cero", { n: 0 }, 0],
  ])("contarPendientes devuelve un number: %s", async (_n, fila, esperado) => {
    const { tx, llamadas } = txFalso({ rows: [fila] });
    expect(await contarPendientes(tx, "sire")).toBe(esperado);
    expect(llamadas[0]!.valores).toContain("sire");
    expect(llamadas[0]!.texto).toMatch(/en_cola/);
  });
});

describe("siguienteDisponible", () => {
  it("pide la cola y `ahora` como parametros, ordena por prioridad y antiguedad y devuelve la fila (al menos TrabajoDespacho) o null", async () => {
    const ahora = new Date("2026-10-27T12:00:00Z");
    const { tx, llamadas } = txFalso({ rows: [FILA] });
    expect(await siguienteDisponible(tx, "sire", ahora)).toMatchObject(DESPACHO);
    const { texto, valores } = llamadas[0]!;
    expect(valores).toContain("sire");
    expect(valores.some((v) => v instanceof Date && v.getTime() === ahora.getTime())).toBe(true);
    expect(texto).toMatch(/order by/i);
    expect(texto).toMatch(/creado_en/);
    expect(texto).toMatch(/limit 1/i);
    expect(texto).toMatch(/disponible_desde/);
    expect(await siguienteDisponible(txFalso({ rows: [] }).tx, "sire", ahora)).toBeNull();
  });
});

describe("transicionar: UPDATE ... WHERE estado = desde (D2)", () => {
  it.each([
    [1, true],
    [0, false],
    [null, false],
  ])("rowCount %s -> %s (ganador unico)", async (rowCount, esperado) => {
    const { tx } = txFalso({ rows: [], rowCount });
    expect(await transicionar(tx, FILA.id, "en_cola", "ejecutando")).toBe(esperado);
  });

  it("filtra por id y por el estado de origen, y fija el nuevo estado como parametros", async () => {
    const { tx, llamadas } = txFalso({ rowCount: 1 });
    await transicionar(tx, FILA.id, "en_cola", "cancelado", { motivo: "cancelado_usuario" });
    const { texto, valores } = llamadas[0]!;
    expect(texto).toMatch(/update job_registro/i);
    expect(texto).toMatch(/where[\s\S]*\bid\b[\s\S]*estado\s*=/i);
    expect(valores).toEqual(expect.arrayContaining([FILA.id, "en_cola", "cancelado", "cancelado_usuario"]));
    expect(texto).not.toContain("cancelado_usuario");
  });

  it("hacia ejecutando fija iniciado_en; hacia un estado terminal fija terminado_en; hacia en_cola ninguno; siempre actualizado_en", async () => {
    const sets = async (desde: string, hacia: string, campos = {}) => {
      const { tx, llamadas } = txFalso({ rowCount: 1 });
      await transicionar(tx, FILA.id, desde as never, hacia as never, campos);
      return llamadas[0]!.texto;
    };
    const ejec = await sets("en_cola", "ejecutando");
    expect(ejec).toMatch(/iniciado_en\s*=/);
    expect(ejec).not.toMatch(/terminado_en\s*=/);
    for (const hacia of ["completado", "error", "cancelado"]) {
      const t = await sets("ejecutando", hacia);
      expect(t, hacia).toMatch(/terminado_en\s*=/);
      expect(t, hacia).not.toMatch(/iniciado_en\s*=/);
    }
    const reintento = await sets("ejecutando", "en_cola", { intentos: 2, disponibleDesde: new Date() });
    expect(reintento).not.toMatch(/terminado_en\s*=/);
    expect(reintento).not.toMatch(/iniciado_en\s*=/);
    for (const t of [ejec, reintento]) expect(t).toMatch(/actualizado_en\s*=/);
  });

  it("solo toca las columnas permitidas: nunca tenant_id, cliente_id, tipo, parametros, clave_dedupe ni creado_*", async () => {
    const { tx, llamadas } = txFalso({ rowCount: 1 });
    await transicionar(tx, FILA.id, "ejecutando", "error", { motivo: "sunat_no_responde", intentos: 3, resultado: { x: 1 } });
    const set = llamadas[0]!.texto.split(/\bwhere\b/i)[0]!;
    for (const prohibida of ["tenant_id", "cliente_id", "ruc", "tipo", "cola", "canal", "prioridad", "parametros", "clave_dedupe", "creado_por", "creado_en", "max_intentos"]) {
      expect(set, prohibida).not.toMatch(new RegExp(`\\b${prohibida}\\s*=`));
    }
    for (const col of ["estado", "motivo", "intentos", "resultado"]) expect(set, col).toMatch(new RegExp(`\\b${col}\\s*=`));
  });

  it("los campos opcionales ausentes no se tocan (motivo, intentos, resultado, disponible_desde)", async () => {
    const { tx, llamadas } = txFalso({ rowCount: 1 });
    await transicionar(tx, FILA.id, "en_cola", "ejecutando");
    const set = llamadas[0]!.texto.split(/\bwhere\b/i)[0]!;
    for (const col of ["motivo", "intentos", "resultado", "disponible_desde"]) expect(set, col).not.toMatch(new RegExp(`\\b${col}\\s*=`));
  });

  it("un error de pg (p. ej. permisos del backend) sale como TrabajosRepoError con el SQLSTATE", async () => {
    const e = await transicionar(txFalso(errorPg("42501")).tx, FILA.id, "en_cola", "ejecutando").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TrabajosRepoError);
    expect((e as TrabajosRepoError).codigo).toBe("42501");
  });
});

describe("listarTrabajos y posicion", () => {
  it("listarTrabajos devuelve TrabajoVista, ordena por creado_en DESC, limita a 100 y manda los filtros como parametros", async () => {
    const otra = { ...FILA, id: "00000000-0000-4000-8000-0000000000a2" };
    const { tx, llamadas } = txFalso({ rows: [FILA, otra] });
    const r = await listarTrabajos(tx, { tipo: "global" }, { clienteId: FILA.cliente_id, estado: "en_cola" });
    expect(r.map((x) => x.id)).toEqual([FILA.id, otra.id]);
    expect(r[0]).toMatchObject(VISTA);
    const { texto, valores } = llamadas[0]!;
    expect(texto).toMatch(/order by[\s\S]*creado_en\s+desc/i);
    expect(texto).toMatch(/limit\s+100\b/i);
    expect(valores).toEqual(expect.arrayContaining([FILA.cliente_id, "en_cola"]));
    expect(texto).not.toContain(FILA.cliente_id);
  });

  it("alcance asignado: el usuario viaja como parametro y la consulta usa la tabla asignacion (filtroAlcance de 005)", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    const usuarioId = "00000000-0000-4000-8000-0000000000e1";
    await listarTrabajos(tx, { tipo: "asignado", usuarioId }, {});
    expect(llamadas[0]!.texto).toMatch(/asignacion/);
    expect(llamadas[0]!.valores).toContain(usuarioId);
    expect(llamadas[0]!.texto).not.toContain(usuarioId);
  });

  it("alcance global no consulta asignacion", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    await listarTrabajos(tx, { tipo: "global" }, {});
    expect(llamadas[0]!.texto).not.toMatch(/asignacion/);
  });

  it("filtros ausentes: sin clienteId ni estado la consulta no los exige", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    expect(await listarTrabajos(tx, { tipo: "global" })).toEqual([]);
    expect(llamadas[0]!.valores).not.toContain(undefined);
  });

  it("posicion devuelve un number (bigint de pg llega como string) o null si el trabajo no esta en_cola", async () => {
    expect(await posicion(txFalso({ rows: [{ posicion: "4" }] }).tx, FILA.id)).toBe(4);
    expect(await posicion(txFalso({ rows: [{ posicion: 1 }] }).tx, FILA.id)).toBe(1);
    expect(await posicion(txFalso({ rows: [] }).tx, FILA.id)).toBeNull();
    expect(await posicion(txFalso({ rows: [{ posicion: null }] }).tx, FILA.id)).toBeNull();
  });
});

describe("purgarTerminados y revalidarEncolado", () => {
  it("purgarTerminados devuelve el rowCount, manda el corte como parametro y solo borra estados terminales", async () => {
    const antes = new Date("2026-07-29T00:00:00Z");
    const { tx, llamadas } = txFalso({ rowCount: 7 });
    expect(await purgarTerminados(tx, antes)).toBe(7);
    const { texto, valores } = llamadas[0]!;
    expect(texto).toMatch(/delete from job_registro/i);
    for (const e of ["completado", "error", "cancelado"]) expect(texto).toContain(e);
    expect(texto).not.toMatch(/en_cola|ejecutando/);
    expect(valores.some((v) => v instanceof Date && v.getTime() === antes.getTime())).toBe(true);
    expect(await purgarTerminados(txFalso({ rowCount: null }).tx, antes)).toBe(0);
  });

  it("revalidarEncolado: un error de pg sale como TrabajosRepoError y no inventa un 'ok'", async () => {
    const e = await revalidarEncolado(txFalso(errorPg("42501")).tx, {
      id: FILA.id,
      clienteId: FILA.cliente_id,
      creadoPor: FILA.creado_por,
      rolesPermitidos: ["dueno"],
    }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TrabajosRepoError);
  });

  it("revalidarEncolado nunca devuelve otra cosa que 'ok' o 'acceso_retirado' (sin filas -> acceso_retirado, falla cerrado)", async () => {
    const r = await revalidarEncolado(txFalso({ rows: [], rowCount: 0 }).tx, {
      id: FILA.id,
      clienteId: FILA.cliente_id,
      creadoPor: FILA.creado_por,
      rolesPermitidos: null,
    });
    expect(r).toBe("acceso_retirado");
  });
});
