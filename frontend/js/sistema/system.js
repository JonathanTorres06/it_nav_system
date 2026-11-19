/**
    * Orquestador de la pagina de modo sistema.
    *
    * Responsabilidad: conectar la interfaz (botones, voz, texto) con la capa
    * de datos (SystemApi) y la logica de resolucion (RoomResolver). Decide el
    * flujo pero no habla HTTP ni normaliza nombres por su cuenta.
    *
    * Patron aplicado:
    *   - Mediator: es el unico que conoce a todas las piezas y coordina como
    *     se hablan entre si; las piezas no se conocen directamente.
    *
    * Flujo de un comando de voz:
    *   voz/texto -> Mia (STT + LLM + TTS) -> accion (LUZ/TODAS_LUCES) ->
    *   resolver habitacion -> device_key -> it_nav_system -> MQTT -> maqueta.
*/
(() => {
    "use strict";

    const POLL_STATUS_MS = 2500;      // cada cuanto se refresca el panel de estado
    const OUTCOME_POLL_TRIES = 8;     // intentos para ver como quedo una orden
    const OUTCOME_POLL_MS = 600;
    const DEFAULT_DOOR_HOLD_MS = 15000; // cierre de seguridad al abrir desde el boton (igual que Unity)

    const LIGHT_PREFIX = "light_";
    const DOOR_PREFIX = "door_";

    const el = {};
    let nodes = [];
    let devicesByKey = {};
    let renderedKeys = "";
    let mode = "sistema";
    let isRecording = false;
    let lastAudioUrl = null;

    // ─── Arranque ────────────────────────────────────────────────────────

    function cacheDom() {
        const ids = [
            "serviceCard", "serviceText", "brokerCard", "brokerText",
            "assistantCard", "assistantText", "boardCard", "boardText",
            "modeSistema", "modeDirecto", "modeNote", "systemControls",
            "talkButton", "textForm", "textInput", "sendTextButton",
            "heardText", "actionText", "resultText", "miaAudio",
            "lightsList", "doorsList", "lightsEmpty", "doorsEmpty",
            "allOnButton", "allOffButton",
        ];
        for (const id of ids) el[id] = document.getElementById(id);
        el.talkLabel = el.talkButton.querySelector(".talk-label");
    }

    function wireEvents() {
        el.modeSistema.addEventListener("click", () => setMode("sistema"));
        el.modeDirecto.addEventListener("click", () => setMode("directo"));

        // Pulsar para hablar: se graba mientras se mantiene presionado
        el.talkButton.addEventListener("pointerdown", startTalk);
        el.talkButton.addEventListener("pointerup", stopTalk);
        el.talkButton.addEventListener("pointerleave", stopTalk);
        el.talkButton.addEventListener("pointercancel", stopTalk);

        el.textForm.addEventListener("submit", (event) => {
            event.preventDefault();
            const text = el.textInput.value.trim();
            if (!text) return;
            runCommand(SystemApi.sendText(text));
            el.textInput.value = "";
        });

        el.allOnButton.addEventListener("click", () => setAllLights("on"));
        el.allOffButton.addEventListener("click", () => setAllLights("off"));

        // Delegacion: un solo oyente por lista
        el.lightsList.addEventListener("click", onLightListClick);
        el.doorsList.addEventListener("click", onDoorListClick);
    }

    let initialized = false;

    function init() {
        // La pestania del panel de dev puede mostrarse varias veces; solo
        // armamos todo la primera vez.
        if (initialized) return;
        initialized = true;

        cacheDom();
        wireEvents();

        if (!VoiceRecorder.isSupported()) {
            el.talkButton.disabled = true;
            el.talkLabel.textContent = "Voz no disponible";
        }

        setMode("sistema");
        loadNodes();
        refreshStatus();
        setInterval(refreshStatus, POLL_STATUS_MS);
    }

    // ─── Modo (seguro contra dos fuentes a la vez) ───────────────────────

    function setMode(next) {
        mode = next;
        const inSystem = next === "sistema";

        el.modeSistema.classList.toggle("is-on", inSystem);
        el.modeDirecto.classList.toggle("is-on", !inSystem);
        el.modeSistema.setAttribute("aria-checked", String(inSystem));
        el.modeDirecto.setAttribute("aria-checked", String(!inSystem));
        el.systemControls.classList.toggle("is-locked", !inSystem);

        el.modeNote.textContent = inSystem
            ? "Las órdenes salen desde esta página a través del servicio. Para el control directo de la placa, usa su página en la red PRUEBA-ESP32."
            : "Esta página está en pausa. Controla la maqueta desde la página de la placa (PRUEBA-ESP32), así no hay dos fuentes mandando órdenes a la vez.";

        if (!inSystem && isRecording) stopTalk();
    }

    // ─── Nodos (para resolver la habitacion hablada) ─────────────────────

    async function loadNodes() {
        try {
            nodes = await SystemApi.getNodes();
            Banner.hide();
        } catch (error) {
            Banner.show("No se pudieron cargar las habitaciones. ¿Está encendido el servicio?", loadNodes);
        }
    }

    // ─── Panel de estado ─────────────────────────────────────────────────

    function setCard(card, textNode, ok, okText, downText) {
        card.dataset.state = ok ? "ok" : "down";
        textNode.textContent = ok ? okText : downText;
    }

    async function refreshStatus() {
        const [serviceUp, assistantUp] = await Promise.all([
            SystemApi.isServiceUp(),
            SystemApi.isAssistantUp(),
        ]);

        setCard(el.serviceCard, el.serviceText, serviceUp, "En línea", "No responde");
        setCard(el.assistantCard, el.assistantText, assistantUp, "En línea", "No responde");

        if (!serviceUp) {
            el.brokerCard.dataset.state = "down";
            el.brokerText.textContent = "Servicio apagado";
            el.boardCard.dataset.state = "down";
            el.boardText.textContent = "Servicio apagado";
            setDevices([]);
            return;
        }

        try {
            const status = await SystemApi.getDevicesStatus();
            updateFromStatus(status);
        } catch {
            el.brokerCard.dataset.state = "down";
            el.brokerText.textContent = "Sin datos";
            el.boardCard.dataset.state = "down";
            el.boardText.textContent = "Sin datos";
        }
    }

    function updateFromStatus(status) {
        setCard(el.brokerCard, el.brokerText, status.connected, "Conectado", "Sin conexión");

        const devices = Array.isArray(status.devices) ? status.devices : [];
        const anyOnline = devices.some((device) => device.online === true);

        if (!status.connected) {
            el.boardCard.dataset.state = "down";
            el.boardText.textContent = "Depende del broker";
        } else if (devices.length === 0) {
            el.boardCard.dataset.state = "checking";
            el.boardText.textContent = "Sin datos aún";
        } else {
            setCard(el.boardCard, el.boardText, anyOnline, "En línea", "Sin respuesta");
        }

        setDevices(devices);
    }

    // ─── Lista de dispositivos (controles manuales) ──────────────────────

    function setDevices(devices) {
        devicesByKey = {};
        for (const device of devices) devicesByKey[device.device_key] = device;

        const keys = devices.map((device) => device.device_key).sort().join(",");
        if (keys !== renderedKeys) {
            renderedKeys = keys;
            buildDeviceLists(devices);
        }
        updateDeviceStates();
    }

    /** Nombre bonito de un dispositivo: usa el nodo si existe, si no limpia la clave. */
    function nameForDevice(deviceKey) {
        const internal = deviceKey.replace(LIGHT_PREFIX, "").replace(DOOR_PREFIX, "").toUpperCase();
        const node = nodes.find((n) => String(n.internal_name).toUpperCase() === internal);
        if (node) return node.display_name;
        return deviceKey
            .replace(LIGHT_PREFIX, "")
            .replace(DOOR_PREFIX, "")
            .replace(/_/g, " ")
            .replace(/^\w/, (c) => c.toUpperCase());
    }

    function deviceRow(deviceKey) {
        const row = document.createElement("div");
        row.className = "device-row";
        row.dataset.key = deviceKey;

        const info = document.createElement("div");
        const name = document.createElement("div");
        name.className = "device-name";
        name.textContent = nameForDevice(deviceKey);
        const key = document.createElement("div");
        key.className = "device-key";
        key.textContent = deviceKey;
        info.append(name, key);

        const state = document.createElement("span");
        state.className = "device-state";
        state.dataset.role = "state";

        row.append(info, state);
        return { row, state };
    }

    function buildDeviceLists(devices) {
        const lights = devices.filter((d) => d.device_key.startsWith(LIGHT_PREFIX));
        const doors = devices.filter((d) => d.device_key.startsWith(DOOR_PREFIX));

        el.lightsList.innerHTML = "";
        el.doorsList.innerHTML = "";

        if (lights.length === 0) {
            el.lightsList.innerHTML = '<p class="note">Sin luces reportadas todavía.</p>';
        } else {
            for (const light of lights) {
                const { row, state } = deviceRow(light.device_key);
                const button = document.createElement("button");
                button.className = "btn btn-small";
                button.dataset.key = light.device_key;
                button.dataset.role = "toggle";
                button.textContent = "…";
                row.append(button);
                el.lightsList.append(row);
                void state;
            }
        }

        if (doors.length === 0) {
            el.doorsList.innerHTML = '<p class="note">Sin puertas reportadas todavía.</p>';
        } else {
            for (const door of doors) {
                const { row } = deviceRow(door.device_key);
                const buttons = document.createElement("span");
                buttons.style.display = "flex";
                buttons.style.gap = "8px";

                const openButton = document.createElement("button");
                openButton.className = "btn btn-small";
                openButton.dataset.key = door.device_key;
                openButton.dataset.action = "open";
                openButton.textContent = "Abrir";

                const closeButton = document.createElement("button");
                closeButton.className = "btn btn-small";
                closeButton.dataset.key = door.device_key;
                closeButton.dataset.action = "close";
                closeButton.textContent = "Cerrar";

                buttons.append(openButton, closeButton);
                row.append(buttons);
                el.doorsList.append(row);
            }
        }
    }

    const LIGHT_LABEL = { on: "Encendida", off: "Apagada" };
    const DOOR_LABEL = {
        open: "Abierta", closed: "Cerrada",
        opening: "Abriendo…", closing: "Cerrando…", blocked: "Bloqueada",
    };

    function updateDeviceStates() {
        for (const key of Object.keys(devicesByKey)) {
            const row = el.lightsList.querySelector(`.device-row[data-key="${key}"]`)
                || el.doorsList.querySelector(`.device-row[data-key="${key}"]`);
            if (!row) continue;

            const device = devicesByKey[key];
            const stateNode = row.querySelector('[data-role="state"]');
            const value = (device.state || "").toLowerCase();

            if (key.startsWith(LIGHT_PREFIX)) {
                const on = value === "on";
                stateNode.textContent = LIGHT_LABEL[value] || "Sin dato";
                stateNode.dataset.on = String(on);
                const toggle = row.querySelector('[data-role="toggle"]');
                if (toggle) toggle.textContent = on ? "Apagar" : "Encender";
            } else {
                const open = value === "open" || value === "opening";
                stateNode.textContent = DOOR_LABEL[value] || "Sin dato";
                stateNode.dataset.on = String(open);
            }
        }
    }

    // ─── Acciones manuales ───────────────────────────────────────────────

    async function onLightListClick(event) {
        const button = event.target.closest('[data-role="toggle"]');
        if (!button) return;
        const key = button.dataset.key;
        const current = (devicesByKey[key]?.state || "").toLowerCase();
        const next = current === "on" ? "off" : "on";
        await runDeviceOrder(() => SystemApi.setLight(key, next), `Luz ${nameForDevice(key)}: ${next}`);
    }

    async function onDoorListClick(event) {
        const button = event.target.closest("[data-action]");
        if (!button) return;
        const key = button.dataset.key;
        const action = button.dataset.action;
        const holdMs = action === "open" ? DEFAULT_DOOR_HOLD_MS : null;
        await runDeviceOrder(() => SystemApi.setDoor(key, action, holdMs), `Puerta ${nameForDevice(key)}: ${action}`);
    }

    async function setAllLights(state) {
        const lightKeys = Object.keys(devicesByKey).filter((key) => key.startsWith(LIGHT_PREFIX));
        if (lightKeys.length === 0) {
            Toast.show("No hay luces reportadas.");
            return;
        }
        let failed = 0;
        for (const key of lightKeys) {
            try {
                await SystemApi.setLight(key, state);
            } catch {
                failed += 1;
            }
        }
        Toast.show(failed === 0
            ? `Orden enviada a ${lightKeys.length} luces (${state}).`
            : `Enviadas ${lightKeys.length - failed} de ${lightKeys.length}; ${failed} fallaron.`);
        refreshStatus();
    }

    /** Ejecuta una orden manual y muestra el resultado comun. */
    async function runDeviceOrder(sendFn, description) {
        try {
            await sendFn();
            Toast.show(`${description}. Orden enviada.`);
            refreshStatus();
        } catch (error) {
            notifyOrderError(error);
        }
    }

    function notifyOrderError(error) {
        if (error && error.status === 503) {
            Toast.show("Sin conexión con el broker: la orden no se envió.");
        } else {
            Toast.show(error && error.message ? error.message : "No se pudo enviar la orden.");
        }
    }

    // ─── Voz y texto a Mia ───────────────────────────────────────────────

    async function startTalk(event) {
        if (event) event.preventDefault();
        if (mode !== "sistema" || isRecording || el.talkButton.disabled) return;
        try {
            await VoiceRecorder.start();
            isRecording = true;
            el.talkButton.setAttribute("aria-pressed", "true");
            el.talkLabel.textContent = "Grabando… suelta para enviar";
        } catch (error) {
            Toast.show(error && error.message ? error.message : "No se pudo usar el micrófono.");
        }
    }

    async function stopTalk() {
        if (!isRecording) return;
        isRecording = false;
        el.talkButton.setAttribute("aria-pressed", "false");
        el.talkLabel.textContent = "Mantén para hablar";

        let blob;
        try {
            blob = await VoiceRecorder.stop();
        } catch {
            return;
        }

        if (!blob || blob.size < 1200) {
            Toast.show("No se grabó audio. Mantén presionado mientras hablas.");
            return;
        }

        runCommand(SystemApi.sendVoice(blob, `command.${VoiceRecorder.fileExtension(blob)}`));
    }

    // Mientras Mia procesa, se bloquea el envio para no mandar dos comandos
    // encimados y se muestra el boton "cargando".
    function setProcessing(on) {
        el.sendTextButton.classList.toggle("is-loading", on);
        el.sendTextButton.disabled = on;
        el.textInput.disabled = on;
        el.talkButton.disabled = on ? true : !VoiceRecorder.isSupported();
    }

    async function runCommand(sendPromise) {
        setProcessing(true);
        setHeard("Procesando…");
        setAction("·");
        setResult("·", null);

        try {
            const result = await sendPromise;
            setHeard(result.responseText || "(sin texto)");
            playAudio(result.audioUrl);
            await executeAction(result);
        } catch (error) {
            setHeard("·");
            setResult(error && error.message ? error.message : "Mía no respondió.", "error");
        } finally {
            setProcessing(false);
        }
    }

    async function executeAction(result) {
        if (result.intent !== "home_action" || !result.actionType) {
            setAction("Sin acción (pregunta o conversación).");
            setResult("·", null);
            return;
        }

        const type = result.actionType.toUpperCase();

        if (type === "LUZ") {
            await executeLight(result);
        } else if (type === "TODAS_LUCES") {
            const state = (result.actionState || "").toLowerCase();
            setAction(`Todas las luces: ${state || "?"}`);
            if (state !== "on" && state !== "off") {
                setResult("Mía no indicó encender o apagar.", "error");
                return;
            }
            await setAllLights(state);
            setResult("Órdenes enviadas.", "confirmed");
        } else if (type === "TEMP") {
            setAction("Temperatura");
            setResult("La temperatura es solo visual en Unity; no llega a la maqueta.", null);
        } else if (type === "MOVER") {
            setAction("Mover al robot");
            setResult("Mover al robot no está en el modo sistema.", null);
        } else {
            setAction(type);
            setResult("Acción no soportada en el modo sistema.", null);
        }
    }

    async function executeLight(result) {
        const state = (result.actionState || "").toLowerCase();
        setAction(`Luz · ${result.actionRoom || "?"} · ${state || "?"}`);

        if (!result.actionRoom) {
            setResult("Mía no dijo cuál habitación.", "error");
            return;
        }
        if (state !== "on" && state !== "off") {
            setResult("Mía no indicó encender o apagar.", "error");
            return;
        }

        const node = RoomResolver.resolveRoomNode(result.actionRoom, nodes);
        if (!node) {
            setResult(`No encontré la habitación «${result.actionRoom}».`, "error");
            return;
        }

        const deviceKey = RoomResolver.deviceKeyFor(node, "light");
        if (!(deviceKey in devicesByKey)) {
            setResult(`La luz «${deviceKey}» no está disponible en la maqueta.`, "error");
            return;
        }

        try {
            await SystemApi.setLight(deviceKey, state);
            setResult("Orden enviada, esperando confirmación…", null);
            pollOutcome(deviceKey);
        } catch (error) {
            notifyOrderError(error);
            setResult(error && error.status === 503 ? "Sin conexión con el broker." : "No se pudo enviar.", "error");
        }
    }

    const OUTCOME_TEXT = {
        confirmed: "Confirmada",
        no_response: "La maqueta no respondió.",
        mismatch: "La maqueta reportó un estado distinto.",
        pending: "Esperando…",
    };

    /** Revisa cada pocos cientos de ms como quedo la ultima orden de un dispositivo. */
    async function pollOutcome(deviceKey) {
        for (let attempt = 0; attempt < OUTCOME_POLL_TRIES; attempt += 1) {
            await delay(OUTCOME_POLL_MS);
            let status;
            try {
                status = await SystemApi.getDevicesStatus();
            } catch {
                continue;
            }
            updateFromStatus(status);

            const device = (status.devices || []).find((d) => d.device_key === deviceKey);
            const outcome = device && device.last_order ? device.last_order.outcome : null;

            if (outcome && outcome !== "pending") {
                setResult(OUTCOME_TEXT[outcome] || outcome, outcome);
                return;
            }
        }
        setResult("Sin confirmación todavía.", "no_response");
    }

    // ─── Ayudas de interfaz ──────────────────────────────────────────────

    function setHeard(text) { el.heardText.textContent = text; }
    function setAction(text) { el.actionText.textContent = text; }

    function setResult(text, outcome) {
        el.resultText.textContent = text;
        if (outcome) el.resultText.dataset.outcome = outcome;
        else el.resultText.removeAttribute("data-outcome");
    }

    function playAudio(url) {
        if (!url) return;
        if (lastAudioUrl) URL.revokeObjectURL(lastAudioUrl);
        lastAudioUrl = url;
        el.miaAudio.src = url;
        el.miaAudio.play().catch(() => { /* el navegador puede bloquear el autoplay */ });
    }

    function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // Dentro del panel de desarrollo, la pestania lo arranca cuando se muestra.
    window.SystemTab = { onShow: init };

    // Respaldo: si algun dia se usa como pagina propia (body con clase
    // sys-body), arranca sola sin esperar a una pestania.
    if (document.body && document.body.classList.contains("sys-body")) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", init);
        } else {
            init();
        }
    }
})();
