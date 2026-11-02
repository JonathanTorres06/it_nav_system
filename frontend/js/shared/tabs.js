/**
 * Navegacion entre pestanias del panel (una sola pagina, varias vistas).
 * Vistas: elementos con data-view. Enlaces: <a data-tab="nombre">.
 * El indicador del menu se desplaza a la pestania activa y la vista entra segun la direccion del cambio.
 */
const Tabs = (() => {
	"use strict";

	// Pestanias pendientes: solo muestran un aviso
	const COMING_SOON = Object.freeze({
		settings: "Configuración",
		help: "Ayuda"
	});
	const ENTER_MS = 240;
	const ENTER_SHIFT_PX = 16;
	const ENTER_EASING = "cubic-bezier(0.23, 1, 0.32, 1)";

	/** nombre -> { element, onShow } */
	const registry = new Map();
	const pills = new Map(); // nav -> indicador
	let current = null;

	const links = () => Array.from(document.querySelectorAll("nav a[data-tab]"));
	const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

	function register(name, {
		element,
		onShow
	}) {
		registry.set(name, {
			element,
			onShow
		});
	}

	// --- Indicador deslizante ---------------------------------------------------

	function pillFor(nav) {
		if (!pills.has(nav)) {
			const pill = document.createElement("span");
			pill.className = "tab-pill";
			pill.setAttribute("aria-hidden", "true");
			nav.prepend(pill);
			pills.set(nav, pill);
			// el menu de dev inicia oculto: se recalcula al mostrarse
			if (window.ResizeObserver) new ResizeObserver(() => movePills(false)).observe(nav);
		}
		return pills.get(nav);
	}

	/** Posiciona el indicador bajo el enlace activo (sin animacion la primera vez) */
	function movePills(animate) {
		pills.forEach((pill, nav) => {
			const active = nav.querySelector('a[aria-current="page"]');
			if (!active) return;
			const box = active.getBoundingClientRect();
			const navBox = nav.getBoundingClientRect();
			pill.style.width = `${box.width}px`;
			pill.style.height = `${box.height}px`;
			pill.style.transform = `translate(${box.left - navBox.left + nav.scrollLeft}px, ${box.top - navBox.top}px)`;
			if (!animate) {
				pill.classList.remove("is-ready");
				void pill.offsetWidth;
			}
			pill.classList.add("is-ready");
		});
	}

	// --- Cambio de vista --------------------------------------------------------

	/** Entrada de la vista: desde la derecha al avanzar, desde la izquierda al retroceder */
	function enter(element, direction) {
		if (reducedMotion() || !element.animate) return;
		element.animate([{
			opacity: 0,
			transform: `translateX(${direction * ENTER_SHIFT_PX}px)`
		}, {
			opacity: 1,
			transform: "none"
		}], {
			duration: ENTER_MS,
			easing: ENTER_EASING
		});
	}

	function show(name) {
		if (!registry.has(name)) return;
		Banner.hide(); // el aviso de una pestania no persiste en otra
		const names = Array.from(registry.keys());
		const direction = current === null ? 0 : Math.sign(names.indexOf(name) - names.indexOf(current)) || 1;
		registry.forEach((tab, tabName) => {
			tab.element.hidden = tabName !== name;
		});
		links().forEach((link) => {
			if (link.dataset.tab === name) link.setAttribute("aria-current", "page");
			else link.removeAttribute("aria-current");
		});
		const firstTime = current === null;
		current = name;
		movePills(!firstTime);
		registry.get(name).onShow();
		if (!firstTime) enter(registry.get(name).element, direction);
	}

	/** Conecta los enlaces del menu */
	function init() {
		links().forEach((link) => {
			pillFor(link.closest("nav"));
			link.addEventListener("click", (event) => {
				event.preventDefault();
				const name = link.dataset.tab;
				if (COMING_SOON[name]) {
					Toast.show(`${COMING_SOON[name]} · próximamente`);
					return;
				}
				if (name !== current) show(name);
			});
		});
		window.addEventListener("resize", () => movePills(false));
		// El ancho de los enlaces cambia al cargar las fuentes
		if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => movePills(false));
	}

	return Object.freeze({
		register,
		show,
		init
	});
})();
