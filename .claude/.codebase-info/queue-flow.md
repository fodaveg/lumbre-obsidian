# Flujo de la cola de mutaciones

*Última actualización: 2026-09-14*

Fichero: `src/lumbre/queue.ts` (`OperationQueue`). No importa `obsidian`. Persiste por
`QueueStorage` (`readQueue`/`writeQueue`/`deviceId`), que cumple `PluginStore`. Recibe un
`Pick<LumbreClient>` con exactamente los métodos que usa.

## Por qué existe

Un 200 de `/api/ingest`, `/api/mutations` o `/api/batch` significa «encolado en el servidor», no
«materializado». Cada operación se envía una vez y luego se RELEE hasta confirmarla. Excepción
desde la 0.1.12: `POST /api/mutations` puede traer `outcome`, que ya es la confirmación.

## Kinds

| `kind` | Quién lo encola | Envío | Relectura (`reread`) |
|---|---|---|---|
| `create` | Enviar como tarea, `api.createTask` | `client.createTask(draft, clientTaskId)` (`POST /api/ingest`) | `getTask(clientTaskId)` existe |
| `status` | casilla de bloque, panel, `api.completeTask/reopenTask` | `client.mutate({op:'complete'})` | `outcome` si viene; si no `getTask` y `task.done === done` |
| `brl` | Anotar en el BRL | `client.mutate({op:'createBrlEntry', entryId})` | `brlJson(date)` contiene `entryId` |
| `batch` | plan de Soplo | `client.batch(ops)` (`POST /api/batch`) | `getTasksByIds(createdTaskIds)` menos los rechazados; sin altas se confirma solo |
| `listLink` | vincular o quitar lista, rename, barrido | `client.listLink/listUnlink` (`POST /api/list-links`) | `listLinks(listId)` contiene o no la url exacta |
| `notes` | Guardar esta nota en la tarea | `client.mutate({op:'update', notes})` | `outcome` si viene; si no `getTask` y `notes` contiene la cabecera de la foto |
| `taskLink` | vincular tarea existente, materialización de un `create`, rename, barrido, backfill | `client.taskLink/taskUnlink` (`POST /api/task-links`) | `taskLinks(taskId)` contiene o no la url exacta |

Los ids que fija el plugin (`clientTaskId`, `entryId`) hacen idempotente el reenvío. `taskLink`
es un kind aparte de `listLink` a propósito: una cola ya persistida desde la 0.1.10 tiene
`kind: 'listLink'` y no se traduce al vuelo.

## Estados (`OperationState`)

```
pending_local ──send ok──▶ sent ──confirm──▶ materialized (fin)
      │                     │
      │ 400/401/403/404     │ 'missing' × MAX_ATTEMPTS (5)
      ▼                     ▼
   rejected           recoverable_error ◀── red / 5xx (attempts += 1) / 429 (sin gastar intento, nextAttemptAt)
```

- `PERMANENT_REASONS` = `unauthorized`, `bad_request`, `not_found`. No se reintentan solos.
- `no_token`: no cuenta como intento; el flush se para tal cual.
- `rate_limited`: para el flush entero, `nextAttemptAt` = `Retry-After` o `RATE_LIMIT_BACKOFF_MS` (30 s).
- `retry(id)`: intentos a 0, `nextAttemptAt` null, vuelve a `sent` si tenía `sentAt` (relee, no reenvía).
- `discard(id)`: saca de la cola sin deshacer nada en Lumbre.
- `isActionable`: ni `materialized`, ni `rejected`, ni agotada, ni esperando un 429.

## Un `flush()`

1. `flush()` admite UN flush en vuelo y UNO de seguimiento encadenado (`queuedFlush`); quien
   llegue con ambos ocupados espera al encadenado.
2. `runFlush` lee la cola, filtra `mine()` por `deviceId` (las de otro dispositivo se saltan con un
   `warn`) y luego `actionable`.
3. `onceDrain` envuelve `client.flush()` (`POST /api/sync/flush`, cupo 60/min): se gasta como
   máximo UNA vez por flush, y solo para operaciones que ya venían con `sentAt` de un flush
   anterior. Las recién enviadas no lo necesitan porque los endpoints de escritura ya drenan.
4. Por operación, `process`:
   - sin `sentAt`: `send` → `sent`; si `outcomeOf` (solo `status` y `notes`) da `applied|noop` →
     `materializeByOutcome`; `not-found` → `rejectByOutcome` sin gastar intento; `queued` o
     ausente → sigue a la relectura.
   - con `sentAt`: `drain()` y relectura.
   - `confirm` relee hasta 2 veces con `REREAD_DELAY_MS` (1 s) entre medias. `confirmed` →
     `materialized`, `materializedAt`, `onMaterialized(operation)`. `missing` → `attempts += 1`,
     queda `sent` o pasa a `recoverable_error` al llegar a `MAX_ATTEMPTS`.
5. Se para con `no_token` o `rate_limited`.

## Qué cuelga de `onMaterialized` (`src/main.ts`)

- `refreshBlocks()` → `notifyDataChange()` + `queries.refreshSoon()` (coalescido 250 ms).
- `emitTaskLinksForMaterialized(operation)`: para un `create` o las altas de un `batch`, encola
  `taskLink link` y guarda `deepLink` en `LinkStore`.

## Persistencia y poda

- Todo camino de escritura pasa por `write()`, que aplica `pruneQueue`: fuera las
  `materialized` de más de `MATERIALIZED_TTL_MS` (7 días) y solo las `MAX_MATERIALIZED` (50) más
  recientes. Lo no materializado no se toca nunca.
- De lo releído no se guarda la tarea; solo `materializedAt`. Lo que sí viaja en la operación es lo
  que hay que mandar (`draft`, `entry`, `notes`, `ops`).
- `PluginStore.save()` relee `data.json` y fusiona por `id` con `updatedAt` mayor; recuerda en
  memoria los ids descartados o podados para que la fusión no los resucite.

## Éxito parcial de `batch`

`/api/batch` responde 200 aunque alguna op falle. El lote queda `sent` con `failedItems`
(índice y motivo); `expectedTaskIds` excluye los `create` rechazados de la relectura. Reintentar un
lote con `sentAt` no lo reenvía (un `addSubtask` no es idempotente).

## Registro

`logEnqueued` (info, sin texto del usuario) y `logTransition` con `from → to`, intentos y motivo.
Nivel: `error` si `rejected` o agotada, `warn` a partir de `WARN_AFTER_ATTEMPTS` (3), si no `info`.

## Drenaje periódico

`src/lumbre/queue-drain.ts`: `startQueueDrain` registra un intervalo de `QUEUE_DRAIN_INTERVAL_MS`
(60 s) que llama a `flush()` solo si hay red y `actionable()` no está vacío. También drenan:
`onload` (`flushIfConnected`), el evento `online` y cada gesto del usuario tras encolar.

## Tests

`src/lumbre/queue.test.ts`: `fakeClient()` con `vi.fn()` tipados, `memoryStorage()` que expone
`operations`, reloj y `sleep` inyectados, `deferred()` para congelar un flush a medias. Cubre
outcome, 429, éxito parcial, poda, dispositivos ajenos y el caso H7 (reabrir lo ya abierto).
