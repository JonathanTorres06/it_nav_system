"""
hardware_bridge/bridge.py

El puente: habla MQTT como si fuera la placa 'casa' y reenvia a la placa real
por HTTP.

Reparte el trabajo igual que el simulador:
    - Cada dispositivo (BridgeLight / BridgeDoor) sabe como reaccionar a una
      orden y que estado publicar.
    - La placa del puente (HardwareBridge) tiene UNA conexion MQTT con su Last
      Will, recibe las ordenes y las reparte, y ademas sondea el /estado de la
      placa real para detectar cambios hechos desde su propia pagina (el modo
      directo) y para saber si la placa sigue viva.

Las puertas de la placa real son un toggle instantaneo: no avisan opening ni
closing ni cierran solas. Esa parte del contrato la pone este puente, con sus
propios temporizadores (igual que hacia el simulador).

Patrones:
    - Adapter: traduce el contrato MQTT a las llamadas HTTP de la placa.
    - Template Method: BridgeDevice define los dos pasos que cada tipo rellena.
    - State (puerta): closed -> opening -> open -> closing -> closed.
"""

import argparse
import logging
import queue
import sys
import threading
import time
from abc import ABC, abstractmethod
from typing import Callable, Optional

import paho.mqtt.client as mqtt

from simulator import contract
from simulator.backend_client import (
    DEVICE_TYPE_DOOR,
    DEVICE_TYPE_LIGHT,
    BackendUnavailableError,
    fetch_registered_devices,
)
from simulator.settings import (
    DEFAULT_BACKEND_URL,
    DEFAULT_HOUSE_ID,
    DEFAULT_MQTT_HOST,
    DEFAULT_MQTT_PORT,
    DEFAULT_MQTT_USER,
    KEEPALIVE_SECONDS,
    MS_PER_SECOND,
    RECONNECT_MAX_SECONDS,
    RECONNECT_MIN_SECONDS,
    read_password,
)
from hardware_bridge.board_client import (
    KIND_DOOR,
    KIND_LIGHT,
    BoardHttpClient,
    BoardUnreachable,
    device_key_to_target,
)

logger = logging.getLogger("hardware_bridge")

QOS = 1
CLIENT_ID_PREFIX = "bridge-esp32-"   # Distinto de la placa real y del simulador

# Valores por defecto propios del puente
DEFAULT_BOARD_URL = "http://192.168.4.1"
DEFAULT_BOARD_TIMEOUT_MS = 3000
DEFAULT_DOOR_TRAVEL_MS = 1200     # Lo que tarda el servo en abrir o cerrar (ajustable)
DEFAULT_DOOR_HOLD_MS = 15000      # Cierre de seguridad si la orden no trae hold_ms
DEFAULT_POLL_MS = 2000            # Cada cuanto se relee el /estado de la placa


# ─── Dispositivos ────────────────────────────────────────────────────────

class BridgeDevice(ABC):
    """Un dispositivo de la placa, visto desde el contrato."""

    def __init__(self, device_key: str, lugar: str, client: BoardHttpClient) -> None:
        self.device_key = device_key
        self.lugar = lugar
        self._client = client
        self._publish: Optional[Callable[[str, str], None]] = None

    def bind(self, publish: Callable[[str, str], None]) -> None:
        """La placa del puente le entrega la funcion para publicar estados."""
        self._publish = publish

    def shutdown(self) -> None:
        """Se llama al apagar el puente. Por defecto no hay nada que detener."""
        return None

    @abstractmethod
    def handle_command(self, payload: bytes) -> Optional[str]:
        """Reacciona a una orden; devuelve el estado a publicar de inmediato, o None."""
        ...


class BridgeLight(BridgeDevice):
    """Luz: enciende o apaga la luz real por HTTP."""

    def handle_command(self, payload: bytes) -> Optional[str]:
        command = contract.parse_light_command(payload)
        if command is None:
            return None

        want_on = command == contract.STATE_ON
        try:
            self._client.ensure_light(self.lugar, want_on)
        except BoardUnreachable as error:
            logger.warning("[%s] No se pudo cambiar la luz: %s", self.device_key, error)
            return None  # sin estado: el backend la marcara sin respuesta

        return command  # 'on' u 'off'

    def state_from_board_value(self, is_on: bool) -> str:
        return contract.STATE_ON if is_on else contract.STATE_OFF


