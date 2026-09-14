# Arquitectura

*Última actualización: 2026-09-14*

## Resumen

El plugin es un único bundle (`main.js`) con una clase `LumbrePlugin` (`src/main.ts`) que
construye todas las piezas en `onload` y las cablea por inyección. La regla de dependencia es
simple: los módulos de dominio (`src/lumbre/`, `src/blocks/query-*`, `src/links/*-store`,
`src/storage/`, `src/diagnostics/` salvo el modal, `src/soplo/plan-to-ops`, `src/review/`,
`src/notes/note-snapshot`, `src/attachments/upload`, `src/export/`) NO importan `obsidian`.
Reciben por opciones lo que necesitan del entorno (`request`, `now`, `sleep`, `register`,
`exists`, `app`). Solo la capa de UI (`main.ts`, modales, `ItemView`, `MarkdownRenderChild`,
`settings.ts`, `links/note-list.ts`) importa `obsidian`.

Hay tres invariantes de producto que atraviesan todo el diseño:

1. **Lumbre manda sobre la tarea, el vault sobre la nota.** El plugin no escribe tareas en
   Markdown. La única escritura automática en una nota es la propiedad `lumbre-list` del
   frontmatter (`src/links/note-list.ts`). Las fotos fijas (BRL de hoy, foto semanal) y la
   exportación solo salen por un comando ejecutado a mano.
2. **Un 200 no es un hecho.** Lumbre encola las escrituras y las materializa al drenar. Por eso
   toda mutación pasa por `OperationQueue` (`src/lumbre/queue.ts`), que envía y RELEE. Ver
   [queue-flow.md](./queue-flow.md).
3. **El token no sale del cliente HTTP.** Solo `LumbreClient.request` lo lee para la cabecera
   `Authorization`. El registro pasa por `redact.ts` y `main.ts` mantiene una copia en memoria
   (`secrets`) solo para poder taparlo de forma síncrona.

## Diagrama

```
Obsidian ──▶ src/main.ts (LumbrePlugin.onload)
             │
             ├─ PluginStore (storage/plugin-store.ts) ─── data.json (viaja por Obsidian Sync)
             │     ├─ TokenStore (token-store.ts)
             │     ├─ QueueStorage      ◀── OperationQueue (lumbre/queue.ts)
             │     ├─ LinkStorage       ◀── LinkStore (links/link-store.ts)  nota ↔ tarea
             │     └─ NoteListLinkStorage ◀── NoteListLinkStore             nota ↔ lista
             │
             ├─ LumbreClient (lumbre/client.ts) ── requestUrl ──▶ https://app.lumbre.pro/api/*
             │     ▲ lo usan: queue, QueryCache, BrlCache, ListCache, ChangeFeed,
             │       weekly-snapshot, panel, API pública, adjuntos (directo, sin cola)
             │
             ├─ Cachés de lectura: QueryCache (bloques ```lumbre```), BrlCache (```lumbre-brl```),
             │   ListCache (5 min). Invalidación: queue.onMaterialized → queries.refreshSoon()
             │
             ├─ Superficies: bloques (blocks/*-block.ts), panel NoteTasksView (ui/note-tasks-view.ts),
             │   modales (send, brl, soplo, save-note, suggest), pestaña de ajustes, DiagnosticsModal
             │
             ├─ Temporizadores (registerInterval, 60 s): queue-drain, change-feed, dos barridos de huérfanos
             │
             ├─ Eventos del vault: rename / delete / create → LinkStore y NoteListLinkStore
             │
             └─ API pública: app.plugins.plugins.lumbre.api (api/lumbre-api.ts, docs/API.md)
```

## Componentes

