"""
hardware_bridge/fake_board.py

Placa falsa para probar el puente SIN la placa real.

Imita los endpoints HTTP de la placa de verdad (CodigoFinal.ino):
    GET /estado            -> estado de luces y puertas en JSON
    GET /luz?lugar=sala    -> invierte (toggle) la luz de ese lugar
    GET /puerta?lugar=bano -> invierte (toggle) la puerta de ese lugar

Igual que la placa real, /luz y /puerta son interruptores: cada llamada
cambia el estado al contrario. Guarda todo en memoria.

Uso:
    python -m hardware_bridge.fake_board            # puerta 8080
    python -m hardware_bridge.fake_board --port 9090
"""

import argparse
import json
import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

logger = logging.getLogger("fake_board")

# Lugares con luz y con puerta, igual que en el firmware real
LUGARES_CON_LUZ = ["sala", "cocina", "bano", "cuarto1", "cuarto2"]
LUGARES_CON_PUERTA = ["sala", "cocina", "bano", "cuarto1", "cuarto2"]


class FakeBoardState:
    """El estado en memoria de la placa falsa."""

    def __init__(self) -> None:
        self.luces = {lugar: 0 for lugar in LUGARES_CON_LUZ}
        self.puertas = {lugar: 0 for lugar in LUGARES_CON_PUERTA}
        # En el firmware real la luz de la sala arranca encendida
        self.luces["sala"] = 1

    def toggle_luz(self, lugar: str) -> bool:
        if lugar not in self.luces:
            return False
        self.luces[lugar] = 0 if self.luces[lugar] else 1
        return True

    def toggle_puerta(self, lugar: str) -> bool:
        if lugar not in self.puertas:
            return False
        self.puertas[lugar] = 0 if self.puertas[lugar] else 1
        return True

    def as_json(self) -> dict:
        return {"luces": dict(self.luces), "puertas": dict(self.puertas), "robot": False}


def build_handler(state: FakeBoardState):
    """Crea el manejador HTTP enlazado a un estado concreto."""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args) -> None:
            # Un log mas limpio que el ruidoso por defecto
            logger.info("%s", self.path)

        def _text(self, code: int, body: str) -> None:
            data = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _json(self, data: dict) -> None:
            body = json.dumps(data).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            lugar = parse_qs(parsed.query).get("lugar", [""])[0]

            if parsed.path == "/estado":
                self._json(state.as_json())
            elif parsed.path == "/luz":
                if state.toggle_luz(lugar):
                    estado = "encendida" if state.luces[lugar] else "apagada"
                    self._text(200, f"Luz {lugar}: {estado}")
                else:
                    self._text(400, "Ese lugar no tiene luz")
            elif parsed.path == "/puerta":
                if state.toggle_puerta(lugar):
                    estado = "abierta" if state.puertas[lugar] else "cerrada"
                    self._text(200, f"Puerta {lugar}: {estado}")
                else:
                    self._text(400, "Ese lugar no tiene puerta")
            else:
                self._text(404, "No encontrado")

    return Handler


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [placa-falsa] %(message)s", datefmt="%H:%M:%S")
    parser = argparse.ArgumentParser(prog="python -m hardware_bridge.fake_board")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()

    state = FakeBoardState()
    server = ThreadingHTTPServer((args.host, args.port), build_handler(state))
    logger.info("Placa falsa en http://%s:%s (Ctrl+C para cerrar)", args.host, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Placa falsa detenida.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
