# Spec 028 · Avisos por correo y resumen diario

Estado: **borrador** (2026-11-24). Rama `spec/028-correo-avisos` (desde la rama de 027, 7fed2c9, aún no en `main`). Plan y tareas: después de que el usuario responda U-1 a U-16.
Nivel de riesgo: **A** (confirma ESTADO). Por 04 §2.1: (1) no: no calcula montos ni genera archivos; (2) sí: el correo sale del perímetro de la app y de RLS; un destinatario, un cliente o un enlace equivocado expone datos de otro cliente, usuario o estudio, y un enlace de baja mal hecho deja cambiar preferencias ajenas; (3) sí: un resumen que omite una coactiva, o un correo que no sale, no se nota (el contador cree que no hubo novedades); (4) sí: ciclo programado con varios workers, deduplicación por día y por aviso, revalidación al enviar, usuarios en varios estudios, preferencias por tipo y reintentos. (2) con (3) y (4) da A: TDD y ronda adversarial.
Cubre: RF-161, RF-162 · HU-33 («y por correo si lo activé») · RNF-001, RNF-004, RNF-070. Reutiliza: `notificacion`, catálogo de tipos y destinatarios de 017 (D-8, D-9, D-10, P-4) y 023 (`interno.destinatarios_cliente`, 0056); puerto `Correo` (`consola` | `smtp`) de 004 y Mailpit/`E2E_CORREO=consola` de 018/019; cola `notificaciones` y `notificacion.enviar` reservadas en 008 (03 §6.1); patrón del ciclo programado de 023 D-5 (`buzon.programar`, candado en BD, `encolar_buzon_programados`); «nuevo» e «histórico» de 024 (P-1, D-12); estados de periodo de 014 D-9 y 012b D5; `filtroAlcance` y asignaciones de 005; estilo A de 038.

## Objetivo
Que cada usuario elija qué avisos de la app le llegan también por correo (RF-161), sobre todo la coactiva y la clave inválida (HU-33, HU-10), y que quien lo active reciba cada mañana un resumen con los mensajes de buzón nuevos y los periodos pendientes de sus clientes (RF-162), sin que el correo lleve secretos ni datos que el usuario ya no puede ver.

## Alcance
- **Preferencias de correo** por usuario y estudio (granularidad según U-2), con valores iniciales según U-1 y U-8, API del propio usuario y página «Notificaciones por correo» en su perfil (nivel C por tarea).
- **Correo de avisos inmediatos**: por cada `notificacion` de un tipo habilitado para correo (U-1) cuyo destinatario lo tiene activado, un envío durable en la cola `notificaciones` (agrupación según U-9).
- **Resumen diario** (U-3 a U-8): trabajo programado de sistema en la cola `programados` que encola un resumen por usuario, estudio y día de Lima.
- **Envío desde el worker** con el puerto `Correo` compartido (`consola` por defecto, `smtp` contra Mailpit en local y E2E), baja desde el correo (U-12) y registro de envíos con su estado.
- Migraciones desde la **0073**.

## Fuera de alcance
- Correos de autenticación (invitación, recuperación, aviso de bloqueo): siguen como en 004/005 con `ColaCorreo` del backend, sin cambios.
- Nuevos tipos de aviso en la app (vencimientos por cronograma SUNAT, envíos SIRE de RF-104): sus specs. 028 solo usa el catálogo de 017/023.
- Integración por API con un proveedor de correo y proceso de rebotes y quejas, salvo que U-13 o U-14 digan otra cosa.
- SMS, WhatsApp, push del navegador; plantillas editables por el estudio; marca del estudio en el correo (salvo U-11).

