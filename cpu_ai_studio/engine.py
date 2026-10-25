"""Движок CPU AI Studio: модель GPT, токенайзер, загрузка датасетов, обучение, генерация.

Зависимости: torch (CPU), tokenizers, numpy. `datasets` нужен только для Hugging Face.
Файл самодостаточный: его же копируют в папку экспорта, чтобы модель запускалась без GUI.
"""
from __future__ import annotations

import json
import math
import os
import random
import threading
import time
from dataclasses import asdict, dataclass

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from tokenizers import Tokenizer, decoders, models, pre_tokenizers, trainers

EOS = "<|endoftext|>"
USER_TAG, BOT_TAG = "User:", "Assistant:"


# ───────────────────────────── модель ─────────────────────────────
@dataclass
class ModelConfig:
    vocab_size: int = 8000
    block_size: int = 256
    n_layer: int = 6
    n_head: int = 6
    n_embd: int = 384
    dropout: float = 0.1


def estimate_params(c: ModelConfig) -> int:
    d = c.n_embd
    return c.vocab_size * d + c.block_size * d + c.n_layer * (12 * d * d + 13 * d) + 2 * d


class Block(nn.Module):
    def __init__(self, c: ModelConfig):
        super().__init__()
        self.n_head = c.n_head
        self.drop = c.dropout
        self.ln1 = nn.LayerNorm(c.n_embd)
        self.qkv = nn.Linear(c.n_embd, 3 * c.n_embd)
        self.proj = nn.Linear(c.n_embd, c.n_embd)
        self.ln2 = nn.LayerNorm(c.n_embd)
        self.fc = nn.Linear(c.n_embd, 4 * c.n_embd)
        self.fc2 = nn.Linear(4 * c.n_embd, c.n_embd)
        self.resid_drop = nn.Dropout(c.dropout)

    def forward(self, x):
        B, T, C = x.shape
        q, k, v = self.qkv(self.ln1(x)).split(C, dim=2)
        q, k, v = (t.view(B, T, self.n_head, C // self.n_head).transpose(1, 2) for t in (q, k, v))
        a = F.scaled_dot_product_attention(q, k, v, is_causal=True,
                                           dropout_p=self.drop if self.training else 0.0)
        x = x + self.resid_drop(self.proj(a.transpose(1, 2).reshape(B, T, C)))
        return x + self.resid_drop(self.fc2(F.gelu(self.fc(self.ln2(x)))))


class GPT(nn.Module):
    def __init__(self, c: ModelConfig):
        super().__init__()
        assert c.n_embd % c.n_head == 0, "n_embd должно делиться на n_head"
        self.cfg = c
        self.wte = nn.Embedding(c.vocab_size, c.n_embd)
        self.wpe = nn.Embedding(c.block_size, c.n_embd)
        self.drop = nn.Dropout(c.dropout)
        self.blocks = nn.ModuleList(Block(c) for _ in range(c.n_layer))
        self.ln_f = nn.LayerNorm(c.n_embd)
        self.head = nn.Linear(c.n_embd, c.vocab_size, bias=False)
        self.head.weight = self.wte.weight  # общие веса
        self.apply(self._init)
        for n, p in self.named_parameters():
            if n.endswith(("proj.weight", "fc2.weight")):
                nn.init.normal_(p, 0.0, 0.02 / math.sqrt(2 * c.n_layer))

    @staticmethod
    def _init(m):
        if isinstance(m, nn.Linear):
            nn.init.normal_(m.weight, 0.0, 0.02)
            if m.bias is not None:
                nn.init.zeros_(m.bias)
        elif isinstance(m, nn.Embedding):
            nn.init.normal_(m.weight, 0.0, 0.02)

    def forward(self, idx, targets=None):
        B, T = idx.shape
        x = self.drop(self.wte(idx) + self.wpe(torch.arange(T, device=idx.device)))
        for b in self.blocks:
            x = b(x)
        logits = self.head(self.ln_f(x))
        loss = None
        if targets is not None:
            loss = F.cross_entropy(logits.view(-1, logits.size(-1)), targets.view(-1))
        return logits, loss

    @torch.no_grad()
    def generate(self, ids, max_new=200, temperature=0.8, top_k=40, top_p=0.95,
                 rep_penalty=1.1, should_stop=None):
        """Генератор id новых токенов."""
        self.eval()
        ids = list(ids)
        for _ in range(max_new):
            if should_stop and should_stop():
                return
            ctx = torch.tensor([ids[-self.cfg.block_size:]], dtype=torch.long)
            logits = self(ctx)[0][0, -1].float()
            if rep_penalty != 1.0:
                for t in set(ids[-128:]):
                    logits[t] = logits[t] / rep_penalty if logits[t] > 0 else logits[t] * rep_penalty
            if temperature <= 0.01:
                nxt = int(logits.argmax())
            else:
                logits = logits / temperature
                if top_k and top_k < logits.numel():
                    logits[logits < torch.topk(logits, top_k).values[-1]] = -float("inf")
                probs = F.softmax(logits, -1)
                if top_p < 1.0:
                    sp, si = torch.sort(probs, descending=True)
                    cut = torch.cumsum(sp, 0) - sp > top_p
                    sp[cut] = 0
                    probs = torch.zeros_like(probs).scatter_(0, si, sp)
                    probs = probs / probs.sum()
                nxt = int(torch.multinomial(probs, 1))
            ids.append(nxt)
            yield nxt


# ───────────────────────────── токенайзер ─────────────────────────────
def train_tokenizer(texts, vocab_size: int) -> Tokenizer:
    tok = Tokenizer(models.BPE())
    tok.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)
    tok.decoder = decoders.ByteLevel()
    tr = trainers.BpeTrainer(vocab_size=vocab_size, special_tokens=[EOS], show_progress=False,
                             initial_alphabet=pre_tokenizers.ByteLevel.alphabet())
    tok.train_from_iterator(texts, tr)
    return tok


# ───────────────────────────── данные ─────────────────────────────
_TEXT_COLS = ("text", "content", "sentence", "document", "article", "story", "body", "review", "passage")


def _msgs_to_text(msgs) -> str | None:
    out = []
    for m in msgs:
        if not isinstance(m, dict):
            return None
        role = str(m.get("role", m.get("from", ""))).lower()
        txt = m.get("content", m.get("value", ""))
        if not isinstance(txt, str):
            return None
        out.append(f"{BOT_TAG if role in ('assistant', 'gpt', 'model', 'bot') else USER_TAG} {txt.strip()}")
    return "\n".join(out)


def row_to_text(row: dict, fmt: str = "auto", column: str = "") -> str | None:
    """Превращает строку датасета в текст. fmt: auto | text | chat."""
    if column and isinstance(row.get(column), str) and fmt != "chat":
        return row[column]
    low = {k.lower(): k for k in row}
    if fmt in ("auto", "chat"):
        for k in ("messages", "conversations", "conversation"):
            if k in low and isinstance(row[low[k]], list):
                t = _msgs_to_text(row[low[k]])
                if t:
                    return t
        pairs = [("instruction", "output"), ("instruction", "response"), ("question", "answer"),
                 ("prompt", "response"), ("prompt", "completion"), ("prompt", "chosen"),
                 ("input", "output"), ("query", "response"), ("question", "response")]
        for q, a in pairs:
            if q in low and a in low and isinstance(row[low[q]], str) and isinstance(row[low[a]], str):
                extra = row.get(low["input"], "") if q == "instruction" and "input" in low else ""
                q_txt = row[low[q]] + (("\n" + extra) if isinstance(extra, str) and extra else "")
                return f"{USER_TAG} {q_txt.strip()}\n{BOT_TAG} {row[low[a]].strip()}"
    if fmt != "chat":
        for k in _TEXT_COLS:
            if k in low and isinstance(row[low[k]], str):
                return row[low[k]]
        for v in row.values():
            if isinstance(v, str) and len(v) > 20:
                return v
    return None


def iter_dataset(source: str, config: str = "", split: str = "train", column: str = "",
                 fmt: str = "auto", max_samples: int = 20000, token: str = ""):
    """Итерирует тексты из HF-датасета (streaming) либо из локального файла/папки."""
    if os.path.isfile(source) and source.lower().endswith((".txt", ".md")):
        with open(source, encoding="utf-8", errors="ignore") as f:
            buf = f.read()
        # режем длинный файл на абзацы-пачки
        parts = [p for p in buf.split("\n\n") if p.strip()] or [buf]
        for p in parts[:max_samples]:
            yield p
        return
    from datasets import load_dataset  # импорт здесь: нужен только для датасетов

    if os.path.isfile(source):
        ext = source.lower().rsplit(".", 1)[-1]
        builder = {"jsonl": "json", "json": "json", "csv": "csv", "tsv": "csv", "parquet": "parquet"}.get(ext)
        if not builder:
            raise ValueError(f"Неизвестный формат файла: .{ext}")
        kw = {"delimiter": "\t"} if ext == "tsv" else {}
        ds = load_dataset(builder, data_files=source, split="train", streaming=True, **kw)
    elif os.path.isdir(source):
        ds = load_dataset(source, split=split or "train", streaming=True)
    else:
        ds = load_dataset(source, config or None, split=split or "train", streaming=True,
                          token=token or None)
    n = 0
    for row in ds:
        t = row_to_text(row, fmt, column)
        if t and t.strip():
            yield t
            n += 1
            if n >= max_samples:
                return
    if n == 0:
        raise ValueError("В датасете не найдено текстовых колонок. Укажите колонку вручную.")


# ───────────────────────────── параметры обучения ─────────────────────────────
@dataclass
class TrainParams:
    max_steps: int = 2000
    batch_size: int = 16
    grad_accum: int = 1
    lr: float = 3e-4
    warmup: int = 100
    weight_decay: float = 0.1
    grad_clip: float = 1.0
    eval_every: int = 100
    save_every: int = 500
    threads: int = 4
    seed: int = 1337


def lr_at(step: int, p: TrainParams) -> float:
    if step < p.warmup:
        return p.lr * (step + 1) / max(1, p.warmup)
    prog = (step - p.warmup) / max(1, p.max_steps - p.warmup)
    return p.lr * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * min(1.0, prog))))


