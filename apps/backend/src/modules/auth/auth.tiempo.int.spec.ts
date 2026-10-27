// T7 (004) · CA-2 (umbral de tiempos, D9). Argon2 real en el piso, BD y HTTP; 200 intentos por rama
// intercalados, IP distinta por intento. Rojo: `crearApp` aun no existe (T12).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirHarness, claveCorreo, mediana, type Harness } from "../../../test/soporte.js";

let h: Harness;
beforeAll(async () => {
  h = await abrirHarness();
});
afterAll(async () => {
  await h?.cerrar();
});

const INTENTOS = 200;

describe("CA-2 · umbral de tiempos entre ramas", () => {
  it(
    "|mediana(rama) - mediana(errónea)| <= max(5 ms, 10 % de la mediana errónea) para inexistente y bloqueada",
    async () => {
      const real = await h.crearUsuario({ estudios: [] });
      const bloqueado = await h.crearUsuario({ estudios: [] });
      // Cuenta bloqueada de forma estable durante toda la medición.
      await h.sql(
        "insert into auth.intento_login (clave, fallos, ventana_inicio, bloqueado_hasta, aviso_enviado_en) values ($1, 5, now(), now() + interval '15 minutes', now()) on conflict (clave) do update set fallos = 5, ventana_inicio = now(), bloqueado_hasta = now() + interval '15 minutes', aviso_enviado_en = now()",
        [claveCorreo(bloqueado.correo)],
      );

      const tiempos = { inexistente: [] as number[], erronea: [] as number[], bloqueada: [] as number[] };
      const claveReal = claveCorreo(real.correo);
      // Calentamiento (JIT, pool de conexiones, Argon2).
      for (let i = 0; i < 8; i++) {
        await h.login(h.correoInexistente(), "Contrasena-cualquiera-1");
        await h.login(real.correo, "Contrasena-equivocada-1");
        await h.login(bloqueado.correo, bloqueado.contrasena);
      }
      for (let i = 0; i < INTENTOS; i++) {
        // El contador de la cuenta "errónea" se reinicia fuera del tiempo medido.
        await h.sql("delete from auth.intento_login where clave = $1", [claveReal]);
        const orden = [i % 3, (i + 1) % 3, (i + 2) % 3];
        for (const rama of orden) {
          if (rama === 0) {
            const r = await h.login(h.correoInexistente(), "Contrasena-cualquiera-1");
            expect(r.status).toBe(401);
            tiempos.inexistente.push(r.ms);
          } else if (rama === 1) {
            const r = await h.login(real.correo, "Contrasena-equivocada-1");
            expect(r.status).toBe(401);
            tiempos.erronea.push(r.ms);
          } else {
            const r = await h.login(bloqueado.correo, bloqueado.contrasena);
            expect(r.status).toBe(401);
            tiempos.bloqueada.push(r.ms);
          }
        }
      }
      const base = mediana(tiempos.erronea);
      const umbral = Math.max(5, base * 0.1);
      expect(Math.abs(mediana(tiempos.inexistente) - base)).toBeLessThanOrEqual(umbral);
      expect(Math.abs(mediana(tiempos.bloqueada) - base)).toBeLessThanOrEqual(umbral);
    },
    600_000,
  );

  it("el envío del correo de bloqueo (retenido) no altera la respuesta del 5.º fallo", async () => {
    const u = await h.crearUsuario({ estudios: [] });
    h.correo.retenido = true;
    try {
      const t0 = Date.now();
      for (let i = 0; i < 5; i++) await h.login(u.correo, `incorrecta-${i}-Zz`);
      expect(Date.now() - t0).toBeLessThan(5000); // el envío colgado no bloquea la petición
    } finally {
      h.correo.liberar();
    }
  });
});
