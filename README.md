# Generador de Informes OyM — SmartEnergy

Aplicación web para levantar en campo el informe técnico de mantenimiento
preventivo y correctivo de plantas solares fotovoltaicas, y generarlo en PDF
desde el propio celular.

## Qué hay en cada carpeta

```
public/GeneradorOyM.html        La aplicación completa (HTML + CSS + JS)
public/manifest.json            Datos de la app instalable (nombre, iconos, color)
public/sw.js                    Service worker: solo habilita el botón "Instalar"
public/icons/                   Iconos de la app, recortados del logo
public/img/logo.png             Logo de SmartEnergy que se ve en la cabecera
netlify/functions/              Funciones serverless
  mejorar-texto.mjs             Redacta con IA el texto dictado por el técnico
netlify.toml                    Configuración del despliegue
package.json                    Dependencias de la función serverless
```

## Cómo se publica

El sitio está en **Netlify**, conectado a este repositorio. Cada vez que se
sube un cambio a la rama `main`, Netlify vuelve a publicar solo. No hay que
subir archivos a mano.

```bash
git add .
git commit -m "Describe aquí el cambio"
git push
```

## Instalarla en el celular

La aplicación es una PWA: se instala desde el navegador y luego se abre en su
propia ventana, sin la barra de direcciones, con su icono en la pantalla de
inicio.

- **Android (Chrome):** menú ⋮ → *Instalar aplicación*. También aparece solo
  como un aviso al pie después de un par de visitas.
- **iPhone (Safari):** botón compartir → *Añadir a pantalla de inicio*.

El `sw.js` **no guarda nada en caché a propósito**. Existe solo porque Chrome
exige un service worker para ofrecer la instalación. Los informes se generan
con conexión: es lo que hace funcionar el botón "Mejorar", y el sitio vive en
Netlify. Así nadie se queda con una versión vieja de la aplicación.

## Dónde se guardan los informes

Nada sale del celular todavía.

- **El índice** (nombre, fecha, si ya se generó el PDF) va en `localStorage`,
  para que la lista de inicio se pinte al instante.
- **El contenido completo, fotos incluidas**, va en IndexedDB. Las fotos no
  caben en `localStorage`, y son justo lo que no se puede recuperar si el
  navegador se cierra mientras el técnico está tomando una: el informe se
  guarda solo con cada tecleo y cada vez que la app pasa a segundo plano.

Todo pasa por `leerInforme` / `escribirInforme` / `eliminarInforme`. El día que
entre Supabase se sustituyen esas tres funciones y la interfaz no se entera.

## El botón "Mejorar"

Cuando el técnico dicta por voz, el texto sale desordenado y en primera
persona. El botón "Mejorar" lo redacta en el registro técnico del informe.

Funciona por dos caminos:

1. **Con IA** (el bueno). La página llama a `/.netlify/functions/mejorar-texto`,
   que a su vez llama a la API de Gemini. Entiende la frase, así que puede
   reordenar ideas, separar oraciones y elegir el término correcto.
2. **Limpieza básica sin conexión** (la red de seguridad). Si la función no
   responde, la página aplica un corrector local que solo hace cambios que no
   pueden romper la gramática: quitar muletillas, puntuación, mayúsculas,
   unidades y unos pocos términos equivalentes. La página avisa cuándo usó
   este camino, para que el técnico sepa que debe revisar la redacción.

### Activar la IA

La función usa **Google Gemini**, que tiene capa gratuita. Saca la clave en
[aistudio.google.com](https://aistudio.google.com) → *Get API key*. No pide
tarjeta.

La clave va **como variable de entorno en Netlify**, nunca dentro del
repositorio, con el nombre `GEMINI_API_KEY`.

Luego, en Netlify: **Site configuration → Environment variables → Add a
variable**, con Key `GEMINI_API_KEY` y el valor de la clave. Después
**Deploys → Trigger deploy → Deploy site**.

Si la variable no está definida, la aplicación sigue funcionando: aplica la
limpieza básica y avisa al técnico de que revise la redacción.

### Cambiar de modelo sin tocar el código

La función pide a Google la lista de modelos vivos y elige sola, porque Google
renombra y retira modelos cada pocos meses. Para forzar uno concreto, define
`GEMINI_MODEL` en Netlify.

### Cuando "Mejorar" deja de funcionar

Desde fuera, tres averías distintas se parecen. Para distinguirlas, abre en el
navegador:

```
https://informes-oym.netlify.app/.netlify/functions/mejorar-texto?diagnostico=1
```

Dice qué modelos ve la clave y qué contesta cada uno. No revela la clave ni
ningún dato de los informes, y gasta una pizca de cuota.

| Lo que devuelve | Qué pasa |
|---|---|
| `FALLÓ 401` | La clave está mal o la API no está habilitada |
| `FALLÓ 429` | Se acabó la cuota gratuita del día; mañana vuelve sola |
| `FALLÓ 503` | El modelo está saturado ahora mismo; reintenta en un minuto |
| `OK` | Gemini responde: el problema está en otra parte |

Mientras tanto la aplicación no se queda tirada: aplica su limpieza básica
local y avisa al técnico de que revise la redacción.

## Desarrollo local

Para probar la página sola, basta con abrir `public/GeneradorOyM.html` o
servirla:

```bash
npx serve public
```

Para probar también la función serverless hace falta el CLI de Netlify:

```bash
npm install
npx netlify dev
```
