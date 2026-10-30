# 07 · Seguridad: cifrado de credenciales y sesiones

> Módulo anterior: [06-backend-nestjs-sse.md](06-backend-nestjs-sse.md) · Siguiente: [08-dinero-y-dominio.md](08-dinero-y-dominio.md) · Índice: [00-indice.md](00-indice.md)

## Lo que aprenderás

- Por qué la clave SOL y el `client_secret` de SIRE son lo más delicado que guarda ContApp.
- La diferencia entre cifrado **simétrico** y **asimétrico**, y por qué aquí se usan los dos juntos (cifrado "de sobre" o *envelope*: KEK + DEK con AES-256-GCM).
- Por qué el backend puede **cifrar** pero nunca **descifrar**, y las tres barreras que lo garantizan (llaves, lint y permisos de PostgreSQL).
- Qué son los proveedores de llaves `mock` y `local`, y por qué `mock` jamás puede llegar a producción.
- Cómo se rota la llave maestra (`kek:rotar`) sin perder ninguna credencial.
- Cómo se guardan las contraseñas de los usuarios (Argon2id) y cómo funciona la sesión: cookie, caducidades, CSRF, bloqueo por intentos y recuperación.
- Qué encontraron las rondas adversariales de las specs 003 y 004, y qué enseñan.

---

## 1. Lo más sensible: la clave SOL

Piensa en un estudio contable que te entrega las llaves de las oficinas de 80 clientes. Si alguien roba ese llavero, no entra a una oficina: entra a **todas**. Eso es la tabla `credencial` para ContApp.

Con el usuario y la clave SOL de un contribuyente se puede presentar declaraciones, leer buzones y modificar registros ante SUNAT. Con el `client_id`/`client_secret` de la API SIRE se descargan y reemplazan propuestas. Por eso las reglas del proyecto (`CLAUDE.md`) son tajantes:

- Nunca registrar, devolver ni exportar secretos.
- `apps/backend` nunca llama a SUNAT ni descifra credenciales. Solo el **worker** lo hace, justo antes de usarlas.

El tipo de dato está en `packages/crypto/src/comun/sobre.ts:55-56`:

```ts
export type CredencialSol = { usuario: string; clave: string };
export type CredencialSireApi = { clientId: string; clientSecret: string };
```

## 2. Simétrico vs asimétrico, en lenguaje de oficina

| | Simétrico (AES) | Asimétrico (RSA) |
|---|---|---|
| Llaves | Una sola: la misma cierra y abre | Un par: la **pública** cierra, solo la **privada** abre |
| Velocidad | Muy rápido, cualquier tamaño | Lento, y solo cifra datos pequeños |
| Analogía | Candado con una llave | Buzón con ranura: cualquiera echa cartas, solo el dueño abre |

El problema: con solo AES, quien cifra también puede descifrar (es la misma llave), y el backend tendría que tener esa llave. Con solo RSA, cifrar cada credencial sería lento y con límite de tamaño.

**Solución: cifrado híbrido o de sobre (*envelope encryption*).**

- **DEK** (*Data Encryption Key*): una llave AES-256 **nueva y aleatoria por cada credencial**. Es la "caja fuerte por cliente".
- **KEK** (*Key Encryption Key*): un par RSA-4096 del sistema. La pública "envuelve" (cifra) cada DEK; la privada la "desenvuelve". Es la "llave maestra guardada en la bóveda".

```
   Backend (solo tiene la PÚBLICA)                       Worker (tiene la PRIVADA)
   ─────────────────────────────                         ─────────────────────────
   clave SOL ──AES-256-GCM(DEK)──► ciphertext + tag ──┐
   DEK ──RSA-OAEP(KEK pública)───► dek_envuelta ──────┼──► tabla credencial ──► worker:
                                                       │      RSA privada abre DEK
                                                       │      AES-GCM abre la clave SOL
```

El backend echa la carta por la ranura y ya no puede sacarla. Solo el worker, que tiene la llave de la bóveda, la abre.

## 3. El código real del cifrado

`packages/crypto/src/cifrado/cifrar.ts:22-49` (simplificado):

