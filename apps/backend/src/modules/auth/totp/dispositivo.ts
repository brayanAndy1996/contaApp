// Spec 029 (U6, CA-5). Resumen del dispositivo (lista cerrada) e IP truncada. Puro: sin IO.
// Nunca se guarda ni se muestra texto del User-Agent ni la parte de host de la IP.

type Navegador = "Chrome" | "Firefox" | "Safari" | "Edge" | "Opera";
type SistemaOperativo = "Windows" | "macOS" | "Linux" | "Android" | "iOS";

function navegador(ua: string): Navegador | null {
  if (/\bEdg(?:e|A|iOS)?\//.test(ua)) return "Edge";
  if (/\bOPR\/|\bOpera\b/.test(ua)) return "Opera";
  if (/\bFirefox\/|\bFxiOS\//.test(ua)) return "Firefox";
  if (/\bChrome\/|\bCriOS\//.test(ua)) return "Chrome";
  if (/\bVersion\/[\d.]+[^]*\bSafari\//.test(ua)) return "Safari";
  return null;
}

function sistema(ua: string): SistemaOperativo | null {
  if (/\b(?:iPhone|iPad|iPod)\b/.test(ua)) return "iOS";
  if (/\bAndroid\b/.test(ua)) return "Android";
  if (/\bWindows NT\b/.test(ua)) return "Windows";
  if (/\bMacintosh\b|\bMac OS X\b/.test(ua)) return "macOS";
  if (/\bLinux\b|\bX11\b/.test(ua)) return "Linux";
  return null;
}

/** «<Navegador> en <SO>» de una lista cerrada o «Otro». ≤ 60 caracteres. */
export function resumirDispositivo(userAgent: unknown): string {
  if (typeof userAgent !== "string") return "Otro";
  const nav = navegador(userAgent);
  const so = sistema(userAgent);
  return nav !== null && so !== null ? `${nav} en ${so}` : "Otro";
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const MAPEADA = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

function octetosIpv4(ip: string): number[] | null {
  const m = IPV4.exec(ip);
  if (!m) return null;
  const octetos = m.slice(1).map((o) => (o.length > 1 && o.startsWith("0") ? NaN : Number(o)));
  return octetos.every((o) => o >= 0 && o <= 255) ? octetos : null;
}

/** Ocho grupos de 16 bits de una IPv6 (sin sufijo IPv4), o `null` si no es válida. */
function gruposIpv6(ip: string): number[] | null {
  if (!/^[0-9a-fA-F:]+$/.test(ip)) return null;
  const mitades = ip.split("::");
  if (mitades.length > 2) return null;
  const parsear = (texto: string): number[] | null => {
    if (texto === "") return [];
    const grupos = texto.split(":");
    if (grupos.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
    return grupos.map((g) => parseInt(g, 16));
  };
  const cabeza = parsear(mitades[0]!);
  if (cabeza === null) return null;
  if (mitades.length === 1) return cabeza.length === 8 ? cabeza : null;
  const cola = parsear(mitades[1]!);
  if (cola === null || cabeza.length + cola.length > 7) return null;
  return [
    ...cabeza,
    ...Array<number>(8 - cabeza.length - cola.length).fill(0),
    ...cola,
  ];
}

/** IPv4 → `a.b.c.0/24`; IPv6 → primeros 3 grupos canónicos + `::/48`; inválida o no cadena → `null`. */
export function truncarIp(ip: unknown): string | null {
  if (typeof ip !== "string") return null;
  const mapeada = MAPEADA.exec(ip);
  const v4 = octetosIpv4(mapeada ? mapeada[1]! : ip);
  if (v4) return `${v4[0]}.${v4[1]}.${v4[2]}.0/24`;
  const grupos = gruposIpv6(ip);
  if (grupos === null) return null;
  const primeros = grupos.slice(0, 3);
  while (primeros.length > 0 && primeros[primeros.length - 1] === 0) primeros.pop();
  return `${primeros.map((g) => g.toString(16)).join(":")}::/48`;
}
