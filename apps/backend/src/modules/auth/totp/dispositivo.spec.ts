import { describe, expect, it } from "vitest";
import { resumirDispositivo, truncarIp } from "./dispositivo.js";

// Spec 029 (U6, CA-5). Contrato de `totp/dispositivo.ts` (puro):
//   resumirDispositivo(userAgent: unknown): string
//       // lista cerrada «<Navegador> en <SO>» con Navegador ∈ {Chrome, Firefox, Safari, Edge, Opera} y
//       // SO ∈ {Windows, macOS, Linux, Android, iOS}; si no se reconocen ambos, «Otro». ≤ 60 caracteres.
//       // Nunca devuelve texto del User-Agent (ni versiones). iPhone/iPad = iOS; Android gana a Linux.
//   truncarIp(ip: unknown): string | null
//       // IPv4 → «a.b.c.0/24»; IPv6 → primeros 3 grupos en forma canónica (RFC 5952) + «::/48»;
//       // IPv4 mapeada en IPv6 (::ffff:a.b.c.d) → como IPv4; entrada inválida o no cadena → null.
const CERRADA =
  /^(Otro|(Chrome|Firefox|Safari|Edge|Opera) en (Windows|macOS|Linux|Android|iOS))$/;

const UA = {
  chromeWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  edgeWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
  operaWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/110.0.0.0",
  firefoxLinux:
    "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
  firefoxWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
  firefoxMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  chromeLinux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  firefoxAndroid:
    "Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  safariIpad:
    "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
};

describe("resumirDispositivo: lista cerrada (U6)", () => {
  it.each([
    ["chromeWin", "Chrome en Windows"],
    ["edgeWin", "Edge en Windows"],
    ["operaWin", "Opera en Windows"],
    ["firefoxLinux", "Firefox en Linux"],
    ["firefoxWin", "Firefox en Windows"],
    ["firefoxMac", "Firefox en macOS"],
    ["safariMac", "Safari en macOS"],
    ["chromeMac", "Chrome en macOS"],
    ["chromeLinux", "Chrome en Linux"],
    ["chromeAndroid", "Chrome en Android"],
    ["firefoxAndroid", "Firefox en Android"],
    ["safariIphone", "Safari en iOS"],
    ["safariIpad", "Safari en iOS"],
  ] as const)("%s → %s", (clave, esperado) => {
    expect(resumirDispositivo(UA[clave])).toBe(esperado);
  });

  it.each([
    ["curl", "curl/8.4.0"],
    [
      "bot",
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    ],
    ["vacío", ""],
    ["solo Mozilla", "Mozilla/5.0"],
    ["navegador sin SO", "Chrome/126.0.0.0"],
    ["SO sin navegador", "Windows NT 10.0"],
    ["cliente propio", "ContApp-Movil/1.0 (Windows)"],
  ])("no reconocido (%s) → «Otro»", (_n, ua) => {
    expect(resumirDispositivo(ua)).toBe("Otro");
  });

  it.each([[undefined], [null], [42], [{}], [["Chrome"]]])(
    "un valor que no es cadena (%j) → «Otro»",
    (v) => {
      expect(resumirDispositivo(v)).toBe("Otro");
    },
  );

  it("nunca refleja texto del User-Agent: HTML, saltos de línea o texto largo", () => {
    const hostiles = [
      "<script>alert(1)</script>",
      "Chrome/126 (Windows NT 10.0)\r\nSet-Cookie: x=1",
      `${UA.chromeWin} ${"A".repeat(10_000)}`,
      "' OR 1=1 --",
      "Firefox/127 (X11; Linux) \u0000‮",
      `${"Mozilla/5.0 ".repeat(2000)}`,
    ];
    for (const ua of hostiles) {
      const r = resumirDispositivo(ua);
      expect(r).toMatch(CERRADA);
      expect(r.length).toBeLessThanOrEqual(60);
    }
  });

  it("fuzz determinista: 2000 combinaciones de fragmentos siempre caen en la lista cerrada", () => {
    const trozos = [
      "Mozilla/5.0",
      "Windows NT 10.0",
      "Macintosh",
      "Mac OS X",
      "Linux",
      "Android 14",
      "iPhone",
      "iPad",
      "Chrome/126",
      "Firefox/127",
      "Safari/605",
      "Edg/126",
      "OPR/110",
      "Version/17",
      "<b>",
      "\n",
      "ñ",
      "%00",
      "x".repeat(200),
    ];
    let semilla = 12345;
    const azar = (n: number) => {
      semilla = (semilla * 1103515245 + 12345) & 0x7fffffff;
      return semilla % n;
    };
    for (let i = 0; i < 2000; i++) {
      const ua = Array.from(
        { length: 1 + azar(8) },
        () => trozos[azar(trozos.length)],
      ).join(" ");
      expect(resumirDispositivo(ua)).toMatch(CERRADA);
    }
  });
});

describe("truncarIp: /24 y /48 antes de guardar (U6)", () => {
  it.each([
    ["203.0.113.77", "203.0.113.0/24"],
    ["10.1.2.3", "10.1.2.0/24"],
    ["255.255.255.255", "255.255.255.0/24"],
    ["0.0.0.0", "0.0.0.0/24"],
    ["::ffff:203.0.113.77", "203.0.113.0/24"],
  ])("IPv4 %s → %s", (ip, esperado) => {
    expect(truncarIp(ip)).toBe(esperado);
  });

  it.each([
    ["2001:db8:abcd:1234:5678:9abc:def0:1234", "2001:db8:abcd::/48"],
    ["2001:db8:abcd:1234::1", "2001:db8:abcd::/48"],
    ["2001:DB8:ABCD:1::1", "2001:db8:abcd::/48"],
    ["2001:0db8:00ab:0001::1", "2001:db8:ab::/48"],
    ["2001:db8::1", "2001:db8::/48"],
    ["2001:db8:0:5::1", "2001:db8::/48"],
    ["::1", "::/48"],
    ["fe80:1:2:3:4:5:6:7", "fe80:1:2::/48"],
  ])("IPv6 %s → %s", (ip, esperado) => {
    expect(truncarIp(ip)).toBe(esperado);
  });

  it("no conserva la parte de host (último octeto ni los últimos 80 bits)", () => {
    expect(truncarIp("198.51.100.231")).not.toContain("231");
    expect(truncarIp("2001:db8:abcd:1234:5678:9abc:def0:1234")).not.toMatch(
      /1234|5678|9abc|def0/,
    );
  });

  it.each([
    [""],
    ["   "],
    ["1.2.3"],
    ["1.2.3.4.5"],
    ["256.1.1.1"],
    ["1.2.3.-4"],
    ["a.b.c.d"],
    ["1.2.3.4/24"],
    ["2001:db8:::1"],
    ["2001:db8:abcd:1234:5678:9abc:def0:1234:1"],
    ["gggg::1"],
    ["203.0.113.77\n"],
    ["203.0.113.77, 10.0.0.1"],
    ["<script>"],
    ["' OR 1=1"],
  ])("inválida %j → null", (ip) => {
    expect(truncarIp(ip)).toBeNull();
  });

  it.each([[undefined], [null], [42], [{}], [["1.2.3.4"]]])(
    "no cadena (%j) → null",
    (v) => {
      expect(truncarIp(v)).toBeNull();
    },
  );
});