```ts
export async function cifrarCredencial(w: KeyWrapper, ctx: ContextoAad, valor) {
  const aad = construirAad(ctx);                 // "v1|tenant|cliente|tipo"
  const sensibles = [serializarSecreto(ctx.tipo, valor)];
  try {
    const { dek, nonce } = generarMaterial();    // 32 B de DEK + 12 B de nonce, aleatorios
    const cifrador = createCipheriv("aes-256-gcm", dek, nonce, { authTagLength: 16 });
    cifrador.setAAD(aad);
    const ciphertext = Buffer.concat([cifrador.update(plano), cifrador.final()]);
    const tag = cifrador.getAuthTag();           // sello de integridad
    const dekEnvuelta = Buffer.from(await w.wrap(paraEnvolver)); // RSA con la pública
    return { ciphertext, nonce, tag, dekEnvuelta, kekId: w.kekId, version: 1 };
  } finally {
    for (const b of sensibles) b.fill(0);        // borra DEK y texto plano de memoria
  }
}
```

Tres ideas para retener:

1. **GCM autentica.** Además de cifrar, produce un `tag` de 16 bytes. Si alguien cambia un solo bit del `ciphertext`, al descifrar `final()` falla y el worker lanza `IntegridadError` (`packages/crypto/src/descifrado/descifrar.ts`). Es como el sello de lacre de un sobre notarial.
2. **AAD: el sobre lleva escrito el destinatario.** `construirAad` (`packages/crypto/src/comun/aad.ts:14-23`) arma el texto `v1|<tenant>|<cliente>|<tipo>`. No se cifra, pero entra en el cálculo del `tag`. Si alguien copia el cifrado del cliente A a la fila del cliente B, el AAD ya no coincide y falla. Evita el "pegar el sobre en otra carpeta".
3. **Nonce único.** AES-GCM se rompe si se repite el par (DEK, nonce). Por eso `comun/aleatorio.ts` vigila el generador aleatorio (lo endurecieron los hallazgos F5 y R2a-1, más abajo).

La DEK se envuelve con RSA-OAEP SHA-256 y una etiqueta que la ata a su `kek_id` (`packages/crypto/src/comun/rsa.ts:22-24`):

```ts
export function etiquetaOaep(kekId: string): Buffer {
  return Buffer.from(`contapp-kek|v1|${kekId}`, "utf8");
}
```

Y si por error alguien pone la llave **privada** en la ruta de la pública del backend, arranca con error (`rsa.ts:60`): `if (pem.toString("latin1").includes("PRIVATE KEY")) throw new ConfiguracionKeyProviderError();`.

### El secreto descifrado tampoco se deja ver

En el worker, el resultado es un `Secreto` (`packages/crypto/src/descifrado/secreto.ts:22-55`). Guarda el plano en un `WeakMap` fuera del objeto, y todas sus formas de imprimirse devuelven `[REDACTADO]`: `toJSON`, `toString`, `Symbol.toPrimitive` y `util.inspect`. Si un programador hace `console.log(secreto)` por descuido, no sale nada. Se usa así: `secreto.usar(v => login(v.usuario, v.clave))` y luego `secreto.destruir()` pone el buffer a cero.

## 4. Tres barreras para que el backend no descifre

Un solo candado no basta. ContApp pone tres, de distinta naturaleza:

1. **Llaves**: con `KEY_PROVIDER=local`, el backend solo recibe `KEK_PUBLIC_KEY_PATH`; la privada (`KEK_PRIVATE_KEY_PATH`) va solo al worker (`.env.example`, "Solo apps/worker").
2. **Lint**: `packages/crypto` exporta dos entradas, `.` (cifrar) y `./descifrado` (`packages/crypto/package.json`, `exports`). El ESLint del repo prohíbe que `apps/backend` importe la segunda (`eslint.config.mjs:77-85`):

   ```js
   { desde: "apps/backend/",
     paquetes: /^@contapp\/crypto\/(?:descifrado|dist|src)(?:[/.].*)?$/,
     sinEvasiones: true,
     mensaje: "apps/backend no puede importar el descifrado de @contapp/crypto (solo el worker; spec 003, CA-4b)." }
   ```
   `sinEvasiones` cubre también `require`, `import()` con plantilla, `createRequire`, `eval`, etc. (hallazgos F4 y R2a-2).
