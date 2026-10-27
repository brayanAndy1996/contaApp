# Spec 003 · Cifrado de credenciales

Estado: aprobada (usuario, 2026-10-25: "todo recomendado"; decisiones D1–D8)
Nivel de riesgo: A — sí a (2) un fallo expone claves SOL/API de clientes de cualquier estudio; sí a (3) un cifrado débil o una fuga en logs no se nota a simple vista; sí a (4) manipulación de sobres, rotación concurrente con escrituras. (1) no aplica.
Cubre: RNF-002, RNF-003, RNF-004, RF-033 (parte de cifrado) · HU-09 (criterio "ninguna API devuelve la clave")

## Objetivo
Guardar las credenciales SOL y API SIRE de modo que el backend pueda **cifrar pero nunca descifrar** y solo el worker las descifre, en memoria y con auditoría (ADR-06, 03 §5). Entrega `packages/crypto`, el puerto `KeyProvider` con adaptadores `mock` y `local`, la tabla `credencial` con permisos por columna (heredado de 002, D3) y el servicio de descifrado del worker.

## Alcance
- `packages/crypto`: sobre híbrido según 03 §5. DEK aleatoria de 32 B **por secreto**, AES-256-GCM con nonce de 12 B y tag de 16 B, AAD canónica `v1|tenant_id|cliente_id|tipo` (D7). La DEK se envuelve con `KeyProvider.wrap` y se guarda `{ciphertext, nonce, tag, dek_envuelta, kek_id, version}`.
- Puerto partido en dos: `KeyWrapper` (wrap, para el backend) y `KeyUnwrapper` (unwrap, solo el worker). Dos puntos de entrada del paquete: el de cifrado y el de descifrado.
- Adaptadores: `LocalKeyProvider` (RSA-OAEP 4096 con SHA-256; el backend monta solo la pública y el worker la privada, `./secrets/`, fuera de git) y `MockKeyProvider` (según D1, con fallas simulables). Se eligen con `KEY_PROVIDER=mock|local`, y `mock` es el valor por defecto.
- Comando `kek:generar`, que crea el par local en `./secrets/`.
- Migración de `credencial` (según D2) con RLS y permisos **por columna**: `contapp_backend` puede hacer `INSERT`/`UPDATE` del sobre y `SELECT` solo de las columnas de estado; `contapp_worker` puede leer el sobre; `contapp_platform` no tiene acceso. Repositorios en `packages/db`.
- Servicio del worker `descifrarCredencial(ctx, credencialId, motivo)` dentro de `withTenant`. Devuelve un `Secreto` que se redacta al serializarse y registra la auditoría de descifrado (D3).
- Re-envolver DEKs al rotar la KEK, como función del worker con su comando (D6).

## Fuera de alcance
- Endpoint y formulario para guardar credenciales, estados y "Verificar" (RF-034/035, HU-09/10) → 007. Job `kek.rotar` en cola → 008.
- `AwsKmsKeyProvider`/`VaultKeyProvider` → despliegue. Token SIRE en Redis con llave efímera (03 §5) → spec del cliente SIRE (D8).

## Criterios de aceptación
- [x] CA-1 (ida y vuelta): cifrar en el backend (solo `KeyWrapper`) y descifrar en el worker devuelve el secreto exacto para `sol` y `sire_api`, con unicode y con la longitud máxima. Un secreto vacío o que excede el límite se rechaza.
- [x] CA-2 (nonce y DEK únicos): 10 000 cifrados del mismo secreto y contexto dan nonces, DEKs y ciphertexts distintos (CSPRNG de `node:crypto`). Un nonce distinto de 12 B o un tag distinto de 16 B (tag truncado) se rechaza antes de descifrar.
- [x] CA-3 (integridad y AAD): falla con un error tipado de integridad, sin devolver texto parcial, cuando:
  - se cambia 1 bit de `ciphertext`, `nonce`, `tag` o `dek_envuelta`;
  - se cambia cualquier campo del AAD;
  - se invierte el orden de campos (tenant con cliente);
  - se copia el sobre a otra fila, cliente, tipo o estudio.

  Los UUID no canónicos, un `tipo` fuera del enum cerrado o campos con `|` se rechazan al cifrar y al descifrar.
