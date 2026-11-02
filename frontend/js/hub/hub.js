/**
	* Pantalla central: presentacion del logo, estado del servicio y acceso a desarrollo.
	* El acceso a desarrollo pide la clave, la valida contra el backend y la guarda en
	* sessionStorage (misma clave que lee dev.html) antes de redirigir.
*/
(() => {
	"use strict";

	const DEV_PAGE = "dev.html";
	const SERVICE_TIMEOUT_MS = 4000;
	const OPEN_PAUSE_MS = 750; // pausa con el candado abierto antes de redirigir
	const INTRO_KEY = "it_intro";
	const INTRO_BEAT_MS = 1300;
	const INTRO_FLY_MS = 1950;
	const INTRO_FLIGHT_MS = 520;
	const EASE_IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)";

	// Igual que DevApi: origen propio si lo sirve el backend
	const serviceUrl = location.protocol.startsWith("http") ? location.origin : "http://localhost:8001";

	const $ = (id) => document.getElementById(id);
	const door = $("devDoor");
	const doorLabel = $("devDoorLabel");
	const doorLock = $("devLock");
	const dialog = $("unlockDialog");
	const dialogLock = $("dialogLock");
	const form = $("unlockForm");
	const input = $("unlockInput");
	const submit = $("unlockSubmit");
	const status = $("serviceStatus");
	const statusText = $("serviceStatusText");

	const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	/** Reinicia una animacion CSS reaplicando la clase */
	function replay(node, className) {
		node.classList.remove(className);
		void node.offsetWidth;
		node.classList.add(className);
		node.addEventListener("animationend", () => node.classList.remove(className), {
			once: true
		});
	}

	// --- Presentacion del logo ---------------------------------------------

	/**
		* Secuencia: trazo del logo, latido y traslado a la barra (FLIP).
		* Un clic o una tecla la omite.
	*/
	function playIntro() {
		const intro = $("intro");
		const logo = intro.querySelector(".logo");
		const target = document.querySelector(".topbar .brand-mark");
		let flown = false;
		const timers = [];

		try {
			sessionStorage.setItem(INTRO_KEY, "1");
		} catch (e) { /* sin almacenamiento: la presentacion se repite */ }

		logo.classList.add("is-drawing");
		timers.push(setTimeout(() => logo.classList.add("is-beating"), INTRO_BEAT_MS));

		function fly() {
			if (flown) return;
			flown = true;
			timers.forEach(clearTimeout);
			const from = logo.getBoundingClientRect();
			const to = target.getBoundingClientRect();
			const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
			const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
			const move = logo.animate([{
				transform: "none"
			}, {
				transform: `translate(${dx}px, ${dy}px) scale(${to.width / from.width})`
			}], {
				duration: INTRO_FLIGHT_MS,
				easing: EASE_IN_OUT,
				fill: "forwards"
			});
			intro.querySelector(".intro-bg").animate([{
				opacity: 1
			}, {
				opacity: 0
			}], {
				duration: INTRO_FLIGHT_MS,
				easing: "ease-out",
				fill: "forwards"
			});
			move.finished.then(() => {
				target.style.opacity = "1";
				intro.remove();
				replay(target, "is-beating"); // latido final al llegar
			}).catch(() => {
				intro.remove();
				target.style.opacity = "1";
			});
		}

		timers.push(setTimeout(fly, INTRO_FLY_MS));
		intro.addEventListener("click", fly);
		document.addEventListener("keydown", fly, {
			once: true
		});
	}

	// --- Mascota: inclinacion segun el cursor -------------------------

	function followPointer() {
		const guard = $("guard");
		const picture = guard && guard.querySelector("img");
		if (!picture || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
		let x = 0,
			y = 0,
			tilt = 0;
		let goalX = 0,
			goalY = 0,
			goalTilt = 0;
		let frame = 0;

		function step() {
			// interpolacion exponencial hacia el objetivo (inercia)
			x += (goalX - x) * 0.08;
			y += (goalY - y) * 0.08;
			tilt += (goalTilt - tilt) * 0.08;
			picture.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) rotate(${tilt.toFixed(2)}deg)`;
			const left = Math.abs(goalX - x) + Math.abs(goalY - y) + Math.abs(goalTilt - tilt);
			frame = left > 0.02 ? requestAnimationFrame(step) : 0;
		}

		document.addEventListener("pointermove", (event) => {
			const nx = (event.clientX / window.innerWidth - 0.5) * 2;
			const ny = (event.clientY / window.innerHeight - 0.5) * 2;
			goalX = nx * 10;
			goalY = ny * 6;
			goalTilt = nx * 3.5;
			if (!frame) frame = requestAnimationFrame(step);
		}, {
			passive: true
		});
	}

	// --- Estado del servicio -----------------------------------------------

	const STATUS_TEXT = {
		checking: "Comprobando servicio…",
		online: "Servicio de navegación en línea",
		offline: "Sin conexión con el servicio"
	};

	function setStatus(state) {
		status.dataset.state = state;
		statusText.textContent = STATUS_TEXT[state];
	}

	/** Cualquier respuesta HTTP se considera servicio en linea */
	async function checkService() {
		setStatus("checking");
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), SERVICE_TIMEOUT_MS);
		try {
			await fetch(`${serviceUrl}/user/nodes`, {
				signal: controller.signal
			});
			setStatus("online");
		} catch (error) {
			setStatus("offline");
		} finally {
			clearTimeout(timer);
		}
	}

	// --- Puerta de desarrollo ----------------------------------------------

	function markDoorOpen() {
		door.classList.add("is-open");
		doorLock.dataset.lock = "open";
		doorLabel.textContent = "Entrar";
	}

	const goToDev = () => {
		location.href = DEV_PAGE;
	};

	const noteHtml = $("unlockNote").innerHTML;

	function resetDialog() {
		dialogLock.dataset.lock = "locked";
		dialog.classList.remove("is-ok");
		$("unlockTitle").textContent = "Clave de desarrollador";
		$("unlockNote").innerHTML = noteHtml;
		submit.className = "btn btn-primary";
		submit.textContent = "Desbloquear";
		submit.disabled = false;
		Fields.clear(input);
		input.value = "";
	}

	function openDialog() {
		resetDialog();
		dialog.showModal();
		input.focus();
	}

	door.addEventListener("click", () => {
		// Con clave en sessionStorage se entra directo; dev.html la revalida.
		if (DevApi.KeyStore.get()) goToDev();
		else openDialog();
	});

	$("unlockCancel").addEventListener("click", () => dialog.close());

	/** Clave rechazada: muestra el error en el campo y anima el candado */
	function rejectKey(message) {
		Fields.error(input, message);
		replay(dialogLock, "is-rattle");
		input.focus();
	}

	form.addEventListener("submit", async (event) => {
		event.preventDefault(); // campo vacio: validado antes por forms.js
		const key = input.value.trim();
		submit.classList.add("is-loading");
		submit.textContent = "Comprobando…";
		try {
			await DevApi.fetchOverview(key); // valida la clave antes de guardarla
			DevApi.KeyStore.set(key);
			// el candado se abre en el dialogo y luego se redirige
			dialogLock.dataset.lock = "open";
			replay(dialogLock, "is-pulse");
			dialog.classList.add("is-ok");
			$("unlockTitle").textContent = "Puerta abierta";
			$("unlockNote").textContent = "Entrando al panel de desarrollo…";
			submit.classList.remove("is-loading");
			submit.classList.add("is-done");
			submit.textContent = "Abierta";
			markDoorOpen();
			await wait(prefersReducedMotion() ? 0 : OPEN_PAUSE_MS);
			goToDev();
		} catch (error) {
			submit.classList.remove("is-loading");
			submit.textContent = "Desbloquear";
			if (error.kind === "unauthorized") rejectKey("Esa clave no abre la puerta. Revisa el archivo backend/.env.");
			else rejectKey(error.message || "No se pudo comprobar la clave.");
		}
	});

	status.addEventListener("click", checkService);

	// --- Arranque ------------------------------------------------------------

	if (DevApi.KeyStore.get()) markDoorOpen();
	if (document.documentElement.classList.contains("has-intro")) playIntro();
	followPointer();
	checkService();
})();
