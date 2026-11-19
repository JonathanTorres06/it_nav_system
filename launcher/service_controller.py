"""
launcher/service_controller.py

Controla el ciclo de vida de UN servicio, imitando lo que hace el
ProcessManager de Unity (seccion 4.6 del contrato de pruebas):

    1. Antes de arrancar, comprueba si el servicio ya responde. Si ya esta
       vivo, lo REUTILIZA y no lanza un segundo (ni lo apagara al cerrar).
    2. Lo lanza como proceso oculto, con el python del venv, inyectando
       PYTHONUNBUFFERED y PYTHONUTF8.
    3. Espera a que responda su /health antes de darlo por listo.
    4. Al apagarlo, mata el ARBOL de procesos con taskkill /T /F (el python
       de un venv suele crear un proceso hijo; matar solo al padre deja huerfano).

Solo apaga lo que el mismo arranco. Lo que ya estaba corriendo no se toca.

Patron aplicado:
    - State (ligero): el servicio pasa por stopped -> starting -> running.
    Analogia: un semaforo; cada color permite unas acciones y no otras.

Depende solo de la libreria estandar, para que el lanzador sea robusto.
"""

import logging
import os
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from typing import Optional

from services_config import ServiceConfig

logger = logging.getLogger("launcher")

# Estados que ve la interfaz
STATE_STOPPED = "stopped"      # no responde y el lanzador no lo arranco
STATE_STARTING = "starting"    # el lanzador lo lanzo y espera su /health
STATE_RUNNING = "running"      # responde y lo arranco el lanzador
STATE_EXTERNAL = "external"    # responde pero lo arranco otra persona (reutilizado)
STATE_ERROR = "error"          # fallo al arrancar o no respondio a tiempo
STATE_ONLINE = "online"        # para servicios solo observados (el broker)
STATE_OFFLINE = "offline"

