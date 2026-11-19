/**
    * Grabador de voz para "pulsar para hablar".
    *
    * Unica responsabilidad: capturar el microfono y entregar el audio
    * grabado como un Blob. No sabe nada de Mia ni del DOM.
    *
    * Analogia: una grabadora de mano. La enciendes, la apagas y te da la
    * cinta; no decide que hacer con ella.
*/
const VoiceRecorder = (() => {
    "use strict";

    let mediaRecorder = null;
    let mediaStream = null;
    let chunks = [];

    /** True si el navegador puede grabar audio. */
    function isSupported() {
        return Boolean(
            navigator.mediaDevices &&
            navigator.mediaDevices.getUserMedia &&
            window.MediaRecorder
        );
    }

    /** Elige un formato de audio que el navegador soporte. */
    function pickMimeType() {
        const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg", "audio/mp4"];
        for (const type of candidates) {
            if (window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(type)) {
                return type;
            }
        }
        return "";  // deja que el navegador use su formato por defecto
    }

    /**
        * Pide permiso del microfono y empieza a grabar.
        * @throws {Error} si no hay soporte o la persona niega el permiso
    */
    async function start() {
        if (!isSupported()) {
            throw new Error("Este navegador no permite grabar audio.");
        }
        if (mediaRecorder && mediaRecorder.state === "recording") {
            return;  // ya esta grabando
        }

        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        chunks = [];

        const mimeType = pickMimeType();
        mediaRecorder = mimeType
            ? new MediaRecorder(mediaStream, { mimeType })
            : new MediaRecorder(mediaStream);

        mediaRecorder.addEventListener("dataavailable", (event) => {
            if (event.data && event.data.size > 0) chunks.push(event.data);
        });

        mediaRecorder.start();
    }

    /** Libera el microfono (apaga la luz de la camara). */
    function releaseStream() {
        if (mediaStream) {
            mediaStream.getTracks().forEach((track) => track.stop());
            mediaStream = null;
        }
    }

    /**
        * Detiene la grabacion y entrega el audio.
        * @returns {Promise<Blob>} el audio grabado
    */
    function stop() {
        return new Promise((resolve, reject) => {
            if (!mediaRecorder) {
                reject(new Error("No había una grabación en curso."));
                return;
            }

            mediaRecorder.addEventListener("stop", () => {
                const type = mediaRecorder.mimeType || "audio/webm";
                const blob = new Blob(chunks, { type });
                releaseStream();
                mediaRecorder = null;
                resolve(blob);
            }, { once: true });

            try {
                mediaRecorder.stop();
            } catch (error) {
                releaseStream();
                mediaRecorder = null;
                reject(error);
            }
        });
    }

    /** Extension de archivo acorde al formato, para nombrar el envio a Mia. */
    function fileExtension(blob) {
        const type = (blob && blob.type) || "";
        if (type.includes("ogg")) return "ogg";
        if (type.includes("mp4")) return "mp4";
        return "webm";
    }

    return Object.freeze({
        isSupported,
        start,
        stop,
        fileExtension,
    });
})();
