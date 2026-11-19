"""
launcher/launcher.py

Lanzador local de servicios de Inclusive Tech.

Para que sirve: una pagina web NO puede arrancarse a si misma, asi que el
modo sistema (servido por it_nav_system) no puede tener el boton que
enciende it_nav_system. Este lanzador es un proceso pequenio y aparte, con
su propia pagina, que si puede arrancar y apagar los servicios del PC.

Responsabilidad: exponer una pagina y unos endpoints para arrancar, apagar
y consultar el estado de cada servicio. La logica de arranque vive en
ServiceController; aqui solo esta el cableado HTTP.

Seguridad: escucha SOLO en 127.0.0.1. Puede lanzar procesos, por eso nunca
debe quedar expuesto en la red.

Arranque: doble clic en start-launcher.bat, o
    it_nav_system\\backend\\venv\\Scripts\\python.exe launcher\\launcher.py
"""

import logging
import threading
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from services_config import LAUNCHER_HOST, LAUNCHER_PORT, NAV_SISTEMA_URL, SERVICES
from service_controller import ServiceController

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
logger = logging.getLogger("launcher")

STATIC_DIR = Path(__file__).resolve().parent / "static"

# Un controlador por servicio, indexado por su nombre tecnico
controllers: dict[str, ServiceController] = {
    config.name: ServiceController(config) for config in SERVICES
}

app = FastAPI(title="Lanzador de servicios · Inclusive Tech")


@app.get("/")
async def index() -> FileResponse:
    """Sirve la pagina del lanzador."""
    return FileResponse(STATIC_DIR / "launcher.html")


# Nota: estos endpoints son 'def' (no 'async def') a proposito. Hacen E/S
# bloqueante (sondear puertos y /health, matar procesos); con 'def', FastAPI
# los corre en un hilo aparte y no congela el servidor mientras esperan.

@app.get("/status")
def status() -> dict:
    """Estado de todos los servicios y a donde abrir el modo sistema."""
    # Se sondea cada servicio en paralelo: asi una consulta tarda lo de la
    # prueba mas lenta, no la suma de todas.
    with ThreadPoolExecutor(max_workers=len(controllers)) as pool:
        services = list(pool.map(
            lambda config: controllers[config.name].status(),
            SERVICES,
        ))
    return {"services": services, "sistema_url": NAV_SISTEMA_URL}


@app.post("/services/{name}/start")
def start_service(name: str) -> dict:
    """Arranca (o reutiliza) un servicio."""
    controller = controllers.get(name)
    if controller is None:
        raise HTTPException(status_code=404, detail=f"No existe el servicio '{name}'.")
    controller.start()
    return controller.status()


@app.post("/services/{name}/stop")
def stop_service(name: str) -> dict:
    """Apaga un servicio, solo si este lanzador lo habia arrancado."""
    controller = controllers.get(name)
    if controller is None:
        raise HTTPException(status_code=404, detail=f"No existe el servicio '{name}'.")
    controller.stop()
    return controller.status()


def _open_browser_later() -> None:
    """Abre la pagina del lanzador cuando el servidor ya responde."""
    import time
    time.sleep(1.2)
    try:
        webbrowser.open(f"http://{LAUNCHER_HOST}:{LAUNCHER_PORT}/")
    except Exception:
        pass  # si no hay navegador, el usuario abre la URL a mano


if __name__ == "__main__":
    logger.info("Lanzador en http://%s:%s  (Ctrl+C para cerrar)", LAUNCHER_HOST, LAUNCHER_PORT)
    threading.Thread(target=_open_browser_later, daemon=True).start()
    uvicorn.run(app, host=LAUNCHER_HOST, port=LAUNCHER_PORT, log_level="warning")
