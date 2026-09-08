/**
 * Redacta con IA el texto que el técnico dictó en campo.
 *
 * El generador de informes llama a esta función desde el botón "Mejorar".
 * Si no está publicada, o si no hay ninguna clave configurada, la aplicación
 * se da cuenta sola y aplica su limpieza básica local, así que la herramienta
 * nunca se queda sin funcionar.
 *
 * Usa Google Gemini, que tiene capa gratuita. La clave va en
 * GEMINI_API_KEY, como variable de entorno en Netlify
 * (Site configuration -> Environment variables), NUNCA en el repositorio.
 * Se saca en https://aistudio.google.com -> Get API key.
 *
 * El modelo se elige solo a partir de la lista que publica Google, porque
 * Google renombra y retira modelos cada pocos meses. GEMINI_MODEL desactiva
 * esa eleccion automatica y fuerza uno concreto.
 *
 * Con GET ?diagnostico=1 la funcion cuenta que modelos ve y como responde
 * cada uno, sin revelar la clave. Sirve para saber si el problema es cuota
 * agotada, saturacion o una clave mala.
 *
 * Queda publicada en /.netlify/functions/mejorar-texto
 */

const LIMITE_CARACTERES = 6000;

/*
 * PLAZOS
 *
 * Netlify corta la funcion a los ~30 s. Sin plazos propios, la cadena de
 * modelos de reserva se comia ese tiempo entera y la funcion moria con un
 * 502 generico: el tecnico veia el boton girando medio minuto y luego un
 * error que no explicaba nada.
 *
 * Con presupuesto, la funcion siempre contesta a tiempo. Si no le da para
 * redactar, devuelve 503, que el cliente ya entiende como "pasajero, vuelve
 * a intentarlo", y mientras tanto aplica su limpieza local.
 */
const PRESUPUESTO_MS = 20000; // margen para responder antes de que corten
const TIMEOUT_MODELO_MS = 8000; // lo que se le concede a un modelo concreto
const TIMEOUT_LISTA_MS = 5000; // lo que se le concede a la lista de modelos

/** fetch que se rinde solo, en vez de quedarse colgado para siempre. */
async function fetchConPlazo(url, opciones, ms) {
  try {
    return await fetch(url, { ...opciones, signal: AbortSignal.timeout(ms) });
  } catch (error) {
    // Un plazo agotado no es culpa del texto: merece la pena probar el
    // siguiente modelo si aun queda presupuesto.
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw Object.assign(
        new Error(`Google no respondio en ${Math.round(ms / 1000)} s`),
        { status: 504, otroModelo: true },
      );
    }
    throw Object.assign(error, { status: error.status || 502, otroModelo: true });
  }
}

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

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Ordena los modelos que publica Google y devuelve los mejores candidatos.
 *
 * Se hace así porque Google renombra y retira modelos cada pocos meses, y
 * dejar el nombre escrito a mano hace que la herramienta deje de funcionar
 * sin aviso (paso con "gemini-2.0-flash"). Preferimos los "flash": son los
 * rapidos y los que entran en la capa gratuita, y para redactar un parrafo
 * van de sobra.
 */
function elegirModelos(nombres) {
  // Modelos que no sirven para escribir texto.
  const descartar = /(vision|embedding|aqa|imagen|image|tts|audio|live|learnlm|gemma)/i;

  const puntuar = (n) => {
    let p = 0;
    if (/flash/i.test(n)) p += 1000; // rapido y barato, es lo que necesitamos
    if (/latest/i.test(n)) p += 100; // alias estable que Google mantiene al dia
    if (/preview|exp/i.test(n)) p -= 500; // los experimentales desaparecen
    const version = n.match(/(\d+)\.(\d+)/); // "2.5" -> 25
    if (version) p += Number(version[1]) * 10 + Number(version[2]);
    return p;
  };

  return nombres
    .filter((n) => !descartar.test(n))
    .sort((a, b) => puntuar(b) - puntuar(a))
    .slice(0, 5); // el mejor y cuatro suplentes
}

// Se recuerda entre invocaciones mientras el contenedor siga vivo, para no
// pedir la lista en cada pulsacion del boton.
let modelosResueltos = null;

