/**
 * Service worker del Generador de Informes OyM.
 *
 * DELIBERADAMENTE NO GUARDA NADA EN CACHÉ.
 *
 * Chrome solo ofrece "Instalar" si la página registra un service worker que
 * atienda el evento `fetch`. Ese es el único motivo por el que existe este
 * archivo: para que la app se pueda instalar y se abra en su propia ventana,
 * sin la barra del navegador.
 *
 * Los informes se generan con conexión a propósito. Es lo que hace funcionar
 * el botón "Mejorar" (llama a /.netlify/functions/mejorar-texto), y el sitio
 * vive en Netlify, así que la primera carga necesita red de todos modos.
 * Guardar copias aquí solo traería el problema clásico: el técnico abriendo
 * una versión vieja de la app días después de haberla actualizado.
 *
 * Si algún día se quiere que funcione sin señal, este es el sitio: cachear el
 * HTML, jsPDF y las fuentes con una estrategia "stale-while-revalidate" y
 * subir el número de VERSION en cada despliegue.
 */

const VERSION = 'oym-v1';

self.addEventListener('install', () => {
    // Sin espera: la versión nueva sustituye a la anterior en cuanto llega.
    self.skipWaiting();
});

self.addEventListener('activate', (evento) => {
    evento.waitUntil((async () => {
        // Barre cachés de versiones anteriores por si en el futuro se usan.
        const nombres = await caches.keys();
        await Promise.all(
            nombres.filter((n) => n !== VERSION).map((n) => caches.delete(n)),
        );
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (evento) => {
    // Todo va a la red, tal cual. El manejador existe para cumplir el
    // requisito de instalabilidad, no para interceptar nada.
    if (evento.request.method !== 'GET') return;
    evento.respondWith(fetch(evento.request));
});
