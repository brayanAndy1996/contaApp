/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 007b T16 · ronda adversarial (caja negra, luego blanca) de la importación (D7–D9, D11; CA-1 a CA-3, CA-8).
// Solo el contrato público: HTTP, `crearApp` y las tablas. Las claves son CANARIOS sintéticos.
// Una prueba que falla es un hallazgo `H-007b-n` (tasks.md, T16); las que pasan quedan como regresión.
import { gzipSync, strFromU8, strToU8 } from "fflate";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirBancoCola,
  abrirSobreMock,
  canario,
  filtrados,
  pedirBin,
  type Actor,
  type BancoCola,
  type Estudio,
} from "../../../test/soporte-credenciales.js";
import {
  CABECERA,
  comprimir,
  filaDatos,
  partesXlsx,
  rucConPrefijo,
  xlsx,
  xlsxConDatos,
  type Celda,
  type DatosFila,
} from "../../../test/soporte-importacion.js";
import { capturarLogs, ipUnica, ORIGEN } from "../../../test/soporte.js";

const VISTA = "/clientes/importacion/vista-previa";
const CONFIRMAR = "/clientes/importacion/confirmar";

let b: BancoCola;
let serie = 500_000 + (process.pid % 997) * 1000;
const ruc = () => rucConPrefijo("20", serie++);
const rucMalo = () => {
  const bueno = ruc();
  return `${bueno.slice(0, 10)}${(Number(bueno[10]) + 1) % 10}`;
};

beforeAll(async () => {
  b = await abrirBancoCola();
});
afterAll(async () => {
  await b?.cerrar();
});

const previa = (a: Actor, bytes: Uint8Array) =>
  pedirBin(b.c.p.b.h, a, "POST", VISTA, bytes);
const confirmar = (a: Actor, bytes: Uint8Array) =>
  pedirBin(b.c.p.b.h, a, "POST", CONFIRMAR, bytes);
const porN = (xs: any[]) => Object.fromEntries(xs.map((x) => [x.n, x]));
const clientesDe = (t: string) =>
  b.sql(
    "select id, ruc, razon_social, archivado_at from cliente where tenant_id = $1 order by created_at, ruc",
    [t],
  );

/** `.xlsx` con la cabecera y las filas, y un reemplazo de texto en el XML de una parte (para entidades o `<v>` raros). */
function xlsxParcheado(
  filas: Celda[][],
  parte: string,
  cambios: [string, string][],
): Uint8Array {
  const partes = partesXlsx(filas);
  let texto = strFromU8(partes[parte]!);
  for (const [de, a] of cambios) {
    expect(texto.includes(de), `marcador ${de} en ${parte}`).toBe(true);
    texto = texto.replaceAll(de, a);
  }
  partes[parte] = strToU8(texto);
  return comprimir(partes);
}

