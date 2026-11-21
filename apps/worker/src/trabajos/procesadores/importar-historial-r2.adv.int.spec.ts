import type { ContappDb } from "@contapp/db";
import { aprenderDeHistorial, type FilaHistorial } from "@contapp/domain";
import type { FilaPropuestaSire } from "@contapp/sunat";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { arrancar007b, esperarTerminal } from "../../../test/procesadores-007b.js";
import {
  PERIODOS_6,
  SireRegistroControlado,
  candidatasDe,
  crearDirFixtures,
  encolarImportacion,
  filaRegistro,
  importacionDe,
  iniciarImportacion,
  limpiarAprendizaje,
  rucProveedor,
  type DirFixtures,
} from "../../../test/importar-historial.js";
import { limpiarReglas } from "../../../test/reglas.js";
import { limpiarCompras } from "../../../test/compras.js";
import { Escenario, conectarRedis, crearDbAdmin, crearDbRol, fijarConfig, limpiarPrefijo, nuevoPrefijo, restaurarConfig } from "../../../test/trabajos.js";
import { mundoVentas } from "../../../test/ventas.js";
import { esCandidataGuardable } from "./importar-historial.js";

// Spec 025 · T18 (ronda adversarial 2), integración con PostgreSQL y Redis reales: el dominio y `reglas_importacion_completar` (0064)
// deben coincidir en el umbral y en la gramática. Un conjunto con el 80 % exacto, notas de crédito por el máximo de NUMERIC(14,2),
// razones sociales hostiles (bidi, saltos de línea, `|`, 10.000 caracteres), tipos de documento raros y documentos que la BD no
// admite: la importación se completa y guarda EXACTAMENTE lo que deduce el dominio (ni una candidata de más ni de menos).

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

let admin: ContappDb;
let backend: ContappDb;
let redis: Redis;
let e: Escenario;
let fx: DirFixtures;
const prefijo = nuevoPrefijo();

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  redis = conectarRedis();
  e = new Escenario(admin);
  fx = crearDirFixtures();
  await fijarConfig(admin, "sire", { global: 4, tenant: 2, espera: 0, reintentos: 1, base: 100 });
});

