# API pública del plugin

El plugin expone una superficie pequeña para que otros plugins del vault (Dataview, js-engine,
Templater) puedan leer tareas de Lumbre y crearlas. Se llega a ella así:

```js
const lumbre = app.plugins.plugins['lumbre']?.api;
```

Sale `undefined` si el plugin no está instalado o está desactivado, así que **compruébalo siempre**
antes de usarla.

Dos reglas que explican por qué la API hace lo que hace:

- **Todo lo que muta pasa por la cola durable.** `createTask`, `completeTask` y `reopenTask` encolan;
  no hablan con la API de Lumbre a pelo. Un 200 de Lumbre significa «aceptada», no «ya existe», y la
  cola es quien relee para confirmarlo.
- **Nada de aquí escribe en el vault.** La API lee tareas y encola escrituras hacia Lumbre. Tu nota
  es tuya.

## La superficie

| Miembro | Qué hace |
| --- | --- |
| `version: string` | Versión del plugin, la del `manifest.json`. Sube cuando esta superficie cambia. |
| `isConnected(): Promise<boolean>` | Pregunta a Lumbre si el origen y el token valen. |
| `listTasks(query?): Promise<LumbreTask[]>` | Las tareas de una consulta. Ver «La consulta». |
| `getTask(id): Promise<LumbreTask \| null>` | Una tarea por id, o `null` si no existe o no es de tu token. |
| `listLists(): Promise<LumbreList[]>` | Las listas de Lumbre. |
| `createTask(draft, target?): Promise<string>` | Encola una tarea nueva y devuelve su `clientTaskId`, que es el id que tendrá en Lumbre. |
| `completeTask(id): Promise<void>` | Encola completarla. |
| `reopenTask(id): Promise<void>` | Encola reabrirla. |
| `linksForNote(path): LumbreTaskLink[]` | Los vínculos nota ↔ tarea de una nota, por su ruta en el vault. |
| `openInLumbre(id): void` | Abre la tarea: la app de escritorio si la hay, la web en móvil. |
| `weeklySnapshot(options?): Promise<string>` | El Markdown de la foto semanal de la revisión, para pegarlo desde una plantilla. Ver «La foto semanal». |
| `on(evento, handler): () => void` | Se apunta a un evento. Devuelve cómo darse de baja. |
| `diagnostics.report(): string` | El informe de diagnóstico en texto plano, el mismo que copia el botón de los ajustes. |
| `diagnostics.events(n?): LogEvent[]` | Los últimos `n` eventos del registro (300 por defecto), del más viejo al más nuevo. |

`LumbreTask` lleva `id`, `content`, `notes`, `date`, `someday`, `time`, `deadline`, `priority`
(`p1`…`p4`), `done`, `cancelledAt`, `archivedAt`, `list`, `section`, `rolloverCount`, `parentId` y,
cuando el servidor los cuenta, `attachmentCount`.

`someday`, `time` y `rolloverCount` los **sirve** Lumbre desde su SHA `861cfb4d`. Contra un servidor
anterior, los dos primeros salen en su valor por defecto (`false` y `null`), y ahí no los leas como
«no tiene hora»: significan «el servidor no lo dice».

`rolloverCount` y `attachmentCount` son **opcionales a propósito**: ausentes significan que la fila
no traía el campo (`rolloverCount`) o el array `attachments`, no que la tarea no haya rodado nunca ni
que no tenga adjuntos. Un `0` presente sí es un dato. De ahí que sea `task.rolloverCount === undefined`
lo que hay que mirar para saber si tu Lumbre cuenta los arrastres, nunca `=== 0`.

`LumbreList` lleva `id`, `name`, `icon`, `color`, `parentListId`, `pinned` y `taskCount`. Mismo
criterio: los cuatro de en medio los sirve Lumbre desde ese SHA, y sus valores por defecto (`null`
los tres primeros, `false` en `pinned`) cubren un servidor anterior.

### `createTask(draft, target?)`

