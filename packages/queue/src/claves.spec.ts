import { describe, expect, it } from "vitest";
import { claveDedupe, crearClaves, jsonCanonico } from "./index.js";

// Contrato (plan 008, packages/queue/src/claves.ts), D8, CA-15:
//  - jsonCanonico(v): JSON con las claves de CADA objeto ordenadas, sin espacios; los arreglos
//    conservan su orden. Es la base de la clave de deduplicacion.
//  - claveDedupe(tipo, clienteId, parametros): Buffer de 32 bytes (SHA-256 de tipo + cliente + JSON
//    canonico). Estable ante el orden de las claves del JSON; distinta si cambia el tipo, el
//    cliente o cualquier valor.
//  - crearClaves(prefijo = "contapp:") -> constructores de claves Redis. El prefijo se ANTEPONE tal
//    cual (incluye los dos puntos): crearClaves("p1:").pend("sire", T) === "p1:pend:sire:" + T.
//      pend(cola, tenantId)        pend:{cola}:{tenantId}      ZSET de jobId (prioridad + tiempo)
//      tenants(cola)               tenants:{cola}              conjunto de tenants con pendientes
//      cupoTenant(cola, tenantId)  cupo:{cola}:{tenantId}      ZSET jobId -> vencimiento del arriendo
//      cupoGlobal(cola)            cupo:{cola}                 ZSET jobId -> vencimiento del arriendo
//      lockRuc(canal, ruc)         lock:ruc:{canal}:{ruc}      SET NX PX
//      lider(cola)                 lider:{cola}
//      ejec(jobId)                 ejec:{jobId}
//      eventos(tenantId)           eventos:{tenantId}          pub/sub
//      tokenSire(proceso, tenantId, clienteId)  sire:token:{proceso}:{tenantId}:{clienteId}
const uuid = (n: number): string =>
  `0190a000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const C1 = uuid(1);
const C2 = uuid(2);

describe("jsonCanonico", () => {
  it("ordena las claves en todos los niveles y no deja espacios", () => {
    expect(jsonCanonico({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}',
    );
  });

  it("conserva el orden de los arreglos", () => {
    expect(jsonCanonico([3, 1, 2])).toBe("[3,1,2]");
    expect(jsonCanonico({ a: [1, 2] })).not.toBe(jsonCanonico({ a: [2, 1] }));
  });

  it("distingue tipos (1 vs '1', null vs 'null')", () => {
    expect(jsonCanonico({ a: 1 })).not.toBe(jsonCanonico({ a: "1" }));
    expect(jsonCanonico({ a: null })).not.toBe(jsonCanonico({ a: "null" }));
  });
});

describe("claveDedupe", () => {
  it("son 32 bytes (SHA-256)", () => {
    const k = claveDedupe("sire.propuesta.descargar", C1, {
      periodo: "202610",
    });
    expect(Buffer.isBuffer(k)).toBe(true);
    expect(k.length).toBe(32);
  });

  it("es estable ante el orden de las claves del JSON (tambien anidadas)", () => {
    const a = claveDedupe("sire.propuesta.descargar", C1, {
      periodo: "202610",
      opciones: { x: 1, y: [1, 2], z: { p: true, q: null } },
    });
    const b = claveDedupe("sire.propuesta.descargar", C1, {
      opciones: { z: { q: null, p: true }, y: [1, 2], x: 1 },
      periodo: "202610",
    });
    expect(a.equals(b)).toBe(true);
  });

  it("es determinista entre llamadas", () => {
    expect(
      claveDedupe("a.b", C1, { n: 1 }).equals(claveDedupe("a.b", C1, { n: 1 })),
    ).toBe(true);
  });

  it("cambia con el tipo, el cliente o cualquier valor", () => {
    const base = claveDedupe("a.b", C1, { n: 1, lista: [1, 2] });
    for (const otra of [
      claveDedupe("a.c", C1, { n: 1, lista: [1, 2] }),
      claveDedupe("a.b", C2, { n: 1, lista: [1, 2] }),
      claveDedupe("a.b", C1, { n: 2, lista: [1, 2] }),
      claveDedupe("a.b", C1, { n: 1, lista: [2, 1] }),
      claveDedupe("a.b", C1, { n: "1", lista: [1, 2] }),
      claveDedupe("a.b", C1, { n: 1, lista: [1, 2], extra: 0 }),
    ]) {
      expect(otra.equals(base)).toBe(false);
    }
  });

  it("no hay colision por concatenacion entre tipo y parametros", () => {
    const a = claveDedupe("a.b", C1, "x");
    const b = claveDedupe("a.bx", C1, "");
    expect(a.equals(b)).toBe(false);
  });
});

describe("crearClaves", () => {
  const T = uuid(7);
  const CL = uuid(8);

  it("usa el prefijo contapp: por defecto y las formas del plan", () => {
    const k = crearClaves();
    expect(k.pend("sire", T)).toBe(`contapp:pend:sire:${T}`);
    expect(k.tenants("sire")).toBe("contapp:tenants:sire");
    expect(k.cupoTenant("sire", T)).toBe(`contapp:cupo:sire:${T}`);
    expect(k.cupoGlobal("sire")).toBe("contapp:cupo:sire");
    expect(k.lockRuc("sol", "20100000001")).toBe(
      "contapp:lock:ruc:sol:20100000001",
    );
    expect(k.lider("xml")).toBe("contapp:lider:xml");
    expect(k.ejec(CL)).toBe(`contapp:ejec:${CL}`);
    expect(k.eventos(T)).toBe(`contapp:eventos:${T}`);
    expect(k.tokenSire("p1", T, CL)).toBe(`contapp:sire:token:p1:${T}:${CL}`);
  });

  it("antepone el prefijo de la prueba tal cual", () => {
    const k = crearClaves("t-abc:");
    expect(k.pend("sire", T)).toBe(`t-abc:pend:sire:${T}`);
    expect(k.lockRuc("sire", "20100000001")).toBe(
      "t-abc:lock:ruc:sire:20100000001",
    );
  });

  it("el cupo del tenant y el global son claves distintas, y el lock depende del canal", () => {
    const k = crearClaves("x:");
    expect(k.cupoTenant("sire", T)).not.toBe(k.cupoGlobal("sire"));
    expect(k.lockRuc("sire", "20100000001")).not.toBe(
      k.lockRuc("sol", "20100000001"),
    );
    expect(k.tenants("sire")).not.toBe(k.tenants("sol"));
  });
});