# ───────────────────────────── сохранение / загрузка ─────────────────────────────
def save_bundle(path: str, model: GPT, tok: Tokenizer, info: dict | None = None):
    torch.save({"model_cfg": asdict(model.cfg), "state": model.state_dict(),
                "tokenizer": tok.to_str(), "info": info or {}}, path)


def load_bundle(path: str):
    b = torch.load(path, map_location="cpu", weights_only=True)
    m = GPT(ModelConfig(**b["model_cfg"]))
    m.load_state_dict(b["state"])
    return m, Tokenizer.from_str(b["tokenizer"]), b.get("info", {})


_CHAT_PY = '''"""Запуск экспортированной модели: python chat.py"""
import os
from engine import load_bundle, build_prompt, stream_reply

here = os.path.dirname(os.path.abspath(__file__))
model, tok, _ = load_bundle(os.path.join(here, "model.pt"))
history = []
print("Чат запущен. Пустая строка — выход.")
while True:
    q = input("Вы: ").strip()
    if not q:
        break
    print("ИИ: ", end="", flush=True)
    answer = ""
    for piece in stream_reply(model, tok, history, q):
        answer += piece
        print(piece, end="", flush=True)
    print()
    history.append((q, answer.strip()))
'''


def export_model(folder: str, model: GPT, tok: Tokenizer, info: dict | None = None) -> list[str]:
    os.makedirs(folder, exist_ok=True)
    save_bundle(os.path.join(folder, "model.pt"), model, tok, info)
    tok.save(os.path.join(folder, "tokenizer.json"))
    with open(os.path.join(folder, "config.json"), "w", encoding="utf-8") as f:
        json.dump({**asdict(model.cfg), "params": sum(p.numel() for p in model.parameters()),
                   "info": info or {}}, f, indent=2, ensure_ascii=False)
    with open(os.path.join(folder, "chat.py"), "w", encoding="utf-8") as f:
        f.write(_CHAT_PY)
    with open(os.path.join(folder, "engine.py"), "w", encoding="utf-8") as f, \
            open(__file__, encoding="utf-8") as src:
        f.write(src.read())
    files = ["model.pt", "tokenizer.json", "config.json", "chat.py", "engine.py"]
    try:
        from safetensors.torch import save_file
        sd = {k: v.contiguous() for k, v in model.state_dict().items() if k != "head.weight"}
        save_file(sd, os.path.join(folder, "model.safetensors"))
        files.append("model.safetensors")
    except ImportError:
        pass
    return files


