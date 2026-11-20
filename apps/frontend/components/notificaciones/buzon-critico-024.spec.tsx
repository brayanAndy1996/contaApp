import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { destinoDe, notificacionDeFila } from "../../lib/notificaciones";
import { reiniciarSesion } from "../../lib/sesion";
import {
  CLIENTE_A,
  MENSAJES_BANDEJA as B,
  PERMISOS_TODOS,
  RUTA_BANDEJA,
  detalleConAtencion,
  filaBandeja,
  paginaDeCliente,
  rutaAtencionDe,
  rutaDetalleDe,
  rutaMensajesDe,
  rutasBase,
} from "../../pruebas/bandeja";
import { uuidDe } from "../../pruebas/compras";
import { estadoCredencialDe } from "../../pruebas/credenciales";
import { instalarFetchFalso } from "../../pruebas/soporte";

vi.mock("next/navigation", async () => import("../../pruebas/navegacion"));

import { navegacion } from "../../pruebas/navegacion";
import { Bandeja } from "../buzon/bandeja";

// Spec 024 · T5 (rojo; D-14, CA-12). La campana de 023 no cambia: `buzon_critico` sigue llevando a
// `/clientes/<clienteId>/buzon?mensaje=<mensajeId>`, y esa ruta ahora es la bandeja fijada en el cliente, que abre el
// mensaje (aunque no esté en la página cargada). Atender no crea, borra ni marca notificaciones.

const MENSAJE = uuidDe(24, 61);

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const notificacion = notificacionDeFila({
  id: uuidDe(24, 62),
  tipo: "buzon_critico",
  creadaEn: "2026-11-18T12:00:00.000Z",
  leidaEn: null,
  cliente: { id: CLIENTE_A, razonSocial: "Alfa SAC" },
  trabajoId: null,
  params: { categoria: "coactiva", mensajeId: MENSAJE },
})!;

describe("campana → bandeja (D-14)", () => {
  it("el destino de `buzon_critico` sigue siendo la ruta del cliente con `?mensaje=`", () => {
    expect(destinoDe(notificacion)).toBe(`/clientes/${CLIENTE_A}/buzon?mensaje=${MENSAJE}`);
  });

  it("seguir ese destino abre el mensaje en la bandeja fijada y atenderlo no toca las notificaciones", async () => {
    const destino = destinoDe(notificacion)!;
    navegacion.reiniciar(destino);
    const f = instalarFetchFalso(
      rutasBase(PERMISOS_TODOS, {
        [rutaMensajesDe(CLIENTE_A)]: { status: 200, cuerpo: paginaDeCliente([filaBandeja({ id: uuidDe(24, 63), asunto: "Otro mensaje" })]) },
        [`GET /api/clientes/${CLIENTE_A}/credenciales`]: {
          status: 200,
          cuerpo: [estadoCredencialDe("sol", "verificada"), estadoCredencialDe("sire_api", "no_configurada")],
        },
        [rutaDetalleDe(CLIENTE_A, MENSAJE)]: {
          status: 200,
          cuerpo: detalleConAtencion({ id: MENSAJE, asunto: "Resolución de multa de la campana", categoria: "resolucion_multa" }),
        },
        [rutaAtencionDe(CLIENTE_A, MENSAJE)]: {
          status: 200,
          cuerpo: { atencion: { estado: "atendido", por: { id: uuidDe(24, 91), nombre: "Ana Prueba" }, en: "2026-11-18T15:30:00.000Z", comentario: "Listo" } },
        },
      }),
    );
    render(<Bandeja clienteFijo={{ id: CLIENTE_A, archivado: false }} />);
    expect(await screen.findByText("Resolución de multa de la campana")).toBeTruthy();
    expect(f.de(RUTA_BANDEJA)).toHaveLength(0);

    const usuario = userEvent.setup();
    await usuario.type(await screen.findByRole("textbox", { name: B.comentario }), "Listo");
    await usuario.click(screen.getByRole("button", { name: B.marcar }));
    await vi.waitFor(() => expect(f.de(rutaAtencionDe(CLIENTE_A, MENSAJE))).toHaveLength(1));
    // CA-12: atender no crea ni marca notificaciones
    expect(f.llamadas.filter((l) => l.ruta.startsWith("/api/notificaciones"))).toHaveLength(0);
  });
});
