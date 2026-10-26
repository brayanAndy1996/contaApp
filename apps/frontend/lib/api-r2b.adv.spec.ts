import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, EVENTO_ESTUDIO_DESFASADO } from "./api";
import { reiniciarSesion } from "./sesion";

// Spec 004 · ronda adversarial 2b (T17b). Cliente del frontend: el token CSRF de la sesión nunca debe
// viajar a otro origen aunque la ruta venga manipulada, y una escritura rechazada con 409 (pestaña con
// estudio desfasado, D12) no debe reenviarse sola con el estudio nuevo.

interface Llamada {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function instalar(manejar: (l: Llamada, vez: number) => { status: number; cuerpo?: unknown }) {
  const llamadas: Llamada[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (entrada: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof entrada === "string" ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
      const l = { url, method: (init?.method ?? "GET").toUpperCase(), headers };
      llamadas.push(l);
      const r = manejar(l, llamadas.length);
      return new Response(r.status === 204 ? null : JSON.stringify(r.cuerpo ?? {}), {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return llamadas;
}

const sesion = (estudio: string, csrf: string) => ({
  usuario: { id: "u-1", nombre: "Ana", correo: "ana@ejemplo.test" },
  estudioActivo: { id: estudio, nombre: estudio },
  csrf,
});

describe("lib/api · ronda adversarial 2b", () => {
  beforeEach(() => reiniciarSesion());
  afterEach(() => {
    vi.unstubAllGlobals();
    reiniciarSesion();
  });

  it("R2b-06 el CSRF nunca sale del mismo origen con rutas hostiles y un 409 no reenvía la escritura", async () => {
    // 1) Rutas manipuladas (protocol-relative, backslash, userinfo, absoluta): todo queda en /api del mismo origen.
    let llamadas = instalar((l) =>
      l.url.endsWith("/auth/sesion") ? { status: 200, cuerpo: sesion("e-A", "csrf-canario-r2b") } : { status: 200, cuerpo: {} },
    );
    for (const ruta of ["//evil.example/x", "/\\evil.example/x", "@evil.example/x", "https://evil.example/x", "/../../x"]) {
      await api(ruta, { method: "POST", body: {} });
    }
    const conCsrf = llamadas.filter((l) => l.headers["x-csrf-token"] !== undefined);
    expect(conCsrf.length).toBe(5);
    for (const l of conCsrf) {
      const destino = new URL(l.url, window.location.origin);
      // Solo se exige el mismo origen: las rutas son literales del código y `/api/../x` sigue en el
      // mismo servidor (no es una vía de fuga real).
      expect(destino.origin, `CSRF enviado a ${l.url}`).toBe(window.location.origin);
    }

    // 2) 409 en un POST: recarga la sesión y avisa, pero no repite la escritura en el estudio nuevo.
    reiniciarSesion();
    let lecturas = 0;
    llamadas = instalar((l) => {
      if (l.url.endsWith("/auth/sesion")) {
        lecturas += 1;
        return { status: 200, cuerpo: lecturas === 1 ? sesion("e-A", "csrf-A") : sesion("e-B", "csrf-B") };
      }
      return { status: 409, cuerpo: { codigo: "estudio_desfasado" } };
    });
    const evento = vi.fn();
    window.addEventListener(EVENTO_ESTUDIO_DESFASADO, evento);
    try {
      const r = await api("/clientes", { method: "POST", body: { ruc: "20100070970" } });
      expect(r.status).toBe(409);
    } finally {
      window.removeEventListener(EVENTO_ESTUDIO_DESFASADO, evento);
    }
    const escrituras = llamadas.filter((l) => l.method === "POST");
    expect(escrituras.length, "la escritura rechazada con 409 se reenvió").toBe(1);
    expect(escrituras[0]!.headers["x-estudio"]).toBe("e-A");
    expect(evento).toHaveBeenCalledTimes(1);
  });
});
