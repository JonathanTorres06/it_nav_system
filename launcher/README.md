# Lanzador de servicios (modo sistema)

Proceso pequeño y aparte que enciende y apaga los servicios del **modo sistema**
desde un botón, sin abrir una terminal. Existe porque una página web servida por
`it_nav_system` no puede arrancarse a sí misma.

## Cómo se usa

1. Asegúrate de que el **broker MQTT (Mosquitto)** esté corriendo (se arranca aparte).
2. Doble clic en **`start-launcher.bat`**. Se abre la página del lanzador en el
   navegador (`http://127.0.0.1:8010`).
3. Pulsa **Arrancar** en *Servicio de navegación (it_nav_system)*. El indicador
   pasa a verde cuando responde (menos de 30 s).
4. Pulsa **Abrir modo sistema** para ir a la página de pruebas.
5. Para probar por voz, arranca también **Mía** (tarda hasta ~120 s y necesita internet).

## Qué hace por dentro (patrón de la sección 4.6)

- **Comprueba** antes de arrancar: si el servicio ya responde, lo **reutiliza** y
  no lanza un segundo (ni lo apaga al cerrar).
- Lanza cada servicio como **proceso oculto** con el `python.exe` del venv,
  inyectando `PYTHONUNBUFFERED` y `PYTHONUTF8`.
- **Espera** a que responda su `/health` antes de darlo por listo.
- Al apagar, mata el **árbol de procesos** (`taskkill /T /F`), porque el python
  de un venv suele crear un proceso hijo.
- Solo apaga lo que él mismo arrancó. El broker no lo arranca ni lo apaga.

## Archivos

- `launcher.py`: servidor HTTP del lanzador (puerta 8010, solo 127.0.0.1).
- `service_controller.py`: ciclo de vida de un servicio (comprobar, arrancar, esperar, apagar).
- `services_config.py`: rutas, puertas, health y plazos de cada servicio.
- `static/launcher.html`: la página con los botones y los indicadores.
- `start-launcher.bat`: doble clic para abrir el lanzador.

Nota de seguridad: el lanzador puede iniciar procesos, por eso escucha solo en
`127.0.0.1`. No lo expongas en la red.
