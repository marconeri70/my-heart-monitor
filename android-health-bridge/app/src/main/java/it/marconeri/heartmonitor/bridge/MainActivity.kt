package it.marconeri.heartmonitor.bridge

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.*
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.*
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.time.Duration
import java.time.Instant
import java.time.temporal.ChronoUnit

class MainActivity : AppCompatActivity() {
    private lateinit var status: TextView
    private lateinit var summary: TextView
    private lateinit var daysSpinner: Spinner
    private var exportJson: String? = null

    private val permissions = setOf(
        HealthPermission.getReadPermission(BloodPressureRecord::class),
        HealthPermission.getReadPermission(HeartRateRecord::class),
        HealthPermission.getReadPermission(OxygenSaturationRecord::class),
        HealthPermission.getReadPermission(HeartRateVariabilityRmssdRecord::class),
        HealthPermission.getReadPermission(StepsRecord::class),
        HealthPermission.getReadPermission(DistanceRecord::class),
        HealthPermission.getReadPermission(TotalCaloriesBurnedRecord::class),
        HealthPermission.getReadPermission(SleepSessionRecord::class)
    )

    private val permissionLauncher =
        registerForActivityResult(PermissionController.createRequestPermissionResultContract()) {
            status.text = "Permessi aggiornati. Ora puoi leggere i dati."
        }

