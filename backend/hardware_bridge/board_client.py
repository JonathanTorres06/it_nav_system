"""
hardware_bridge/board_client.py

Cliente HTTP de la placa real de la casa.

Responsabilidad: hablar con los endpoints de la placa (CodigoFinal.ino) y
traducir entre los nombres del contrato (device_key, como 'light_sala') y los
nombres que usa la placa en su URL (el lugar, como 'sala'). Nada de MQTT aqui.

Dato importante del firmware: /luz y /puerta son INTERRUPTORES (toggle), no
ordenes absolutas. Por eso, para dejar una luz en 'on', primero leemos /estado
y solo mandamos el toggle si hace falta.

Usa solo la libreria estandar (urllib), para que el puente sea ligero.
"""

import json
import logging
import threading
import urllib.error
import urllib.request

logger = logging.getLogger("hardware_bridge")

LIGHT_PREFIX = "light_"
DOOR_PREFIX = "door_"

# Nombre interno del backend -> lugar de la placa (ver CodigoFinal.ino).
# El comedor no tiene equivalente fisico, por eso no esta en el mapa: sus
# ordenes se ignoran y el backend las marcara como "sin respuesta".
ROOM_TO_LUGAR = {
    "sala": "sala",
    "cocina": "cocina",
    "banio": "bano",
    "cuarto_principal": "cuarto1",
    "cuarto_secundario": "cuarto2",
}

KIND_LIGHT = "light"
KIND_DOOR = "door"


class BoardUnreachable(Exception):
    """No se pudo hablar con la placa (apagada, fuera de la red, etc.)."""


def device_key_to_target(device_key: str):
    """
    Traduce un device_key del contrato al par (tipo, lugar) de la placa.

    Returns:
        (tipo, lugar), por ejemplo ('light', 'sala'); o None si ese
        dispositivo no tiene equivalente en la placa (como el comedor).
    """
    if device_key.startswith(LIGHT_PREFIX):
        room = device_key[len(LIGHT_PREFIX):]
        kind = KIND_LIGHT
    elif device_key.startswith(DOOR_PREFIX):
        room = device_key[len(DOOR_PREFIX):]
        kind = KIND_DOOR
    else:
        return None

    lugar = ROOM_TO_LUGAR.get(room)
    if lugar is None:
        return None
    return kind, lugar


class BoardHttpClient:
    """Habla con la placa por HTTP. Serializa el acceso para no pisar ordenes."""

    def __init__(self, base_url: str, timeout_seconds: float) -> None:
        """
        Args:
            base_url: raiz de la placa, por ejemplo 'http://192.168.4.1'.
            timeout_seconds: cuanto esperar cada peticion HTTP.
        """
        self._base = base_url.rstrip("/")
        self._timeout = timeout_seconds
        self._lock = threading.Lock()

    # ─── Peticiones basicas ──────────────────────────────────────────────

    def _get(self, path: str) -> str:
        url = self._base + path
        try:
            with urllib.request.urlopen(url, timeout=self._timeout) as response:
                return response.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, OSError, TimeoutError) as error:
            raise BoardUnreachable(f"No respondio {url}: {error}") from error

    def get_state(self) -> dict:
        """
        Lee /estado y lo devuelve como diccionario.

        Forma esperada: {"luces":{"sala":0/1,...},"puertas":{"bano":0/1,...},...}
        """
        text = self._get("/estado")
        try:
            data = json.loads(text)
        except json.JSONDecodeError as error:
            raise BoardUnreachable(f"El /estado no es JSON valido: {error}") from error
        if not isinstance(data, dict):
            raise BoardUnreachable("El /estado no es un objeto JSON.")
        return data

    # ─── Dejar un dispositivo en un estado concreto ──────────────────────

    def ensure_light(self, lugar: str, want_on: bool) -> None:
        """Deja la luz encendida o apagada; solo manda el toggle si hace falta."""
        with self._lock:
            lights = self.get_state().get("luces", {})
            current = bool(lights.get(lugar, 0))
            if current != want_on:
                self._get(f"/luz?lugar={lugar}")

    def ensure_door(self, lugar: str, want_open: bool) -> None:
        """Deja la puerta abierta o cerrada; solo manda el toggle si hace falta."""
        with self._lock:
            doors = self.get_state().get("puertas", {})
            current = bool(doors.get(lugar, 0))
            if current != want_open:
                self._get(f"/puerta?lugar={lugar}")

    # ─── Lectura para el sondeo de estado ────────────────────────────────

    def read_lights(self) -> dict:
        """Devuelve {lugar: bool} con las luces, segun la placa."""
        with self._lock:
            lights = self.get_state().get("luces", {})
        return {lugar: bool(value) for lugar, value in lights.items()}

    def is_reachable(self) -> bool:
        """True si la placa responde su /estado ahora mismo."""
        try:
            with self._lock:
                self.get_state()
            return True
        except BoardUnreachable:
            return False
