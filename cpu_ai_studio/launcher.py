"""Запуск CPU AI Studio: сам доустанавливает нужные библиотеки, затем открывает приложение.
Использует только стандартную библиотеку, поэтому работает на чистом Python."""
import importlib
import importlib.util
import os
import site
import subprocess
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# (модуль, pip-пакет, доп. аргументы)
DEPS = [
    ("numpy", "numpy", []),
    ("torch", "torch", ["--index-url", "https://download.pytorch.org/whl/cpu"]),  # версия только для CPU
    ("tokenizers", "tokenizers", []),
    ("datasets", "datasets", []),
    ("customtkinter", "customtkinter", []),
    ("safetensors", "safetensors", []),
]


def missing():
    return [d for d in DEPS if importlib.util.find_spec(d[0]) is None]


def pip(args, log):
    in_venv = sys.prefix != getattr(sys, "base_prefix", sys.prefix)
    cmd = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check"] + ([] if in_venv else ["--user"]) + args
    log("$ " + " ".join(cmd[3:]))
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                         errors="replace", creationflags=flags)
    for line in p.stdout:
        line = line.strip()
        if line:
            log(line[:150])
    return p.wait() == 0


def install_all(log, step):
    todo = missing()
    for i, (mod, pkg, extra) in enumerate(todo, 1):
        step(f"Устанавливаю {pkg} ({i}/{len(todo)})…")
        ok = pip([pkg] + extra, log)
        if not ok and extra:  # запасной вариант: обычный PyPI
            log("Основной источник не сработал, пробую PyPI…")
            ok = pip([pkg], log)
        if not ok:
            raise RuntimeError(f"Не удалось установить {pkg}. Проверьте интернет и запустите снова.")
    importlib.invalidate_caches()
    us = site.getusersitepackages()
    if os.path.isdir(us) and us not in sys.path:
        site.addsitedir(us)
    importlib.invalidate_caches()


def main():
    if not missing():
        return run_app()
    try:
        import tkinter as tk
        from tkinter import ttk
    except ImportError:  # нет tkinter — ставим в консоли
        install_all(print, print)
        return run_app()

    root = tk.Tk()
    root.title("CPU AI Studio — первая настройка")
    root.geometry("640x380")
    root.configure(bg="#1e1f26")
    tk.Label(root, text="🧠 CPU AI Studio", font=("Segoe UI", 18, "bold"), bg="#1e1f26", fg="#6C8CFF").pack(pady=(14, 0))
    tk.Label(root, text="Первый запуск: ставлю нужные компоненты (несколько минут, нужен интернет).\n"
                        "Окно закроется само, и откроется программа.", bg="#1e1f26", fg="#ccc").pack(pady=6)
    lbl = tk.Label(root, text="Подготовка…", bg="#1e1f26", fg="white", font=("Segoe UI", 11, "bold"))
    lbl.pack()
    bar = ttk.Progressbar(root, mode="indeterminate", length=580)
    bar.pack(pady=8)
    bar.start(12)
    box = tk.Text(root, height=11, bg="#14151a", fg="#9aa", font=("Consolas", 9), relief="flat")
    box.pack(fill="both", expand=True, padx=12, pady=(0, 12))
    state = {"err": None, "done": False}

    def log(m):
        root.after(0, lambda: (box.insert("end", m + "\n"), box.see("end")))

    def step(m):
        root.after(0, lambda: lbl.configure(text=m))

    def work():
        try:
            install_all(log, step)
        except Exception as e:  # noqa: BLE001
            state["err"] = str(e)
        state["done"] = True

    def poll():
        if not state["done"]:
            return root.after(300, poll)
        bar.stop()
        if state["err"]:
            lbl.configure(text="❌ " + state["err"], fg="#ff6b6b")
        else:
            root.destroy()

    threading.Thread(target=work, daemon=True).start()
    root.after(300, poll)
    root.mainloop()
    if not state["err"] and state["done"]:
        run_app()


def run_app():
    import app
    app.App().mainloop()


if __name__ == "__main__":
    main()