- [x] CA-4 (el backend no descifra, RNF-003):
  - (a) La fábrica del backend solo devuelve `KeyWrapper`. Con `local` lee únicamente la llave pública, y si recibe la ruta de la privada no arranca.
  - (b) Una regla de lint impide que `apps/backend` importe el punto de entrada de descifrado. Una importación de prueba rompe el lint.
  - (c) Con `contapp_backend`, cualquier lectura de `ciphertext`, `nonce`, `tag` o `dek_envuelta` recibe `permission denied`: `SELECT` directo o con `*`, `RETURNING`, `row_to_json`, `WHERE`/`ORDER BY` sobre esas columnas, `COPY` o `ON CONFLICT DO UPDATE` que las lea. El `INSERT`/`UPDATE` del sobre y el `SELECT` de estado funcionan.

  Se verifica con `information_schema.column_privileges` y consultas reales.
- [x] CA-5 (aislamiento): dentro de `withTenant(A)` el worker no lee credenciales de B. El tenant del AAD sale del contexto de `withTenant`, nunca del llamador. Es simétrico.
- [x] CA-6 (rotación): con `k1` retirada y `k2` activa, re-envolver cambia solo `dek_envuelta` y `kek_id` (`ciphertext`, `nonce` y `tag` quedan intactos). Es idempotente y se puede reanudar si se interrumpe. Los cifrados nuevos usan `k2`. Un `kek_id` desconocido o retirado falla cerrado. Una actualización concurrente del backend no queda pisada por la rotación.
- [x] CA-7 (KeyProvider caído): si la llave falta, no se puede leer o está corrupta, o el proveedor da timeout o error:
  - el backend no guarda nada (ni fila parcial ni texto plano);
  - el worker devuelve un error tipado reintentable y no marca la credencial como inválida;
  - nunca hay fallback a `mock` ni a otro proveedor.
- [x] CA-8 (auditoría): cada descifrado, exitoso o fallido, registra tenant, cliente, tipo, trabajo o motivo, resultado y fecha, sin el secreto. Si el registro falla, el secreto no se entrega. Para los roles de la app, el registro es solo de inserción.
- [x] CA-9 (sin fugas, RNF-004): con un secreto canario, el canario, la DEK y el material de llave no aparecen en ninguno de estos lugares:
  - logs capturados;
  - `message`, `stack` o `cause` de los errores;
  - `JSON.stringify`/`util.inspect` de errores, sobres y `Secreto`;
  - errores de `pg`.

  El texto plano nunca llega a la capa de BD.
- [x] CA-10 (modos): `mock` y `local` se comportan según D1.
  - Un `KEY_PROVIDER` desconocido o una variable requerida faltante impide arrancar.
  - `local` rechaza sobres `mock` y viceversa.
  - `mock` no arranca con `NODE_ENV=production`.
- [x] CA-11 (llaves locales): `kek:generar` crea el par en `./secrets/`. `git check-ignore secrets/kek-private.pem` lo confirma. En el repo no hay ninguna llave privada salvo el fixture `mock`, marcado (verificado con búsqueda).
- [x] CA-12 (adversario): hasta 2 rondas (04 §2.3), al menos con los ataques de abajo. Todo hallazgo queda corregido o aceptado por el usuario, y los `*.adv.spec.ts` quedan como regresión.
- [ ] Casos reales aplicables: ninguno.

**Cobertura (DoD A):** el módulo es `packages/crypto/src/**/*.ts` más los archivos que 003 agrega en `packages/db` y `apps/worker` (los lista el plan), sin contar las pruebas. Se mide con `pnpm cobertura:crypto` (v8). El umbral es ≥ 90 % en líneas, sentencias, funciones y ramas, y el comando falla por debajo.