| Componente | Dónde | Responsabilidad | Habla con |
|---|---|---|---|
| `LumbrePlugin` | `src/main.ts` | Construcción, comandos, eventos, temporizadores, hosts de bloques y panel | todo |
| `LumbreClient` | `src/lumbre/client.ts` | HTTP con `LumbreResult`, cubos por endpoint, pestillo de lecturas tras 401, `flush()` único en vuelo | `requestUrl` inyectado |
| `OperationQueue` | `src/lumbre/queue.ts` | Cola durable: enviar, confirmar releyendo, reintentar, podar | client, PluginStore |
| `PluginStore` | `src/storage/plugin-store.ts` | Único objeto de `data.json`, migraciones, escrituras coalescidas y fusión con disco | `Plugin.loadData/saveData` |
| `LinkStore` / `NoteListLinkStore` | `src/links/` | Mapas nota ↔ tarea (N por nota) y nota ↔ lista (1 por nota) por RUTA, con huérfanos y deep links | PluginStore, client |
| `QueryCache` / `BrlCache` / `ListCache` | `src/blocks/`, `src/lumbre/list-cache.ts` | Una entrada por consulta o día, TTL 30 s (listas 5 min), peticiones deduplicadas, suscriptores | client |
| `ChangeFeed` | `src/lumbre/change-feed.ts` | Sondeo `updatedSince` con cursor en memoria; avisa a QueryCache y LinkStore | client |
| Bloques | `src/blocks/task-block.ts`, `brl-block.ts` | `MarkdownRenderChild` que pinta y se suscribe; nunca escribe la nota | cachés, hosts |
| Panel | `src/ui/note-tasks-view.ts` | `ItemView` que sigue a la nota activa | LinkStore, queue, client, ListCache |
| Soplo | `src/soplo/` | Plan del agente con casillas; solo lo marcado va a `POST /api/batch` por la cola | client, queue |
| Diagnóstico | `src/diagnostics/` | Logger con buffer de 1000, redacción, informe, ficheros de log, `guarded` | vault.adapter |
| API pública | `src/api/lumbre-api.ts` | Superficie estable para Dataview y js-engine | queue, cachés, client |

## Flujos de datos clave

**Enviar como tarea** (`main.ts` `openSendModal` → `sendDraft`): `SendTaskModal` → `queue.enqueueCreate(draft)`
(id `clientTaskId` fijado en local) → `links.link(..., 'pending_local')` → `queue.flush()` →
`client.createTask` (`POST /api/ingest`) → `sent` → relectura `getTask(clientTaskId)` → `materialized`
→ `onMaterialized` → `refreshBlocks()` y `emitTaskLinksForMaterialized` (encola `taskLink` a
`POST /api/task-links`).

**Casilla de un bloque** (`task-block.ts` `toggleDone` → `main.ts` `setTaskDone`): `queue.enqueueStatus`
→ `flush` → `client.mutate({op:'complete'})` → si la respuesta trae `outcome` `applied|noop` se
materializa sin releer; si no, relectura por `getTask` comparando `done`.

**Bloque ```lumbre```**: registro en `main.ts` con `registerMarkdownCodeBlockProcessor` →
`LumbreTaskBlock.onload` → `parseQuery` → `resolveQuery` (con `lumbre-list` de la nota y
`ListCache.nameFor`) → `QueryCache.subscribe/peek/get` → render. Invalidación por
`refreshSoon` (coalescida 250 ms) desde la cola, el sondeo de cambios o el botón «Actualizar».

**Cambios hechos fuera de Obsidian**: `startChangeFeedPoll` (60 s, solo con suscriptores o panel
abierto, online, pestaña visible, pestillo suelto) → `ChangeFeed.poll()` → si hay delta:
`queries.refreshSoon`, `links.refresh` por nota afectada, `notifyDataChange`.

**Soplo**: ver [entry-points.md](./entry-points.md) y `src/soplo/`. El consentimiento se consulta
ANTES de mandar el texto; el plan se aplica por índice, en lotes de 200, por la cola.

## Decisiones y restricciones que hay que conocer

- `data.json` viaja por Obsidian Sync. Consecuencias: cada operación lleva `deviceId` y
  `flush()` solo procesa las propias; el id de dispositivo va al `localStorage` de Obsidian, no a
  `data.json`; el cursor del change-feed vive en memoria; la cola se poda (7 días, 50 máx.) y de lo
  releído solo se guarda `materializedAt`; `save()` relee y fusiona con lo que hay en disco.
- Los adjuntos NO van por la cola (25 MB en base64 dentro de `data.json` sería inaceptable).
- Los cupos de Lumbre son por endpoint y por token, independientes. `client.ts` lleva un cubo
  por `MÉTODO RUTA` y avisa al 5/6. Un 401 en cualquier lectura echa un pestillo global de
  lecturas; solo lo sueltan el cambio de token en Ajustes y «Reintentar» del panel.
- `Modal` no es `Component`: cada modal lleva un `Component` propio para `registerDomEvent`.
  Ningún `addEventListener` a pelo en `src/`; lo vigila `src/dom-events.test.ts`.
- El nombre de cualquier fichero que el plugin escribe en el vault nunca lleva `:` (los informes
  usan `HHMMSS`), porque un `:` mete a Obsidian Sync en bucle.
- El host de ajustes se llama `config`, no `settings`, porque Obsidian 1.13 añadió
  `Plugin.settings` y el manifest declara `minAppVersion` 1.11.4.
- Historial de decisiones por lote: `docs/ESTADO.md`. Es la fuente de los «por qué».
