# Lumbre para Obsidian

Plugin de escritorio y móvil que conecta el vault de Obsidian con [Lumbre](https://lumbre.pro), el
gestor de tareas.

## Qué hace

El plugin **proyecta** tareas de Lumbre dentro de Obsidian. Nunca las copia al Markdown: la tarea
vive en Lumbre y la nota es tuya.

**Los comandos** (en la paleta salen con el prefijo «Lumbre:»):

| Comando | Qué hace |
| --- | --- |
| **Enviar como tarea** | Abre un formulario con el título ya puesto (la selección, o la línea del cursor sin su marcador de lista), lista, fecha o «Algún día», hora, prioridad, fecha límite, notas y subtareas. También está en el menú contextual del editor, como «Enviar a Lumbre». |
| **Anotar en el BRL** | Un campo de texto (prefijado con la selección) y dos botones, «Nota» y «Pensamiento». La entrada va al registro de HOY por la misma cola durable que las tareas. |
| **Insertar el BRL de hoy como texto** | Pega el Markdown del registro de hoy en el cursor. Es una **foto fija**: la única vez que el BRL entra en un fichero del vault, y solo porque lo pides a mano. |
| **Insertar la foto semanal** | Pega en el cursor el texto de la revisión: vencidas y arrastradas, listas sin próxima acción y cinco de «Algún día». También es una **foto fija**. Ver «La foto semanal». |
| **Soplo con la selección** | Manda la selección (o el párrafo del cursor) a Soplo y enseña lo que HARÍA, con una casilla por acción. Nada se aplica sin pulsar «Aplicar». También está en el menú contextual del editor. |
| **Vincular esta nota a una lista** | Escribe la propiedad `lumbre-list` en el frontmatter con el id de la lista elegida. |
| **Quitar el vínculo con la lista** | Borra esa propiedad. |
| **Mostrar diagnóstico** | El resumen de estado y los últimos 100 eventos del registro, con botones para copiarlo o guardarlo. Ver «Cuando algo falla». |

**Un panel lateral**, «Tareas de esta nota» (icono en la barra izquierda, o el comando **Abrir las
tareas de esta nota**). Sigue a la nota abierta y enseña:

- Las tareas de Lumbre vinculadas a esa nota, con checkbox para completarlas o reabrirlas, su lista,
  su fecha, cuántos adjuntos tiene, botón para abrirlas en Lumbre y para desvincularlas.
- **Adjuntar fichero…** en cada tarea: elige un fichero del vault que no sea una nota y lo sube a esa
  tarea de Lumbre. Tope de 25 MB, que se comprueba antes de subir nada.
- **Reintentar** y **Descartar** en las escrituras que se han quedado paradas (un rechazo de Lumbre,
  o un error que ha agotado los reintentos). Descartar solo saca la operación de la cola: lo que ya
  llegó a Lumbre sigue en Lumbre.
- Un buscador para vincular una tarea que ya existe, por título o por nombre de lista.
- Si la nota tiene `lumbre-list`, todas las tareas de esa lista agrupadas por sección.

Completar una tarea no es inmediato: la escritura va por una cola durable y el chip dice «Enviando…»
hasta que Lumbre la confirma al releerla. Sin conexión, la cabecera lo dice y se sigue enseñando lo
último confirmado, nunca una caché disfrazada de dato fresco. La cola se repasa sola cada minuto,
así que lo que se encoló sin red sale en cuanto la haya, sin tener que tocar nada.

`lumbre-list` es **lo único** que el plugin escribe dentro de una nota por su cuenta. Lo otro que
puede acabar en un fichero es el BRL de hoy, y solo con el comando que lo pega a mano.

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

## El bloque `lumbre-brl`

El registro del día (el BRL de Lumbre) dentro de una nota, en vivo. El cuerpo tiene una sola clave,
`date`, y un bloque vacío es el registro de hoy:

````markdown
```lumbre-brl
date: today
```
````

| Clave | Valores | Por defecto |
| --- | --- | --- |
| `date` | `today` (o `hoy`), o una fecha `YYYY-MM-DD`. | `today` |

Con `today`, quién es «hoy» lo decide el **servidor** con la zona horaria de tu cuenta, no el reloj
del dispositivo. El Markdown lo pinta el mismo motor que el resto de la nota, así que los enlaces
internos y las listas salen como en cualquier otro sitio del vault. Igual que el bloque `lumbre`, no
toca el Markdown, dice de qué hora son los datos y comparte una caché de 30 segundos.

Necesita el add-on **BRL** activado en tu cuenta de Lumbre; si está apagado, el bloque lo dice.

## La foto semanal

**Lumbre: Insertar la foto semanal** pega en el cursor un bloque de texto con tres apartados, para
que la revisión de la semana empiece con lo que hay delante:

| Apartado | Qué trae |
| --- | --- |
| **Vencidas y arrastradas** | Lo vencido, más lo que lleva rodando tres días o más sin completarse. |
| **Listas sin próxima acción** | Listas con tareas pendientes y ninguna con fecha. |
| **Muestra de Algún día** | Cinco tareas al azar de «Algún día», las mismas durante todo el día. |

Es una **foto fija**, no un bloque en vivo: la cabecera dice de qué momento es («Foto del …») y desde
que se pega, el texto es tuyo. Las líneas son texto con un enlace para abrir la tarea en Lumbre y
**nunca** casillas de Markdown: una casilla en el vault sería una tarea del vault, y la tarea vive en
Lumbre. Un apartado sin nada que decir pone «Nada», y el que no se haya podido leer lo dice; si no se
puede leer ninguno de los tres, no se pega nada.

Si tu Lumbre es anterior al que cuenta los arrastres, el apartado dice «arrastradas: este Lumbre no
lo informa» en vez de dar un cero que parecería un dato.

Gasta una petición por lista, en serie y con un intervalo entre medias para no pasarse del límite de
Lumbre, así que en un vault con muchas listas tarda unos segundos. Lo mismo, desde una plantilla:
`api.weeklySnapshot()`, documentado en [`docs/API.md`](docs/API.md).

## Soplo desde una nota

**Lumbre: Soplo con la selección** manda ese texto a Soplo, el agente de Lumbre, y abre un modal con
lo que HARÍA: el texto original arriba y una casilla por acción, todas marcadas. **La IA propone y
tú confirmas**: hasta que pulsas «Aplicar» no se ha encolado nada, y solo se aplica lo que dejaste
marcado. Las tareas que nazcan de ahí quedan vinculadas a la nota desde la que lo pediste.

El texto se recorta a 4000 caracteres, que es el tope del servidor, y el modal avisa cuando lo hace.
Soplo exige tu consentimiento en Lumbre: el plugin lo pregunta **antes** de mandar nada, y si falta,
el texto de tu nota no sale del dispositivo. El modal lo dice y lleva a los ajustes de la web. Contra
un Lumbre que todavía no responde a esa pregunta con tu token, se manda como hasta ahora y el aviso
sale igual, con la respuesta de Soplo.

## Cuando algo falla

El plugin lleva un registro de diagnóstico que dice **qué** pasó, **dónde** y con qué datos. Nunca
lleva tu token, ni una cabecera `Authorization`, ni el texto de tus notas: de las tareas salen ids y
recuentos, y los títulos solo en nivel `debug` y recortados.

Si algo va mal, en **Ajustes → Lumbre → Diagnóstico**:

1. Pon el **nivel del registro** en `Todo (debug)` y repite lo que fallaba. Da igual si ya había
   pasado: el registro guarda **siempre** los últimos 1000 eventos, con independencia del nivel, así
   que lo de antes también está.
2. Pulsa **Copiar registro** y pégalo donde lo vayas a contar. Si el portapapeles no funciona (pasa
   en móvil), **Guardar registro en el vault** deja el mismo texto en
   `<carpeta de configuración>/plugins/lumbre/logs/lumbre-<fecha>-<hora>.log`, normalmente
   `.obsidian/plugins/lumbre/logs/`. Se conservan los 10 últimos.
3. Baja otra vez el nivel a `Normal (info)` cuando termines. En `debug` el registro es verboso a
   propósito.

Lo mismo, sin abrir los ajustes: el comando **Lumbre: Mostrar diagnóstico**, que enseña el resumen de
estado, los últimos 100 eventos y los dos mismos botones.

Para un fallo que ocurre **cuando no estás mirando** está el interruptor **Registrar también en
fichero en vivo**: apagado por defecto, y con él cada aviso y cada error se van escribiendo en
`logs/lumbre-live.log` según pasan. Rota al llegar a 1 MB y conserva una vuelta anterior.

El informe empieza con la versión del plugin y de Obsidian, la plataforma, el origen de la API, si
hay token (nunca cuál), la última prueba de conexión, el estado de la cola y de los vínculos.

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
