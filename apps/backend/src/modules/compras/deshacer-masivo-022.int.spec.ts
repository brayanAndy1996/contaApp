/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 022 (T9, RP-5, CA-12): parte del servidor del Ctrl+Z masivo. El contrato HTTP no cambia (P-3 = a): `POST …/deshacer` de
// una masiva de 4.850 filas responde en ≤ 1.200 ms (límite de regresión; mediana de 3, sin instrumentar) y deja exactamente lo mismo que antes en la BD
// (versiones, puntero vigente, evaluación 1 y hallazgos de cada versión nueva, operación). La prueba de equivalencia usa más de
// un lote de 500 filas y mezcla filas con y sin hallazgos. Medir en una BD recién creada (el INSERT de hallazgos se degrada en
// una reutilizada: plan 022, «Perfilado (T1)»).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoCompras,
  base,
  type Actor,
  type BancoCompras,
  type Estudio,
} from "../../../test/soporte-compras.js";
import { BAJO_COBERTURA, medirMediana } from "../../../test/tiempos.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 120_000 });

/** Vigila la regresión de la llamada (sin la recarga ni el render del frontend). Decisión del usuario (2026-11-13, spec 022, P-3 revisada):
 * la meta de 550 ms no se alcanza (queda SQL por fila: FK, índices, triggers, `uuid_v7()`); se acepta ~1,5 s de total y este límite
 * pasa a guardar contra regresiones: ≤ 1.200 ms. */
const META_DESHACER_MS = 1_200;

let v: BancoCompras;
let E: Estudio;
let contador: Actor;

beforeAll(async () => {
  v = await abrirBancoCompras();
  E = await v.estudio();
  contador = await v.b.c.p.b.miembro(E.tenantId, "contador");
});
afterAll(async () => {
  await v?.cerrar();
});

const items = (ids: string[], versionBase: number) => ids.map((compraId) => ({ compraId, versionBase }));
const nuevoCliente = () => v.cliente(E, { responsable: contador.id });

/** Lo que la BD guarda de las filas de un cliente, sin ids ni fechas (el id de la compra se sustituye por su posición). */
async function foto(clienteId: string): Promise<Record<string, unknown>[]> {
  return v.b.sql(
    `with c as (select id, row_number() over (order by clave) as pos, version_vigente from compra where cliente_id = $1)
     select c.pos::int as pos, c.version_vigente::int as vigente,
       (select jsonb_agg(to_jsonb(x) order by x.n) from (select n, bi_dg::text, igv_dg::text, bi_dgng::text, igv_dgng::text, bi_dng::text,
          igv_dng::text, no_gravado::text, isc::text, icbper::text, otros_tributos::text, total::text, excluida, motivo, clasificada, accion
          from compra_version where compra_id = c.id) x) as versiones,
       (select jsonb_agg(to_jsonb(x) order by x.version_n, x.n) from (select version_n, n, documento_xml_id from compra_evaluacion
          where compra_id = c.id) x) as evaluaciones,
       (select jsonb_agg(to_jsonb(x) order by x.version_n, x.evaluacion_n, x.regla) from (select version_n, evaluacion_n, regla, sugerencia,
          lecturas, requiere_confirmacion from compra_hallazgo where compra_id = c.id) x) as hallazgos
     from c order by c.pos`,
    [clienteId],
  );
}

