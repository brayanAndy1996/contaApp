// Levanta la pila antes de la suite (spec 018, D-2 y D-3): BD `contapp_e2e` migrada dos veces y sembrada,
// índice de Redis vacío, y backend, worker y frontend en mock. Si algo falla, apaga lo que arrancó, borra
// la BD que creó esta corrida y el directorio temporal, y devuelve el error original.
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { borrarBd, crearBd, ejecutarCliDb, vaciarIndiceRedis } from "./bd.js";
import {
  PUERTO_BACKEND,
  PUERTO_FRONTEND,
  RAIZ,
  URL_BACKEND,
  URL_FRONTEND,
  cargarDotenv,
  entornoDeLaPila,
  leerConfig,
  type ConfigE2E,
} from "./entorno.js";
import {
  apagarProcesos,
  arrancarProceso,
  comprobarPuertoLibre,
  esperarListo,
  esperarWorker,
  guardarEstado,
  respondeCon,
  type EstadoPila,
  type Proceso,
} from "./procesos.js";

function registrar(estado: EstadoPila, proceso: Proceso): Proceso {
  estado.procesos.push({
    nombre: proceso.nombre,
    pid: proceso.pid,
    log: proceso.log,
  });
  guardarEstado(estado);
  return proceso;
}

async function limpiar(estado: EstadoPila, config: ConfigE2E): Promise<void> {
  await apagarProcesos(estado.procesos);
  if (estado.bdCreada && !config.conservarBd) {
    await borrarBd(config.urlMantenimiento);
  }
  await rm(estado.dir, { recursive: true, force: true });
  delete process.env.E2E_PILA_DIR;
}

export default async function globalSetup(): Promise<void> {
  cargarDotenv();
  const config = leerConfig();
  await Promise.all([
    comprobarPuertoLibre(PUERTO_FRONTEND),
    comprobarPuertoLibre(PUERTO_BACKEND),
  ]);

  const dir = await mkdtemp(join(tmpdir(), "contapp-e2e-"));
  const estado: EstadoPila = {
    dir,
    bdCreada: false,
    conservarBd: config.conservarBd,
    procesos: [],
  };
  process.env.E2E_PILA_DIR = dir;
  guardarEstado(estado);
  const env = entornoDeLaPila(config, dir);

  try {
    estado.bdCreada = await crearBd(
      config.urlMantenimiento,
      config.conservarBd,
    );
    guardarEstado(estado);
    await ejecutarCliDb("migrar", env);
    await ejecutarCliDb("migrar", env);
    await ejecutarCliDb("seed", env);
    await vaciarIndiceRedis(config.urlRedis);

    // Next resuelve su binario desde apps/frontend (pnpm lo deja en su node_modules).
    const nextCli = join(
      dirname(
        createRequire(join(RAIZ, "apps/frontend/package.json")).resolve(
          "next/package.json",
        ),
      ),
      "dist/bin/next",
    );
    const backend = registrar(
      estado,
      arrancarProceso({
        nombre: "backend",
        cwd: join(RAIZ, "apps/backend"),
        args: [join(RAIZ, "apps/backend/dist/main.js")],
        env,
        log: join(dir, "backend.log"),
      }),
    );
    const worker = registrar(
      estado,
      arrancarProceso({
        nombre: "worker",
        cwd: join(RAIZ, "apps/worker"),
        args: [join(RAIZ, "apps/worker/dist/main.js")],
        env,
        log: join(dir, "worker.log"),
      }),
    );
    const frontend = registrar(
      estado,
      arrancarProceso({
        nombre: "frontend",
        cwd: join(RAIZ, "apps/frontend"),
        args: [nextCli, "start", "-p", String(PUERTO_FRONTEND)],
        env: { ...env, NODE_ENV: "production" },
        log: join(dir, "frontend.log"),
      }),
    );

    await Promise.all([
      esperarListo(backend, () =>
        respondeCon(`${URL_BACKEND}/auth/sesion`, 401),
      ),
      esperarWorker(worker, config.urlRedis),
      esperarListo(frontend, () => respondeCon(`${URL_FRONTEND}/login`, 200)),
    ]);

    // Las pruebas (y su siembra por SQL) usan la BD y el índice de la E2E, no los de .env.
    Object.assign(process.env, {
      DATABASE_URL: config.urlApp,
      MIGRATIONS_DATABASE_URL: config.urlMigraciones,
      REDIS_URL: config.urlRedis,
      E2E_CORREO: config.modoCorreo,
      E2E_REDIS_DB: String(config.redisDb),
    });
  } catch (error) {
    await limpiar(estado, config).catch((fallo: unknown) => {
      const motivo =
        fallo instanceof Error ? fallo.message : "error desconocido";
      process.stderr.write(
        `Limpieza incompleta tras el fallo de la pila: ${motivo}\n`,
      );
    });
    throw error;
  }
}
