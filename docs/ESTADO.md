# Estado

- **Versión**: 0.1.9 (publicada para BRAT).
- **Qué hay**: esqueleto del plugin, ajustes (origen + token), botón de prueba de conexión, gate
  `npm run check`, CI y workflow de release para BRAT con los tres assets sueltos.
- **Qué hay (lote A)**: cliente HTTP completo (`listTasks`, `getTask`, `getTasksByIds`, `listLists`,
  `createTask`, `mutate`, `batch`, `flush` compartido), cola durable de escrituras que releen antes de
  darse por materializadas, mapa nota ↔ tarea por ruta con listeners de rename y delete, y el almacén
  único de `data.json` que migra desde el formato anterior sin perder el token. Todo con tests; sin UI.
- **Qué hay (lote B, la primera interfaz)**:
  - Comando **Enviar como tarea** (paleta y menú contextual del editor, donde se llama «Enviar a
    Lumbre»): modal con título prefijado con la selección o la línea del cursor, lista, fecha o
    «Algún día», hora, prioridad, fecha límite, notas y subtareas. Encola un `create`, crea el
    vínculo en pendiente y drena. El Markdown de la nota no se toca.
  - Panel lateral **Tareas de esta nota** (`lumbre-note-tasks`, ribbon y comando): sigue a la nota
    activa, enseña las tareas vinculadas con checkbox, chip de estado y «Abrir en Lumbre»,
    «Desvincular» con confirmación en línea y «Reintentar» sobre las operaciones con error
    recuperable; buscador para vincular una tarea que ya existe; y, si la nota tiene `lumbre-list`,
    las tareas de esa lista agrupadas por sección.
  - Comandos **Vincular esta nota a una lista** y **Quitar el vínculo con la lista**: escriben o
    borran la propiedad `lumbre-list` del frontmatter con `processFrontMatter`. Es la ÚNICA
    escritura del plugin dentro de una nota.
  - Módulos puros con tests: `src/ui/draft-from-editor.ts`, `src/ui/link-chip-state.ts`,
    `src/ui/search-filter.ts`, `src/ui/task-sections.ts` y `src/lumbre/list-cache.ts`.
- **Qué hay (lote C, el bloque y la API)**:
  - Bloque de código ```` ```lumbre ```` (`registerMarkdownCodeBlockProcessor`), renderizado en vivo
    y sin tocar el Markdown: consulta en líneas `clave: valor` (`scope`, `list`, `section`, `days`,
    `tag`, `includeDone`, `limit`, `title`), cabecera con título o descripción y botón «Actualizar»,
    casilla que completa o reabre por la cola, punto de prioridad, fecha o «Algún día», deadline con
    icono, canceladas tachadas sin casilla, agrupación por sección cuando la consulta es de una
    lista, estado vacío y pie con «Datos de HH:MM» más el aviso de que se enseña la última lectura.
  - `src/blocks/query-parser.ts`: parser propio y tolerante, con la resolución contra el
    `lumbre-list` de la nota y el catálogo de listas, la clave de caché y el filtro en cliente.
  - `src/blocks/query-cache.ts`: una entrada por consulta, TTL de 30 s, peticiones en vuelo
    deduplicadas, suscriptores por bloque y `refreshAll()` de golpe cuando la cola materializa.
  - `src/api/lumbre-api.ts`: la API pública (`app.plugins.plugins.lumbre.api`), documentada en
    `docs/API.md`, con `version`, `isConnected`, `listTasks`, `getTask`, `listLists`, `createTask`,
    `completeTask`, `reopenTask`, `linksForNote`, `openInLumbre` y `on(...)`. Todo lo que muta pasa
    por la cola; además dispara `lumbre:tasks-changed` en el workspace.
- **Qué hay (lote D, el BRL, Soplo y los adjuntos)**:
  - Comando **Anotar en el BRL**: modal mínimo (un campo de texto prefijado con la selección y dos
    botones, «Nota» y «Pensamiento»). Encola un `createBrlEntry` por la cola durable, con su
    relectura propia (`GET /api/brl/<fecha>?format=json`, buscando el id que fijó el plugin), y
    avisa con un Notice al encolar.
  - Bloque de código ```` ```lumbre-brl ````: cuerpo opcional `date: today|YYYY-MM-DD`, el Markdown
    del registro pintado con `MarkdownRenderer.render`, pie con «Datos de HH:MM» y botón
    «Actualizar». Caché propia con el mismo TTL de 30 s (`BrlCache`), clave por día.
  - Comando **Insertar el BRL de hoy como texto**: pega el Markdown en el cursor. Foto fija.
  - Comando **Soplo con la selección** (paleta y menú contextual): manda la selección o el párrafo
    del cursor a `POST /api/agent`, que corre siempre en modo previsualización, y abre un modal con
    el texto original arriba y una casilla por acción del plan, todas marcadas. «Aplicar» manda solo
    lo marcado por `POST /api/batch` a través de la cola y vincula a la nota las tareas creadas.
  - Acción **Adjuntar fichero…** por tarea en el panel: `SuggestModal` con los ficheros no-Markdown
    del vault, lectura con `app.vault.readBinary` y subida directa por `POST /api/attachments`. El
    panel enseña el número de adjuntos cuando la API lo devuelve en la tarea.
  - Módulos puros con tests: `src/brl/brl-ops.ts`, `src/soplo/plan-to-ops.ts`,
    `src/attachments/upload.ts`. El cliente gana `brl`, `brlJson`, `agent` y `uploadAttachment`.
  - Deuda de tipos cerrada: `LumbreList.pinned` y `LumbreTask.attachmentCount`, con los JSDoc de
    `someday`/`time`/`rolloverCount` e `icon`/`color`/`parentListId` puestos al día (Lumbre los
    sirve desde su SHA `861cfb4d`; los valores por defecto cubren un servidor anterior).