## Reglas
- **R-1 · Quién envía.** Solo el worker envía estos correos, por la cola `notificaciones` (`notificacion.enviar`, trabajo de sistema que pasa por el despachador de 008/022). El backend no envía ni encola correos de avisos: solo guarda preferencias. El puerto `Correo` y sus adaptadores (`consola`, `smtp`, `memoria` en pruebas) pasan a un paquete que usan backend y worker, sin cambiar su contrato ni `CorreoNoEnviadoError`.
- **R-2 · Nace con el hecho.** El envío de un aviso inmediato se registra (tabla de envíos, R-11) en la misma transacción que inserta la `notificacion` (017 D-9): si el hecho se revierte, no hay correo. El pedido de envío solo lleva ids; nunca el correo del destinatario, nombres ni textos.
- **R-3 · Revalidar al enviar.** Al armar el correo el worker vuelve a leer, dentro de `withTenant`: membresía activa, `usuario.email` vigente, preferencia todavía activa y, si el aviso o la fila del resumen tiene cliente, que siga visible para el usuario (`filtroAlcance`, 017 D-10) y no archivado. Si algo falla, el envío queda `omitido` con un código y no se manda nada.
- **R-4 · Un estudio por correo.** Preferencias, avisos y resumen son por (usuario, estudio). Un usuario en dos estudios recibe correos separados y ninguno menciona al otro estudio.
- **R-5 · Resumen una vez por día.** Clave única (estudio, usuario, día de Lima): con varios workers y ticks simultáneos sale como máximo uno. El ciclo programado sigue el patrón de 023 D-5 (repetible cada minuto, candado con vencimiento en BD, una sola ejecución por intervalo, configurable en `config_sistema`). El contenido se calcula al enviar, con el alcance del usuario en ese momento. Zona horaria fija `America/Lima`.
- **R-6 · Contenido por lista blanca.** Cada tipo de correo tiene asunto y cuerpo fijos en español con campos de una lista blanca (U-10). Nunca: claves SOL, usuario SOL, `client_secret`, tokens, cifrados, `SMTP_URL`, contenido ni adjuntos de mensajes de buzón. Los textos de usuario (razón social) se escapan en HTML y se limpian de CR/LF y caracteres de control antes de entrar a cualquier cabecera o cuerpo.
- **R-7 · Enlaces.** Los enlaces apuntan a la app (`APP_URL`) y exigen sesión; no llevan ids de otro estudio ni datos en la URL más allá del id de la pantalla. El único enlace que actúa sin sesión es el de baja (U-12): token aleatorio de un solo propósito guardado como hash, ligado a (usuario, estudio, tipo), que solo puede **desactivar**, es idempotente y responde igual para un token inválido, vencido o ajeno.
- **R-8 · Trazas.** Logs, `resultado` del trabajo y registro de envíos solo con ids, códigos y conteos; nunca correo, nombre, razón social ni el error del transporte (004 D11).
- **R-9 · Fallos.** Un fallo de transporte se reintenta según 008 (3 intentos, backoff) y luego queda `fallido`; la garantía ante una caída entre la entrega al SMTP y la marca de enviado es la de U-16.
- **R-10 · Auditoría.** Cambiar una preferencia (en la app o por el enlace de baja) deja `correo.preferencia_cambiada` en `auditoria` (017 D-3, lista blanca: tipo, de → a, origen `app` | `enlace`). Los envíos no se auditan uno por uno: su registro es la tabla de R-11.
- **R-11 · Datos.** Tablas nuevas con RLS forzada por `tenant_id` y prueba de aislamiento de 002 ampliada: preferencias (lectura y escritura solo de `usuario_id = app.user_id`; el worker solo lee), envíos (`pendiente` | `enviado` | `omitido` | `fallido`, origen aviso o resumen, clave única, intentos, sin texto del correo) y tokens de baja (hash). El backend nunca inserta envíos. Envíos y tokens se purgan a los 90 días, como las notificaciones (017 P-7).
- **R-12 · Planes.** Disponibilidad por plan según U-15, leída de `plan.features` (nunca en el código); un estudio sin suscripción activa ni prueba vigente no recibe resúmenes.