class BridgeDoor(BridgeDevice):
    """
    Puerta: abre o cierra el servo real por HTTP y le pone al contrato los
    estados intermedios (opening, closing) y el cierre de seguridad (hold_ms),
    que la placa por si sola no da.
    """

    def __init__(self, device_key: str, lugar: str, client: BoardHttpClient,
                 travel_seconds: float, default_hold_seconds: float) -> None:
        super().__init__(device_key, lugar, client)
        self._travel = travel_seconds
        self._default_hold = default_hold_seconds
        self._lock = threading.Lock()
        self._state = contract.DOOR_CLOSED
        self._token = 0
        self._timers: list[threading.Timer] = []

    def handle_command(self, payload: bytes) -> Optional[str]:
        command = contract.parse_door_command(payload)
        if command is None:
            return None

        with self._lock:
            self._invalidate_timers()
            token = self._token

            if command.action == contract.ACTION_OPEN:
                hold = (command.hold_ms / MS_PER_SECOND) if command.hold_ms else self._default_hold

                if self._state == contract.DOOR_OPEN:
                    # Ya estaba abierta: solo se reinicia el cierre de seguridad
                    self._schedule(hold, self._on_hold_expired, token)
                    return self._state

                if not self._move_board(open_door=True):
                    return None
                self._state = contract.DOOR_OPENING
                self._schedule(self._travel, self._finish_open, token, hold)
                return self._state

            # close: tiene prioridad sobre cualquier cierre automatico pendiente
            if self._state == contract.DOOR_CLOSED:
                return self._state

            if not self._move_board(open_door=False):
                return None
            self._state = contract.DOOR_CLOSING
            self._schedule(self._travel, self._finish_close, token)
            return self._state

    def sync_from_board(self, is_open: bool) -> Optional[str]:
        """
        Pone el estado inicial segun la placa, sin pisar una puerta que esta
        justo abriendo o cerrando.

        Returns:
            El estado a publicar, o None si estaba en plena transicion.
        """
        with self._lock:
            if self._state in (contract.DOOR_OPENING, contract.DOOR_CLOSING):
                return None
            self._state = contract.DOOR_OPEN if is_open else contract.DOOR_CLOSED
            return self._state

    def shutdown(self) -> None:
        with self._lock:
            self._invalidate_timers()

    # ─── Pasos automaticos (corren en hilos de temporizador) ─────────────

    def _finish_open(self, token: int, hold_seconds: float) -> None:
        with self._lock:
            if token != self._token:
                return
            self._state = contract.DOOR_OPEN
            self._schedule(hold_seconds, self._on_hold_expired, token)
        self._announce(contract.DOOR_OPEN)

    def _on_hold_expired(self, token: int) -> None:
        with self._lock:
            if token != self._token:
                return
            logger.info("[%s] Vencio hold_ms: cierre de seguridad.", self.device_key)
            if not self._move_board(open_door=False):
                return
            self._state = contract.DOOR_CLOSING
            self._schedule(self._travel, self._finish_close, token)
        self._announce(contract.DOOR_CLOSING)

    def _finish_close(self, token: int) -> None:
        with self._lock:
            if token != self._token:
                return
            self._state = contract.DOOR_CLOSED
        self._announce(contract.DOOR_CLOSED)

    # ─── Internos ────────────────────────────────────────────────────────

    def _move_board(self, open_door: bool) -> bool:
        """Mueve el servo real. Devuelve False si la placa no respondio."""
        try:
            self._client.ensure_door(self.lugar, open_door)
            return True
        except BoardUnreachable as error:
            logger.warning("[%s] No se pudo mover la puerta: %s", self.device_key, error)
            return False

    def _schedule(self, delay_seconds: float, action: Callable, *args) -> None:
        timer = threading.Timer(delay_seconds, action, args=args)
        timer.daemon = True
        self._timers.append(timer)
        timer.start()

    def _invalidate_timers(self) -> None:
        self._token += 1
        for timer in self._timers:
            timer.cancel()
        self._timers.clear()

    def _announce(self, state: str) -> None:
        if self._publish is not None:
            logger.info("[%s] Estado -> %s", self.device_key, state)
            self._publish(self.device_key, state)


# ─── Placa del puente (lado MQTT) ──────────────────────────────────────────