3. **Base de datos**: la migración `packages/db/migrations/0006_credencial_rls_y_grants.sql:34-40` da al rol del backend permiso de **escribir** el sobre pero no de **leerlo**:

   ```sql
   GRANT SELECT (id, tenant_id, cliente_id, tipo, created_at, updated_at) ON public.credencial TO contapp_backend;
   GRANT INSERT (cliente_id, tipo, ciphertext, nonce, tag, dek_envuelta, kek_id, version) ON public.credencial TO contapp_backend;
   GRANT SELECT ON public.credencial TO contapp_worker;
   GRANT UPDATE (dek_envuelta, kek_id, updated_at) ON public.credencial TO contapp_worker;
   ```
   Es "escritura a ciegas": como la persona de mesa de partes que recibe sobres cerrados y los archiva, pero no tiene llave del archivador. Y el worker, al rotar, solo puede tocar `dek_envuelta` y `kek_id`, nunca el `ciphertext`. Todo dentro de RLS (ver [03-rls-y-withtenant.md](03-rls-y-withtenant.md)).

## 5. Proveedores de llaves: `mock` y `local`

`KEY_PROVIDER` es obligatorio y cerrado: `mock` o `local`, sin valor por defecto escondido (`packages/crypto/src/comun/config.ts:17-21`).

- **`mock`**: usa un par de llaves de prueba que **está versionado en el repo** (`packages/crypto/fixtures/mock-kek/SOLO-PRUEBAS-kek-mock-*.pem`). Sirve para desarrollar y para el CI sin configurar nada. Pero si su privada está en GitHub, cualquiera puede descifrar lo que se cifre con ella. Por eso:
  - El constructor se niega a arrancar en producción (`packages/crypto/src/cifrado/mock.ts:46`), y `esProduccion` normaliza mayúsculas y espacios (`config.ts:27-29`) desde el hallazgo R2b-3: antes `NODE_ENV=Production` lo dejaba pasar.
  - `local` rechaza la llave del fixture comparando su huella SHA-256 (`rsa.ts`, `rechazarFixtureMock`).
  - La rotación nunca acepta `mock` ni como activa ni como anterior (hallazgo F1).
- **`local`**: un par RSA-4096 generado por ti con `kek:generar`, guardado fuera del repo o en `./secrets/` (ignorada por git). En el futuro habrá `aws`/`vault` (`docs/03-arquitectura.md`).

## 6. Rotar la llave maestra: `kek:rotar`

Si sospechas que la llave de la bóveda se copió, la cambias. Lo bonito del sobre: **no hay que re-cifrar las claves SOL**, solo re-envolver cada DEK con la KEK nueva. Es cambiar la cerradura de la bóveda sin abrir cada caja fuerte.

```bash
pnpm kek:rotar -- --desde <kek-id-anterior> --privada-anterior <ruta> --tenant <uuid>
```

La cabecera de `apps/worker/src/cli/kek-rotar.ts:1-15` explica los códigos de salida: `0` todo bien, `1` error, `2` argumentos inválidos, `3` quedan credenciales corruptas (no jubiles la llave vieja). Salvaguardas reales:

- `kekAnterior` es **obligatorio** al reemplazar una DEK (`packages/db/src/credenciales/repositorio.ts:186-189`): la actualización compara `dek_envuelta` **y** `kek_id` (CAS, *compare-and-swap*) y si falta lanza antes de consultar. Así no se pisa una fila que otro proceso ya cambió.
- Se niega si la llave "anterior" es la misma que la activa con otro nombre (hallazgo R2b-1, `apps/worker/src/credenciales/rotar-kek.ts`, `exigirLlavesDistintas`).
- La salida solo trae ids de estudio y conteos, nunca llaves, rutas ni bytes.