- **Decisiones del lote D**:
  - Las mutaciones del plan de Soplo viajan **verbatim** (`BatchOperation` de tipo `mutateRaw`): el
    `kind` y el `payload` los escribió Lumbre y son lo que describía la línea que el usuario aprobó.
    Traducirlos a la `MutationOp` del plugin recortaría los campos que el plugin no modela, o sea
    aplicaría algo distinto de lo aprobado.
  - El plan y su preview se emparejan **por índice**, que es como los construye el servidor
    (`buildPreview` hace un `map` sobre el plan). Una acción sin su línea de preview se descarta:
    no se aplica lo que no se ha visto.
  - Las acciones de BRL y de hábitos del plan no se aplican: `POST /api/batch` solo entiende de
    tareas. Se cuentan y se dicen en el Notice, en vez de tragárselas.
  - Los adjuntos NO van por la cola. La cola persiste en `data.json`, que viaja por Obsidian Sync, y
    meter ahí los bytes de un fichero de 25 MB hincharía el fichero de datos del plugin.
  - `POST /api/attachments` va con `Content-Type: application/octet-stream` SIEMPRE y el mime real
    en `x-lumbre-content-type`: SvelteKit rechaza con 403, antes del handler, un POST cuyo
    `Content-Type` sea uno de los cuatro que trata como formulario, y `text/plain` es uno de ellos.
  - La falta de consentimiento de Soplo se detecta por el **403 de `POST /api/agent`**, no por
    `GET /api/agent/consent`: ese endpoint es solo por cookie de sesión y responde 401 a un token
    Bearer, así que un plugin no puede consultarlo. **Corregido en el lote E**: Lumbre acepta ahí el
    Bearer, se pregunta antes de mandar, y el 403 del POST se queda como red de seguridad para un
    servidor anterior al cambio.
  - `BrlCache` va aparte de `QueryCache` y comparte con ella la constante del TTL: lo que guardan es
    distinto (Markdown de un día contra `LumbreTask[]` de una consulta).
  - «Insertar el BRL de hoy» NO sirve una lectura vieja si la relectura falla, a diferencia del
    bloque: eso escribe en la nota, y un texto de hace media hora pegado en el fichero ya no se
    distingue del de ahora.
- **Qué hay (lote F, el registro de diagnóstico)**:
  - `src/diagnostics/logger.ts`: `Logger` con cuatro niveles, `child(module)` para etiquetar la
    pieza (`http`, `queue`, `links`, `cache`, `block`, `panel`, `modal`, `api`, `settings`, `vault`,
    `main`) y salida DOBLE: consola filtrada por el nivel de Ajustes, y buffer circular de 1000
    eventos SIEMPRE, con independencia del nivel.
  - `src/diagnostics/redact.ts`: sustituye el token (y cualquier secreto) por `«token»` en cadenas,
    claves y valores anidados; tapa el valor de las claves prohibidas (todo lo que acabe en
    `authorization`, `token`, `apikey`, `bearer`, `password` o `secret`); recorta las cadenas a 200
    caracteres y aguanta ciclos, arrays largos y valores no serializables.
  - `src/diagnostics/errors.ts`: `describeError` (`name`, `message`, `status?`, `reason?`), con
    stack solo cuando se pide, o sea solo en `debug`.
  - `src/diagnostics/report.ts`: `buildReport()`, el texto plano que se copia. Entorno, conexión,
    cola por estado con las 10 últimas operaciones, vínculos, cachés con la edad de la entrada más
    vieja y los últimos N eventos (300 por defecto).
  - `src/diagnostics/unhandled.ts`: `guarded(logger, acción, fn)` para los callbacks que el plugin
    registra, y `unhandledEvent` para los `error` y `unhandledrejection` de la ventana.
  - `src/diagnostics/log-files.ts`: los informes guardados (`logs/lumbre-<fecha>-<hora>.log`, los 10
    últimos) y el registro en vivo (`logs/lumbre-live.log`, rotación a 1 MB con una vuelta anterior).
  - `src/diagnostics/diagnostics-modal.ts` y el comando **Mostrar diagnóstico**.
  - Instrumentado: cliente (una línea por petición con método, ruta sin origen, status, ms y bytes;
    aviso a los 3 s y al pasar de 100 peticiones por minuto), cola (cada transición con `from → to`,
    intentos y motivo, y cada `flush`), vínculos, las dos cachés, los dos bloques, el panel, los
    modales, los ajustes y la API pública.
  - Ajustes: sección «Diagnóstico» con el nivel, «Copiar registro», «Guardar registro en el vault»,
    el interruptor del registro en fichero y un resumen de estado de dos líneas.
  - API pública: `api.diagnostics.report()` y `api.diagnostics.events(n)`.