describe("T16 · parsers y celdas peligrosas (caja negra)", () => {
  it("adv-i1: cuerpo con Content-Encoding gzip que se infla a 40 MB: 4xx rápido, nunca 500 ni consumo desmedido", async () => {
    const E: Estudio = await b.estudioCon(5);
    const bomba = gzipSync(new Uint8Array(40 * 1024 * 1024), { level: 9 });
    expect(bomba.length).toBeLessThan(200 * 1024);
    const dir = b.c.p.b.h.app.getHttpServer().address() as { port: number };
    const t0 = Date.now();
    const res = await request(`http://127.0.0.1:${dir.port}`)
      .post(VISTA)
      .set("X-Forwarded-For", ipUnica())
      .set("Cookie", E.titular.cookie)
      .set("X-CSRF-Token", E.titular.csrf)
      .set("X-Estudio", E.tenantId)
      .set("Origin", ORIGEN)
      .set("Content-Type", "application/octet-stream")
      .set("Content-Encoding", "gzip")
      .ok(() => true)
      .send(Buffer.from(bomba))
      .catch((e: { code?: string }) => ({
        status: e.code === "ECONNRESET" || e.code === "EPIPE" ? 0 : -1,
        text: "",
      }));
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect([0, 400, 413, 415], `${res.status} ${(res as any).text}`).toContain(
      res.status,
    );
    expect(await clientesDe(E.tenantId)).toHaveLength(0);
  });

  it("adv-i2: una cadena compartida enorme en la columna RUC repetida 1.000 veces no amplifica la respuesta (≤ 2 MB)", async () => {
    const E: Estudio = await b.estudioCon(5);
    const enorme = `2${"0".repeat(100 * 1024)}`;
    const filas: Celda[][] = [
      [...CABECERA],
      ...Array.from({ length: 1000 }, () => filaDatos({ ruc: enorme })),
    ];
    const archivo = xlsx(filas);
    expect(archivo.length).toBeLessThan(64 * 1024);
    const r = await previa(E.titular, archivo);
    expect(r.status, r.texto.slice(0, 200)).not.toBe(500);
    expect(r.bytes.length, "bytes de la respuesta").toBeLessThan(
      2 * 1024 * 1024,
    );
  });

  it("adv-i3: CSV injection disfrazada (espacio, NBSP, BOM, U+3000, tab, entidad &#61;) nunca deja una razón social que empiece con = + - @", async () => {
    const E: Estudio = await b.estudioCon(20);
    const variantes = [
      ' =HYPERLINK("http://x.test","y")',
      " =1+1",
      "﻿=1+1",
      "　@SUM(1)",
      "\t=1+1",
      "\r\n=1+1",
      "MARCA-ENTIDAD-1", // se reemplaza por &#61;1+1 en sharedStrings.xml
      "MARCA-ENTIDAD-2", // se reemplaza por &#x2B;1+1
    ];
    const rucs = variantes.map(() => ruc());
    const filas: Celda[][] = [
      [...CABECERA],
      ...variantes.map((v, i) => filaDatos({ ruc: rucs[i], razonSocial: v })),
    ];
    const archivo = xlsxParcheado(filas, "xl/sharedStrings.xml", [
      ["MARCA-ENTIDAD-1", "&#61;1+1"],
      ["MARCA-ENTIDAD-2", "&#x2B;1+1"],
    ]);
    const r = await confirmar(E.titular, archivo);
    expect(r.status, r.texto).toBe(200);
    const creados = await clientesDe(E.tenantId);
    const peligrosas = creados.filter((c: any) =>
      /^[=+\-@\t\r\n]/.test(c.razon_social),
    );
    expect(peligrosas.map((c: any) => JSON.stringify(c.razon_social))).toEqual(
      [],
    );
  });

  it("adv-i4: RUC numéricos raros (1e308, negativo, decimal, hexadecimal, Infinity) y dígitos Unicode: ruc_invalido, nunca 500 ni un RUC fabricado", async () => {
    const E: Estudio = await b.estudioCon(20);
    const base = ruc();
    const ancho = [...base]
      .map((d) => String.fromCharCode(0xff10 + Number(d)))
      .join("");
    const arabe = [...base]
      .map((d) => String.fromCharCode(0x0660 + Number(d)))
      .join("");
    const marcas = [900_001, 900_002, 900_003, 900_004, 900_005];
    const filas: Celda[][] = [
      [...CABECERA],
      ...marcas.map((m) => [m, "", "", "", "", "", ""] as Celda[]),
      filaDatos({ ruc: ancho }),
      filaDatos({ ruc: arabe }),
      filaDatos({ ruc: `${base}​` }),
    ];
    const archivo = xlsxParcheado(filas, "xl/worksheets/sheet1.xml", [
      ["<v>900001</v>", "<v>1e308</v>"],
      ["<v>900002</v>", `<v>-${base}</v>`],
      ["<v>900003</v>", `<v>${base}.5</v>`],
      ["<v>900004</v>", `<v>0x${BigInt(base).toString(16)}</v>`],
      ["<v>900005</v>", "<v>Infinity</v>"],
    ]);
    const r = await previa(E.titular, archivo);
    expect(r.status, r.texto).toBe(200);
    const f = porN(r.json.filas);
    for (let n = 2; n <= 9; n++) {
      expect(f[n]?.estado, `fila ${n}: ${JSON.stringify(f[n])}`).toBe("error");
      expect(f[n]?.motivos, `fila ${n}`).toContain("ruc_invalido");
    }
  });
});

