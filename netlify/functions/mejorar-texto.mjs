/**
 * Redacta con IA el texto que el técnico dictó en campo.
 *
 * El generador de informes llama a esta función desde el botón "Mejorar".
 * Si no está publicada, o si no hay ninguna clave configurada, la aplicación
 * se da cuenta sola y aplica su limpieza básica local, así que la herramienta
 * nunca se queda sin funcionar.
 *
 * Funciona con dos proveedores; usa el primero que tenga clave:
 *
 *   1. GEMINI_API_KEY    Google Gemini. Tiene capa gratuita.
 *                        Clave en https://aistudio.google.com -> Get API key
 *   2. ANTHROPIC_API_KEY Claude. Se cobra por consumo (unos 0,01 USD por
 *                        pulsación). Clave en https://console.anthropic.com
 *
 * Las claves se definen como variables de entorno en Netlify
 * (Site configuration -> Environment variables), NUNCA en el repositorio.
 *
 * Variables opcionales para cambiar de modelo sin tocar el código:
 *   GEMINI_MODEL     por defecto "gemini-2.0-flash"
 *   ANTHROPIC_MODEL  por defecto "claude-opus-5"
 *
 * Queda publicada en /.netlify/functions/mejorar-texto
 */

const LIMITE_CARACTERES = 6000;

const INSTRUCCIONES = `Eres el redactor técnico de SmartEnergy, una empresa de instalación y
mantenimiento de plantas solares fotovoltaicas en Colombia.

Recibes un texto que un técnico dictó por voz mientras trabajaba en sitio, para
un informe de operación y mantenimiento (O&M). Viene desordenado: sin puntuación,
con muletillas, en primera persona y con lenguaje coloquial de obra.

Reescríbelo para el informe siguiendo estas reglas:
- Español de Colombia, registro técnico y formal.
- Impersonal: "se revisó", "se encontró", nunca "revisé" ni "revisamos".
- Quita muletillas y repeticiones; separa las ideas en frases completas y cortas.
- Usa el vocabulario del sector: módulos fotovoltaicos, inversores, strings,
  interruptores termomagnéticos, puesta a tierra, tablero de protecciones.
- Normaliza las unidades: V, A, kW, kWh, Ω, °C, %.
- NO inventes datos, mediciones, marcas ni conclusiones que no estén en el texto.
  Si algo quedó ambiguo, mantenlo igual de general.
- Conserva todas las cifras exactamente como las dictó el técnico.
- Extensión parecida a la del original; no lo resumas ni lo infles.

Responde ÚNICAMENTE con el texto corregido, sin comillas, sin encabezados y sin
comentarios sobre lo que cambiaste.`;

const construirPeticion = (texto, contexto) =>
  (contexto ? `Sección del informe: ${contexto}\n\n` : "") +
  `Texto dictado:\n${texto}`;

/* ------------------------------------------------------------------ */
/* Google Gemini (capa gratuita)                                       */
/* ------------------------------------------------------------------ */
async function redactarConGemini(texto, contexto) {
  const modelo = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`;

  const respuesta = await fetch(url, {
    method: "POST",
    headers: {
      // La clave va en la cabecera, nunca en la URL: las URLs quedan
      // registradas en los logs de los servidores intermedios.
      "x-goog-api-key": process.env.GEMINI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: INSTRUCCIONES }] },
      contents: [{ parts: [{ text: construirPeticion(texto, contexto) }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
    }),
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    if (respuesta.status === 404) {
      throw Object.assign(
        new Error(
          `Gemini no reconoce el modelo "${modelo}". Cambia la variable ` +
            `GEMINI_MODEL en Netlify por uno disponible en aistudio.google.com.`,
        ),
        { status: 502 },
      );
    }
    if (respuesta.status === 429) {
      throw Object.assign(
        new Error("Se agotó la cuota gratuita de Gemini por ahora. Intenta en un momento."),
        { status: 429 },
      );
    }
    throw Object.assign(new Error(`Gemini respondió ${respuesta.status}: ${detalle.slice(0, 300)}`), {
      status: 502,
    });
  }

  const datos = await respuesta.json();

  if (datos.promptFeedback?.blockReason) {
    throw Object.assign(
      new Error(`Gemini rechazó el texto (${datos.promptFeedback.blockReason})`),
      { status: 422 },
    );
  }

  const partes = datos.candidates?.[0]?.content?.parts || [];
  return partes
    .map((p) => p.text || "")
    .join("")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Claude (de pago)                                                    */
/* ------------------------------------------------------------------ */
async function redactarConClaude(texto, contexto) {
  // Se importa solo si hace falta: así el camino de Gemini no depende
  // de que el SDK esté instalado.
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();

  const respuesta = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || "claude-opus-5",
    max_tokens: 4000,
    system: INSTRUCCIONES,
    // Tarea corta y acotada: no necesita razonamiento profundo.
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages: [{ role: "user", content: construirPeticion(texto, contexto) }],
  });

  if (respuesta.stop_reason === "refusal") {
    throw Object.assign(new Error("El modelo no pudo procesar este texto"), { status: 422 });
  }

  return respuesta.content
    .filter((bloque) => bloque.type === "text")
    .map((bloque) => bloque.text)
    .join("")
    .trim();
}

/* ------------------------------------------------------------------ */

export default async (request) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Usa POST" }, { status: 405 });
  }

  const redactar = process.env.GEMINI_API_KEY
    ? redactarConGemini
    : process.env.ANTHROPIC_API_KEY
      ? redactarConClaude
      : null;

  if (!redactar) {
    // La aplicación interpreta cualquier error como "no disponible" y pasa a
    // la limpieza básica local, así que basta con avisar.
    return Response.json(
      { error: "No hay ninguna clave configurada (GEMINI_API_KEY o ANTHROPIC_API_KEY)" },
      { status: 503 },
    );
  }

  let cuerpo;
  try {
    cuerpo = await request.json();
  } catch {
    return Response.json({ error: "El cuerpo debe ser JSON" }, { status: 400 });
  }

  const texto = typeof cuerpo?.texto === "string" ? cuerpo.texto.trim() : "";
  const contexto = typeof cuerpo?.contexto === "string" ? cuerpo.contexto.trim() : "";

  if (!texto) {
    return Response.json({ error: "No llegó ningún texto" }, { status: 400 });
  }
  if (texto.length > LIMITE_CARACTERES) {
    return Response.json(
      { error: `El texto supera los ${LIMITE_CARACTERES} caracteres` },
      { status: 413 },
    );
  }

  try {
    const mejorado = await redactar(texto, contexto);
    if (!mejorado) {
      return Response.json({ error: "El modelo devolvió una respuesta vacía" }, { status: 502 });
    }
    return Response.json({ texto: mejorado });
  } catch (error) {
    console.error("Error redactando el texto:", error);
    const status = typeof error?.status === "number" ? error.status : 502;
    return Response.json(
      { error: error?.message || "No se pudo contactar al servicio" },
      { status },
    );
  }
};