## 7. Nunca registrar secretos: los canarios

¿Cómo pruebas que algo **no** aparece en los logs? Con un **canario**: un valor llamativo y único (en `packages/crypto/src/soporte-pruebas.ts` hay uno para el usuario y otro para la clave) que se cifra en la prueba. Luego se capturan logs, mensajes de error, `stack`, `cause`, `JSON.stringify` y `util.inspect`, y se verifica que el canario no aparece en ninguno. Lo hace `packages/crypto/src/fugas.spec.ts` (CA-9). Si un día alguien agrega `logger.info(valor)`, la prueba se pone roja.

## 8. Contraseñas de usuarios: Argon2id

Las contraseñas de los contadores **no se cifran**: se guardan como *hash*, una huella de una sola vía. Al iniciar sesión se calcula el hash de lo que escribiste y se compara. Si roban la tabla, no obtienen las contraseñas.

Argon2id es un hash **lento a propósito y que consume memoria**, para que probar millones de contraseñas sea caro. `apps/backend/src/modules/auth/contrasena/hasher.ts:52-57`:

```ts
const opciones = {
  algorithm: ARGON2ID,                    // 2 = Argon2id
  memoryCost: parametros.memoriaKib,
  timeCost: parametros.iteraciones,
  parallelism: parametros.paralelismo,
};
```

Los parámetros vienen de `.env.example` (no son secretos): `ARGON2_MEMORIA_KIB=19456`, `ARGON2_ITERACIONES=2`, `ARGON2_PARALELISMO=1`, con un piso: por debajo, la app no arranca. Además:

- Las contraseñas de más de 128 caracteres nunca llegan a la librería (`hasher.ts:43-46`), para evitar un DoS con textos gigantes.
- Hay un `hashFicticio` (`hasher.ts:60`): si el correo no existe, igual se verifica contra él. Así la respuesta tarda lo mismo y no revela qué correos están registrados (CA-2 de la spec 004).

## 9. Sesiones: cookie, caducidad y CSRF

La sesión es un token aleatorio en una cookie; en la BD se guarda su SHA-256 (`apps/backend/src/modules/auth/sesion/token.ts:19`), así que robar la tabla `auth.sesion` no sirve para entrar. `apps/backend/src/modules/auth/sesion/cookie.ts:5-11`:

```ts
export const COOKIE_NOMBRE = "__Host-contapp_sid";
const ATRIBUTOS = "HttpOnly; Secure; SameSite=Lax; Path=/";
```

- **`HttpOnly`**: JavaScript de la página no puede leerla; un script inyectado (XSS) no la roba.
- **`Secure`** y prefijo **`__Host-`**: solo viaja por HTTPS, sin `Domain`, para todo el sitio.
- **`SameSite=Lax`**: el navegador no la envía en peticiones POST iniciadas desde otro sitio.

**Caducidades** (spec 004, D3), las aplica la BD en `packages/db/migrations/0007_auth.sql`:

- Absoluta de **12 h** al crear la sesión: `now() + interval '12 hours'` (línea 232).
- Por inactividad de **2 h**: `x.ultimo_uso > now() - interval '2 hours'` (línea 251 y repetida en cada función que consulta la sesión). El último uso se actualiza como máximo cada 5 min.

**CSRF** (falsificación de petición entre sitios: una página maliciosa que hace que tu navegador envíe un POST a ContApp con tu cookie). Tres capas (D6):

1. `SameSite=Lax`.
2. `OrigenGuard` (`apps/backend/src/modules/auth/guards/origen.guard.ts:16-25`): en todo método que no sea GET, `Origin` debe ser exactamente `APP_ORIGIN` y `Sec-Fetch-Site`, si viene, `same-origin`. Si no viene ninguna de las dos: 403.
3. Token sincronizador en la cabecera `X-CSRF-Token`, comparado en tiempo constante con `timingSafeEqual` (`apps/backend/src/modules/auth/sesion/csrf.ts:16`).

