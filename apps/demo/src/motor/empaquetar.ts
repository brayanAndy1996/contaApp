// Versión de navegador de packages/sunat/src/formatos/empaquetar.ts: mismo ZIP (fflate 0.8.2,
// una sola entrada, nivel 6) y SHA-256 en hex, pero con Web Crypto en lugar de node:crypto.
import { zipSync } from "fflate";

async function sha256(bytes: Uint8Array): Promise<string> {
  const copia = new Uint8Array(bytes);
  const h = await crypto.subtle.digest("SHA-256", copia.buffer);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface Empaquetado {
  zip: Uint8Array;
  nombreZip: string;
  sha256Txt: string;
  sha256Zip: string;
}

export async function empaquetar(txt: Uint8Array, nombres: { nombreTxt: string; nombreZip: string }): Promise<Empaquetado> {
  const zip = zipSync({ [nombres.nombreTxt]: [txt, { level: 6, mtime: new Date() }] });
  return { zip, nombreZip: nombres.nombreZip, sha256Txt: await sha256(txt), sha256Zip: await sha256(zip) };
}

export function aBase64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

export function deBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function descargar(nombre: string, datos: Uint8Array | string, tipo = "application/octet-stream") {
  const blob = new Blob([typeof datos === "string" ? datos : new Uint8Array(datos)], { type: tipo });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