## Criterios de aceptación
- [ ] CA-1 (RF-161, R-11, U-1, U-2, U-8): un usuario nuevo tiene las preferencias iniciales de U-1/U-8; `GET`/`PUT` de sus preferencias en el estudio activo cambian solo las suyas; el `usuarioId` del cuerpo se ignora; con la sesión de otro usuario o de otro estudio, ni la API ni el SQL directo leen o cambian las ajenas. Cada cambio deja una fila `correo.preferencia_cambiada`.
- [ ] CA-2 (HU-33, R-2): una coactiva nueva del mock, con el correo de `buzon_critico` activado, deja exactamente un envío para cada destinatario de 023 en la misma transacción; si la transacción se revierte no hay envío; con el correo desactivado no hay envío pero sí la notificación en la app. La misma captura repetida o una reclasificación no crea otro envío. Igual para cada tipo habilitado en U-1.
- [ ] CA-3 (R-3): si entre el encolado y el envío el usuario se desactiva, se le quita la asignación del cliente, el cliente se archiva o apaga la preferencia, el envío queda `omitido` y `CorreoMemoria` no recibe nada; si cambia su correo, sale al correo nuevo.
- [ ] CA-4 (R-5, RF-162, U-3 a U-7): con un usuario con dos clientes asignados (uno con 3 mensajes nuevos, uno con compras del periodo pendiente según U-5), uno no asignado y uno archivado, a la hora de U-6 recibe un único resumen con solo los dos asignados y las cifras correctas según U-4 y U-5; con tres workers y ticks simultáneos durante 10 ciclos sale exactamente uno por usuario y día; si el worker con el candado muere, otro lo toma; un día sin novedades se comporta según U-7; cambiar la hora del ciclo en `config_sistema` surte efecto sin reiniciar.
- [ ] CA-5 (R-4, RNF-001): un usuario en dos estudios recibe un resumen por estudio y ninguno contiene clientes, conteos ni el nombre del otro.
- [ ] CA-6 (R-6, R-8, RNF-004): con centinelas en clave SOL, usuario SOL, `client_secret`, `SMTP_URL` con contraseña, asunto y contenido de un mensaje de buzón, ninguno aparece en cuerpos, cabeceras, envíos, `resultado`, logs ni respuestas de la API. El pedido de envío en la cola solo lleva ids.
- [ ] CA-7 (R-6): una razón social con `<img src=x onerror=…>`, `\r\nBcc: x@y` y caracteres de control no agrega cabeceras ni ejecuta nada: sale como texto escapado.
- [ ] CA-8 (R-7, U-12): el enlace de baja desactiva solo el tipo (o el resumen) y solo del usuario y estudio del token, sin sesión; repetirlo da lo mismo; un token inválido, alterado, vencido o de otro usuario responde igual y no cambia nada; nunca activa. Si U-12 lo pide, el correo lleva `List-Unsubscribe` y `List-Unsubscribe-Post`.
- [ ] CA-9 (U-9): 50 críticos nuevos de un cliente en una captura producen como máximo los correos que fije U-9 y ninguno se pierde (todos figuran en los correos enviados o en el resumen).
- [ ] CA-10 (R-9, U-16): con el transporte fallando, 3 intentos y estado `fallido` sin el texto del error; con el worker muerto antes y después de la entrega al SMTP, el resultado cumple U-16.
- [ ] CA-11 (R-12, U-15): un estudio en un plan sin la función no envía; uno sin suscripción ni prueba no recibe resúmenes.
- [ ] CA-12 (frontend, nivel C, estilo A de 038): la página de preferencias muestra y guarda cada interruptor, avisa si el último envío falló y es usable a 390 px; los textos salen en español sin códigos crudos.
- [ ] CA-13: suites de los paquetes tocados, `test:aislamiento`, typecheck, lint, `db:migrate` ×2 y `pnpm e2e` (un caso: activar el correo de críticos → «Revisar buzón ahora» → coactiva del mock → correo en Mailpit con enlace a la bandeja → baja desde el enlace → la preferencia queda apagada) en verde.
- [ ] Casos reales aplicables: ninguno.

**Ataques mínimos del adversario:** IDOR y SQL directo sobre preferencias, envíos y tokens; token de baja forjado, reutilizado, de otro usuario o de otro estudio, y enumeración por tiempos; inyección de cabeceras y HTML por razón social; correo a un usuario desactivado o desasignado (carreras entre desasignar y enviar); dos ciclos del resumen a la vez y worker que muere con el candado; inundación de avisos (primera sincronización con muchos críticos); canarios de secretos en errores del transporte y del portal.

## Dependencias
- Specs: 004 (puerto `Correo`), 005 (alcance, asignaciones), 006 (planes, `features`, suscripción), 008/022 (cola, despachador, sistema), 012b y 014 (estados de periodo), 017 (notificación, auditoría), 018/019 (Mailpit, E2E), 023 y 024 (buzón, destinatarios, nuevo/histórico), 038 (estilo A).
- Externas: ninguna con U-13 (a). Con U-13 (b), cuenta y dominio verificados en el proveedor.