- **Decisiones del lote F**:
  - El buffer se llena con TODO, también con los `debug`, aunque el nivel sea `info`. El nivel solo
    filtra la consola. Si filtrara el buffer, «Copiar registro» tras un fallo traería justo lo que
    no sirve: los eventos posteriores a subir el nivel, nunca los de antes.
  - El token vive además en memoria (`secrets` de `main.ts`) porque `redact` es SÍNCRONO y
    `tokenStore.get()` no. Es la única forma de COMPROBAR que un evento no lo lleva, en vez de
    confiar en que cada llamador se acuerde. El almacén del token va envuelto para que un cambio en
    los ajustes actualice esa copia.
  - Nada de lo que escribe el usuario entra en `info`: ni el título de una tarea (solo en `debug` y
    recortado a 80), ni el texto de una entrada del BRL, ni lo que se busca en el panel, ni el texto
    que se manda a Soplo. De ellos van el recuento y la longitud. Sí van las RUTAS de las notas y el
    texto de la consulta de un bloque: la ruta es lo que identifica un vínculo y la consulta es una
    instrucción al plugin, no contenido.
  - `guarded` NO relanza. Relanzar desde un handler de Obsidian no arregla nada y se lleva por
    delante lo que viniera detrás; lo que faltaba era el contexto, y eso es lo que apunta.
  - Los errores de la ventana se filtran por la marca `plugin:lumbre` del stack. Sin ella son de
    otro plugin y solo se apuntan en `debug`: la consola de Obsidian es de todos.
  - `PLUGIN_DATA_VERSION` sube a 2 por los dos ajustes nuevos (`logLevel`, `liveLog`). Un
    `data.json` de la 1 los estrena en su valor por defecto sin perder nada, y `PluginStore` guarda
    de qué versión venía para poder apuntarlo al arrancar.
  - El nombre del fichero de informe lleva la hora como `HHMMSS`, sin dos puntos: un `:` en un
    nombre dentro del vault mete a Obsidian Sync en bucle.
- **Qué hay (lote E, la foto semanal)**:
  - `src/review/weekly-snapshot.ts`: `buildWeeklySnapshot(deps, options)` compone el Markdown de la
    revisión con tres apartados. **Vencidas y arrastradas** (`scope: overdue` más lo que tenga
    `rolloverCount >= 3`), **Listas sin próxima acción** (listas con pendientes y ninguna con fecha,
    agrupado en cliente) y **Muestra de Algún día** (5 tareas, semilla del día). Sin red propia: el
    cliente entra por inyección. Módulo puro con tests.
  - Comando **Insertar la foto semanal**: pega ese texto en el cursor. Foto FIJA, como la del BRL.
  - API pública: `api.weeklySnapshot(options?)`, documentada en `docs/API.md` con el ejemplo de
    Templater.
  - `client.agentConsent()`: `GET /api/agent/consent` con el token Bearer, que Lumbre va a aceptar.
    Devuelve `granted | missing | unknown`. El modal de Soplo lo consulta ANTES de mandar el texto:
    con `missing` enseña el aviso con el enlace a `<origen>/settings` y no manda nada.
  - `LumbreTask.rolloverCount` pasa a OPCIONAL, como `attachmentCount`: ausente es "la fila cruda no
    lo traía", que es lo que hace posible distinguirlo de un cero de verdad.