**Bloqueo por intentos** (D7): el 5.º fallo en 15 minutos bloquea la cuenta 15 minutos (`0007_auth.sql:177-184`), con contador atómico (`SELECT … FOR UPDATE`) para que 20 intentos concurrentes no se cuelen. Hay límites por IP (429).

**Recuperación** (D8): token de 32 bytes que viaja en el **fragmento** de la URL (`#t=…`, que el navegador no manda al servidor ni en el `Referer`), se guarda solo su SHA-256, caduca a los 30 min (`0007_auth.sql:372`) y se consume con un `UPDATE … WHERE usado_en IS NULL AND expira_en > now()` (líneas 388-390): de dos consumos simultáneos, solo uno gana. Al restablecer se revocan las sesiones vivas.

## 10. Hallazgos adversariales que enseñan (003 y 004)

Del tablero `docs/specs/ESTADO.md`. Todos corregidos salvo los marcados como aceptados.

| Hallazgo | Qué pasaba | Lección |
|---|---|---|
| 003 · F1 (alta) | `kek:rotar` aceptaba `mock` como llave activa: re-envolvía DEKs reales con una llave cuya privada está en el repo | Lo "de prueba" debe ser imposible de usar en real, no solo "no recomendado" |
| 003 · R2b-3 | `NODE_ENV=Production` (con mayúscula) dejaba arrancar `mock` | Normaliza antes de comparar textos de configuración |
| 003 · R2b-4 | `kek:generar --salida` aceptaba una carpeta del repo no ignorada | Una privada versionable es una privada publicada |
| 003 · F2 (aceptado) | Una sola fila corrupta abortaba la rotación de todo el estudio | Ahora continúa, reporta los ids y sale con código 3 |
| 004 · H1 | Un token de recuperación seguía valiendo tras cambiar la contraseña | Al cambiar credenciales, invalida todo lo que se emitió antes |
| 004 · H2 | `Origin` correcto con `Sec-Fetch-Site: cross-site` pasaba | Si hay dos señales, se revisan las dos |
| 004 · B1 | Restablecer calculaba Argon2id antes de validar el token: 25 tokens inventados = 25 hashes caros | Valida lo barato antes de lo caro (DoS) |
| 004 · H-r2b-3 | `db:seed` en producción insertaba usuarios admin con una contraseña versionada | Los datos de desarrollo también son un riesgo |

## Práctica

**A. Generar un par KEK fuera del repo** (verificado: no deja nada versionable; `git status` queda igual):

```bash
cd /ruta/a/contaApp
pnpm --filter @contapp/crypto build          # si no existe dist/
DIR=$(mktemp -d)                              # carpeta temporal fuera del repo
pnpm kek:generar -- --salida "$DIR"
# Llave pública: <DIR>/kek-public.pem
# Llave privada: <DIR>/kek-private.pem
# Huella SHA-256 (SPKI): <64 caracteres hex>
ls -l "$DIR"                                  # privada -rw------- (0600), pública -rw-r--r-- (0644)
git status --porcelain                        # vacío: nada nuevo en el repo
pnpm kek:generar -- --salida "$DIR"           # 2.ª vez: falla, nunca sobrescribe un par
rm -rf "$DIR"                                 # es una práctica: bórrala
```

El CLI está en `packages/crypto/src/cli/kek-generar.ts`: `exigirSalidaIgnorada` (líneas 34-48) rechaza una carpeta del repo que git no ignore, y la línea 59 impide sobrescribir ("perder la privada pierde todas las credenciales"). No abras ni copies el contenido del `.pem` privado en ningún chat, ticket o log.

**B. Ver en psql que la BD guarda bytes, no texto** (solo lectura, con el rol administrador local):

```bash
psql -h localhost -U postgres -d contapp -c '\d public.credencial'
psql -h localhost -U postgres -d contapp -c \
  "SELECT tipo, kek_id, octet_length(ciphertext) AS bytes_cifrado,
          octet_length(nonce) AS nonce, octet_length(tag) AS tag,
          octet_length(dek_envuelta) AS bytes_dek
     FROM public.credencial LIMIT 5;"
```

