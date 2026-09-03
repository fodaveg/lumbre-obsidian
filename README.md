# Lumbre para Obsidian

Plugin de escritorio que conecta el vault de Obsidian con [Lumbre](https://lumbre.pro), el gestor de tareas.

## Qué hace

El plugin **proyecta** tareas de Lumbre dentro de Obsidian. Nunca las copia al Markdown: la tarea
vive en Lumbre y la nota es tuya.

**Tres comandos** (en la paleta salen con el prefijo «Lumbre:»):

| Comando | Qué hace |
| --- | --- |
| **Enviar como tarea** | Abre un formulario con el título ya puesto (la selección, o la línea del cursor sin su marcador de lista), lista, fecha o «Algún día», hora, prioridad, fecha límite, notas y subtareas. También está en el menú contextual del editor, como «Enviar a Lumbre». |
| **Vincular esta nota a una lista** | Escribe la propiedad `lumbre-list` en el frontmatter con el id de la lista elegida. |
| **Quitar el vínculo con la lista** | Borra esa propiedad. |

**Un panel lateral**, «Tareas de esta nota» (icono en la barra izquierda, o el comando **Abrir las
tareas de esta nota**). Sigue a la nota abierta y enseña:

- Las tareas de Lumbre vinculadas a esa nota, con checkbox para completarlas o reabrirlas, su lista y
  su fecha, botón para abrirlas en Lumbre y para desvincularlas.
- Un buscador para vincular una tarea que ya existe, por título o por nombre de lista.
- Si la nota tiene `lumbre-list`, todas las tareas de esa lista agrupadas por sección.

Completar una tarea no es inmediato: la escritura va por una cola durable y el chip dice «Enviando…»
hasta que Lumbre la confirma al releerla. Sin conexión, la cabecera lo dice y se sigue enseñando lo
último confirmado, nunca una caché disfrazada de dato fresco.

`lumbre-list` es **lo único** que el plugin escribe dentro de una nota, y solo cuando lo pides con
ese comando.

## El bloque `lumbre`

Un bloque de código con el lenguaje `lumbre` se convierte, al renderizar la nota, en la lista de
tareas que pide su consulta. **No toca el Markdown**: el fichero se queda exactamente como lo
escribiste, y lo que se ve es lo que hay en Lumbre en ese momento.

````markdown
```lumbre
scope: upcoming
days: 7
tag: casa
title: Lo de casa esta semana
```
````

El cuerpo son líneas `clave: valor`, y un bloque vacío son las tareas de hoy:

| Clave | Valores | Por defecto |
| --- | --- | --- |
| `scope` | `today`, `week`, `upcoming`, `inbox`, `someday`, `overdue`, `all` | `today` |
| `list` | Nombre o id de lista. Nombrarla sin `scope` significa la lista entera, agrupada por sección. | ninguna |
| `section` | Nombre de una sección dentro de `list`. | ninguna |
| `days` | Días de la ventana. **Solo** con `scope: upcoming`. | los del servidor |
| `tag` | Etiqueta dentro del título, con o sin `#`. Una etiqueta padre casa con sus hijas. | ninguna |
| `includeDone` | `true` o `false`. | `false` |
| `limit` | Tope de tareas. | sin tope |
| `title` | Texto de la cabecera. | una descripción de la consulta |

Si la nota tiene `lumbre-list` y el bloque no dice ni `list` ni `scope`, se enseña esa lista entera.
Una consulta que no se entiende pinta el problema en una línea y no rompe nada más de la nota.

La casilla de cada tarea la completa o la reabre, y va por la misma cola durable que el resto: dice
«Enviando…» hasta que Lumbre la confirma al releer. El pie dice de qué hora son los datos y, si la
última lectura falló, que eso es lo que estás viendo. Los bloques comparten una caché de 30 segundos,
así que tener varios en una nota no multiplica las llamadas a Lumbre.

## API para Dataview y js-engine

`app.plugins.plugins['lumbre'].api` expone una superficie pequeña y estable para leer tareas y
crearlas desde un script. Está documentada, con ejemplos, en **[`docs/API.md`](docs/API.md)**.

## Estado

Lo que falta (dónde se guarda el token) está en la lista `lumbre-obsidian` de Lumbre. El detalle de
lo construido, en `docs/ESTADO.md`.

## Instalación por BRAT

El repositorio es público, así que BRAT no necesita ningún token:

1. Instala el plugin **BRAT** desde la tienda de plugins de Obsidian.
2. Ejecuta **Add beta plugin** y escribe `fodaveg/lumbre-obsidian`.

BRAT descarga los tres ficheros de la última release (`main.js`, `manifest.json`, `styles.css`) y
actualiza el plugin cuando salga una versión nueva.

Después, en los ajustes de Lumbre dentro de Obsidian: pon el origen (por defecto
`https://app.lumbre.pro`), pega tu token personal de Lumbre y pulsa **Probar conexión**.

## Desarrollo

```sh
npm install
npm run dev          # esbuild en modo watch
npm run check        # el gate: lint + tests + verify-release + build
OBSIDIAN_VAULT=/ruta/al/vault npm run install:dev   # copia main.js, manifest.json y styles.css
```

`npm run check` es el gate. Si está en rojo, no se publica.

## Cómo se publica

```sh
npm version patch    # o minor
git push --follow-tags
```

`npm version` dispara `version-bump.mjs`, que sincroniza `manifest.json` y `versions.json`, y crea el
tag **sin prefijo `v`** (lo fija `.npmrc` con `tag-version-prefix=""`). Ese detalle no es cosmético: BRAT y el instalador de Obsidian buscan la
release cuyo tag es exactamente `manifest.version`, y `scripts/verify-release.mjs --tag` falla si
alguien publica `v0.1.0`.


Al llegar el tag, `.github/workflows/release.yml` pasa el gate, comprueba el tag contra el manifest,
crea la release con los tres assets sueltos y vuelve a comprobarla contra lo que GitHub tiene
publicado de verdad.

## De dónde sale el diseño

- Audit `2026-09-03 - Plugin Obsidian-Lumbre - viabilidad e ideas de funciones`, en el vault de
  Obsidian (`21.11 Lumbre` / `40 Audits y revisiones`).
- Lista `lumbre-obsidian` de Lumbre, que lleva las tareas pendientes.

## Licencia

MIT.
