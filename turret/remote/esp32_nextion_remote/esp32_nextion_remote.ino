// ============================================================================
// Автотурель - выносной пульт на ESP32 + дисплей Nextion
//
// Схема: Nextion (UART, локально) <-> ESP32 <-> Wi-Fi <-> REST API Raspberry Pi
//
// ESP32 ничего не решает сам по себе "по-крупному" - вся безопасность
// (ARM/DISARM, лимиты стрельбы и т.п.) по-прежнему на стороне Pi
// (app/motion/trigger.py, app/tracking.py). Этот скетч - просто мост:
// читает касания с Nextion и дёргает тот же самый REST API, которым
// пользуется браузерный веб-интерфейс (см. app/web/server.py).
//
// Библиотеки (Arduino IDE -> Инструменты -> Управление библиотеками):
//   - "ArduinoJson" (автор Benoit Blanchon) - нужна именно ВЕРСИЯ 7.x
// Плата (Инструменты -> Плата): любая "ESP32 Dev Module" (ESP32-WROOM-32).
//
// ВНИМАНИЕ: этот скетч не был скомпилирован здесь (в песочнице нет доступа
// к серверам Arduino/Espressif) - собран по хорошо известным, стабильным
// API вручную и тщательно перепроверен, но если Arduino IDE выдаст ошибку
// компиляции - пришлите её текст, поправим.
// ============================================================================

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ---------------------------------------------------------------------------
// НАСТРОЙКИ - ОБЯЗАТЕЛЬНО ПРАВИМ ПОД СЕБЯ
// ---------------------------------------------------------------------------
const char* WIFI_SSID     = "ВАШ_WIFI";
const char* WIFI_PASSWORD = "ВАШ_ПАРОЛЬ";
const char* PI_BASE_URL   = "http://192.168.1.50:8080";  // IP-адрес Raspberry Pi в вашей сети

// UART к Nextion. По умолчанию берём аппаратный UART2 (GPIO16=RX2, GPIO17=TX2).
// Подключение ПЕРЕКРЁСТНОЕ: TX2 (GPIO17) -> RX дисплея, RX2 (GPIO16) -> TX дисплея.
// Если у вашей платы ESP32 это модуль с PSRAM (WROVER) - эти пины могут быть
// заняты под память; в этом случае замените на, например, 25 и 26.
#define NEXTION_RX_PIN 16
#define NEXTION_TX_PIN 17
#define NEXTION_BAUD   9600   // заводской baud rate Nextion; см. README, если меняли

// Числовые ID компонентов - ДОЛЖНЫ ТОЧНО совпадать с полем "id" в Nextion
// Editor для каждой кнопки (см. remote/docs/nextion-ui-spec.md).
enum ComponentId {
  ID_B_ARM    = 1,
  ID_B_MODE   = 2,
  ID_B_UP     = 3,
  ID_B_DOWN   = 4,
  ID_B_LEFT   = 5,
  ID_B_RIGHT  = 6,
  ID_B_CENTER = 7,
  ID_B_FIRE   = 8,
  ID_B_ESTOP  = 9,
};

const unsigned long STATUS_POLL_INTERVAL_MS = 400;
const unsigned long ARM_CONFIRM_WINDOW_MS   = 3000;
const float MANUAL_PAN_SPEED   = 300.0;  // шаг/сек, пока зажата ВЛЕВО/ВПРАВО
const float MANUAL_TILT_STEP   = 1.5;    // градусов за один импульс ВВЕРХ/ВНИЗ
const unsigned long TILT_REPEAT_MS = 120; // период повторных импульсов наклона

// ---------------------------------------------------------------------------

HardwareSerial NextionSerial(2);

// Последнее известное состояние турели (из /api/status)
bool   knownArmed               = false;
String knownMode                = "manual";
bool   knownDetectionAvailable  = true;

// Состояние подтверждения взвода (двойное нажатие ARM в течение окна)
bool armConfirmPending    = false;
unsigned long armConfirmStartedAt = 0;

// Текущее "зажатое" состояние осей ручного управления - именно ОБЕ оси
// шлются вместе в каждом manual_move, иначе отпускание одной кнопки может
// случайно обнулить движение по другой.
float currentPanCmd = 0;
bool  tiltUpHeld     = false;
bool  tiltDownHeld   = false;
unsigned long lastTiltRepeatAt = 0;

unsigned long lastStatusPollAt = 0;

