"""CPU AI Studio — создание и обучение ИИ с нуля на процессоре. Запуск: python app.py"""
import os
import queue
import threading
import tkinter as tk
from tkinter import filedialog, messagebox

import customtkinter as ctk

import engine as E

ACCENT, ACCENT2, WARN = "#6C8CFF", "#FF9F43", "#FF6B6B"
WORK = os.path.join(os.path.expanduser("~"), "CPU_AI_Studio")
os.makedirs(WORK, exist_ok=True)

PRESETS = {  # слои, головы, embd, контекст, словарь
    "Крошечная": (4, 4, 128, 128, 4000),
    "Малая": (6, 6, 256, 256, 8000),
    "Средняя": (8, 8, 384, 256, 12000),
    "Большая": (12, 12, 512, 384, 16000),
}
DATA_PRESETS = ["roneneldan/TinyStories", "wikitext", "Salesforce/wikitext", "tatsu-lab/alpaca",
                "HuggingFaceH4/ultrachat_200k", "IlyaGusev/ru_turbo_alpaca", "bigcode/the-stack-smol"]
FORMATS = {"Авто": "auto", "Обычный текст": "text", "Диалог (вопрос-ответ)": "chat"}


class Slider(ctk.CTkFrame):
    """Подпись + ползунок + текущее значение."""

    def __init__(self, parent, label, lo, hi, value, step=1, fmt="{:g}", tip="", cmd=None, log=False):
        super().__init__(parent, fg_color="transparent")
        self.fmt, self.log, self.cmd, self.step = fmt, log, cmd, step
        self.lo, self.hi = lo, hi
        top = ctk.CTkFrame(self, fg_color="transparent")
        top.pack(fill="x")
        ctk.CTkLabel(top, text=label, anchor="w").pack(side="left")
        self.val = ctk.CTkLabel(top, text="", text_color=ACCENT, font=ctk.CTkFont(weight="bold"))
        self.val.pack(side="right")
        n = int(round((hi - lo) / step)) if not log else 200
        m = __import__("math")
        self.s = ctk.CTkSlider(self, from_=m.log10(lo) if log else lo, to=m.log10(hi) if log else hi, number_of_steps=n, command=self._ch,
                               progress_color=ACCENT, button_color=ACCENT, button_hover_color="#8FA8FF")
        self.s.pack(fill="x", pady=(2, 0))
        if tip:
            ctk.CTkLabel(self, text=tip, text_color="gray60", font=ctk.CTkFont(size=11),
                         anchor="w", justify="left", wraplength=330).pack(fill="x")
        self.set(value)

    def _ch(self, _=None):
        self.val.configure(text=self.fmt.format(self.get()))
        if self.cmd:
            self.cmd()

    def get(self):
        v = self.s.get()
        if self.log:
            return 10 ** v
        return int(round(v)) if isinstance(self.step, int) else round(v, 4)

    def set(self, v):
        self.s.set(__import__("math").log10(v) if self.log else v)
        self._ch()