## Preguntas para el usuario
- **U-1 · Qué avisos pueden ir por correo y cuáles vienen activados.**
  (a) (Recom.) Pueden ir por correo `buzon_critico`, `credencial_invalida` y `plan_limite`; los dos primeros vienen activados y `plan_limite` activado solo para Dueños. `trabajo_terminado` no va por correo. — Son los que piden acción fuera de la app; el trabajo terminado lo lanzó alguien que está mirando la pantalla.
  (b) Los cuatro tipos pueden ir por correo y todos vienen desactivados. — Cero correo no pedido, pero la coactiva no llega a nadie que no entre a configurarlo.
  (c) Los cuatro tipos pueden ir por correo y todos vienen activados. — Máxima cobertura, más ruido.
- **U-2 · Granularidad de la configuración.**
  (a) (Recom.) Un interruptor por tipo de aviso y otro para el resumen, por usuario y por estudio. — Cubre RF-161 sin pantalla compleja y respeta que un usuario trabaje en varios estudios.
  (b) Un solo interruptor «recibir correos» por usuario y estudio. — Más simple, pero obliga a todo o nada.
  (c) Por tipo y además por cliente. — Muy fino, caro de mantener y de explicar.
- **U-3 · De qué clientes es el resumen diario.**
  (a) (Recom.) De los clientes donde el usuario es responsable o colaborador, para cualquier rol; un Dueño o Administrador sin asignaciones puede marcar «todos los clientes». — Es lo que dice RF-162 («asignados») y evita resúmenes de 600 clientes por defecto.
  (b) De todos los clientes visibles para el usuario (Dueño y Administrador, todos). — Sin configuración extra, pero el resumen de un Dueño puede ser enorme.
  (c) Solo de los clientes donde es responsable. — Más corto, pero el colaborador no se entera.
- **U-4 · Qué cuenta como «mensajes de buzón nuevos» en el resumen.**
  (a) (Recom.) Los capturados desde el resumen anterior (o las últimas 24 h), con los críticos aparte, más el total de pendientes de atender por cliente (24 P-1). — Dice qué llegó hoy sin perder lo que sigue sin atender.
  (b) Solo los pendientes de atender (el «nuevo» de 024). — Coincide con el indicador de la app, pero repite los mismos mensajes cada día.
  (c) Solo los capturados en las últimas 24 h. — Corto, pero lo no atendido de ayer desaparece del correo.
- **U-5 · Qué es un «periodo pendiente».**
  (a) (Recom.) El periodo del mes anterior (en Lima) de compras y de ventas de cada cliente activo que no está `generado`, incluido «sin descargar»; se muestra el estado (sin descargar, abierto, revisado). — Es el periodo que toca declarar este mes y usa los estados que ya existen (014, 012b).
  (b) Cualquier periodo con estado `abierto` o `revisado`, sin importar el mes. — Encuentra periodos olvidados, pero no avisa de los que nadie descargó.
  (c) Según el cronograma de vencimientos SUNAT por último dígito del RUC (solo los que vencen en los próximos N días). — El más útil, pero exige cargar y mantener el cronograma: otra spec.
- **U-6 · Hora y días del resumen.**
  (a) (Recom.) 07:00 de Lima, de lunes a viernes. — Llega después de la pasada de madrugada del buzón (02:00–05:00, 023 D-5) y antes de la jornada; los críticos del fin de semana ya llegan al momento (U-1).
  (b) 07:00 de Lima, todos los días. — No deja huecos, pero manda correos en días sin trabajo.
  (c) Hora y días elegidos por cada usuario. — Flexible, más pantalla y más combinaciones que probar.
- **U-7 · Resumen sin novedades.**
  (a) (Recom.) No se envía si no hay mensajes nuevos ni periodos pendientes. — Evita correo inútil que entrena a ignorar el resumen.
  (b) Se envía siempre, con «Sin novedades» cuando no hay nada. — Confirma que el sistema funciona, pero es ruido diario.
- **U-8 · Estado inicial del resumen.**
  (a) (Recom.) Desactivado; la página de preferencias y un aviso único en la app invitan a activarlo. — RF-162 es «C» y así no mandamos correos diarios no pedidos.
  (b) Activado para quien tenga al menos un cliente asignado. — Más adopción, más riesgo de que lo marquen como spam.