# ───────────────────────────── чат ─────────────────────────────
def build_prompt(history, user_msg, chat_mode=True, tok=None, budget=None) -> str:
    if not chat_mode:
        return user_msg
    turns = [f"{USER_TAG} {q}\n{BOT_TAG} {a}\n" for q, a in history]
    turns.append(f"{USER_TAG} {user_msg}\n{BOT_TAG}")
    prompt = "".join(turns)
    while budget and tok and len(turns) > 1 and len(tok.encode(prompt).ids) > budget:
        turns.pop(0)
        prompt = "".join(turns)
    return prompt


def stream_reply(model: GPT, tok: Tokenizer, history, user_msg, chat_mode=True, max_new=200,
                 temperature=0.8, top_k=40, top_p=0.95, rep_penalty=1.1, should_stop=None):
    """Выдаёт куски текста ответа по мере генерации."""
    budget = model.cfg.block_size - max_new
    prompt = build_prompt(history, user_msg, chat_mode, tok, max(8, budget))
    ids = tok.encode(prompt).ids[-max(8, budget):]
    eos = tok.token_to_id(EOS)
    gen, out_ids, shown = model.generate(ids, max_new, temperature, top_k, top_p, rep_penalty, should_stop), [], ""
    for t in gen:
        if t == eos:
            break
        out_ids.append(t)
        text = tok.decode(out_ids)
        if text.endswith("�"):  # неполный UTF-8 символ
            continue
        if chat_mode and f"\n{USER_TAG}" in text:
            text = text.split(f"\n{USER_TAG}")[0]
            yield text[len(shown):]
            return
        yield text[len(shown):]
        shown = text