describe("RP-5 · deshacer una masiva (servidor)", () => {
  it("escribe lo mismo que antes: versiones, puntero, evaluación 1 y hallazgos; rehacer lo repone", async () => {
    const c = await nuevoCliente();
    const n = 1_230; // 3 lotes de 500
    const ids = await v.sembrarVolumen(E.tenantId, c.id, n, { usuarioId: E.titular.id });
    const pe = base(c.id);
    const m = await v.llamar(contador, "POST", `${pe}/masivas/clasificar`, { items: items(ids, 1), destino: "DNG" });
    expect(m.status, m.text).toBe(200);
    expect(m.body.aplicadas).toBe(n);
    const trasMasiva = await foto(c.id);

    const d = await v.llamar(contador, "POST", `${pe}/deshacer`, {});
    expect(d.status, d.text).toBe(200);
    expect(d.body.filas).toHaveLength(n);
    const trasDeshacer = await foto(c.id);
    expect(trasDeshacer).toHaveLength(n);
    for (let i = 0; i < n; i++) {
      const antes = trasMasiva[i] as any;
      const ahora = trasDeshacer[i] as any;
      expect(ahora.vigente, `fila ${i}`).toBe(3);
      const [v1, , v3] = ahora.versiones;
      // La versión nueva copia los valores de la anterior a la masiva y lleva la acción `deshacer`.
      expect({ ...v3, n: undefined, accion: undefined }, `fila ${i}`).toEqual({ ...v1, n: undefined, accion: undefined });
      expect(v3.accion).toBe("deshacer");
      // Lo anterior queda intacto (la historia no se toca).
      expect(ahora.versiones.slice(0, 2)).toEqual(antes.versiones);
      // Cada versión nueva tiene su evaluación 1 y los hallazgos de las anteriores no cambian.
      expect(ahora.evaluaciones.filter((e: any) => e.version_n === 3)).toEqual([{ version_n: 3, n: 1, documento_xml_id: null }]);
      expect((ahora.hallazgos ?? []).filter((h: any) => h.version_n < 3)).toEqual(antes.hallazgos ?? []);
      expect((ahora.hallazgos ?? []).every((h: any) => h.evaluacion_n === 1)).toBe(true);
    }
    // La evaluación de una fila deshecha es la de la fila original: mismos hallazgos que la versión 1 de una fila gemela.
    const hallazgosDe3 = (r: any) => JSON.stringify((r.hallazgos ?? []).filter((h: any) => h.version_n === 3).map((h: any) => [h.regla, h.sugerencia, h.lecturas, h.requiere_confirmacion]));
    expect(new Set(trasDeshacer.map(hallazgosDe3)).size).toBe(1);
    const ops = await v.operaciones(c.id);
    expect(ops.map((o: any) => [o.tipo, o.estado])).toEqual([["clasificar", "deshecha"], ["deshacer", "vigente"]]);

    const r = await v.llamar(contador, "POST", `${pe}/rehacer`, {});
    expect(r.status, r.text).toBe(200);
    expect(r.body.filas).toHaveLength(n);
    const trasRehacer = (await foto(c.id)) as any[];
    expect(trasRehacer.every((f) => f.vigente === 4 && f.versiones[3].clasificada === true)).toBe(true);
  });

  it("deshacer de 4.850 filas responde en ≤ 1.200 ms (mediana de 3, CA-12)", async () => {
    const c = await nuevoCliente();
    const ids = await v.sembrarVolumen(E.tenantId, c.id, 4_850, { usuarioId: E.titular.id });
    const pe = base(c.id);
    let versionBase = 1;
    const llamada = async (): Promise<number> => {
      const m = await v.llamar(contador, "POST", `${pe}/masivas/clasificar`, { items: items(ids, versionBase), destino: "DNG" });
      expect(m.status, m.text.slice(0, 200)).toBe(200);
      const t0 = performance.now();
      const d = await v.llamar(contador, "POST", `${pe}/deshacer`, {});
      const ms = performance.now() - t0;
      expect(d.status, d.text.slice(0, 200)).toBe(200);
      expect(d.body.filas).toHaveLength(4_850);
      versionBase += 2;
      return ms;
    };
    const mediana = await medirMediana(llamada, 3);
    if (BAJO_COBERTURA) {
      console.info(`CA-12 bajo cobertura (no se compara): deshacer de 4.850 = ${mediana.toFixed(0)} ms`);
      return;
    }
    console.info(`RP-5 deshacer de 4.850 filas (mediana de 3): ${mediana.toFixed(0)} ms`);
    expect(mediana, "POST deshacer de 4.850 filas (mediana de 3)").toBeLessThanOrEqual(META_DESHACER_MS);
  });
});