- **Decisiones del lote E**:
  - `rolloverCount` ausente contra cero. Sin esa distinción, un Lumbre anterior al SHA `861cfb4d`
    haría que la foto dijera "0 arrastradas", que es una mentira con forma de dato. Ahora el
    apartado dice «arrastradas: este Lumbre no lo informa» cuando NINGUNA tarea viva trae el campo.
    Esto cambia el tipo público: `taskFromDraft` ya no pone `0` y `taskFromApi` solo lo copia si
    viene.
  - Las arrastradas se buscan en una lectura de `scope: all`, no en un scope propio: ningún scope
    del servidor filtra por `rolloverCount`, así que el filtro es de aquí. Son dos peticiones para
    ese apartado, no una.
  - Las listas se recorren ENTERAS, sin saltarse las de `taskCount: 0`: ese contador también sale en
    cero contra un servidor que no lo manda, y usarlo para ahorrar peticiones vaciaría el apartado
    justo en el caso que interesa.
  - El intervalo entre peticiones por lista sale de `REQUESTS_PER_MINUTE_WARN` del cliente
    (`60_000 / 100` = 600 ms), no de un número a ojo: el apartado gasta una petición por lista y el
    límite del servidor es 120/min.
  - La muestra de «Algún día» se ordena por el hash de `semilla + id` y se cortan las cinco
    primeras, en vez de barajar: así depende SOLO de la semilla y de los ids, no del orden de
    llegada. La semilla por defecto es el día local, así que la foto de la mañana y la de la tarde
    coinciden.
  - Con los TRES apartados en rojo, el comando no pega nada (lo que quedaría en la nota serían tres
    líneas de error). Con uno o dos sí pega: la línea dice cuál falló y el texto no miente.
  - `weeklySnapshot` NO va por la caché de consultas: una foto es de ahora, no de hace 30 segundos.
    Y `notes: 'none'` en todas sus lecturas, que las notas largas no hacen falta para esto.
  - `agentConsent()` trata el 401 como `unknown`, no como token malo: un Lumbre anterior al cambio
    responde 401 a un token VÁLIDO porque ese endpoint solo aceptaba la cookie de sesión. Esto
    corrige la decisión del lote D, que daba el endpoint por inconsultable desde el plugin; el 403
    del `POST /api/agent` sigue detectándose igual, y es lo que cubre a ese Lumbre anterior.
- **Lote G: arreglos de la revisión fría** (sobre `e1ac5d8`; cada uno con su test):
  - **G1** `PluginStore.save()` RELEE `data.json` y lo UNE con la memoria (cola por `id` de
    operación, vínculos por `id`, gana el `updatedAt` más reciente; los ajustes, la memoria). Antes,
    un Obsidian abierto desde hacía horas pisaba lo que otro dispositivo había subido por Sync.
  - **G2** El éxito PARCIAL de `POST /api/batch` deja el lote ENVIADO y guarda `failedItems` con el
    índice y el motivo de cada op rechazada; reintentar un lote con `sentAt` ya no lo reenvía (un
    `addSubtask` no es idempotente) y el Notice dice qué acciones no entraron.
  - **G3** La cola se poda al escribirla: fuera las materializadas de más de 7 días, 50 como mucho, y
    de lo releído solo se guarda `materializedAt` (la `LumbreTask` entera viajaba por Sync).
  - **G4** El cuerpo de un bloque mal escrito ya no entra en el informe: en `info` va `sourceLength`
    y el texto solo en `debug` (`src/blocks/block-log.ts`, para el bloque de tareas y el del BRL).
  - **G5** `openTaskInLumbre` (`src/ui/open-in-lumbre.ts`) manda en los dos llamadores: la web
    SIEMPRE salvo en macOS, donde se intenta `lumbre://` con repliegue a la web.
  - **G6** «Descartar» junto a «Reintentar» para las operaciones paradas
    (`src/ui/operation-actions.ts`), y `pendingOperationFor` devuelve la MÁS RECIENTE.
  - **G7** `getTask`/`getTasksByIds` van con `includeArchived=true`, y una `sent` que nunca confirma
    pasa a `recoverable_error` al agotar `MAX_ATTEMPTS` en vez de reintentarse para siempre.
  - **G8** `flush()` encadena UN flush de seguimiento si ya hay otro en vuelo, y `main.ts` registra
    un drenaje periódico de 60 s con `registerInterval` (`src/lumbre/queue-drain.ts`).
  - **G9** El modal de Soplo sale de «Aplicando…» si `apply` lanza (`src/soplo/apply-flow.ts`), con
    los botones habilitados y «Reintentar» volviendo a APLICAR; `applySoploPlan` apunta el fallo.
  - **G10** UN `client.flush()` por `runFlush` (los endpoints de escritura ya drenan al responder) y
    un 429 no gasta intento: aplaza con `Retry-After` o 30 s.
  - **G11** README y `docs/API.md` dicen que el plugin es de escritorio Y móvil.
