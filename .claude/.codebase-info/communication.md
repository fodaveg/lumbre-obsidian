# Comunicación

*Última actualización: 2026-09-18*

## API de Lumbre (`src/lumbre/client.ts`)

Todo pasa por `LumbreClient.request`: `Authorization: Bearer <token>` (única lectura del token),
`Content-Type: application/json` si hay cuerpo, `throw: false`, error de red tragado como
`{ ok: false, reason: 'network' }`. Resultado uniforme `LumbreResult<T>`.

| Método del cliente | Endpoint | Cupo/min (cubo local) | Notas |
|---|---|---|---|
| `ping` | `GET /api/tasks?limit=1&notes=none` | 120 | guarda `lastPing` para el informe |
| `listTasks(params)` | `GET /api/tasks` | 120 | pestillo de lecturas; `limit` siempre |
| `tasksUpdatedSince` | `GET /api/tasks?updatedSince=` | 120 | orden `updatedAt` asc, sin filtro de visibilidad |
| `getTask(id)` / `getTasksByIds(ids)` | `GET /api/tasks?id=` / `?ids=` | 120 | `includeArchived=true`; `?ids=` no trae subtareas, `?id=` sí |
| `listLists` | `GET /api/lists` | por defecto 120 | |
| `listNotes(listId)` | `GET /api/tasks?includeLists=1` | por defecto 120 (mismo endpoint y cupo que `listLists`) | `{ found, notes }`; relectura de un `setListNotes` |
| `createTask(draft, clientTaskId)` | `POST /api/ingest` | por defecto | el id lo fija el plugin |
| `mutate(op)` | `POST /api/mutations` | 60 | devuelve `outcome?` (`applied`, `noop`, `not-found`, `queued`) |
| `batch(ops)` | `POST /api/batch` | por defecto | tope 200 ops; 200 con informe por op |
| `flush` | `POST /api/sync/flush` | 60 | un solo flush en vuelo |
| `brl(date)` / `brlJson(date)` | `GET /api/brl/<date>` (`?format=json`) | por defecto | Markdown o JSON; 403 = add-on apagado |
| `agent(text)` | `POST /api/agent` | 30 | siempre previsualización; 403 = sin consentimiento |
| `agentConsent` | `GET /api/agent/consent` | por defecto | `granted`, `missing`, `unknown` (401 → `unknown`, no pasa por el pestillo) |
| `uploadAttachment` | `POST /api/attachments?taskId=` | por defecto | `Content-Type: application/octet-stream` siempre, mime real en `x-lumbre-content-type`, nombre en `x-lumbre-filename`; tope 25 MB comprobado antes |
| `listLink` / `listUnlink` / `listLinks` | `POST /api/list-links`, `GET` | 60 escritura / 120 lectura | url exacta |
| `taskLink` / `taskUnlink` / `taskLinks` | `POST /api/task-links`, `GET` | 60 / 120 | url exacta; respuesta trae `archived` (no se muestra) |
| `exportData` | `GET /api/export` | 10 | texto tal cual, bytes reales por `TextEncoder` |
| `getAttachment(id)` | `GET /api/attachments/<id>` | 120 (`ATTACHMENT_READ_RATE_LIMIT`) | bytes crudos; pasa por el pestillo de lecturas |
| `deleteAttachment(id)` | `DELETE /api/attachments/<id>` | 60 (`ATTACHMENT_DELETE_RATE_LIMIT`) | soft-delete; fuera del pestillo y fuera de la cola |

`FailureReason`: `no_token`, `unauthorized` (401), `bad_request` (400), `not_found` (404),
`rate_limited` (429 con `retryAfterSeconds`), `network`, `server` (5xx), `too_large`.
`describeFailure(reason, status)` da el texto para el usuario.

### Cubos por endpoint
`countRequest` lleva un `RateBucket` por `MÉTODO RUTA` con ventana de un minuto y avisa (`warn`)
al superar `warnThreshold(limit)` = 5/6 del límite. Son cubos independientes porque los del
servidor también lo son (por token y por endpoint). Además Lumbre tiene un cubo de 20/min POR IP
para token inválido, previo al 401: por eso existe el pestillo.

`routeOf` normaliza `/api/attachments/<id>` a `/api/attachments/:id` antes de contar: sin eso cada
id abriría su propio cubo y el aviso del 5/6 nunca llegaría a sonar.

`ATTACHMENT_READ_RATE_LIMIT` (120) y `ATTACHMENT_DELETE_RATE_LIMIT` (60): MEDIDOS el 18 de
septiembre de 2026 en el repo de Lumbre (`origin/main` `719ee852d`),
`src/routes/api/attachments/[id]/+server.ts` líneas 59 y 122, sobre las claves `attachment:<token>`
y `attachments-delete:<token>`. El JSDoc de `client.ts` los citó primero como contrato del encargo
que los añadió (`9e7d031d`) y se corrigió con esa medición al cerrar el lote.

### Pestillo de lecturas
`gated(method, path, run)`: si `readsLocked`, falla sin gastar petición; un 401 real lo echa para
todo el cliente. Cubre `listTasks`, `tasksUpdatedSince`, `getTask`, `getTasksByIds`, `listLists`,
`brl`, `brlJson`, `exportData`. Fuera: `ping`, `agentConsent` y todas las escrituras (la cola tiene
su propia clasificación). Lo sueltan `unlockReads('settings')` al cambiar el token y
`unlockReads('panel')` desde «Reintentar». `readsAreLocked` lo consultan el sondeo y las superficies.

### Registro de peticiones
Un evento por petición: método, ruta sin origen ni query, status, ms, bytes; `warn` si falla o
supera `SLOW_REQUEST_MS` (3 s). La query solo en `debug`.

## Eventos internos del plugin

| Canal | Emisor | Receptores |
|---|---|---|
| `dataListeners` / `notifyDataChange()` (`main.ts`) | cola, vínculos, change-feed, cualquier gesto | panel y bloques (repintan sin red) |
| `QueryCache.subscribe` | `QueryCache.notify` tras cada lectura | bloques ```lumbre```, `api.listTasks` |
| `BrlCache.subscribe` | `BrlCache` | bloques ```lumbre-brl``` |
| `queue.onMaterialized` | `OperationQueue` | `main.ts`: `refreshBlocks`, `emitTaskLinksForMaterialized` |
| `QueryCache.onRefresh` | tras cada lectura buena | `api.notifyTasksChanged()` |
| `workspace.trigger('lumbre:tasks-changed')` | `LumbreApi.notifyTasksChanged` | scripts externos |
| `api.on('tasks-changed' \| 'connection-changed')` | API | scripts externos |
| `Logger.onEvent` | logger | `LiveLog` (solo `warn` y `error`) |

## Eventos de Obsidian que se escuchan

`vault.on('rename' | 'delete' | 'create')`, `workspace.on('editor-menu' | 'active-leaf-change' |
'file-open')`, `metadataCache.on('changed')` (panel), `window` `online` / `offline` / `error` /
`unhandledrejection`. Todos por `registerEvent` o `registerDomEvent`.

## Integraciones externas

- **Lumbre** (`https://app.lumbre.pro` por defecto, configurable): la única.
- **Obsidian Sync**: no es una integración explícita pero condiciona `data.json` (ver
  [storage.md](./storage.md)).
- **BRAT**: instalación y actualización por release de GitHub con tres assets sueltos.
- **Dataview / js-engine / Templater**: consumidores de la API pública.
