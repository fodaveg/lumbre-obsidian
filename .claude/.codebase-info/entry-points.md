# Puntos de entrada

*Última actualización: 2026-09-14*

Todo se registra en `LumbrePlugin.onload` (`src/main.ts`). Los comandos van envueltos en
`this.command(id, fn)`, que apunta un evento `info` y usa `guarded` para que una excepción no se
escape sin registro. Los callbacks de Obsidian (procesadores de bloque, eventos del vault, ribbon)
van con `guarded(logger, acción, fn)` de `src/diagnostics/unhandled.ts`.

## Comandos de la paleta (`registerCommands`, `src/main.ts`)

| id | Nombre en la paleta (Obsidian antepone «Lumbre:») | Tipo | Qué hace |
|---|---|---|---|
| `send-task` | Enviar como tarea | `editorCallback` | `openSendModal` → `sendDraft` → cola `create` |
| `open-note-tasks` | Abrir las tareas de esta nota | `callback` | `openNoteTasksView` (hoja derecha) |
| `link-note-to-list` | Vincular esta nota a una lista | `checkCallback` (nota activa) | `ListSuggestModal` → `applyListLink`: escribe `lumbre-list` y encola `listLink` |
| `unlink-note-from-list` | Quitar el vínculo con la lista | `checkCallback` (nota con `lumbre-list`) | borra la propiedad y encola `unlink` con la url guardada |
| `brl-entry` | Anotar en el BRL | `editorCallback` | `BrlEntryModal` → `sendBrlEntry` → cola `brl` |
| `insert-brl-today` | Insertar el BRL de hoy como texto | `editorCallback` | `insertBrlToday`: foto fija, no pega si la lectura falla |
| `insert-weekly-snapshot` | Insertar la foto semanal | `editorCallback` | `insertWeeklySnapshot`: foto fija, no pega si fallan los tres apartados |
| `save-note-to-task` | Guardar esta nota en la tarea | `editorCallback` | `saveNoteToTask` → `SaveNoteModal` → cola `notes` |
| `soplo-selection` | Soplo con la selección | `editorCallback` | `openSoploModal(file, soploSource(editor))` |
| `export-to-vault` | Guardar una copia de exportación en el vault | `callback` | `runExportToVault` → `GET /api/export` → `vault.create/modify` |
| `show-diagnostics` | Mostrar diagnóstico | `callback` | `DiagnosticsModal` |

Menú contextual del editor (`workspace.on('editor-menu')`): «Enviar a Lumbre» y «Soplo con la
selección».

Ribbon: icono `flame` (`NOTE_TASKS_ICON`) que abre el panel.

## Bloques de código

| Lenguaje | Constante | Clase | Caché |
|---|---|---|---|
| ```` ```lumbre ```` | `LUMBRE_BLOCK_LANGUAGE` (`src/blocks/task-block.ts`) | `LumbreTaskBlock` | `QueryCache` |
| ```` ```lumbre-brl ```` | `LUMBRE_BRL_BLOCK_LANGUAGE` (`src/blocks/brl-block.ts`) | `LumbreBrlBlock` | `BrlCache` |

Registro con `registerMarkdownCodeBlockProcessor`; el procesador hace `ctx.addChild(new ...Block(el,
source, ctx.sourcePath, host))`. El host (`taskBlockHost()` / `brlBlockHost()` en `main.ts`) se crea
por bloque pero comparte las instancias del plugin.

Ciclo de `LumbreTaskBlock`: `onload` → `parseQuery` (si falla: pinta el error, no se suscribe) →
`host.onDataChange(render)` → `start()`: `lists.get()` solo si la consulta o la nota nombran una
lista → `resolveQuery` → `cache.subscribe` → `cache.peek` → render → `cache.get`. `onunload`
suelta las dos suscripciones. La entrada de caché sobrevive 10 min sin suscriptores
(`IDLE_ENTRY_TTL_MS`) porque en modo lectura el bloque se remonta con cada edición.

## Vista lateral