class HardwareBridge:
    """Una conexion MQTT que se hace pasar por la placa y reenvia a la real."""

    def __init__(self, board_id: str, devices: list[BridgeDevice],
                 client: BoardHttpClient, host: str, port: int, username: str,
                 password: str, poll_seconds: float) -> None:
        self.board_id = board_id
        self._devices = {device.device_key: device for device in devices}
        for device in devices:
            device.bind(self._publish_state)
        self._client_http = client
        self._poll_seconds = poll_seconds
        self._started_at = time.monotonic()
        self._last_light_state: dict[str, str] = {}
        self._board_online: Optional[bool] = None
        self._stop = threading.Event()

        self._commands: queue.Queue = queue.Queue()
        self._worker = threading.Thread(target=self._process_commands, daemon=True)
        self._poller = threading.Thread(target=self._poll_loop, daemon=True)
        self._availability_topic = contract.board_availability_topic(board_id)

        self._mqtt = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2,
            client_id=f"{CLIENT_ID_PREFIX}{board_id}",
            protocol=mqtt.MQTTv311,
        )
        self._mqtt.username_pw_set(username, password)
        self._mqtt.will_set(self._availability_topic, contract.AVAILABILITY_OFFLINE, qos=QOS, retain=True)
        self._mqtt.reconnect_delay_set(RECONNECT_MIN_SECONDS, RECONNECT_MAX_SECONDS)
        self._mqtt.on_connect = self._on_connect
        self._mqtt.on_message = self._on_message
        self._host, self._port = host, port

    # ─── Ciclo de vida ───────────────────────────────────────────────────

    def start(self) -> None:
        self._worker.start()
        self._poller.start()
        self._mqtt.connect_async(self._host, self._port, KEEPALIVE_SECONDS)
        self._mqtt.loop_start()

    def stop(self) -> None:
        """Apagado ordenado: avisa offline y suelta los temporizadores."""
        self._stop.set()
        try:
            info = self._mqtt.publish(self._availability_topic, contract.AVAILABILITY_OFFLINE, qos=QOS, retain=True)
            info.wait_for_publish(timeout=2)
        except Exception as error:
            logger.warning("No se pudo avisar 'offline': %s", error)
        for device in self._devices.values():
            device.shutdown()
        self._commands.put(None)
        self._mqtt.disconnect()
        self._mqtt.loop_stop()

    # ─── MQTT ────────────────────────────────────────────────────────────

    def _on_connect(self, client, userdata, flags, reason_code, properties) -> None:
        if reason_code.is_failure:
            logger.error("El broker rechazo la conexion: %s", reason_code)
            return
        for device_key in self._devices:
            client.subscribe(contract.set_topic(device_key), qos=QOS)
        logger.info("Puente conectado al broker con %d dispositivo(s).", len(self._devices))
        # La disponibilidad y los estados iniciales los pone el sondeo, que ya
        # sabe si la placa responde.

    def _on_message(self, client, userdata, message) -> None:
        self._commands.put((message.topic, message.payload))

    # ─── Procesamiento de ordenes ────────────────────────────────────────

    def _process_commands(self) -> None:
        while True:
            item = self._commands.get()
            if item is None:
                return
            topic, payload = item
            device = self._find_device(topic)
            if device is None:
                logger.warning("Orden para un tema que no manejo: %s", topic)
                continue
            try:
                new_state = device.handle_command(payload)
            except Exception:
                logger.exception("[%s] Error atendiendo una orden.", device.device_key)
                continue
            if new_state is not None:
                self._publish_state(device.device_key, new_state)

    def _find_device(self, topic: str) -> Optional[BridgeDevice]:
        for device_key, device in self._devices.items():
            if topic == contract.set_topic(device_key):
                return device
        return None

    # ─── Sondeo del /estado de la placa real ─────────────────────────────

    def _poll_loop(self) -> None:
        while not self._stop.is_set():
            try:
                state = self._client_http.get_state()
                self._on_reachable(state)
            except BoardUnreachable:
                self._on_unreachable()
            self._stop.wait(self._poll_seconds)

    def _on_reachable(self, state: dict) -> None:
        going_online = self._board_online is not True
        if going_online:
            self._board_online = True
            logger.info("Placa en linea.")
            self._mqtt.publish(self._availability_topic, contract.AVAILABILITY_ONLINE, qos=QOS, retain=True)
            self._publish_initial_states(state)
        else:
            self._publish_light_changes(state)

    def _on_unreachable(self) -> None:
        if self._board_online is not False:
            self._board_online = False
            logger.warning("Placa sin respuesta: se avisa offline.")
            self._mqtt.publish(self._availability_topic, contract.AVAILABILITY_OFFLINE, qos=QOS, retain=True)

    def _publish_initial_states(self, state: dict) -> None:
        """Al (re)conectar con la placa, publica como esta cada dispositivo."""
        lights = state.get("luces", {})
        doors = state.get("puertas", {})
        for device in self._devices.values():
            if isinstance(device, BridgeLight):
                self._publish_state(device.device_key, device.state_from_board_value(bool(lights.get(device.lugar, 0))))
            elif isinstance(device, BridgeDoor):
                door_state = device.sync_from_board(bool(doors.get(device.lugar, 0)))
                if door_state is not None:
                    self._publish_state(device.device_key, door_state)

    def _publish_light_changes(self, state: dict) -> None:
        """Publica las luces que cambiaron en la placa (ej: desde el modo directo)."""
        lights = state.get("luces", {})
        for device in self._devices.values():
            if not isinstance(device, BridgeLight):
                continue
            new_state = device.state_from_board_value(bool(lights.get(device.lugar, 0)))
            if self._last_light_state.get(device.device_key) != new_state:
                self._publish_state(device.device_key, new_state)

    # ─── Publicacion ─────────────────────────────────────────────────────

    def _publish_state(self, device_key: str, state: str) -> None:
        if device_key.startswith("light_"):
            self._last_light_state[device_key] = state
        elapsed_ms = int((time.monotonic() - self._started_at) * MS_PER_SECOND)
        self._mqtt.publish(contract.state_topic(device_key), contract.encode_state(state, elapsed_ms), qos=QOS, retain=True)