`draft` es lo mismo que rellena el modal de «Enviar a Lumbre»:

```js
{
  title: 'Comprar pan',        // lo único obligatorio
  listId: 'id-de-la-lista',    // o `list: 'Casa'` por nombre; se crea si no existe
  section: 'Cocina',
  date: '2026-09-04',          // YYYY-MM-DD
  someday: true,               // excluye date y time
  time: '18:30',
  priority: 'p2',
  deadline: '2026-09-10',
  notes: 'Texto largo',
  subtasks: ['Una', 'Otra'],
}
```

`target` es opcional y dice a qué parte del vault pertenece: `{ notePath, label, excerpt }`. Con él,
la tarea queda vinculada a esa nota y sale en el panel «Tareas de esta nota».

Devuelve el `clientTaskId`. Ese id vale desde el primer momento (es el que tendrá la tarea en
Lumbre), aunque la promesa resuelve cuando la cola ya ha intentado enviarla.

### Cuándo lanza

`listTasks` y `getTask` lanzan un `Error` con el motivo en castellano si la petición falla. Con una
excepción a propósito: si `listTasks` ya tenía una lectura confirmada de esa consulta y la nueva
falla, **devuelve la anterior** en vez de lanzar. Es lo mismo que enseña el bloque `lumbre`: sin red,
la última lectura buena, nunca una lista vacía que se leería como «no tienes nada».

## La consulta

`listTasks` acepta lo mismo que el cuerpo de un bloque ```` ```lumbre ````, en texto o en objeto:

```js
await lumbre.listTasks('scope: upcoming\ndays: 7');
await lumbre.listTasks({ scope: 'upcoming', days: 7 });
```

| Clave | Valores | Por defecto |
| --- | --- | --- |
| `scope` | `today`, `week`, `upcoming`, `inbox`, `someday`, `overdue`, `all` | `today` |
| `list` | Nombre o id de lista. Nombrarla sin `scope` significa la lista entera. | ninguna |
| `section` | Nombre de una sección dentro de `list`. | ninguna |
| `days` | Días de la ventana. **Solo** con `scope: upcoming`. | los del servidor |
| `tag` | Etiqueta dentro del título, con o sin `#`. Una etiqueta padre casa con sus hijas. | ninguna |
| `includeDone` | `true` o `false`. | `false` |
| `limit` | Tope de tareas. | sin tope |

Una consulta que no se entiende lanza un `Error` con el problema en una línea.

Las consultas van por la **misma caché** que los bloques: TTL de 30 segundos, peticiones en vuelo
deduplicadas y una sola llamada por consulta distinta, aunque la pidan a la vez cinco bloques y un
script. La API de Lumbre admite 120 llamadas por minuto y esto es lo que las cuida: un script que se
repinte cada segundo no gasta una petición por repintado.

## La foto semanal

`weeklySnapshot()` devuelve el mismo Markdown que pega el comando **Lumbre: Insertar la foto
semanal**: vencidas y arrastradas, listas sin próxima acción y una muestra de «Algún día». Es texto
de **solo lectura** y de ese momento, con su fecha en la cabecera; no proyecta tareas, no lleva
casillas de Markdown y no escribe nada por su cuenta. Dónde acaba lo decide quien llama.

```js
await lumbre.weeklySnapshot();
await lumbre.weeklySnapshot({ somedaySample: 3, seed: '2026-09-03' });
```

| Opción | Qué hace | Por defecto |
| --- | --- | --- |
| `now` | `Date` de la foto, el que sale en la cabecera. | ahora |
| `somedaySample` | Cuántas tareas de «Algún día» se enseñan. | 5 |
| `seed` | Semilla de esa muestra. La misma semilla da la misma muestra. | el día de `now` |
| `rolloverThreshold` | Veces rodada a partir de las cuales una tarea sale como arrastrada. | 3 |

Nunca lanza: el apartado que no se ha podido leer lo dice en su línea, en vez de salir vacío.