    private val createFileLauncher =
        registerForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri: Uri? ->
            if (uri == null) return@registerForActivityResult
            val json = exportJson ?: return@registerForActivityResult
            contentResolver.openOutputStream(uri)?.use { it.write(json.toByteArray(Charsets.UTF_8)) }
            status.text = "✅ File esportato. Ora importalo nella Heart Monitor."
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
        refreshAvailability()
    }

    private fun buildUi(): View {
        val scroll = ScrollView(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(20), dp(20), dp(32))
            setBackgroundColor(Color.rgb(246, 247, 251))
        }
        scroll.addView(root)

        root.addView(text("❤️ Heart Monitor Bridge", 28, true).apply {
            setTextColor(Color.rgb(17,19,26))
        })
        root.addView(text(
            "Importa in modo controllato i dati che QRing o altre app scrivono in Health Connect. Nessun collegamento Bluetooth diretto all’anello.",
            15, false
        ).apply { setPadding(0, dp(8), 0, dp(14)) })

        status = text("Controllo Health Connect…", 15, true)
        root.addView(card(status))

        root.addView(button("1 · AUTORIZZA HEALTH CONNECT", action = {
            lifecycleScope.launch {
                val client = getClientOrNull() ?: return@launch
                val granted = client.permissionController.getGrantedPermissions()
                if (granted.containsAll(permissions)) {
                    status.text = "✅ Permessi Health Connect già concessi."
                } else {
                    permissionLauncher.launch(permissions)
                }
            }
        }))

        root.addView(button("GESTISCI ACCESSO HEALTH CONNECT", {
            try {
                startActivity(Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS))
            } catch (_: Exception) {
                startActivity(Intent(Settings.ACTION_APPLICATION_SETTINGS))
            }
        }, secondary = true))

        root.addView(text("PERIODO DA IMPORTARE", 12, true).apply {
            setPadding(0, dp(16), 0, dp(5))
            setTextColor(Color.rgb(126,132,146))
        })
        daysSpinner = Spinner(this).apply {
            adapter = ArrayAdapter(
                this@MainActivity,
                android.R.layout.simple_spinner_dropdown_item,
                listOf("Ultimi 7 giorni", "Ultimi 30 giorni")
            )
            setSelection(1)
        }
        root.addView(daysSpinner, LinearLayout.LayoutParams(-1, dp(56)))

        root.addView(button("2 · LEGGI DATI", action = { readHealthData() }))

        summary = text("Nessun dato letto.", 14, false)
        root.addView(card(summary))

        root.addView(button("3 · ESPORTA JSON PER HEART MONITOR", action = {
            val json = exportJson
            if (json == null) {
                Toast.makeText(this, "Prima premi LEGGI DATI", Toast.LENGTH_SHORT).show()
                return@button
            }
            val date = java.time.LocalDate.now().toString()
            createFileLauncher.launch("heart-monitor-health-connect-$date.json")
        }))

        root.addView(text(
            "Dati supportati: pressione arteriosa, battito, SpO₂, HRV, passi, distanza, calorie e sonno. Heart Monitor mostrerà anche l’app sorgente indicata da Health Connect, utile per verificare la provenienza dei dati.",
            12, false
        ).apply {
            setPadding(0, dp(16), 0, 0)
            setTextColor(Color.rgb(126,132,146))
        })

        return scroll
    }

    private fun refreshAvailability() {
        when (HealthConnectClient.getSdkStatus(this)) {
            HealthConnectClient.SDK_AVAILABLE -> status.text = "✅ Health Connect disponibile."
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> status.text = "⚠️ Health Connect richiede un aggiornamento."
            else -> status.text = "❌ Health Connect non disponibile su questo dispositivo."
        }
    }

    private fun getClientOrNull(): HealthConnectClient? {
        if (HealthConnectClient.getSdkStatus(this) != HealthConnectClient.SDK_AVAILABLE) {
            status.text = "Health Connect non disponibile."
            return null
        }
        return HealthConnectClient.getOrCreate(this)
    }

    private fun readHealthData() {
        lifecycleScope.launch {
            val client = getClientOrNull() ?: return@launch
            val granted = client.permissionController.getGrantedPermissions()
            if (!granted.containsAll(permissions)) {
                status.text = "⚠️ Concedi prima i permessi Health Connect."
                permissionLauncher.launch(permissions)
                return@launch
            }

            status.text = "⏳ Lettura dati Health Connect…"
            summary.text = "Caricamento…"

            try {
                val days = if (daysSpinner.selectedItemPosition == 0) 7L else 30L
                val end = Instant.now()
                val start = end.minus(days, ChronoUnit.DAYS)
                val timeFilter = TimeRangeFilter.between(start, end)

                val root = JSONObject()
                root.put("schema", "heart-monitor-health-connect-v1")
                root.put("generatedAt", end.toString())
                root.put("days", days)

                val data = JSONObject()
                val sources = linkedSetOf<String>()

                val heart = JSONArray()
                val heartSamples = mutableListOf<Triple<Instant, Long, String>>()
                client.readRecords(ReadRecordsRequest(HeartRateRecord::class, timeFilter)).records.forEach { r ->
                    val source = r.metadata.dataOrigin.packageName
                    sources += source
                    r.samples.forEach { sample ->
                        heartSamples += Triple(sample.time, sample.beatsPerMinute, source)
                        heart.put(JSONObject()
                            .put("time", sample.time.toString())
                            .put("bpm", sample.beatsPerMinute)
                            .put("source", source))
                    }
                }
                data.put("heartRate", heart)

                val pressure = JSONArray()
                client.readRecords(ReadRecordsRequest(BloodPressureRecord::class, timeFilter)).records.forEach { r ->
                    val source = r.metadata.dataOrigin.packageName
                    sources += source
                    val nearestBpm = heartSamples
                        .filter { it.third == source }
                        .minByOrNull { kotlin.math.abs(Duration.between(it.first, r.time).toMillis()) }
                        ?.takeIf { kotlin.math.abs(Duration.between(it.first, r.time).toMinutes()) <= 5 }
                        ?.second

                    pressure.put(JSONObject()
                        .put("time", r.time.toString())
                        .put("systolic", r.systolic.inMillimetersOfMercury)
                        .put("diastolic", r.diastolic.inMillimetersOfMercury)
                        .put("bpm", nearestBpm)
                        .put("bodyPosition", r.bodyPosition)
                        .put("measurementLocation", r.measurementLocation)
                        .put("source", source))
                }
                data.put("bloodPressure", pressure)

                val spo2 = JSONArray()
                client.readRecords(ReadRecordsRequest(OxygenSaturationRecord::class, timeFilter)).records.forEach { r ->
                    sources += r.metadata.dataOrigin.packageName
                    spo2.put(JSONObject()
                        .put("time", r.time.toString())
                        .put("percentage", r.percentage.value)
                        .put("source", r.metadata.dataOrigin.packageName))
                }
                data.put("oxygenSaturation", spo2)

                val hrv = JSONArray()
                client.readRecords(ReadRecordsRequest(HeartRateVariabilityRmssdRecord::class, timeFilter)).records.forEach { r ->
                    sources += r.metadata.dataOrigin.packageName
                    hrv.put(JSONObject()
                        .put("time", r.time.toString())
                        .put("millis", r.heartRateVariabilityMillis)
                        .put("source", r.metadata.dataOrigin.packageName))
                }
                data.put("hrv", hrv)

                val steps = JSONArray()
                client.readRecords(ReadRecordsRequest(StepsRecord::class, timeFilter)).records.forEach { r ->
                    sources += r.metadata.dataOrigin.packageName
                    steps.put(JSONObject()
                        .put("startTime", r.startTime.toString())
                        .put("endTime", r.endTime.toString())
                        .put("count", r.count)
                        .put("source", r.metadata.dataOrigin.packageName))
                }
                data.put("steps", steps)

                val distance = JSONArray()
                client.readRecords(ReadRecordsRequest(DistanceRecord::class, timeFilter)).records.forEach { r ->
                    sources += r.metadata.dataOrigin.packageName
                    distance.put(JSONObject()
                        .put("startTime", r.startTime.toString())
                        .put("endTime", r.endTime.toString())
                        .put("meters", r.distance.inMeters)
                        .put("source", r.metadata.dataOrigin.packageName))
                }
                data.put("distance", distance)

                val calories = JSONArray()
                client.readRecords(ReadRecordsRequest(TotalCaloriesBurnedRecord::class, timeFilter)).records.forEach { r ->
                    sources += r.metadata.dataOrigin.packageName
                    calories.put(JSONObject()
                        .put("startTime", r.startTime.toString())
                        .put("endTime", r.endTime.toString())
                        .put("kcal", r.energy.inKilocalories)
                        .put("source", r.metadata.dataOrigin.packageName))
                }
                data.put("calories", calories)

                val sleep = JSONArray()
                client.readRecords(ReadRecordsRequest(SleepSessionRecord::class, timeFilter)).records.forEach { r ->
                    sources += r.metadata.dataOrigin.packageName
                    val stages = JSONArray()
                    r.stages.forEach { stage ->
                        val minutes = Duration.between(stage.startTime, stage.endTime).toMinutes()
                        stages.put(JSONObject()
                            .put("startTime", stage.startTime.toString())
                            .put("endTime", stage.endTime.toString())
                            .put("stage", stage.stage)
                            .put("minutes", minutes))
                    }
                    sleep.put(JSONObject()
                        .put("startTime", r.startTime.toString())
                        .put("endTime", r.endTime.toString())
                        .put("minutes", Duration.between(r.startTime, r.endTime).toMinutes())
                        .put("source", r.metadata.dataOrigin.packageName)
                        .put("stages", stages))
                }
                data.put("sleep", sleep)

                root.put("sources", JSONArray(sources.toList()))
                root.put("data", data)
                exportJson = root.toString(2)

                val total = pressure.length()+heart.length()+spo2.length()+hrv.length()+steps.length()+distance.length()+calories.length()+sleep.length()
                summary.text = buildString {
                    append("Record trovati: ").append(total).append("\n\n")
                    append("🩺 Pressione: ").append(pressure.length()).append("\n")
                    append("❤️ Battito: ").append(heart.length()).append("\n")
                    append("🫁 SpO₂: ").append(spo2.length()).append("\n")
                    append("💓 HRV: ").append(hrv.length()).append("\n")
                    append("🚶 Passi: ").append(steps.length()).append("\n")
                    append("📍 Distanza: ").append(distance.length()).append("\n")
                    append("🔥 Calorie: ").append(calories.length()).append("\n")
                    append("🌙 Sonno: ").append(sleep.length()).append("\n\n")
                    append("Sorgenti Health Connect:\n")
                    if (sources.isEmpty()) append("Nessuna")
                    else sources.forEach { append("• ").append(it).append("\n") }
                }
                status.text = if (total > 0) "✅ Dati letti. Ora puoi esportare il file JSON." else "⚠️ Nessun dato trovato nel periodo scelto."
            } catch (e: Exception) {
                status.text = "❌ Lettura non riuscita: ${e.message ?: e.javaClass.simpleName}"
                summary.text = "Controlla i permessi e verifica che QRing stia realmente scrivendo in Health Connect."
            }
        }
    }

    private fun text(value: String, sp: Int, bold: Boolean) = TextView(this).apply {
        text = value
        textSize = sp.toFloat()
        setTextColor(Color.rgb(40,40,45))
        if (bold) setTypeface(null, android.graphics.Typeface.BOLD)
    }

    private fun card(child: View): View = LinearLayout(this).apply {
        setPadding(dp(16), dp(15), dp(16), dp(15))
        setBackgroundColor(Color.WHITE)
        addView(child, LinearLayout.LayoutParams(-1,-2))
        layoutParams = LinearLayout.LayoutParams(-1,-2).apply {
            setMargins(0, dp(10), 0, dp(8))
        }
    }

    private fun button(label: String, action: () -> Unit, secondary: Boolean = false) = Button(this).apply {
        text = label
        textSize = 14f
        isAllCaps = false
        setTextColor(Color.WHITE)
        setBackgroundColor(if (secondary) Color.rgb(0,122,255) else Color.rgb(255,42,95))
        setOnClickListener { action() }
        layoutParams = LinearLayout.LayoutParams(-1, dp(60)).apply {
            setMargins(0, dp(7), 0, dp(7))
        }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density + .5f).toInt()
}
