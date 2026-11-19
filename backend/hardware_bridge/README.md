# Puente a la placa real (hardware_bridge)

Conecta el servicio `it_nav_system` (que habla MQTT) con la placa real de la
casa (que habla HTTP). Es el hermano "de verdad" del simulador: ocupa el mismo
lugar del lado del dispositivo, pero en vez de simular, maneja la placa.

## Por qué existe

La placa (`CodigoFinal.ino`) no habla MQTT. Es un punto de acceso WiFi con una
página web y endpoints HTTP (`/luz`, `/puerta`, `/estado`). El puente se conecta
al broker haciéndose pasar por la placa `casa` y traduce en los dos sentidos:

- **Órdenes:** escucha `inclusive/casa1/devices/+/set` y las reenvía por HTTP a
  la placa (`/luz?lugar=...`, `/puerta?lugar=...`).
- **Estado:** publica en `.../state` cómo quedó cada cosa, y sondea `/estado`
  cada pocos segundos para enterarse de los cambios hechos desde la página de la
  placa (el modo directo) y para saber si la placa sigue viva.

Así, para el backend el puente es indistinguible de una placa que hablara MQTT,
y el simulador se puede reemplazar por el puente sin tocar nada del backend.

## Lo que el puente le pone al contrato

La placa real es más simple que el contrato, así que el puente completa la
diferencia:

- `/luz` y `/puerta` son **interruptores** (toggle), no órdenes absolutas. El
  puente lee `/estado` y solo manda el toggle si hace falta, para dejar el
  dispositivo en el estado pedido.
- Las puertas de la placa no avisan `opening` ni `closing` ni cierran solas. El
  puente agrega esos estados intermedios y el cierre de seguridad `hold_ms`, con
  sus propios temporizadores.
- La disponibilidad (`online`/`offline` de la placa `casa`) la maneja el puente
  según si la placa responde su `/estado`, además del Last Will de MQTT.

## Mapa de dispositivos

El `device_key` del contrato se traduce al "lugar" que usa la placa:

| device_key                 | lugar (placa) |
| -------------------------- | ------------- |
| light_sala                 | sala          |
| light_cocina               | cocina        |
| light_banio                | bano          |
| light_cuarto_principal     | cuarto1       |
| light_cuarto_secundario    | cuarto2       |
| door_banio                 | bano          |
| door_cuarto_principal      | cuarto1       |
| door_cuarto_secundario     | cuarto2       |

`light_comedor` no tiene equivalente físico: el puente lo omite y el backend
marcará sus órdenes como "sin respuesta".

## Cómo correrlo

Necesita el broker MQTT y el backend encendidos (de ahí saca la lista de
dispositivos), y la clave `INCLUSIVE_ESP32_PASSWORD` en el `.env`.

Contra la placa real (lo normal):

```powershell
cd "it_nav_system\backend"
.\venv\Scripts\python.exe -m hardware_bridge --board-url http://192.168.4.1
```

También se arranca con el botón **Puente a la placa** del lanzador de servicios.

## Probar sin la placa (placa falsa)

Hay una placa falsa que imita los endpoints de la placa real, para probar todo
el camino sin hardware:

```powershell
cd "it_nav_system\backend"
.\venv\Scripts\python.exe -m hardware_bridge.fake_board --port 8080
```

Y en otra consola, el puente apuntando a ella:

```powershell
cd "it_nav_system\backend"
.\venv\Scripts\python.exe -m hardware_bridge --board-url http://127.0.0.1:8080
```

Luego, desde el modo sistema o con las rutas `/user/devices/...`, las órdenes
llegan a la placa falsa y el estado vuelve al backend.

## Archivos

- `board_client.py`: cliente HTTP de la placa y el mapa device_key a lugar.
- `bridge.py`: el puente MQTT, la lógica de luces y puertas, y el sondeo.
- `fake_board.py`: placa falsa para pruebas.

## Nota importante

El puente y el simulador NO deben correr a la vez: los dos se hacen pasar por la
placa `casa` y se pisarían. Usa el simulador para pruebas sin placa, o el puente
con la placa (real o falsa), pero no ambos.
