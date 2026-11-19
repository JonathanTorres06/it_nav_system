"""
launcher/services_config.py

Catalogo de servicios que el lanzador puede arrancar y observar.

Responsabilidad: reunir en un solo lugar las rutas, argumentos y formas de
comprobar que cada servicio esta listo. Si manana cambia la carpeta de un
servicio o su puerta, se edita aqui y nada mas.

Es el equivalente del perfil ServicesConfig que usa Unity (seccion 4.6 del
contrato de pruebas): por cada servicio se guarda el ejecutable, la carpeta
de trabajo, los argumentos y como saber que ya respondio.

Principio SOLID aplicado:
    - O (Open/Closed): se agregan o quitan servicios sin tocar el controlador.
"""

from dataclasses import dataclass, field
from pathlib import Path

# .../INCLUSIVE_TECH  (este archivo esta en it_nav_system/launcher)
PROJECT_ROOT = Path(__file__).resolve().parents[2]

NAV_DIR = PROJECT_ROOT / "it_nav_system" / "backend"
MIA_DIR = PROJECT_ROOT / "it_ai_assistant"

# Puerta propia del lanzador (distinta de 8000 y 8001)
LAUNCHER_HOST = "127.0.0.1"
LAUNCHER_PORT = 8010

# A donde manda el boton "Abrir modo sistema"
NAV_SISTEMA_URL = "http://127.0.0.1:8001/sistema.html"


@dataclass(frozen=True)
class ServiceConfig:
    """Todo lo que el lanzador necesita saber de un servicio."""

    name: str                 # identificador tecnico (ej: "nav")
    label: str                # nombre visible (ej: "Servicio de navegacion")
    host: str
    port: int
    managed: bool = True      # True: el lanzador lo arranca y apaga. False: solo lo observa.
    executable: str = ""      # ruta al python del venv (solo si managed)
    args: list[str] = field(default_factory=list)
    cwd: str = ""
    health_path: str = ""     # ruta HTTP de salud (solo para health_mode "http")
    # Como saber si esta vivo:
    #   "http"    -> responde su health_path
    #   "tcp"     -> algo escucha en host:port (ej: el broker)
    #   "process" -> el proceso que lanzamos sigue vivo (para el puente, que no abre puerto)
    health_mode: str = "http"
    ready_timeout_s: float = 30.0
    note: str = ""

    @property
    def health_url(self) -> str:
        """URL completa de salud (vacia si el servicio no expone una)."""
        if not self.health_path:
            return ""
        return f"http://{self.host}:{self.port}{self.health_path}"


# Servicio de navegacion it_nav_system (puerta 8001). Es el principal.
NAV_SERVICE = ServiceConfig(
    name="nav",
    label="Servicio de navegación (it_nav_system)",
    host="127.0.0.1",
    port=8001,
    managed=True,
    executable=str(NAV_DIR / "venv" / "Scripts" / "python.exe"),
    args=["-m", "app.main"],
    cwd=str(NAV_DIR),
    health_path="/health",
    ready_timeout_s=30.0,
    note="Necesario para el modo sistema. Usa el broker MQTT.",
)

# Asistente de voz Mia (puerta 8000). Tarda hasta ~120 s en frio.
MIA_SERVICE = ServiceConfig(
    name="mia",
    label="Asistente Mía (it_ai_assistant)",
    host="127.0.0.1",
    port=8000,
    managed=True,
    executable=str(MIA_DIR / "venv" / "Scripts" / "python.exe"),
    args=["main.py"],
    cwd=str(MIA_DIR),
    health_path="/",
    ready_timeout_s=150.0,
    note="Solo si vas a probar por voz. Necesita internet y tarda en cargar.",
)

# Broker MQTT: NO lo arranca el lanzador (se inicia aparte). Solo se observa.
BROKER_SERVICE = ServiceConfig(
    name="broker",
    label="Broker MQTT (Mosquitto)",
    host="127.0.0.1",
    port=1883,
    managed=False,
    health_mode="tcp",   # sin HTTP: se comprueba abriendo el puerto 1883
    note="Se arranca aparte (Mosquitto). El lanzador solo muestra si está vivo.",
)

# Puente hacia la placa real (hermano del simulador). No abre puerto propio,
# por eso su salud es "el proceso sigue vivo". Por defecto apunta a la placa
# real (192.168.4.1); para probar contra la placa falsa, arrancalo a mano con
# --board-url. Arrancalo DESPUES del broker y del servicio de navegacion.
BRIDGE_SERVICE = ServiceConfig(
    name="bridge",
    label="Puente a la placa (hardware_bridge)",
    host="127.0.0.1",
    port=0,
    managed=True,
    executable=str(NAV_DIR / "venv" / "Scripts" / "python.exe"),
    args=["-m", "hardware_bridge"],
    cwd=str(NAV_DIR),
    health_mode="process",
    ready_timeout_s=10.0,
    note="Conecta el servicio con la placa real. Arrancalo tras el broker y la navegación.",
)

# Orden en el que se muestran en la pagina
SERVICES: list[ServiceConfig] = [BROKER_SERVICE, NAV_SERVICE, BRIDGE_SERVICE, MIA_SERVICE]
