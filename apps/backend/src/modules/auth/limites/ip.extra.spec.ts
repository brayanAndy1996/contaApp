import { describe, expect, it } from "vitest";
import { sujetoIp } from "./ip.js";

// Ramas de sujetoIp que ip.spec.ts no ejercita: IPv6 con cola IPv4 y valores que no son IP.
describe("sujetoIp: casos adicionales", () => {
  it("IPv6 con cola IPv4 comparte /64 con su equivalente en hexadecimal", () => {
    expect(sujetoIp("2001:db8:1:2:0:0:1.2.3.4")).toBe(
      sujetoIp("2001:db8:1:2:0:0:102:304"),
    );
    expect(sujetoIp("2001:db8:1:2::1.2.3.4")).toBe(sujetoIp("2001:db8:1:2::1"));
  });

  it("el prefijo es el /64 canónico", () => {
    expect(sujetoIp("2001:DB8:0:0::1")).toBe("2001:db8:0:0::/64");
  });

  it("lo que no es una IP se usa tal cual (no inventa un prefijo)", () => {
    expect(sujetoIp("no-es-ip")).toBe("no-es-ip");
    expect(sujetoIp("")).toBe("");
  });
});
