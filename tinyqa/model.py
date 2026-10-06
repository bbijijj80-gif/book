import torch, torch.nn as nn, torch.nn.functional as F

class Block(nn.Module):
    def __init__(s, d, h):
        super().__init__()
        s.h = h; s.ln1 = nn.LayerNorm(d); s.ln2 = nn.LayerNorm(d)
        s.qkv = nn.Linear(d, 3 * d); s.o = nn.Linear(d, d)
        s.mlp = nn.Sequential(nn.Linear(d, 4 * d), nn.GELU(), nn.Linear(4 * d, d))
    def forward(s, x):
        B, T, D = x.shape
        q, k, v = s.qkv(s.ln1(x)).view(B, T, 3, s.h, D // s.h).permute(2, 0, 3, 1, 4)
        y = F.scaled_dot_product_attention(q, k, v, is_causal=True).transpose(1, 2).reshape(B, T, D)
        x = x + s.o(y)
        return x + s.mlp(s.ln2(x))

class GPT(nn.Module):
    def __init__(s, vocab, d=192, L=5, h=6, T=160):
        super().__init__()
        s.T = T
        s.tok = nn.Embedding(vocab, d); s.pos = nn.Embedding(T, d)
        s.blocks = nn.Sequential(*[Block(d, h) for _ in range(L)])
        s.ln = nn.LayerNorm(d); s.head = nn.Linear(d, vocab, bias=False)
        s.head.weight = s.tok.weight
    def forward(s, idx, tgt=None):
        x = s.tok(idx) + s.pos(torch.arange(idx.shape[1]))
        lg = s.head(s.ln(s.blocks(x)))
        loss = F.cross_entropy(lg.view(-1, lg.size(-1)), tgt.view(-1)) if tgt is not None else None
        return lg, loss
    @torch.no_grad()
    def generate(s, idx, n=150, stop="\n\n", itos=None):
        for _ in range(n):
            lg, _ = s(idx[:, -s.T:])
            idx = torch.cat([idx, lg[:, -1].argmax(-1, keepdim=True)], 1)   # greedy
            if itos and "".join(itos[i] for i in idx[0, -2:].tolist()) == stop: break
        return idx