async function obtenerModelos() {
  if (process.env.GEMINI_MODEL) return [process.env.GEMINI_MODEL];
  if (modelosResueltos) return modelosResueltos;

  const respuesta = await fetchConPlazo(
    `${GEMINI_BASE}/models?pageSize=200`,
    { headers: { "x-goog-api-key": process.env.GEMINI_API_KEY } },
    TIMEOUT_LISTA_MS,
  );

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw Object.assign(
      new Error(
        respuesta.status === 400 || respuesta.status === 403
          ? "La clave GEMINI_API_KEY no es valida o no tiene habilitada la API. " +
            "Revisala en aistudio.google.com."
          : `Google respondio ${respuesta.status} al pedir la lista de modelos: ${detalle.slice(0, 200)}`,
      ),
      { status: respuesta.status === 403 ? 401 : 502 },
    );
  }

  const datos = await respuesta.json();
  const nombres = (datos.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => String(m.name).replace(/^models\//, ""));

  // Se guarda una lista, no un solo modelo: en la capa gratuita los modelos
  // mas nuevos se saturan a ratos y devuelven 503. Teniendo alternativas, la
  // funcion baja al siguiente en vez de fallar.
  const elegidos = elegirModelos(nombres);
  if (elegidos.length === 0) {
    throw Object.assign(
      new Error(
        "Tu clave de Gemini no da acceso a ningun modelo de texto. " +
          `Modelos visibles: ${nombres.slice(0, 10).join(", ") || "ninguno"}`,
      ),
      { status: 502 },
    );
  }

  modelosResueltos = elegidos;
  console.log("Modelos de Gemini disponibles, por orden:", elegidos.join(", "));
  return elegidos;
}

/** Una sola peticion a un modelo concreto, con plazo. */
async function pedirAGemini(modelo, texto, contexto, plazoMs) {
  const url = `${GEMINI_BASE}/models/${modelo}:generateContent`;

  const respuesta = await fetchConPlazo(
    url,
    {
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
    },
    plazoMs,
  );

  if (!respuesta.ok) {
    const detalle = await respuesta.text();

    // "otroModelo" marca los fallos que no son culpa del texto: merece la
    // pena reintentar con el siguiente modelo de la lista.
    //   404 el modelo ya no existe
    //   429 se agoto la cuota gratuita de ese modelo
    //   503 el modelo esta saturado ("high demand"), muy comun en la capa
    //       gratuita con los modelos mas nuevos
    //   500 error puntual de Google
    const otroModelo = [404, 429, 500, 503].includes(respuesta.status);

    if (respuesta.status === 404) {
      // Se olvida la lista para que la proxima llamada la pida de nuevo.
      modelosResueltos = null;
    }

    throw Object.assign(
      new Error(`Gemini respondió ${respuesta.status} con "${modelo}": ${detalle.slice(0, 200)}`),
      { status: respuesta.status, otroModelo },
    );
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

/**
 * Pide la redacción probando los modelos por orden.
 *
 * En la capa gratuita el modelo mejor valorado se satura a ratos y responde
 * 503 "high demand". En vez de fallarle al técnico, se baja al siguiente
 * candidato, que suele estar libre.
 */
async function redactarConGemini(texto, contexto) {
  // Todo lo que sigue tiene que caber aqui dentro.
  const limite = Date.now() + PRESUPUESTO_MS;

  const modelos = await obtenerModelos();
  let ultimoError = null;

  for (const modelo of modelos) {
    // Mejor rendirse con un mensaje util que morir a medias y que Netlify
    // devuelva un 502 sin explicacion.
    const restante = limite - Date.now();
    if (restante < 3000) {
      console.warn("Se agoto el presupuesto de tiempo antes de probar", modelo);
      break;
    }

    try {
      const resultado = await pedirAGemini(
        modelo,
        texto,
        contexto,
        Math.min(TIMEOUT_MODELO_MS, restante),
      );
      if (resultado) {
        // El que funciona pasa a ser el primero de la cola.
        if (modelosResueltos && modelosResueltos[0] !== modelo) {
          modelosResueltos = [modelo, ...modelosResueltos.filter((m) => m !== modelo)];
        }
        return resultado;
      }
      ultimoError = Object.assign(new Error(`"${modelo}" devolvió una respuesta vacía`), {
        status: 502,
        otroModelo: true,
      });
    } catch (error) {
      ultimoError = error;
      // Si el fallo es del texto (bloqueado, mal formado), no tiene sentido
      // repetirlo con otro modelo.
      if (!error.otroModelo) throw error;
      console.warn(`"${modelo}" no respondió (${error.status}); se prueba el siguiente.`);
    }
  }

  // Se acabaron los candidatos (o el tiempo).
  if (ultimoError && [429, 503, 504].includes(ultimoError.status)) {
    const porCuota = ultimoError.status === 429;
    throw Object.assign(
      new Error(
        porCuota
          ? "Se agotó la cuota gratuita de Gemini por hoy. Revisa el consumo " +
            "en aistudio.google.com; mientras tanto se aplica la limpieza básica."
          : "Gemini no está respondiendo en este momento. Espera un minuto y " +
            "vuelve a pulsar Mejorar.",
      ),
      // Si es cuota, hoy ya no hay nada que hacer: que el cliente no invite a
      // reintentar y aplique su limpieza local. Si es lentitud, sí compensa.
      { status: 503, reintentar: !porCuota },
    );
  }
  throw ultimoError || new Error("No se pudo redactar el texto");
}

/* ------------------------------------------------------------------ */

/**
 * Modo diagnóstico: GET ?diagnostico=1
 *
 * Cuenta qué modelos ve la clave y qué contesta cada uno de los tres
 * primeros ante una petición mínima. Sirve para distinguir de un vistazo
 * las tres averías que se parecen desde fuera:
 *
 *   401  la clave está mal o la API no está habilitada
 *   429  se acabó la cuota gratuita del día
 *   503  el modelo está saturado ahora mismo
 *
 * No devuelve la clave ni ningún dato del informe, y gasta muy poca cuota
 * (pide un "ok" de un token). Se puede llamar desde el navegador.
 */
async function diagnosticar() {
  if (!process.env.GEMINI_API_KEY) {
    return { clave: "no configurada" };
  }

  const informe = {
    clave: `configurada (${process.env.GEMINI_API_KEY.length} caracteres)`,
    modeloForzado: process.env.GEMINI_MODEL || null,
  };

  let modelos;
  try {
    // Se olvida lo memorizado para que el diagnóstico mida de verdad.
    modelosResueltos = null;
    modelos = await obtenerModelos();
    informe.modelosElegidos = modelos;
  } catch (error) {
    informe.listaDeModelos = `FALLÓ (${error.status}): ${error.message}`;
    return informe;
  }

  informe.pruebas = [];
  for (const modelo of modelos.slice(0, 3)) {
    const t0 = Date.now();
    try {
      const texto = await pedirAGemini(modelo, "Responde solo: ok", "", TIMEOUT_MODELO_MS);
      informe.pruebas.push({ modelo, resultado: "OK", ms: Date.now() - t0, devolvio: texto.slice(0, 40) });
    } catch (error) {
      informe.pruebas.push({
        modelo,
        resultado: `FALLÓ ${error.status}`,
        ms: Date.now() - t0,
        detalle: String(error.message).slice(0, 260),
      });
    }
  }
  return informe;
}

export default async (request) => {
  if (request.method === "GET" && new URL(request.url).searchParams.get("diagnostico") === "1") {
    return Response.json(await diagnosticar(), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  if (request.method !== "POST") {
    return Response.json({ error: "Usa POST" }, { status: 405 });
  }

  if (!process.env.GEMINI_API_KEY) {
    // La aplicación interpreta cualquier error como "no disponible" y pasa a
    // la limpieza básica local, así que basta con avisar.
    return Response.json(
      { error: "No hay clave configurada (GEMINI_API_KEY)" },
      // 501 y no 503: el cliente distingue "no esta configurado" (deja de
      // insistir) de "esta saturado" (merece la pena reintentar).
      { status: 501 },
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
    const mejorado = await redactarConGemini(texto, contexto);
    if (!mejorado) {
      return Response.json({ error: "El modelo devolvió una respuesta vacía" }, { status: 502 });
    }
    return Response.json({ texto: mejorado });
  } catch (error) {
    console.error("Error redactando el texto:", error);
    const status = typeof error?.status === "number" ? error.status : 502;
    return Response.json(
      {
        error: error?.message || "No se pudo contactar al servicio",
        // false = no insistas hoy (cuota agotada); la app aplica su limpieza.
        reintentar: error?.reintentar !== false,
      },
      { status },
    );
  }
};
