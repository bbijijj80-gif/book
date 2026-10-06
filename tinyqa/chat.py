import sys, torch
from model import GPT
ck = torch.load("model.pt"); chars = ck["chars"]; stoi = {c: i for i, c in enumerate(chars)}
m = GPT(len(chars)); m.load_state_dict(ck["m"]); m.eval()
def ask(q):
    p = f"В: {q}\nО:"
    idx = torch.tensor([[stoi.get(c, 0) for c in p]])
    out = "".join(chars[i] for i in m.generate(idx, itos=chars)[0].tolist())
    return out[len(p):].split("\n")[0].strip()
if len(sys.argv) > 1:
    for q in sys.argv[1:]: print(q, "->", ask(q))
else:
    while True:
        try: print(ask(input("Вы: ")))
        except EOFError: break