// ============================================================================
// Nextion: низкоуровневая отправка команд
// ============================================================================
void nxSendRaw(const String& cmd) {
  NextionSerial.print(cmd);
  NextionSerial.write((uint8_t)0xFF);
  NextionSerial.write((uint8_t)0xFF);
  NextionSerial.write((uint8_t)0xFF);
}

void nxSetText(const char* objName, const String& value) {
  String escaped = value;
  escaped.replace("\"", "'");  // кавычки внутри строки сломали бы команду
  nxSendRaw(String(objName) + ".txt=\"" + escaped + "\"");
}

// Читает одно событие касания с Nextion, если оно уже пришло целиком.
// Формат пакета: 0x65 <page> <component> <event> 0xFF 0xFF 0xFF (7 байт).
// event: 0x01 = нажатие, 0x00 = отпускание.
// Требует включённой галочки "Send Component ID" в Touch Press И Touch
// Release Event для каждой кнопки в Nextion Editor.
bool nxReadTouchEvent(uint8_t &component, uint8_t &event) {
  if (NextionSerial.available() < 7) return false;
  if (NextionSerial.peek() != 0x65) {
    NextionSerial.read();  // не наш байт - выкидываем и ищем синхронизацию заново
    return false;
  }
  uint8_t buf[7];
  for (int i = 0; i < 7; i++) buf[i] = NextionSerial.read();
  if (buf[4] != 0xFF || buf[5] != 0xFF || buf[6] != 0xFF) return false;
  component = buf[2];
  event = buf[3];
  return true;
}

// ============================================================================
// REST API Raspberry Pi
// ============================================================================
bool piPostJson(const String& path, const String& jsonBody) {
  HTTPClient http;
  http.setTimeout(1500);
  if (!http.begin(String(PI_BASE_URL) + path)) return false;
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(jsonBody);
  http.end();
  Serial.printf("POST %s -> %d\n", path.c_str(), code);
  return code >= 200 && code < 300;
}

bool piGetStatus() {
  HTTPClient http;
  http.setTimeout(1500);
  if (!http.begin(String(PI_BASE_URL) + "/api/status")) return false;
  int code = http.GET();
  if (code != 200) {
    http.end();
    return false;
  }
  String body = http.getString();
  http.end();

  JsonDocument doc;  // ArduinoJson 7.x: единый JsonDocument без шаблонного размера
  DeserializationError err = deserializeJson(doc, body);
  if (err) {
    Serial.print("JSON parse error: ");
    Serial.println(err.c_str());
    return false;
  }

  knownArmed = doc["armed"] | false;
  const char* modeStr = doc["mode"] | "manual";
  knownMode = modeStr;
  knownDetectionAvailable = doc["detection_available"] | true;
  bool  locked   = doc["locked"] | false;
  float fps      = doc["fps"] | 0.0f;
  int   targets  = doc["targets"] | 0;
  int   panPos   = doc["pan_position"] | 0;
  float tiltAngle = doc["tilt_angle"] | 0.0f;

  if (!armConfirmPending) {
    nxSetText("t_status", knownArmed ? "ARMED" : "SAFE");
  }
  nxSetText("t_mode", knownMode == "auto" ? "AUTO" : "MANUAL");
  nxSetText("t_lock", locked ? "LOCK" : "-");
  nxSetText("t_fps", String(fps, 1));
  nxSetText("t_targets", String(targets));
  nxSetText("t_pan", String(panPos));
  nxSetText("t_tilt", String(tiltAngle, 1));
  nxSetText("t_conn", "OK");
  return true;
}

// ============================================================================
// Ручное управление: всегда шлём ОБЕ оси вместе (см. комментарий у переменных)
// ============================================================================
void updateManualMove() {
  float tilt = 0;
  if (tiltUpHeld) tilt = MANUAL_TILT_STEP;
  else if (tiltDownHeld) tilt = -MANUAL_TILT_STEP;
  piPostJson("/api/manual_move",
             "{\"pan\":" + String(currentPanCmd, 1) + ",\"tilt\":" + String(tilt, 1) + "}");
}