_TCP_TIMEOUT_S = 1.0
_HEALTH_TIMEOUT_S = 2.0
_POLL_INTERVAL_S = 0.5
# Bandera de Windows para lanzar sin abrir una ventana de consola
_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class ServiceController:
    """Arranca, observa y apaga un unico servicio."""

    def __init__(self, config: ServiceConfig) -> None:
        self._config = config
        self._lock = threading.Lock()
        self._process: Optional[subprocess.Popen] = None
        self._owned = False          # True si este lanzador lo arranco
        self._starting = False
        self._error: str = ""

    @property
    def name(self) -> str:
        return self._config.name

    # ─── Comprobaciones ──────────────────────────────────────────────────

    def _tcp_open(self) -> bool:
        """True si algo escucha en host:puerto."""
        try:
            with socket.create_connection((self._config.host, self._config.port), _TCP_TIMEOUT_S):
                return True
        except OSError:
            return False

    def _health_ok(self) -> bool:
        """
        True si el servicio esta listo.

        Si expone /health se usa HTTP (2xx); si no, basta con que el puerto
        este abierto (asi se observa el broker, que no habla HTTP).
        """
        url = self._config.health_url
        if not url:
            return self._tcp_open()

        try:
            request = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(request, timeout=_HEALTH_TIMEOUT_S) as response:
                return 200 <= response.status < 300
        except (urllib.error.URLError, OSError, ValueError):
            return False

    # ─── Arranque ────────────────────────────────────────────────────────

    def start(self) -> None:
        """
        Arranca el servicio si hace falta.

        No hace nada si solo se observa (el broker), si ya lo esta arrancando,
        o si ya responde (en ese caso lo marca como reutilizado).
        """
        if not self._config.managed:
            return

        with self._lock:
            if self._starting:
                return

        # Reutilizar: si ya responde, no lanzamos un segundo. Si no lo arranco
        # este lanzador queda como reutilizado (external); si ya era nuestro,
        # sigue siendo nuestro (no se toca _owned).
        if self._health_ok():
            with self._lock:
                self._error = ""
            logger.info("[%s] Ya responde: no se lanza otro.", self._config.name)
            return

        try:
            process = self._spawn()
        except OSError as error:
            with self._lock:
                self._error = f"No se pudo iniciar: {error}"
                self._starting = False
            logger.error("[%s] %s", self._config.name, self._error)
            return

        with self._lock:
            self._process = process
            self._owned = True
            self._starting = True
            self._error = ""

        threading.Thread(target=self._wait_until_ready, daemon=True).start()
        logger.info("[%s] Lanzado (PID %s); esperando /health…", self._config.name, process.pid)

    def _spawn(self) -> subprocess.Popen:
        """Lanza el proceso oculto con el entorno del contrato (seccion 4.6)."""
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONUTF8"] = "1"

        return subprocess.Popen(
            [self._config.executable, *self._config.args],
            cwd=self._config.cwd,
            env=env,
            creationflags=_CREATE_NO_WINDOW,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def _wait_until_ready(self) -> None:
        """Espera a que responda /health, o marca error si se pasa del plazo."""
        deadline = time.monotonic() + self._config.ready_timeout_s

        while time.monotonic() < deadline:
            process = self._process
            if process is not None and process.poll() is not None:
                with self._lock:
                    self._starting = False
                    self._error = "El proceso terminó solo antes de responder."
                logger.error("[%s] Termino solo durante el arranque.", self._config.name)
                return

            if self._health_ok():
                with self._lock:
                    self._starting = False
                    self._error = ""
                logger.info("[%s] Listo (respondio /health).", self._config.name)
                return

            time.sleep(_POLL_INTERVAL_S)

        # Se acabo el tiempo: no respondio. Se mata lo que quedo a medias.
        logger.error("[%s] No respondio en %ss.", self._config.name, self._config.ready_timeout_s)
        self._kill_tree()
        with self._lock:
            self._starting = False
            self._error = f"No respondió en {int(self._config.ready_timeout_s)} s."

    # ─── Apagado ─────────────────────────────────────────────────────────

    def stop(self) -> None:
        """
        Apaga el servicio SOLO si lo arranco este lanzador.

        Lo que ya estaba corriendo (reutilizado) no se toca, igual que hace
        Unity: no apaga lo que no es suyo.
        """
        if not self._config.managed:
            return

        with self._lock:
            owned = self._owned
            process = self._process

        if not owned or process is None:
            logger.info("[%s] No lo arranco este lanzador: no se apaga.", self._config.name)
            with self._lock:
                self._starting = False
            return

        self._kill_tree()
        with self._lock:
            self._process = None
            self._owned = False
            self._starting = False
            self._error = ""
        logger.info("[%s] Apagado.", self._config.name)

    def _kill_tree(self) -> None:
        """Mata el proceso y todos sus hijos (taskkill /T /F)."""
        process = self._process
        if process is None or process.poll() is not None:
            return
        try:
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                capture_output=True,
                creationflags=_CREATE_NO_WINDOW,
            )
        except OSError as error:
            logger.error("[%s] Error al matar el arbol: %s", self._config.name, error)

    # ─── Estado para la interfaz ─────────────────────────────────────────

    def status(self) -> dict:
        """Foto del estado actual, lista para enviar a la pagina."""
        healthy = self._health_ok()

        with self._lock:
            owned = self._owned
            starting = self._starting
            error = self._error

        if not self._config.managed:
            state = STATE_ONLINE if healthy else STATE_OFFLINE
        elif starting and not healthy:
            state = STATE_STARTING
        elif healthy:
            state = STATE_RUNNING if owned else STATE_EXTERNAL
        elif error:
            state = STATE_ERROR
        else:
            state = STATE_STOPPED

        return {
            "name": self._config.name,
            "label": self._config.label,
            "managed": self._config.managed,
            "port": self._config.port,
            "note": self._config.note,
            "state": state,
            "healthy": healthy,
            "error": error,
        }
