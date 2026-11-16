# Fórmulas de conversión 4-20 mA (WISE)

Catálogo de las fórmulas con las que se convierten las entradas analógicas 4-20 mA de los WISE
(WISE-4610 S617 / S614T) a su magnitud real. Registrado el **2026-10-12** para aplicarlas al
integrar cada equipo en cualquier sede.

## Cómo se aplican

Cada canal analógico del WISE (`ai0` … `ai3`) envía la corriente en mA (`aiN_value`). La fórmula
**no está en el código**: se configura en ChirpStack con etiquetas por canal y el Agente Go la
aplica en cada mensaje (`apps/Agente_Go/internal/discovery/lorawansource/lorawansource.go`,
`addScaledChannels`):

```
valor = aiN_value × aiN_multiplier + aiN_offset
```

> **Regla del signo:** `aiN_offset` se guarda en ChirpStack **con su signo** (ej. `-138.45`) y el
> agente lo **suma**. Escribir `9.5147(X) − 138.45` equivale a `multiplier = 9.5147` y
> `offset = -138.45`. Si se carga `138.45` en positivo, el resultado sale ~277 unidades más alto.

## Catálogo de fórmulas

| Dispositivo | Tipo de equipo | Canal | Fórmula | `multiplier` | `offset` | Unidad | 4 mA → | 20 mA → | Estado |
|---|---|---|---|---|---|---|---|---|---|
| WISE | Cadena de frío | ai0 | 9.5147(X) − 138.45 | 9.5147 | -138.45 | °C | −100.4 | +51.8 | En uso en Escuintla (todos los canales) |
| WISE | Cadena de frío | ai1 | 9.5147(X) − 138.46 | 9.5147 | -138.46 | °C | −100.4 | +51.8 | Pendiente: en Escuintla está −138.45 |
| WISE | Cadena de frío | ai2 | 9.5147(X) − 138.47 | 9.5147 | -138.47 | °C | −100.4 | +51.8 | Pendiente: en Escuintla está −138.45 |
| WISE | Cadena de frío | ai3 | 9.5147(X) − 138.48 | 9.5147 | -138.48 | °C | −100.4 | +51.8 | Pendiente: en Escuintla está −138.45 |
| WISE | Cadena de frío (otro transmisor) | según equipo | 7.6924(X) − 112.39 | 7.6924 | -112.39 | °C | −81.6 | +41.5 | En uso en Escuintla (3 refrigeradores y 1 congelador) |
| WISE | Bombeo de agua | ai0 | 9.375(X) − 37.5 | 9.375 | -37.5 | PSI | 0 | 150 | En uso en Escuintla (3 WISE) |
| WISE | Calentador | ai0 | 12.893(X) − 48.111 | 12.893 | -48.111 | °C | 3.46 | 209.8 | Por aplicar: verificar rango |
| WISE | Caldera | ai0 | 12.893(X) − 48.111 | 12.893 | -48.111 | °C | 3.46 | 209.8 | Por aplicar: verificar rango |

`X` = corriente del canal en mA (`aiN_value`). Las fórmulas de las filas 1-4 y 6-8 son las que
entregó el equipo de SIASA; la de la fila 5 se encontró en las etiquetas de ChirpStack de
Escuintla.

## Etiquetas que hay que cargar en ChirpStack por canal

Ejemplo real (Escuintla, canal `ai0` de un ultracongelador):

| Etiqueta | Valor | Para qué |
|---|---|---|
| `ai0_type` | `temperature` | Magnitud. `temperature` → se guarda como `ai0_temperature`; cualquier otra (ej. `water_pressure`) → `ai0_scaled` |
| `ai0_multiplier` | `9.5147` | Pendiente de la fórmula |
| `ai0_offset` | `-138.45` | Desplazamiento, **con signo** |
| `ai0_unit` | `°C` | Unidad (`°C`, `PSI`) |
| `ai0_category` | `Ultra congelador` | Tipo de equipo (`Refrigerador`, `Congelador`, `Ultra congelador`…) |
| `ai0_operative_area` | `Congelador De Medicina Transfusional` | Nombre del equipo que se muestra |
| `ai0_code` | `HES010` | Código de inventario |
| `ai0_threshold_min` / `ai0_threshold_max` | `-40` / `-30` | Rango permitido |
| `ai0_tolerance` | `10` | Minutos fuera de rango antes de alarmar |

