# Generador de Informes OyM — SmartEnergy

Aplicación web para levantar en campo el informe técnico de mantenimiento
preventivo y correctivo de plantas solares fotovoltaicas, y generarlo en PDF
desde el propio celular.

## Qué hay en cada carpeta

```
public/GeneradorOyM.html        La aplicación completa (HTML + CSS + JS)
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

## El botón "Mejorar"

Cuando el técnico dicta por voz, el texto sale desordenado y en primera
persona. El botón "Mejorar" lo redacta en el registro técnico del informe.

Funciona por dos caminos:

1. **Con IA** (el bueno). La página llama a `/.netlify/functions/mejorar-texto`,
   que a su vez llama a la API de Claude. Entiende la frase, así que puede
   reordenar ideas, separar oraciones y elegir el término correcto.
2. **Limpieza básica sin conexión** (la red de seguridad). Si la función no
   responde, la página aplica un corrector local que solo hace cambios que no
   pueden romper la gramática: quitar muletillas, puntuación, mayúsculas,
   unidades y unos pocos términos equivalentes. La página avisa cuándo usó
   este camino, para que el técnico sepa que debe revisar la redacción.

### Activar la IA

La función acepta dos proveedores y usa el primero que tenga clave. Las claves
van **como variables de entorno en Netlify**, nunca dentro del repositorio:

| Variable | Proveedor | Costo |
|---|---|---|
| `GEMINI_API_KEY` | Google Gemini | Tiene capa gratuita |
| `ANTHROPIC_API_KEY` | Claude | Por consumo, ~0,01 USD por pulsación |

**Opción gratuita (la que usamos):** saca la clave en
[aistudio.google.com](https://aistudio.google.com) → *Get API key*. No pide
tarjeta.

Luego, en Netlify: **Site configuration → Environment variables → Add a
variable**, con Key `GEMINI_API_KEY` y el valor de la clave. Después
**Deploys → Trigger deploy → Deploy site**.

Si ninguna variable está definida, la aplicación sigue funcionando: aplica la
limpieza básica y avisa al técnico de que revise la redacción.

### Cambiar de modelo sin tocar el código

Si el proveedor retira un modelo, basta con definir otra variable de entorno:

- `GEMINI_MODEL` — por defecto `gemini-2.0-flash`. Los modelos disponibles
  aparecen en aistudio.google.com.
- `ANTHROPIC_MODEL` — por defecto `claude-opus-5`.

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