- **U-9 · Agrupación y límites contra la inundación.**
  (a) (Recom.) Los avisos de un mismo tipo para un usuario se juntan en ventanas de 10 min (un correo con la lista); tope de 30 correos inmediatos por usuario y día, y lo que pase el tope va al resumen o a un último correo «y N avisos más». — Una primera sincronización con 40 coactivas no manda 40 correos y nada se pierde.
  (b) Un correo por aviso, sin agrupar, con tope diario de 100 por usuario. — Inmediato, pero puede inundar y caer en spam.
  (c) Sin límites. — Lo más simple; riesgo de bloqueo del remitente.
- **U-10 · Qué datos pueden ir en el correo.**
  (a) (Recom.) Razón social del cliente, tipo y categoría del aviso (p. ej. «Coactiva»), fecha del mensaje, conteos del resumen y el enlace; sin RUC, sin asunto ni contenido del mensaje y sin montos. — Basta para priorizar y obliga a entrar a la app (con sesión) para el detalle.
  (b) Nada identificable: «Tienes 1 aviso crítico» y el enlace. — Máxima privacidad; el contador no sabe de qué cliente es sin entrar.
  (c) Además RUC, asunto del mensaje y montos. — Más útil leído en el celular, pero esos datos salen del perímetro y quedan en buzones de terceros.
- **U-11 · Idioma y formato.**
  (a) (Recom.) Español peruano; multiparte con texto plano y HTML simple de plantilla fija (todo escapado), sin imágenes remotas ni seguimiento de apertura o clics. — Se ve bien en cualquier cliente de correo y no filtra cuándo se abrió.
  (b) Solo texto plano, como las invitaciones de hoy. — Lo más seguro y simple, menos legible en el resumen.
  (c) HTML con logo y colores del estudio. — Más marca; más superficie y trabajo.
- **U-12 · Baja desde el correo.**
  (a) (Recom.) Cada correo trae «Dejar de recibir este tipo de correo» de un clic, sin iniciar sesión (token de R-7), más las cabeceras `List-Unsubscribe` y `List-Unsubscribe-Post` (RFC 8058). — Gmail y Yahoo lo exigen a remitentes con volumen y evita que nos marquen como spam.
  (b) El enlace lleva a la página de preferencias, que pide sesión. — Sin token público que atacar, pero peor entregabilidad.
  (c) Un clic que apaga todos los correos del estudio. — Simple, pero el usuario pierde también las coactivas sin querer.
- **U-13 · Proveedor de correo.**
  (a) (Recom.) Solo el adaptador SMTP existente (`consola` por defecto, Mailpit en local y E2E); el servicio de producción (SES, Postmark u otro por SMTP) se elige al desplegar, sin código propio. — No ata la spec a un proveedor y reutiliza lo que ya probó 018.
  (b) Integrar ya un proveedor por API (p. ej. Amazon SES) con sus avisos de entrega. — Más control y métricas; exige cuenta, dominio verificado y secretos nuevos.
- **U-14 · Rebotes y fallos.**
  (a) (Recom.) Sin proceso de rebotes en 028: tras 3 intentos el envío queda `fallido` y la página de preferencias muestra «No pudimos enviarte el último correo». — Suficiente con SMTP; los rebotes llegan con U-13 (b) o con el despliegue en nube.
  (b) Procesar rebotes y quejas del proveedor y suspender esa dirección hasta que el usuario la confirme. — Protege la reputación del remitente; requiere U-13 (b).
- **U-15 · Planes.**
  (a) (Recom.) Avisos por correo y resumen en todos los planes, incluida la Prueba. — El costo por correo es mínimo y la coactiva por correo es parte del valor del producto.
  (b) Avisos inmediatos en todos; el resumen desde el plan Estudio (`plan.features`). — Diferencia planes, pero recorta una función barata.
  (c) Todo solo en planes pagados. — La prueba no muestra el valor del correo.
- **U-16 · Duplicado o pérdida ante una caída.**
  (a) (Recom.) Al menos una vez: si el worker muere después de entregar al SMTP y antes de marcarlo enviado, se reintenta y puede llegar un duplicado (raro). — Para una coactiva, un duplicado es mejor que un correo perdido.
  (b) Como máximo una vez: se marca `enviado` antes de entregar y no se reintenta tras una caída. — Nunca duplica, pero puede perder un aviso crítico sin que nadie lo note.
