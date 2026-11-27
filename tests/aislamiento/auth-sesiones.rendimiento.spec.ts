// Spec 029 (T1, rojo hasta 0078) · CA-8: el guard (`sesion_validar`) y la lista de sesiones no crecen con las sesiones de OTROS usuarios.
// Se mide contra la BD real: minimo de >= 5 corridas (6) por tamano, sin tope absoluto en ms (la maquina de CI varia): lo que se protege es la
// complejidad. Una consulta que recorre `auth.sesion` entera crece ~ 20x al pasar de 2 000 a 40 000 filas ajenas; una por indice no crece. El
// volumen es el dato (no se puede tener los dos tamanos a la vez), asi que las dos fases son secuenciales y cada una toma su minimo; las
// consultas de ambas fases se intercalan (validar, listar) para ver la misma carga. No se sube un tope para que pase. Fuera de cobertura.
// Rojo por: auth.sesiones_listar y la columna auth.sesion.factor aun no existen (0078).
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EscenarioTotp, SQL, abrirAdmin, abrirApp, exito, insertarSesionesAjenas, llamar, minimoDe, tenantDe } from "./auth-totp-soporte";

let app: Pool;
let admin: Pool;
let esc: EscenarioTotp;
const ruido: string[] = [];
const CORRIDAS = 6;
const LLAMADAS = 30; // por corrida, para que el tiempo no sea ruido del reloj

beforeAll(() => {
  app = abrirApp(6);
  admin = abrirAdmin(4);
  esc = new EscenarioTotp(admin);
});
afterAll(async () => {
  for (const id of ruido) {
    await admin.query("delete from auth.sesion where usuario_id = $1", [id]).catch(() => undefined);
    await admin.query("delete from usuario where id = $1", [id]).catch(() => undefined);
  }
  await esc?.limpiar();
  await app?.end();
  await admin?.end();
});

describe("CA-8 · escala con las sesiones de otros usuarios", () => {
  it(`sesion_validar y sesiones_listar de un usuario con 5 sesiones: 40 000 sesiones ajenas no cuestan mas de 3x que 2 000 (minimo de ${CORRIDAS} corridas)`, async () => {
    const u = await esc.usuario({ estudios: [tenantDe("A")] });
    const propias = [];
    for (let i = 0; i < 5; i++) propias.push(await esc.sesionF(u.id, { factor: "verificado", tenant: tenantDe("A") }));
    const t = propias[0]!.token;

    const medir = async () => {
      const validar = await minimoDe(CORRIDAS, async () => {
        for (let i = 0; i < LLAMADAS; i++) await exito(llamar(app, SQL.validar, [t]));
      });
      const listar = await minimoDe(CORRIDAS, async () => {
        for (let i = 0; i < LLAMADAS; i++) expect(await exito(llamar(app, SQL.listar, [t]))).toHaveLength(5);
      });
      return { validar, listar };
    };

    ruido.push(await insertarSesionesAjenas(admin, 2_000));
    await admin.query("analyze auth.sesion");
    const chico = await medir();
    ruido.push(await insertarSesionesAjenas(admin, 38_000));
    await admin.query("analyze auth.sesion");
    const grande = await medir();

    // piso de 5 ms por lado: con tiempos tan chicos el ruido del reloj dominaria la razon
    const razon = (g: number, c: number) => g / Math.max(c, 5);
    expect(
      razon(grande.validar, chico.validar),
      `sesion_validar: ${chico.validar.toFixed(1)} ms -> ${grande.validar.toFixed(1)} ms por ${LLAMADAS} llamadas`,
    ).toBeLessThanOrEqual(3);
    expect(
      razon(grande.listar, chico.listar),
      `sesiones_listar: ${chico.listar.toFixed(1)} ms -> ${grande.listar.toFixed(1)} ms por ${LLAMADAS} llamadas`,
    ).toBeLessThanOrEqual(3);
  }, 240_000);
});
