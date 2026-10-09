---
name: sede-igss
description: Integrar una sede IGSS nueva (o revisar una existente) en Nodivo - descubrir y mapear los registros Modbus del EBO AS-P (escaneo de solo lectura), identificar ION7400/PM2130/generadores/ATS, conectar ChirpStack por MQTT, generar el config del Agente_Go y verificar en la pestaña Sedes. Usar cuando se mencione una sede del IGSS (Escuintla, Amatitlán, Cobán, Gineco, La Gomera, Mazatenango, Palín, Retalhuleu, Santa Lucía, Tiquisate, Villa Nueva), el EBO, registros Modbus o "autodescubrimiento".
---

# Integrar una sede IGSS

Sede modelo ya integrada: **Escuintla** (`buildingKey: igss-escuintla`, EBO 10.0.6.26, ChirpStack 10.0.6.35).
Referencia completa: `docs/sedes-igss.md`.

## 0. Reglas

- **Solo lectura**: escanear con funcion 03/04. Nunca escribir registros (funcion 06/16) en un EBO.
- El EBO tambien lo lee el sistema anterior (`api-SIASA`): escanear con pausas (los scripts ya
  esperan 40 ms entre lecturas) y no dejar escaneos corriendo en bucle.
- Antes de afirmar que un dato "esta mal", mirar los registros crudos (`raw-registers.js`).

## 1. Buscar lo que ya se sabe de la sede

El sistema anterior tiene un proyecto por sede en `E:\Users\Users\chernandez\Fuentes-api-Sedes\api-SIASA-<Sede>\`
(Escuintla = `api-SIASA\` raiz). De ahi sacar:

- `.env`: `MODBUS_HOST`, `MODBUS_PORT`, `MODBUS_ID`, `MQTT_*_HOST` (broker de ChirpStack).
- `MANUAL_TECNICO.md` / `CAMBIOS.md`: cuantos generadores, que analizador vigila el ATS.
- `modbus_cliente/lectura_Ebo_v2.js`: bloques (`LEGACY_PM2130_BLOCKS`, `LEGACY_ION7400_BLOCKS`,
  `GENERADOR_*_BLOCK`, `LEGACY_ION7400_VIGILANT_FIELDS`) y `SEDES_DEVICE_TAGS` (area, codigo HES, fase, capacidad).

## 2. Escanear el EBO (solo lectura)

Scripts en `.claude/skills/sede-igss/scripts/` (Node, sin dependencias). Copiarlos a una carpeta temporal y:

```bash
node scan-ebo.js <ip-ebo> 1 6000 100        # rangos de registros con datos != 0
node scan-ebo.js <ip-ebo> 5701 5800 1       # zona fina (donde un bloque grande da excepcion)
node raw-registers.js <ip-ebo> 5705 38 3    # valores crudos de un bloque
```

Lectura del resultado (layout tipico de los EBO del IGSS, registro N = direccion Modbus N-1):

| Rango | Contenido | Perfil del agente |
|---|---|---|
| 101 + 22·(k-1) | PM2130-k: 11 float32 (V L-N, V L-L, I, Hz, demanda) | `pm2130` |
| 255-323 | ANALIZADOR-1: 35 float32 | `ion7400` |
| 325, 399, 473, 547, 621 | ANALIZADOR-2..6: 20 float32 + 2 reservados + 15 calidad | `ion7400-b` |
| 695/697 (y 587/589) | Estado S1 comercial / S2 generador del ATS (16 bits) | `extra` del ION |
| 701-5703 | Armonicos de los ION7400 (no se leen por defecto) | — |
| 5705-5742, 5743-5780 | Bloques de generador (int32 ×0.01) | `generator` |
| 5781-5787 | Contadores de transferencias del vigilante | `extra` del ION |

**Generadores**: en Escuintla los bloques de generador estan practicamente en 0 en el EBO (el EBO
no recibe datos del controlador). El agente lo reporta como evento `generator.no_data`. Para
tener metricas de motor reales hay que leer el controlador del generador directamente (pedir
marca/modelo e IP del controlador) y agregar un perfil para ese controlador.

## 3. ChirpStack (LoRaWAN por MQTT)

- Broker: `<ip>:1883`, topic `application/+/device/+/event/up` (lo escucha `lorawansource`).
- Los tags de cada dispositivo en ChirpStack (area, code_inventory, sensor_type, threshold_min/max,
  y por canal en WISE: aiN_operative_area, aiN_multiplier, aiN_offset, aiN_threshold_min/max,
  aiN_tolerance) llegan como `attributes.tag_*` y alimentan nombres, conversiones y alarmas.
  Mantenerlos completos en ChirpStack es la forma de "configurar" sensores sin tocar codigo.
- Si ChirpStack se cae no llega nada por MQTT: lo detecta el evento `lorawan.site_silent`.

## 4. Config del agente y verificacion

1. Copiar `apps/Agente_Go/config.igss-escuintla.example.yaml` -> `config.igss-<sede>.yaml`, cambiar
   `buildingKey`, IPs y la lista `modbus.devices` (nombre, perfil, start, extra, attributes).
2. Agregar la sede a `apps/web/src/config/sites.ts` (mismo `buildingKey`, IPs para la tarjeta del agente).
3. Correr el agente (skill `agente-go`) y verificar:
   - log `N/M equipo(s) con datos validos` (un bloque que no valida no aparece: es el "autodescubrimiento");
   - valores plausibles (≈120-127 V, ≈60 Hz) en la pestaña Sedes;
   - eventos en Sedes > Eventos.