**Ataques mínimos del adversario:**
- nonce repetido o RNG forzado;
- tag truncado o vacío;
- bit-flip en cada campo;
- AAD cruzada (copiar a otra fila, cliente, tipo o estudio) y AAD con `|` u orden alterado;
- `kek_id` ajeno o retirado;
- rotación concurrente con un `UPDATE` del backend;
- `KeyProvider` caído a mitad de la rotación;
- el backend leyendo el sobre por cualquier vía SQL, incluidas vistas, funciones u oráculos `WHERE`;
- el backend importando el descifrado;
- descifrado entre estudios;
- canario en logs y errores;
- sobre `mock` aceptado en `local`.

## Límites conocidos
Alcances que 003 no cubre o cubre en parte (aceptados por el usuario o trasladados a otra spec o a despliegue).

- **Rotación con filas corruptas (F2, aceptado por el usuario):** `kek:rotar` no aborta por una fila corrupta: la deja en `desde`, la reporta por id y sale con código 3. Si ninguna fila del estudio abre con la KEK anterior, se detiene con `anterior_no_abre` (código 1, sin escribir). En una corrida posterior con solo filas corruptas no se distingue de una llave equivocada y sale con 1 en vez de 3. Falla cerrado y avisa que la KEK anterior sigue siendo necesaria (no jubilarla).
- **Rotación por estudio:** `kek:rotar` opera por estudio (`--tenant`). El job `kek.rotar` de 008 debe enumerar los estudios, porque el rol worker no ve otros tenants (D9 de 002).
- **`cliente_id` sin FK:** `credencial.cliente_id` no tiene clave foránea hasta 007 (D2).
- **Token SIRE:** fuera de alcance (D8); lo cubre la spec del cliente SIRE.
- **Lint heurístico:** la regla de `apps/backend` (CA-4b) no cubre todas las vías de carga posibles. La defensa real es la migración `0006` (CA-4c): aun evadiendo el lint, el backend no tiene la privada en `local` ni puede leer el sobre; con `mock` solo descifraría sobres de prueba (D1).
- **`huellaPublica` opcional:** `KeyUnwrapper.huellaPublica` no es obligatoria. Si un adaptador KMS/Vault no la implementa, no se comprueba que la KEK anterior y la activa sean distintas (R2b-1); ese adaptador debe implementarla o la rotación debe fallar cerrado en producción.
- **Rutas de llaves absolutas:** las rutas relativas se resuelven contra la raíz del repo. Fuera del monorepo, `raizRepo()` cae al directorio de trabajo: en despliegue, las rutas de llaves deben ser absolutas.

## Dependencias
- Specs: 002 (hecha): roles, `withTenant`, regla de lint contra SQL crudo.
- Externas: ninguna (Node `node:crypto`; sin Docker).

## Decisiones (aprobadas por el usuario el 2026-10-25)
- D1 `mock`: usa un par RSA **de prueba fijo**, guardado como fixture marcado, con `kek_id = mock`, para que backend y worker funcionen de punta a punta. Prohibido con `NODE_ENV=production` y rechazado por `local` (sus sobres y su llave). Con claves SOL reales en local (01 §6) se usa `local`.
- D2 Tabla `credencial`: la crea 003, con `cliente_id` sin FK. 007 agrega la FK cuando amplíe `cliente`.
- D3 Auditoría de descifrado: tabla mínima solo de inserción en 003, que falla cerrado. 017 la integra.
- D4 Contradicción documental: se sigue ADR-06 y 03 §5 (una DEK por secreto, llaves en archivos fuera de git). Se corrigieron RNF-002 (02) y 01 §5 con nota de cambio.
- D5 `.env.example` pasa de 8 a 11 variables: `KEK_ID`, `KEK_PUBLIC_KEY_PATH`, `KEK_PRIVATE_KEY_PATH` (rutas, no secretos).
- D6 Rotación: 003 entrega la función de re-envolver y su comando. El job `kek.rotar` en cola va en 008.
- D7 El AAD lleva prefijo de versión: `v1|tenant_id|cliente_id|tipo` (contra el downgrade).
- D8 Se cifra el par completo como un solo secreto: usuario + clave SOL (`sol`) y `client_id` + `client_secret` (`sire_api`). El token SIRE queda fuera (spec del cliente SIRE).