afterAll(async () => {
  await restaurarConfig(admin).catch(() => undefined);
  await limpiarAprendizaje(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarReglas(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarCompras(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  await limpiarPrefijo(redis, prefijo).catch(() => undefined);
  redis?.disconnect();
  fx?.limpiar();
  await Promise.all([backend?.close(), admin?.close()]);
});

/** Lo mismo que el procesador hace con cada fila (D-2). */
const aHistorial = (f: FilaPropuestaSire, periodo: string): FilaHistorial => ({
  periodo,
  tipoDocProveedor: typeof f.tipoDocContraparte === "string" ? f.tipoDocContraparte : null,
  numeroDocProveedor: f.rucContraparte,
  razonSocial: typeof f.razonSocialContraparte === "string" ? f.razonSocialContraparte : null,
  tipoComprobante: f.tipo,
  biDg: f.biDg,
  biDgng: f.biDgng,
  biDng: f.biDng,
});

describe("T18 · dominio y 0064 coinciden (umbral y gramática)", () => {
  it("ADV2-14 bordes del umbral, montos extremos, razones hostiles y tipos raros: se guarda exactamente lo que deduce el dominio", async () => {
    const m = await mundoVentas(e, backend);
    const r = (n: number) => rucProveedor(900 + n);
    let k = 0;
    const porPeriodo = new Map<string, FilaPropuestaSire[]>();
    for (const [i, p] of PERIODOS_6.entries()) {
      const f = (o: Omit<Parameters<typeof filaRegistro>[0], "periodo" | "numero">) =>
        filaRegistro({ periodo: p, numero: String(++k), ...o });
      const filas: FilaPropuestaSire[] = [
        // 80 % exacto en el total (4 de 5 a lo largo de los periodos), y 79 % (no llega).
        ...(i < 4 ? [f({ ruc: r(1), destino: "DG" })] : i === 4 ? [f({ ruc: r(1), destino: "DGNG" })] : []),
        ...(i < 3 ? [f({ ruc: r(2), destino: "DNG" })] : i < 5 ? [f({ ruc: r(2), destino: "MIXTA" })] : []),
        // Notas de crédito por el máximo de NUMERIC(14,2).
        f({ ruc: r(3), destino: "DG", base: "999999999999.99", igv: "0.00", negativa: i % 2 === 0, tipo: i % 2 === 0 ? "07" : "01" }),
        // Razones sociales hostiles (la del periodo más reciente gana).
        f({ ruc: r(4), destino: "DGNG", razon: `‮${"Ñ|".repeat(5000)}\n\r⁦${p}` }),
        f({ ruc: r(5), destino: "DNG", razon: "\u0000\u0001‏؜﻿  \t\n" }),
        // Tipos raros: DNI, minúsculas con espacios Unicode, «--», tipo de dos caracteres y RUC de 10 dígitos.
        f({ ruc: "12345678", tipoDoc: "1", destino: "DG" }),
        f({ ruc: " ab-1234　", tipoDoc: " z ", destino: "DG" }),
        f({ ruc: "--", tipoDoc: "0", destino: "DG" }),
        f({ ruc: "20100070970", tipoDoc: "06", destino: "DG" }),
        f({ ruc: "2010007097", destino: "DG" }),
      ];
      porPeriodo.set(p, filas);
    }
    fx.registro(m.c.ruc, porPeriodo);
    const esperadas = aprenderDeHistorial([...porPeriodo].flatMap(([p, fs]) => fs.map((x) => aHistorial(x, p))))
      .candidatas.filter(esCandidataGuardable)
      .map((c) => ({
        doc_tipo: c.proveedor.tipo,
        doc_numero: c.proveedor.numero,
        razon_social: c.razonSocial,
        destino_propuesto: c.destino,
        n_dg: c.conteos.DG,
        n_dgng: c.conteos.DGNG,
        n_dng: c.conteos.DNG,
        n_mixto: c.conteos.mixto,
        n_total: c.conteos.total,
        periodos_con_proveedor: c.periodosConProveedor,
      }));
    // Control del conjunto: los bordes del umbral quedan como se espera.
    expect(esperadas.find((x) => x.doc_numero === r(1))?.destino_propuesto).toBe("DG");
    expect(esperadas.find((x) => x.doc_numero === r(2))?.destino_propuesto).toBeNull();

    const api = new SireRegistroControlado(fx.dir);
    const proc = await arrancar007b({ prefijo, sireApi: api } as Parameters<typeof arrancar007b>[0]);
    try {
      const importacionId = await iniciarImportacion(backend, m, PERIODOS_6);
      const trabajoId = await encolarImportacion(backend, redis, prefijo, m, importacionId);
      const t = await esperarTerminal(e, trabajoId, 60_000);
      expect([t.estado, t.motivo]).toEqual(["completado", null]);
      expect(await importacionDe(admin, importacionId)).toMatchObject({ estado: "completada", candidatas: esperadas.length });
      const guardadas = (await candidatasDe(admin, { importacionId })).map((c) => ({
        doc_tipo: c.doc_tipo,
        doc_numero: c.doc_numero,
        razon_social: c.razon_social,
        destino_propuesto: c.destino_propuesto,
        n_dg: c.n_dg,
        n_dgng: c.n_dgng,
        n_dng: c.n_dng,
        n_mixto: c.n_mixto,
        n_total: c.n_total,
        periodos_con_proveedor: c.periodos_con_proveedor,
      }));
      const orden = (xs: typeof esperadas) => [...xs].sort((a, b) => `${a.doc_tipo}:${a.doc_numero}`.localeCompare(`${b.doc_tipo}:${b.doc_numero}`));
      expect(orden(guardadas)).toEqual(orden(esperadas));
    } finally {
      await proc.detener({ esperaMs: 2000 });
    }
  });
});
