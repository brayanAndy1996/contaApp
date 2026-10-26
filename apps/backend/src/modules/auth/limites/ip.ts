import { isIPv4, isIPv6 } from "node:net";

const MAPEADA = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** Expande una IPv6 válida a sus 8 grupos de 16 bits (con o sin "::" y cola IPv4). */
function gruposIPv6(ip: string): number[] {
  let texto = ip.toLowerCase();
  const cola = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(texto);
  if (cola) {
    const [a, b, c, d] = (cola[1] as string).split(".").map(Number) as [
      number,
      number,
      number,
      number,
    ];
    texto =
      texto.slice(0, cola.index) +
      ((a << 8) | b).toString(16) +
      ":" +
      ((c << 8) | d).toString(16);
  }
  const [cabeza = "", resto] = texto.split("::");
  const izq = cabeza === "" ? [] : cabeza.split(":");
  const der = resto === undefined || resto === "" ? [] : resto.split(":");
  const faltan = 8 - izq.length - der.length;
  const todos =
    resto === undefined
      ? izq
      : [...izq, ...Array<string>(faltan).fill("0"), ...der];
  return todos.map((g) => parseInt(g, 16));
}

/**
 * D7: sujeto del límite por IP. IPv4 completa; IPv4 mapeada en IPv6 = su IPv4; IPv6 por prefijo
 * /64 (rotar dentro del /64 no evade el límite). Lo que no es una IP se usa tal cual.
 */
export function sujetoIp(ip: string): string {
  const mapeada = MAPEADA.exec(ip);
  if (mapeada) return mapeada[1] as string;
  if (isIPv4(ip) || !isIPv6(ip)) return ip;
  const prefijo = gruposIPv6(ip)
    .slice(0, 4)
    .map((g) => g.toString(16));
  return `${prefijo.join(":")}::/64`;
}
