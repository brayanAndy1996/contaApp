import { describe, expect, it } from "vitest";
import { sujetoIp } from "./ip.js";

// D7 (spec 004). Contrato (plan: Decisiones: IP): sujetoIp(ip: string): string es la clave del
// límite por IP (`limite_consumir('login_ip', sujeto)`):
//   - IPv4: la dirección completa;
//   - IPv6: el prefijo /64 (todas las direcciones del mismo /64 comparten sujeto; notaciones
//     equivalentes —mayúsculas, ceros a la izquierda, "::"— dan el mismo sujeto);
//   - IPv4 mapeada en IPv6 ("::ffff:a.b.c.d"): el sujeto de la IPv4.
describe("sujetoIp: IPv4", () => {
  it("devuelve la dirección completa", () => {
    expect(sujetoIp("203.0.113.7")).toBe("203.0.113.7");
    expect(sujetoIp("10.0.0.1")).toBe("10.0.0.1");
  });

  it("direcciones distintas dan sujetos distintos, incluso vecinas", () => {
    expect(sujetoIp("203.0.113.7")).not.toBe(sujetoIp("203.0.113.8"));
  });
});

describe("sujetoIp: IPv4 mapeada en IPv6", () => {
  it("::ffff:a.b.c.d equivale a la IPv4", () => {
    expect(sujetoIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(sujetoIp("::FFFF:203.0.113.7")).toBe("203.0.113.7");
    expect(sujetoIp("::ffff:203.0.113.7")).toBe(sujetoIp("203.0.113.7"));
  });

  it("no cuenta como IPv6 /64: dos mapeadas distintas no comparten sujeto", () => {
    expect(sujetoIp("::ffff:203.0.113.7")).not.toBe(sujetoIp("::ffff:203.0.113.8"));
  });
});

describe("sujetoIp: IPv6 por prefijo /64", () => {
  it("las direcciones del mismo /64 comparten sujeto", () => {
    const a = sujetoIp("2001:db8:1:2:3:4:5:6");
    const b = sujetoIp("2001:db8:1:2:ffff:ffff:ffff:ffff");
    const c = sujetoIp("2001:db8:1:2::1");
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("un /64 distinto da otro sujeto", () => {
    expect(sujetoIp("2001:db8:1:2::1")).not.toBe(sujetoIp("2001:db8:1:3::1"));
    expect(sujetoIp("2001:db8:1:2::1")).not.toBe(sujetoIp("2001:db8:9:2::1"));
  });

  it("el último bit del prefijo (cuarto grupo) cuenta", () => {
    expect(sujetoIp("2001:db8:1:2::1")).not.toBe(sujetoIp("2001:db8:1:3::1"));
    expect(sujetoIp("2001:db8:1:ffff::1")).not.toBe(sujetoIp("2001:db8:1:fffe::1"));
  });

  it("notaciones equivalentes dan el mismo sujeto (mayúsculas, ceros, compresión)", () => {
    const base = sujetoIp("2001:db8:0:0::1");
    expect(sujetoIp("2001:DB8::1")).toBe(base);
    expect(sujetoIp("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe(base);
    expect(sujetoIp("2001:db8::ffff")).toBe(base);
  });

  it("el sujeto IPv6 indica que es un prefijo /64 y no puede confundirse con una IPv4", () => {
    const s = sujetoIp("2001:db8:1:2:3:4:5:6");
    expect(s).toMatch(/\/64$/);
    expect(s).not.toBe(sujetoIp("1.2.3.4"));
  });

  it("el loopback ::1 da un sujeto estable", () => {
    expect(sujetoIp("::1")).toBe(sujetoIp("::1"));
    expect(sujetoIp("::1").length).toBeGreaterThan(0);
  });
});
