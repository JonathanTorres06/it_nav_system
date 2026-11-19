"""
hardware_bridge

Puente entre el contrato MQTT y la placa real de la casa.

La placa (CodigoFinal.ino) no habla MQTT: es un punto de acceso WiFi con una
pagina web y endpoints HTTP (/luz, /puerta, /estado). Este puente se conecta
al broker haciendose pasar por la placa 'casa' y traduce: recibe las ordenes
MQTT del backend y las reenvia por HTTP a la placa, y publica de vuelta el
estado para que el backend se entere de como quedo todo.

Es el hermano "real" del simulador: mismo papel del lado dispositivo, pero en
vez de simular, maneja la placa de verdad.
"""
