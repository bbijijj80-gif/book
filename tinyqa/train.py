import time, sys, torch, math
from data import build, fmt
from model import GPT
torch.manual_seed(0)
BUDGET = float(sys.argv[1]) if len(sys.argv) > 1 else 600
text = "".join(fmt(q, a) for q, a in build())
chars = sorted(set(text)); stoi = {c: i for i, c in enumerate(chars)}
data = torch.tensor([stoi[c] for c in text])
m = GPT(len(chars)); print(sum(p.numel() for p in m.parameters()) / 1e6, "M params,", len(text), "chars")
opt = torch.optim.AdamW(m.parameters(), lr=2e-3, weight_decay=0.01)
B, T = 32, m.T; t0 = time.time(); step = 0
while time.time() - t0 < BUDGET:
    lr = 2e-3 * min(1, step / 100) * (0.1 + 0.9 * (1 - (time.time() - t0) / BUDGET))
    for g in opt.param_groups: g["lr"] = lr
    ix = torch.randint(len(data) - T - 1, (B,))
    x = torch.stack([data[i:i + T] for i in ix]); y = torch.stack([data[i + 1:i + T + 1] for i in ix])
    _, loss = m(x, y); opt.zero_grad(); loss.backward()
    torch.nn.utils.clip_grad_norm_(m.parameters(), 1.0); opt.step(); step += 1
    if step % 100 == 0: print(step, f"{loss.item():.3f}", f"{time.time()-t0:.0f}s", flush=True)
torch.save({"m": m.state_dict(), "chars": chars}, "model.pt")