class LossPlot(tk.Canvas):
    def __init__(self, parent, **kw):
        super().__init__(parent, highlightthickness=0, **kw)
        self.train, self.val = [], []
        self.bind("<Configure>", lambda e: self.redraw())

    def reset(self):
        self.train, self.val = [], []
        self.redraw()

    def redraw(self):
        self.delete("all")
        dark = ctk.get_appearance_mode() == "Dark"
        bg, fg, grid = ("#1e1f26", "#aaa", "#32343f") if dark else ("#f4f5f8", "#555", "#d9dbe3")
        self.configure(bg=bg)
        w, h = self.winfo_width(), self.winfo_height()
        L, R, T, B = 48, 12, 12, 24
        if w < 100 or h < 80:
            return
        pts = self.train + [v for _, v in self.val]
        if len(self.train) < 2:
            self.create_text(w / 2, h / 2, text="График появится после первых шагов", fill=fg)
            return
        lo, hi = min(pts), max(pts)
        hi = hi if hi > lo else lo + 1
        xmax = self.train[-1][0]
        X = lambda s: L + (w - L - R) * s / max(1, xmax)  # noqa: E731
        Y = lambda v: T + (h - T - B) * (1 - (v - lo) / (hi - lo))  # noqa: E731
        for i in range(5):
            v = lo + (hi - lo) * i / 4
            self.create_line(L, Y(v), w - R, Y(v), fill=grid)
            self.create_text(L - 6, Y(v), text=f"{v:.2f}", fill=fg, anchor="e", font=("Segoe UI", 8))
        self.create_text(w - R, h - 8, text=f"шаг {xmax}", fill=fg, anchor="e", font=("Segoe UI", 8))
        # скользящее среднее для читаемости
        data = self.train
        k = max(1, len(data) // 150)
        step = max(1, len(data) // 400)
        line = []
        for i in range(0, len(data), step):
            seg = [d[1] for d in data[max(0, i - k):i + 1]]
            line += [X(data[i][0]), Y(sum(seg) / len(seg))]
        if len(line) >= 4:
            self.create_line(*line, fill=ACCENT, width=2, smooth=True)
        if len(self.val) >= 2:
            self.create_line(*[c for s, v in self.val for c in (X(s), Y(v))], fill=ACCENT2, width=2)
        for s, v in self.val[-1:]:
            self.create_oval(X(s) - 3, Y(v) - 3, X(s) + 3, Y(v) + 3, fill=ACCENT2, outline="")
        self.create_text(L + 6, T + 2, anchor="nw", fill=ACCENT, text="● обучение", font=("Segoe UI", 9))
        self.create_text(L + 90, T + 2, anchor="nw", fill=ACCENT2, text="● проверка", font=("Segoe UI", 9))


class App(ctk.CTk):
    def __init__(self):
        super().__init__()
        ctk.set_appearance_mode("dark")
        ctk.set_default_color_theme("blue")
        self.title("CPU AI Studio — создай свой ИИ с нуля")
        self.geometry("1180x820")
        self.minsize(980, 700)
        self.q = queue.Queue()
        self.job = None
        self.model = self.tok = None
        self.model_info = {}
        self.history = []
        self.chat_stop = threading.Event()
        self.chatting = False
        self._build()
        self.after(100, self._poll)

    # ─── каркас ───
    def _build(self):
        head = ctk.CTkFrame(self, fg_color="transparent")
        head.pack(fill="x", padx=18, pady=(12, 0))
        ctk.CTkLabel(head, text="🧠 CPU AI Studio", font=ctk.CTkFont(size=24, weight="bold")).pack(side="left")
        self.model_lbl = ctk.CTkLabel(head, text="Модель не создана", text_color="gray60")
        self.model_lbl.pack(side="left", padx=18)
        sw = ctk.CTkSwitch(head, text="Тёмная тема", command=self._theme)
        sw.select(); sw.pack(side="right")
        self.tabs = ctk.CTkTabview(self, segmented_button_selected_color=ACCENT)
        self.tabs.pack(fill="both", expand=True, padx=14, pady=8)
        for t in ("1. Данные", "2. Модель", "3. Обучение", "4. Чат", "5. Сохранение"):
            self.tabs.add(t)
        self._tab_data(self.tabs.tab("1. Данные"))
        self._tab_model(self.tabs.tab("2. Модель"))
        self._tab_train(self.tabs.tab("3. Обучение"))
        self._tab_chat(self.tabs.tab("4. Чат"))
        self._tab_save(self.tabs.tab("5. Сохранение"))
        self.status = ctk.CTkLabel(self, text="Готово", anchor="w", text_color="gray60")
        self.status.pack(fill="x", padx=20, pady=(0, 6))

    def _theme(self):
        ctk.set_appearance_mode("dark" if ctk.get_appearance_mode() == "Light" else "light")
        self.after(50, self.plot.redraw)

    def _field(self, parent, label, default="", width=300, ph=""):
        ctk.CTkLabel(parent, text=label, anchor="w").pack(fill="x", pady=(8, 0))
        e = ctk.CTkEntry(parent, width=width, placeholder_text=ph)
        e.insert(0, default)
        e.pack(fill="x")
        return e

    # ─── вкладка данных ───
    def _tab_data(self, tab):
        left = ctk.CTkScrollableFrame(tab, width=460)
        left.pack(side="left", fill="y", padx=(0, 10))
        ctk.CTkLabel(left, text="Источник данных", font=ctk.CTkFont(size=16, weight="bold")).pack(anchor="w")
        self.src_mode = ctk.CTkSegmentedButton(left, values=["Hugging Face", "Локальный файл/папка"],
                                               command=self._src_changed, selected_color=ACCENT)
        self.src_mode.set("Hugging Face")
        self.src_mode.pack(fill="x", pady=8)
        ctk.CTkLabel(left, text="Датасет (любой с huggingface.co/datasets):", anchor="w").pack(fill="x")
        self.ds_box = ctk.CTkComboBox(left, values=DATA_PRESETS)
        self.ds_box.set("roneneldan/TinyStories")
        self.ds_box.pack(fill="x")
        self.file_row = ctk.CTkFrame(left, fg_color="transparent")
        self.file_btn = ctk.CTkButton(self.file_row, text="Выбрать файл (.txt .jsonl .csv .parquet)…",
                                      command=self._pick_file)
        self.file_btn.pack(fill="x")
        self.cfg_e = self._field(left, "Конфигурация (необязательно, напр. wikitext-2-raw-v1):")
        self.split_e = self._field(left, "Сплит:", "train")
        self.col_e = self._field(left, "Колонка с текстом (пусто = авто):")
        self.tok_e = self._field(left, "HF-токен (только для закрытых датасетов):")
        self.tok_e.configure(show="•")
        ctk.CTkLabel(left, text="Формат:", anchor="w").pack(fill="x", pady=(8, 0))
        self.fmt_m = ctk.CTkOptionMenu(left, values=list(FORMATS), fg_color=ACCENT)
        self.fmt_m.pack(fill="x")
        self.max_samples = Slider(left, "Макс. примеров", 1000, 200000, 20000, 1000, "{:,}",
                                  "Больше данных = умнее модель, но дольше подготовка.")
        self.max_samples.pack(fill="x", pady=(14, 0))
        self.max_mb = Slider(left, "Макс. объём текста (МБ)", 1, 200, 20, 1, "{} МБ")
        self.max_mb.pack(fill="x", pady=(8, 0))
        ctk.CTkButton(left, text="🔍 Проверить датасет (показать примеры)", command=self._preview,
                      fg_color="#3a3d4d", hover_color="#4a4e63").pack(fill="x", pady=14)
        right = ctk.CTkFrame(tab)
        right.pack(side="left", fill="both", expand=True)
        ctk.CTkLabel(right, text="Предпросмотр — так модель увидит данные", anchor="w",
                     font=ctk.CTkFont(size=14, weight="bold")).pack(fill="x", padx=12, pady=(10, 0))
        self.preview = ctk.CTkTextbox(right, wrap="word")
        self.preview.pack(fill="both", expand=True, padx=12, pady=10)
        self.preview.insert("1.0", "Подсказки:\n• Для болтовни/ответов берите диалоговые датасеты "
                            "(alpaca, ultrachat, ru_turbo_alpaca) — формат определится сам.\n"
                            "• Для чистого текста — TinyStories, wikitext.\n"
                            "• Любое имя вида «автор/датасет» с Hugging Face подойдёт.\n"
                            "• Данные грузятся потоком — скачивать гигабайты не нужно.")
        self._src_changed("Hugging Face")

    def _src_changed(self, v):
        if v == "Hugging Face":
            self.file_row.pack_forget()
        else:
            self.file_row.pack(fill="x", pady=4, after=self.ds_box)

    def _pick_file(self):
        p = filedialog.askopenfilename(filetypes=[("Данные", "*.txt *.md *.jsonl *.json *.csv *.tsv *.parquet"), ("Все", "*")])
        if p:
            self.ds_box.set(p)

    def _data_args(self):
        return dict(source=self.ds_box.get().strip(), config=self.cfg_e.get().strip(),
                    split=self.split_e.get().strip() or "train", column=self.col_e.get().strip(),
                    fmt=FORMATS[self.fmt_m.get()], max_samples=self.max_samples.get(),
                    token=self.tok_e.get().strip())

    def _preview(self):
        args = self._data_args()
        args["max_samples"] = 5
        self.preview.delete("1.0", "end")
        self.preview.insert("end", "Загружаю…\n")

        def work():
            try:
                out = [t[:900] for t in E.iter_dataset(**args)]
                self.q.put(("preview", "\n\n──────────\n\n".join(out)))
            except Exception as e:  # noqa: BLE001
                self.q.put(("preview", f"❌ Ошибка: {e}"))
        threading.Thread(target=work, daemon=True).start()

    # ─── вкладка модели ───
    def _tab_model(self, tab):
        left = ctk.CTkScrollableFrame(tab, width=460)
        left.pack(side="left", fill="y", padx=(0, 10))
        ctk.CTkLabel(left, text="Архитектура нейросети", font=ctk.CTkFont(size=16, weight="bold")).pack(anchor="w")
        self.preset = ctk.CTkSegmentedButton(left, values=list(PRESETS), command=self._apply_preset,
                                             selected_color=ACCENT)
        self.preset.pack(fill="x", pady=8)
        self.s_layer = Slider(left, "Слоёв (глубина)", 1, 24, 6, 1, tip="Больше слоёв — умнее, но медленнее.", cmd=self._upd)
        self.s_head = Slider(left, "Голов внимания", 1, 16, 6, 1, cmd=self._upd)
        self.s_embd = Slider(left, "Размер эмбеддинга (ширина)", 64, 1024, 256, 32, tip="Подгоняется под число голов.", cmd=self._upd)
        self.s_ctx = Slider(left, "Длина контекста (токенов)", 32, 1024, 256, 32, tip="Сколько текста модель «помнит».", cmd=self._upd)
        self.s_vocab = Slider(left, "Размер словаря токенайзера", 1000, 32000, 8000, 500, "{:,}", cmd=self._upd)
        self.s_drop = Slider(left, "Dropout", 0, 0.5, 0.1, 0.05, "{:.2f}", "Защита от переобучения.", cmd=self._upd)
        for s in (self.s_layer, self.s_head, self.s_embd, self.s_ctx, self.s_vocab, self.s_drop):
            s.pack(fill="x", pady=6)
        right = ctk.CTkFrame(tab)
        right.pack(side="left", fill="both", expand=True)
        self.params_lbl = ctk.CTkLabel(right, text="", font=ctk.CTkFont(size=40, weight="bold"), text_color=ACCENT)
        self.params_lbl.pack(pady=(40, 0))
        ctk.CTkLabel(right, text="параметров", text_color="gray60").pack()
        self.model_hint = ctk.CTkLabel(right, text="", wraplength=420, justify="left")
        self.model_hint.pack(pady=20, padx=20)
        self.cont_var = ctk.BooleanVar(value=False)
        self.cont_sw = ctk.CTkSwitch(right, text="Дообучать загруженную/обученную модель (вместо новой с нуля)",
                                     variable=self.cont_var)
        self.cont_sw.pack(pady=10)
        self.preset.set("Малая")
        self._apply_preset("Малая")

    def _apply_preset(self, name):
        l, h, d, c, v = PRESETS[name]
        self.s_layer.set(l); self.s_head.set(h); self.s_embd.set(d); self.s_ctx.set(c); self.s_vocab.set(v)

    def _model_cfg(self):
        h = self.s_head.get()
        d = max(h, round(self.s_embd.get() / h) * h)
        return E.ModelConfig(self.s_vocab.get(), self.s_ctx.get(), self.s_layer.get(), h, d, self.s_drop.get())

    def _upd(self):
        if not hasattr(self, "params_lbl"):
            return
        c = self._model_cfg()
        n = E.estimate_params(c)
        self.params_lbl.configure(text=f"{n / 1e6:.1f} M")
        speed = "очень быстро" if n < 5e6 else "быстро" if n < 20e6 else "умеренно" if n < 60e6 else "медленно"
        self.model_hint.configure(text=f"Эмбеддинг будет {c.n_embd} (кратен {c.n_head} головам).\n"
                                       f"Скорость обучения на CPU: {speed}.\n"
                                       f"Размер файла модели ≈ {n * 4 / 1e6:.0f} МБ.")

    # ─── вкладка обучения ───
    def _tab_train(self, tab):
        left = ctk.CTkScrollableFrame(tab, width=400)
        left.pack(side="left", fill="y", padx=(0, 10))
        ctk.CTkLabel(left, text="Настройки обучения", font=ctk.CTkFont(size=16, weight="bold")).pack(anchor="w")
        ncpu = os.cpu_count() or 4
        self.t_steps = Slider(left, "Шагов обучения", 100, 50000, 2000, 100, "{:,}", "Больше шагов — лучше результат.")
        self.t_batch = Slider(left, "Размер батча", 1, 64, 16, 1)
        self.t_accum = Slider(left, "Накопление градиента", 1, 16, 1, 1, tip="Эффективный батч = батч × накопление.")
        self.t_lr = Slider(left, "Скорость обучения (LR)", 1e-5, 1e-2, 3e-4, fmt="{:.1e}", log=True)
        self.t_warm = Slider(left, "Разогрев (шагов)", 0, 1000, 100, 10)
        self.t_wd = Slider(left, "Weight decay", 0, 0.3, 0.1, 0.01, "{:.2f}")
        self.t_clip = Slider(left, "Обрезка градиента", 0, 5, 1.0, 0.1, "{:.1f}")
        self.t_eval = Slider(left, "Проверка каждые N шагов", 10, 1000, 100, 10)
        self.t_thr = Slider(left, "Потоков CPU", 1, ncpu, max(1, ncpu - 1) if ncpu > 2 else ncpu, 1,
                            tip=f"Доступно ядер/потоков: {ncpu}. Меньше — комп не тормозит.")
        for s in (self.t_steps, self.t_batch, self.t_accum, self.t_lr, self.t_warm, self.t_wd,
                  self.t_clip, self.t_eval, self.t_thr):
            s.pack(fill="x", pady=5)
        right = ctk.CTkFrame(tab)
        right.pack(side="left", fill="both", expand=True)
        btns = ctk.CTkFrame(right, fg_color="transparent")
        btns.pack(fill="x", padx=12, pady=10)
        self.b_start = ctk.CTkButton(btns, text="▶ Начать обучение", command=self._start, fg_color="#2ea043",
                                     hover_color="#3fb950", height=38, font=ctk.CTkFont(weight="bold"))
        self.b_start.pack(side="left", padx=(0, 8))
        self.b_pause = ctk.CTkButton(btns, text="⏸ Пауза", command=self._pause, state="disabled", height=38,
                                     fg_color=ACCENT2, hover_color="#ffb066", text_color="black")
        self.b_pause.pack(side="left", padx=(0, 8))
        self.b_stop = ctk.CTkButton(btns, text="⏹ Стоп", command=self._stop, state="disabled", height=38,
                                    fg_color=WARN, hover_color="#ff8888")
        self.b_stop.pack(side="left")
        self.bar = ctk.CTkProgressBar(right, progress_color=ACCENT)
        self.bar.set(0)
        self.bar.pack(fill="x", padx=12)
        self.stats = ctk.CTkLabel(right, text="—", anchor="w", font=ctk.CTkFont(family="Consolas", size=12))
        self.stats.pack(fill="x", padx=12, pady=6)
        self.plot = LossPlot(right, height=240)
        self.plot.pack(fill="x", padx=12, pady=4)
        self.log = ctk.CTkTextbox(right, height=140, font=ctk.CTkFont(family="Consolas", size=11))
        self.log.pack(fill="both", expand=True, padx=12, pady=10)

    def _log(self, msg):
        self.log.insert("end", msg + "\n")
        self.log.see("end")

    def _start(self):
        if self.job and self.job.is_alive():
            return
        args = self._data_args()
        if not args["source"]:
            return messagebox.showwarning("Нет данных", "Укажите датасет на вкладке «Данные».")
        args["max_chars"] = self.max_mb.get() * 1_000_000
        cont = self.cont_var.get() and self.model is not None
        if self.cont_var.get() and self.model is None:
            messagebox.showinfo("Нет модели", "Дообучать пока нечего — создаю новую модель с нуля.")
        resume = (self.model, self.tok, self.model_info) if cont else None
        cfg = self.model.cfg if cont else self._model_cfg()
        p = E.TrainParams(self.t_steps.get(), self.t_batch.get(), self.t_accum.get(), self.t_lr.get(),
                          self.t_warm.get(), self.t_wd.get(), self.t_clip.get(), self.t_eval.get(),
                          500, self.t_thr.get())
        self.plot.reset()
        self.bar.set(0)
        self.log.delete("1.0", "end")
        self.job = E.TrainJob(args, cfg, p, lambda k, **d: self.q.put((k, d)), resume,
                              os.path.join(WORK, "checkpoint.pt"))
        self.job.start()
        self.b_start.configure(state="disabled")
        self.b_pause.configure(state="normal", text="⏸ Пауза")
        self.b_stop.configure(state="normal")
        self.tabs.set("3. Обучение")

    def _pause(self):
        if not self.job:
            return
        if self.job.pause_flag.is_set():
            self.job.pause_flag.clear(); self.b_pause.configure(text="⏸ Пауза")
        else:
            self.job.pause_flag.set(); self.b_pause.configure(text="▶ Продолжить")

    def _stop(self):
        if self.job:
            self.job.stop_flag.set()
            self.job.pause_flag.clear()

    def _finish_ui(self):
        self.b_start.configure(state="normal")
        self.b_pause.configure(state="disabled")
        self.b_stop.configure(state="disabled")

    # ─── вкладка чата ───
    def _tab_chat(self, tab):
        left = ctk.CTkScrollableFrame(tab, width=300)
        left.pack(side="left", fill="y", padx=(0, 10))
        ctk.CTkLabel(left, text="Генерация", font=ctk.CTkFont(size=16, weight="bold")).pack(anchor="w")
        self.c_mode = ctk.CTkSegmentedButton(left, values=["Диалог", "Продолжение текста"], selected_color=ACCENT)
        self.c_mode.set("Диалог")
        self.c_mode.pack(fill="x", pady=8)
        self.c_temp = Slider(left, "Температура", 0, 2, 0.8, 0.05, "{:.2f}", "Выше — креативнее, ниже — строже.")
        self.c_topk = Slider(left, "Top-K", 0, 200, 40, 1)
        self.c_topp = Slider(left, "Top-P", 0.1, 1.0, 0.95, 0.05, "{:.2f}")
        self.c_rep = Slider(left, "Штраф за повторы", 1.0, 2.0, 1.1, 0.05, "{:.2f}")
        self.c_len = Slider(left, "Макс. длина ответа", 16, 1000, 200, 8)
        for s in (self.c_temp, self.c_topk, self.c_topp, self.c_rep, self.c_len):
            s.pack(fill="x", pady=6)
        ctk.CTkButton(left, text="🗑 Очистить чат", command=self._clear_chat, fg_color="#3a3d4d").pack(fill="x", pady=10)
        right = ctk.CTkFrame(tab)
        right.pack(side="left", fill="both", expand=True)
        self.chat = ctk.CTkTextbox(right, wrap="word", font=ctk.CTkFont(size=14))
        self.chat.pack(fill="both", expand=True, padx=10, pady=(10, 6))
        self.chat.tag_config("you", foreground=ACCENT)
        self.chat.tag_config("bot", foreground="#7ee787")
        self.chat.insert("end", "Обучите или загрузите модель, затем пишите сюда.\n")
        row = ctk.CTkFrame(right, fg_color="transparent")
        row.pack(fill="x", padx=10, pady=(0, 10))
        self.entry = ctk.CTkEntry(row, placeholder_text="Напишите сообщение и нажмите Enter…", height=40)
        self.entry.pack(side="left", fill="x", expand=True, padx=(0, 8))
        self.entry.bind("<Return>", lambda e: self._send())
        self.b_send = ctk.CTkButton(row, text="Отправить", width=110, height=40, command=self._send, fg_color=ACCENT)
        self.b_send.pack(side="left")

    def _clear_chat(self):
        self.history = []
        self.chat.delete("1.0", "end")

    def _send(self):
        if self.chatting:
            self.chat_stop.set()
            return
        msg = self.entry.get().strip()
        if not msg:
            return
        if not self.model:
            return messagebox.showinfo("Нет модели", "Сначала обучите или загрузите модель.")
        self.entry.delete(0, "end")
        self.chat.insert("end", f"\nВы: {msg}\n", "you")
        self.chat.insert("end", "ИИ: ", "bot")
        self.chat_stop.clear()
        self.chatting = True
        self.b_send.configure(text="Стоп")
        chat_mode = self.c_mode.get() == "Диалог"
        kw = dict(chat_mode=chat_mode, max_new=self.c_len.get(), temperature=self.c_temp.get(),
                  top_k=self.c_topk.get(), top_p=self.c_topp.get(), rep_penalty=self.c_rep.get(),
                  should_stop=self.chat_stop.is_set)
        hist = list(self.history)

        def work():
            ans = ""
            try:
                for piece in E.stream_reply(self.model, self.tok, hist, msg, **kw):
                    ans += piece
                    self.q.put(("chat_tok", piece))
            except Exception as e:  # noqa: BLE001
                self.q.put(("chat_tok", f"[ошибка: {e}]"))
            self.q.put(("chat_done", (msg, ans.strip(), chat_mode)))
        threading.Thread(target=work, daemon=True).start()

    # ─── вкладка сохранения ───
    def _tab_save(self, tab):
        box = ctk.CTkFrame(tab)
        box.pack(fill="both", expand=True, padx=40, pady=30)
        self.info_lbl = ctk.CTkLabel(box, text="Модель пока не создана.", justify="left", anchor="w",
                                     font=ctk.CTkFont(size=14))
        self.info_lbl.pack(fill="x", padx=20, pady=20)
        for text, cmd, col in (("💾 Сохранить модель (.pt)", self._save, ACCENT),
                               ("📦 Экспорт папкой (модель + токенайзер + чат-скрипт)", self._export, "#2ea043"),
                               ("📂 Загрузить модель (.pt)", self._load, "#3a3d4d"),
                               ("🗂 Открыть рабочую папку", lambda: os.startfile(WORK) if hasattr(os, "startfile") else None, "#3a3d4d")):
            ctk.CTkButton(box, text=text, command=cmd, height=42, fg_color=col, width=420).pack(pady=7)
        ctk.CTkLabel(box, text=f"Автосохранение: {os.path.join(WORK, 'checkpoint.pt')}", text_color="gray60").pack(pady=10)

    def _set_model(self, model, tok, info):
        self.model, self.tok, self.model_info = model, tok, info or {}
        n = sum(p.numel() for p in model.parameters())
        c = model.cfg
        self.model_lbl.configure(text=f"✅ Модель: {n / 1e6:.1f}M параметров", text_color="#7ee787")
        self.info_lbl.configure(text=f"Параметров: {n:,}\nСлоёв: {c.n_layer}   Голов: {c.n_head}   Ширина: {c.n_embd}\n"
                                     f"Контекст: {c.block_size}   Словарь: {c.vocab_size}\n"
                                     f"Шагов обучено: {self.model_info.get('steps', '—')}")

    def _need_model(self):
        if not self.model:
            messagebox.showinfo("Нет модели", "Сначала обучите или загрузите модель.")
        return bool(self.model)

    def _save(self):
        if not self._need_model():
            return
        p = filedialog.asksaveasfilename(defaultextension=".pt", filetypes=[("Модель", "*.pt")], initialfile="my_ai.pt")
        if p:
            E.save_bundle(p, self.model, self.tok, self.model_info)
            self.status.configure(text=f"Сохранено: {p}")

    def _export(self):
        if not self._need_model():
            return
        d = filedialog.askdirectory(title="Куда экспортировать?")
        if d:
            out = os.path.join(d, "my_ai_model")
            files = E.export_model(out, self.model, self.tok, self.model_info)
            messagebox.showinfo("Готово", f"Экспорт в {out}\n\n" + "\n".join(files) +
                                "\n\nЗапуск без программы: python chat.py (нужны torch и tokenizers).")

    def _load(self):
        p = filedialog.askopenfilename(filetypes=[("Модель", "*.pt")])
        if p:
            try:
                self._set_model(*E.load_bundle(p))
                self.status.configure(text=f"Загружено: {p}")
            except Exception as e:  # noqa: BLE001
                messagebox.showerror("Ошибка", str(e))

    # ─── события из потоков ───
    def _poll(self):
        try:
            while True:
                k, d = self.q.get_nowait()
                self._handle(k, d)
        except queue.Empty:
            pass
        self.after(80, self._poll)

    def _handle(self, k, d):
        if k == "log":
            self._log(d["msg"])
        elif k == "status":
            self.status.configure(text=d["msg"])
        elif k == "preview":
            self.preview.delete("1.0", "end"); self.preview.insert("end", d)
        elif k == "step":
            self.bar.set(d["step"] / d["total"])
            self.plot.train.append((d["step"], d["loss"]))
            if d["val"] is not None:
                self.plot.val.append((d["step"], d["val"]))
            if d["step"] % 5 == 0 or d["val"] is not None:
                self.plot.redraw()
            m, s = divmod(int(d["eta"]), 60)
            self.stats.configure(text=f"шаг {d['step']}/{d['total']}  loss {d['ema']:.3f}"
                                      + (f"  val {d['val']:.3f}" if d["val"] is not None else "")
                                      + f"  lr {d['lr']:.1e}  {d['tps']:.0f} ток/с  осталось {m}м {s:02d}с")
        elif k == "model":
            self._set_model(d["model"], d["tok"], d["info"])
        elif k == "error":
            self._finish_ui()
            messagebox.showerror("Ошибка обучения", d["msg"])
        elif k == "done":
            self._finish_ui()
            self.plot.redraw()
            self.status.configure(text="Обучение завершено — можно общаться на вкладке «Чат»")
        elif k == "chat_tok":
            self.chat.insert("end", d, "bot"); self.chat.see("end")
        elif k == "chat_done":
            q, a, chat_mode = d
            if chat_mode:
                self.history.append((q, a))
            self.chat.insert("end", "\n"); self.chat.see("end")
            self.chatting = False
            self.b_send.configure(text="Отправить")


if __name__ == "__main__":
    App().mainloop()
