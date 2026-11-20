// Tarea programada de InfluxDB "Resumen de consumo por hora" (Gravix de sede).
// Cada hora toma el detalle de Telegraf (bucket "monitoreo", 10 s, 30 dias) y guarda un resumen en el
// bucket "monitoreo_horas" (365 dias), measurement "consumo_hora":
//   - por contenedor (tag servicio): ram_mb_prom, ram_mb_max, cpu_pct_prom, cpu_pct_max
//   - servicio "timescaledb": disco_gb (tamano total de la base)
//   - servicio "influxdb": disco_mb (tamano en disco)
// Se instala con: influx task create -o <org> -t <token> -f tarea-consumo.flux
import "date"

option task = {name: "Resumen de consumo por hora", every: 1h, offset: 2m}

hora = date.truncate(t: now(), unit: 1h)
desde = date.sub(d: 1h, from: hora)

ram = from(bucket: "monitoreo")
    |> range(start: desde, stop: hora)
    |> filter(fn: (r) => r._measurement == "docker_container_mem" and r._field == "usage")
    |> map(fn: (r) => ({r with _value: float(v: r._value) / 1048576.0}))
    |> group(columns: ["com.docker.compose.service"])

cpu = from(bucket: "monitoreo")
    |> range(start: desde, stop: hora)
    |> filter(fn: (r) => r._measurement == "docker_container_cpu" and r._field == "usage_percent" and r.cpu == "cpu-total")
    |> map(fn: (r) => ({r with _value: float(v: r._value)}))
    |> group(columns: ["com.docker.compose.service"])

guardar = (tables=<-, campo) =>
    tables
        |> map(fn: (r) => ({_time: hora, _measurement: "consumo_hora", servicio: r["com.docker.compose.service"], _field: campo, _value: r._value}))
        |> group(columns: ["servicio", "_field"])
        |> to(bucket: "monitoreo_horas")

ram |> mean() |> guardar(campo: "ram_mb_prom")
ram |> max() |> guardar(campo: "ram_mb_max")
cpu |> mean() |> guardar(campo: "cpu_pct_prom")
cpu |> max() |> guardar(campo: "cpu_pct_max")

from(bucket: "monitoreo")
    |> range(start: desde, stop: hora)
    |> filter(fn: (r) => r._measurement == "timescaledb" and r._field == "base_bytes")
    |> last()
    |> map(fn: (r) => ({_time: hora, _measurement: "consumo_hora", servicio: "timescaledb", _field: "disco_gb", _value: float(v: r._value) / 1073741824.0}))
    |> group(columns: ["servicio", "_field"])
    |> to(bucket: "monitoreo_horas")

from(bucket: "monitoreo")
    |> range(start: desde, stop: hora)
    |> filter(fn: (r) => r._measurement == "influxdb_interno" and r._field == "storage_shard_disk_size")
    |> last()
    |> group()
    |> sum()
    |> map(fn: (r) => ({_time: hora, _measurement: "consumo_hora", servicio: "influxdb", _field: "disco_mb", _value: float(v: r._value) / 1048576.0}))
    |> group(columns: ["servicio", "_field"])
    |> to(bucket: "monitoreo_horas")