`NoteTasksView extends ItemView` (`src/ui/note-tasks-view.ts`), tipo `lumbre-note-tasks`
(`NOTE_TASKS_VIEW_TYPE`), registrada con `registerView`. Se abre en la hoja derecha. Escucha
`host.onDataChange`, `active-leaf-change`, `file-open`, `metadataCache.changed` y `online/offline`.
Pinta: cabecera con estado de red, aviso de token, tareas vinculadas (`LinkStore.linksForNote`),
buscador (`searchTasks`, una sola lectura `scope: all` filtrada en cliente) y, si la nota tiene
`lumbre-list`, la lista agrupada por sección. El botón «Reintentar» del error llama a
`client.unlockReads('panel')`.

## Eventos del vault

`vault.on('rename' | 'delete' | 'create')` y `workspace.on('editor-menu')`. Detalle en
[vault-events.md](./vault-events.md).

## Temporizadores (`registerInterval`, todos a 60 s)

| Arranque | Módulo | Guardas | Efecto |
|---|---|---|---|
| `startQueueDrain` | `src/lumbre/queue-drain.ts` | online y `queue.actionable()` no vacío | `queue.flush()` |
| `startChangeFeedPoll` | `src/lumbre/change-feed.ts` | hay suscriptores o panel abierto, online, pestaña visible, pestillo suelto | `ChangeFeed.poll()` → refrescos |
| `sweepOrphanedNoteListLinks` | `main.ts` | huérfanos pasados de `ORPHAN_GRACE_MS` (30 s) y nota aún ausente | encola `listLink unlink` |
| `sweepOrphanedTaskLinks` + `backfillTaskLinks` | `main.ts` | ídem; backfill de 40 por pasada (`TASK_LINK_BACKFILL_BATCH`) | encola `taskLink unlink` / `link` |

Además: `window` `online` → `flushIfConnected`; `window` `error` y `unhandledrejection` →
`unhandledEvent` filtrado por la marca `plugin:lumbre` del stack.

## API pública

`app.plugins.plugins.lumbre.api` (`src/api/lumbre-api.ts`, contrato en `docs/API.md`). Mutan solo
`createTask`, `completeTask` y `reopenTask`, todas por la cola. `listTasks` va por `QueryCache`;
`weeklySnapshot` y `exportToVault` delegan en `main.ts`. Emite `lumbre:tasks-changed` en el
workspace (`TASKS_CHANGED_EVENT`) y ofrece `on('tasks-changed' | 'connection-changed')`.

Desajustes conocidos entre código y `docs/API.md` (medidos el 14 sep 2026): `LumbreQueryInput`
no declara `notes`, `context` ni `title` aunque el parser los acepta y la doc los usa; la doc de
`weeklySnapshot` dice «una petición por lista» pero ese es solo el camino de repliegue cuando el
pool `scope: all` falla o llega recortado.

## Flujo representativo: Soplo

1. `openSoploModal` recorta el texto a `MAX_AGENT_PROMPT_LENGTH` (4000) y abre `SoploModal`.
2. `SoploModal.ask()` consulta `client.agentConsent()`; con `missing` el texto no sale del
   dispositivo. Luego `client.agent(prompt)` (`POST /api/agent`, siempre previsualización).
3. Se pinta `plan.preview` con una casilla por ítem, todas marcadas.
4. «Aplicar» → `applySoploPlan` → `planToBatches(plan.plan, checked)` (`src/soplo/plan-to-ops.ts`):
   por índice, `add` → `create` con `clientTaskId` = id del plan, `mutation` → `mutateRaw` verbatim,
   `brl` y `habit` se cuentan como saltados, lotes de `MAX_BATCH_OPS` (200).
5. Un `queue.enqueueBatch` por lote, vínculos locales en `pending_local`, `flush`,
   `reportSoploOutcome` traduce `failedItems` a posiciones del plan entero.
6. Si `apply` lanza, `runApply` (`src/soplo/apply-flow.ts`) devuelve el fallo y «Reintentar»
   vuelve a aplicar sin remandar el texto a Soplo.
