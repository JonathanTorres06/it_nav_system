/**
	* Pantalla del panel de desarrollo: Pedir la clave, listar, crear y eliminar
	* casas. Solo usa DevApi (no hace fetch directo) y Toast/Banner compartidos.
	*
	* Capa: Presentacion.
	* Analogia: Es como si fuera la ventanilla de una oficina de registro; recibe la llave,
	* muestra el libro de casas y exige firmar el nombre antes de demoler una.
*/
(() => {
	"use strict";

	const $ = (id) => document.getElementById(id);
	const keyForm = $("keyForm"),
		keyInput = $("keyInput"),
		keyForget = $("keyForget"),
		keyCard = $("keyCard"),
		keyTitle = $("keyTitle");
	const workArea = $("workArea"),
		activeWarning = $("activeWarning");
	const housesBody = $("housesBody"),
		housesEmpty = $("housesEmpty"),
		housesTable = $("housesTable");
	const createForm = $("createForm"),
		createName = $("createName"),
		createDescription = $("createDescription");
	const dialog = $("deleteDialog"),
		deleteForm = $("deleteForm"),
		deleteMessage = $("deleteMessage");
	const deleteActive = $("deleteActive"),
		deleteConfirm = $("deleteConfirm");
	const deleteOk = $("deleteOk"),
		deleteCancel = $("deleteCancel");

	let pendingDelete = null; // casa que se esta por eliminar

	/** Muestra u oculta el area de trabajo segun haya sesion con clave valida */
	function setUnlocked(unlocked) {
		workArea.hidden = !unlocked;
		keyForget.hidden = !unlocked;
		// sesion abierta: tarjeta de clave en modo compacto
		keyCard.classList.toggle("is-unlocked", unlocked);
		$("keyLock").dataset.lock = unlocked ? "open" : "locked";
		keyTitle.textContent = unlocked ? "Sesión de desarrollo abierta" : "Clave de desarrollador";
	}

	/** Traduce un error a un aviso visible */
	function reportError(error) {
		if (error.kind === "unauthorized") {
			DevApi.KeyStore.clear();
			setUnlocked(false);
			// error junto al campo y animacion del candado
			Fields.error(keyInput, "Esa clave no abre la puerta. Revisa que sea la de backend/.env.");
			const lock = $("keyLock");
			lock.classList.remove("is-rattle");
			void lock.offsetWidth;
			lock.classList.add("is-rattle");
			return;
		}
		Banner.show(error.message, error.kind === "network" ? refresh : null);
	}

	/** Dibuja el aviso de casa activa y la tabla de casas */
	function render(overview) {
		// El letrero solo aparece cuando hay un problema real o algo que conviene saber
		const noHouses = overview.houses.length === 0;
		const manyHouses = overview.houses.length > 1;
		activeWarning.hidden = !(noHouses || manyHouses);

		if (noHouses) {
			activeWarning.textContent = "Atención: no hay ninguna casa registrada, el sistema de navegación no funcionará. Crea una abajo.";
		} else if (manyHouses) {
			activeWarning.textContent = "Hay varias casas. El sistema usa solo la activa (la de menor ID); las demas no se ven en el panel de usuario.";
		}

		housesBody.replaceChildren();
		housesEmpty.hidden = overview.houses.length > 0;
		housesTable.hidden = overview.houses.length === 0;

		overview.houses.forEach((house) => {
			const row = document.createElement("tr");
			const nameCell = document.createElement("td");
			nameCell.textContent = house.name;
			if (house.is_active) {
				const badge = document.createElement("span");
				badge.className = "dev-badge";
				badge.textContent = "activa";
				nameCell.append(badge);
			}
			const button = document.createElement("button");
			button.type = "button";
			button.className = "dev-btn dev-btn--danger";
			button.textContent = "Eliminar";
			button.addEventListener("click", () => openDeleteDialog(house));
			const actionCell = document.createElement("td");
			actionCell.append(button);

			[String(house.id), null, String(house.node_count)].forEach((text, i) => {
				if (i === 1) {
					row.append(nameCell);
					return;
				}
				const cell = document.createElement("td");
				cell.textContent = text;
				row.append(cell);
			});
			row.append(actionCell);
			housesBody.append(row);
		});
	}

	/** Carga el resumen desde el backend */
	async function refresh() {
		try {
			Banner.hide();
			render(await DevApi.fetchOverview());
			setUnlocked(true);
		} catch (error) {
			reportError(error);
		}
	}

	// ----- Eventos -----
	keyForm.addEventListener("submit", async(event) => {
		event.preventDefault();
		const key = keyInput.value.trim();
		if (!key) return;
		try {
			render(await DevApi.fetchOverview(key)); // valida la clave antes de guardarla
			DevApi.KeyStore.set(key);
			keyInput.value = "";
			setUnlocked(true);
		} catch (error) {
			reportError(error);
		}
	});

	keyForget.addEventListener("click", () => {
		DevApi.KeyStore.clear();
		setUnlocked(false);
		Toast.show("Sesión cerrada. La clave ya no está en este navegador.");
	});

	createForm.addEventListener("submit", async(event) => {
		event.preventDefault();
		try {
			await DevApi.createHouse(createName.value.trim(), createDescription.value.trim());
			createForm.reset();
			Toast.show("Casa creada.");
			await refresh();
		} catch (error) {
			reportError(error);
		}
	});

	function openDeleteDialog(house) {
		pendingDelete = house;
		deleteMessage.textContent =
			`Se eliminará "${house.name}" con sus ${house.node_count} nodos, alias y conexiones. No se puede deshacer.`;
		deleteActive.hidden = !house.is_active;
		deleteConfirm.value = "";
		deleteOk.disabled = true;
		dialog.showModal();
		deleteConfirm.focus();
	}

	deleteConfirm.addEventListener("input", () => {
		deleteOk.disabled = !pendingDelete || deleteConfirm.value.trim() !== pendingDelete.name;
	});
	deleteCancel.addEventListener("click", () => dialog.close());

	deleteForm.addEventListener("submit", async(event) => {
		event.preventDefault();
		if (!pendingDelete) return;
		try {
			const result = await DevApi.deleteHouse(pendingDelete.id, deleteConfirm.value.trim());
			dialog.close();
			Toast.show(result.message);
			await refresh();
		} catch (error) {
			dialog.close();
			reportError(error);
		}
	});

	// Arranque. Si ya hay clave guardada en esta pestana, entra directo
	if (DevApi.KeyStore.get()) refresh();
})();