# ─── Arranque por linea de comandos ────────────────────────────────────────

def _build_devices(device_keys: list[str], client: BoardHttpClient,
                   travel_s: float, hold_s: float) -> list[BridgeDevice]:
    """Crea un dispositivo del puente por cada device_key que tenga equivalente en la placa."""
    devices: list[BridgeDevice] = []
    for key in device_keys:
        target = device_key_to_target(key)
        if target is None:
            logger.info("Se omite '%s': no tiene equivalente en la placa (ej: comedor).", key)
            continue
        kind, lugar = target
        if kind == KIND_LIGHT:
            devices.append(BridgeLight(key, lugar, client))
        elif kind == KIND_DOOR:
            devices.append(BridgeDoor(key, lugar, client, travel_s, hold_s))
    return devices


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m hardware_bridge",
        description="Puente entre el broker MQTT y la placa real de la casa (luces y puertas).",
    )
    parser.add_argument("--board-url", default=DEFAULT_BOARD_URL, help="Raiz HTTP de la placa (ej: http://192.168.4.1).")
    parser.add_argument("--board-timeout-ms", type=int, default=DEFAULT_BOARD_TIMEOUT_MS)
    parser.add_argument("--board-id", default=contract.HOUSE_BOARD_ID)
    parser.add_argument("--lights", nargs="+", metavar="DEVICE_KEY", help="Luces a manejar (si no, se leen del backend).")
    parser.add_argument("--doors", nargs="+", metavar="DEVICE_KEY", help="Puertas a manejar (si no, se leen del backend).")
    parser.add_argument("--backend-url", default=DEFAULT_BACKEND_URL)
    parser.add_argument("--house-id", type=int, default=DEFAULT_HOUSE_ID)
    parser.add_argument("--host", default=DEFAULT_MQTT_HOST, help="Direccion del broker MQTT.")
    parser.add_argument("--port", type=int, default=DEFAULT_MQTT_PORT)
    parser.add_argument("--user", default=DEFAULT_MQTT_USER)
    parser.add_argument("--door-travel-ms", type=int, default=DEFAULT_DOOR_TRAVEL_MS)
    parser.add_argument("--door-hold-ms", type=int, default=DEFAULT_DOOR_HOLD_MS)
    parser.add_argument("--poll-ms", type=int, default=DEFAULT_POLL_MS)
    return parser


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    args = build_parser().parse_args()

    if args.lights is None and args.doors is None:
        try:
            light_keys = fetch_registered_devices(args.backend_url, args.house_id, DEVICE_TYPE_LIGHT)
            door_keys = fetch_registered_devices(args.backend_url, args.house_id, DEVICE_TYPE_DOOR)
        except BackendUnavailableError as error:
            logger.error("%s", error)
            logger.error("Enciende el backend o indica los dispositivos con --lights / --doors.")
            return 1
    else:
        light_keys = args.lights or []
        door_keys = args.doors or []

    client = BoardHttpClient(args.board_url, args.board_timeout_ms / MS_PER_SECOND)
    devices = _build_devices(
        light_keys + door_keys, client,
        args.door_travel_ms / MS_PER_SECOND, args.door_hold_ms / MS_PER_SECOND,
    )
    if not devices:
        logger.error("No hay dispositivos con equivalente en la placa para manejar.")
        return 1

    logger.info("Puente hacia %s como placa '%s': %d dispositivo(s).", args.board_url, args.board_id, len(devices))
    logger.info("Broker %s:%s como '%s'. Ctrl+C para cerrar.", args.host, args.port, args.user)

    bridge = HardwareBridge(
        args.board_id, devices, client,
        args.host, args.port, args.user, read_password(),
        args.poll_ms / MS_PER_SECOND,
    )
    bridge.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        logger.info("Cerrando el puente…")
        bridge.stop()
        return 0


if __name__ == "__main__":
    sys.exit(main())
