/**
 * Validacion de formularios con mensajes propios.
 * Desactiva el aviso nativo (novalidate) y muestra el error junto al campo.
 * Escucha submit en fase de captura y corta el evento si hay campos invalidos.
 */
const Fields = (() => {
	"use strict";

	const DEFAULT_MESSAGES = Object.freeze({
		valueMissing: "Este campo no puede quedar vacío.",
		patternMismatch: "El formato no es válido.",
		tooShort: "Es demasiado corto.",
		typeMismatch: "El valor no es válido."
	});
	// Mensaje por campo: data-msg-missing, data-msg-pattern, data-msg-short, data-msg-type
	const DATA_KEYS = Object.freeze({
		valueMissing: "msgMissing",
		patternMismatch: "msgPattern",
		tooShort: "msgShort",
		typeMismatch: "msgType"
	});

	let counter = 0;

	/** Dentro del <label> si existe; si no, a continuacion del campo */
	function insertMessage(control, node) {
		const label = control.closest("label");
		if (label) label.append(node);
		else control.after(node);
	}

	function clear(control) {
		if (control._fieldMsg) {
			control._fieldMsg.remove();
			control._fieldMsg = null;
		}
		control.removeAttribute("aria-invalid");
		control.removeAttribute("aria-describedby");
	}

	/** Muestra un error en el campo. Tambien se usa para errores del servidor */
	function error(control, text) {
		clear(control);
		const node = document.createElement("p");
		node.className = "field-msg";
		node.id = `field-msg-${++counter}`;
		node.setAttribute("role", "alert");
		node.textContent = text;
		insertMessage(control, node);
		control._fieldMsg = node;
		control.setAttribute("aria-invalid", "true");
		control.setAttribute("aria-describedby", node.id);
		control.classList.remove("is-shake");
		void control.offsetWidth; // reinicia la animacion
		control.classList.add("is-shake");
		control.addEventListener("animationend", () => control.classList.remove("is-shake"), {
			once: true
		});
	}

	function messageFor(control) {
		const state = control.validity;
		for (const key of Object.keys(DEFAULT_MESSAGES)) {
			if (state[key]) return control.dataset[DATA_KEYS[key]] || DEFAULT_MESSAGES[key];
		}
		return control.validationMessage || "Revisa este campo.";
	}

	/** Valida el formulario; muestra los errores, enfoca el primer campo invalido y devuelve false */
	function validate(form) {
		const invalid = Array.from(form.elements).filter((control) => control.willValidate && !control.validity.valid);
		Array.from(form.elements).forEach(clear);
		if (!invalid.length) return true;
		invalid.forEach((control) => error(control, messageFor(control)));
		invalid[0].focus();
		return false;
	}

	document.querySelectorAll("form").forEach((form) => {
		form.noValidate = true;
	});

	document.addEventListener("submit", (event) => {
		if (!validate(event.target)) {
			event.preventDefault();
			event.stopImmediatePropagation();
		}
	}, true);

	// Al editar el campo se limpia su mensaje
	document.addEventListener("input", (event) => {
		if (event.target._fieldMsg) clear(event.target);
	}, true);

	return Object.freeze({
		validate,
		error,
		clear
	});
})();
