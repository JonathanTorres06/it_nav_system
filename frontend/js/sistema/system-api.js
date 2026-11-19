/**
    * Capa de datos de la pagina de modo sistema.
    *
    * Unica responsabilidad: hablar por HTTP con los dos servicios del PC,
    * it_nav_system (puerta 8001) y Mia (puerta 8000). No conoce el DOM.
    *
    * Patron aplicado:
    *   - Facade: cada funcion esconde los detalles de fetch (metodo,
    *     cabeceras, parseo) y expone una operacion simple hacia system.js.
    *
    * Nota de red: las direcciones se derivan del host de la propia pagina.
    * Asi funciona igual abierta en el PC (127.0.0.1) que desde el celular
    * en la red de la placa (la IP del PC), sin cambiar nada aqui.
*/
const SystemApi = (() => {
    "use strict";

    const host = location.protocol.startsWith("http") && location.hostname
        ? location.hostname
        : "127.0.0.1";

    const NAV_BASE = `http://${host}:8001`;
    const ASSISTANT_BASE = `http://${host}:8000`;

    // Cabeceras que Mia pone con la accion del hogar (ver assistant_router.py)
    const HEADER_INTENT = "X-Intent";
    const HEADER_RESPONSE_TEXT = "X-Response-Text";
    const HEADER_ACTION_TYPE = "X-Action-Type";
    const HEADER_ACTION_ROOM = "X-Action-Room";
    const HEADER_ACTION_STATE = "X-Action-State";
    const HEADER_ACTION_VALUE = "X-Action-Value";

    const NULL_HEADER = "null";

    /**
        * Lanza un Error con el "detail" de FastAPI si la respuesta fallo.
        * @param {Response} response
        * @returns {Promise<any>} cuerpo ya parseado como JSON (o null si va vacio)
    */
    async function handleJson(response) {
        if (!response.ok) {
            let message = `Error inesperado (codigo ${response.status}).`;
            try {
                const body = await response.json();
                if (body && body.detail) message = body.detail;
            } catch {
                // cuerpo no-JSON: nos quedamos con el mensaje generico
            }
            const error = new Error(message);
            error.status = response.status;
            throw error;
        }

        if (response.headers.get("content-length") === "0") return null;
        return response.json();
    }

    /** Decodifica una cabecera que Mia codifico con URL encoding. */
    function decodeHeader(value) {
        if (!value || value === NULL_HEADER) return null;
        try {
            return decodeURIComponent(value);
        } catch {
            return value;
        }
    }

    // ─── it_nav_system (puerta 8001) ─────────────────────────────────────

    /** True si el servicio responde /health; nunca lanza (para el panel de estado). */
    async function isServiceUp() {
        try {
            const response = await fetch(`${NAV_BASE}/health`, { cache: "no-store" });
            return response.ok;
        } catch {
            return false;
        }
    }

    /** Estado de la pasarela y ultimo estado de cada dispositivo. */
    async function getDevicesStatus() {
        const response = await fetch(`${NAV_BASE}/user/devices/status`, { cache: "no-store" });
        return handleJson(response);
    }

    /** Nodos de la casa con sus alias (para resolver la habitacion hablada). */
    async function getNodes() {
        const response = await fetch(`${NAV_BASE}/user/nodes`, { cache: "no-store" });
        return handleJson(response);
    }

    /** Enciende o apaga una luz por su device_key. Responde 202 (orden enviada). */
    async function setLight(deviceKey, state) {
        const response = await fetch(`${NAV_BASE}/user/devices/lights/${deviceKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ state }),
        });
        return handleJson(response);
    }

    /** Abre o cierra una puerta por su device_key. hold_ms es opcional. */
    async function setDoor(deviceKey, action, holdMs = null) {
        const payload = { action };
        if (holdMs !== null && holdMs !== undefined) payload.hold_ms = holdMs;

        const response = await fetch(`${NAV_BASE}/user/devices/doors/${deviceKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        return handleJson(response);
    }

    /** Ordenes recientes que la maqueta no cumplio (sin respuesta o estado distinto). */
    async function getOrderProblems() {
        const response = await fetch(`${NAV_BASE}/user/devices/orders/problems`, { cache: "no-store" });
        return handleJson(response);
    }

    // ─── Mia (puerta 8000) ───────────────────────────────────────────────

    /** True si Mia responde en su raiz; nunca lanza. */
    async function isAssistantUp() {
        try {
            const response = await fetch(`${ASSISTANT_BASE}/`, { cache: "no-store" });
            return response.ok;
        } catch {
            return false;
        }
    }

    /**
        * Lee la respuesta de Mia: el audio en el cuerpo y la accion en cabeceras.
        * @returns {Promise<Object>} intent, responseText, actionType, actionRoom,
        *                            actionState, actionValue y audioUrl.
    */
    async function parseAssistantResponse(response) {
        if (!response.ok) {
            let message = `Mía respondió con un error (codigo ${response.status}).`;
            try {
                const body = await response.json();
                if (body && body.detail) message = body.detail;
            } catch {
                // sin cuerpo JSON
            }
            const error = new Error(message);
            error.status = response.status;
            throw error;
        }

        const result = {
            intent: response.headers.get(HEADER_INTENT),
            responseText: decodeHeader(response.headers.get(HEADER_RESPONSE_TEXT)),
            actionType: response.headers.get(HEADER_ACTION_TYPE),
            actionRoom: decodeHeader(response.headers.get(HEADER_ACTION_ROOM)),
            actionState: response.headers.get(HEADER_ACTION_STATE),
            actionValue: response.headers.get(HEADER_ACTION_VALUE),
            audioUrl: null,
        };

        const audio = await response.blob();
        if (audio && audio.size > 0) result.audioUrl = URL.createObjectURL(audio);

        return result;
    }

    /** Manda audio grabado a Mia (pipeline completo STT, LLM y TTS). */
    async function sendVoice(audioBlob, filename = "command.webm") {
        const form = new FormData();
        form.append("audio_file", audioBlob, filename);

        const response = await fetch(`${ASSISTANT_BASE}/assistant/process`, {
            method: "POST",
            body: form,
        });
        return parseAssistantResponse(response);
    }

    /** Manda texto ya escrito a Mia (salta el STT: LLM y TTS). */
    async function sendText(text) {
        const response = await fetch(`${ASSISTANT_BASE}/assistant/process-text`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
        });
        return parseAssistantResponse(response);
    }

    return Object.freeze({
        NAV_BASE,
        ASSISTANT_BASE,
        isServiceUp,
        isAssistantUp,
        getDevicesStatus,
        getNodes,
        setLight,
        setDoor,
        getOrderProblems,
        sendVoice,
        sendText,
    });
})();