// ============================================================================
// Логика кнопок
// ============================================================================
void handleArmButton() {
  unsigned long now = millis();
  if (armConfirmPending && (now - armConfirmStartedAt) <= ARM_CONFIRM_WINDOW_MS) {
    // Второе нажатие в пределах окна подтверждения - реально взводим
    armConfirmPending = false;
    bool wantArm = !knownArmed;
    piPostJson("/api/arm", String("{\"armed\":") + (wantArm ? "true" : "false") + "}");
    nxSetText("t_status", wantArm ? "ARMED" : "SAFE");
  } else if (!knownArmed) {
    // Первое нажатие на взвод - просим подтверждения
    armConfirmPending = true;
    armConfirmStartedAt = now;
    nxSetText("t_status", "CONFIRM?");
  } else {
    // Снятие с взвода подтверждения не требует
    piPostJson("/api/arm", "{\"armed\":false}");
    nxSetText("t_status", "SAFE");
  }
}

void handleModeButton() {
  String newMode = (knownMode == "auto") ? "manual" : "auto";
  if (piPostJson("/api/mode", "{\"mode\":\"" + newMode + "\"}")) {
    knownMode = newMode;
    nxSetText("t_mode", newMode == "auto" ? "AUTO" : "MANUAL");
  }
}

void handleTouchEvent(uint8_t component, uint8_t event) {
  bool pressed = (event == 0x01);
  switch (component) {
    case ID_B_ARM:
      if (pressed) handleArmButton();
      break;
    case ID_B_MODE:
      if (pressed) handleModeButton();
      break;
    case ID_B_LEFT:
      currentPanCmd = pressed ? -MANUAL_PAN_SPEED : 0;
      updateManualMove();
      break;
    case ID_B_RIGHT:
      currentPanCmd = pressed ? MANUAL_PAN_SPEED : 0;
      updateManualMove();
      break;
    case ID_B_UP:
      tiltUpHeld = pressed;
      updateManualMove();
      break;
    case ID_B_DOWN:
      tiltDownHeld = pressed;
      updateManualMove();
      break;
    case ID_B_CENTER:
      if (pressed) piPostJson("/api/center", "{}");
      break;
    case ID_B_FIRE:
      if (pressed) piPostJson("/api/fire", "{}");
      break;
    case ID_B_ESTOP:
      if (pressed) {
        piPostJson("/api/emergency_stop", "{}");
        armConfirmPending = false;
        currentPanCmd = 0;
        tiltUpHeld = false;
        tiltDownHeld = false;
      }
      break;
    default:
      Serial.printf("Неизвестный component id: %d\n", component);
      break;
  }
}

// ============================================================================
void setup() {
  Serial.begin(115200);
  delay(200);

  NextionSerial.begin(NEXTION_BAUD, SERIAL_8N1, NEXTION_RX_PIN, NEXTION_TX_PIN);
  delay(500);
  nxSendRaw("");  // сбрасываем возможный "хвост" в буфере Nextion после включения
  nxSetText("t_conn", "WIFI...");

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // без этого Wi-Fi модем-сон добавляет заметные задержки
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Подключение к Wi-Fi");
  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wifiStart < 20000) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Wi-Fi подключён, IP: ");
    Serial.println(WiFi.localIP());
    nxSetText("t_conn", "WIFI OK");
  } else {
    Serial.println("Не удалось подключиться к Wi-Fi за 20 секунд");
    nxSetText("t_conn", "NET WIFI");
  }
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    nxSetText("t_conn", "NET WIFI");
    WiFi.reconnect();
    delay(500);
    return;
  }

  // Таймаут "зависшего" подтверждения взвода
  if (armConfirmPending && millis() - armConfirmStartedAt > ARM_CONFIRM_WINDOW_MS) {
    armConfirmPending = false;
    nxSetText("t_status", knownArmed ? "ARMED" : "SAFE");
  }

  // Повторные импульсы наклона, пока кнопка ВВЕРХ/ВНИЗ удерживается
  if ((tiltUpHeld || tiltDownHeld) && millis() - lastTiltRepeatAt >= TILT_REPEAT_MS) {
    lastTiltRepeatAt = millis();
    updateManualMove();
  }

  // Разбираем все накопившиеся события касания с Nextion
  uint8_t component, event;
  while (nxReadTouchEvent(component, event)) {
    handleTouchEvent(component, event);
  }

  // Периодический опрос состояния турели
  if (millis() - lastStatusPollAt >= STATUS_POLL_INTERVAL_MS) {
    lastStatusPollAt = millis();
    if (!piGetStatus()) {
      nxSetText("t_conn", "NET PI");
    }
  }
}