Para bombeo de agua en Escuintla: `ai0_type = water_pressure`, `ai0_unit = PSI`, rangos 10-60,
10-20 y 20-80 PSI según el equipo.

## Cómo sacar la fórmula de un transmisor nuevo

Con el rango configurado en el transmisor (valor a 4 mA = `mín`, valor a 20 mA = `máx`):

```
multiplier = (máx − mín) / 16
offset     = mín − 4 × multiplier
```

Ejemplos:

- Cadena de frío, −100.4 a +51.84 °C → `multiplier = 152.24 / 16 = 9.5147`, `offset = −100.4 − 38.06 = −138.46`.
- Bombeo, 0 a 150 PSI → `multiplier = 150 / 16 = 9.375`, `offset = 0 − 37.5 = −37.5`.
- Un transmisor 0 a 200 °C daría `multiplier = 12.5`, `offset = −50`.

Para validar una fórmula en sitio: comparar el valor convertido con un termómetro o manómetro de
referencia, o con la pantalla del propio equipo.

## Pendientes antes de aplicar

1. **Offsets por canal de cadena de frío (−138.46 / −138.47 / −138.48).** Confirmar si son una
   calibración real de cada canal. Si lo son, actualizar `ai1_offset`, `ai2_offset` y `ai3_offset`
   en ChirpStack (hoy todos están en −138.45).
2. **Calentador y caldera (12.893 / −48.111).** Con esa fórmula 4 mA da 3.46 °C, no 0 °C. Si el
   transmisor es de 0 a 206.3 °C, el offset correcto sería −51.57. Verificar el rango del
   transmisor antes de cargarla.
3. **Calentadores y calderas deben llevar un `aiN_type` distinto de `temperature`** (en Escuintla:
   `water_heater_temperature`). Con `temperature` se tratarían como cadena de frío.

## Cómo se muestra y se alarma (aplicado el 2026-10-12)

| `aiN_type` | Lectura | Tarjeta en Sedes | Eventos (rango `threshold_min/max`, gracia `tolerance` en min) |
|---|---|---|---|
| `temperature` | `aiN_temperature` (°C) | "Cadena de frío" | `coldchain.out_of_range` (crítico) / `coldchain.normal` |
| `water_pressure` | `aiN_scaled` (unidad de `aiN_unit`, PSI) | "Bombeo de agua" | `water.pressure_low` / `water.pressure_high` (aviso) / `water.pressure_normal` |
| `water_heater_temperature` | `aiN_scaled` (°C) | "Calderas y calentadores" | `process.out_of_range` (aviso) / `process.normal` |
| Cualquier otro | `aiN_scaled` | "Entradas 4-20 mA" | `process.out_of_range` / `process.normal` |

- Si la corriente queda en ≤ 4.05 mA, en ≥ 19.95 mA o en circuito abierto, la tarjeta muestra
  **"Sonda sin señal"** en lugar del valor convertido (4 mA daría −100.4 °C o −37.5 PSI) y el
  agente emite `io.sensor_fault` en vez de la alarma de rango.
- Los WISE alternan una trama con las entradas analógicas y otra solo con la digital; el agente
  conserva los últimos valores analógicos entre una y otra.

Verificado en Escuintla después del despliegue: bombeo 12.9 y 17.3 PSI; calderas y calentadores
38.9, 95.1 y 128.3 °C; HES-BOM-…H2O-1 con 0.13 mA (sonda sin señal).