- **Decisiones del lote G**:
  - La unión de `save()` respeta lo que se quitó A PROPÓSITO: `PluginStore` recuerda en memoria los
    ids que se han descartado o podado, y la unión no los resucita desde la foto de disco.
  - `applySoploPlan` NO va envuelto en `guarded`: `guarded` se traga la excepción por diseño, y el
    modal cerraría como si todo hubiera ido bien. Se apunta el error con su contexto y se RELANZA,
    que es lo que hace visible el fallo donde el usuario está mirando.
  - Los tres endpoints de escritura de Lumbre (`/api/ingest`, `/api/mutations`, `/api/batch`) llaman
    a `runHeadlessDrain` antes de responder, así que tras un envío recién aceptado no hace falta
    `POST /api/sync/flush`. Ese drenaje solo se gasta por las operaciones que ya venían aceptadas de
    un flush anterior, y va uno para todas.
  - Un 429 no cuenta como intento fallido: no ha fallado la operación, ha fallado el momento.
- **Lote H: segunda tanda de la revisión fría** (cupo de peticiones, desajuste con la API y calidad;
  cada arreglo con su test):
  - **H1** `QueryCache.refreshSoon()` COALESCE las rondas de refresco (ventana de 250 ms,
    `REFRESH_COALESCE_MS`): la cola avisa una vez por operación, así que materializar un lote de diez
    eran diez rondas de lecturas, una por consulta montada, contra el límite de 120 peticiones/min.
  - **H2** Las consultas mandan SIEMPRE `limit`, y por defecto el tope del servidor (500,
    `MAX_TASKS_LIMIT`): el default de `GET /api/tasks` es 200 y se estaba dejando fuera media lista
    sin decirlo. Con `tag` viaja el tope, no el `limit` escrito. Si la lectura llega a 500, el pie del
    bloque y el buscador del panel dicen «Resultados parciales (500 tareas leídas)»; el buscador
    (`src/ui/task-search.ts`) apunta además `partial` en el registro.
  - **H3** `notes` es una clave de la consulta (`none` por defecto, admite `full`) y entra en la clave
    de caché. Antes iba fijo a `none`, así que `task.notes` era `null` siempre, también en
    `api.listTasks()`, y `docs/API.md` no lo decía.
  - **H4** El pie del bloque pinta el MOTIVO real (`src/blocks/block-footer.ts`), no «Sin conexión»
    para todo: un token caducado y un corte de red no se arreglan en el mismo sitio. Vale para los dos
    bloques.
  - **H5** La laguna de `includeArchived` ya la cerró G7 en `getTasksByIds` (comprobado contra
    `+server.ts` de Lumbre: `?ids=` respeta el parámetro), así que un vínculo a una tarea archivada ya
    se releía sin error; el test se queda como guardia. Lo que faltaba era ENSEÑARLO: chip «Archivada»
    en el panel y en el bloque (`src/ui/task-state-labels.ts`).
  - **H6** `LinkStore.markCreated()` colgado de `vault.on('create')`, y la relectura de vínculos quita
    el huérfano si `vault.getAbstractFileByPath` dice que la nota está. Un delete + create en la misma
    ruta (lo que hace Obsidian Sync cuando la nota vuelve de otro dispositivo) dejaba «La nota ya no
    existe» para siempre.
  - **H7** NO se arregla, y se documenta por qué: un `status` se confirma solo por `done`, así que
    reabrir lo que ya estaba abierto se da por materializado al instante. La señal que lo distinguiría
    es un `updatedAt` de la fila posterior al `sentAt`, y `GET /api/tasks` no lo sirve (`serializeTask`
    da `createdAt` y `notesUpdatedAt`, y ninguno se mueve al completar). Comentado en
    `matchesOperation` y con el test en `it.todo`.
  - **H8** `migrate` copia los ajustes enteros (`{ ...DEFAULT_SETTINGS, ...settings }`) y solo corrige
    los dos que pueden venir mal escritos (origen normalizado con `normalizeOrigin`, nivel de log
    dentro del enum). Antes los reconstruía campo a campo y un ajuste escrito por una versión más
    nueva se perdía en cada carga.
  - **H9** `peek()` ya no CREA la entrada, en las dos cachés, y las entradas sin bloques montados que
    llevan más de 10 minutos (`IDLE_ENTRY_TTL_MS`) se desalojan en el siguiente `refreshAll` o al irse
    su último suscriptor.
  - **H10** `onunload` aguanta un `onload` que falló antes de construir el registro y la cola.
  - **H11** Ningún `addEventListener` a pelo en `src/`: todo por `registerDomEvent`, con un test de
    FORMA que lee los ficheros (`src/dom-events.test.ts`). Los modales llevan un `Component` propio
    (`Modal` NO es un `Component`), que se carga al abrir y se descarga al cerrar.
  - **H12** El plan de Soplo se trocea al tope de `POST /api/batch` (`planToBatches`), un `batch` de
    la cola por trozo. Un plan de más de 200 acciones se rechazaba entero con los vínculos de sus
    altas ya creados.