Ojo con el coste, que aquí sí importa: gasta **una petición por lista** de Lumbre, en serie y con un
intervalo entre medias para no pasarse de las 120 llamadas por minuto. Con muchas listas tarda
segundos, y no va por la caché de 30 segundos de los bloques: una foto es de ahora.

### Ejemplo: Templater

En una plantilla de nota semanal:

```
<%* tR += await app.plugins.plugins['lumbre'].api.weeklySnapshot() %>
```

## Eventos

```js
const off = lumbre.on('tasks-changed', () => {
  // Tras cualquier materialización de la cola o cualquier refresco de la caché.
});
off(); // darse de baja
```

- `tasks-changed`: algo ha cambiado en las tareas. Sin argumentos.
- `connection-changed`: recibe `true` o `false`. Solo salta cuando el estado cambia de verdad.

Además, en los mismos casos que `tasks-changed`, el plugin dispara el evento del workspace de
Obsidian **`lumbre:tasks-changed`**. Es lo que puede escuchar un script de Dataview, que ya tiene un
componente al que colgar la baja:

```js
this.registerEvent(app.workspace.on('lumbre:tasks-changed', () => dv.container.empty()));
```

## Diagnóstico

`diagnostics` es solo lectura y sirve para el mismo caso que el botón de los ajustes: enseñar qué
está pasando cuando algo no va. Lo que devuelve ya viene limpio, con las mismas reglas que el
informe: **nunca** el token, nunca una cabecera `Authorization` y nunca el texto de una nota.

```js
const lumbre = app.plugins.plugins['lumbre']?.api;

// El informe entero, para pegarlo en una nota o en un aviso.
const informe = lumbre.diagnostics.report();

// Solo los errores recientes.
const errores = lumbre.diagnostics.events(200).filter((event) => event.level === 'error');
```

Cada `LogEvent` lleva `seq` (contador), `ts` (ISO 8601), `level` (`debug`, `info`, `warn`, `error`),
`module` (`http`, `queue`, `links`, `cache`, `block`, `panel`, `modal`, `api`, `settings`, `vault`,
`main`), `message` y un `data` opcional con datos sueltos.

El buffer guarda **siempre** los últimos 1000 eventos, con independencia del nivel elegido en los
ajustes: ese nivel solo decide qué llega a la consola. Así que `events()` trae también los `debug`
anteriores al fallo, que son justo los que nadie tenía activados cuando pasó.

## Ejemplo: Dataview JS

Las tareas de hoy, en una lista:

````markdown
```dataviewjs
const lumbre = app.plugins.plugins['lumbre']?.api;
if (!lumbre) {
	dv.paragraph('El plugin de Lumbre no está activo.');
} else {
	const tasks = await lumbre.listTasks({ scope: 'today' });
	dv.list(tasks.map((task) => task.content));
}
```
````

## Ejemplo: js-engine

Un botón que crea una tarea con la nota actual como destino:

````markdown
```js-engine
const lumbre = app.plugins.plugins['lumbre']?.api;
if (!lumbre) return;

const button = container.createEl('button', { text: 'Enviar esta nota a Lumbre' });
button.addEventListener('click', async () => {
	const file = app.workspace.getActiveFile();
	if (file === null) return;

	button.disabled = true;
	button.setText('Enviando…');
	await lumbre.createTask(
		{ title: `Revisar ${file.basename}` },
		{ notePath: file.path, label: file.basename },
	);
	button.setText('Enviada');
});
```
````

`container` y `app` los inyecta js-engine. La tarea queda vinculada a la nota, así que aparece
también en el panel «Tareas de esta nota».

## Qué NO promete esta API

- El resto de las tripas del plugin (`client`, `queue`, `links`, `store`) **no** es superficie
  pública. Está ahí porque el objeto del plugin es alcanzable, pero cambia sin aviso.
- El token no se expone por ninguna vía. No hay método que lo devuelva y nunca aparece en un error.
