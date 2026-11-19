/**
    * Resuelve el nombre hablado de una habitacion a su dispositivo.
    *
    * Reproduce fuera de Unity lo que hace RoomManager.ResolveNodeName:
    * toma lo que dijo la persona ("la sala", "el cuarto de la bebe") y lo
    * compara contra el nombre visible y los alias de cada nodo, sin
    * distinguir mayusculas ni tildes.
    *
    * Son funciones puras: no tocan el DOM ni la red, por eso se pueden
    * probar solas.
    *
    * Analogia: un recepcionista que entiende varios apodos de la misma
    * persona y siempre apunta al mismo numero de habitacion.
*/
const RoomResolver = (() => {
    "use strict";

    const NODE_TYPE_ROOM = "room";

    // Articulos y conectores que no aportan al nombre ("la sala" -> "sala")
    const FILLER_WORDS = new Set([
        "el", "la", "los", "las", "un", "una", "de", "del", "al", "a", "mi", "the",
    ]);

    /**
        * Pasa un texto a minusculas, le quita tildes y espacios de sobra.
        * @param {string} text
        * @returns {string}
    */
    function normalize(text) {
        if (!text) return "";
        return text
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")  // quita los acentos combinados
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")      // signos fuera: solo letras, numeros y espacios
            .replace(/\s+/g, " ")
            .trim();
    }

    /** Quita los articulos de relleno para comparar solo las palabras con significado. */
    function stripFillers(normalized) {
        return normalized
            .split(" ")
            .filter((word) => word && !FILLER_WORDS.has(word))
            .join(" ");
    }

    /** Todos los nombres posibles de un nodo (visible y alias), ya normalizados. */
    function candidatesOf(node) {
        const names = [node.display_name];
        if (Array.isArray(node.aliases)) {
            for (const alias of node.aliases) names.push(alias.alias);
        }
        return names
            .map(normalize)
            .filter(Boolean);
    }

    /**
        * Busca el nodo (habitacion) que mejor encaja con lo que dijo la persona.
        *
        * Orden de intento: igualdad exacta, luego igualdad sin articulos,
        * luego que uno contenga al otro. El primero que encaja gana.
        *
        * @param {string} spokenRoom nombre hablado de la habitacion
        * @param {Array} nodes lista de /user/nodes
        * @returns {Object|null} el nodo, o null si no hay coincidencia
    */
    function resolveRoomNode(spokenRoom, nodes) {
        const target = normalize(spokenRoom);
        if (!target || !Array.isArray(nodes)) return null;

        const targetCore = stripFillers(target);
        const rooms = nodes.filter((node) => node.node_type === NODE_TYPE_ROOM);

        // 1) Igualdad exacta (con o sin articulos)
        for (const node of rooms) {
            for (const candidate of candidatesOf(node)) {
                if (candidate === target || stripFillers(candidate) === targetCore) {
                    return node;
                }
            }
        }

        // 2) Uno contiene al otro (ej: "sala" dentro de "la sala principal")
        if (targetCore) {
            for (const node of rooms) {
                for (const candidate of candidatesOf(node)) {
                    const core = stripFillers(candidate);
                    if (!core) continue;
                    if (core.includes(targetCore) || targetCore.includes(core)) {
                        return node;
                    }
                }
            }
        }

        return null;
    }

    /**
        * device_key de un nodo segun el contrato: tipo + nombre interno.
        * Ej: SALA + light -> "light_sala"; CUARTO_PRINCIPAL + door -> "door_cuarto_principal".
        *
        * @param {Object} node nodo con internal_name
        * @param {string} deviceType "light" o "door"
        * @returns {string}
    */
    function deviceKeyFor(node, deviceType) {
        return `${deviceType}_${String(node.internal_name).toLowerCase()}`;
    }

    return Object.freeze({
        normalize,
        resolveRoomNode,
        deviceKeyFor,
    });
})();