- **Decisiones del lote H**:
  - El `limit` por defecto pasa a 500 para TODA consulta, no solo para las que filtran en cliente: sin
    `limit` el servidor aplicaba su 200 y el recorte era igual de silencioso. El precio es una
    respuesta más grande en un vault con muchas tareas, y `notes=none` es lo que la mantiene barata.
  - «Parcial» se declara cuando la lectura trae exactamente 500. No se puede distinguir de un vault
    con 500 justas, y decir de menos es lo único que el usuario no puede corregir mirando.
  - `refreshSoon` suelta el pestillo ANTES de leer: lo que materialice durante la ronda merece la
    suya detrás, o su cambio no se vería hasta que venciera el TTL de 30 s.
  - `registerDomEvent` en una vista que se repinta (el panel, el bloque) acumula un registro por
    pintado hasta que se cierra, porque Obsidian solo los suelta al descargar el `Component`. Se acepta
    a cambio de que no quede ni un listener sin dueño; los modales no lo pagan porque descargan su
    `Component` al cerrarse.
- **Lote I: los cupos reales de la API y el pestillo del token** (los tres límites nuevos los midió
  la sesión de Lumbre en su código, con fichero y línea; cada arreglo con su test):
  - **I1** El contador de peticiones deja de ser UN cubo global de 120 y pasa a un cubo POR ENDPOINT
    (`src/lumbre/client.ts`), con el techo real de cada uno: `GET /api/tasks` 120/min,
    `POST /api/mutations` 60/min, `POST /api/sync/flush` 60/min y `POST /api/agent` 30/min. Los cubos
    del servidor son por token y con clave distinta por endpoint, o sea INDEPENDIENTES: gastar las 120
    de lecturas no resta ni una de las 60 de mutaciones. Constantes nuevas `TASKS_RATE_LIMIT`,
    `MUTATIONS_RATE_LIMIT`, `SYNC_FLUSH_RATE_LIMIT`, `AGENT_RATE_LIMIT`, `DEFAULT_RATE_LIMIT` y
    `RATE_WARN_RATIO` (5/6, la proporción que ya había) con `warnThreshold(limit)`; desaparece
    `REQUESTS_PER_MINUTE_WARN`. Con el cubo global, Soplo se comía un 429 en `/api/agent` a la
    petición 30 con el contador marcando 30, muy por debajo del aviso, y el registro no decía nada.
  - **I2** Un 401 en cualquier lectura echa un pestillo que apaga las lecturas de TODAS las
    superficies a la vez, no una por una: campo `readsLocked`, método privado `gated`, getter
    `readsAreLocked` y `unlockReads(source)`. Envuelve `listTasks`, `getTasksByIds`, `getTask`,
    `listLists`, `brl` y `brlJson`; quedan fuera `ping()` y `agentConsent()` (este por su semántica
    documentada de 401 → `unknown`). Las escrituras NO pasan por el pestillo: la cola tiene su propia
    clasificación y su reintento manual, y enredarlos dejaría una operación pendiente sin reintentar.
    Un 403 tampoco lo dispara, porque aquí significa que falta el consentimiento de Soplo.
    El motivo es lo que lo hizo urgente: Lumbre tiene un cubo aparte de 20 peticiones/min POR IP para
    token inválido, aplicado ANTES del 401 y compartido entre `/api/tasks`, `/api/sync/flush` y la
    autenticación del agente. Cuenta por IP, no por token, así que varias superficies reintentando con
    el token caducado llegan a 20 enseguida y a partir de ahí la IP entera come 429, incluidas las
    peticiones con el token BUENO cuando el usuario lo renueva. Era un fallo que sobrevivía a que el
    usuario arreglara su token.
  - **I2b** Reabren el pestillo el cambio de token en Ajustes (`src/settings.ts`) y el botón
    «Reintentar» del panel (`src/ui/note-tasks-view.ts`). `createClient()` devuelve la instancia
    COMPARTIDA (`src/main.ts:386`), comprobado, así que el desbloqueo llega a todas las superficies y
    no a una copia suelta.
  - **I3** `listsWithoutNextActionSection` (`src/review/weekly-snapshot.ts`) reutiliza el pool de
    `scope: all, limit: 500` que la foto semanal ya pedía, agrupando en memoria por ID de lista, en
    vez de una petición por lista. Si ese pool falló o llegó justo al tope, cae al camino anterior.
    `?ids=` (200 ids por petición y coste 1 del cubo) NO aplicaba: la consulta no es por ids conocidos.
  - **I4** El separador del hash de la muestra de «Algún día» (`src/review/weekly-snapshot.ts`) era un
    byte NUL CRUDO dentro del template literal, y eso hacía BINARIO el fichero entero para las
    herramientas de texto: `grep` respondía «Binary file matches» sin las líneas y `file` lo llamaba
    `application/octet-stream`. Ahora es el escape `\x1f`.