# ───────────────────────────── обучение ─────────────────────────────
class TrainJob(threading.Thread):
    """Полный цикл: данные → токенайзер → модель → обучение. События уходят в emit(kind, **data)."""

    def __init__(self, data_args: dict, model_cfg: ModelConfig, params: TrainParams, emit,
                 resume: tuple | None = None, ckpt_path: str = "checkpoint.pt"):
        super().__init__(daemon=True)
        self.data_args, self.model_cfg, self.p = data_args, model_cfg, params
        self.emit, self.resume, self.ckpt_path = emit, resume, ckpt_path
        self.stop_flag, self.pause_flag = threading.Event(), threading.Event()
        self.model: GPT | None = None
        self.tok: Tokenizer | None = None

    def log(self, msg):
        self.emit("log", msg=msg)

    def _prepare(self):
        self.log("Загружаю датасет…")
        texts, chars = [], 0
        max_chars = self.data_args.pop("max_chars")
        for t in iter_dataset(**self.data_args):
            texts.append(t)
            chars += len(t)
            if len(texts) % 1000 == 0:
                self.emit("status", msg=f"Загружено примеров: {len(texts)}")
            if chars >= max_chars or self.stop_flag.is_set():
                break
        if not texts:
            raise ValueError("Датасет пуст.")
        self.log(f"Примеров: {len(texts):,}, символов: {chars:,}")
        if self.resume:
            self.model, self.tok, _ = self.resume
            self.log("Продолжаю обучение загруженной модели (токенайзер сохранён).")
        else:
            self.log(f"Обучаю токенайзер (BPE, словарь {self.model_cfg.vocab_size})…")
            self.tok = train_tokenizer(texts, self.model_cfg.vocab_size)
            self.model_cfg.vocab_size = self.tok.get_vocab_size()
        eos = self.tok.token_to_id(EOS)
        self.log("Токенизация…")
        ids: list[int] = []
        for enc in self.tok.encode_batch(texts):
            ids.extend(enc.ids)
            ids.append(eos)
        arr = np.array(ids, dtype=np.int64 if self.tok.get_vocab_size() > 65535 else np.uint16)
        self.log(f"Токенов: {len(arr):,}")
        return arr

    def _batch(self, data, B, T):
        ix = np.random.randint(0, len(data) - T - 1, B)
        x = torch.from_numpy(np.stack([data[i:i + T] for i in ix]).astype(np.int64))
        y = torch.from_numpy(np.stack([data[i + 1:i + 1 + T] for i in ix]).astype(np.int64))
        return x, y

    def run(self):
        try:
            self._train()
        except Exception as e:  # noqa: BLE001
            import traceback
            self.log(traceback.format_exc())
            self.emit("error", msg=str(e))
        else:
            self.emit("done")

    def _train(self):
        p = self.p
        torch.set_num_threads(p.threads)
        random.seed(p.seed); np.random.seed(p.seed); torch.manual_seed(p.seed)
        data = self._prepare()
        if self.stop_flag.is_set():
            return
        if self.model is None:
            T = self.model_cfg.block_size
            if len(data) < 2 * T + 2:
                T = max(16, (len(data) - 2) // 2)
                self.log(f"Данных мало — контекст уменьшен до {T}.")
                self.model_cfg.block_size = T
            self.model = GPT(self.model_cfg)
        model = self.model
        T = model.cfg.block_size
        if len(data) < 2 * T + 2:
            raise ValueError("Слишком мало данных для такого контекста. Увеличьте объём датасета.")
        n_val = max(T + 2, int(len(data) * 0.05))
        train, val = data[:-n_val], data[-n_val:]
        if len(train) < T + 2:
            train = data
        n_par = sum(x.numel() for x in model.parameters())
        self.log(f"Модель: {n_par / 1e6:.2f}M параметров, контекст {T}, потоки CPU: {p.threads}")

        decay = [x for n, x in model.named_parameters() if x.dim() >= 2]
        nodecay = [x for n, x in model.named_parameters() if x.dim() < 2]
        opt = torch.optim.AdamW([{"params": decay, "weight_decay": p.weight_decay},
                                 {"params": nodecay, "weight_decay": 0.0}], lr=p.lr, betas=(0.9, 0.95))

        def evaluate():
            model.eval()
            with torch.no_grad():
                ls = [model(*self._batch(val, p.batch_size, T))[1].item() for _ in range(5)]
            model.train()
            return sum(ls) / len(ls)

        info = lambda step: {"steps": step, "tokens_seen": step * p.batch_size * p.grad_accum * T}  # noqa: E731
        tokens_per_step = p.batch_size * p.grad_accum * T
        self.log(f"Токенов за шаг: {tokens_per_step:,}. Эпох за {p.max_steps} шагов: "
                 f"{p.max_steps * tokens_per_step / len(train):.2f}")
        model.train()
        t0 = time.time()
        step = 0
        ema = None
        for step in range(1, p.max_steps + 1):
            while self.pause_flag.is_set() and not self.stop_flag.is_set():
                time.sleep(0.2)
            if self.stop_flag.is_set():
                break
            for g in opt.param_groups:
                g["lr"] = lr_at(step - 1, p)
            loss_acc = 0.0
            for _ in range(p.grad_accum):
                _, loss = model(*self._batch(train, p.batch_size, T))
                (loss / p.grad_accum).backward()
                loss_acc += loss.item() / p.grad_accum
            if p.grad_clip > 0:
                nn.utils.clip_grad_norm_(model.parameters(), p.grad_clip)
            opt.step(); opt.zero_grad(set_to_none=True)
            ema = loss_acc if ema is None else 0.9 * ema + 0.1 * loss_acc
            el = time.time() - t0
            ev = None
            if step % p.eval_every == 0 or step == p.max_steps:
                ev = evaluate()
            self.emit("step", step=step, total=p.max_steps, loss=loss_acc, ema=ema, val=ev,
                      lr=opt.param_groups[0]["lr"], tps=step * tokens_per_step / el,
                      eta=el / step * (p.max_steps - step))
            if p.save_every and step % p.save_every == 0:
                save_bundle(self.ckpt_path, model, self.tok, info(step))
                self.log(f"Контрольная точка сохранена (шаг {step}).")
        save_bundle(self.ckpt_path, model, self.tok, info(step))
        self.log("Обучение остановлено." if self.stop_flag.is_set() else "Обучение завершено.")
        self.emit("model", model=model, tok=self.tok, info=info(step))
