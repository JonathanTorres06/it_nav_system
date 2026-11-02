/**
    * Avisos compartidos por todas las pestanas: Toast (mensaje corto temporal)
    * y Banner (franja de error con boton "Reintentar").
    *
    * Capa: Presentacion (componentes reutilizables).
    * Analogia: El timbre y el letrero de la casa. Cualquier habitacion los usa
    * pero ninguna es duena de ellos.
    *
    * Requiere en el HTML: #toast, #banner, #bannerText, #bannerRetry.
*/
// Guarda el punto de entrada y salida del cursor en cada boton (--px / --py) como origen del barrido de relleno
function trackPointerOnButton(event) {
	const button = event.target.closest && event.target.closest(".btn, .dev-btn");
	if (!button || button.contains(event.relatedTarget)) return;
	const box = button.getBoundingClientRect();
	button.style.setProperty("--px", `${((event.clientX - box.left) / box.width * 100).toFixed(1)}%`);
	button.style.setProperty("--py", `${((event.clientY - box.top) / box.height * 100).toFixed(1)}%`);
}
document.addEventListener("pointerover", trackPointerOnButton);
document.addEventListener("pointerout", trackPointerOnButton);

const Toast = (() => {
	"use strict";

	const DURATION_MS = 3500;
	const LEAVE_MS = 220;
	const node = document.getElementById("toast");
	let timer = null;
	let leaveTimer = null;

	/** Muestra un mensaje que desaparece solo */
	function show(message) {
		node.textContent = message;
		node.classList.remove("is-leaving");
		node.hidden = false;
		clearTimeout(timer);
		clearTimeout(leaveTimer);
		timer = setTimeout(() => {
			// animacion de salida antes de ocultar
			node.classList.add("is-leaving");
			leaveTimer = setTimeout(() => {
				node.hidden = true;
			}, LEAVE_MS);
		}, DURATION_MS);
	}

	return Object.freeze({
		show
	});
})();

const Banner = (() => {
	"use strict";

	const node = document.getElementById("banner");
	const text = document.getElementById("bannerText");
	const retryButton = document.getElementById("bannerRetry");
	let retryHandler = null;

	retryButton.addEventListener("click", () => {
		if (retryHandler) retryHandler();
	});

	/**
		* Muestra la franja de error.
		* @param {string} message texto para la persona usuaria
		* @param {function|null} onRetry accion del boton "Reintentar" (null lo oculta)
	*/
	function show(message, onRetry = null) {
		text.textContent = message;
		retryHandler = onRetry;
		retryButton.hidden = !onRetry;
		node.hidden = false;
	}

	function hide() {
		node.hidden = true;
		retryHandler = null;
	}

	return Object.freeze({
		show,
		hide
	});
})();