- **Decisiones del lote I**:
  - Para `/api/agent` se usa el límite de 30 y no el de 45 del modo live, porque el plugin no manda
    ese modo. Si algún día lo mandara, el techo sube; equivocarse por abajo solo cuesta un aviso de
    más, y por arriba cuesta un 429 sin avisar.
  - El pestillo de I2 es del CLIENTE y no de cada caché o cada vista, precisamente porque el cubo que
    lo motiva se cuenta por IP: un pestillo por superficie no habría arreglado nada.
  - Agrupar por ID de lista y nunca por nombre, para no fundir dos listas homónimas en una.
  - Cambiar el separador de I4 CAMBIA el hash, y por tanto qué tareas concretas salen en la muestra de
    «Algún día». Se acepta: lo que importa es que sea determinista por día, y lo sigue siendo. Los
    tests aseveran esa propiedad y no ids concretos, así que ninguno hubo que tocarlo.
  - Los dos arreglos se verificaron ROMPIÉNDOLOS: al sustituir el pestillo compartido por un flag
    local caen dos tests (uno recibe `{ok: true}` donde esperaba el 401 y otro cuenta dos avisos donde
    esperaba uno); al volver a un cubo único caen los dos de independencia de cubos.
- **Qué falta**: la decisión de dónde vive el token; las tareas están en la lista `lumbre-obsidian`
  de Lumbre, no aquí.
- **Lote J: vínculos nota ↔ lista por `/api/list-links`** (paso 1 de 4 de la tarea `5800b32a`):
  - **Qué hay**: `linkNoteToList`/`unlinkNoteFromList` (`src/main.ts`) siguen escribiendo `lumbre-list`
    en el frontmatter, la ÚNICA escritura del plugin en la nota, y además encolan un `link`/`unlink`
    contra `POST /api/list-links` (kind nuevo `listLink` en `src/lumbre/queue.ts`, métodos
    `listLink`/`listUnlink`/`listLinks` en `src/lumbre/client.ts`). Solo viaja la RUTA de la nota
    (por su `obsidian://open?vault=&file=`, `src/links/deep-link.ts`), nunca el contenido. Un
    renombrado (nota o carpeta) reemite `unlink` de la url vieja → `link` con la nueva, en ese orden
    (`renameListLinkChanges`, `src/links/note-list-link-store.ts`); un borrado encola el `unlink` y
    quita la entrada.
  - **Por qué un almacén nuevo**: el servidor guarda la url TAL CUAL llega (solo `trim`, sin
    normalizar), así que un `unlink` tiene que mandar la MISMA cadena que mandó el `link`, byte a
    byte, o responde 200 con `removed: false` sin haber quitado nada (fallo MUDO). `NoteListLinkStore`
    guarda esa url exacta por nota (`data.json` versión 3, campo `noteListLinks`; migración desde la
    2 arranca con el registro vacío).
  - **Decisión**: 404 (lista de otra cuenta o borrada) es un `FailureReason` nuevo, `not_found`, y
    ENTRA en `PERMANENT_REASONS` de la cola: no se reintenta solo, igual que `bad_request` y
    `unauthorized`. Antes de este lote un 404 cualquiera caía en `server` (recuperable) porque ningún
    endpoint lo devolvía en un caso legítimo.
  - **Qué falta**: los pasos 2 a 4 de la tarea (mostrar el vínculo en el panel, tareas de otro agente
    en paralelo sobre `src/blocks/*` y `src/ui/note-tasks-view.ts`); ver la lista `lumbre-obsidian`.
- **Decisiones del lote B**: las listas se cachean en memoria cinco minutos (`ListCache`), no en
  `data.json`; las secciones de la lista de proyecto se agrupan en cliente por el `section` que ya
  trae cada tarea, sin usar `includeSections=1`, que el cliente todavía no soporta.
- **Decisiones del lote C**:
  - Nombrar una lista sin escribir `scope` significa la lista ENTERA (`scope: all`), no lo de hoy de
    esa lista. Vale igual para el `lumbre-list` de la nota.
  - La clave de caché se calcula sobre lo que se PIDE al servidor, no sobre lo escrito: dos bloques
    con el mismo `scope` y distinto `title` comparten una sola petición.
  - Con `tag`, el `limit` NO viaja al servidor (recortaría antes de filtrar) y se aplica en cliente.
  - La caché guarda las entradas aunque se queden sin bloques montados: en modo lectura un bloque se
    desmonta y se remonta con cada edición, y conservarlas es lo que evita la petición y el parpadeo.
  - El bloque no lleva «Abrir en Lumbre» por tarea: son filas densas y una lista de 200 tareas se
    llenaría de elementos enfocables. Para saltar a Lumbre están el panel y `api.openInLumbre(id)`.
  - `OperationQueue` gana un `onMaterialized`: es el único punto en que un cambio deja de ser una
    promesa, y de ahí cuelga la invalidación de la caché de los bloques.
