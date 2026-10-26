// Sesión del usuario en memoria (spec 004). La cookie es HttpOnly: el navegador nunca la lee; solo
// se guarda lo que entrega GET /api/auth/sesion (usuario, estudio activo y token CSRF derivado).

export interface Sesion {
  usuario: { id: string; nombre: string; correo: string };
  estudioActivo: { id: string; nombre: string } | null;
  csrf: string;
}

let guardada: Sesion | null = null;
let pendiente: Promise<Sesion | null> | null = null;
let generacion = 0;

async function cargar(): Promise<Sesion | null> {
  const mia = generacion;
  const respuesta = await fetch("/api/auth/sesion", {
    credentials: "same-origin",
  });
  if (respuesta.status === 401) return null;
  if (!respuesta.ok) throw new Error("No se pudo leer la sesión");
  const sesion = (await respuesta.json()) as Sesion;
  if (mia === generacion) guardada = sesion;
  return sesion;
}

/** Devuelve la sesión (de memoria si ya se leyó); `forzar` la vuelve a pedir. 401 → `null`. */
export async function obtenerSesion(forzar = false): Promise<Sesion | null> {
  if (!forzar) {
    if (guardada) return guardada;
    if (pendiente) return pendiente;
  }
  const peticion = cargar().finally(() => {
    if (pendiente === peticion) pendiente = null;
  });
  pendiente = peticion;
  return peticion;
}

/** Vacía el caché (login, logout, cambio de estudio, 401). */
export function reiniciarSesion(): void {
  generacion += 1;
  guardada = null;
  pendiente = null;
}
