import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENTO_ESTUDIO_DESFASADO, api } from "./api";
import { reiniciarSesion } from "./sesion";
import { instalarFetchFalso, sesionDe } from "../pruebas/soporte";

// Contrato (plan 005, Frontend; CA-10, CA-2, D15): 005 introduce 409 que NO son un estudio desfasado
// (`ultimo_dueno`, `ya_es_miembro`, `invitacion_existente`, `cupo_usuarios`, `miembro_no_asignable`,
// `requiere_sesion`). `api()` solo recarga la sesión y emite `contapp:estudio-desfasado` cuando el
// 409 trae `codigo: "estudio_desfasado"` (004); en los demás devuelve el 409 tal cual, sin avisar a
// otras pestañas ni recargar la sesión.

const ESTUDIO = { id: "e-1", nombre: "Estudio Uno" };

describe("lib/api · 409 de 005", () => {
  beforeEach(() => {
    reiniciarSesion();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    "ultimo_dueno",
    "ya_es_miembro",
    "invitacion_existente",
    "cupo_usuarios",
    "miembro_no_asignable",
    "requiere_sesion",
  ])(
    "409 %s: devuelve el 409 sin recargar la sesión ni emitir el aviso de estudio desfasado",
    async (codigo) => {
      const f = instalarFetchFalso({
        "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(ESTUDIO) },
        "POST /api/usuarios/u-1/desactivar": {
          status: 409,
          cuerpo: { codigo },
        },
      });
      const avisos: Event[] = [];
      const oyente = (e: Event) => avisos.push(e);
      window.addEventListener(EVENTO_ESTUDIO_DESFASADO, oyente);
      try {
        const r = await api("/usuarios/u-1/desactivar", { method: "POST" });
        expect(r.status).toBe(409);
        expect(r.ok).toBe(false);
        expect(r.datos).toEqual({ codigo });
        expect(f.de("GET /api/auth/sesion")).toHaveLength(1);
        expect(avisos).toHaveLength(0);
      } finally {
        window.removeEventListener(EVENTO_ESTUDIO_DESFASADO, oyente);
      }
    },
  );
});