Verás columnas `bytea` y CHECKs (`nonce` = 12, `tag` = 16, `kek_id` con formato). Pedimos solo **longitudes**, no valores: con RSA-4096 la `dek_envuelta` mide 512 bytes. Si la tabla está vacía (como en una BD recién sembrada) igual ves la estructura. Nota: `postgres` es superusuario y salta RLS; la app nunca usa ese rol.

## Impacto en ContApp

- Un volcado de la BD robado no revela claves SOL: sin la privada (que solo vive en el worker) los sobres son ruido.
- Un bug o una dependencia comprometida en el backend (la parte expuesta a internet) tampoco puede descifrar: no tiene la llave, el lint no le deja importar el descifrado y PostgreSQL no le deja leer el sobre.
- Rotar la KEK es barato (solo DEKs) y seguro (CAS con `kekAnterior`).
- Las sesiones caducan solas y resisten CSRF, fijación y fuerza bruta: requisito para datos tributarios de terceros.

## Errores comunes

- **Reusar un nonce** con la misma DEK en AES-GCM: rompe confidencialidad e integridad. Aquí cada credencial tiene DEK y nonce nuevos.
- **Cifrar sin autenticar** (AES-CBC sin MAC): un atacante altera bytes sin que lo notes. GCM + AAD lo evita.
- **Loguear el objeto completo** (`logger.info({ body })`) en el endpoint que recibe la clave SOL.
- **Pensar que `mock` es inofensivo** porque "es solo desarrollo": su privada es pública.
- **Guardar contraseñas con SHA-256 "a secas"**: es rápido, y rápido es malo para contraseñas. Usa Argon2id.
- **Comparar tokens con `===`**: puede filtrar información por tiempo; usa `timingSafeEqual`.
- **Poner el token de recuperación en la query** (`?t=`): queda en logs de proxies y en el `Referer`. Va en el fragmento.

## Ejercicios

1. Si alguien copia `ciphertext`, `nonce`, `tag` y `dek_envuelta` de la credencial del cliente A a la fila del cliente B (mismo estudio), ¿qué pasa al descifrar y por qué?
2. ¿Por qué no basta con el lint para impedir que el backend descifre?
3. Un compañero propone "para simplificar, que el backend tenga también la privada y así valida la clave SOL al guardarla". ¿Qué le respondes?
4. Con `ARGON2_MEMORIA_KIB=8192`, ¿qué pasa al arrancar el backend?
5. Al rotar, ¿por qué el worker solo puede actualizar `dek_envuelta`, `kek_id` y `updated_at`?

<details><summary>Soluciones</summary>

1. Falla con `IntegridadError`. El AAD incluye `clienteId` (`aad.ts:22`); al descifrar con el contexto de B el AAD es distinto y el `tag` de GCM no verifica.
2. El lint es una revisión de código: se puede saltar (deshabilitar la regla, un truco de carga dinámica no previsto). Por eso hay defensa en profundidad: el backend no tiene la privada y su rol de BD no puede leer el sobre (migración 0006). Ninguna capa sola es suficiente.
3. Que rompe la regla central (`CLAUDE.md`): el backend es la parte expuesta a internet; si lo comprometen, tendrían todas las claves. La validación de la clave SOL la hace el worker (trabajo en la cola, ver [05-bullmq-y-la-cola.md](05-bullmq-y-la-cola.md)).
4. No arranca: `.env.example` documenta el piso 19456 KiB / 2 / 1; por debajo es error de arranque (CA de 004: "parámetros de Argon2id bajo el piso").
5. Porque re-envolver no requiere tocar el cifrado de la clave SOL: la DEK es la misma, solo cambia quién la envuelve. Limitar los GRANT (`0006…sql:40`) hace que un bug en la rotación no pueda dañar `ciphertext`.

</details>

## Para profundizar

- Node.js, módulo `crypto` (AES-GCM, RSA-OAEP): https://nodejs.org/api/crypto.html
- OWASP, Password Storage Cheat Sheet (Argon2id) y Session Management Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html · https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- NIST SP 800-38D (modo GCM): https://csrc.nist.gov/pubs/sp/800/38/d/final