- **Lote K: contexto de la tarea en el bloque** (tarea `8c88a2c1` de Lumbre; PINTADO EN VIVO, nunca
  escrito en el Markdown):
  - Clave nueva del bloque `lumbre`, `context: none | full` (por defecto `none`, el bloque queda
    como hoy). Entra en la clave de caché (`queryKey`) APARTE de `notes`: dos consultas que piden lo
    MISMO al servidor pero difieren en `context` no comparten entrada, porque una dispara peticiones
    extra de subtareas y la otra no. `context: full` implica `notes: full` en la petición; si el
    bloque escribe `notes: none` a la vez, gana `context` y `QueryCache` lo apunta en `debug`.
  - Con `context: full`, cada fila pinta bajo el título (`LumbreTaskBlock.renderTaskContext`,
    `src/blocks/task-block.ts`): el chip de estado (`contextStateLabel`, solo si la tarea no está
    simplemente pendiente: completada, cancelada o archivada; reutiliza el orden de
    `taskStateLabels` y añade «Completada», que ese módulo no cubría porque el panel ya lo dice con
    la casilla marcada), el extracto de las notas en texto plano (`noteExcerpt`, tope de 200
    caracteres o 3 líneas, `textContent` nunca `innerHTML`) y las subtareas, con un carácter (✓/○)
    que NO es una casilla interactiva ni de Markdown: una subtarea se marca desde el panel o desde
    Lumbre, no desde este bloque de solo lectura. Módulo puro nuevo con tests:
    `src/blocks/task-context.ts`.
  - **Hecho medido antes de decidir cómo pedir las subtareas** (repo de Lumbre,
    `src/routes/api/tasks/+server.ts`, SHA `543017e271a526ba4257424bcb3977d264643e9b`, JSDoc de
    `?ids=` en torno a la línea 146): `?ids=` **NO** adjunta `subtasks` a propósito («A DIFERENCIA de
    `id`, NO adjunta `subtasks`... en un lote de hasta 200 infla la respuesta justo en el camino que
    este parámetro existe para adelgazar», 25 ago 2026). Solo `?id=` las trae, y solo para tareas de
    primer nivel. Una petición por tarea para un bloque de 200 filas reventaría el cubo de 120/min de
    `GET /api/tasks`, así que `QueryCache.attachContextSubtasks` limita el lookup (`client.getTask`,
    una petición por tarea) a las primeras `CONTEXT_SUBTASK_TASK_CAP` (20) tareas de primer nivel de
    la lectura, en el orden que ya trae el listado. Si hubo que recortar, `QuerySnapshot.subtasksLimited`
    se pone a `true` y el pie del bloque lo dice (`contextSubtasksLimitedNote`,
    `src/blocks/block-footer.ts`). Un `getTask` que falla para una tarea concreta no tira la lectura
    entera: esa tarea sencillamente se queda sin subtareas.
  - `QueryCacheOptions.client` acepta `getTask` como OPCIONAL (`Partial<Pick<LumbreClient,
    'getTask'>>`, a diferencia de `listTasks`): sin él (o con `context: none`), la caché nunca lo
    llama, así que un test que no toca `context: full` no tiene que simularlo.
  - Test de forma sobre el DOM del bloque (`src/blocks/task-block.test.ts`, nuevo): con
    `context: full`, ninguna línea es una casilla de Markdown (la única `<input type="checkbox">`
    sigue siendo la de completar/reabrir la tarea) y una pendiente sin notas ni subtareas no pinta
    nada de contexto. Para esto, `src/test/obsidian-mock.ts` gana un `MarkdownRenderChild` que SÍ
    guarda `containerEl` (el mock anterior no lo hacía porque nada lo necesitaba) y
    `src/test/fake-dom.ts` es un DOM de mentira mínimo (`createDiv`/`createSpan`/`createEl`/
    `createFragment`, sin `jsdom` ni `happy-dom`) con lo justo que usan los bloques.
- **Decisiones del lote K**:
  - El tope de subtareas (`CONTEXT_SUBTASK_TASK_CAP = 20`) se aplica sobre el orden del LISTADO del
    servidor, no sobre lo que queda tras el filtro de cliente (`tag`/`limit`): la caché no sabe qué
    va a filtrar cada bloque suscrito a la misma consulta, así que recortar ahí sería recortar para
    unos y no para otros.
  - El chip de «Completada» no se añadió a `taskStateLabels` (el módulo que usa el panel): el panel
    ya lo dice con la casilla marcada y añadir el label ahí habría sido ruido nuevo en una superficie
    que no lo pidió. `contextStateLabel` (`task-context.ts`) reutiliza `taskStateLabels` y solo
    añade el caso que le falta.
