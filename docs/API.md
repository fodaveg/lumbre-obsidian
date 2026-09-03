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
| `on(evento, handler): () => void` | Se apunta a un evento. Devuelve cómo darse de baja. |

`LumbreTask` lleva `id`, `content`, `notes`, `date`, `someday`, `time`, `deadline`, `priority`
(`p1`…`p4`), `done`, `cancelledAt`, `archivedAt`, `list`, `section` y `parentId`. Ojo: hoy
`GET /api/tasks` no manda `someday`, `time` ni `rolloverCount`, así que esos tres salen en su valor
por defecto. No los leas como «no tiene hora»: significan «el servidor no lo dice».

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