describe("T16 · oráculos y alcance en la importación (caja negra)", () => {
  it("adv-i5: el correo de un miembro de OTRO estudio (incluso lectura) o de un miembro desactivado da responsable_inexistente, igual que un correo inventado", async () => {
    const E: Estudio = await b.estudioCon(20);
    const F: Estudio = await b.estudioCon(20);
    const ajenoContador = await b.c.p.b.miembro(F.tenantId, "contador", {
      sesion: false,
    });
    const ajenoLectura = await b.c.p.b.miembro(F.tenantId, "lectura", {
      sesion: false,
    });
    const desactivado = await b.c.p.b.miembro(E.tenantId, "contador", {
      sesion: false,
    });
    await b.sql(
      "update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2",
      [E.tenantId, desactivado.id],
    );
    const inventado = `nadie-${Date.now()}@ejemplo.test`;
    const correos = [
      inventado,
      ajenoContador.correo,
      ajenoLectura.correo,
      desactivado.correo,
      F.titular.correo,
    ];
    const archivo = xlsxConDatos(
      correos.map((c) => ({ ruc: ruc(), responsable: c })),
    );
    const r = await previa(E.titular, archivo);
    expect(r.status, r.texto).toBe(200);
    const motivos = r.json.filas.map((x: any) => x.motivos);
    for (const m of motivos) expect(m).toEqual(["responsable_inexistente"]);
  });

  it("adv-i6: cada sobre importado abre solo con la AAD de SU cliente y lleva SU canario, aunque haya filas repetidas, con error, existentes y excedentes en medio", async () => {
    const E: Estudio = await b.estudioCon(3);
    const existente = await b.c.sembrar(E.tenantId, {});
    const A = ruc();
    const B = ruc();
    const C = ruc();
    const k = Object.fromEntries(
      ["a", "ia", "sa", "x", "y", "e", "b", "c"].map((n) => [
        n,
        canario(`imp-${n}`),
      ]),
    );
    const datos: DatosFila[] = [
      {
        ruc: A,
        usuarioSol: "UA",
        claveSol: k.a,
        clientId: k.ia,
        clientSecret: k.sa,
      },
      { ruc: A, usuarioSol: "UX", claveSol: k.x },
      { ruc: rucMalo(), usuarioSol: "UY", claveSol: k.y },
      { ruc: existente.ruc, usuarioSol: "UE", claveSol: k.e },
      { ruc: B, usuarioSol: "UB", claveSol: k.b },
      { ruc: C, usuarioSol: "UC", claveSol: k.c },
    ];
    const { resultado: r, logs } = await capturarLogs(() =>
      confirmar(E.titular, xlsxConDatos(datos)),
    );
    expect(r.status, r.texto).toBe(200);
    expect(r.json.creadas).toBe(2);
    expect(porN(r.json.noImportadas)[7]?.motivo).toBe("cupo_rucs");
    expect(filtrados(Object.values(k), r.texto, r.headers, logs)).toEqual([]);

    const porRuc = Object.fromEntries(
      (await clientesDe(E.tenantId)).map((c: any) => [c.ruc, c.id]),
    );
    const creds = await b.sql(
      "select c.*, cl.ruc from credencial c join cliente cl on cl.id = c.cliente_id where c.tenant_id = $1",
      [E.tenantId],
    );
    const abiertos = creds.map((f: any) => ({
      ruc: f.ruc,
      tipo: f.tipo,
      plano: abrirSobreMock(f, {
        tenantId: E.tenantId,
        clienteId: f.cliente_id,
        tipo: f.tipo,
      }),
      otro: abrirSobreMock(f, {
        tenantId: E.tenantId,
        clienteId: porRuc[f.ruc === A ? B : A],
        tipo: f.tipo,
      }),
    }));
    expect(abiertos.map((x: any) => x.otro)).toEqual(abiertos.map(() => null));
    const vistos = abiertos
      .map((x: any) => `${x.ruc}:${x.tipo}:${JSON.stringify(x.plano)}`)
      .sort();
    expect(vistos).toEqual(
      [
        `${A}:sol:${JSON.stringify({ usuario: "UA", clave: k.a })}`,
        `${A}:sire_api:${JSON.stringify({ clientId: k.ia, clientSecret: k.sa })}`,
        `${B}:sol:${JSON.stringify({ usuario: "UB", clave: k.b })}`,
      ].sort(),
    );
  });
});

describe("T16 · importación concurrente contra el cupo (caja negra)", () => {
  it("adv-i7: importar y reactivar un archivado a la vez en el límite: los activos nunca pasan del máximo y nada da 500", async () => {
    for (let ronda = 0; ronda < 6; ronda++) {
      const E: Estudio = await b.estudioCon(2);
      await b.c.sembrar(E.tenantId, {});
      const archivado = await b.c.sembrar(E.tenantId, { archivado: true });
      const archivo = xlsxConDatos([{ ruc: ruc() }]);
      const [imp, react] = await Promise.all([
        confirmar(E.titular, archivo),
        b.c.p.b.llamar(
          E.titular,
          "POST",
          `/clientes/${archivado.id}/reactivar`,
        ),
      ]);
      expect(imp.status, imp.texto).toBe(200);
      expect([200, 201, 204, 409], react.text).toContain(react.status);
      expect(
        await b.c.activos(E.tenantId),
        `ronda ${ronda}`,
      ).toBeLessThanOrEqual(2);
    }
  });
});
